#!/bin/bash
# Sensor System - Jetson Xavier NX (and other ARM64 Ubuntu) Setup
# One-shot setup: system deps, elodin-db, Node.js, Python venv, C++ build

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_header() {
    echo -e "\n${CYAN}═══ $1 ═══${NC}"
}

# Must be run from repo root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# -----------------------------------------------------------------------------
# 1. System packages
# -----------------------------------------------------------------------------
print_header "1. Installing system packages"
sudo apt-get update
sudo apt-get install -y \
    build-essential cmake g++ gcc \
    git curl \
    python3 python3-venv python3-dev python3-pip \
    libeigen3-dev libssl-dev zlib1g-dev \
    libgl1-mesa-glx libxkbcommon-x11-0 \
    tmux

# -----------------------------------------------------------------------------
# 2. Elodin DB (Rust binary)
# -----------------------------------------------------------------------------
print_header "2. Installing elodin-db"
ELODIN_BIN="$HOME/.cargo/bin/elodin-db"
if [ -x "$ELODIN_BIN" ]; then
    echo -e "${GREEN}✅ elodin-db already installed${NC}"
else
    # Jetson/ARM64: prebuilt is musl (incompatible with Ubuntu glibc). Build from source.
    if ! command -v cargo &>/dev/null; then
        echo "Installing Rust..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        . "$HOME/.cargo/env"
    fi
    . "$HOME/.cargo/env" 2>/dev/null || true

    # Build from source (prebuilt ARM64 Linux is musl-only; Jetson uses glibc)
    echo "Building elodin-db from source (Jetson/ARM64)..."
    ELODIN_SRC="/tmp/elodin-src"
    rm -rf "$ELODIN_SRC"
    git clone --depth 1 --branch v0.16.2 https://github.com/elodin-sys/elodin.git "$ELODIN_SRC"
    (cd "$ELODIN_SRC" && cargo install --path libs/db/cli)
    # Crate installs as impeller2-cli; symlink to elodin-db for compatibility
    if [ -x "$HOME/.cargo/bin/impeller2-cli" ] && [ ! -x "$ELODIN_BIN" ]; then
        ln -sf impeller2-cli "$ELODIN_BIN"
    fi
    rm -rf "$ELODIN_SRC"
    echo -e "${GREEN}✅ elodin-db built and installed${NC}"
fi

if [ ! -x "$ELODIN_BIN" ]; then
    echo -e "${RED}❌ elodin-db not found. Install manually.${NC}"
    exit 1
fi

# -----------------------------------------------------------------------------
# 3. Node.js 20+ (NodeSource supports ARM64)
# -----------------------------------------------------------------------------
print_header "3. Installing Node.js"
if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 20 ]; then
        echo -e "${GREEN}✅ Node.js $(node -v) already installed${NC}"
    fi
fi
if ! command -v node &>/dev/null || [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo -e "${GREEN}✅ Node.js $(node -v) installed${NC}"
fi

# -----------------------------------------------------------------------------
# 4. Git submodules
# -----------------------------------------------------------------------------
print_header "4. Initializing git submodules"
git submodule update --init --recursive
echo -e "${GREEN}✅ Submodules ready${NC}"

# -----------------------------------------------------------------------------
# 5. Python venv + requirements
# -----------------------------------------------------------------------------
print_header "5. Setting up Python environment"
VENV_DIR="$REPO_ROOT/.venv"
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r requirements.txt
echo -e "${GREEN}✅ Python venv ready${NC}"

# -----------------------------------------------------------------------------
# 6. Web GUI (Node.js)
# -----------------------------------------------------------------------------
print_header "6. Installing Web GUI dependencies"
(cd "$REPO_ROOT/diablo_server/backend" && npm install)
(cd "$REPO_ROOT/diablo_server/frontend" && npm install)
echo -e "${GREEN}✅ Web GUI deps installed${NC}"

# -----------------------------------------------------------------------------
# 7. C++ build
# -----------------------------------------------------------------------------
print_header "7. Building C++ components"
mkdir -p build
(cd build && cmake .. && make -j$(nproc))
echo -e "${GREEN}✅ C++ build complete${NC}"

# -----------------------------------------------------------------------------
# 8. Calibration dirs
# -----------------------------------------------------------------------------
print_header "8. Creating calibration directories"
mkdir -p tools/calibration/calibrations
mkdir -p tools/calibration/calibrations/pt
mkdir -p tools/calibration/calibrations/tc
mkdir -p tools/calibration/calibrations/rtd
mkdir -p tools/calibration/calibrations/lc
echo -e "${GREEN}✅ Calibration dirs ready${NC}"

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
print_header "Setup Complete!"
echo -e "
${GREEN}Jetson setup finished.${NC}

To start the full stack:
  ${CYAN}source .venv/bin/activate${NC}
  ${CYAN}./scripts/startup/start_tmux_dev.sh${NC}

Or for minimal (DB + DAQ):
  ${CYAN}elodin-db run '[::]:2240' ~/.local/share/elodin/daq_live &${NC}
  ${CYAN}./build/bin/daq_bridge config/config.toml${NC}

Web GUI: http://<jetson-ip>:3000
"
