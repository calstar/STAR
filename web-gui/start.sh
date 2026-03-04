#!/bin/bash
# Quick start script for Sensor System Web GUI
# Use DEMO_MODE=1 or --demo for hardware-free testing (synthetic PT/actuator data)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DEMO_MODE=false
[[ "$1" = "--demo" ]] || [[ "${DEMO_MODE:-0}" = "1" ]] && DEMO_MODE=true

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
sleep 3

# Backend: data only from DB via relay (modular; no direct UDP/Elodin stream)
# DEMO_MODE=true: injects synthetic PT sweep + actuator data for hardware-free validation
echo "📡 Starting WebSocket server (data via relay)..."
cd backend
BACKEND_ENV="ELODIN_RELAY_WS_URL=ws://localhost:9090 USE_DIRECT_DAQ=false"
$DEMO_MODE && BACKEND_ENV="$BACKEND_ENV DEMO_MODE=true"
$BACKEND_ENV npm run dev &
BACKEND_PID=$!
cd ..

# In demo mode, skip daq_bridge+simulator (demo injects data directly); otherwise build and run full pipeline
DAQ_BRIDGE_PID=""; SIMULATOR_PID=""; CONTROLLER_PID=""
if ! $DEMO_MODE; then
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
sleep 4

echo "🔧 Adding loopback aliases (192.168.2.21, .22...) for simulator..."
( [ -x ../../scripts/setup_sim_network.sh ] && ../../scripts/setup_sim_network.sh ) &
sleep 2
# If aliases fail (sudo prompt), simulator falls back to 127.0.0.x — data still flows

echo "🎭 Starting board_simulator (PT data → :5006)..."
cd ../..
python3 scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 --only-type PT &
SIMULATOR_PID=$!
cd FSW/build

echo "🚀 Starting controller_service..."
./controller_service --config ../../config/config.toml --elodin-host 127.0.0.1 &
CONTROLLER_PID=$!

cd ../../web-gui
fi

# Calibration sidecar (reads raw PT from relay, writes calibrated PT to Elodin DB)
SIDECAR_SCRIPT="$SCRIPT_DIR/../scripts/calibration/calibration_server.py"
if [ -f "$SIDECAR_SCRIPT" ] && command -v python3 &>/dev/null; then
  echo "🧪 Starting calibration sidecar..."
  PYTHONPATH="$SCRIPT_DIR/.." python3 "$SIDECAR_SCRIPT" > /tmp/calibration_sidecar.log 2>&1 &
  SIDECAR_PID=$!
  echo "   ✅ Calibration sidecar started (pid $SIDECAR_PID), log: /tmp/calibration_sidecar.log"
else
  SIDECAR_PID=""
  echo "   ⚠️ calibration_server.py not found or python3 not installed — skipping"
fi


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
$DEMO_MODE && echo "   🎭 DEMO MODE — synthetic PT sweep + actuator data (no hardware)"
echo ""
echo "📡 Elodin relay: ws://localhost:9090 (raw data fan-out)"
echo "📡 WebSocket server: http://localhost:8081"
echo "🌐 Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for user interrupt
trap "echo 'Stopping all services...'; kill $BACKEND_PID $FRONTEND_PID $RELAY_PID $DAQ_BRIDGE_PID $SIMULATOR_PID $CONTROLLER_PID $SIDECAR_PID $ELODIN_PID 2>/dev/null; exit" INT TERM
wait
