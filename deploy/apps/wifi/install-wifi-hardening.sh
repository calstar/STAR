#!/bin/bash
# Wi-Fi hardening for Wi-Fi-only hosts (STAR apps/DAQ server and friends).
# Run as root. Idempotent. Does NOT drop the current association.
#
# Safe to run on a live server: it only touches Wi-Fi (power save, connectivity
# checking, and a recovery watchdog) and reassociates nothing on install.
#
# Installs, all copied from the files next to this script (single source of truth):
#   /etc/NetworkManager/conf.d/default-wifi-powersave-on.conf  (power save off)
#   /etc/NetworkManager/conf.d/99-star-connectivity.conf       (fast conn checks)
#   /usr/local/sbin/wifi-watchdog.sh
#   /etc/systemd/system/wifi-watchdog.{service,timer}
set -euo pipefail

if (( EUID != 0 )); then
  echo "must run as root (try: sudo $0)" >&2
  exit 1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> 1/5 disabling Wi-Fi power save"
install -m 0644 "$SRC/default-wifi-powersave-on.conf" \
  /etc/NetworkManager/conf.d/default-wifi-powersave-on.conf

echo "==> 2/5 tightening connectivity checking and autoconnect"
install -m 0644 "$SRC/99-star-connectivity.conf" \
  /etc/NetworkManager/conf.d/99-star-connectivity.conf

echo "==> 3/5 installing watchdog"
install -m 0755 "$SRC/wifi-watchdog.sh" /usr/local/sbin/wifi-watchdog.sh

echo "==> 4/5 installing systemd units"
install -m 0644 "$SRC/wifi-watchdog.service" /etc/systemd/system/wifi-watchdog.service
install -m 0644 "$SRC/wifi-watchdog.timer"   /etc/systemd/system/wifi-watchdog.timer

systemctl daemon-reload
systemctl enable --now wifi-watchdog.timer

echo "==> 5/5 applying power save to live interfaces (no reconnect needed)"
systemctl reload NetworkManager
for dev in $(nmcli -t -f DEVICE,TYPE device | awk -F: '$2=="wifi"{print $1}'); do
  if iw dev "$dev" set power_save off 2>/dev/null; then
    echo "    $dev: power save off"
  else
    echo "    $dev: iw failed, will apply on next reconnect"
  fi
done

echo
echo "Done. Verify:"
echo "  nmcli -t -f DEVICE,TYPE device | awk -F: '\$2==\"wifi\"{print \$1}' \\"
echo "    | xargs -I{} iw dev {} get power_save      # expect: off"
echo "  systemctl status wifi-watchdog.timer"
echo "  journalctl -t wifi-watchdog -f"
