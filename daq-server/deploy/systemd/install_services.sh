#!/bin/bash
set -e

# deploy/systemd → daq-server. pwd -P so a symlinked checkout still resolves to
# the real path.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DAQ_DIR="$(cd "$DIR/../.." && pwd -P)"          # the repo's daq-server/ dir
SYSTEMD_DIR="$HOME/.config/systemd/user"

UNITS="sensor-elodin sensor-daq sensor-simulator sensor-calibration \
sensor-controller sensor-actuator sensor-backend sensor-frontend sensor-sidecar \
sensor-heartbeat sensor-config-broadcast"

mkdir -p "$SYSTEMD_DIR"

echo "Installing systemd services (WorkingDirectory → $DAQ_DIR)..."
for u in $UNITS; do
  ln -sf "$DIR/$u.service" "$SYSTEMD_DIR/"
  # The committed units carry a placeholder WorkingDirectory=%h/sensor_system.
  # Override it with the real checkout path via a drop-in, so the DAQ works from
  # wherever it's cloned — no ~/sensor_system symlink required.
  mkdir -p "$SYSTEMD_DIR/$u.service.d"
  printf '[Service]\nWorkingDirectory=%s\n' "$DAQ_DIR" \
    > "$SYSTEMD_DIR/$u.service.d/workdir.conf"
done

echo "Reloading systemd user daemon..."
systemctl --user daemon-reload

echo ""
echo "Pipeline: UDP → daq_bridge → Elodin DB → backend → frontend."
echo ""
echo "Start the always-on web layer (the run pipeline is started by the GUI Session button):"
echo "  systemctl --user enable --now sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat"
echo ""
echo "Or start the whole stack by hand:"
echo "  systemctl --user start sensor-elodin sensor-daq sensor-simulator sensor-calibration \\"
echo "    sensor-controller sensor-actuator sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat"
echo ""
echo "Logs:"
echo "  journalctl --user -u sensor-backend -f          # one service"
echo "  bash $DAQ_DIR/deploy/startup/start_tmux_logs.sh # optional multi-pane journal view"
