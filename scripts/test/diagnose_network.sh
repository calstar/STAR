#!/bin/bash
# Comprehensive network diagnosis

echo "=== Network Diagnosis ==="
echo ""

INTERFACE="enx00e04c680240"
EXPECTED_IP="192.168.2.201"

echo "1. Interface Status:"
ip link show $INTERFACE | grep -E "state|UP|DOWN"
echo ""

echo "2. IP Configuration:"
ip addr show $INTERFACE | grep "inet " || echo "  ❌ No IP assigned"
echo ""

echo "3. Routes:"
ip route | grep 192.168.2 || echo "  ⚠️  No route to 192.168.2.0 network"
echo ""

echo "4. ARP Table (shows devices on network):"
arp -a | grep 192.168.2 || echo "  ⚠️  No 192.168.2.x devices in ARP table"
echo ""

echo "5. Firewall:"
if command -v ufw &> /dev/null; then
    sudo ufw status | head -5
else
    echo "  UFW not available"
fi
echo ""

echo "6. Listening Sockets on Port 5006:"
sudo netstat -ulnp 2>/dev/null | grep 5006 || sudo ss -ulnp 2>/dev/null | grep 5006 || echo "  (Need sudo to check)"
echo ""

echo "=== Recommendations ==="
echo ""
echo "If board is definitely sending but nothing arrives:"
echo ""
echo "1. Verify board network config matches:"
echo "   • Board IP: 192.168.2.x (e.g., 192.168.2.100)"
echo "   • Subnet: 255.255.255.0"
echo "   • receiverIP: 192.168.2.201"
echo "   • receiverPort: 5006"
echo ""
echo "2. Test connectivity from board:"
echo "   • Ping 192.168.2.201 from board Serial monitor"
echo "   • If ping fails, networks aren't connected"
echo ""
echo "3. Check physical connection:"
echo "   • Is cable connected to USB adapter?"
echo "   • Is board powered on?"
echo "   • Try different USB port/cable"
echo ""
echo "4. Check if board appears in ARP:"
echo "   • Send packets from board"
echo "   • Run: arp -a | grep 192.168.2"
echo "   • If board doesn't appear, it's not on same network"
echo ""
echo "5. Try Wireshark/tcpdump (if available):"
echo "   sudo tcpdump -i enx00e04c680240 -n udp port 5006"



