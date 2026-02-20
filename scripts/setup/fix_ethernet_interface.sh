#!/bin/bash
# Fix Ethernet interface configuration for DiabloAvionics board

echo "=== Ethernet Interface Setup ==="
echo ""

# Check which interface should be used
echo "Available Ethernet interfaces:"
echo ""

INTERFACES=()
for iface in $(ip link show | grep -E "^[0-9]+:.*:" | awk -F: '{print $2}' | tr -d ' '); do
    if [[ "$iface" != "lo" ]] && [[ "$iface" != wlp* ]]; then
        state=$(ip link show $iface | grep -o "state [A-Z]*" | awk '{print $2}')
        carrier=$(ip link show $iface | grep -o "carrier [A-Z]*" | awk '{print $2}' || echo "UNKNOWN")
        ip=$(ip addr show $iface 2>/dev/null | grep "inet " | awk '{print $2}' | head -1 || echo "none")
        INTERFACES+=("$iface|$state|$carrier|$ip")
        echo "  $iface: state=$state, carrier=$carrier, IP=$ip"
    fi
done

echo ""
echo "Which interface is your DiabloAvionics board connected to?"
echo "  (Usually enp* for built-in Ethernet, enx* for USB adapter)"
echo ""

# Try to auto-detect
ETH_INTERFACE=""
for info in "${INTERFACES[@]}"; do
    IFS='|' read -r iface state carrier ip <<< "$info"
    if [[ "$state" == "UP" ]] && [[ "$carrier" == "UP" ]] || [[ "$carrier" == "UNKNOWN" ]]; then
        if [[ "$iface" =~ ^en ]]; then
            ETH_INTERFACE="$iface"
            echo "Auto-detected: $iface (UP and looks like Ethernet)"
            break
        fi
    fi
done

if [ -z "$ETH_INTERFACE" ]; then
    echo "Could not auto-detect. Please specify interface name:"
    read -p "Interface name: " ETH_INTERFACE
fi

echo ""
echo "Using interface: $ETH_INTERFACE"
echo ""

# Check current IP
CURRENT_IP=$(ip addr show $ETH_INTERFACE 2>/dev/null | grep "inet.*192.168.2" | awk '{print $2}' | cut -d/ -f1)

if [ -n "$CURRENT_IP" ]; then
    echo "✅ Interface already has IP: $CURRENT_IP"
    if [ "$CURRENT_IP" == "192.168.2.201" ]; then
        echo "✅ IP matches configuration (192.168.2.201)"
        exit 0
    else
        echo "⚠️  IP is $CURRENT_IP but you want 192.168.2.201"
        echo "   Remove old IP first or use the current IP in board config"
    fi
else
    echo "⚠️  No 192.168.2.x IP assigned to this interface"
    echo ""
    echo "To assign 192.168.2.201:"
    echo "  sudo ip addr add 192.168.2.201/24 dev $ETH_INTERFACE"
    echo "  sudo ip link set $ETH_INTERFACE up"
    echo ""
    read -p "Apply IP configuration now? (y/n): " APPLY

    if [ "$APPLY" == "y" ] || [ "$APPLY" == "Y" ]; then
        echo "Applying configuration..."
        sudo ip addr add 192.168.2.201/24 dev $ETH_INTERFACE 2>/dev/null || echo "IP may already exist"
        sudo ip link set $ETH_INTERFACE up
        sleep 1

        # Verify
        NEW_IP=$(ip addr show $ETH_INTERFACE | grep "inet.*192.168.2.201" | awk '{print $2}' | cut -d/ -f1)
        if [ -n "$NEW_IP" ]; then
            echo "✅ IP assigned: $NEW_IP"
        else
            echo "❌ Failed to assign IP"
        fi
    fi
fi

echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Verify interface is UP:"
echo "   ip link show $ETH_INTERFACE | grep state"
echo ""
echo "2. Verify IP is assigned:"
echo "   ip addr show $ETH_INTERFACE | grep 192.168.2"
echo ""
echo "3. Configure your board to send to: 192.168.2.201:5006"
echo ""
echo "4. Test connectivity:"
echo "   ping <board_ip>  (from board, ping 192.168.2.201)"



