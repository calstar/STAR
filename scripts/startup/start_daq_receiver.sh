#!/bin/bash
# Start DAQ Bridge to receive DiabloAvionics packets
# Usage: ./start_daq_receiver.sh [port]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

PORT="${1:-5006}"  # Default to 5006 (most common for DiabloAvionics)

echo "=== Starting DAQ Bridge Receiver ==="
echo "Port: $PORT"
echo ""

# Kill existing daq_bridge
pkill -f "daq_bridge" 2>/dev/null || true
sleep 1

# Check if Elodin is running
if ! pgrep -f "elodin-db.*2240" > /dev/null; then
    echo "⚠️  Warning: Elodin database not running on port 2240"
    echo "   Start it with: source scripts/startup/startup_daq_db.sh daq_db 2240"
    echo ""
fi

# Start DAQ bridge
echo "Starting DAQ bridge on port $PORT..."
./build/daq_comms/daq_bridge config/config.toml 0.0.0.0 $PORT 2>&1 | tee /tmp/daq_bridge_${PORT}.log &
DAQ_PID=$!
sleep 2

if ! ps -p $DAQ_PID > /dev/null 2>&1; then
    echo "❌ Failed to start DAQ bridge"
    echo "   Check logs: tail -20 /tmp/daq_bridge_${PORT}.log"
    exit 1
fi

# Get computer IP
COMPUTER_IP=$(ip addr show | grep -oP 'inet \K[\d.]+' | grep -E "^192\.168\." | head -1)

echo "✅ DAQ bridge started (PID: $DAQ_PID)"
echo ""
echo "📡 Listening for DiabloAvionics packets on:"
echo "   IP: 0.0.0.0 (all interfaces)"
echo "   Port: $PORT"
echo ""
if [ -n "$COMPUTER_IP" ]; then
    echo "📥 Configure your DiabloAvionics board to send to:"
    echo "   IP: $COMPUTER_IP"
    echo "   Port: $PORT"
    echo ""
fi
echo "📊 View data: elodin editor \$HOME/.local/share/elodin/test_db"
echo ""
echo "📝 Logs: tail -f /tmp/daq_bridge_${PORT}.log"
echo ""
echo "🛑 To stop: kill $DAQ_PID"
echo ""
