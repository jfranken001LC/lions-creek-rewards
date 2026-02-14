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
  local url="$1"
  local p="${url#file:}"
  p="${p%%\?*}"
  if [[ "$p" == /* ]]; then
    echo "$p"
  else
    echo "$REPO_DIR/$p"
  fi
}

# Re-exec from /tmp so git operations never clobber the running script
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "${DEPLOY_REEXEC:-0}" != "1" ]] && [[ "$SELF" == "$REPO_DIR"* ]]; then
  TMP="/tmp/$(basename "$SELF").$$"
  cp -f "$SELF" "$TMP"
  chmod +x "$TMP"
  DEPLOY_REEXEC=1 exec "$TMP" "$@"
fi

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
echo "Prisma: $PRISMA_VER"

# Lock
exec 9>"$LOCK_FILE" || die "Cannot open lock file: $LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || die "Another reset/deploy appears to be running (lock: $LOCK_FILE)"
else
  say "WARN: 'flock' not found; continuing without a hard lock"
fi

say "Load environment"
load_env
echo "DATABASE_URL=$DATABASE_URL"

say "Stop service (if running)"
sudo systemctl stop "$SERVICE_NAME" || true

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

# Ensure we can see install errors (and avoid engine-strict surprises)
export npm_config_engine_strict="${npm_config_engine_strict:-false}"
export npm_config_fund="${npm_config_fund:-false}"
export npm_config_audit="${npm_config_audit:-false}"

say "Ensure Prisma tooling installed locally (no npx silent installs)"
if [[ ! -x "./node_modules/.bin/prisma" ]]; then
  echo "Local prisma not found -> installing prisma@${PRISMA_VER} (devDependency) with visible logs"
  npm install --save-dev --save-exact "prisma@${PRISMA_VER}"
fi

# @prisma/client should exist for runtime. If missing, install it pinned to the same version.
node -e "require('@prisma/client')" >/dev/null 2>&1 || {
  echo "@prisma/client not found -> installing @prisma/client@${PRISMA_VER} with visible logs"
  npm install --save-exact "@prisma/client@${PRISMA_VER}"
}

say "Prisma version check"
./node_modules/.bin/prisma -v || true

say "Prisma generate (local prisma v${PRISMA_VER})"
./node_modules/.bin/prisma generate

say "Prisma migrate deploy (local prisma v${PRISMA_VER})"
./node_modules/.bin/prisma migrate deploy

say "Start service"
sudo systemctl start "$SERVICE_NAME" || true

say "Status / logs"
sudo systemctl status "$SERVICE_NAME" --no-pager || true
sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true

say "Done"
