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

# For engine_sim, handle branch tracking specially
echo ""
echo "🔧 Updating engine_sim submodule (christmas branch)..."
cd engine_sim
git fetch origin christmas || echo "⚠️  Warning: Could not fetch christmas branch"
git checkout christmas 2>/dev/null || git checkout -b christmas origin/christmas
git pull origin christmas || echo "⚠️  Warning: Could not pull christmas branch"
cd ..

# Update all submodules to latest commits
echo ""
echo "⬆️  Updating all submodules to latest commits..."
git submodule update --remote --recursive

# Pull changes in each submodule
echo ""
echo "📥 Pulling changes in each submodule..."
git submodule foreach 'git pull || echo "⚠️  Warning: Could not pull in $name"'

echo ""
echo "✅ All updates complete!"
echo ""
echo "Submodule status:"
git submodule status
