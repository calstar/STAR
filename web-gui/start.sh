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

# Elodin DB must run first — relay and daq_bridge both connect to it
ELODIN_PORT="${ELODIN_PORT:-2240}"
DB_NAME="sensor_system"
DB_PATH="$HOME/.local/share/elodin/$DB_NAME"
ELODIN_DB_BIN=""
[ -f "$HOME/.cargo/bin/elodin-db" ] && ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
[ -z "$ELODIN_DB_BIN" ] && command -v elodin-db &>/dev/null && ELODIN_DB_BIN="elodin-db"

if [ -n "$ELODIN_DB_BIN" ]; then
  if ! lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
    echo "📊 Starting Elodin DB on port $ELODIN_PORT..."
    mkdir -p "$(dirname "$DB_PATH")"
    RUST_LOG=warn $ELODIN_DB_BIN run "[::]:$ELODIN_PORT" "$DB_PATH" > /tmp/elodin_db_${DB_NAME}.log 2>&1 &
    ELODIN_PID=$!
    sleep 2
    if lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
      echo "   ✅ Elodin DB ready"
    else
      echo "   ⚠️ Elodin DB may have failed — check /tmp/elodin_db_${DB_NAME}.log"
    fi
  else
    echo "📊 Elodin DB already running on port $ELODIN_PORT"
    ELODIN_PID=""
  fi
else
  echo "⚠️ elodin-db not found — ensure it's running on port $ELODIN_PORT for data"
  ELODIN_PID=""
fi

# Start Elodin relay (single subscriber → many WS clients)
echo "📡 Starting Elodin relay..."
cd backend
if [ ! -d "node_modules" ]; then
    echo "📦 Installing backend dependencies..."
    npm install
fi
npm run relay &
RELAY_PID=$!
cd ..
sleep 1

# Backend: data only from DB via relay (modular; no direct UDP/Elodin stream)
echo "📡 Starting WebSocket server (data via relay)..."
cd backend
ELODIN_RELAY_WS_URL=ws://localhost:9090 USE_DIRECT_DAQ=false npm run dev &
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

echo "🚀 Starting daq_bridge (config from repo root)..."
./daq_bridge ../../config/config.toml &
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
echo "📡 Elodin relay: ws://localhost:9090 (raw data fan-out)"
echo "📡 WebSocket server: http://localhost:8081"
echo "🌐 Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for user interrupt
trap "echo 'Stopping all services...'; kill $BACKEND_PID $FRONTEND_PID $RELAY_PID $DAQ_BRIDGE_PID $CONTROLLER_PID $ELODIN_PID 2>/dev/null; exit" INT TERM
wait
