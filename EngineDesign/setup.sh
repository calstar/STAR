#!/usr/bin/env bash
# EngineDesign/setup.sh — per-project setup for the engine design pipeline.
#
# Standalone: `bash EngineDesign/setup.sh` from the repo root creates a Python
# venv and installs deps. Also invoked by top-level `setup.sh --engine-design`.
#
# What it installs:
#   1. Python venv at EngineDesign/.venv
#   2. pip install -r requirements.txt (default) OR requirements-ci.txt (--ci)
#   3. npm install for the frontend (optional; skip with --no-frontend)
#   4. Native C physics kernel — cmake + build (skip with --no-native)
#
# rocketcea note: the default requirements.txt includes rocketcea, which
# builds NASA CEA from Fortran (needs gfortran). CI uses requirements-ci.txt
# to skip that; use --ci here to match CI locally.
#
# Flags:
#   --ci               Install requirements-ci.txt (no rocketcea/gfortran)
#   --no-frontend      Skip npm install for frontend/
#   --no-native        Skip cmake build for engine/native/
#   --yes / -y         Accept prompts (non-interactive)
#   --help / -h        Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../scripts/setup_common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ED_DIR="$SCRIPT_DIR"

USE_CI=0
DO_FRONTEND=1
DO_NATIVE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --ci)          USE_CI=1 ;;
    --no-frontend) DO_FRONTEND=0 ;;
    --no-native)   DO_NATIVE=0 ;;
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
step "EngineDesign setup — OS: $OS"

# ─── 1. System packages ──────────────────────────────────────────────────────
step "System packages"

if is_macos; then
  ensure_homebrew
  info "brew install cmake python@3.11 node@20"
  brew install cmake python@3.11 node@20 || true
  if [ "$USE_CI" = "0" ]; then
    # rocketcea needs a Fortran compiler on macOS too.
    info "brew install gcc (for gfortran — rocketcea build)"
    brew install gcc || true
  fi
else
  APT_PKGS=(build-essential cmake python3 python3-pip curl git)
  if [ "$USE_CI" = "0" ]; then
    APT_PKGS+=(gfortran)
  fi
  ensure_apt_packages "${APT_PKGS[@]}"
  ensure_python_venv

  # Node 20 for frontend (only if we're doing frontend).
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
step "Python venv (EngineDesign/.venv)"

cd "$ED_DIR"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ok ".venv created"
else
  ok ".venv already exists"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip setuptools wheel

REQ_FILE="requirements.txt"
if [ "$USE_CI" = "1" ]; then
  REQ_FILE="requirements-ci.txt"
  info "Installing CI subset (no rocketcea/gfortran) — $REQ_FILE"
else
  info "Installing full deps (includes rocketcea; requires gfortran) — $REQ_FILE"
fi

# rocketcea on Apple Silicon needs ARCHFLAGS=-arch arm64. On x86 macOS + Linux
# the flag is a no-op, so it's safe to always set it on macOS.
if is_macos && [ "$USE_CI" = "0" ]; then
  export ARCHFLAGS="-arch arm64"
fi

pip install --quiet -r "$REQ_FILE"
ok "Python requirements installed ($REQ_FILE)"
deactivate

# ─── 3. Native C kernel ──────────────────────────────────────────────────────
if [ "$DO_NATIVE" = "1" ] && [ -d "$ED_DIR/engine/native" ]; then
  step "Native C kernel (engine/native)"
  # Portable build (matches CI: ED_NATIVE_ARCH=OFF drops -march=native).
  (cd "$ED_DIR/engine/native" \
    && cmake -S . -B build -DED_NATIVE_ARCH=OFF > /dev/null \
    && cmake --build build -j)
  ok "Native kernel built"
elif [ "$DO_NATIVE" = "0" ]; then
  step "Native C kernel — skipped (--no-native)"
fi

# ─── 4. Frontend ─────────────────────────────────────────────────────────────
if [ "$DO_FRONTEND" = "1" ] && [ -d "$ED_DIR/frontend" ]; then
  step "Frontend (npm install)"
  (cd "$ED_DIR/frontend" && (npm ci --silent 2>/dev/null || npm install --silent))
  ok "Frontend npm install done"
elif [ "$DO_FRONTEND" = "0" ]; then
  step "Frontend — skipped (--no-frontend)"
fi

step "EngineDesign setup complete"

cat <<EOF

Next steps:

  1. Activate the venv:
       source EngineDesign/.venv/bin/activate

  2. Run the Python regression gate (matches CI):
       cd EngineDesign
       python -m pytest tests/ --timeout=120 --timeout-method=thread --durations=15 -q

  3. Start the dev stack (backend + frontend):
       cd EngineDesign
       ./dev.sh

EOF
