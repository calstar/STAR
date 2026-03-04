#!/bin/bash
# Full stack: DB → services pipeline.
# Raw data flows only into Elodin DB (daq_bridge). All services consume from DB via the relay
# (single subscriber), so they are modular and independent of each other.
#
# Order: DB → relay (connects first so it's the only stream subscriber) → backend → daq_bridge → frontend → sidecar

SESSION="sensor-dev"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Check if services are already running via systemd
if systemctl --user is-active --quiet sensor-backend.service 2>/dev/null; then
  echo "⚠️  Systemd services are currently running!"
  echo "   Stop them first: systemctl --user stop sensor-elodin sensor-relay sensor-backend sensor-frontend sensor-sidecar sensor-actuator"
  exit 1
fi

ELODIN_DB_DIR="$HOME/.local/share/elodin/daq_live"
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
DAQ_BIN="$PROJECT/build/FSW/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  DAQ_BIN="$PROJECT/FSW/build/daq_bridge"
fi
CMD_DAQ="printf '\n  ══ DAQ BRIDGE (writes to Elodin — UDP from config → DB) ══\n\n' && sleep 5 && cd $PROJECT && exec $DAQ_BIN config/config.toml 2>&1"

# Calibration Service: Reads RAW DB → Writes CALIBRATED DB
CAL_BIN="$PROJECT/build/FSW/calibration_service"
if [ ! -x "$CAL_BIN" ]; then
  CAL_BIN="$PROJECT/FSW/build/calibration_service"
fi
CMD_CAL="printf '\n  ══ CALIBRATION SERVICE (DB Raw → DB Calibrated) ══\n\n' && sleep 3 && cd $PROJECT && exec $CAL_BIN --config config/config.toml --elodin-host 127.0.0.1 2>&1"

# Controller Service: Reads CALIBRATED DB → UDP out + Diagnostics DB
CTRL_BIN="$PROJECT/build/FSW/controller_service"
if [ ! -x "$CTRL_BIN" ]; then
  CTRL_BIN="$PROJECT/FSW/build/controller_service"
fi
CMD_CTRL="printf '\n  ══ CONTROLLER SERVICE (DB Calibrated → Actuators) ══\n\n' && sleep 4 && cd $PROJECT && exec $CTRL_BIN --config config/config.toml --elodin-host 127.0.0.1 2>&1"

# Actuator Service: receives state via TCP :9998, sends UDP to actuator boards
ACTUATOR_BIN="$PROJECT/build/FSW/actuator_service"
if [ ! -x "$ACTUATOR_BIN" ]; then
  ACTUATOR_BIN="$PROJECT/FSW/build/actuator_service"
fi
CMD_ACTUATOR="printf '\n  ══ ACTUATOR SERVICE (TCP :9998 → state → UDP commands) ══\n\n' && sleep 3 && cd $PROJECT && exec $ACTUATOR_BIN --config config/config.toml --port 9998 2>&1"

CMD_DB="printf '\n  ══ ELODIN DB — :2240 (raw data lands here only) ══\n\n' && mkdir -p $HOME/.local/share/elodin && RUST_LOG=debug exec $HOME/.cargo/bin/elodin-db run '[::]:2240' '$HOME/.local/share/elodin/daq_live'"
# Relay must connect to DB FIRST (sleep 2s) — daq_bridge sleeps 5s so relay subscribes before any TABLE data flows.
CMD_RELAY="printf '\n  ══ ELODIN RELAY — WS :9090 (DB → relay → services) ══\n\n' && sleep 2 && cd $PROJECT/web-gui/backend && npm run relay 2>&1"
# Auto-detect whether the actuator_service binary is available for TCP forwarding.
# If not built yet, disable TCP forwarding so state transitions send UDP directly.
ACTUATOR_SVC_ENV="ACTUATOR_SERVICE_ENABLED=false"
if [ -x "$ACTUATOR_BIN" ]; then
  ACTUATOR_SVC_ENV="ACTUATOR_SERVICE_ENABLED=true ACTUATOR_SERVICE_PORT=9998"
fi
CMD_WEB_BACKEND="printf '\n  ══ BACKEND — WS :8081 (data from relay only) ══\n\n' && sleep 5 && cd $PROJECT/web-gui/backend && $ACTUATOR_SVC_ENV ELODIN_RELAY_WS_URL=ws://localhost:9090 USE_DIRECT_DAQ=false USE_CALIBRATION_SERVICE_CALIBRATED=false npm run dev 2>&1"
CMD_WEB_FRONTEND="printf '\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n' && sleep 3 && cd $PROJECT/web-gui/frontend && npm run dev 2>&1"
CMD_SIDECAR="printf '\n  ══ CALIBRATION SIDECAR — HTTP :8100, WS :8101 ══\n\n' && cd $PROJECT && PYTHONPATH=$PROJECT exec python3 scripts/calibration/calibration_server.py 2>/dev/null || PYTHONPATH=$PROJECT exec $HOME/fsw/venv/bin/python3 scripts/calibration/calibration_server.py"
CMD_SIM="printf '\n  ══ BOARD SIMULATOR — UDP → :5006 (All Boards) ══\n\n' && sleep 4 && cd $PROJECT && ([ -x scripts/setup_sim_network.sh ] && scripts/setup_sim_network.sh || true) && exec python3 scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 2>&1"

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
  "bash --norc --noprofile -c \"$CMD_SIDECAR\""

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

tmux split-window -v -t "$SESSION:main.4" \
  "bash --norc --noprofile -c \"$CMD_CAL\""

tmux split-window -v -t "$SESSION:main.5" \
  "bash --norc --noprofile -c \"$CMD_CTRL\""

tmux split-window -v -t "$SESSION:main.6" \
  "bash --norc --noprofile -c \"$CMD_ACTUATOR\""

tmux select-layout -t "$SESSION:main" tiled

tmux select-pane -t "$SESSION:main.2"

echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  Pipeline: UDP → daq_bridge → DB → relay → backend → UI     │"
echo "│  0: Elodin DB  1: Relay :9090  2: Backend :8081             │"
echo "│  3: DAQ Bridge  4: Frontend  5: Sidecar  6: Board Simulator │"
echo "│  7: Calibration  8: Controller  9: Actuator Service        │"
echo "│  Ctrl+B arrows=switch  D=detach                              │"
echo "└─────────────────────────────────────────────────────────────┘"
tmux attach -t "$SESSION"
