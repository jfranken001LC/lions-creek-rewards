#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/var/www/lions-creek-rewards}"
SERVICE_NAME="${SERVICE_NAME:-lions-creek-rewards}"
ENV_FILE="${ENV_FILE:-/etc/lions-creek-rewards/lions-creek-rewards.env}"

say() { printf "\n==== %s ====\n" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

load_env() {
  [[ -f "$ENV_FILE" ]] || die "Env file not found: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source <(sudo -n cat "$ENV_FILE")
  set +a
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set (check $ENV_FILE)"
}

resolve_sqlite_path_from_database_url() {
  local url="${DATABASE_URL:-}"
  [[ "$url" =~ ^file:(.*)$ ]] || die "This reset script supports SQLite DATABASE_URLs only. Got: $url"
  local p="${BASH_REMATCH[1]}"
  p="${p%%\?*}"
  if [[ "$p" =~ ^/ ]]; then
    echo "$p"
  else
    echo "$REPO_DIR/$p"
  fi
}

ensure_node_deps() {
  if [[ -x "$REPO_DIR/node_modules/.bin/prisma" ]]; then
    return 0
  fi

  say "Dependencies missing (no local prisma). Installing dependencies"
  cd "$REPO_DIR"

  # Make installs more forgiving for Shopify peer-dep drift
  export npm_config_legacy_peer_deps="true"
  export npm_config_audit="false"
  export npm_config_fund="false"

  if [[ -f package-lock.json ]]; then
    # Try CI first (fast, deterministic) …
    npm ci --no-audit --no-fund || {
      say "npm ci failed (likely lock mismatch). Falling back to npm install"
      npm install --no-audit --no-fund
    }
  else
    npm install --no-audit --no-fund
  fi

  [[ -x "$REPO_DIR/node_modules/.bin/prisma" ]] || die "Prisma still not available after dependency install"
}

run_prisma() {
  local prisma_bin="$REPO_DIR/node_modules/.bin/prisma"
  [[ -x "$prisma_bin" ]] || die "Prisma binary not found at $prisma_bin"
  cd "$REPO_DIR"
  "$prisma_bin" "$@"
}

main() {
  need_cmd sudo
  need_cmd node
  need_cmd npm

  say "Preflight"
  echo "Repo: $REPO_DIR"
  echo "User: $(whoami)"
  echo "Node: $(node -v)"
  echo "NPM:  $(npm -v)"
  echo "Service: $SERVICE_NAME"
  echo "Env file: $ENV_FILE"

  say "Load environment"
  load_env
  echo "DATABASE_URL=$DATABASE_URL"

  say "Stop service (if running)"
  sudo systemctl stop "$SERVICE_NAME" || true

  local db_path
  db_path="$(resolve_sqlite_path_from_database_url)"

  say "Delete SQLite DB (development reset)"
  echo "DB file: $db_path"
  sudo rm -f "$db_path" "${db_path}-wal" "${db_path}-shm" || true
  sudo mkdir -p "$(dirname "$db_path")"
  sudo chown -R "$(whoami):$(whoami)" "$(dirname "$db_path")" || true

  say "Ensure node deps"
  ensure_node_deps

  say "Prisma generate"
  run_prisma generate

  if [[ -d "$REPO_DIR/prisma/migrations" ]] && [[ -n "$(ls -A "$REPO_DIR/prisma/migrations" 2>/dev/null || true)" ]]; then
    say "Prisma migrate deploy"
    run_prisma migrate deploy
  else
    say "No prisma/migrations found -> prisma db push (development-safe)"
    run_prisma db push
  fi

  say "Start service"
  sudo systemctl start "$SERVICE_NAME" || true

  say "Status / logs"
  sudo systemctl status "$SERVICE_NAME" --no-pager || true
  sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true

  say "Done"
}

main "$@"
