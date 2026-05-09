#!/bin/bash
# Fix engine_sim submodule when commit doesn't exist
# Usage: ./scripts/setup/fix_engine_sim.sh

set -e

echo "🔧 Fixing engine_sim submodule..."

cd "$(git rev-parse --show-toplevel)"

# Initialize submodule if needed
if [ ! -d "engine_sim/.git" ]; then
    echo "📦 Initializing engine_sim submodule..."
    git submodule update --init engine_sim
fi

cd engine_sim

# Fetch the christmas branch
echo "📥 Fetching christmas branch..."
git fetch origin christmas || {
    echo "❌ Error: Could not fetch christmas branch"
    echo "   Check your network connection and repository access"
    exit 1
}

# Checkout the branch (create local if needed)
echo "🔀 Checking out christmas branch..."
if git show-ref --verify --quiet refs/heads/christmas; then
    git checkout christmas
    git pull origin christmas || echo "⚠️  Warning: Could not pull, but branch exists"
else
    git checkout -b christmas origin/christmas || {
        echo "❌ Error: Could not checkout christmas branch"
        exit 1
    }
fi

# Update main repo reference
cd ..
echo "📝 Updating main repository reference..."
git add engine_sim
git commit -m "Update engine_sim submodule to christmas branch HEAD" || echo "No changes to commit"

echo "✅ engine_sim submodule fixed!"
echo ""
echo "Current status:"
git submodule status engine_sim
