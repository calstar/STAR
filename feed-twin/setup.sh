#!/usr/bin/env bash
# feed-twin/setup.sh — per-project setup for the feed system twin.
#
# Standalone: `bash feed-twin/setup.sh` from the repo root prepares both ends of
# the app. Also invoked by top-level `setup.sh --feed-twin`.
#
# What it installs:
#   1. Python venv at feed-twin/.venv + pip install -r requirements.txt
#   2. lib/feedtwin (editable) — the physics core, and with it CoolProp,
#      fluids, ht, numpy and scipy
#   3. npm install for frontend/
#
# Flags:
#   --no-frontend   Skip frontend npm install
#   --yes / -y      Accept prompts (non-interactive)
#   --help / -h     Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../scripts/setup_common.sh"

APP_DIR="$SCRIPT_DIR"

DO_FRONTEND=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-frontend) DO_FRONTEND=0 ;;
    --yes|-y)      export SETUP_YES=1 ;;
    --help|-h)
      awk '/^#!/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "Unknown flag: $1 (try --help)" ;;
  esac
  shift
done

OS="$(detect_os)"
step "feed-twin setup — OS: $OS"

# ─── 1. System packages ──────────────────────────────────────────────────────
step "System packages"

if is_macos; then
  ensure_homebrew
  brew install python@3.11 node@20 || true
else
  APT_PKGS=(python3 python3-pip curl git)
  ensure_apt_packages "${APT_PKGS[@]}"
  ensure_python_venv
  if [ "$DO_FRONTEND" = "1" ]; then
    if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
      info "Installing Node 20 from NodeSource"
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
  fi
fi
ok "System packages ready"

# ─── 2. Python venv ──────────────────────────────────────────────────────────
step "Python venv (feed-twin/.venv)"

cd "$APP_DIR"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ok ".venv created"
else
  ok ".venv already exists"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt
# The physics core. Editable: developing this app is mostly developing that.
# CoolProp is a large wheel, so this step is the slow one on a cold venv.
info "Installing the physics core (CoolProp, fluids, ht — this takes a minute)"
pip install --quiet -e ../lib/feedtwin
python -c "import feedtwin; print('  feedtwin', feedtwin.__version__)"
ok "Backend requirements installed"
deactivate

# ─── 3. Frontend ─────────────────────────────────────────────────────────────
if [ "$DO_FRONTEND" = "1" ]; then
  step "Frontend (npm install)"
  if [ -d "$APP_DIR/frontend" ]; then
    (cd "$APP_DIR/frontend" && (npm ci --silent 2>/dev/null || npm install --silent))
    ok "Frontend npm install done"
  else
    warn "feed-twin/frontend not found — skipping"
  fi
fi

step "feed-twin setup complete"

cat <<EOF

Next steps:

  1. Start the dev stack (backend :8003 + frontend :5177):
       cd feed-twin
       ./dev.sh

  2. Or run backend / frontend individually:
       source feed-twin/.venv/bin/activate
       cd feed-twin && uvicorn backend.main:app --reload --port 8003
       cd feed-twin/frontend && npm run dev

  3. Check the physics core is wired up:
       curl -s localhost:8003/api/version

EOF
