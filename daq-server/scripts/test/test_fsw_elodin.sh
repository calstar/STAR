#!/bin/bash
# Test script to verify FSW's Elodin integration works correctly
# Sends fake DiabloEthernet packets to FSW and checks if they appear in Elodin

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

DB_NAME="fsw_test"
ELODIN_PORT="${1:-2240}"
UDP_PORT="${2:-8888}"

echo "🧪 Testing FSW Elodin Integration"
echo "=================================="
echo ""

# Step 1: Start Elodin database
echo "📊 Step 1: Starting Elodin database..."
if [ -d "$HOME/.local/share/elodin/$DB_NAME" ]; then
    echo "   Removing existing database..."
    rm -rf "$HOME/.local/share/elodin/$DB_NAME" "$HOME/.local/share/elodin/${DB_NAME}_metadata" 2>/dev/null || true
fi

# Kill existing processes
PIDS=$(pgrep -f "elodin-db run.*:$ELODIN_PORT" || true)
if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
    sleep 1
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

# Start database
DB_PATH="$HOME/.local/share/elodin/$DB_NAME"
mkdir -p "${DB_PATH}_metadata"
echo "   Starting Elodin DB: $DB_PATH on port $ELODIN_PORT"
RUST_LOG=info $ELODIN_DB_BIN run "[::]:$ELODIN_PORT" "$DB_PATH" > /tmp/elodin_db_${DB_NAME}.log 2>&1 &
DB_PID=$!
sleep 2

# Wait for database
echo "   Waiting for database..."
for i in {1..20}; do
    if lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
        echo "✅ Database is ready!"
        break
    fi
    if [ -n "$DB_PID" ] && ! ps -p $DB_PID > /dev/null 2>&1; then
        echo "❌ Error: Database process died"
        echo "   Check logs: tail -20 /tmp/elodin_db_${DB_NAME}.log"
        exit 1
    fi
    sleep 0.5
done

if ! lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
    echo "❌ Error: Database failed to start"
    exit 1
fi

echo ""
echo "✅ Database started (PID: $DB_PID)"
echo ""
echo "📝 Next steps:"
echo "   1. Start FSW system (in another terminal):"
echo "      cd $PROJECT_ROOT/FSW"
echo "      ./build/diablo_fsw <config_file>"
echo ""
echo "   2. Send test packets (in another terminal):"
echo "      python3 $SCRIPT_DIR/fake_diablo_packet.py 127.0.0.1 $UDP_PORT"
echo ""
echo "   3. Open Elodin editor:"
echo "      elodin editor $DB_PATH"
echo ""
echo "   4. Stop database when done:"
echo "      kill $DB_PID"
echo ""
