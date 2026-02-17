#!/usr/bin/env bash
set -Eeuo pipefail

# ==============================================================================
# Loyalty - Production Deploy (Git + Build + Prisma + Systemd restart)
# Tuned for loyalty.basketbooster.ca
# ==============================================================================

# -------- Config (override via env vars) --------------------------------------
REPO_DIR="${REPO_DIR:-/var/www/lions-creek-rewards}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
SERVICE_NAME="${SERVICE_NAME:-lions-creek-rewards}"
ENV_FILE="${ENV_FILE:-/etc/lions-creek-rewards/lions-creek-rewards.env}"
LOCK_FILE="${LOCK_FILE:-/var/lock/${SERVICE_NAME}.deploy.lock}"

# Optional: set STRICT_NPM_CI=1 to fail deploy if npm ci can't be used
STRICT_NPM_CI="${STRICT_NPM_CI:-0}"

say() { printf "\n==== %s ====\n" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

load_env() {
  [[ -f "$ENV_FILE" ]] || die "Env file not found: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source <(sudo -n cat "$ENV_FILE")
  set +a
}

# If this script lives inside the repo, re-exec from /tmp so git reset won't clobber it.
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "${DEPLOY_REEXEC:-0}" != "1" ]] && [[ "$SELF" == "$REPO_DIR"* ]]; then
  TMP="/tmp/$(basename "$SELF").$$"
  cp -f "$SELF" "$TMP"
  chmod +x "$TMP"
  DEPLOY_REEXEC=1 exec "$TMP" "$@"
fi

run_prisma() {
  local prisma_bin="$REPO_DIR/node_modules/.bin/prisma"
  [[ -x "$prisma_bin" ]] || die "Prisma binary not found at $prisma_bin (did npm install succeed?)"
  cd "$REPO_DIR"
  "$prisma_bin" "$@"
}

install_deps() {
  cd "$REPO_DIR"

  # Make npm more forgiving with Shopify peer dependencies / workspace churn
  export npm_config_legacy_peer_deps="true"
  export npm_config_audit="false"
  export npm_config_fund="false"

  if [[ -f package-lock.json ]]; then
    say "Install dependencies (prefer npm ci; fallback to npm install if lock mismatch)"
    if npm ci --include=dev --no-audit --no-fund; then
      return 0
    fi

    if [[ "$STRICT_NPM_CI" == "1" ]]; then
      die "npm ci failed and STRICT_NPM_CI=1. Fix package-lock.json consistency and retry."
    fi

    echo "npm ci failed (lock out of sync). Falling back to npm install..."
    npm install --include=dev --no-audit --no-fund
    return 0
  fi

  if [[ "$STRICT_NPM_CI" == "1" ]]; then
    die "package-lock.json missing and STRICT_NPM_CI=1. Commit a lockfile and retry."
  fi

  say "Install dependencies (npm install)"
  npm install --include=dev --no-audit --no-fund
}

# -------- Preflight ------------------------------------------------------------
need_cmd git
need_cmd sudo
need_cmd node
need_cmd npm
need_cmd flock

say "Preflight"
echo "Repo: $REPO_DIR"
echo "User: $(whoami)"
echo "Node: $(node -v)"
echo "NPM:  $(npm -v)"
echo "Branch: $BRANCH"
echo "Service: $SERVICE_NAME"
echo "Env file: $ENV_FILE"
echo "STRICT_NPM_CI: $STRICT_NPM_CI"

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
git clean -ffdx \
  -e ".env" \
  -e ".env.*" \
  -e "prisma/**/prod.sqlite" \
  -e "prisma/**/*.sqlite" \
  -e "prisma/**/*.db" \
  -e "prisma/*.sqlite" \
  -e "prisma/*.db" \
  || true

# -------- Show current revision ------------------------------------------------
say "Show current revision"
git rev-parse --short HEAD
git log -1 --oneline

# -------- Load env (required for prisma/build) --------------------------------
say "Load env (required for prisma/build)"
load_env
echo "HOST=${HOST:-127.0.0.1}"
echo "PORT=${PORT:-3001}"
[[ -n "${SHOPIFY_APP_URL:-}" ]] && echo "SHOPIFY_APP_URL=${SHOPIFY_APP_URL}"

missing=()
# Added JOB_TOKEN because /jobs/expire is token-protected in the requirements and implementation.
for k in DATABASE_URL SHOPIFY_API_KEY SHOPIFY_API_SECRET SHOPIFY_APP_URL SESSION_SECRET JOB_TOKEN; do
  [[ -n "${!k:-}" ]] || missing+=("$k")
done
if (( ${#missing[@]} > 0 )); then
  echo "Missing env var(s): ${missing[*]}"
  echo "Add them to: $ENV_FILE (and ensure systemd loads that file)."
  exit 2
fi

# -------- Install dependencies -------------------------------------------------
install_deps

# -------- Prisma migrate + generate -------------------------------------------
say "Prisma deploy"
export PRISMA_HIDE_UPDATE_MESSAGE=1
run_prisma generate

if [[ -d "$REPO_DIR/prisma/migrations" ]] && [[ -n "$(ls -A "$REPO_DIR/prisma/migrations" 2>/dev/null || true)" ]]; then
  run_prisma migrate deploy
else
  echo "No prisma/migrations found -> using prisma db push (development-safe)"
  run_prisma db push
fi

# -------- Build extensions (only if present) ----------------------------------
say "Build extension(s) if configured"
if npm run -s | grep -qE '^  build:function$'; then
  npm run -s build:function
else
  echo "No build:function script found; skipping."
fi

# -------- Build app ------------------------------------------------------------
say "Build app"
export NODE_ENV=production
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
PORT="${PORT:-3001}"

say "Wait for listen + local health check (bypass nginx)"
sleep 1

if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "Service is not active."
  sudo journalctl -u "$SERVICE_NAME" -n 200 -l --no-pager || true
  exit 3
fi

for _ in {1..20}; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "(:${PORT}$|\[::\]:${PORT}$|0\.0\.0\.0:${PORT}$)"; then
    break
  fi
  sleep 1
done

echo "Listening sockets (filtered):"
ss -ltnp 2>/dev/null | grep -E ":${PORT}\b" || true

curl -fsS "http://${HOST}:${PORT}/" >/dev/null 2>&1 \
  || curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 \
  || curl -fsS "http://[::1]:${PORT}/" >/dev/null 2>&1 \
  || {
    echo "Health check failed (no response on ${PORT}). Dumping recent logs:"
    sudo systemctl status "$SERVICE_NAME" -l --no-pager || true
    sudo journalctl -u "$SERVICE_NAME" -n 200 -l --no-pager || true
    exit 4
  }

echo "OK: app is responding on localhost:${PORT}"

say "Ensure scripts are executable"
cd "$REPO_DIR"
sudo chmod +x ./scripts/Server_Git_Code_Deploy.sh || true
sudo chmod +x ./scripts/Server_Git_Only.sh || true

say "Done"
