#!/bin/bash
# Install the board-LAN DHCP service (dnsmasq, star-dhcp.service).
#
# This is a ROOT SYSTEM service, unlike the sensor-* user units: DHCP needs
# privileged port 67 + raw sockets, so it can't run under `systemctl --user`.
# Run this with sudo. It:
#   1. installs dnsmasq (if missing) and disables the distro dnsmasq.service
#   2. generates /etc/star-dhcp/{star-dhcp.conf,star-dhcp.hosts} from the DAQ config
#   3. installs and enables star-dhcp.service, and restarts it if it is running
#   4. installs star-dhcp-sync.{service,path}: from then on, saving a board's
#      `mac =` in the config editor regenerates and reloads the reservations
#      by itself -- no shell step, no sudo
#
# Safe to re-run; re-run it after pulling a change to generate_dhcp_config.py
# (the sync runs a root-owned copy). The network interface is the one holding
# the board subnet; set DHCP_INTERFACE to override.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run as root (sudo $0 ...)" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"      # deploy/dhcp
DAQ_DIR="$(cd "$DIR/../.." && pwd -P)"                       # daq-server/
OUT_DIR="/etc/star-dhcp"
LIB_DIR="/usr/local/lib/star-dhcp"
# Config to read reservations from. Defaults to the active config; override with
# DAQ_CONFIG or as $1.
CONFIG="$(realpath "${1:-${DAQ_CONFIG:-$DAQ_DIR/config/config.toml}}")"

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

echo "installing systemd units..."
install -m 0644 "$DAQ_DIR/deploy/systemd/star-dhcp.service" /etc/systemd/system/star-dhcp.service
# The sync runs as root, so it runs a root-owned copy of the generator rather
# than the one in a user-writable checkout.
install -d -m 0755 "$LIB_DIR"
install -m 0644 "$DIR/generate_dhcp_config.py" "$LIB_DIR/generate_dhcp_config.py"
for unit in star-dhcp-sync.service star-dhcp-sync.path; do
  sed -e "s|@GENERATOR@|$LIB_DIR/generate_dhcp_config.py|g" -e "s|@CONFIG@|$CONFIG|g" \
    "$DAQ_DIR/deploy/systemd/$unit" > "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable star-dhcp.service
systemctl enable --now star-dhcp-sync.path

# A running server keeps its old reservations in memory until told to re-read.
# (This step was missing: re-running the installer used to leave dnsmasq on the
# old list until someone also ran `systemctl reload`.)
RUNNING=""
if systemctl is-active --quiet star-dhcp; then
  echo "star-dhcp is running: restarting it on the new config..."
  systemctl restart star-dhcp
  RUNNING=1
fi

if [ -n "$RUNNING" ]; then
  echo
  echo "Installed and running on the new config."
else
  echo
  echo "Installed. NOT started automatically -- starting it makes this host the DHCP"
  echo "authority on the board LAN. When you're ready:"
  echo
  echo "  sudo systemctl start star-dhcp"
fi
cat <<EOF
  journalctl -u star-dhcp -f          # watch leases

Reservations now follow $CONFIG by themselves: save a board's mac = in the
config editor and star-dhcp-sync regenerates and reloads them
(journalctl -u star-dhcp-sync shows each run). A board picks up a changed
address at its next boot.
EOF
