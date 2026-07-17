#!/usr/bin/env bash
# Build the frontend SPA (Vite) if sources changed since the last build.
# The backend serves frontend/dist on GUI_PORT (:3000) — there is no frontend
# server process anymore. Cold starts skip the build entirely when dist/ is
# already current, so startup stays fast.
#
# Usage: bash ensure_frontend_build.sh   (safe to run repeatedly)
# Env:   FRONTEND_FORCE_BUILD=1  — rebuild unconditionally

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$SCRIPT_DIR/../../diablo_server/frontend"
cd "$FRONTEND"

if [ ! -d node_modules ]; then
  echo "[frontend-build] node_modules missing — running npm install..."
  npm install
fi

needs_build=0
if [ "${FRONTEND_FORCE_BUILD:-0}" = "1" ]; then
  needs_build=1
elif [ ! -f dist/index.html ]; then
  needs_build=1
else
  # Any source newer than the last build output → rebuild.
  if find app components lib src index.html package.json vite.config.ts \
       tailwind.config.ts tsconfig.json ../shared \
       -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.html' -o -name '*.json' \) \
       -newer dist/index.html 2>/dev/null | head -1 | grep -q .; then
    needs_build=1
  fi
fi

if [ "$needs_build" = "1" ]; then
  echo "[frontend-build] Sources changed (or no build) — running vite build..."
  npm run build
  echo "[frontend-build] Done."
else
  echo "[frontend-build] dist/ is up to date — skipping build."
fi
