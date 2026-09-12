#!/bin/bash
#
# Install the TP-Link Wi-Fi fix + watchdog. Idempotent — safe to re-run.
#
#   sudo ./install.sh            install everything
#   sudo ./install.sh --uninstall  put it all back
#
# See README.md for what each piece does and why.
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

SBIN=/usr/local/sbin/tplink-wifi-watchdog
UNIT_DIR=/etc/systemd/system
NM_CONF=/etc/NetworkManager/conf.d/zz-wifi-powersave-off.conf
UDEV_RULE=/etc/udev/rules.d/70-tplink-8822bu-power.rules

[ "$(id -u)" = 0 ] || { echo "Run me with sudo." >&2; exit 1; }

# --- uninstall ---------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
    systemctl disable --now tplink-wifi-watchdog.timer 2>/dev/null || true
    rm -f "$SBIN" "$NM_CONF" "$UDEV_RULE" \
          "$UNIT_DIR/tplink-wifi-watchdog.service" \
          "$UNIT_DIR/tplink-wifi-watchdog.timer" \
          /run/tplink-wifi-watchdog.last
    systemctl daemon-reload
    udevadm control --reload-rules
    nmcli general reload conf 2>/dev/null || true
    echo "Uninstalled. Wi-Fi power save reverts to the distro default on next reconnect."
    exit 0
fi

echo "==> Installing watchdog script to $SBIN"
install -m 0755 "$DIR/tplink-wifi-watchdog" "$SBIN"

echo "==> Installing systemd units to $UNIT_DIR"
install -m 0644 "$DIR/tplink-wifi-watchdog.service" "$UNIT_DIR/"
install -m 0644 "$DIR/tplink-wifi-watchdog.timer"   "$UNIT_DIR/"
systemctl daemon-reload

echo "==> Disabling Wi-Fi power save (the actual fix)"
install -m 0644 "$DIR/zz-wifi-powersave-off.conf" "$NM_CONF"
# Reload config rather than restarting NetworkManager: a restart would bounce
# every connection on this box, including the DAQ's own link.
nmcli general reload conf 2>/dev/null || true

echo "==> Keeping USB autosuspend off across re-enumeration"
install -m 0644 "$DIR/70-tplink-8822bu-power.rules" "$UDEV_RULE"
udevadm control --reload-rules

# Apply to the adapter that is up right now, so the fix takes effect without
# waiting for a reconnect. NM's powersave setting only applies on activation.
IFACE=$(for n in /sys/class/net/wlx*; do [ -d "$n" ] && basename "$n" && break; done) || true
if [ -n "${IFACE:-}" ]; then
    echo "==> Applying to the live interface $IFACE"
    iw dev "$IFACE" set power_save off 2>/dev/null \
        && echo "    power_save: $(iw dev "$IFACE" get power_save | sed 's/.*: //')" \
        || echo "    (could not set power_save on $IFACE; it will apply on next reconnect)"
    # Persist on the active profile too, so it survives a profile reactivation
    # even if the conf.d default is ever changed back.
    CON=$(nmcli -g GENERAL.CONNECTION device show "$IFACE" 2>/dev/null || true)
    if [ -n "$CON" ] && [ "$CON" != "--" ]; then
        nmcli connection modify "$CON" 802-11-wireless.powersave 2 2>/dev/null \
            && echo "    pinned powersave=2 on profile '$CON'" || true
    fi
fi

echo "==> Enabling the timer"
systemctl enable --now tplink-wifi-watchdog.timer

echo
echo "Done."
echo
systemctl list-timers tplink-wifi-watchdog.timer --no-pager 2>/dev/null | head -3
echo
echo "Check health any time:   sudo tplink-wifi-watchdog --status"
echo "Force a reset by hand:   sudo tplink-wifi-watchdog --now"
echo "Watch it work:           journalctl -t tplink-wifi-watchdog -f"
