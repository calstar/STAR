#!/bin/bash
# wifi-watchdog — recover from "associated but dead" Wi-Fi.
#
# Why this exists: on a Wi-Fi-only host, 802.11 association is soft state. The
# radio can stay associated to an AP while passing zero frames (power-save
# desync, wedged USB firmware, a sick AP). NetworkManager only recovers on
# CARRIER loss, which never happens in that case -- it correctly reports
# CONNECTED_SITE and then does nothing. This script is the missing actuator:
# it tests the path end-to-end and has the authority to re-associate.
#
# Escalation ladder, one rung per consecutive failed probe (30s apart):
#   1-2   log only (ride out normal roams, which resolve in ~10s)
#   3     bounce the connection  -> forces a rescan, usually lands on a better AP
#   6     toggle the radio       -> resets adapter state a bounce cannot
#   10    reload the driver      -> last resort for wedged USB firmware
# Past rung 10 it keeps retrying the bounce every 4th tick, so it never gives up.
#
# All autodetected values can be overridden via the environment (see the
# systemd unit) if a host has more than one Wi-Fi interface.

set -uo pipefail

# --- autodetect: first Wi-Fi device, its active connection, its driver --------
IFACE="${WIFI_IFACE:-$(nmcli -t -f DEVICE,TYPE device 2>/dev/null \
  | awk -F: '$2=="wifi"{print $1; exit}')}"

if [[ -z "$IFACE" ]]; then
  logger -t wifi-watchdog -- "no Wi-Fi interface found; nothing to do"
  exit 0
fi

CONN="${WIFI_CONN:-$(nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null \
  | awk -F: -v d="$IFACE" '$2==d{print $1; exit}')}"

MODULE="${WIFI_MODULE:-$(basename "$(readlink -f "/sys/class/net/$IFACE/device/driver" \
  2>/dev/null)" 2>/dev/null)}"

STATE_DIR="${WIFI_STATE_DIR:-/run/wifi-watchdog}"
STATE_FILE="$STATE_DIR/fail_count"

# Probe targets: "host port". TCP, because ICMP is routinely filtered on campus
# and hotel networks. Mix of public DNS and the Cloudflare tunnel edge, so a
# single provider outage cannot make us think our own link is dead.
read -r -a PROBE_TARGETS <<<"${WIFI_PROBES:-}"
if (( ${#PROBE_TARGETS[@]} == 0 )); then
  PROBE_TARGETS=("1.1.1.1:443" "8.8.8.8:443" "198.41.192.7:7844")
fi

log() { logger -t wifi-watchdog -- "$*"; echo "$*"; }

# 0 if ANY target answers within 5s. Any single success means the path is fine.
probe() {
  local target host port
  for target in "${PROBE_TARGETS[@]}"; do
    host="${target%:*}"; port="${target##*:}"
    if timeout 5 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

reassociate() {
  nmcli device disconnect "$IFACE" >/dev/null 2>&1
  sleep 3
  if [[ -n "$CONN" ]]; then
    nmcli connection up "$CONN" ifname "$IFACE" >/dev/null 2>&1 \
      || log "  'nmcli connection up $CONN' returned non-zero"
  else
    nmcli device connect "$IFACE" >/dev/null 2>&1 \
      || log "  'nmcli device connect $IFACE' returned non-zero"
  fi
}

mkdir -p "$STATE_DIR"
fails=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
[[ "$fails" =~ ^[0-9]+$ ]] || fails=0

if probe; then
  (( fails > 0 )) && log "connectivity restored after $fails failed probe(s)"
  echo 0 >"$STATE_FILE"
  exit 0
fi

fails=$(( fails + 1 ))
echo "$fails" >"$STATE_FILE"

nm_state=$(nmcli -g STATE,CONNECTIVITY general 2>/dev/null | paste -sd/ -)
log "probe FAILED on $IFACE (consecutive=$fails, NetworkManager=$nm_state)"

case "$fails" in
  3)
    log "rung 1: bouncing '${CONN:-$IFACE}' to force a rescan"
    reassociate
    ;;
  6)
    log "rung 2: toggling Wi-Fi radio"
    nmcli radio wifi off >/dev/null 2>&1
    sleep 5
    nmcli radio wifi on  >/dev/null 2>&1
    ;;
  10)
    if [[ -n "$MODULE" ]]; then
      log "rung 3: reloading driver '$MODULE'"
      modprobe -r "$MODULE" >/dev/null 2>&1 || log "  modprobe -r $MODULE failed"
      sleep 5
      modprobe "$MODULE"    >/dev/null 2>&1 || log "  modprobe $MODULE failed"
      sleep 10
      reassociate
    else
      log "rung 3: driver name unknown, bouncing instead"
      reassociate
    fi
    ;;
  *)
    # Past the ladder: keep retrying the cheap fix rather than giving up.
    if (( fails > 10 && fails % 4 == 0 )); then
      log "rung 1 (repeat): still down after $fails probes"
      reassociate
    fi
    ;;
esac

exit 0
