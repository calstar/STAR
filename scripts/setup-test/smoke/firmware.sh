#!/usr/bin/env bash
# Smoke check: firmware setup made PlatformIO usable + fixed critical symlinks.
# Runs from the repo root.
set -euo pipefail

echo "  → PlatformIO on PATH"
# pip --user installs go to ~/.local/bin on Linux, ~/Library/Python/X.Y/bin on
# macOS. Both may not be on PATH in a fresh shell — check explicitly.
if command -v pio >/dev/null 2>&1; then
  PIO_BIN="$(command -v pio)"
elif [ -x "$HOME/.local/bin/pio" ]; then
  PIO_BIN="$HOME/.local/bin/pio"
else
  # macOS pip --user location, best-effort.
  PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  if [ -x "$HOME/Library/Python/$PY_VER/bin/pio" ]; then
    PIO_BIN="$HOME/Library/Python/$PY_VER/bin/pio"
  else
    echo "  ✗ pio not on PATH and not at expected pip --user location"
    exit 1
  fi
fi
echo "  ✓ pio at $PIO_BIN ($($PIO_BIN --version 2>&1 | head -1))"

echo "  → DAQv2-Comms symlink intact (Windows-clone foot-gun)"
# firmware/*/DAQv2-Comms typically points at ../../lib/DAQv2-Comms. If someone
# cloned on Windows without symlink support, this shows up as a plain text file
# containing the target path — which silently breaks builds.
FAIL=0
for link in firmware/*/DAQv2-Comms firmware/*/*/DAQv2-Comms; do
  [ -e "$link" ] || continue
  if [ -L "$link" ]; then
    if [ ! -e "$link" ]; then
      echo "  ✗ dangling symlink: $link"
      FAIL=1
    fi
  else
    # Not a symlink and not a directory — probably the Windows text-file bug.
    if [ ! -d "$link" ]; then
      echo "  ✗ $link is not a symlink or directory (Windows clone bug?)"
      FAIL=1
    fi
  fi
done
[ "$FAIL" = "0" ] && echo "  ✓ symlinks look sane"
[ "$FAIL" = "0" ] || exit 1

echo "  ✓ firmware smoke passed"
