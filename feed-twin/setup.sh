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

# Node 22.12 or newer: the frontend's vitest 5 requires ^22.12 (npm warns
# EBADENGINE on 20), and its image builds on node:24.
node_new_enough() {
  command -v node >/dev/null 2>&1 && node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1);' 2>/dev/null
}

if is_macos; then
  ensure_homebrew
  brew install python@3.11 node@22 || true
else
  APT_PKGS=(python3 python3-pip curl git)
  ensure_apt_packages "${APT_PKGS[@]}"
  ensure_python_venv
  if [ "$DO_FRONTEND" = "1" ]; then
    if ! node_new_enough; then
      info "Installing Node 22 from NodeSource"
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
  fi
fi
if [ "$DO_FRONTEND" = "1" ] && ! node_new_enough; then
  warn "Node $(node -v 2>/dev/null || echo 'not found') on PATH; the frontend wants 22.12 or newer."
  if is_macos; then
    warn "Homebrew's node@22 is keg-only: put \$(brew --prefix node@22)/bin on PATH."
  fi
fi
ok "System packages ready"

# ─── 2. Python venv ──────────────────────────────────────────────────────────
step "Python venv (feed-twin/.venv)"

cd "$APP_DIR"
# lib/feedtwin and lib/stardesign require Python 3.11 or newer; a bare
# `python3` is the macOS system 3.9 beside the python3.11 installed above, or
# Ubuntu 22.04's 3.10.
PY="$(python_at_least 11)" || fail "feed-twin needs Python 3.11 or newer (lib/feedtwin and lib/stardesign require it); python3 here is $(python3 --version 2>&1). Install python3.11 or newer (brew install python@3.11; apt install python3.11 python3.11-venv) and run this again."
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
  ok ".venv created ($("$PY" --version 2>&1))"
elif ! venv_at_least .venv 11; then
  fail "feed-twin/.venv is $(.venv/bin/python --version 2>&1); feed-twin needs 3.11 or newer. Remove feed-twin/.venv and run this again to rebuild it on $("$PY" --version 2>&1)."
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
pip install --quiet -e ../lib/stardesign
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
