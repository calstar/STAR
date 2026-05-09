#!/bin/bash
# Quick start script for Sensor System Web GUI
# Use DEMO_MODE=1 or --demo for hardware-free testing (synthetic PT/actuator data)
# Use --replay [DB_NAME] or ELODIN_DB_NAME=daq_YYYYMMDD_HHMMSS to load a past DB (GUI + relay only; no daq_bridge/simulator).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DEMO_MODE=false
REPLAY_MODE=false
DB_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --demo) DEMO_MODE=true; shift ;;
    --replay)
      REPLAY_MODE=true
      shift
      if [[ -n "${1:-}" && "$1" != --* ]]; then DB_NAME="$1"; shift; fi
      ;;
    *) shift ;;
  esac
done
[[ "${DEMO_MODE:-0}" = "1" ]] && DEMO_MODE=true
DB_NAME="${DB_NAME:-${ELODIN_DB_NAME:-sensor_system}}"

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
DB_PATH="$HOME/.local/share/elodin/$DB_NAME"
ELODIN_DB_BIN=""
[ -f "$HOME/.cargo/bin/elodin-db" ] && ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
[ -z "$ELODIN_DB_BIN" ] && command -v elodin-db &>/dev/null && ELODIN_DB_BIN="elodin-db"

if [ -n "$ELODIN_DB_BIN" ]; then
  if ! lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
    echo "📊 Starting Elodin DB on port $ELODIN_PORT (DB: $DB_NAME)..."
    mkdir -p "$(dirname "$DB_PATH")"
    if [ ! -d "$DB_PATH" ] && [ "$REPLAY_MODE" = true ]; then
      echo "   ❌ Replay DB not found: $DB_PATH"
      echo "   Use a name under ~/.local/share/elodin/ (e.g. daq_20260306_043134) or run with ELODIN_DB_NAME=..."
      exit 1
    fi
    if [ "$REPLAY_MODE" = true ]; then
      RUST_LOG=warn $ELODIN_DB_BIN run "[::]:$ELODIN_PORT" "$DB_PATH" --replay > /tmp/elodin_db_${DB_NAME}.log 2>&1 &
    else
      RUST_LOG=warn $ELODIN_DB_BIN run "[::]:$ELODIN_PORT" "$DB_PATH" > /tmp/elodin_db_${DB_NAME}.log 2>&1 &
    fi
    ELODIN_PID=$!
    sleep 2
    if lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
      echo "   ✅ Elodin DB ready"
    else
      echo "   ⚠️ Elodin DB may have failed — check /tmp/elodin_db_${DB_NAME}.log"
    fi
  else
    echo "📊 Elodin DB already running on port $ELODIN_PORT (using existing process)"
    ELODIN_PID=""
  fi
  $REPLAY_MODE && echo "   📂 Replay mode: $DB_NAME (no daq_bridge/simulator/controller)"
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
[ -n "${DEMO_RATE_HZ:-}" ] && BACKEND_ENV="$BACKEND_ENV DEMO_RATE_HZ=$DEMO_RATE_HZ"
[ -n "${LOAD_TEST:-}" ] && BACKEND_ENV="$BACKEND_ENV LOAD_TEST=$LOAD_TEST"
env $BACKEND_ENV npm run dev &
BACKEND_PID=$!
cd ..

# In demo or replay mode, skip daq_bridge+simulator; otherwise build and run full pipeline
DAQ_BRIDGE_PID=""; SIMULATOR_PID=""; CONTROLLER_PID=""; SIDECAR_PID=""
if ! $DEMO_MODE && ! $REPLAY_MODE; then
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
make -j"$(nproc)" daq_bridge controller_service

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

# C++ Calibration Service (skip in replay/demo)
if ! $DEMO_MODE && ! $REPLAY_MODE; then
  sleep 2  # Ensure relay TCP forward is ready
  CAL_BIN="$SCRIPT_DIR/../FSW/build/calibration_service"
  [ ! -x "$CAL_BIN" ] && CAL_BIN="$SCRIPT_DIR/../build/FSW/calibration_service"
  if [ -x "$CAL_BIN" ]; then
    echo "🧪 Starting C++ calibration service..."
    cd "$SCRIPT_DIR/.."
    $CAL_BIN --config config/config.toml --elodin-host 127.0.0.1 --relay-host 127.0.0.1 --relay-port 9091 > /tmp/calibration_service.log 2>&1 &
    SIDECAR_PID=$!
    cd "$SCRIPT_DIR"
    echo "   ✅ Calibration service started (pid $SIDECAR_PID), log: /tmp/calibration_service.log"
  else
    echo "   ⚠️ calibration_service not found — run: cd FSW/build && make calibration_service"
  fi
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
$REPLAY_MODE && echo "   📂 REPLAY — past DB: $DB_NAME (plots/history from existing data)"
echo ""
echo "📡 Elodin relay: ws://localhost:9090 (raw data fan-out)"
echo "📡 WebSocket server: http://localhost:8081"
echo "🌐 Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for user interrupt
trap 'echo "Stopping all services..."; kill $BACKEND_PID $FRONTEND_PID $RELAY_PID $DAQ_BRIDGE_PID $SIMULATOR_PID $CONTROLLER_PID $SIDECAR_PID $ELODIN_PID 2>/dev/null; exit' INT TERM
wait
