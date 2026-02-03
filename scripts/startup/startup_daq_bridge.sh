#!/bin/bash
# DAQ Bridge Startup Script
# Starts Elodin database and DAQ bridge
# Usage: source startup_daq_bridge.sh <db_name> [udp_port] [elodin_port]

set -e

# Check for source
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "Usage: source startup_daq_bridge.sh <db_name> [udp_port] [elodin_port]"
    exit 1
fi

# Check for an argument
if [ -z "$1" ]; then
    echo "Usage: source startup_daq_bridge.sh <db_name> [udp_port] [elodin_port]"
    return 1
fi

DB_NAME="$1"
UDP_PORT="${2:-8888}"
ELODIN_PORT="${3:-2240}"

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Start database (non-interactive - auto-delete if exists)
echo "📊 Starting database..."
if [ -d "$HOME/.local/share/elodin/$DB_NAME" ]; then
    echo "   Removing existing database..."
    rm -rf "$HOME/.local/share/elodin/$DB_NAME" "$HOME/.local/share/elodin/${DB_NAME}_metadata" 2>/dev/null || true
fi

# Start database directly (bypassing interactive prompts)
DB_ROOT_PATH="$HOME/.local/share/elodin"
TMP_DB_PATH="$DB_ROOT_PATH/$DB_NAME"
TMP_DB_META_PATH="${TMP_DB_PATH}_metadata"
DB_HOST="[::]:$ELODIN_PORT"

# Kill existing processes on port
PIDS=$(pgrep -f "elodin-db run.*:$ELODIN_PORT" || true)
if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
    sleep 1
fi

# Create metadata directory
mkdir -p "$TMP_DB_META_PATH"

# Find elodin-db binary
ELODIN_DB_BIN=""
if [ -f "$HOME/.cargo/bin/elodin-db" ]; then
    ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
elif command -v elodin-db &> /dev/null; then
    ELODIN_DB_BIN="elodin-db"
else
    echo "❌ Error: elodin-db not found. Please install Elodin."
    return 1
fi

# Start database
echo "   Starting Elodin DB: $TMP_DB_PATH on port $ELODIN_PORT"
RUST_LOG=info $ELODIN_DB_BIN run "$DB_HOST" "$TMP_DB_PATH" 2>&1 | tee /tmp/elodin_db_${DB_NAME}.log &
DB_PID=$!
sleep 2

# Wait for database to be ready
echo "   Waiting for database..."
for i in {1..20}; do
    if lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
        echo "✅ Database is ready!"
        break
    fi
    if [ -n "$DB_PID" ] && ! ps -p $DB_PID > /dev/null 2>&1; then
        echo "❌ Error: Database process died"
        echo "   Check logs: tail -20 /tmp/elodin_db_${DB_NAME}.log"
        return 1
    fi
    sleep 0.5
done

if ! lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
    echo "❌ Error: Database failed to start on port $ELODIN_PORT"
    echo "   Check logs: tail -20 /tmp/elodin_db_${DB_NAME}.log"
    return 1
fi

# Get database path
DB_ROOT_PATH="$HOME/.local/share/elodin"
DB_PATH="$DB_ROOT_PATH/$DB_NAME"

# Kill any existing DAQ bridge processes
pkill -f "daq_bridge" 2>/dev/null || true
pkill -f "fake_packet_generator" 2>/dev/null || true
sleep 1

# Check if executables exist
DAQ_BRIDGE_BIN="$PROJECT_ROOT/build/daq_comms/daq_bridge"
FAKE_GEN_BIN="$PROJECT_ROOT/build/daq_comms/fake_packet_generator"
CONFIG_FILE="$PROJECT_ROOT/config/sensor_routing.toml"

if [ ! -f "$DAQ_BRIDGE_BIN" ]; then
    echo "❌ Error: daq_bridge not found at $DAQ_BRIDGE_BIN"
    echo "   Build it first: cd build && make daq_bridge"
    return 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Error: Config file not found at $CONFIG_FILE"
    return 1
fi

# Start DAQ bridge
echo ""
echo "🌉 Starting DAQ bridge..."
echo "   UDP bind: 0.0.0.0:$UDP_PORT"
echo "   Elodin: 127.0.0.1:$ELODIN_PORT"
echo "   Config: $CONFIG_FILE"

"$DAQ_BRIDGE_BIN" "0.0.0.0" "$UDP_PORT" "127.0.0.1" "$ELODIN_PORT" "$CONFIG_FILE" &
BRIDGE_PID=$!
sleep 2

# Check if bridge started successfully
if ! ps -p $BRIDGE_PID > /dev/null 2>&1; then
    echo "❌ Error: DAQ bridge failed to start"
    return 1
fi

echo "✅ DAQ bridge started (PID: $BRIDGE_PID)"
echo ""

# Check if fake packet generator exists and start it automatically
if [ -f "$FAKE_GEN_BIN" ]; then
    echo "🎲 Starting fake packet generator..."
    # Start fake packet generator (sends packets continuously)
    # Send 1000 packets (enough for testing, can be interrupted)
    "$FAKE_GEN_BIN" "127.0.0.1" "$UDP_PORT" 1000 &
    FAKE_GEN_PID=$!
    sleep 1
    
    if ps -p $FAKE_GEN_PID > /dev/null 2>&1; then
        echo "✅ Fake packet generator started (PID: $FAKE_GEN_PID)"
        echo ""
        echo "📡 Full pipeline running:"
        echo "   Fake packets → Parser → Elodin DB"
        echo ""
        echo "To open editor:"
        echo "   elodin editor $DB_PATH"
        echo ""
        echo "To stop everything:"
        echo "   kill $DB_PID $BRIDGE_PID $FAKE_GEN_PID"
    else
        echo "⚠️  Warning: Fake packet generator failed to start"
        echo ""
        echo "📡 Ready to receive sensor packets on UDP port $UDP_PORT"
        echo ""
        echo "To send test packets manually:"
        echo "   $FAKE_GEN_BIN 127.0.0.1 $UDP_PORT 10"
        echo ""
        echo "To open editor:"
        echo "   elodin editor $DB_PATH"
        echo ""
        echo "To stop:"
        echo "   kill $DB_PID $BRIDGE_PID"
    fi
else
    echo "⚠️  Warning: Fake packet generator not found at $FAKE_GEN_BIN"
    echo "   Build it first: cd build && make fake_packet_generator"
    echo ""
    echo "📡 Ready to receive sensor packets on UDP port $UDP_PORT"
    echo ""
    echo "To send test packets manually:"
    echo "   $FAKE_GEN_BIN 127.0.0.1 $UDP_PORT 10"
    echo ""
    echo "To open editor:"
    echo "   elodin editor $DB_PATH"
    echo ""
    echo "To stop:"
    echo "   kill $DB_PID $BRIDGE_PID"
fi

return 0

