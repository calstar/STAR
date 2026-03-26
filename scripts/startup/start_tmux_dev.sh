#!/bin/bash
# Full stack with the default server.ts (thin relay backend).
# Legacy monolithic backend is available via start_tmux_dev_legacy.sh.
#
# Thin backend: HTTP + WebSocket on WS_PORT (8081 here so frontend + data_logger defaults work).
# Env aligns with integration test thin path: ELODIN_RELAY_URL, WS_PORT, ACTUATOR_SERVICE_PORT.
#
# Startup delays in each CMD_* keep pipeline safe (DB before relay before DAQ) regardless of pane order.
# Command path: thin → TCP :9998 → sequencer_service (matches test_integration.sh).
# Tmux: same split topology as start_tmux_dev_legacy.sh. Sequencer + OTA replace cal panes; one
# placeholder pane where actuator_service ran (sequencer owns TCP :9998). Thirteen panes total.

SESSION="sensor-dev"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Prefer: 1) bashrc-activated venv (VIRTUAL_ENV), 2) repo .venv, 3) PATH python3
PYTHON_BIN=""
if [ -n "$VIRTUAL_ENV" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then
  PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif [ -x "$PROJECT/.venv/bin/python" ]; then
  PYTHON_BIN="$PROJECT/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || command -v python || true)"
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "❌ python3 not found. Activate your venv (e.g. source ~/.bashrc) or run:"
  echo "   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

# Node.js must be modern enough for the web GUI tooling.
if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found. Install Node.js 20+ (recommended) and retry."
  exit 1
fi
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js 20+ required. Current: $(node -v)"
  exit 1
fi
if [ "$NODE_MAJOR" -ge 23 ]; then
  echo "⚠️  Node.js $(node -v) detected. If relay/backend crash, switch to Node 20/22."
fi

# Elodin DB binary (portable path: cargo bin or PATH).
ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
if [ ! -x "$ELODIN_DB_BIN" ]; then
  ELODIN_DB_BIN="$(command -v elodin-db || true)"
fi
if [ -z "$ELODIN_DB_BIN" ]; then
  echo "❌ elodin-db not found. Install it (cargo) and ensure it's on PATH."
  exit 1
fi

# Ensure web-gui dependencies are installed (tmux panes assume they exist).
if [ ! -d "$PROJECT/web-gui/backend/node_modules" ]; then
  echo "📦 Installing web-gui backend dependencies..."
  (cd "$PROJECT/web-gui/backend" && npm install) || { echo "❌ backend npm install failed"; exit 1; }
fi
if [ ! -d "$PROJECT/web-gui/frontend/node_modules" ]; then
  echo "📦 Installing web-gui frontend dependencies..."
  (cd "$PROJECT/web-gui/frontend" && npm install) || { echo "❌ frontend npm install failed"; exit 1; }
fi

# Check if services are already running via systemd
if systemctl --user is-active --quiet sensor-backend.service 2>/dev/null; then
  echo "⚠️  Systemd services are currently running!"
  echo "   Stop them first: systemctl --user stop sensor-elodin sensor-relay sensor-backend sensor-frontend sensor-sidecar sensor-actuator"
  exit 1
fi

if [ -z "$ELODIN_DB_NAME" ]; then
  read -r -p "Enter optional DB name (press Enter for timestamp default): " CUSTOM_DB_NAME
  if [ -n "$CUSTOM_DB_NAME" ]; then
    ELODIN_DB_NAME="$CUSTOM_DB_NAME"
  fi
fi

DB_NAME="${ELODIN_DB_NAME:-daq_$(date +%Y%m%d_%H%M%S)}"
echo "Using DB Name: $DB_NAME"

ELODIN_DB_DIR="$HOME/.local/share/elodin/$DB_NAME"
HAVE_EXISTING_DB=false
pgrep -f "elodin-db run.*2240" >/dev/null 2>&1 && HAVE_EXISTING_DB=true
[ -d "$ELODIN_DB_DIR" ] || [ -d "${ELODIN_DB_DIR}_metadata" ] && HAVE_EXISTING_DB=true

if [ "$HAVE_EXISTING_DB" = true ]; then
  echo ""
  echo "Existing Elodin DB process or data found."
  echo "Start fresh? (kill process + clear DB — recommended for accurate server time)"
  read -r -p "  [y/N] " REPLY
  if [[ "$REPLY" =~ ^[yY] ]]; then
    pkill -f "elodin-db run.*2240" 2>/dev/null || true
    rm -rf "$ELODIN_DB_DIR" "${ELODIN_DB_DIR}_metadata" 2>/dev/null || true
    echo "  Cleared. Starting fresh."
  fi
  echo ""
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
pkill -f "elodin-db run.*2240" 2>/dev/null || true
pkill -f "elodin-relay" 2>/dev/null || true
pkill -f "daq_bridge" 2>/dev/null || true
pkill -f "sequencer_service" 2>/dev/null || true
pkill -f "actuator_service" 2>/dev/null || true
pkill -f "heartbeat_service" 2>/dev/null || true
pkill -f "config_broadcast_service" 2>/dev/null || true
pkill -f "data_logger_service" 2>/dev/null || true
pkill -f "board_simulator" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch.*server\.ts" 2>/dev/null || true
pkill -f "tsx.*server\.ts" 2>/dev/null || true
# Thin uses :8081 for HTTP+WS (frontend + datalogger); free 8082 for stray legacy API listeners
for port in 8081 8082; do
  pid=$(lsof -ti:$port 2>/dev/null) || true
  if [ -n "$pid" ]; then kill -9 "$pid" 2>/dev/null || true; fi
done
fuser -k 8081/tcp 8082/tcp 2>/dev/null || true
OTA_CMD_PORT="${OTA_SERVICE_CMD_PORT:-9997}"
fuser -k "${OTA_CMD_PORT}/tcp" 2>/dev/null || true
sleep 2

OTA_BIN="$PROJECT/build/FSW/ota_service"
if [ ! -x "$OTA_BIN" ]; then
  OTA_BIN="$PROJECT/FSW/build/ota_service"
fi
pkill -f "ota_service" 2>/dev/null || true

# Publisher: writes UDP sensor data → Elodin DB. Without this, nothing is written to the DB.
DAQ_BIN="$PROJECT/build/FSW/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  DAQ_BIN="$PROJECT/FSW/build/daq_bridge"
fi
CMD_DAQ="printf '\n  ══ DAQ BRIDGE (writes to Elodin — UDP from config → DB) ══\n\n' && sleep 5 && cd $PROJECT && exec $DAQ_BIN config/config.toml 2>&1"

# Controller Service: Reads CALIBRATED DB → UDP out + Diagnostics DB
CTRL_BIN="$PROJECT/build/FSW/controller_service"
if [ ! -x "$CTRL_BIN" ]; then
  CTRL_BIN="$PROJECT/FSW/build/controller_service"
fi
CTRL_LUT="${LUT_PATH:-$PROJECT/output/lut/controller_policy_fsw.bin}"
CTRL_OPTS="--config config/config.toml --elodin-host 127.0.0.1"
[ -f "$CTRL_LUT" ] && CTRL_OPTS="$CTRL_OPTS --lut-path $CTRL_LUT"
CMD_CTRL="printf '\n  ══ CONTROLLER SERVICE (DB Calibrated → Actuators) ══\n\n' && sleep 4 && cd $PROJECT && exec $CTRL_BIN $CTRL_OPTS 2>&1"

# Sequencer service: state machine + actuator UDP (same TCP :9998 text protocol as server.ts)
SEQ_BIN="$PROJECT/build/FSW/sequencer_service"
if [ ! -x "$SEQ_BIN" ]; then
  SEQ_BIN="$PROJECT/FSW/build/sequencer_service"
fi
if [ -x "$SEQ_BIN" ]; then
  CMD_SEQUENCER="printf '\n  ══ SEQUENCER SERVICE (TCP :9998 — TRANSITION / ACTUATOR / …) ══\n\n' && sleep 3 && cd $PROJECT && exec $SEQ_BIN --config config/config.toml --port 9998 2>&1"
else
  CMD_SEQUENCER="printf '\n  ❌ sequencer_service not found. Build: cd FSW/build && cmake .. && make sequencer_service\n\n' && sleep infinity"
fi

CMD_DB="printf '\n  ══ ELODIN DB — :2240 (raw data lands here only) ══\n\n' && mkdir -p $HOME/.local/share/elodin && RUST_LOG=debug exec $ELODIN_DB_BIN run '[::]:2240' '$ELODIN_DB_DIR'"
# Relay must connect to DB FIRST (sleep 2s) — daq_bridge sleeps 5s so relay subscribes before any TABLE data flows.
CMD_RELAY="printf '\n  ══ ELODIN RELAY — WS :9090 (DB → relay → services) ══\n\n' && sleep 2 && cd $PROJECT/web-gui/backend && npm run relay 2>&1"

# Thin backend (see test_integration.sh BACKEND=thin): ELODIN_RELAY_URL — not ELODIN_RELAY_WS_URL
THIN_WS_PORT="${THIN_WS_PORT:-8081}"
THIN_RELAY_URL="${THIN_RELAY_URL:-ws://localhost:9090}"
THIN_ACT_PORT="${THIN_ACTUATOR_SERVICE_PORT:-9998}"
CMD_WEB_BACKEND="printf '\n  ══ BACKEND — HTTP+WS :${THIN_WS_PORT} (server.ts) ══\n\n' && sleep 5 && cd $PROJECT/web-gui/backend && WS_PORT=$THIN_WS_PORT ELODIN_RELAY_URL=$THIN_RELAY_URL ACTUATOR_SERVICE_PORT=$THIN_ACT_PORT npx tsx watch src/server.ts 2>&1"

CMD_WEB_FRONTEND="printf '\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n' && sleep 3 && cd $PROJECT/web-gui/frontend && OTA_SERVICE_PORT=$OTA_CMD_PORT NEXT_PUBLIC_WS_URL=ws://127.0.0.1:${THIN_WS_PORT} npm run dev 2>&1"

if [ -x "$OTA_BIN" ]; then
  CMD_OTA="printf '\n  ══ ETHERNET OTA SERVICE — TCP :${OTA_CMD_PORT} (pio build+flash here) ══\n\n' && exec $OTA_BIN --port $OTA_CMD_PORT 2>&1"
else
  CMD_OTA="printf '\n  ❌ ota_service not built — cd FSW/build && cmake .. && make ota_service\n\n' && sleep infinity"
fi

# Board simulator (pane 0); set USE_SIM=1 to run (default off for real hardware)
if [ "${USE_SIM:-0}" = "1" ]; then
  CMD_SIM="printf '\n  ══ BOARD SIMULATOR — UDP → :5006 (All Boards) ══\n\n' && sleep 4 && cd $PROJECT && ([ -x scripts/setup_sim_network.sh ] && scripts/setup_sim_network.sh || true) && exec $PYTHON_BIN scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 2>&1"
else
  CMD_SIM="printf '\n  ══ BOARD SIMULATOR — DISABLED (USE_SIM=1 to enable) ══\n\n' && sleep infinity"
fi
# Heartbeat service: C++ preferred (flight-ready), Python fallback — poll /api/engine_state on thin HTTP port
HEARTBEAT_BIN="$PROJECT/build/FSW/heartbeat_service"
[ ! -x "$HEARTBEAT_BIN" ] && HEARTBEAT_BIN="$PROJECT/FSW/build/heartbeat_service"
HB_BACKEND_URL="http://127.0.0.1:${THIN_WS_PORT}"
# Python heartbeat polls /api/engine_state; C++ reads sequencer state from Elodin (no backend URL).
CMD_HEARTBEAT="printf '\n  ══ HEARTBEAT SERVICE — SERVER_HEARTBEAT to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $PYTHON_BIN scripts/services/heartbeat_service.py --config config/config.toml --backend-url $HB_BACKEND_URL 2>&1"
[ -x "$HEARTBEAT_BIN" ] && CMD_HEARTBEAT="printf '\n  ══ HEARTBEAT SERVICE (C++) — SERVER_HEARTBEAT to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $HEARTBEAT_BIN --config config/config.toml 2>&1"
# Config broadcast service: C++ preferred (flight-ready), Python fallback
CONFIG_BIN="$PROJECT/build/FSW/config_broadcast_service"
[ ! -x "$CONFIG_BIN" ] && CONFIG_BIN="$PROJECT/FSW/build/config_broadcast_service"
CMD_CONFIG="printf '\n  ══ CONFIG BROADCAST SERVICE — config packets to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $PYTHON_BIN scripts/services/config_broadcast_service.py --config config/config.toml 2>&1"
[ -x "$CONFIG_BIN" ] && CMD_CONFIG="printf '\n  ══ CONFIG BROADCAST SERVICE (C++) — config packets to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $CONFIG_BIN --config config/config.toml 2>&1"
# Data logger: connects to backend WS (same port as frontend default)
CMD_DATALOG="printf '\n  ══ DATA LOGGER SERVICE — .sensorlog recording ══\n\n' && sleep 7 && cd $PROJECT && exec $PYTHON_BIN scripts/services/data_logger_service.py --ws-url ws://127.0.0.1:${THIN_WS_PORT} 2>&1"

# Legacy layout keeps an actuator pane index; thin uses sequencer_service instead of actuator_service.
CMD_ACTUATOR_PLACEHOLDER="printf '\n  ══ actuator_service — N/A (Sequencer pane owns TCP :9998) ══\n\n' && sleep infinity"

# ── Tmux: same split sequence as start_tmux_dev_legacy.sh (known-good pane targets) ──
tmux new-session -d -s "$SESSION" -n main -x 220 -y 60 \
  "bash --norc --noprofile -c \"$CMD_DB\""

tmux set-option -t "$SESSION" remain-on-exit on
tmux set-option -t "$SESSION" mouse on

tmux split-window -h -t "$SESSION:main.0" \
  "bash --norc --noprofile -c \"$CMD_RELAY\""

tmux split-window -h -t "$SESSION:main.1" \
  "bash --norc --noprofile -c \"$CMD_WEB_BACKEND\""

tmux split-window -v -t "$SESSION:main.0" \
  "bash --norc --noprofile -c \"$CMD_DAQ\""

tmux split-window -v -t "$SESSION:main.1" \
  "bash --norc --noprofile -c \"$CMD_WEB_FRONTEND\""

tmux split-window -v -t "$SESSION:main.2" \
  "bash --norc --noprofile -c \"$CMD_SEQUENCER\""

tmux split-window -v -t "$SESSION:main.5" \
  "bash --norc --noprofile -c \"$CMD_OTA\""

if [ "${USE_SIM:-0}" = "1" ]; then
  echo -e "\n  🔌 STARTING BOARD SIMULATOR"
else
  echo -e "\n  🚫 BOARD SIMULATOR DISABLED (set USE_SIM=1 to enable)"
fi
tmux split-window -v -t "$SESSION:main.3" \
  "bash --norc --noprofile -c \"$CMD_SIM\""

tmux split-window -v -t "$SESSION:main.5" \
  "bash --norc --noprofile -c \"$CMD_CTRL\""

tmux split-window -v -t "$SESSION:main.6" \
  "bash --norc --noprofile -c \"$CMD_ACTUATOR_PLACEHOLDER\""

tmux split-window -v -t "$SESSION:main.2" \
  "bash --norc --noprofile -c \"$CMD_HEARTBEAT\""
tmux split-window -v -t "$SESSION:main.2" \
  "bash --norc --noprofile -c \"$CMD_CONFIG\""
tmux split-window -v -t "$SESSION:main.2" \
  "bash --norc --noprofile -c \"$CMD_DATALOG\""

tmux select-layout -t "$SESSION:main" tiled

tmux select-pane -t "$SESSION:main.2"

echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  Pipeline: UDP → daq_bridge → DB → relay → backend → UI       │"
echo "│  Layout matches legacy splits (see start_tmux_dev_legacy.sh)  │"
echo "│  0: Elodin DB  1: Relay :9090  2: Backend :${THIN_WS_PORT} (server.ts) │"
echo "│  3: DAQ  4: Frontend :3000  5: Sequencer :9998  6: OTA :${OTA_CMD_PORT} │"
echo "│  7: Simulator  8: Controller  9: (actuator N/A — use Sequencer) │"
echo "│  10: Heartbeat  11: Config  12: Data logger                  │"
echo "│  USE_SIM=1 enables simulator; run calibration_server separately │"
echo "│  Override: THIN_WS_PORT THIN_RELAY_URL THIN_ACTUATOR_SERVICE_PORT OTA_SERVICE_CMD_PORT │"
echo "│  Ctrl+B arrows=switch  D=detach                              │"
echo "└─────────────────────────────────────────────────────────────┘"
tmux attach -t "$SESSION"
