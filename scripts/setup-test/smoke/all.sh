#!/usr/bin/env bash
# Smoke check: run every per-project smoke script in sequence.
# Matches what setup.sh --all installs.
# Runs from the repo root.
set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECTS=(pid-designer engine-design firmware daq-server)

FAILED=()
for p in "${PROJECTS[@]}"; do
  echo ""
  echo "── smoke: $p"
  if bash "$SMOKE_DIR/$p.sh"; then
    :
  else
    echo "  ✗ $p smoke failed"
    FAILED+=("$p")
  fi
done

echo ""
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "✓ all smoke checks passed (${#PROJECTS[@]} projects)"
else
  echo "✗ failed: ${FAILED[*]}"
  exit 1
fi
