#!/bin/bash
# Quick installation script for Sensor System Web GUI
# Installs Node.js and all dependencies

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Sensor System Web GUI - Quick Install"
echo "=========================================="
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "⚠️  Don't run this script as root/sudo"
    echo "   The script will use sudo only when needed"
    exit 1
fi

# Step 1: Install Node.js
echo "📦 Step 1: Installing Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 20 ]; then
        echo "✅ Node.js $(node -v) is already installed"
    else
        echo "⚠️  Node.js $(node -v) is too old. Installing Node.js 20+..."
        ./install_nodejs.sh
    fi
else
    echo "📥 Node.js not found. Installing..."
    ./install_nodejs.sh
fi

# Step 2: Install dependencies
echo ""
echo "📦 Step 2: Installing dependencies..."

cd "$SCRIPT_DIR/backend"
if [ ! -d "node_modules" ]; then
    echo "  Installing backend dependencies..."
    npm install
else
    echo "  ✅ Backend dependencies already installed"
fi

cd "$SCRIPT_DIR/frontend"
if [ ! -d "node_modules" ]; then
    echo "  Installing frontend dependencies..."
    npm install
else
    echo "  ✅ Frontend dependencies already installed"
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "🚀 Next steps:"
echo "   1. Start the system: ./scripts/startup/start_tmux.sh"
echo "   2. Open browser: http://localhost:3000"
echo "   3. For network access: http://<your-ip>:3000"
echo ""



