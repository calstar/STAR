#!/bin/bash
# setup_sim_network.sh
# Adds flight IPs as aliases to the loopback interface for local simulation/testing.

# Board IPs from config.toml
IPS=(
    "192.168.2.21" # pt_board
    "192.168.2.22" # pt_board_2
    "192.168.2.11" # actuator_board
    "192.168.2.12" # actuator_board_2
    "192.168.2.13" # actuator_board_3
    "192.168.2.14" # actuator_board_4
    "192.168.2.41" # lc_board
    "192.168.2.42" # lc_board_2
    "192.168.2.51" # tc_board
    "192.168.2.52" # tc_board_2
    "192.168.2.31" # rtd_board
    "192.168.2.32" # rtd_board_2
)

echo "🔧 Setting up virtual IP aliases for simulation..."

for ip in "${IPS[@]}"; do
    if ip addr show lo | grep -q "$ip"; then
        echo "✅ $ip is already assigned to lo"
    else
        echo "➕ Adding $ip to lo..."
        sudo ip addr add "$ip/32" dev lo 2>/dev/null || echo "❌ Failed to add $ip (try running with sudo manually: sudo ip addr add $ip/32 dev lo)"
    fi
done

echo "✨ Network setup complete. Simulator can now bind to flight IPs."
