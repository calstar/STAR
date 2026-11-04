#!/bin/bash
# Tear down the systemd sim harness (start_systemd_sim.sh): stop every unit, and
# remove the sim overlay so the units revert to the hardware config. Leaves the
# installed unit symlinks in place (harmless; re-running the start script reuses them).
set -uo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

ALL_UNITS="sensor-elodin sensor-daq sensor-calibration sensor-controller sensor-actuator \
sensor-simulator sensor-frontend sensor-backend sensor-config-broadcast sensor-heartbeat"

echo "▶ Stopping DAQ units…"
systemctl --user stop $ALL_UNITS 2>/dev/null || true

# Drop the sim overlay so a later hardware run isn't silently pinned to sim.
rm -f "$HOME/.config/daq/pipeline.env" "$PROJECT/config/sim_config.toml"
echo "  removed sim overlay (pipeline.env, sim_config.toml)"

# Remove the dev symlink only if it points at this repo (never touch a real dir).
LINK="$HOME/sensor_system"
if [ -L "$LINK" ] && [ "$(readlink -f "$LINK")" = "$PROJECT" ]; then
  rm -f "$LINK"
  echo "  removed symlink $LINK"
fi
echo "✅ Torn down."
