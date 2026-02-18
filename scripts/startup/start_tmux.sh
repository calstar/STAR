#!/bin/bash
# =============================================================================
# Sensor System tmux Launcher
# Starts: Elodin DB | DAQ Bridge | Elodin Editor  (3 panes)
# Then launches Diablo combined_gui.py in a separate X window.
# Usage: ./scripts/startup/start_tmux.sh [session_name] [db_name]
# =============================================================================

SESSION="${1:-sensor}"
DB_NAME="${2:-daq_live}"
ELODIN_PORT=2240
SENSOR_PORT=5006
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELODIN_DB="$HOME/.cargo/bin/elodin-db"
ELODIN_ED="$HOME/.cargo/bin/elodin"
DAQ="$PROJECT/build/FSW/daq_bridge"
CFG="$PROJECT/config/config.toml"
DB="$HOME/.local/share/elodin/$DB_NAME"
VENV="$PROJECT/venv/bin/activate"
DIABLO_GUI="$PROJECT/external/DiabloAvionics/test_guis/combined_gui.py"

# ── Preflight ───────────────────────────────────────────────────────────────
[ -x "$ELODIN_DB" ] || command -v elodin-db &>/dev/null || { echo "❌ elodin-db not found"; exit 1; }
[ -f "$DAQ" ]       || { echo "❌ daq_bridge not built — run: cd build && cmake .. && make daq_bridge -j\$(nproc)"; exit 1; }
[ -f "$CFG" ]       || { echo "❌ config.toml not found"; exit 1; }

# ── Tear down ───────────────────────────────────────────────────────────────
tmux kill-session -t "$SESSION" 2>/dev/null || true
pkill -f "elodin-db run.*:$ELODIN_PORT" 2>/dev/null || true
pkill -f "daq_bridge" 2>/dev/null || true
pkill -f "combined_gui.py" 2>/dev/null || true
pkill -f "combined_fsw_gui.py" 2>/dev/null || true
sleep 1

# ── Fresh DB ────────────────────────────────────────────────────────────────
rm -rf "$DB" "${DB}_metadata" 2>/dev/null || true

# ── Pane commands ───────────────────────────────────────────────────────────
CMD_DB="printf '\n  ══ ELODIN DB — :$ELODIN_PORT ══\n\n' && RUST_LOG=info exec $ELODIN_DB run '[::]:$ELODIN_PORT' '$DB'"

CMD_DAQ="printf '\n  ══ DAQ BRIDGE — UDP :$SENSOR_PORT ══\n\n' && sleep 2 && cd $PROJECT && exec $DAQ $CFG 0.0.0.0 $SENSOR_PORT"

CMD_ED="printf '\n  ══ ELODIN EDITOR — 127.0.0.1:$ELODIN_PORT ══\n\n' && sleep 4 && exec $ELODIN_ED editor '127.0.0.1:$ELODIN_PORT'"

# ── Create tmux session ────────────────────────────────────────────────────
# Layout (3 panes):
#  ┌──────────────────┬──────────────────┐
#  │   Elodin DB      │   DAQ Bridge     │
#  │                  │                  │
#  ├──────────────────┴──────────────────┤
#  │         Elodin Editor               │
#  └─────────────────────────────────────┘

tmux new-session  -d -s "$SESSION" -n main -x 200 -y 50 \
  "bash --norc --noprofile -c \"$CMD_DB\""

tmux set-option -t "$SESSION" remain-on-exit on

# Pane 1 (right): DAQ Bridge
tmux split-window -h -t "$SESSION:main.0" \
  "bash --norc --noprofile -c \"$CMD_DAQ\""

# Pane 2 (bottom full-width): Elodin Editor
tmux split-window -v -t "$SESSION:main.0" -l 15 \
  "bash --norc --noprofile -c \"$CMD_ED\""

tmux select-pane -t "$SESSION:main.1"

# ── Launch Diablo GUI in separate X window (not in tmux) ────────────────────
if [ -n "$DISPLAY" ] && [ -f "$DIABLO_GUI" ]; then
    echo "🖥️  Launching Diablo combined_gui.py in separate window..."
    (
        cd "$PROJECT/external/DiabloAvionics/test_guis"
        source "$VENV" 2>/dev/null
        sleep 3
        python3 combined_gui.py &
    ) &
    DIABLO_PID=$!
    echo "   PID: $DIABLO_PID"
fi

# ── Attach ──────────────────────────────────────────────────────────────────
echo "┌────────────────────────────────────────┐"
echo "│  tmux: $SESSION                        │"
echo "│  0: Elodin DB    1: DAQ Bridge         │"
echo "│  2: Elodin Editor                      │"
echo "│  + Diablo GUI (separate X window)      │"
echo "│  Ctrl+B arrows=switch  D=detach        │"
echo "│  stop: ./scripts/startup/stop_tmux.sh  │"
echo "└────────────────────────────────────────┘"
tmux attach -t "$SESSION"
