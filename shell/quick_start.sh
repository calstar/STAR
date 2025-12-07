#!/usr/bin/env bash
set -euo pipefail

# Quick sensor system startup - based on your proven tmux pattern

# Set ROOT_SENSOR_DIR to project root (parent of shell directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_SENSOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default values
DB_NAME="${1:-test_db}"
SESSION_NAME="sensor_system"
PORT=2240

# Setup paths
TMP_DB_PATH="$HOME/.local/share/elodin/${DB_NAME}"
TMP_DB_META_PATH="${TMP_DB_PATH}_metadata"
LOG_DIR="${TMP_DB_META_PATH}/log"
TIMESTAMP=$(date +%m_%d_%y__%H_%M_%S)

# Create log directory
mkdir -p "$LOG_DIR"

# Log files
DB_LOG="$LOG_DIR/db_$TIMESTAMP.log"
SENSOR_LOG="$LOG_DIR/sensors_$TIMESTAMP.log"

echo "🚀 Starting Sensor System..."
echo "   Database: $DB_NAME"
echo "   Logs: $LOG_DIR"

# Timing constants
SLEEP_TIME_SHORT=1
SLEEP_TIME_SHELL_ENTER=2
SLEEP_TIME_LONG=3

# Kill existing session if running
tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

# Kill any existing elodin-db on port 2240
pkill -f "elodin-db.*2240" 2>/dev/null || true
sleep 1

# Create DB directory
mkdir -p "$TMP_DB_PATH"

# Start new tmux session
tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER

# Start database in first pane
tmux send-keys -t "$SESSION_NAME":0 "elodin-db run '[::]:$PORT' $TMP_DB_PATH 2>&1 | tee $DB_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0 -T "DB"

echo "Waiting for database to start..."
sleep $SLEEP_TIME_LONG

# Wait for database to be ready (check if port is listening)
for i in {1..20}; do
    if lsof -i:$PORT &>/dev/null; then
        echo "✅ Database is ready!"
        break
    fi
    sleep 0.5
done

# Start ESP32 PT streamer in second pane (using real hardware /dev/ttyACM0)
tmux split-window -h -t "$SESSION_NAME":0 -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER
tmux send-keys -t "$SESSION_NAME":0.1 "cd build && ./esp32_pt_streamer 127.0.0.1 $PORT /dev/ttyACM0 2>&1 | tee $SENSOR_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0.1 -T "ESP32-PT"
sleep $SLEEP_TIME_SHORT

# Add third pane for visualizer
tmux split-window -v -t "$SESSION_NAME":0.1 -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER
tmux send-keys -t "$SESSION_NAME":0.2 "elodin" C-m
tmux select-pane -t "$SESSION_NAME":0.2 -T "Visualizer"

echo "✅ Sensor system started successfully!"
echo "   - Database: $DB_NAME"
echo "   - Logs: $LOG_DIR"
echo ""
echo "Attaching to session..."

# Attach to the session
sleep 1
tmux attach -t "$SESSION_NAME"
