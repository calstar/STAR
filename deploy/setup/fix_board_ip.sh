#!/bin/bash
# Fix IP to match DiabloAvionics board configuration

echo "=== DiabloAvionics IP Configuration Fix ==="
echo ""

INTERFACE="enx00e04c680240"

# Check current IP
CURRENT_IP=$(ip addr show $INTERFACE 2>/dev/null | grep "inet.*192.168.2" | awk '{print $2}' | cut -d/ -f1 | head -1)

echo "Current IP on $INTERFACE: ${CURRENT_IP:-none}"
echo ""

# DiabloAvionics boards typically send to 192.168.2.20
# But check your board's firmware for the actual receiverIP!
EXPECTED_IP="192.168.2.20"

echo "DiabloAvionics boards typically send to: $EXPECTED_IP"
echo ""
echo "⚠️  IMPORTANT: Check your board's Serial monitor to see what receiverIP it's using!"
echo "   Look for: 'receiverIP = IPAddress(...)' or 'Send to: X.X.X.X'"
echo ""

read -p "What IP is your board sending to? (default: $EXPECTED_IP): " BOARD_RECEIVER_IP
BOARD_RECEIVER_IP=${BOARD_RECEIVER_IP:-$EXPECTED_IP}

echo ""
echo "Setting $INTERFACE to $BOARD_RECEIVER_IP..."

# Remove old IP if exists
if [ -n "$CURRENT_IP" ] && [ "$CURRENT_IP" != "$BOARD_RECEIVER_IP" ]; then
    echo "Removing old IP: $CURRENT_IP"
    sudo ip addr del "$CURRENT_IP/24" dev $INTERFACE 2>/dev/null || true
fi

# Add new IP
sudo ip addr add "$BOARD_RECEIVER_IP/24" dev $INTERFACE 2>/dev/null || echo "IP may already exist"
sudo ip link set $INTERFACE up

sleep 1

# Verify
NEW_IP=$(ip addr show $INTERFACE | grep "inet.*$BOARD_RECEIVER_IP" | awk '{print $2}' | cut -d/ -f1)
if [ -n "$NEW_IP" ]; then
    echo "✅ IP set to: $NEW_IP"
else
    echo "❌ Failed to set IP"
    exit 1
fi

echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Verify board is sending to: $BOARD_RECEIVER_IP"
echo "   (Check Serial monitor for receiverIP)"
echo ""
echo "2. Check board port (usually 5006 or 5007):"
echo "   (Check Serial monitor for receiverPort)"
echo ""
echo "3. Start DAQ bridge on that port:"
echo "   ./build/bin/daq_bridge config/config.toml 0.0.0.0 <port>"
echo ""
echo "4. Test packet reception:"
echo "   python3 scripts/test/test_udp_simple.py"
