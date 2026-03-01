#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$SYSTEMD_DIR"

echo "Symlinking systemd services..."
ln -sf "$DIR/sensor-elodin.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-relay.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-backend.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-frontend.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-sidecar.service" "$SYSTEMD_DIR/"

echo "Reloading systemd user daemon..."
systemctl --user daemon-reload

echo "Pipeline: data → Elodin DB → relay → backend → frontend (all services feed off DB)."
echo ""
echo "Start order (relay must run before backend):"
echo "  systemctl --user start sensor-elodin    # DB first"
echo "  systemctl --user start sensor-relay     # single DB subscriber, fans out"
echo "  systemctl --user start sensor-backend sensor-frontend sensor-sidecar"
echo ""
echo "Or start all:"
echo "  systemctl --user start sensor-elodin sensor-relay sensor-backend sensor-frontend sensor-sidecar"
echo ""
echo "To enable on boot:"
echo "  systemctl --user enable sensor-elodin sensor-relay sensor-backend sensor-frontend sensor-sidecar"
echo ""
echo "You can view their logs cleanly with:"
echo "  ../startup/start_tmux_logs.sh"
