#!/bin/bash
# Quick dependency installer for groundstation GUI

set -e

echo "🔧 Installing Groundstation GUI Dependencies"
echo "=============================================="
echo ""

# Check if running as root for system packages
if [ "$EUID" -eq 0 ]; then
    INSTALL_METHOD="system"
else
    INSTALL_METHOD="pip"
fi

# Method 1: System packages (fastest, recommended)
if command -v apt-get &> /dev/null; then
    echo "📦 Option 1: Installing via apt-get (fastest)..."
    echo "   Run: sudo apt-get install -y python3-pyqt6 python3-pyqt6.qtsvg python3-pyqtgraph python3-numpy"
    echo ""
fi

# Method 2: pip install (slower but works everywhere)
echo "📦 Option 2: Installing via pip..."
echo "   This may take 2-5 minutes (PyQt6 is ~100MB)..."
echo ""

# Check if we should use system packages
read -p "Use system packages (faster)? [Y/n] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    if command -v apt-get &> /dev/null; then
        echo "Installing via apt-get..."
        sudo apt-get update
        sudo apt-get install -y python3-pyqt6 python3-pyqt6.qtsvg python3-pyqtgraph python3-numpy
        echo "✅ Installed via system packages"
    else
        echo "⚠️  apt-get not available, falling back to pip..."
        INSTALL_METHOD="pip"
    fi
else
    INSTALL_METHOD="pip"
fi

# Method 3: pip install
if [ "$INSTALL_METHOD" = "pip" ]; then
    echo "Installing via pip (this may take a few minutes)..."
    pip3 install --timeout=300 PyQt6 pyqtgraph numpy || {
        echo ""
        echo "❌ pip install failed or timed out"
        echo ""
        echo "💡 Try these alternatives:"
        echo "   1. Install via system packages: sudo apt-get install python3-pyqt6 python3-pyqtgraph python3-numpy"
        echo "   2. Use PyQt5 instead: pip3 install PyQt5 pyqtgraph numpy"
        echo "   3. Check your internet connection"
        exit 1
    }
    echo "✅ Installed via pip"
fi

echo ""
echo "✅ Dependencies installed!"
echo ""
echo "🧪 Test installation:"
echo "   python3 -c 'from PyQt6 import QtWidgets; import pyqtgraph; print(\"✅ All imports OK\")'"
echo ""
