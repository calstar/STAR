#!/usr/bin/env bash
set -euo pipefail

# Groundstation TMUX Startup Script
# This script starts the groundstation database and viewer

# Make sure ROOT_SENSOR_DIR is set
if [[ -z "${ROOT_SENSOR_DIR:-}" ]]; then
    echo "ROOT_SENSOR_DIR is not set. Did you forget to source startup.sh?"
    exit 1
fi

# Start of the script
if [ "$#" -ne 1 ]; then
    echo "Usage: tmux_start_groundstation.sh <db_name>"
    exit 1
fi

SESSION_NAME="groundstation"

DB_NAME="${1}"

TMP_DB_PATH="$HOME/.local/share/elodin/${DB_NAME}"
TMP_DB_META_PATH="${TMP_DB_PATH}_metadata"
LOG_DIR="${TMP_DB_META_PATH}/log"

TIMESTAMP=$(date +%m_%d_%y__%H_%M_%S)

# Create log directory
mkdir -p "$LOG_DIR"

# Log file paths
DB_LOG="$LOG_DIR/groundstation_db_$TIMESTAMP.log"
VIEWER_LOG="$LOG_DIR/sensor_viewer_$TIMESTAMP.log"
SENSOR_LOG="$LOG_DIR/sensor_generator_$TIMESTAMP.log"

echo "[INFO] Starting Groundstation System"
echo "[INFO] Database: $DB_NAME"
echo "[INFO] Logs will be saved to $LOG_DIR"
SLEEP_TIME_SHORT=1
SLEEP_TIME_SHELL_ENTER=2
SLEEP_TIME_LONG=3

# Write to last_run.txt
CUR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat > "$CUR_DIR/last_run.txt" <<EOF
DB_SESSION=$DB_NAME
MODE=groundstation
EOF

# Get local IP address
LOCAL_IP=$(hostname -I | awk '{print $1}')

# Kill existing session if running
tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

# Start new session
# Start tmux session with just the DB (left big pane)
tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER
tmux send-keys -t "$SESSION_NAME" "cd groundstation/scripts && source start_groundstation_db.sh $DB_NAME 2>&1 | tee $DB_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0 -T "Database"

# Start a background watcher to wait for "Database is ready!" in log
(
    sleep $SLEEP_TIME_LONG
    while true; do
        if grep -q "Database is ready" "$DB_LOG" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done

    # Once DB is ready, start sensor viewer
    tmux split-window -h -t "$SESSION_NAME":0 -c "$ROOT_SENSOR_DIR"
    sleep $SLEEP_TIME_SHELL_ENTER
    tmux send-keys -t "$SESSION_NAME":0.1 "cd groundstation/scripts && python3 sensor_data_viewer.py --host 127.0.0.1 --port 2240 2>&1 | tee $VIEWER_LOG" C-m
    tmux select-pane -t "$SESSION_NAME":0.1 -T "Sensor Viewer"
    sleep $SLEEP_TIME_SHORT

    # Start sensor generators in a third pane
    tmux split-window -v -t "$SESSION_NAME":0.1 -c "$ROOT_SENSOR_DIR"
    sleep $SLEEP_TIME_SHELL_ENTER
    tmux send-keys -t "$SESSION_NAME":0.2 "cd scripts && ./fake_sensor_generator 127.0.0.1 2240 2>&1 | tee $SENSOR_LOG" C-m
    tmux select-pane -t "$SESSION_NAME":0.2 -T "Sensor Generator"
    sleep $SLEEP_TIME_SHORT

    echo "✅ Groundstation system started successfully!"
    echo "   - Database: $DB_NAME"
    echo "   - Local IP: $LOCAL_IP"
    echo "   - Port: 2240"
    echo "   - Logs: $LOG_DIR"
    echo ""
    echo "🌐 Remote sensors can connect to: $LOCAL_IP:2240"
    echo ""
    echo "To attach to the session: tmux attach -t $SESSION_NAME"
    echo "To stop the system: tmux kill-session -t $SESSION_NAME"
) &

echo "Starting groundstation system..."
echo "Waiting for database to be ready..."

# Wait a bit for the background process to complete
sleep 5

# Attach to the session
tmux attach -t "$SESSION_NAME"
