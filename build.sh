#!/usr/bin/env bash
set -euo pipefail

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
if make -j$(nproc); then
  echo "✅ Build complete!"
else
  echo "❌ Build failed!"
  exit 1
fi
