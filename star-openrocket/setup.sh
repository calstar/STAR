#!/usr/bin/env bash
# star-openrocket/setup.sh — per-project setup for the STAR OpenRocket.
#
# Standalone: `bash star-openrocket/setup.sh` from the repo root prepares both
# ends of the app. Also invoked by top-level `setup.sh --star-openrocket`.
#
# What it installs:
#   1. Python venv at star-openrocket/.venv + pip install -r requirements.txt
#   2. npm install for frontend/
#   3. A gitignored .env stub for the Onshape API credentials
#
# Flags:
#   --no-frontend   Skip frontend npm install
#   --ci            Install requirements-ci.txt (adds pytest); skip the .env stub
#   --yes / -y      Accept prompts (non-interactive)
#   --help / -h     Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../scripts/setup_common.sh"

VIEWER_DIR="$SCRIPT_DIR"

DO_FRONTEND=1
CI_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-frontend) DO_FRONTEND=0 ;;
    --ci)          CI_MODE=1 ;;
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
step "star-openrocket setup — OS: $OS"

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
step "Python venv (star-openrocket/.venv)"

cd "$VIEWER_DIR"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ok ".venv created"
else
  ok ".venv already exists"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
if [ "$CI_MODE" = "1" ]; then
  pip install --quiet -r requirements-ci.txt
  ok "Backend requirements installed (CI subset, includes pytest)"
else
  pip install --quiet -r requirements.txt
  ok "Backend requirements installed"
fi
deactivate

# ─── 3. Frontend ─────────────────────────────────────────────────────────────
if [ "$DO_FRONTEND" = "1" ]; then
  step "Frontend (npm install)"
  if [ -d "$VIEWER_DIR/frontend" ]; then
    (cd "$VIEWER_DIR/frontend" && (npm ci --silent 2>/dev/null || npm install --silent))
    ok "Frontend npm install done"
  else
    warn "star-openrocket/frontend not found — skipping"
  fi
fi

# ─── 4. Credentials ──────────────────────────────────────────────────────────
# The viewer reads ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY from the environment
# with no defaults, and dev.sh sources .env if it exists. We write the stub but
# never a key: this file is gitignored, but the surest way to keep a credential
# out of the repo is for no script to ever hold one.
#
# Skipped under --ci on purpose. CI must not have credentials at all — see the
# comment block at the top of .github/workflows/star-openrocket-ci.yml.
if [ "$CI_MODE" = "0" ]; then
  step "Onshape credentials (.env)"
  if [ -f "$VIEWER_DIR/.env" ]; then
    ok ".env already exists — leaving it alone"
  else
    cat > "$VIEWER_DIR/.env" <<'EOF'
# Onshape API credentials. Gitignored — never commit this file.
# Get a key pair from https://dev-portal.onshape.com and paste it below.
ONSHAPE_ACCESS_KEY=
ONSHAPE_SECRET_KEY=
EOF
    ok "Wrote .env stub (gitignored)"
    warn "Fill in star-openrocket/.env before building a model."
  fi
fi

step "star-openrocket setup complete"

cat <<EOF

Next steps:

  1. Put your Onshape key pair in star-openrocket/.env
     (https://dev-portal.onshape.com — the viewer will not build without it)

  2. Start the dev stack (backend :8002 + frontend :5175):
       cd star-openrocket
       ./dev.sh

  3. Run the tests (fully offline — no credentials, no API calls):
       cd star-openrocket
       .venv/bin/python -m pytest tests/ -q

A note on API quota: Onshape bills per request. Building a model costs roughly
7 + 3x(part studios) calls -- about 22 for the reference rocket assembly -- and
a rebuild of the same microversion costs zero. Browsing is served from a local
cache and only reaches Onshape when you press "search Onshape" in the picker.

EOF
