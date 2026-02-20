#!/bin/bash
# Pull all submodules and main repository updates
# Usage: ./scripts/setup/pull_all.sh

set -e

echo "🔄 Pulling all updates (main repo + submodules)..."
echo ""

# Pull main repository
echo "📦 Pulling main repository..."
git pull

# Initialize submodules if needed
echo ""
echo "🔧 Initializing submodules..."
git submodule update --init --recursive

# Update all submodules to latest commits
echo ""
echo "⬆️  Updating all submodules to latest commits..."
git submodule update --remote --recursive

# Pull changes in each submodule
echo ""
echo "📥 Pulling changes in each submodule..."
git submodule foreach git pull

echo ""
echo "✅ All updates complete!"
echo ""
echo "Submodule status:"
git submodule status

