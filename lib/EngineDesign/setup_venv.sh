#!/bin/bash
# Setup script for EngineDesign on macOS (Apple Silicon)

set -e

echo "Setting up EngineDesign virtual environment..."

# Activate virtual environment if it exists
if [ -d ".venv" ]; then
    source .venv/bin/activate
    echo "Virtual environment activated"
else
    echo "Creating virtual environment..."
    python3 -m venv .venv
    source .venv/bin/activate
fi

# Upgrade pip
echo "Upgrading pip..."
pip install --upgrade pip setuptools wheel

# Install numpy and scipy first to ensure correct architecture
echo "Installing numpy and scipy..."
pip install numpy scipy

# Try to install build dependencies, but continue if it fails
echo "Installing build dependencies (mesonpy, meson, ninja)..."
pip install mesonpy meson ninja || echo "Warning: Could not install some build dependencies, will try alternative method"

# Set architecture flags for Apple Silicon
export ARCHFLAGS="-arch arm64"

# Try installing rocketcea with --no-build-isolation first, fall back to regular install
echo "Installing rocketcea (this may take a few minutes)..."
if pip install --no-build-isolation rocketcea 2>/dev/null; then
    echo "✓ Installed rocketcea with --no-build-isolation"
else
    echo "Trying regular installation with ARCHFLAGS..."
    pip install rocketcea
fi

# Install remaining dependencies
echo "Installing remaining dependencies..."
pip install pandas matplotlib pydantic PyYAML rocketpy streamlit plotly ezdxf cma CoolProp fastapi "uvicorn[standard]" python-multipart

echo ""
echo "✓ Installation complete!"
echo ""
echo "To activate the virtual environment in the future, run:"
echo "  source .venv/bin/activate"

