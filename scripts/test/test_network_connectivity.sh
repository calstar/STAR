#!/bin/bash
# Test network connectivity for DiabloAvionics board communication

echo "=== Network Connectivity Test ==="
echo ""

# Find the interface with 192.168.2.x
INTERFACE=""
BOARD_NETWORK_IP=""

for iface in $(ip link show | grep -E "^[0-9]+:" | awk -F: '{print $2}' | tr -d ' '); do
    ip=$(ip addr show $iface 2>/dev/null | grep "inet.*192.168.2" | awk '{print $2}' | cut -d/ -f1)
    if [ -n "$ip" ]; then
        INTERFACE="$iface"
        BOARD_NETWORK_IP="$ip"
        break
    fi
done

if [ -z "$INTERFACE" ]; then
    echo "❌ No interface found with 192.168.2.x IP"
    echo ""
    echo "Available interfaces:"
    ip -4 addr show | grep -E "^[0-9]+:|inet " | head -20
    exit 1
fi

echo "✅ Found interface: $INTERFACE"
echo "   IP: $BOARD_NETWORK_IP"
echo ""

# Check interface status
LINK_STATE=$(ip link show $INTERFACE | grep -o "state [A-Z]*" | awk '{print $2}')
echo "Interface state: $LINK_STATE"

if [ "$LINK_STATE" != "UP" ]; then
    echo "⚠️  Interface is not UP!"
    echo "   Try: sudo ip link set $INTERFACE up"
fi

echo ""

# Check firewall
echo "=== Firewall Check ==="
if command -v ufw &> /dev/null; then
    UFW_STATUS=$(sudo ufw status 2>/dev/null | head -1)
    echo "UFW: $UFW_STATUS"
    if echo "$UFW_STATUS" | grep -q "Status: active"; then
        echo "⚠️  Firewall is active - checking rules for port 5006..."
        sudo ufw status | grep 5006 || echo "   No rule found for port 5006"
        echo "   If needed: sudo ufw allow 5006/udp"
    fi
else
    echo "UFW not installed or not accessible"
fi

echo ""

# Check if socket can bind
echo "=== Socket Binding Test ==="
if command -v nc &> /dev/null; then
    echo "Testing if we can bind to 0.0.0.0:5006..."
    timeout 1 nc -u -l 0.0.0.0 5006 2>&1 &
    NC_PID=$!
    sleep 1
    if ps -p $NC_PID > /dev/null 2>&1; then
        echo "✅ Can bind to port 5006"
        kill $NC_PID 2>/dev/null
    else
        echo "❌ Cannot bind to port 5006 (may be in use or permission denied)"
    fi
else
    echo "nc (netcat) not available for testing"
fi

echo ""

# Check routing
echo "=== Routing Check ==="
ROUTE=$(ip route | grep "192.168.2")
if [ -n "$ROUTE" ]; then
    echo "✅ Route to 192.168.2.0 network:"
    echo "   $ROUTE"
else
    echo "⚠️  No route found to 192.168.2.0 network"
fi

echo ""

# Recommendations
echo "=== Recommendations ==="
echo ""
echo "1. Verify board IP configuration:"
echo "   • Board should be on 192.168.2.x network"
echo "   • Board receiverIP should be: $BOARD_NETWORK_IP"
echo "   • Board receiverPort should be: 5006"
echo ""
echo "2. Test connectivity:"
echo "   • From board: ping $BOARD_NETWORK_IP"
echo "   • From this computer: ping <board_ip>"
echo ""
echo "3. If firewall is blocking:"
echo "   sudo ufw allow 5006/udp"
echo ""
echo "4. Check if DAQ bridge is using correct interface:"
echo "   The DAQ bridge binds to 0.0.0.0 which should work, but verify:"
echo "   netstat -ulnp | grep 5006"
