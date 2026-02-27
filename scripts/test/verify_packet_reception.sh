#!/bin/bash
# Verify packet reception and processing pipeline

echo "=== Packet Reception Verification ==="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# Check if DAQ bridge is running
if ! pgrep -f "daq_bridge.*5006" > /dev/null; then
    echo "❌ DAQ bridge not running"
    echo "   Start it with: ./build/FSW/daq_bridge config/config.toml 0.0.0.0 5006"
    exit 1
fi

echo "✅ DAQ bridge is running"
echo ""

# Check if listening on port
if lsof -i:5006 > /dev/null 2>&1; then
    echo "✅ Listening on UDP port 5006"
else
    echo "❌ Not listening on port 5006"
    exit 1
fi

echo ""
echo "📡 Monitoring for incoming packets (30 seconds)..."
echo "   Send packets from your DiabloAvionics board to: $(hostname -I | awk '{print $1}'):5006"
echo ""

# Monitor logs
LOG_FILE="/tmp/daq_bridge_verbose.log"
if [ ! -f "$LOG_FILE" ]; then
    LOG_FILE="/tmp/daq_bridge.log"
fi

# Count initial packets
INITIAL_COUNT=$(grep -c "\[Packet #" "$LOG_FILE" 2>/dev/null || echo "0")

echo "Starting packet count: $INITIAL_COUNT"
echo ""

# Monitor for 30 seconds
timeout 30 tail -f "$LOG_FILE" 2>/dev/null | grep --line-buffered -E "\[Packet|\[Elodin|\[Pipeline.*Received" &
MONITOR_PID=$!

sleep 30
kill $MONITOR_PID 2>/dev/null || true

# Count final packets
FINAL_COUNT=$(grep -c "\[Packet #" "$LOG_FILE" 2>/dev/null || echo "0")
PACKETS_RECEIVED=$((FINAL_COUNT - INITIAL_COUNT))

echo ""
echo "=== Results ==="
echo ""

if [ "$PACKETS_RECEIVED" -gt 0 ]; then
    echo "✅ SUCCESS! Received $PACKETS_RECEIVED packet(s)"
    echo ""
    echo "Recent packets:"
    grep "\[Packet #" "$LOG_FILE" 2>/dev/null | tail -5
    echo ""

    # Check Elodin publishing
    ELODIN_PUBLISHED=$(grep -c "\[Elodin\].*Published" "$LOG_FILE" 2>/dev/null || echo "0")
    if [ "$ELODIN_PUBLISHED" -gt 0 ]; then
        echo "✅ Messages published to Elodin: $ELODIN_PUBLISHED"
    else
        echo "⚠️  No messages published to Elodin (connection may be down)"
    fi

    echo ""
    echo "✅ System is working! Packets are being received and parsed."
else
    echo "⚠️  No packets received during monitoring period"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check board is powered on and connected"
    echo "  2. Verify board IP configuration"
    echo "  3. Check board is sending to: $(hostname -I | awk '{print $1}'):5006"
    echo "  4. Check firewall: sudo ufw status"
    echo "  5. Test with: nc -u -l 5006 (should see UDP packets)"
fi

echo ""
echo "Full logs: tail -f $LOG_FILE"
