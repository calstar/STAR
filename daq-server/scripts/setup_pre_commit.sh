#!/bin/bash
# Setup script for pre-commit hooks

set -e

echo "🔧 Setting up pre-commit hooks..."

# Check if we're in a virtual environment
if [ -n "$VIRTUAL_ENV" ]; then
    echo "📦 Detected virtual environment: $VIRTUAL_ENV"
    PIP_INSTALL_CMD="pip install"
    USE_USER_FLAG=false
else
    echo "📦 Installing to user site-packages..."
    PIP_INSTALL_CMD="pip3 install --user"
    USE_USER_FLAG=true
fi

# Check if pre-commit is installed
if ! command -v pre-commit &> /dev/null; then
    echo "📦 Installing pre-commit..."
    if [ "$USE_USER_FLAG" = true ]; then
        pip3 install --user pre-commit || pip install --user pre-commit
        export PATH="$HOME/.local/bin:$PATH"
    else
        pip install pre-commit || pip3 install pre-commit
    fi
fi

# Install pre-commit hooks
echo "📝 Installing pre-commit hooks..."
pre-commit install

# Install hooks for commit-msg and pre-push
pre-commit install --hook-type commit-msg
pre-commit install --hook-type pre-push

echo "✅ Pre-commit hooks installed successfully!"
echo ""
echo "To test the hooks, run:"
echo "  pre-commit run --all-files"
echo ""
echo "To skip hooks for a commit (not recommended), use:"
echo "  git commit --no-verify"
