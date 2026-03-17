#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$SYSTEMD_DIR"

echo "Symlinking systemd services..."
ln -sf "$DIR/sensor-elodin.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-daq.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-simulator.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-relay.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-calibration.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-backend.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-frontend.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-sidecar.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-heartbeat.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-config-broadcast.service" "$SYSTEMD_DIR/"

echo "Reloading systemd user daemon..."
systemctl --user daemon-reload

echo "Pipeline: UDP → daq_bridge → Elodin DB → relay → backend → frontend."
echo ""
echo "Start order:"
echo "  systemctl --user start sensor-elodin      # DB first"
echo "  systemctl --user start sensor-daq         # daq_bridge (UDP → DB)"
echo "  systemctl --user start sensor-simulator   # synthetic data (skip if using real hardware)"
echo "  systemctl --user start sensor-relay sensor-calibration sensor-backend sensor-frontend sensor-sidecar sensor-heartbeat sensor-config-broadcast"
echo ""
echo "Or start all:"
echo "  systemctl --user start sensor-elodin sensor-daq sensor-simulator sensor-relay sensor-calibration sensor-backend sensor-frontend sensor-sidecar sensor-heartbeat sensor-config-broadcast"
echo ""
echo "To enable on boot:"
echo "  systemctl --user enable sensor-elodin sensor-daq sensor-simulator sensor-relay sensor-calibration sensor-backend sensor-frontend sensor-sidecar sensor-heartbeat sensor-config-broadcast"
echo ""
echo "You can view their logs cleanly with:"
echo "  ../startup/start_tmux_logs.sh"
