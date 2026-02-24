#!/usr/bin/env bash
set -euo pipefail

run() {
  echo "+ $*"
  "$@"
}

run_prisma() {
  run npx prisma "$@"
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-lions-creek-rewards}"
BRANCH="${BRANCH:-main}"
ENV_FILE="${ENV_FILE:-/etc/lions-creek-rewards/lions-creek-rewards.env}"
STRICT_NPM_CI="${STRICT_NPM_CI:-1}"

echo "==== Preflight ===="
echo "Repo: $REPO_DIR"
echo "User: $(whoami)"
echo "Node: $(node -v)"
echo "NPM:  $(npm -v)"
echo "Branch: $BRANCH"
echo "Service: $SERVICE_NAME"
echo "Env file: $ENV_FILE"
echo "STRICT_NPM_CI: $STRICT_NPM_CI"

cd "$REPO_DIR"

echo
echo "==== Stop service (if running) ===="
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl stop "$SERVICE_NAME" || true
fi

echo
echo "==== Fetch + hard reset to origin/$BRANCH ===="
run git fetch origin "$BRANCH"
run git reset --hard "origin/$BRANCH"

echo
echo "==== Clean ignored/untracked build artifacts (preserve env + sqlite DB) ===="
# Keep prisma/*.sqlite (or similar) + env paths safe by not nuking prisma folder
run git clean -xfd -e "prisma/*.sqlite" -e "prisma/*.db" -e ".env" -e ".env.*"

echo
echo "==== Show current revision ===="
run git rev-parse HEAD
run git --no-pager log -1 --oneline

echo
echo "==== Load env (required for prisma/build) ===="
if [[ ! -f "$ENV_FILE" ]]; then
  echo "FATAL: Env file not found: $ENV_FILE"
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Show a few non-sensitive envs (avoid secrets)
echo "HOST=${HOST:-}"
echo "PORT=${PORT:-}"
echo "SHOPIFY_APP_URL=${SHOPIFY_APP_URL:-}"

echo
echo "==== Install dependencies ===="
if [[ "$STRICT_NPM_CI" == "1" ]]; then
  if [[ ! -f package-lock.json ]]; then
    echo "FATAL: package-lock.json is missing. STRICT_NPM_CI=1 requires a committed lockfile."
    echo "Fix on PC:"
    echo "  1) rm -rf node_modules package-lock.json"
    echo "  2) npm install"
    echo "  3) git add package-lock.json && git commit -m \"Add lockfile\" && git push"
    exit 1
  fi
  run npm ci
else
  if [[ -f package-lock.json ]]; then
    if ! npm ci; then
      echo "WARN: npm ci failed; falling back to npm install (STRICT_NPM_CI=0)."
      run npm install
    fi
  else
    echo "WARN: package-lock.json missing; using npm install (STRICT_NPM_CI=0)."
    run npm install
  fi
fi

echo
echo "==== Prisma generate + schema apply (migrate deploy OR db push) ===="
run_prisma generate

# If there are committed migrations, deploy them; otherwise push schema (v1.4 runbook).
if [[ -d "$REPO_DIR/prisma/migrations" ]] && [[ -n "$(ls -A "$REPO_DIR/prisma/migrations" 2>/dev/null || true)" ]]; then
  # Treat "migration_lock.toml" as not-a-migration; require at least one migration.sql
  if find "$REPO_DIR/prisma/migrations" -mindepth 2 -maxdepth 2 -name migration.sql | grep -q .; then
    echo "Migrations detected -> prisma migrate deploy"
    run_prisma migrate deploy
  else
    echo "No migration.sql detected -> prisma db push"
    run_prisma db push
  fi
else
  echo "No prisma/migrations found -> prisma db push"
  run_prisma db push
fi


echo
echo "==== Build ===="
run npm run build

echo
echo "==== Start service ===="
if command -v systemctl >/dev/null 2>&1; then
  run sudo systemctl restart "$SERVICE_NAME"
  run sudo systemctl --no-pager status "$SERVICE_NAME" -l || true
else
  echo "WARN: systemctl not found; start the server manually:"
  echo "  npm run start"
fi

echo
echo "==== Done ===="
