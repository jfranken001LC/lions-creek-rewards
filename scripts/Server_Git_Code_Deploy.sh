#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# Lions Creek Rewards - Server Deploy Script (Lightsail)
# -------------------------------------------------------------------
# - Hard resets repo to origin/main
# - Cleans build artifacts
# - Installs dependencies
# - Prisma generate + migrate deploy (if migrations exist) else db push
# - Builds Remix/React Router app
# - Restarts systemd service
# -------------------------------------------------------------------

REPO_DIR="/var/www/lions-creek-rewards"
SERVICE_NAME="lions-creek-rewards"
ENV_FILE="/etc/lions-creek-rewards/lions-creek-rewards.env"
BRANCH="main"

STRICT_NPM_CI="${STRICT_NPM_CI:-0}"

say() {
  echo
  echo "==== $* ===="
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

run_prisma() {
  npx prisma "$@"
}

say "Preflight"
echo "Repo: $REPO_DIR"
echo "User: $(whoami)"
echo "Node: $(node -v || true)"
echo "NPM:  $(npm -v || true)"
echo "Branch: $BRANCH"
echo "Service: $SERVICE_NAME"
echo "Env file: $ENV_FILE"
echo "STRICT_NPM_CI: $STRICT_NPM_CI"

cd "$REPO_DIR"

say "Stop service (if running)"
sudo systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true

say "Fetch + hard reset to origin/$BRANCH"
git fetch origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

say "Clean ignored/untracked build artifacts (preserve env + sqlite DB)"
# IMPORTANT: We keep prisma/prod.sqlite (prod DB) and env outside repo.
git clean -xdf -e "prisma/prod.sqlite" -e ".env" -e ".env.*" || true

say "Show current revision"
git rev-parse HEAD
git log -1 --oneline --decorate

say "Load env (required for prisma/build)"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  die "Env file not found: $ENV_FILE"
fi

# Basic echo of a few known values (avoid secrets)
echo "HOST=${HOST:-}"
echo "PORT=${PORT:-}"
echo "SHOPIFY_APP_URL=${SHOPIFY_APP_URL:-}"

say "Install dependencies (prefer npm ci; fallback to npm install if lock mismatch)"
if [ "$STRICT_NPM_CI" = "1" ]; then
  npm ci
else
  if ! npm ci; then
    echo "npm ci failed (lock out of sync). Falling back to npm install..."
    npm install
  fi
fi

# -------- Prisma migrate + generate -------------------------------------------
say "Prisma deploy"
export PRISMA_HIDE_UPDATE_MESSAGE=1
run_prisma generate

# Detect actual Prisma migrations by presence of migration.sql files (avoids false positives from .gitkeep).
if find "$REPO_DIR/prisma/migrations" -maxdepth 2 -type f -name "migration.sql" 2>/dev/null | grep -q .; then
  run_prisma migrate deploy
else
  echo "No Prisma migration.sql found -> using prisma db push (development-safe)"
  run_prisma db push
fi

# -------- Build extensions (only if present) ----------------------------------
say "Build extension(s) if configured"
if npm run -s | grep -qE '^  build:function$'; then
  npm run -s build:function
else
  echo "No build:function script found; skipping."
fi

# -------- Build app -----------------------------------------------------------
say "Build app"
npm run build

# -------- Restart service -----------------------------------------------------
say "Start service"
sudo systemctl start "$SERVICE_NAME"

say "Status"
sudo systemctl --no-pager status "$SERVICE_NAME" || true

echo
echo "✅ Deploy complete."
