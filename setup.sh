#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# STAR Monorepo — Newcomer Setup Script
# ─────────────────────────────────────────────────────────────────────────────
#
# One-shot setup for a fresh clone of github.com/calstar/STAR. Installs all
# system dependencies, Python + Node packages, builds C++ binaries, and gets
# you to a state where `bash daq-server/test/test_integration.sh` should run.
#
# ─── Before running this script ──────────────────────────────────────────────
#
#   git clone https://github.com/calstar/STAR.git
#   cd STAR
#   bash setup.sh
#
# ─── Windows users ───────────────────────────────────────────────────────────
#
# This repo has symlinks committed to git. macOS and Linux handle them
# automatically; Windows does not unless you enable symlink support BEFORE
# cloning:
#
#   git config --global core.symlinks true
#
# (Or use WSL — strongly recommended over native Windows for this codebase.)
# Without this, files that should be symlinks become plain text files
# containing the link target, and builds will fail with confusing errors.
#
# ─── What this script does ───────────────────────────────────────────────────
#
#   1. Checks you're on macOS (with Homebrew) or Linux
#   2. Installs Homebrew packages: cmake, openssl@3, eigen, tmux, node@20
#      Installs black (pinned 25.11.0) via pip --user — see comments inline.
#   3. Installs Rust (if missing) and elodin-db (the time-series telemetry DB)
#   4. Creates a Python venv at daq-server/.venv and installs requirements
#   5. Installs npm packages for diablo_server/{backend,frontend}
#   6. Configures cmake and builds the C++ binaries needed by the integration test
#   7. Prints next steps
#
# What it does NOT do:
#   - Sudo-prompts you for the loopback aliases that the integration test
#     needs at run time. Run the integration test itself for that.
#   - Touch your shell rc files. PATH adjustments needed for ~/.cargo/bin
#     and Homebrew are noted at the end.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Terminal colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step()  { echo -e "\n${CYAN}── $1 ──${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1" >&2; exit 1; }

# Resolve repo root (this script lives at the top of the monorepo)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ─── 0. Sanity ───────────────────────────────────────────────────────────────
step "Sanity checks"

if [ ! -d daq-server ] || [ ! -d firmware ]; then
  fail "Run this from the STAR repo root (expected daq-server/ and firmware/)"
fi
ok "Repo root: $REPO_ROOT"

OS="$(uname -s)"
case "$OS" in
  Darwin) ok "Detected macOS" ;;
  Linux)  ok "Detected Linux"  ;;
  *)      fail "Unsupported OS: $OS — use macOS, Linux, or WSL" ;;
esac

if [ "$OS" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
  fail "Homebrew not found. Install from https://brew.sh first, then re-run."
fi

# ─── 1. System packages ──────────────────────────────────────────────────────
step "Installing system packages (Homebrew)"

if [ "$OS" = "Darwin" ]; then
  PKGS="cmake openssl@3 eigen tmux node@20"
  echo "  brew install $PKGS"
  brew install $PKGS
  ok "Homebrew packages installed"
else
  warn "Linux: install equivalents manually with apt/dnf:"
  warn "  cmake, libssl-dev, libeigen3-dev, tmux, nodejs (20+), npm"
fi

# Install black via pip --user (NOT brew). Reasons:
#   (1) format.sh and the pre-push hook run outside the venv, so they need
#       black on $PATH — the venv install alone isn't enough.
#   (2) brew's black formula tracks latest, which can be black 26+. That
#       requires Python ≥3.10. macOS's system Python is 3.9, so brew's
#       black might be unusable.
#   (3) Pinning the exact version (25.11.0) keeps laptops and CI in sync —
#       same pin as daq-server/requirements.txt and the workflow.
echo "  pip3 install --user black==25.11.0"
pip3 install --user --quiet black==25.11.0 || pip3 install --user --quiet --break-system-packages black==25.11.0
ok "black 25.11.0 installed (pip --user)"

# Tell the user how to ensure it's on PATH if it isn't already.
PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
PY_USER_BIN="$HOME/Library/Python/$PY_VER/bin"
[ "$OS" = "Linux" ] && PY_USER_BIN="$HOME/.local/bin"
if ! command -v black >/dev/null 2>&1; then
  warn "black installed but not on \$PATH yet. Add this to your shell rc:"
  warn "  export PATH=\"$PY_USER_BIN:\$PATH\""
fi

# ─── 2. Rust + elodin-db ─────────────────────────────────────────────────────
step "Rust + elodin-db (time-series telemetry DB)"

if ! command -v cargo >/dev/null 2>&1; then
  echo "  Installing Rust toolchain..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
  ok "Rust installed"
else
  ok "Rust already installed ($(cargo --version))"
fi

ELODIN_BIN="$HOME/.cargo/bin/elodin-db"
if [ -x "$ELODIN_BIN" ]; then
  ok "elodin-db already installed: $($ELODIN_BIN --version 2>/dev/null || echo 'present')"
else
  echo "  Building elodin-db from source (a few minutes — Rust compile)..."
  ELODIN_SRC="/tmp/elodin-src-$$"
  rm -rf "$ELODIN_SRC"
  git clone --depth 1 --branch v0.16.2 https://github.com/elodin-sys/elodin.git "$ELODIN_SRC"
  (cd "$ELODIN_SRC" && cargo install --path libs/db)
  rm -rf "$ELODIN_SRC"

  # The crate may install as `impeller2-cli`; symlink for compatibility.
  if [ ! -x "$ELODIN_BIN" ] && [ -x "$HOME/.cargo/bin/impeller2-cli" ]; then
    ln -sf impeller2-cli "$ELODIN_BIN"
  fi

  if [ -x "$ELODIN_BIN" ]; then
    ok "elodin-db built and installed"
  else
    fail "elodin-db install completed but binary not found at $ELODIN_BIN"
  fi
fi

# ─── 3. Python venv + requirements ───────────────────────────────────────────
step "Python virtual environment (daq-server/.venv)"

cd "$REPO_ROOT/daq-server"

if [ ! -d .venv ]; then
  python3 -m venv .venv
  ok ".venv created"
else
  ok ".venv already exists"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --upgrade pip
if [ -f requirements.txt ]; then
  pip install --quiet -r requirements.txt
  ok "Python requirements installed"
else
  warn "No requirements.txt found in daq-server/ — skipping pip install"
fi
deactivate

cd "$REPO_ROOT"

# ─── 4. Node dependencies ────────────────────────────────────────────────────
step "Node dependencies (diablo_server/backend + frontend)"

if [ -d daq-server/diablo_server/backend ]; then
  (cd daq-server/diablo_server/backend && npm install --silent)
  ok "Backend npm install done"
else
  warn "daq-server/diablo_server/backend not found — skipping"
fi

if [ -d daq-server/diablo_server/frontend ]; then
  (cd daq-server/diablo_server/frontend && npm install --silent)
  ok "Frontend npm install done"
else
  warn "daq-server/diablo_server/frontend not found — skipping"
fi

# ─── 5. C++ build ────────────────────────────────────────────────────────────
step "C++ build (cmake + make)"

cd "$REPO_ROOT/daq-server"
mkdir -p build
cd build

CMAKE_FLAGS=()
if [ "$OS" = "Darwin" ]; then
  CMAKE_FLAGS+=("-DOPENSSL_ROOT_DIR=$(brew --prefix openssl@3)")
fi

echo "  Configuring cmake..."
cmake "${CMAKE_FLAGS[@]}" .. > /dev/null
ok "cmake configured"

echo "  Building binaries (this is the slow step)..."
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
make -j"$JOBS" \
  daq_bridge \
  sequencer_service \
  heartbeat_service \
  config_broadcast_service \
  calibration_service \
  controller_service
ok "All target binaries built"

cd "$REPO_ROOT"

# ─── 6. Local format-on-push hook (optional) ─────────────────────────────────
step "Local format-on-push hook (optional)"

cat <<'EOF'
  We ship a pre-push hook at daq-server/githooks/pre-push that runs ./format.sh
  before every push. If formatting changes anything, the push is blocked so you
  can stage + commit the fixes — catching format failures locally instead of in
  CI.

  Note: this is a local convenience only. The real enforcement is GitHub
  branch protection requiring the CI format-check job to pass before merge.

  Enabling sets:     git config core.hooksPath daq-server/githooks
  Disable later:     git config --unset core.hooksPath
  Bypass once:       git push --no-verify

EOF

ENABLE_HOOK=""
if [ -t 0 ]; then
  read -rp "  Enable format-on-push hook? [Y/n] " ENABLE_HOOK || ENABLE_HOOK=""
else
  warn "Non-interactive shell — skipping (hook NOT enabled)"
fi

case "${ENABLE_HOOK:-y}" in
  [Yy]*|"")
    if [ ! -x daq-server/githooks/pre-push ]; then
      chmod +x daq-server/githooks/pre-push 2>/dev/null || true
    fi
    git config core.hooksPath daq-server/githooks
    ok "Enabled — core.hooksPath = daq-server/githooks"
    ;;
  *)
    warn "Skipped — enable later with: git config core.hooksPath daq-server/githooks"
    ;;
esac

# ─── Done ─────────────────────────────────────────────────────────────────────
step "Setup complete"

cat <<EOF

Next steps:

  1. If 'cargo' or 'elodin-db' isn't found in fresh shells, add this to your
     ~/.zshrc or ~/.bashrc and re-source it:

       export PATH="\$HOME/.cargo/bin:\$PATH"

  2. Run the integration test (will sudo-prompt for loopback aliases on macOS):

       cd $REPO_ROOT
       bash daq-server/test/test_integration.sh

  3. Start the dev stack interactively (web GUI + backend + sim + calibration):

       bash daq-server/deploy/startup/start_tmux_dev.sh

  4. Activate the Python venv when running scripts manually:

       source daq-server/.venv/bin/activate

EOF
