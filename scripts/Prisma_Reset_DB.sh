#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/var/www/lions-creek-rewards}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
SERVICE_NAME="${SERVICE_NAME:-lions-creek-rewards}"
ENV_FILE="${ENV_FILE:-/etc/lions-creek-rewards/lions-creek-rewards.env}"
LOCK_FILE="${LOCK_FILE:-/var/lock/${SERVICE_NAME}.deploy.lock}"
PRISMA_VER="${PRISMA_VER:-6.16.3}"

say() { printf "\n==== %s ====\n" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

load_env() {
  [[ -f "$ENV_FILE" ]] || die "Env file not found: $ENV_FILE"

  # Load env vars from the systemd env file so Prisma can resolve env("DATABASE_URL")
  set -a
  if [[ -r "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENV_FILE"
  else
    # shellcheck disable=SC1090
    source <(sudo -n cat "$ENV_FILE")
  fi
  set +a

  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set (expected in $ENV_FILE)"
}

resolve_sqlite_path() {
  # DATABASE_URL like: file:./prisma/prod.sqlite OR file:/abs/path.sqlite
  local url="$1"
  local p="${url#file:}"
  p="${p%%\?*}" # strip any query params if present
  if [[ "$p" == /* ]]; then
    echo "$p"
  else
    # relative to repo root (important under systemd)
    echo "$REPO_DIR/$p"
  fi
}

# If this script lives inside the repo, re-exec from /tmp so git reset won't clobber it.
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
need_cmd npx

say "Preflight"
echo "Repo: $REPO_DIR"
echo "User: $(whoami)"
echo "Node: $(node -v)"
echo "NPM:  $(npm -v)"
echo "Branch: $BRANCH"
echo "Service: $SERVICE_NAME"
echo "Env file: $ENV_FILE"
echo "Prisma: $PRISMA_VER"

# -------- Lock ---------------------------------------------------------------
# Prevent concurrent runs (cron overlap, manual overlap)
exec 9>"$LOCK_FILE" || die "Cannot open lock file: $LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || die "Another reset/deploy appears to be running (lock: $LOCK_FILE)"
else
  say "WARN: 'flock' not found; continuing without a hard lock"
fi

# -------- Load env (CRITICAL) ------------------------------------------------
say "Load environment"
load_env
echo "DATABASE_URL=$DATABASE_URL"

# -------- Stop service ---------------------------------------------------------
say "Stop service (if running)"
sudo systemctl stop "$SERVICE_NAME" || true

# -------- Reset DB (SQLite only) ----------------------------------------------
say "Database reset"
cd "$REPO_DIR"

if [[ "${DATABASE_URL}" == file:* ]]; then
  DB_FILE="$(resolve_sqlite_path "$DATABASE_URL")"
  say "Deleting SQLite DB"
  echo "DB file: $DB_FILE"
  rm -f "$DB_FILE" "${DB_FILE}-wal" "${DB_FILE}-shm" || true
else
  say "Non-SQLite DATABASE_URL detected"
  echo "DATABASE_URL=$DATABASE_URL"
  echo "Skipping file deletion. Prisma migrations will still run."
fi

# -------- Prisma v6 generate + migrate ----------------------------------------
say "Prisma generate (v${PRISMA_VER})"
npx --yes "prisma@${PRISMA_VER}" generate

say "Prisma migrate deploy (v${PRISMA_VER})"
npx --yes "prisma@${PRISMA_VER}" migrate deploy

# -------- Permissions housekeeping ---------------------------------------------
say "Script permissions"
sudo chmod +x ./scripts/Server_Git_Code_Deploy.sh 2>/dev/null || true
sudo chmod +x ./scripts/Server_Git_Only.sh 2>/dev/null || true
sudo chmod +x ./scripts/Prisma_Reset_DB.sh 2>/dev/null || true

say "Done"
