REPO_DIR="${REPO_DIR:-/var/www/lions-creek-rewards}"
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
SERVICE_NAME="${SERVICE_NAME:-lions-creek-rewards}"
ENV_FILE="${ENV_FILE:-/etc/lions-creek-rewards/lions-creek-rewards.env}"
LOCK_FILE="${LOCK_FILE:-/var/lock/${SERVICE_NAME}.deploy.lock}"

say() { printf "\n==== %s ====\n" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

load_env() {
  [[ -f "$ENV_FILE" ]] || die "Env file not found: $ENV_FILE"
  # shellcheck disable=SC1090
  set -a
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


# -------- Stop service ---------------------------------------------------------
say "Stop service (if running)"
sudo systemctl stop "$SERVICE_NAME" || true

# -------- Git hard sync to origin/main ----------------------------------------
say "Fetch + hard reset to ${REMOTE}/${BRANCH}"
cd "$REPO_DIR"
git fetch "$REMOTE" --prune
git checkout -f "$BRANCH"
git reset --hard "${REMOTE}/${BRANCH}"


# -------- Show current revision ------------------------------------------------
say "Show current revision"
git rev-parse --short HEAD
git log -1 --oneline

say "Ensure scripts are executable"
cd "$REPO_DIR"
sudo chmod +x ./scripts/Server_Git_Code_Deploy.sh || true
sudo chmod +x ./scripts/Server_Git_Only.sh || true

say "Done"
