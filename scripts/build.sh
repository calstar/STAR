#!/usr/bin/env bash
# Canonical C++ build for this repo. Used by the `build` / `diablo-build` alias and by
# deploy/startup/start_tmux_dev.sh so guitest / Playwright E2E and manual builds match.
#
# Env:
#   USE_SIM — passed to CMake as -DUSE_SIM=… (default 0). Export USE_SIM=1 for sim builds.
#
set -euo pipefail

trap 'echo "Build failed." >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT/build"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
SIM_FLAG="-DUSE_SIM=${USE_SIM:-0}"

echo "🔨 Building Sensor System..."
echo "   cmake -S \"$ROOT\" -B \"$BUILD_DIR\" $SIM_FLAG -Wno-dev"
echo "   cmake --build \"$BUILD_DIR\" -j$JOBS"
echo ""

cmake -S "$ROOT" -B "$BUILD_DIR" "$SIM_FLAG" -Wno-dev
cmake --build "$BUILD_DIR" -j"$JOBS"

echo ""
echo "✅ Build complete!"
echo "   Binaries: $BUILD_DIR/bin/"
