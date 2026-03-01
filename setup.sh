#!/bin/bash

# Sensor System Setup Script for Linux/WSL
# This script initializes submodules, sets up a Python virtual environment,
# and installs dependencies for the Web GUI.

set -e # Exit on error

# Terminal colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
    echo -e "\n${CYAN}==================================================${NC}"
    echo -e "${CYAN} $1${NC}"
    echo -e "${CYAN}==================================================${NC}"
}

print_header "Starting Sensor System Setup (Linux/WSL)"

# ---------------------------------------------------------
# Check for Prerequisites
# ---------------------------------------------------------
print_header "Checking Prerequisites"

check_cmd() {
    if command -v "$1" >/dev/null 2>&1; then
        echo -e " [OK] $1 is installed."
    else
        echo -e "${RED} [!] $1 is NOT found in PATH.${NC}"
        echo -e "${YELLOW} Please install $1 and restart this script.${NC}"
        exit 1
    fi
}

check_cmd "git"
check_cmd "python3"
check_cmd "node"
check_cmd "npm"

# ---------------------------------------------------------
# Step 1: Initialize Submodules
# ---------------------------------------------------------
print_header "Step 1: Initializing Git Submodules"
echo "Running: git submodule update --init --recursive"
git submodule update --init --recursive
echo -e "${GREEN}Submodules initialized successfully.${NC}"

# ---------------------------------------------------------
# Step 2: Set up Python Virtual Environment
# ---------------------------------------------------------
print_header "Step 2: Setting up Python Environment"
VENV_DIR=".venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment in $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
else
    echo "Virtual environment already exists."
fi

echo "Upgrading pip and installing requirements..."
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r requirements.txt

echo -e "${GREEN}Python environment setup complete.${NC}"

# ---------------------------------------------------------
# Step 3: Set up Web GUI (Node.js)
# ---------------------------------------------------------
print_header "Step 3: Setting up Node.js Environments"

# Backend
echo "Setting up Backend (web-gui/backend)..."
(cd web-gui/backend && npm install)

# Frontend
echo "Setting up Frontend (web-gui/frontend)..."
(cd web-gui/frontend && npm install)

echo -e "${GREEN}Node.js dependencies installed successfully.${NC}"

# ---------------------------------------------------------
# Step 4: C++ Build Hint
# ---------------------------------------------------------
print_header "Step 4: C++ Build Information"

if command -v cmake >/dev/null 2>&1; then
    echo -e "CMake is available. To build C++ components, run:"
    echo -e "  mkdir -p build && cd build && cmake .. && make -j\$(nproc)"
else
    echo -e "${YELLOW}[!] CMake is not installed. C++ components will not be built.${NC}"
    echo -e "${YELLOW}[!] These are required for Flight Software logic run locally.${NC}"
fi

# ---------------------------------------------------------
# Summary
# ---------------------------------------------------------
print_header "Setup Complete!"
echo -e "To start the system:"
echo -e " 1. ${CYAN}Activate Python:${NC} source .venv/bin/activate"
echo -e " 2. ${CYAN}Start Backend:${NC}   (cd web-gui/backend && npm run dev)"
echo -e " 3. ${CYAN}Start Frontend:${NC}  (cd web-gui/frontend && npm run dev)"
echo -e " 4. ${CYAN}Start Control:${NC}   python3 scripts/calibration/calibration_server.py"
echo -e "\n${GREEN}Enjoy your Sensor System setup!${NC}\n"
