#!/bin/bash
# Regenerate board-LAN DHCP reservations from the DAQ config and reload dnsmasq.
#
# Use this after you add or change a [boards.*].mac. It regenerates
# /etc/star-dhcp/star-dhcp.hosts and sends SIGHUP (systemctl reload), which
# re-reads the reservations WITHOUT bouncing the service or dropping the pool.
#
# Note: changes to the base config (subnet, pool range, interface, options) need
# a full restart, not a reload — re-run install_dhcp.sh or `systemctl restart
# star-dhcp` for those.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root (sudo $0 ...)" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"      # deploy/dhcp
DAQ_DIR="$(cd "$DIR/../.." && pwd -P)"                       # daq-server/
OUT_DIR="/etc/star-dhcp"
CONFIG="${1:-${DAQ_CONFIG:-$DAQ_DIR/config/config.toml}}"

echo "regenerating from $CONFIG ..."
python3 "$DIR/generate_dhcp_config.py" --config "$CONFIG" --out-dir "$OUT_DIR"

echo "validating..."
dnsmasq --test --conf-file="$OUT_DIR/star-dhcp.conf"

echo "reloading star-dhcp (SIGHUP)..."
systemctl reload star-dhcp
echo "done. Current leases:"
cat /var/lib/misc/star-dhcp.leases 2>/dev/null || echo "  (no leases yet)"
