#!/bin/bash
# Start Full System: Elodin DB + DAQ Bridge for Ethernet Streaming
# Usage: ./start_full_system.sh [db_name] [udp_port] [elodin_port]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DB_NAME="${1:-daq_db}"
UDP_PORT="${2:-8888}"
ELODIN_PORT="${3:-2240}"

echo "=== Starting Full Sensor System ==="
echo "Database: $DB_NAME"
echo "UDP Port: $UDP_PORT (for sensor packets)"
echo "Elodin Port: $ELODIN_PORT"
echo ""

# Step 1: Start Elodin Database
echo "📊 Step 1: Starting Elodin Database..."
if pgrep -f "elodin-db run.*:$ELODIN_PORT" > /dev/null; then
    echo "   ✅ Elodin database already running on port $ELODIN_PORT"
else
    # Source the database startup script
    source "$SCRIPT_DIR/startup_daq_db.sh" "$DB_NAME" "$ELODIN_PORT"
    if [ $? -ne 0 ]; then
        echo "❌ Failed to start Elodin database"
        exit 1
    fi
    sleep 2
fi

# Step 2: Build DAQ bridge if needed
echo ""
echo "🔨 Step 2: Checking DAQ Bridge..."
DAQ_BRIDGE_BIN=""
if [ -f "$PROJECT_ROOT/build/daq_comms/daq_bridge" ]; then
    DAQ_BRIDGE_BIN="$PROJECT_ROOT/build/daq_comms/daq_bridge"
elif [ -f "$PROJECT_ROOT/build/FSW/daq_bridge" ]; then
    DAQ_BRIDGE_BIN="$PROJECT_ROOT/build/FSW/daq_bridge"
else
    echo "   Building DAQ bridge..."
    if [ ! -d "$PROJECT_ROOT/build" ]; then
        mkdir -p "$PROJECT_ROOT/build"
    fi
    (cd "$PROJECT_ROOT/build" && \
     if [ ! -f "CMakeCache.txt" ]; then \
         cmake "$PROJECT_ROOT"; \
     fi && \
     make daq_bridge -j$(nproc))

    # Check both possible locations
    if [ -f "$PROJECT_ROOT/build/daq_comms/daq_bridge" ]; then
        DAQ_BRIDGE_BIN="$PROJECT_ROOT/build/daq_comms/daq_bridge"
    elif [ -f "$PROJECT_ROOT/build/FSW/daq_bridge" ]; then
        DAQ_BRIDGE_BIN="$PROJECT_ROOT/build/FSW/daq_bridge"
    else
        echo "❌ Failed to build daq_bridge"
        exit 1
    fi
fi

if [ -z "$DAQ_BRIDGE_BIN" ] || [ ! -f "$DAQ_BRIDGE_BIN" ]; then
    echo "❌ daq_bridge executable not found"
    exit 1
fi

echo "   ✅ DAQ bridge executable found: $DAQ_BRIDGE_BIN"

# Step 3: Kill any existing DAQ bridge
echo ""
echo "🧹 Step 3: Cleaning up existing processes..."
pkill -f "daq_bridge" 2>/dev/null || true
sleep 1

# Step 4: DAQ Bridge (DISABLED - backend uses direct UDP mode)
echo ""
echo "⚠️  Step 4: DAQ Bridge startup skipped (backend uses direct UDP mode)..."
CONFIG_FILE="$PROJECT_ROOT/config/config.toml"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "⚠️  Warning: Config file not found at $CONFIG_FILE"
    echo "   Using default config"
    CONFIG_FILE=""
fi

# DAQ Bridge disabled - backend receives packets directly
# The backend uses direct UDP mode (USE_DIRECT_DAQ=true by default)
# and receives packets directly from boards on port 5006
echo "   ⚠️  DAQ Bridge startup skipped"
echo "   ✅ Backend will receive packets directly from boards (no DAQ Bridge needed)"
echo "   Backend listens on: 0.0.0.0:5006"
DAQ_BRIDGE_PID=""

# Step 5: Verify system is ready
echo ""
echo "🔍 Step 5: Verifying system..."
sleep 1

if lsof -i:$UDP_PORT > /dev/null 2>&1; then
    echo "   ✅ DAQ bridge listening on UDP port $UDP_PORT"
else
    echo "   ⚠️  Warning: DAQ bridge may not be listening on port $UDP_PORT"
fi

if lsof -i:$ELODIN_PORT > /dev/null 2>&1; then
    echo "   ✅ Elodin database listening on port $ELODIN_PORT"
else
    echo "   ❌ Error: Elodin database not listening on port $ELODIN_PORT"
    exit 1
fi

echo ""
echo "=== System Ready ==="
echo ""
echo "📡 Sensor packets should be sent to: $(hostname -I | awk '{print $1}'):$UDP_PORT"
echo ""
echo "📊 To view data:"
echo "   elodin editor $HOME/.local/share/elodin/$DB_NAME"
echo ""
echo "📝 Logs:"
echo "   DAQ Bridge: (disabled - backend uses direct UDP mode)"
echo "   Elodin DB: tail -f /tmp/elodin_db_${DB_NAME}.log"
echo ""
echo "🛑 To stop:"
echo "   kill $DAQ_BRIDGE_PID"
echo "   pkill -f 'elodin-db run.*:$ELODIN_PORT'"
echo ""
echo "System is running. Press Ctrl+C to stop monitoring (processes will continue)."
echo ""

# Wait for interrupt (but don't kill processes)
trap "echo ''; echo 'Monitoring stopped. Processes still running.'; exit 0" INT TERM

# Keep script running
wait $DAQ_BRIDGE_PID 2>/dev/null || sleep infinity
