#!/usr/bin/env bash
# daq-server/setup.sh — per-project setup for the DAQ server / FSW.
#
# Standalone: `bash daq-server/setup.sh` from the repo root does everything
# needed to run `bash daq-server/test/test_integration.sh`. Also invoked by
# the top-level dispatcher `setup.sh --daq-server`.
#
# What it installs:
#   1. System packages (Homebrew on macOS; apt on Linux/WSL — list mirrors CI)
#   2. Rust toolchain + elodin-db (time-series telemetry DB)
#   3. Python venv at daq-server/.venv + pip install -r requirements.txt
#   4. npm install for diablo_server/backend and diablo_server/frontend
#   5. cmake + build for daq_bridge, sequencer, heartbeat, config_broadcast,
#      calibration, controller services
#   6. Optional: pre-push format hook (interactive prompt)
#
# Flags:
#   --no-build       Skip the C++ build step (deps only)
#   --no-hook        Don't offer to enable the pre-push format hook
#   --yes / -y       Accept all prompts (non-interactive; enables hook)
#   --help / -h      Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../scripts/setup_common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DAQ_DIR="$SCRIPT_DIR"

DO_BUILD=1
DO_HOOK=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --no-hook)  DO_HOOK=0 ;;
    --yes|-y)   export SETUP_YES=1 ;;
    --help|-h)
      awk '/^#!/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "Unknown flag: $1 (try --help)" ;;
  esac
  shift
done

OS="$(detect_os)"
step "daq-server setup — OS: $OS"

case "$OS" in
  macOS|Linux|WSL) ok "Supported platform" ;;
  *) fail "Unsupported OS: $OS — use macOS, Linux, or WSL" ;;
esac

# ─── 1. System packages ──────────────────────────────────────────────────────
step "System packages"

if is_macos; then
  ensure_homebrew
  BREW_PKGS="cmake openssl@3 eigen tmux node@20"
  info "brew install $BREW_PKGS"
  # shellcheck disable=SC2086
  brew install $BREW_PKGS
  ok "Homebrew packages installed"
else
  # Linux/WSL: mirrors .github/workflows/daq-server-ci.yml apt install list.
  # Kept in sync with CI so a clean laptop install matches what CI builds
  # against. Node 20 comes from NodeSource (Ubuntu's default node is too old).
  APT_PKGS=(
    build-essential
    cmake
    ninja-build
    ccache
    libeigen3-dev
    libssl-dev
    pkg-config
    tmux
    python3
    python3-pip
    curl
    wget
    git
    # For elodin-db build from source (fallback path)
    ca-certificates
  )
  ensure_apt_packages "${APT_PKGS[@]}"
  ensure_python_venv

  # libcanard-dev is optional and not always in default apt (CI marks it
  # best-effort). Try, but don't fail the setup if unavailable.
  if ! dpkg -s libcanard-dev >/dev/null 2>&1; then
    sudo apt-get install -y libcanard-dev 2>/dev/null \
      || warn "libcanard-dev not in apt on this distro — building without CAN package (matches CI)"
  fi

  # Node 20 — Ubuntu 22.04 ships 12; NodeSource repo provides current LTS.
  if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
    info "Installing Node 20 from NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  ok "System packages installed (matches daq-server-ci.yml)"
fi

ensure_pinned_black

# ─── 2. Rust + elodin-db ─────────────────────────────────────────────────────
step "Rust + elodin-db (time-series telemetry DB)"

if ! command -v cargo >/dev/null 2>&1; then
  # Load cargo env if a prior installer wrote it but shell hasn't sourced yet.
  [ -f "$HOME/.cargo/env" ] && { set +u; source "$HOME/.cargo/env"; set -u; }
fi

if ! command -v cargo >/dev/null 2>&1; then
  info "Installing Rust toolchain (rustup)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  set +u; source "$HOME/.cargo/env"; set -u
  ok "Rust installed"
else
  ok "Rust already installed ($(cargo --version))"
fi

ELODIN_BIN="$HOME/.cargo/bin/elodin-db"
if [ -x "$ELODIN_BIN" ]; then
  ok "elodin-db already installed: $($ELODIN_BIN --version 2>/dev/null || echo present)"
else
  # Try the prebuilt installer first (matches CI — much faster than source
  # build). Fall back to cargo install from git if the installer fails.
  # Keep this pinned to the version CI installs + validates against (see
  # .github/workflows/daq-server-ci.yml). deploy/bootstrap_daq.sh is the preferred one-shot.
  ELODIN_VERSION="v0.16.1"
  INSTALLER_URL="https://github.com/elodin-sys/elodin/releases/download/${ELODIN_VERSION}/elodin-db-installer.sh"
  mkdir -p "$HOME/.cargo/bin"
  info "Installing elodin-db $ELODIN_VERSION via prebuilt installer..."
  if curl --proto '=https' --tlsv1.2 -LsSf "$INSTALLER_URL" | sh; then
    ok "elodin-db installed via prebuilt installer"
  else
    warn "Prebuilt installer failed — falling back to cargo build from source (slow)"
    ELODIN_SRC="/tmp/elodin-src-$$"
    rm -rf "$ELODIN_SRC"
    git clone --depth 1 --branch "$ELODIN_VERSION" https://github.com/elodin-sys/elodin.git "$ELODIN_SRC"
    # Crate root moved between elodin releases (libs/db vs libs/db/cli) — try both.
    (cd "$ELODIN_SRC" && (cargo install --path libs/db/cli || cargo install --path libs/db))
    rm -rf "$ELODIN_SRC"
    # The crate may install as impeller2-cli; symlink for compat.
    if [ ! -x "$ELODIN_BIN" ] && [ -x "$HOME/.cargo/bin/impeller2-cli" ]; then
      ln -sf impeller2-cli "$ELODIN_BIN"
    fi
    [ -x "$ELODIN_BIN" ] || fail "elodin-db install completed but binary missing at $ELODIN_BIN"
    ok "elodin-db built from source"
  fi
fi

# ─── 3. Python venv + requirements ───────────────────────────────────────────
step "Python venv (daq-server/.venv)"

cd "$DAQ_DIR"
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
  warn "No requirements.txt in daq-server/ — skipping"
fi
deactivate

# ─── 4. Node dependencies ────────────────────────────────────────────────────
step "Node dependencies (diablo_server backend + frontend)"

if [ -d "$DAQ_DIR/diablo_server/backend" ]; then
  (cd "$DAQ_DIR/diablo_server/backend" && (npm ci --silent 2>/dev/null || npm install --silent))
  ok "Backend npm install done"
else
  warn "diablo_server/backend not found — skipping"
fi

if [ -d "$DAQ_DIR/diablo_server/frontend" ]; then
  (cd "$DAQ_DIR/diablo_server/frontend" && (npm ci --silent 2>/dev/null || npm install --silent))
  ok "Frontend npm install done"
else
  warn "diablo_server/frontend not found — skipping"
fi

# ─── 5. C++ build ────────────────────────────────────────────────────────────
if [ "$DO_BUILD" = "1" ]; then
  step "C++ build (cmake + make)"
  mkdir -p "$DAQ_DIR/build"
  cd "$DAQ_DIR/build"

  CMAKE_FLAGS=()
  if is_macos; then
    CMAKE_FLAGS+=("-DOPENSSL_ROOT_DIR=$(brew --prefix openssl@3)")
  fi

  info "Configuring cmake..."
  cmake "${CMAKE_FLAGS[@]}" .. > /dev/null
  ok "cmake configured"

  info "Building all targets (matches CI: cmake --build . --parallel)..."
  JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
  cmake --build . --parallel "$JOBS"
  ok "All target binaries built"
else
  step "C++ build — skipped (--no-build)"
fi

# ─── 6. Optional pre-push format hook ────────────────────────────────────────
if [ "$DO_HOOK" = "1" ]; then
  step "Local format-on-push hook (optional)"
  cat <<'EOF'
  The pre-push hook at daq-server/githooks/pre-push runs ./format.sh before
  every push. If formatting changes anything the push is blocked so you can
  stage + commit the fixes — catching format failures locally instead of CI.

  Note: local convenience only. Real enforcement is GitHub branch protection
  requiring the CI format-check job to pass before merge.

  Enable:            git config core.hooksPath daq-server/githooks
  Disable later:     git config --unset core.hooksPath
  Bypass once:       git push --no-verify
EOF

  if prompt_yes_no "Enable format-on-push hook?" y; then
    [ -x "$REPO_ROOT/daq-server/githooks/pre-push" ] \
      || chmod +x "$REPO_ROOT/daq-server/githooks/pre-push" 2>/dev/null || true
    (cd "$REPO_ROOT" && git config core.hooksPath daq-server/githooks)
    ok "Enabled — core.hooksPath = daq-server/githooks"
  else
    warn "Skipped — enable later with: git config core.hooksPath daq-server/githooks"
  fi
fi

step "daq-server setup complete"

cat <<EOF

Next steps:

  1. If 'cargo' / 'elodin-db' isn't found in fresh shells, add to shell rc:
       export PATH="\$HOME/.cargo/bin:\$PATH"

  2. Run the integration test (macOS: sudo-prompts for loopback aliases):
       cd $REPO_ROOT
       bash daq-server/test/test_integration.sh

  3. Start the dev stack interactively:
       bash daq-server/deploy/startup/start_tmux_dev.sh

  4. Activate the venv when running Python scripts manually:
       source daq-server/.venv/bin/activate

EOF
