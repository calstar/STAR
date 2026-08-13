#!/usr/bin/env bash
# Canonical C++ build for this repo. Used by the `build` / `diablo-build` alias,
# test/test_integration.sh, and deploy/startup/start_tmux_dev.sh so integration,
# guitest / Playwright E2E, and manual builds all produce identical binaries.
#
# NOTE on USE_SIM: it is a RUNTIME environment variable (read by
# calibration_service and the launch scripts to select sim behavior), not a
# compile flag — no CMake file consumes it. The binaries are identical for sim
# and hardware; a historical -DUSE_SIM define was removed as dead.
#
set -euo pipefail

trap 'echo "Build failed." >&2' ERR

# pwd -P (physical path) so building through a symlink still resolves the repo's
# sibling `../lib` correctly. On a systemd deploy ~/sensor_system is a symlink to
# this daq-server dir; a logical `pwd` would make CMake's `../lib` escape to the
# symlink's parent (e.g. ~/lib) and fail with "Cannot find source file".
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
BUILD_DIR="$ROOT/build"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo "🔨 Building Sensor System..."
echo "   cmake -S \"$ROOT\" -B \"$BUILD_DIR\" -Wno-dev"
echo "   cmake --build \"$BUILD_DIR\" -j$JOBS"
echo ""

cmake -S "$ROOT" -B "$BUILD_DIR" -Wno-dev
cmake --build "$BUILD_DIR" -j"$JOBS"

echo ""
echo "✅ Build complete!"
echo "   Binaries: $BUILD_DIR/bin/"
