#!/bin/bash
# Fix Elodin connection by restarting with proper TCP listening

echo "=== Fixing Elodin Connection ==="
echo ""

# Kill existing Elodin
pkill -f "elodin-db.*2240" 2>/dev/null || true
sleep 2

# Get DB path from running process or use default
DB_PATH="$HOME/.local/share/elodin/test_db"

# Check if DB path exists
if [ ! -d "$DB_PATH" ]; then
    echo "Creating database directory: $DB_PATH"
    mkdir -p "$DB_PATH"
fi

# Find elodin-db
ELODIN_DB_BIN=""
if [ -f "$HOME/.cargo/bin/elodin-db" ]; then
    ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
elif command -v elodin-db &> /dev/null; then
    ELODIN_DB_BIN="elodin-db"
else
    echo "❌ Error: elodin-db not found"
    exit 1
fi

echo "Starting Elodin DB with TCP support..."
echo "  Host: 127.0.0.1:2240 (IPv4)"
echo "  Path: $DB_PATH"
echo ""

# Start Elodin - try IPv4 first
RUST_LOG=info $ELODIN_DB_BIN run "127.0.0.1:2240" "$DB_PATH" > /tmp/elodin_fixed.log 2>&1 &
ELODIN_PID=$!
sleep 3

# Check if it's listening
if lsof -i:2240 > /dev/null 2>&1; then
    echo "✅ Elodin is now listening on 127.0.0.1:2240"
    echo "   PID: $ELODIN_PID"
    echo ""
    echo "Testing connection..."
    if nc -zv 127.0.0.1 2240 2>&1 | grep -q "succeeded"; then
        echo "✅ TCP connection test: SUCCESS"
    else
        echo "⚠️  TCP connection test: Still failing"
        echo "   Check logs: tail -20 /tmp/elodin_fixed.log"
    fi
else
    echo "❌ Elodin failed to start or not listening"
    echo "   Check logs: tail -20 /tmp/elodin_fixed.log"
    tail -10 /tmp/elodin_fixed.log
    exit 1
fi

echo ""
echo "Now restart DAQ bridge to connect:"
echo "  pkill -f daq_bridge"
echo "  ./build/FSW/daq_bridge config/config.toml 0.0.0.0 5006"



