#!/usr/bin/env bash
set -euo pipefail

# Check IP function
is_valid_ip() {
    local ip=$1
    # Basic regex for IPv4 format
    if [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        # Split into octets and check each is <= 255
        IFS='.' read -r o1 o2 o3 o4 <<< "$ip"
        if (( o1 <= 255 && o2 <= 255 && o3 <= 255 && o4 <= 255 )); then
            return 0  # Valid IP
        fi
    fi
    exit 1  # Invalid IP
}

# Make sure ROOT_SENSOR_DIR is set
if [[ -z "${ROOT_SENSOR_DIR:-}" ]]; then
    echo "ROOT_SENSOR_DIR is not set. Did you forget to source startup.sh?"
    exit 1
fi

# Start of the script
if [ "$#" -ne 2 ]; then
    echo "Usage: tmux_start_sensors.sh <config_path> <db_name>"
    exit 1
fi

SESSION_NAME="sensor_system"

CONFIG_INPUT="${1}"
DB_NAME="${2}"

TMP_DB_PATH="$HOME/.local/share/elodin/${DB_NAME}"
TMP_DB_META_PATH="${TMP_DB_PATH}_metadata"
LOG_DIR="${TMP_DB_META_PATH}/log"

CONFIG_PATH="$(realpath "$CONFIG_INPUT")"

TIMESTAMP=$(date +%m_%d_%y__%H_%M_%S)

# Validate config file
if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "Config file not found at: $CONFIG_PATH"
    exit 1
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Log file paths
DB_LOG="$LOG_DIR/db_$TIMESTAMP.log"
SENSOR_LOG="$LOG_DIR/sensors_$TIMESTAMP.log"

echo "[INFO] Using config: $CONFIG_PATH"
echo "[INFO] Logs will be saved to $LOG_DIR"
SLEEP_TIME_SHORT=1
SLEEP_TIME_SHELL_ENTER=2
SLEEP_TIME_LONG=3

# Write to last_run.txt
CUR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat > "$CUR_DIR/last_run.txt" <<EOF
DB_SESSION=$DB_NAME
CONFIG_PATH=$CONFIG_PATH
EOF

# Kill existing session if running
tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

# Start new session
# Start tmux session with just the DB (left big pane)
tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER
tmux send-keys -t "$SESSION_NAME" "cd shell && source startup_db.sh $DB_NAME 2>&1 | tee $DB_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0 -T "DB"

# Start a background watcher to wait for "Database is ready!" in log
(
    sleep $SLEEP_TIME_LONG
    while true; do
        if grep -q "Database is ready!" "$DB_LOG" 2>/dev/null; then
            break
        fi
        sleep 0.5
    done

    # Once DB is ready, start sensor generator
    tmux split-window -h -t "$SESSION_NAME":0 -c "$ROOT_SENSOR_DIR"
    sleep $SLEEP_TIME_SHELL_ENTER
    tmux send-keys -t "$SESSION_NAME":0.1 "cd scripts && ./fake_sensor_generator 2>&1 | tee $SENSOR_LOG" C-m
    tmux select-pane -t "$SESSION_NAME":0.1 -T "Sensors"
    sleep $SLEEP_TIME_SHORT

    echo "✅ Sensor system started successfully!"
    echo "   - Database: $DB_NAME"
    echo "   - Config: $CONFIG_PATH"
    echo "   - Logs: $LOG_DIR"
    echo ""
    echo "To attach to the session: tmux attach -t $SESSION_NAME"
    echo "To stop the system: tmux kill-session -t $SESSION_NAME"
) &

echo "Starting sensor system..."
echo "Waiting for database to be ready..."

# Wait a bit for the background process to complete
sleep 5

# Attach to the session
tmux attach -t "$SESSION_NAME"
