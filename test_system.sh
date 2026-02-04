#!/usr/bin/env bash

# Test script for the sensor system

echo "🧪 Testing Sensor System..."

# Check if elodin-db is available
if ! command -v elodin-db &> /dev/null; then
    echo "❌ elodin-db not found in PATH. Please install elodin-db first."
    exit 1
fi

echo "✅ elodin-db found"

# Check if tmux is available
if ! command -v tmux &> /dev/null; then
    echo "❌ tmux not found in PATH. Please install tmux first."
    exit 1
fi

echo "✅ tmux found"

# Check if cmake is available
if ! command -v cmake &> /dev/null; then
    echo "❌ cmake not found in PATH. Please install cmake first."
    exit 1
fi

echo "✅ cmake found"

# Check if g++ is available
if ! command -v g++ &> /dev/null; then
    echo "❌ g++ not found in PATH. Please install g++ first."
    exit 1
fi

echo "✅ g++ found"

# Test build
echo "🔨 Testing build..."
if ./build.sh; then
    echo "✅ Build successful"
else
    echo "❌ Build failed"
    exit 1
fi

# Test database startup
echo "🗄️ Testing database startup..."
source startup.sh
cd shell
if source startup_db.sh test_db; then
    echo "✅ Database startup successful"
    # Kill the database process
    pkill -f "elodin-db run"
    sleep 2
else
    echo "❌ Database startup failed"
    exit 1
fi

echo ""
echo "🎉 All tests passed! The sensor system is ready to use."
echo ""
echo "To start the system:"
echo "  1. source startup.sh"
echo "  2. ./shell/tmux_start_sensors.sh config/config_base.toml test_db"
echo ""
echo "To stop the system:"
echo "  tmux kill-session -t sensor_system"
