#!/usr/bin/env bash
set -euo pipefail

# Jetson Sensor System TMUX Startup Script
# This script starts the sensor generators on the Jetson to connect to a remote groundstation

# Make sure ROOT_SENSOR_DIR is set
if [[ -z "${ROOT_SENSOR_DIR:-}" ]]; then
    echo "ROOT_SENSOR_DIR is not set. Did you forget to source startup.sh?"
    exit 1
fi

# Start of the script
if [ "$#" -ne 2 ]; then
    echo "Usage: tmux_start_jetson_sensors.sh <config_path> <groundstation_ip>"
    echo "Example: tmux_start_jetson_sensors.sh config/config_jetson.toml 192.168.1.100"
    exit 1
fi

SESSION_NAME="jetson_sensors"

CONFIG_INPUT="${1}"
GROUNDSTATION_IP="${2}"

CONFIG_PATH="$(realpath "$CONFIG_INPUT")"

TIMESTAMP=$(date +%m_%d_%y__%H_%M_%S)

# Validate config file
if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "Config file not found at: $CONFIG_PATH"
    exit 1
fi

# Create log directory
LOG_DIR="$HOME/.local/share/elodin/jetson_logs"
mkdir -p "$LOG_DIR"

# Log file paths
SENSOR_LOG="$LOG_DIR/jetson_sensors_$TIMESTAMP.log"

echo "[INFO] Starting Jetson Sensor System"
echo "[INFO] Config: $CONFIG_PATH"
echo "[INFO] Groundstation: $GROUNDSTATION_IP:2240"
echo "[INFO] Logs will be saved to $LOG_DIR"
SLEEP_TIME_SHORT=1
SLEEP_TIME_SHELL_ENTER=2

# Write to last_run.txt
CUR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat > "$CUR_DIR/last_run.txt" <<EOF
CONFIG_PATH=$CONFIG_PATH
GROUNDSTATION_IP=$GROUNDSTATION_IP
MODE=jetson
EOF

# Kill existing session if running
tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

# Start new session
tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER

# Start sensor generator
tmux send-keys -t "$SESSION_NAME" "cd scripts && ./fake_sensor_generator_remote $GROUNDSTATION_IP 2240 2>&1 | tee $SENSOR_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0 -T "Sensor Generator"

echo "✅ Jetson sensor system started successfully!"
echo "   - Config: $CONFIG_PATH"
echo "   - Groundstation: $GROUNDSTATION_IP:2240"
echo "   - Logs: $LOG_DIR"
echo ""
echo "🌐 Sensors are now streaming to groundstation at $GROUNDSTATION_IP:2240"
echo ""
echo "To attach to the session: tmux attach -t $SESSION_NAME"
echo "To stop the system: tmux kill-session -t $SESSION_NAME"

# Attach to the session
tmux attach -t "$SESSION_NAME"
