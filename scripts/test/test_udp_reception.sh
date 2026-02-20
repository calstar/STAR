#!/bin/bash
# Simple test to verify UDP port 5006 is receiving data

echo "=== UDP Reception Test ==="
echo ""

# Check if DAQ bridge is running
if ! pgrep -f "daq_bridge.*5006" > /dev/null; then
    echo "❌ DAQ bridge not running"
    exit 1
fi

echo "✅ DAQ bridge is running"
echo ""

# Get initial packet count
LOG_FILE="/tmp/daq_bridge_verbose.log"
INITIAL=$(grep -c "\[Packet #" "$LOG_FILE" 2>/dev/null || echo "0")
INITIAL_PIPELINE=$(grep -c "\[Pipeline\].*Received" "$LOG_FILE" 2>/dev/null || echo "0")

echo "Current packet count: $INITIAL"
echo "Current pipeline receives: $INITIAL_PIPELINE"
echo ""

# Test 1: Send a simple UDP packet locally
echo "Test 1: Sending test UDP packet to localhost:5006..."
echo "test123" | timeout 1 nc -u -w1 localhost 5006 2>/dev/null && echo "  ✅ Packet sent" || echo "  ⚠️  nc not available or failed"

sleep 1

# Check if anything was received
FINAL=$(grep -c "\[Packet #" "$LOG_FILE" 2>/dev/null || echo "0")
FINAL_PIPELINE=$(grep -c "\[Pipeline\].*Received" "$LOG_FILE" 2>/dev/null || echo "0")

if [ "$FINAL" -gt "$INITIAL" ] || [ "$FINAL_PIPELINE" -gt "$INITIAL_PIPELINE" ]; then
    echo "  ✅ UDP reception is working! Packet was received."
else
    echo "  ⚠️  Test packet not received (may be filtered by parser)"
    echo "     This is OK - the parser only accepts DiabloAvionics format packets"
fi

echo ""
echo "=== Summary ==="
echo ""
echo "Your computer IPs for board configuration:"
hostname -I | awk '{for(i=1;i<=NF;i++) if ($i ~ /^192\.168\.|^10\./) print "  " $i ":5006"}'
echo ""
echo "Board Configuration Checklist:"
echo "  □ Board is powered on"
echo "  □ Board is connected via Ethernet"
echo "  □ Board IP is on same network (192.168.1.x or 10.60.x.x)"
echo "  □ Board receiverIP is set to one of the IPs above"
echo "  □ Board receiverPort is set to 5006"
echo "  □ Board is actually sending packets (check Serial monitor)"
echo ""
echo "Monitor for incoming packets:"
echo "  tail -f $LOG_FILE | grep -E '\[Packet|\[Pipeline.*Received'"



