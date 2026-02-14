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
}

resolve_sqlite_path_from_database_url() {
  local url="${DATABASE_URL:-}"
  [[ -n "$url" ]] || die "DATABASE_URL is not set (check $ENV_FILE)"

  # Prisma SQLite URLs are typically: file:./prisma/prod.sqlite OR file:/abs/path.db
  if [[ "$url" =~ ^file:(.*)$ ]]; then
    local p="${BASH_REMATCH[1]}"
    if [[ "$p" =~ ^/ ]]; then
      echo "$p"
    else
      # relative to repo root
      echo "$REPO_DIR/$p"
    fi
  else
    die "This reset script currently supports SQLite DATABASE_URLs only. Got: $url"
  fi
}

ensure_node_deps() {
  if [[ -x "$REPO_DIR/node_modules/.bin/prisma" ]]; then
    return 0
  fi

  say "Dependencies missing (no local prisma). Installing dependencies"
  cd "$REPO_DIR"

  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi

  [[ -x "$REPO_DIR/node_modules/.bin/prisma" ]] || die "Prisma still not available after install"
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
  echo "DATABASE_URL=${DATABASE_URL:-<unset>}"

  say "Stop service (if running)"
  sudo systemctl stop "$SERVICE_NAME" || true

  local db_path
  db_path="$(resolve_sqlite_path_from_database_url)"

  say "Delete SQLite DB (development reset)"
  echo "DB file: $db_path"
  if [[ -f "$db_path" ]]; then
    sudo rm -f "$db_path"
  fi
  sudo mkdir -p "$(dirname "$db_path")"
  sudo chown -R "$(whoami):$(whoami)" "$(dirname "$db_path")" || true

  say "Ensure node deps (no ad-hoc prisma installs)"
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

  say "Done"
}

main "$@"
