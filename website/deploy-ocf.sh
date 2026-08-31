#!/usr/bin/env bash
# Deploy the STAR public website to the OCF web server.
#
# ── How OCF serves this site ────────────────────────────────────────────────
# The account's ~/public_html is a SYMLINK to the real web root that Apache
# serves, e.g.:
#
#     ~/public_html -> /services/http/users/s/space
#
# Apache reads the symlink target. So we publish by rsyncing into ~/public_html
# (which follows the symlink into the served directory). Do NOT `mv`/`rm` the
# symlink and `mkdir` a real folder in its place — a plain ~/public_html is not
# what Apache serves, so the site would appear unchanged. If the symlink is ever
# missing, recreate it (adjust the target to match your account):
#
#     ln -sfn /services/http/users/s/space ~/public_html
#
# ── One-time setup (from the OCF account's home dir) ─────────────────────────
#   git clone --filter=blob:none --sparse https://github.com/calstar/STAR.git ~/star
#   cd ~/star
#   git sparse-checkout set website
#   git checkout public-website        # or `main` once the PR is merged
#
# ── Deploy / redeploy (pull, build, publish) ────────────────────────────────
#   ~/star/website/deploy-ocf.sh
#
# Override paths with env vars if yours differ:
#   WEB_ROOT=~/public_html REPO_DIR=~/star ~/star/website/deploy-ocf.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$HERE/.." && pwd)}"   # the monorepo checkout
WEB_ROOT="${WEB_ROOT:-$HOME/public_html}"          # symlink OCF serves from

echo "==> Repo:     $REPO_DIR"
echo "==> Web root: $WEB_ROOT -> $(readlink -f "$WEB_ROOT" 2>/dev/null || echo '???')"

# Guard: WEB_ROOT must resolve to an existing directory (normally the symlink
# target). If it doesn't, bail rather than silently publishing somewhere Apache
# never reads.
if [ ! -d "$WEB_ROOT" ]; then
  echo "ERROR: $WEB_ROOT is not a directory." >&2
  echo "On OCF it should be a symlink to the served web root, e.g.:" >&2
  echo "  ln -sfn /services/http/users/s/space ~/public_html" >&2
  exit 1
fi

# 1. Pull the latest website source (whatever branch is checked out).
git -C "$REPO_DIR" pull --ff-only

# 2. Install exactly what package-lock.json pins, then build to website/dist.
cd "$HERE"
npm ci
npm run build

# 3. Publish. Trailing slashes + --delete make the web root an exact mirror of
#    dist/ (removes stale files from the old site). The .htaccess ships inside
#    dist/ from public/. rsync follows the public_html symlink into the real dir.
rsync -a --delete "$HERE/dist/" "$WEB_ROOT/"

echo "==> Deployed $(date). Live from $WEB_ROOT"
