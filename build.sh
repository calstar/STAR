#!/usr/bin/env bash

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
make -j$(nproc)

echo "✅ Build complete!"
echo "Executable location: $(pwd)/scripts/fake_sensor_generator"
