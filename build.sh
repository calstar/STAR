#!/usr/bin/env bash
set -euo pipefail

trap 'echo "Build failed." >&2' ERR

# Build script for the sensor system

echo "🔨 Building Sensor System..."

# Create build directory
mkdir -p build
cd build

# Run CMake
echo "Running CMake..."
cmake ..

# Build the project
echo "Building project..."
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
make -j"${JOBS}"

echo "✅ Build complete!"
echo "Executable location: $(pwd)/scripts/fake_sensor_generator"
