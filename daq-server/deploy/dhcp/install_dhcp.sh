#!/bin/bash
# Install the board-LAN DHCP service (dnsmasq, star-dhcp.service).
#
# This is a ROOT SYSTEM service, unlike the sensor-* user units: DHCP needs
# privileged port 67 + raw sockets, so it can't run under `systemctl --user`.
# Run this with sudo. It:
#   1. installs dnsmasq (if missing) and disables the distro dnsmasq.service
#   2. generates /etc/star-dhcp/{star-dhcp.conf,star-dhcp.hosts} from the DAQ config
#   3. installs and enables star-dhcp.service
#
# Safe to re-run. To apply reservation changes later, use reload_dhcp.sh instead.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root (sudo $0 ...)" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"      # deploy/dhcp
DAQ_DIR="$(cd "$DIR/../.." && pwd -P)"                       # daq-server/
OUT_DIR="/etc/star-dhcp"
# Config to read reservations from. Defaults to the active config; override with
# DAQ_CONFIG or as $1.
CONFIG="${1:-${DAQ_CONFIG:-$DAQ_DIR/config/config.toml}}"

echo "== board-LAN DHCP install =="
echo "  daq dir : $DAQ_DIR"
echo "  config  : $CONFIG"
echo "  out dir : $OUT_DIR"

if ! command -v dnsmasq >/dev/null 2>&1; then
  echo "installing dnsmasq..."
  apt-get update && apt-get install -y dnsmasq
fi
# The distro instance would bind :67 on all interfaces and fight ours.
systemctl disable --now dnsmasq 2>/dev/null || true

echo "generating config..."
mkdir -p "$OUT_DIR"
python3 "$DIR/generate_dhcp_config.py" --config "$CONFIG" --out-dir "$OUT_DIR"

echo "validating generated config (dnsmasq --test)..."
dnsmasq --test --conf-file="$OUT_DIR/star-dhcp.conf"

echo "installing systemd unit..."
install -m 0644 "$DAQ_DIR/deploy/systemd/star-dhcp.service" /etc/systemd/system/star-dhcp.service
systemctl daemon-reload
systemctl enable star-dhcp.service

cat <<EOF

Installed. NOT started automatically — starting it makes this host the DHCP
authority on the board LAN. When you're ready:

  sudo systemctl start star-dhcp
  journalctl -u star-dhcp -f          # watch leases

After editing [boards.*] MACs, apply changes with:

  sudo $DIR/reload_dhcp.sh
EOF
