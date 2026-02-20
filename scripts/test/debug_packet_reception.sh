#!/bin/bash
# Debug packet reception - shows what's actually happening

echo "=== Packet Reception Debug ==="
echo ""

LOG_FILE="/tmp/daq_bridge_verbose.log"

# Check if DAQ bridge is running
if ! pgrep -f "daq_bridge.*5006" > /dev/null; then
    echo "❌ DAQ bridge not running"
    exit 1
fi

echo "✅ DAQ bridge is running"
echo ""

# Show recent activity
echo "=== Recent Log Activity ==="
tail -30 "$LOG_FILE" | grep -E "\[Pipeline|\[Packet|Received|Listening" | tail -10
echo ""

# Count packets
TOTAL_UDP=$(grep -c "\[Pipeline\].*Received UDP packet" "$LOG_FILE" 2>/dev/null || echo "0")
TOTAL_PARSED=$(grep -c "\[Pipeline\].*Parsed packet type" "$LOG_FILE" 2>/dev/null || echo "0")
TOTAL_FAILED=$(grep -c "\[Pipeline\].*Failed to parse" "$LOG_FILE" 2>/dev/null || echo "0")

echo "=== Statistics ==="
echo "UDP packets received: $TOTAL_UDP"
echo "Successfully parsed: $TOTAL_PARSED"
echo "Parse failures: $TOTAL_FAILED"
echo ""

if [ "$TOTAL_UDP" -gt 0 ]; then
    echo "✅ Packets ARE being received!"
    echo ""
    echo "Recent packet details:"
    grep "\[Pipeline\].*Received UDP packet" "$LOG_FILE" 2>/dev/null | tail -5
    echo ""

    if [ "$TOTAL_FAILED" -gt 0 ]; then
        echo "⚠️  Some packets failed to parse. Details:"
        grep "\[Pipeline\].*Failed to parse" "$LOG_FILE" 2>/dev/null | tail -3
        echo ""
        echo "First bytes of failed packets:"
        grep -A 1 "Failed to parse" "$LOG_FILE" 2>/dev/null | grep "First 16 bytes" | tail -3
    fi
else
    echo "⚠️  No UDP packets received yet"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Verify board is sending to correct IP: $(hostname -I | awk '{print $1}'):5006"
    echo "  2. Check board Serial monitor - is it actually sending?"
    echo "  3. Test network: ping $(hostname -I | awk '{print $1}') from board"
    echo "  4. Check firewall: sudo ufw status"
fi

echo ""
echo "Live monitoring: tail -f $LOG_FILE | grep Pipeline"



