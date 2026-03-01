#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$SYSTEMD_DIR"

echo "Symlinking systemd services..."
ln -sf "$DIR/sensor-backend.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-frontend.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-sidecar.service" "$SYSTEMD_DIR/"
ln -sf "$DIR/sensor-elodin.service" "$SYSTEMD_DIR/"

echo "Reloading systemd user daemon..."
systemctl --user daemon-reload

echo "Services installed! You can start them with:"
echo "  systemctl --user start sensor-backend"
echo "  systemctl --user start sensor-frontend"
echo "  systemctl --user start sensor-sidecar"
echo "  systemctl --user start sensor-elodin"
echo ""
echo "Or start all of them at once:"
echo "  systemctl --user start sensor-backend sensor-frontend sensor-sidecar sensor-elodin"
echo ""
echo "To enable them on boot:"
echo "  systemctl --user enable sensor-backend sensor-frontend sensor-sidecar sensor-elodin"
echo ""
echo "You can view their logs cleanly with:"
echo "  ../startup/start_tmux_logs.sh"
