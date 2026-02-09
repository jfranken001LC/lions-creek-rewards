#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# BasketBooster - Production Deploy (Git + Build + Prisma + Systemd restart)
# Drop-in replacement for: scripts/Server_Git_Code_Deploy.sh
#
# Guarantees repo matches origin/main, keeps secrets outside repo, builds, migrates,
# restarts systemd, and verifies the app is listening locally.
# ==============================================================================

# -------- Config (override via env vars) --------------------------------------
REPO_DIR="${REPO_DIR:-/var/www/basketbooster}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
SERVICE_NAME="${SERVICE_NAME:-basketbooster}"
ENV_FILE="${ENV_FILE:-/etc/basketbooster/basketbooster.env}"
LOCK_FILE="${LOCK_FILE:-/var/lock/${SERVICE_NAME}.deploy.lock}"

say() { printf "\n==== %s ====\n" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

load_env() {
  [[ -f "$ENV_FILE" ]] || die "Env file not found: $ENV_FILE"
  # Read with sudo so ENV_FILE can be chmod 600 root:root.
  # shellcheck disable=SC1090
  set -a
  source <(sudo -n cat "$ENV_FILE")
  set +a
}

# If this script lives inside the repo, re-exec from /tmp so git reset won't
# clobber the running process.
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "${DEPLOY_REEXEC:-0}" != "1" ]] && [[ "$SELF" == "$REPO_DIR"* ]]; then
  TMP="/tmp/$(basename "$SELF").$$"
  cp -f "$SELF" "$TMP"
  chmod +x "$TMP"
  DEPLOY_REEXEC=1 exec "$TMP" "$@"
fi

# -------- Preflight ------------------------------------------------------------
need_cmd git
need_cmd sudo
need_cmd node
need_cmd npm

say "Preflight"
echo "Repo: $REPO_DIR"
echo "User: $(whoami)"
echo "Node: $(node -v)"
echo "NPM:  $(npm -v)"
echo "Branch: $BRANCH"
echo "Service: $SERVICE_NAME"
echo "Env file: $ENV_FILE"

# lock to prevent concurrent deploy runs
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "Another deploy is already running (lock: $LOCK_FILE)"
fi

# -------- Stop service ---------------------------------------------------------
say "Stop service (if running)"
sudo systemctl stop "$SERVICE_NAME" || true

# -------- Git hard sync to origin/main ----------------------------------------
say "Fetch + hard reset to ${REMOTE}/${BRANCH}"
cd "$REPO_DIR"
git fetch "$REMOTE" --prune
git checkout -f "$BRANCH"
git reset --hard "${REMOTE}/${BRANCH}"

# -------- Clean build artifacts (preserve env + sqlite DB) ---------------------
say "Clean ignored/untracked build artifacts (preserve env + sqlite DB)"
# Keep .env (or symlink) if present, and keep prisma/prod.sqlite so sessions persist.
git clean -ffdx -e ".env" -e ".env.*" -e "prisma/prod.sqlite" || true

# -------- Show current revision ------------------------------------------------
say "Show current revision"
git rev-parse --short HEAD
git log -1 --oneline

# -------- Load env (required for prisma/build) --------------------------------
say "Load env (required for prisma/build)"
load_env
echo "HOST=${HOST:-127.0.0.1}"
echo "PORT=${PORT:-3000}"
[[ -n "${SHOPIFY_APP_URL:-}" ]] && echo "SHOPIFY_APP_URL=${SHOPIFY_APP_URL}"

# Fail fast if the service will restart-loop because env is missing
missing=()
for k in DATABASE_URL SHOPIFY_API_KEY SHOPIFY_API_SECRET SHOPIFY_APP_URL SESSION_SECRET; do
  [[ -n "${!k:-}" ]] || missing+=("$k")
done
if (( ${#missing[@]} > 0 )); then
  echo "Missing env var(s): ${missing[*]}"
  echo "Add them to: $ENV_FILE (and ensure systemd loads that file)."
  exit 2
fi

# -------- Install dependencies -------------------------------------------------
say "Install dependencies (include dev deps for build)"
if [[ -f package-lock.json ]]; then
  npm ci --include=dev
else
  npm install
fi

# -------- Prisma migrate + generate -------------------------------------------
say "Prisma deploy"
npx prisma migrate deploy
npx prisma generate

# -------- Build extensions -----------------------------------------------------
say "Build function extension(s)"
npm run -s build:function

# -------- Build app ------------------------------------------------------------
say "Build app"
npm run -s build

# -------- Verify server entry exists ------------------------------------------
say "Verify server entry exists"
[[ -f build/server/index.js ]] || die "Missing build/server/index.js after build"
ls -l build/server/index.js

# -------- Restart service + verify --------------------------------------------
say "Reset service failure state + restart"
sudo systemctl reset-failed "$SERVICE_NAME" || true
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" -l --no-pager || true

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3000}"

say "Wait for listen + local health check (bypass nginx)"
sleep 1

# If it's restart-looping, uptime will be tiny repeatedly; show logs.
if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "Service is not active."
  sudo journalctl -u "$SERVICE_NAME" -n 200 -l --no-pager || true
  exit 3
fi

# Wait up to 20s for a listener
for _ in {1..20}; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "(:${PORT}$|\[::\]:${PORT}$|0\.0\.0\.0:${PORT}$)"; then
    break
  fi
  sleep 1
done

echo "Listening sockets (filtered):"
ss -ltnp 2>/dev/null | grep -E ":${PORT}\b" || true

# Try IPv4 then IPv6 loopback
curl -fsS "http://${HOST}:${PORT}/" >/dev/null 2>&1 || curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || curl -fsS "http://[::1]:${PORT}/" >/dev/null 2>&1 || {
  echo "Health check failed (no response on ${PORT}). Dumping recent logs:"
  sudo systemctl status "$SERVICE_NAME" -l --no-pager || true
  sudo journalctl -u "$SERVICE_NAME" -n 200 -l --no-pager || true
  exit 4
}

echo "OK: app is responding on localhost:${PORT}"
say "Done"
