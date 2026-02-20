#!/bin/bash
# Test script to verify packet reception and processing

echo "=== Testing Packet Reception ==="
echo ""

# Check if DAQ bridge is running
if ! pgrep -f "daq_bridge.*5006" > /dev/null; then
    echo "❌ DAQ bridge not running"
    exit 1
fi

echo "✅ DAQ bridge is running"
echo ""

# Monitor logs for 10 seconds
echo "Monitoring for incoming packets (10 seconds)..."
echo ""

timeout 10 tail -f /tmp/daq_bridge_verbose.log 2>/dev/null | grep --line-buffered -E "(Packet|Elodin|Received|Pipeline)" | head -20 &
MONITOR_PID=$!

sleep 10
kill $MONITOR_PID 2>/dev/null || true

echo ""
echo "=== Summary ==="
echo ""

# Count packets in log
PACKET_COUNT=$(grep -c "\[Packet\]" /tmp/daq_bridge_verbose.log 2>/dev/null || echo "0")
ELODIN_COUNT=$(grep -c "\[Elodin\]" /tmp/daq_bridge_verbose.log 2>/dev/null || echo "0")

echo "Packets received: $PACKET_COUNT"
echo "Messages published to Elodin: $ELODIN_COUNT"
echo ""

if [ "$PACKET_COUNT" -gt 0 ]; then
    echo "✅ System is working! Packets are being received and processed."
    echo ""
    echo "To view data in Elodin:"
    echo "  elodin editor \$HOME/.local/share/elodin/test_db"
else
    echo "⚠️  No packets received yet."
    echo ""
    echo "Make sure your DiabloAvionics board is:"
    echo "  1. Connected via Ethernet"
    echo "  2. Configured to send to: 192.168.1.20:5006"
    echo "  3. Powered on and sending packets"
    echo ""
    echo "Check board IP:"
    echo "  ip addr show | grep 192.168"
fi



