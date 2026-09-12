#!/usr/bin/env bash
# Sync the shared brand masters (assets/brand/) into each consuming app's local
# tree.
#
# Why copies at all? Each frontend builds its Docker image with its OWN directory
# as the build context (e.g. `context: ./landing`), so the build cannot reach up
# into assets/brand/. The copies this writes are committed only so those isolated
# builds can see them -- they are generated, not source. Edit the masters under
# assets/brand/, run this, and commit both. See assets/brand/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/assets/brand"

# One "<master> -> <dest dir>" copy per line (dest dir is relative to the repo
# root). Add a line here when a new app adopts a brand asset.
#
#   star-wordmark.png -> src/assets  : imported by React components (dark headers)
#   star-icon.svg     -> public      : browser-tab favicon, referenced from
#                                      index.html as /star-icon.svg. It's a
#                                      self-contained blue badge (white logo on
#                                      the STAR navy #20415E) so it stays legible
#                                      on both light and dark browser tabs.
COPIES=(
  # Full STAR wordmark (imported in React)
  "star-wordmark.png:landing/src/assets"
  "star-wordmark.png:star-openrocket/frontend/src/assets"
  "star-wordmark.png:daq-server/tools/postprocessing/webviewer/frontend/src/assets"

  # Browser-tab favicon (served from each app's public/ at /star-icon.svg)
  "star-icon.svg:landing/public"
  "star-icon.svg:EngineDesign/frontend/public"
  "star-icon.svg:pid-designer/frontend/public"
  "star-icon.svg:star-openrocket/frontend/public"
  "star-icon.svg:daq-server/diablo_server/frontend/public"
  "star-icon.svg:daq-server/tools/postprocessing/webviewer/frontend/public"
)

for spec in "${COPIES[@]}"; do
  file="${spec%%:*}"
  dest="${spec#*:}"
  mkdir -p "$ROOT/$dest"
  cp "$SRC/$file" "$ROOT/$dest/$file"
  echo "  $dest/$file"
done

echo "Brand assets synced to ${#COPIES[@]} destination(s)."
