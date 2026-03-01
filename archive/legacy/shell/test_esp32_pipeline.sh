#!/usr/bin/env bash
set -euo pipefail

# Test script for ESP32 pipeline with fake data generator
# This creates a complete test setup to verify the entire pipeline

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_SENSOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default values
DB_NAME="${1:-esp32_rec18_$(date +%s)}"
SESSION_NAME="esp32_test"
PORT=2240
PIPE_PATH="/tmp/fake_esp32_pipe"

# Setup paths
TMP_DB_PATH="$HOME/.local/share/elodin/${DB_NAME}"
TMP_DB_META_PATH="${TMP_DB_PATH}_metadata"
LOG_DIR="${TMP_DB_META_PATH}/log"
TIMESTAMP=$(date +%m_%d_%y__%H_%M_%S)

# Create log directory
mkdir -p "$LOG_DIR"

# Log files
DB_LOG="$LOG_DIR/db_$TIMESTAMP.log"
FAKE_ESP32_LOG="$LOG_DIR/fake_esp32_$TIMESTAMP.log"
STREAMER_LOG="$LOG_DIR/streamer_$TIMESTAMP.log"

echo "🧪 ===== ESP32 PIPELINE TEST SYSTEM ====="
echo "   Database: $DB_NAME"
echo "   Logs: $LOG_DIR"
echo "   Named pipe: $PIPE_PATH"
echo ""

# Timing constants
SLEEP_TIME_SHORT=1
SLEEP_TIME_SHELL_ENTER=2
SLEEP_TIME_LONG=3

# Kill existing session if running
tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

# Kill any existing elodin-db on port 2240
pkill -f "elodin-db.*2240" 2>/dev/null || true
sleep 1

# Remove old pipe if it exists
rm -f "$PIPE_PATH"

# Create DB directory
mkdir -p "$TMP_DB_PATH"

echo "🚀 Starting test system with 4 panes..."
echo ""

# Start new tmux session
tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER

# =================
# PANE 1: DATABASE
# =================
tmux send-keys -t "$SESSION_NAME":0 "echo '📊 ELODIN DATABASE' && elodin-db run '[::]:$PORT' $TMP_DB_PATH 2>&1 | tee $DB_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0 -T "DB"

echo "⏳ Waiting for database to start..."
sleep $SLEEP_TIME_LONG

# Wait for database to be ready
for i in {1..20}; do
    if lsof -i:$PORT &>/dev/null; then
        echo "✅ Database is ready!"
        break
    fi
    sleep 0.5
done

# ===========================
# PANE 2: FAKE ESP32 GENERATOR
# ===========================
tmux split-window -h -t "$SESSION_NAME":0 -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER
tmux send-keys -t "$SESSION_NAME":0.1 "echo '🤖 FAKE ESP32 PACKET GENERATOR' && cd build && ./fake_esp32_packet_gen $PIPE_PATH 2>&1 | tee $FAKE_ESP32_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0.1 -T "Fake-ESP32"
sleep $SLEEP_TIME_SHORT

# ========================
# PANE 3: ESP32 STREAMER
# ========================
tmux split-window -v -t "$SESSION_NAME":0.1 -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER
tmux send-keys -t "$SESSION_NAME":0.2 "echo '📡 ESP32 PT STREAMER' && sleep 2 && cd build && ./esp32_pt_streamer 127.0.0.1 $PORT $PIPE_PATH 2>&1 | tee $STREAMER_LOG" C-m
tmux select-pane -t "$SESSION_NAME":0.2 -T "Streamer"
sleep $SLEEP_TIME_SHORT

# ===================
# PANE 4: VISUALIZER
# ===================
tmux split-window -v -t "$SESSION_NAME":0 -c "$ROOT_SENSOR_DIR"
sleep $SLEEP_TIME_SHELL_ENTER
tmux send-keys -t "$SESSION_NAME":0.3 "echo '👁️  ELODIN VISUALIZER' && sleep 3 && elodin" C-m
tmux select-pane -t "$SESSION_NAME":0.3 -T "Visualizer"

# Adjust pane sizes for better visibility
tmux resize-pane -t "$SESSION_NAME":0 -y 20
tmux resize-pane -t "$SESSION_NAME":0.1 -y 15

echo ""
echo "✅ ===== TEST SYSTEM STARTED SUCCESSFULLY! ====="
echo ""
echo "📊 LAYOUT:"
echo "   ┌─────────────────┬──────────────────┐"
echo "   │   DATABASE      │  FAKE ESP32 GEN  │"
echo "   │                 ├──────────────────┤"
echo "   │                 │  ESP32 STREAMER  │"
echo "   ├─────────────────┴──────────────────┤"
echo "   │         ELODIN VISUALIZER          │"
echo "   └────────────────────────────────────┘"
echo ""
echo "🔍 WHAT TO LOOK FOR:"
echo "   1. Fake ESP32: Should show packets/s and sample voltages"
echo "   2. Streamer: Should show records/s and channel counts"
echo "   3. Visualizer: Should display PT data for channels 0-9"
echo ""
echo "📝 LOGS:"
echo "   Database:    $DB_LOG"
echo "   Fake ESP32:  $FAKE_ESP32_LOG"
echo "   Streamer:    $STREAMER_LOG"
echo ""
echo "🎮 CONTROLS:"
echo "   Attach:  tmux attach -t $SESSION_NAME"
echo "   Stop:    tmux kill-session -t $SESSION_NAME"
echo ""
echo "Attaching to session in 3 seconds..."
sleep 3

# Attach to the session
tmux attach -t "$SESSION_NAME"
