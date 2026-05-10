#!/bin/bash
# DEPRECATED — Legacy full stack using server-legacy.ts (monolithic backend).
# Use start_tmux_dev.sh instead (thin relay backend + C++ services).
#
# Full stack: DB → services pipeline.
# Raw data flows only into Elodin DB (daq_bridge). All services consume from DB via the relay
# (single subscriber), so they are modular and independent of each other.
#
# Order: DB → relay (connects first so it's the only stream subscriber) → backend → daq_bridge → frontend → sidecar

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
if [ ! -d "$PROJECT/diablo_server/backend/node_modules" ]; then
  echo "📦 Installing web-gui backend dependencies..."
  (cd "$PROJECT/diablo_server/backend" && npm install) || { echo "❌ backend npm install failed"; exit 1; }
fi
if [ ! -d "$PROJECT/diablo_server/frontend/node_modules" ]; then
  echo "📦 Installing web-gui frontend dependencies..."
  (cd "$PROJECT/diablo_server/frontend" && npm install) || { echo "❌ frontend npm install failed"; exit 1; }
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
pkill -f "actuator_service" 2>/dev/null || true
pkill -f "heartbeat_service" 2>/dev/null || true
pkill -f "config_broadcast_service" 2>/dev/null || true
pkill -f "data_logger_service" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch.*server.ts" 2>/dev/null || true
# Free backend ports so the new process can bind (frontend needs WS :8081, API :8082)
for port in 8081 8082; do
  pid=$(lsof -ti:$port 2>/dev/null) || true
  if [ -n "$pid" ]; then kill -9 "$pid" 2>/dev/null || true; fi
done
fuser -k 8081/tcp 8082/tcp 2>/dev/null || true
sleep 2

# Publisher: writes UDP sensor data → Elodin DB. Without this, nothing is written to the DB.
DAQ_BIN="$PROJECT/build/bin/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  DAQ_BIN="$PROJECT/build/bin/daq_bridge"
fi
CMD_DAQ="printf '\n  ══ DAQ BRIDGE (writes to Elodin — UDP from config → DB) ══\n\n' && sleep 5 && cd $PROJECT && exec $DAQ_BIN config/config.toml 2>&1"

# Calibration Service: Reads raw from relay TCP :9091 → Writes PT_Cal/TC_Cal/RTD_Cal/LC_Cal to Elodin
CAL_BIN="$PROJECT/build/bin/calibration_service"
if [ ! -x "$CAL_BIN" ]; then
  CAL_BIN="$PROJECT/build/bin/calibration_service"
fi

# Controller Service: Reads CALIBRATED DB → UDP out + Diagnostics DB
CTRL_BIN="$PROJECT/build/bin/controller_service"
if [ ! -x "$CTRL_BIN" ]; then
  CTRL_BIN="$PROJECT/build/bin/controller_service"
fi
CTRL_LUT="${LUT_PATH:-$PROJECT/output/lut/controller_policy_fsw.bin}"
CTRL_OPTS="--config config/config.toml --elodin-host 127.0.0.1"
[ -f "$CTRL_LUT" ] && CTRL_OPTS="$CTRL_OPTS --lut-path $CTRL_LUT"
CMD_CTRL="printf '\n  ══ CONTROLLER SERVICE (DB Calibrated → Actuators) ══\n\n' && sleep 4 && cd $PROJECT && exec $CTRL_BIN $CTRL_OPTS 2>&1"

# Actuator Service: receives state via TCP :9998, sends UDP to actuator boards
ACTUATOR_BIN="$PROJECT/build/bin/actuator_service"
if [ ! -x "$ACTUATOR_BIN" ]; then
  ACTUATOR_BIN="$PROJECT/build/bin/actuator_service"
fi
CMD_ACTUATOR="printf '\n  ══ ACTUATOR SERVICE (TCP :9998 → state → UDP commands) ══\n\n' && sleep 3 && cd $PROJECT && exec $ACTUATOR_BIN --config config/config.toml --port 9998 2>&1"

CMD_DB="printf '\n  ══ ELODIN DB — :2240 (raw data lands here only) ══\n\n' && mkdir -p $HOME/.local/share/elodin && RUST_LOG=debug exec $ELODIN_DB_BIN run '[::]:2240' '$ELODIN_DB_DIR'"
# Relay must connect to DB FIRST (sleep 2s) — daq_bridge sleeps 5s so relay subscribes before any TABLE data flows.
CMD_RELAY="printf '\n  ══ ELODIN RELAY — WS :9090 (DB → relay → services) ══\n\n' && sleep 2 && cd $PROJECT/diablo_server/backend && npm run relay 2>&1"
# Auto-detect whether the actuator_service binary is available for TCP forwarding.
# If not built yet, disable TCP forwarding so state transitions send UDP directly.
ACTUATOR_SVC_ENV="ACTUATOR_SERVICE_ENABLED=false"
if [ -x "$ACTUATOR_BIN" ]; then
  ACTUATOR_SVC_ENV="ACTUATOR_SERVICE_ENABLED=true ACTUATOR_SERVICE_PORT=9998"
fi
CMD_WEB_BACKEND="printf '\n  ══ LEGACY BACKEND — WS :8081 (server-legacy.ts) ══\n\n' && sleep 5 && cd $PROJECT/diablo_server/backend && $ACTUATOR_SVC_ENV ELODIN_RELAY_WS_URL=ws://localhost:9090 USE_DIRECT_DAQ=false USE_CALIBRATION_SERVICE_CALIBRATED=false USE_CPP_CONTROLLER=true npx tsx watch src/server-legacy.ts 2>&1"
CMD_WEB_FRONTEND="printf '\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n' && sleep 3 && cd $PROJECT/diablo_server/frontend && npm run dev 2>&1"
# Calibration: Robust stack (Python) is primary; C++ polynomial disabled when USE_ROBUST_CALIBRATION=1 (default)
USE_ROBUST_CAL="${USE_ROBUST_CALIBRATION:-1}"
CAL_VERBOSE="${CAL_VERBOSE:-1}"
CMD_CAL_CPP="printf '\n  ══ CALIBRATION (C++) — DISABLED (robust stack active) ══\n\n' && sleep infinity"
[ "$USE_ROBUST_CAL" = "0" ] && CMD_CAL_CPP="printf '\n  ══ CALIBRATION (C++) — Relay TCP → DB ══\n\n' && sleep 4 && cd $PROJECT && CAL_VERBOSE=$CAL_VERBOSE exec $CAL_BIN --config config/config.toml --elodin-host 127.0.0.1 --relay-host 127.0.0.1 --relay-port 9091 2>&1"
CMD_CAL_PY="printf '\n  ══ CALIBRATION (Python) — Robust stack (PT/TC/RTD/LC) → DB ══\n\n' && sleep 5 && cd $PROJECT && PYTHONPATH=$PROJECT exec $PYTHON_BIN tools/calibration/calibration_server.py 2>&1"
CMD_SIM="printf '\n  ══ BOARD SIMULATOR — UDP → :5006 (All Boards) ══\n\n' && sleep 4 && cd $PROJECT && ([ -x sim/setup_sim_network.sh ] && sim/setup_sim_network.sh || true) && exec $PYTHON_BIN sim/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 2>&1"
# Heartbeat service: C++ preferred (flight-ready), Python fallback
HEARTBEAT_BIN="$PROJECT/build/bin/heartbeat_service"
[ ! -x "$HEARTBEAT_BIN" ] && HEARTBEAT_BIN="$PROJECT/build/bin/heartbeat_service"
CMD_HEARTBEAT="printf '\n  ══ HEARTBEAT SERVICE — SERVER_HEARTBEAT to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $PYTHON_BIN archive/legacy/python-services/heartbeat_service.py --config config/config.toml 2>&1"
[ -x "$HEARTBEAT_BIN" ] && CMD_HEARTBEAT="printf '\n  ══ HEARTBEAT SERVICE (C++) — SERVER_HEARTBEAT to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $HEARTBEAT_BIN --config config/config.toml 2>&1"
# Config broadcast service: C++ preferred (flight-ready), Python fallback
CONFIG_BIN="$PROJECT/build/bin/config_broadcast_service"
[ ! -x "$CONFIG_BIN" ] && CONFIG_BIN="$PROJECT/build/bin/config_broadcast_service"
CMD_CONFIG="printf '\n  ══ CONFIG BROADCAST SERVICE — config packets to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $PYTHON_BIN archive/legacy/python-services/config_broadcast_service.py --config config/config.toml 2>&1"
[ -x "$CONFIG_BIN" ] && CMD_CONFIG="printf '\n  ══ CONFIG BROADCAST SERVICE (C++) — config packets to boards ══\n\n' && sleep 6 && cd $PROJECT && exec $CONFIG_BIN --config config/config.toml 2>&1"
# Data logger: connects to backend WS, writes .sensorlog on ARMED→IDLE runs
CMD_DATALOG="printf '\n  ══ DATA LOGGER SERVICE — .sensorlog recording ══\n\n' && sleep 7 && cd $PROJECT && exec $PYTHON_BIN archive/legacy/python-services/data_logger_service.py --ws-url ws://127.0.0.1:8081 2>&1"

tmux new-session  -d -s "$SESSION" -n main -x 220 -y 60 \
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
  "bash --norc --noprofile -c \"$CMD_CAL_CPP\""
tmux split-window -v -t "$SESSION:main.5" \
  "bash --norc --noprofile -c \"$CMD_CAL_PY\""

# Only launch simulator pane when USE_SIM=1 (default: disabled; set USE_SIM=1 to enable with real hardware)
if [ "${USE_SIM:-0}" = "1" ]; then
  echo -e "\n  🔌 STARTING BOARD SIMULATOR"
  tmux split-window -v -t "$SESSION:main.3" \
    "bash --norc --noprofile -c \"$CMD_SIM\""
else
  echo -e "\n  🚫 BOARD SIMULATOR DISABLED (set USE_SIM=1 to enable)"
  tmux split-window -v -t "$SESSION:main.3" \
    "bash --norc --noprofile -c \"echo '  ══ BOARD SIMULATOR DISABLED (set USE_SIM=1 to enable) ══'; sleep infinity\""
fi

tmux split-window -v -t "$SESSION:main.5" \
  "bash --norc --noprofile -c \"$CMD_CTRL\""

tmux split-window -v -t "$SESSION:main.6" \
  "bash --norc --noprofile -c \"$CMD_ACTUATOR\""

tmux split-window -v -t "$SESSION:main.2" \
  "bash --norc --noprofile -c \"$CMD_HEARTBEAT\""
tmux split-window -v -t "$SESSION:main.2" \
  "bash --norc --noprofile -c \"$CMD_CONFIG\""
tmux split-window -v -t "$SESSION:main.2" \
  "bash --norc --noprofile -c \"$CMD_DATALOG\""

tmux select-layout -t "$SESSION:main" tiled

tmux select-pane -t "$SESSION:main.2"

echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  Pipeline: UDP → daq_bridge → DB → relay → backend → UI     │"
echo "│  0: Elodin DB  1: Relay :9090  2: Backend :8081             │"
echo "│  3: DAQ Bridge  4: Frontend  5: Cal slot  6: Cal (Python)   │"
echo "│  7: Sim  8: Controller  9: Actuator  10: Heartbeat  11: Config  12: Datalog │"
echo "│  Robust stack active (PT/TC/RTD/LC). USE_ROBUST_CAL=0 for C++│"
echo "│  Ctrl+B arrows=switch  D=detach                              │"
echo "└─────────────────────────────────────────────────────────────┘"
tmux attach -t "$SESSION"
