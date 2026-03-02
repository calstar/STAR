#!/bin/bash
# =============================================================================
# Sensor System tmux Launcher
# Starts: Elodin DB (optional) | Web GUI Backend | Web GUI Frontend | Calibration Sidecar
# Data path: boards → UDP → Web GUI Backend (direct). DAQ Bridge and Elodin data pipeline disabled.
# Usage: ./scripts/startup/start_tmux.sh [session_name] [db_name]
# =============================================================================

SESSION="${1:-sensor}"
DB_NAME="${2:-daq_live}"
ELODIN_PORT=2240
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELODIN_DB="$HOME/.cargo/bin/elodin-db"
CFG="$PROJECT/config/config.toml"
DB="$HOME/.local/share/elodin/$DB_NAME"
KDL_DIR="$PROJECT/panels"
CONFIG_LUA="$KDL_DIR/config.lua"
WEB_GUI_BACKEND="$PROJECT/web-gui/backend"
WEB_GUI_FRONTEND="$PROJECT/web-gui/frontend"

# ── Preflight ───────────────────────────────────────────────────────────────
[ -x "$ELODIN_DB" ] || command -v elodin-db &>/dev/null || { echo "❌ elodin-db not found"; exit 1; }
[ -f "$CFG" ]       || { echo "❌ config.toml not found"; exit 1; }

# Check Web GUI availability
WEB_GUI_ENABLED=true
if ! command -v node &>/dev/null; then
    echo "⚠️  Node.js not found — Web GUI will be skipped"
    echo "   Install Node.js: cd web-gui && ./install_nodejs.sh"
    echo "   Or see: web-gui/INSTALL_NODEJS.md"
    WEB_GUI_ENABLED=false
elif [ ! -d "$WEB_GUI_BACKEND" ]; then
    echo "⚠️  Web GUI backend not found — Web GUI will be skipped"
    WEB_GUI_ENABLED=false
elif [ ! -d "$WEB_GUI_FRONTEND" ]; then
    echo "⚠️  Web GUI frontend not found — Web GUI will be skipped"
    WEB_GUI_ENABLED=false
else
    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        echo "⚠️  Node.js version $(node -v) is too old — Web GUI will be skipped"
        echo "   Need Node.js 20+. Install: cd web-gui && ./install_nodejs.sh"
        WEB_GUI_ENABLED=false
    fi
fi

# ── Tear down ───────────────────────────────────────────────────────────────
tmux kill-session -t "$SESSION" 2>/dev/null || true
pkill -f "elodin-db run.*:$ELODIN_PORT" 2>/dev/null || true
pkill -f "combined_gui.py" 2>/dev/null || true
pkill -f "combined_fsw_gui.py" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch.*server.ts" 2>/dev/null || true
sleep 1

# ── Fresh DB (optional, for state transitions) ──────────────────────────────
rm -rf "$DB" "${DB}_metadata" 2>/dev/null || true

# ── Pane commands ───────────────────────────────────────────────────────────
CONFIG_FLAG=""
[ -f "$CONFIG_LUA" ] && CONFIG_FLAG="--config $CONFIG_LUA"

CMD_DB="printf '\n  ══ ELODIN DB (optional, for state transitions) — :$ELODIN_PORT ══\n\n' && export SENSOR_KDL_PATH=$KDL_DIR/sensor-system.kdl && RUST_LOG=info exec $ELODIN_DB run '[::]:$ELODIN_PORT' '$DB' $CONFIG_FLAG"

# Robust PT Calibration Sidecar (Python) — HTTP :8100, WS :8101
CMD_SIDECAR="printf '\n  ══ CALIBRATION SIDECAR — HTTP :8100, WS :8101 ══\n\n' && cd $PROJECT && if command -v python3 >/dev/null 2>&1; then PYTHONPATH=$PROJECT exec python3 scripts/calibration/calibration_server.py; else echo '❌ python3 not found; install Python 3 to use calibration sidecar.' && sleep 3600; fi"

# Web GUI commands (only if enabled)
if [ "$WEB_GUI_ENABLED" = "true" ]; then
    # Data path: boards → UDP (sensor_port) → Backend. No DAQ Bridge, no Elodin data pipeline.
    CMD_WEB_BACKEND="printf '\n  ══ WEB GUI BACKEND — WS :8081, direct UDP (no DAQ Bridge) ══\n\n' && cd $WEB_GUI_BACKEND && if [ ! -d node_modules ]; then echo 'Installing dependencies...' && npm install; fi && echo 'Starting backend (direct DAQ, no Elodin data pipeline)...' && USE_DIRECT_DAQ=true npm run dev 2>&1"
    CMD_WEB_FRONTEND="printf '\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n' && sleep 3 && cd $WEB_GUI_FRONTEND && if [ ! -d node_modules ]; then echo 'Installing dependencies...' && npm install; fi && echo 'Starting frontend...' && npm run dev 2>&1"
else
    CMD_WEB_BACKEND="printf '\n  ══ WEB GUI BACKEND (DISABLED) ══\n\n' && echo 'Web GUI not available. Install Node.js and ensure web-gui/ exists.' && sleep 3600"
    CMD_WEB_FRONTEND="printf '\n  ══ WEB GUI FRONTEND (DISABLED) ══\n\n' && echo 'Web GUI not available. Install Node.js and ensure web-gui/ exists.' && sleep 3600"
fi

# ── Create tmux session ────────────────────────────────────────────────────
# Layout (4 panes): Elodin DB (optional) | Backend | Frontend | Sidecar
# Data: boards → UDP → Web GUI Backend only (DAQ Bridge disabled)

tmux new-session  -d -s "$SESSION" -n main -x 220 -y 60 \
  "bash --norc --noprofile -c \"$CMD_DB\""

tmux set-option -t "$SESSION" remain-on-exit on
tmux set-option -t "$SESSION" mouse on
# Pane 1 (right): Web GUI Backend
tmux split-window -h -t "$SESSION:main.0" \
  "bash --norc --noprofile -c \"$CMD_WEB_BACKEND\""

# Pane 2 (bottom left): Web GUI Frontend
tmux split-window -v -t "$SESSION:main.0" \
  "bash --norc --noprofile -c \"$CMD_WEB_FRONTEND\""

# Pane 3 (bottom): Calibration Sidecar
tmux split-window -v -t "$SESSION:main.1" \
  "bash --norc --noprofile -c \"$CMD_SIDECAR\""

tmux select-pane -t "$SESSION:main.1"

# ── Attach ──────────────────────────────────────────────────────────────────
echo "┌────────────────────────────────────────┐"
echo "│  tmux: $SESSION                        │"
echo "│  0: Elodin DB (optional)  1: Backend   │"
if [ "$WEB_GUI_ENABLED" = "true" ]; then
    echo "│  2: Web GUI Frontend  3: Calibration Sidecar │"
    echo "│  🌐 Web GUI: http://localhost:3000           │"
    echo "│  📡 Data: UDP → Backend (no DAQ Bridge)     │"
else
    echo "│  ⚠️  Web GUI: Disabled (Node.js missing)   │"
fi
echo "│  Ctrl+B arrows=switch  D=detach        │"
echo "│  stop: ./scripts/startup/stop_tmux.sh  │"
echo "└────────────────────────────────────────┘"
tmux attach -t "$SESSION"
