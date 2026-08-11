#!/usr/bin/env bash
# Sync the shared brand masters (assets/brand/) into each consuming app's local
# assets dir.
#
# Why copies at all? Each frontend builds its Docker image with its OWN directory
# as the build context (e.g. `context: ./landing`), so the build cannot reach up
# into assets/brand/. The copies this writes are committed only so those isolated
# builds can see them -- they are generated, not source. Edit the masters under
# assets/brand/, run this, and commit both. See assets/brand/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets/brand"

# Consumers: each app's assets dir (relative to the repo root) that should get a
# copy of the brand masters. Add a line here when a new app adopts the logo.
CONSUMERS=(
  "landing/src/assets"
)

# The master files to distribute (basenames under assets/brand/).
FILES=(
  "star-wordmark.png"
)

for dest in "${CONSUMERS[@]}"; do
  mkdir -p "$ROOT/$dest"
  for f in "${FILES[@]}"; do
    cp "$SRC/$f" "$ROOT/$dest/$f"
    echo "  $dest/$f"
  done
done

echo "Brand assets synced to ${#CONSUMERS[@]} consumer(s)."
