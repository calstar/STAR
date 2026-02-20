#!/bin/bash
# Node.js Installation Script
# Installs Node.js 20+ for the Sensor System Web GUI

set -e

echo "🔧 Installing Node.js and npm for Sensor System Web GUI..."

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VERSION=$VERSION_ID
else
    echo "❌ Cannot detect OS. Please install Node.js manually."
    exit 1
fi

# Check if Node.js is already installed
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 20 ]; then
        echo "✅ Node.js $(node -v) is already installed"
        exit 0
    else
        echo "⚠️  Node.js version $(node -v) is too old. Need version 20+"
    fi
fi

echo "📦 Detected OS: $OS $VERSION"

# Install Node.js based on OS
case $OS in
    ubuntu|debian)
        echo "📥 Installing Node.js 20.x for Ubuntu/Debian..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
        ;;

    fedora|rhel|centos)
        echo "📥 Installing Node.js 20.x for Fedora/RHEL/CentOS..."
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs || sudo dnf install -y nodejs
        ;;

    arch|manjaro)
        echo "📥 Installing Node.js for Arch/Manjaro..."
        sudo pacman -S --noconfirm nodejs npm
        ;;

    *)
        echo "⚠️  Unsupported OS: $OS"
        echo "Please install Node.js 20+ manually from https://nodejs.org/"
        exit 1
        ;;
esac

# Verify installation
if command -v node &> /dev/null; then
    echo "✅ Node.js $(node -v) installed successfully"
    echo "✅ npm $(npm -v) installed successfully"
else
    echo "❌ Node.js installation failed"
    exit 1
fi

# Install dependencies
echo "📦 Installing Web GUI dependencies..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR/backend"
if [ ! -d "node_modules" ]; then
    echo "  Installing backend dependencies..."
    npm install
else
    echo "  Backend dependencies already installed"
fi

cd "$SCRIPT_DIR/frontend"
if [ ! -d "node_modules" ]; then
    echo "  Installing frontend dependencies..."
    npm install
else
    echo "  Frontend dependencies already installed"
fi

echo ""
echo "✅ Installation complete!"
echo "🚀 You can now run: ./scripts/startup/start_tmux.sh"



