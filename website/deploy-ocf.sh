#!/usr/bin/env bash
# Deploy the STAR public website to this OCF machine's web root.
#
# One-time setup (from your OCF home dir):
#   git clone --filter=blob:none --sparse https://github.com/calstar/STAR.git ~/star
#   cd ~/star && git sparse-checkout set website
#
# Then to (re)deploy — pull latest, build, and publish:
#   ~/star/website/deploy-ocf.sh
#
# Override paths with env vars if yours differ, e.g.:
#   WEB_ROOT=~/public_html REPO_DIR=~/star ~/star/website/deploy-ocf.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$HERE/.." && pwd)}"   # the monorepo checkout
WEB_ROOT="${WEB_ROOT:-$HOME/public_html}"          # what OCF serves

echo "==> Repo:     $REPO_DIR"
echo "==> Web root: $WEB_ROOT"

# 1. Pull the latest website source.
git -C "$REPO_DIR" pull --ff-only

# 2. Install exactly what package-lock.json pins, then build to website/dist.
cd "$HERE"
npm ci
npm run build

# 3. Publish. --delete makes WEB_ROOT an exact mirror of dist/ (removes the old
#    site's files). The .htaccess ships inside dist/ from public/.
mkdir -p "$WEB_ROOT"
rsync -a --delete "$HERE/dist/" "$WEB_ROOT/"

echo "==> Deployed $(date). Live from $WEB_ROOT"
