#!/bin/bash
# Stop script for Tmux sessions and related background processes

echo "Stopping Sensor System tmux sessions and processes..."

# Kill all sensor-related tmux sessions
tmux kill-session -t "sensor-dev" 2>/dev/null || true
tmux kill-session -t "sensor-db-only" 2>/dev/null || true
tmux kill-session -t "sensor-logs" 2>/dev/null || true
tmux kill-session -t "sensor" 2>/dev/null || true

# Kill background processes
pkill -f "elodin-db run.*2240" 2>/dev/null || true
pkill -f "elodin-relay" 2>/dev/null || true
pkill -f "daq_bridge" 2>/dev/null || true
pkill -f "board_simulator" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch.*server.ts" 2>/dev/null || true
pkill -f "calibration_server.py" 2>/dev/null || true

# Stop systemd services if they are running
if systemctl --user is-active --quiet sensor-backend.service 2>/dev/null; then
    echo "Stopping systemd services..."
    systemctl --user stop sensor-backend sensor-frontend sensor-sidecar sensor-elodin 2>/dev/null || true
fi

echo "✅ All tmux sessions and related processes have been stopped."
