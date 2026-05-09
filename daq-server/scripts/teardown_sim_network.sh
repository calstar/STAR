#!/bin/bash
# teardown_sim_network.sh
# Removes flight IPs from the loopback interface.

IPS=(
    "192.168.2.21"
    "192.168.2.22"
    "192.168.2.11"
    "192.168.2.12"
    "192.168.2.13"
    "192.168.2.14"
    "192.168.2.41"
    "192.168.2.42"
    "192.168.2.51"
    "192.168.2.52"
    "192.168.2.31"
    "192.168.2.32"
)

echo "🧹 Removing virtual IP aliases from loopback interface..."

for ip in "${IPS[@]}"; do
    if ip addr show lo | grep -q "$ip"; then
        echo "➖ Removing $ip from lo..."
        sudo ip addr del "$ip/32" dev lo 2>/dev/null || echo "❌ Failed to remove $ip (try running manually: sudo ip addr del $ip/32 dev lo)"
    else
        echo "✅ $ip is not on lo"
    fi
done

echo "✨ Network teardown complete."
