#!/bin/bash
# Start SITL (Software-In-The-Loop) simulation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_PATH="${1:-$PROJECT_ROOT/config/config_sitl.toml}"
ELODIN_PORT="${2:-2240}"

echo "=== Starting Diablo FSW SITL ==="
echo "Config: $CONFIG_PATH"
echo "Elodin Port: $ELODIN_PORT"
echo ""

# Check if Elodin database is running
if ! pgrep -f "elodin-db" > /dev/null; then
    echo "⚠️  Elodin database not running. Starting it..."
    cd "$PROJECT_ROOT"
    ./scripts/startup/startup_daq_db.sh "$ELODIN_PORT" sitl_db &
    ELODIN_PID=$!
    sleep 2

    if ! kill -0 $ELODIN_PID 2>/dev/null; then
        echo "❌ Failed to start Elodin database"
        exit 1
    fi
    echo "✅ Elodin database started (PID: $ELODIN_PID)"
else
    echo "✅ Elodin database already running"
fi

# Check if engine_sim submodule is initialized
if [ ! -d "$PROJECT_ROOT/engine_sim/engine" ]; then
    echo "⚠️  Engine simulation submodule not initialized"
    echo "Initializing submodules..."
    cd "$PROJECT_ROOT"
    git submodule update --init --recursive
fi

# Start engine simulation bridge (Python)
echo ""
echo "Starting engine simulation bridge..."
cd "$PROJECT_ROOT"
python3 scripts/sitl/engine_sim_bridge.py \
    --engine-config engine_sim/configs/default.yaml \
    --port 5555 &
ENGINE_BRIDGE_PID=$!
sleep 1

if ! kill -0 $ENGINE_BRIDGE_PID 2>/dev/null; then
    echo "❌ Failed to start engine simulation bridge"
    exit 1
fi
echo "✅ Engine simulation bridge started (PID: $ENGINE_BRIDGE_PID)"

# Build SITL simulator if needed
if [ ! -f "$PROJECT_ROOT/build/FSW/sitl_simulator" ]; then
    echo ""
    echo "Building SITL simulator..."
    cd "$PROJECT_ROOT/build"
    cmake ..
    make sitl_simulator -j$(nproc)
fi

# Start SITL simulator (C++)
echo ""
echo "Starting SITL simulator..."
cd "$PROJECT_ROOT"
./build/FSW/sitl_simulator "$CONFIG_PATH" &
SITL_PID=$!
sleep 1

if ! kill -0 $SITL_PID 2>/dev/null; then
    echo "❌ Failed to start SITL simulator"
    kill $ENGINE_BRIDGE_PID 2>/dev/null || true
    exit 1
fi
echo "✅ SITL simulator started (PID: $SITL_PID)"

echo ""
echo "=== SITL Running ==="
echo "Press Ctrl+C to stop"
echo ""

# Wait for interrupt
trap "echo ''; echo 'Stopping SITL...'; kill $SITL_PID $ENGINE_BRIDGE_PID 2>/dev/null || true; exit" INT TERM

wait $SITL_PID



