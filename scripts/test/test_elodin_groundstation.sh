#!/bin/bash
# Test script for Elodin-integrated groundstation with fake sensor data
# This validates the complete pipeline: GUI → Elodin → FSW → Elodin → GUI

set -e

DB_PORT=${1:-2240}
DB_NAME=${2:-test_groundstation}
DB_PATH="$HOME/.local/share/elodin/$DB_NAME"

echo "🧪 Elodin Groundstation Test Setup"
echo "==================================="
echo "Database: $DB_PATH"
echo "Port: $DB_PORT"
echo ""

# Check if Elodin is installed
if ! command -v elodin-db &> /dev/null; then
    echo "❌ elodin-db not found. Please install Elodin first."
    exit 1
fi

# Create database directory
mkdir -p "$(dirname "$DB_PATH")"

# Kill any existing Elodin instances on this port
echo "🧹 Cleaning up existing processes..."
pkill -f "elodin-db run.*$DB_PORT" || true
sleep 1

# Start Elodin database (match FSW startup_db.sh exactly)
echo "📊 Starting Elodin database..."
# Match FSW: RUST_LOG=debug, no output redirection (output goes to terminal)
RUST_LOG=debug elodin-db run "[::]:$DB_PORT" "$DB_PATH" &
ELODIN_PID=$!
sleep 1  # Match FSW: sleep 1 (not 2)

echo "✅ Elodin database started (PID: $ELODIN_PID)"
echo "   Database path: $DB_PATH"
echo "   Port: $DB_PORT"
echo ""
echo "📋 Next steps:"
echo "   1. Terminal 2: Run fake sensor generator:"
echo "      ./build/daq_comms/send_fake_pt $DB_PORT 1000"
echo ""
echo "   2. Terminal 3: Run FSW simulator (if you have one):"
echo "      # Or use the groundstation GUI which will simulate commands"
echo ""
echo "   3. Terminal 4: Start groundstation GUI:"
echo "      cd groundstation && python3 ground_station_elodin_gui.py"
echo ""
echo "   4. Terminal 5: Open Elodin editor:"
echo "      elodin editor $DB_PATH"
echo ""
echo "Press Ctrl+C to stop the database"
echo ""

# Wait for interrupt
trap "echo ''; echo '🛑 Stopping Elodin database...'; kill $ELODIN_PID 2>/dev/null || true; wait $ELODIN_PID 2>/dev/null || true; echo '✅ Stopped'; exit 0" INT TERM

wait $ELODIN_PID
