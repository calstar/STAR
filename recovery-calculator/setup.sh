#!/usr/bin/env bash
# recovery-calculator/setup.sh — per-project setup for the recovery calculator.
#
# Standalone: `bash recovery-calculator/setup.sh` from the repo root. Also
# invoked by top-level `setup.sh --recovery-calculator`.
#
# What it installs:
#   1. Python venv at recovery-calculator/.venv
#   2. pip install -r requirements.txt (default) OR requirements-ci.txt (--ci)
#   3. Node 20 + npm install for frontend/ (skip with --no-frontend)
#
# This project is a web app, not just a library: `dev.sh` serves a FastAPI
# backend on :8100 and a React frontend on :5273. Node is therefore part of
# setup, not an optional extra -- without it `./dev.sh` aborts at the npm step
# on a machine where everything else installed cleanly. Node 20 matches
# .github/workflows/recovery-calculator-ci.yml.
#
# The tools/ and site-climatology/ trees are stdlib-only by design and need
# none of this -- they run on a bare python3. Only physics's solver
# (numpy/scipy/pydantic) and the backend (fastapi/uvicorn) need the venv.
#
# Flags:
#   --ci               Install requirements-ci.txt (adds pytest + httpx2)
#   --no-frontend      Skip Node and npm install for frontend/
#   --yes / -y         Accept prompts (non-interactive)
#   --help / -h        Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../scripts/setup_common.sh"

RC_DIR="$SCRIPT_DIR"
REQ_FILE="requirements.txt"
DO_FRONTEND=1

while [ $# -gt 0 ]; do
  case "$1" in
    --ci)          REQ_FILE="requirements-ci.txt" ;;
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
step "recovery-calculator setup — OS: $OS"

# ─── 1. System packages ──────────────────────────────────────────────────────
step "System packages"

if is_macos; then
  ensure_homebrew
  if [ "$DO_FRONTEND" = "1" ]; then
    info "brew install python@3.11 node@20"
    brew install python@3.11 node@20 || true
  else
    info "brew install python@3.11"
    brew install python@3.11 || true
  fi
else
  ensure_apt_packages python3 python3-pip curl git
  ensure_python_venv

  # Node 20 for the frontend. Same NodeSource route EngineDesign/setup.sh
  # takes, and the same version CI pins -- a local build passing on a
  # different major than CI is a trap worth not setting.
  if [ "$DO_FRONTEND" = "1" ]; then
    if ! command -v node >/dev/null 2>&1 \
       || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
      info "Installing Node 20 from NodeSource"
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
  fi
fi
ok "System packages ready"

# ─── 2. Python venv ──────────────────────────────────────────────────────────
step "Python venv (recovery-calculator/.venv)"

cd "$RC_DIR"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ok ".venv created"
else
  ok ".venv already exists"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r "$REQ_FILE"
ok "Requirements installed ($REQ_FILE)"
deactivate

# ─── 3. Frontend ─────────────────────────────────────────────────────────────
# `dev.sh` also installs these on first run if node_modules is missing, but
# doing it here means setup finishing successfully actually means the app can
# start -- the point of a setup script.
if [ "$DO_FRONTEND" = "1" ] && [ -d "$RC_DIR/frontend" ]; then
  step "Frontend (npm install)"
  (cd "$RC_DIR/frontend" && (npm ci --silent 2>/dev/null || npm install --silent))
  ok "Frontend npm install done"
elif [ "$DO_FRONTEND" = "0" ]; then
  step "Frontend — skipped (--no-frontend)"
fi

step "recovery-calculator setup complete"

cat <<EOF

Next steps:

  1. Run the whole thing — backend on :8100, GUI on :5273:
       cd recovery-calculator
       ./dev.sh
     Then open http://localhost:5273. Five tabs: Setup & Basic Run, Corners
     (uncertainty sweep), Sweep (compare designs), Atmospheric Data, Units.

  2. Run the validation suite (PLAN.md §12):
       .venv/bin/python -m pytest tests/ -q
       cd frontend && npm test

  3. Run a descent from a config file, no server needed:
       .venv/bin/python -m physics tests/fixtures/worked_example.json

  4. The stdlib-only tools need no venv:
       python3 tools/fruity-chute-scraper/test_mock.py
       cd site-climatology && python3 test_site_climatology.py

EOF
