#!/usr/bin/env bash
# pid-designer/setup.sh — per-project setup for the P&ID Designer.
#
# Standalone: `bash pid-designer/setup.sh` from the repo root prepares both
# ends of the app. Also invoked by top-level `setup.sh --pid-designer`.
#
# What it installs:
#   1. Python venv at pid-designer/.venv + pip install -r requirements.txt
#   2. npm install for frontend/
#
# Flags:
#   --no-frontend   Skip frontend npm install
#   --yes / -y      Accept prompts (non-interactive)
#   --help / -h     Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../scripts/setup_common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$SCRIPT_DIR"

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
step "pid-designer setup — OS: $OS"

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
step "Python venv (pid-designer/.venv)"

cd "$PID_DIR"
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
ok "Backend requirements installed"
deactivate

# ─── 3. Frontend ─────────────────────────────────────────────────────────────
if [ "$DO_FRONTEND" = "1" ]; then
  step "Frontend (npm install)"
  if [ -d "$PID_DIR/frontend" ]; then
    (cd "$PID_DIR/frontend" && (npm ci --silent 2>/dev/null || npm install --silent))
    ok "Frontend npm install done"
  else
    warn "pid-designer/frontend not found — skipping"
  fi
fi

step "pid-designer setup complete"

cat <<EOF

Next steps:

  1. Start the dev stack (backend :8001 + frontend :5174):
       cd pid-designer
       ./dev.sh

  2. Or run backend / frontend individually:
       source pid-designer/.venv/bin/activate
       cd pid-designer && uvicorn backend.main:app --reload --port 8001
       cd pid-designer/frontend && npm run dev

EOF
