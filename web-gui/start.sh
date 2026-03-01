#!/bin/bash
# Quick start script for Sensor System Web GUI

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Starting Sensor System Web GUI..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 20+ first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js version 20+ is required. Current version: $(node -v)"
    exit 1
fi

# Start backend
echo "📡 Starting WebSocket server..."
cd backend
if [ ! -d "node_modules" ]; then
    echo "📦 Installing backend dependencies..."
    npm install
fi
npm run dev &
BACKEND_PID=$!
cd ..

# Build and start C++ FSW components
echo "⚙️  Building and starting C++ FSW components (daq_bridge, controller_service)..."
cd ../FSW
if [ ! -d "build" ]; then
    mkdir -p build
    cd build
    cmake ..
    cd ..
fi
cd build
make -j$(nproc) daq_bridge controller_service

echo "🚀 Starting daq_bridge..."
./daq_bridge &
DAQ_BRIDGE_PID=$!

echo "🚀 Starting controller_service..."
./controller_service &
CONTROLLER_PID=$!

cd ../../web-gui


# Wait for backend to start
sleep 2

# Start frontend
echo "🌐 Starting Next.js frontend..."
cd frontend
if [ ! -d "node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    npm install
fi
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ Web GUI started!"
echo ""
echo "📡 WebSocket server: http://localhost:8081"
echo "🌐 Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for user interrupt
trap "echo 'Stopping all services...'; kill $BACKEND_PID $FRONTEND_PID $DAQ_BRIDGE_PID $CONTROLLER_PID 2>/dev/null; exit" INT TERM
wait
