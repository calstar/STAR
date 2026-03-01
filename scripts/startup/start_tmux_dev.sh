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
  echo "   Stop them first: systemctl --user stop sensor-elodin sensor-relay sensor-backend sensor-frontend sensor-sidecar"
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
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch.*server.ts" 2>/dev/null || true
# Free backend ports so the new process can bind (frontend needs WS :8081, API :8082)
for port in 8081 8082; do
  pid=$(lsof -ti:$port 2>/dev/null) || true
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null || true
done
fuser -k 8081/tcp 8082/tcp 2>/dev/null || true
sleep 2

# Publisher: writes UDP sensor data → Elodin DB. Without this, nothing is written to the DB.
DAQ_BIN="$PROJECT/build/FSW/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  DAQ_BIN="$PROJECT/FSW/build/daq_bridge"
fi
CMD_DAQ="printf '\n  ══ DAQ BRIDGE (writes to Elodin — UDP from config → DB) ══\n\n' && sleep 5 && cd $PROJECT && exec $DAQ_BIN config/config.toml 2>&1"

CMD_DB="printf '\n  ══ ELODIN DB — :2240 (raw data lands here only) ══\n\n' && mkdir -p $HOME/.local/share/elodin && RUST_LOG=debug exec $HOME/.cargo/bin/elodin-db run '[::]:2240' '$HOME/.local/share/elodin/daq_live'"
# Relay must connect to DB FIRST (sleep 2s) — daq_bridge sleeps 5s so relay subscribes before any TABLE data flows.
CMD_RELAY="printf '\n  ══ ELODIN RELAY — WS :9090 (DB → relay → services) ══\n\n' && sleep 2 && cd $PROJECT/web-gui/backend && npm run relay 2>&1"
CMD_WEB_BACKEND="printf '\n  ══ BACKEND — WS :8081 (data from relay only) ══\n\n' && sleep 5 && cd $PROJECT/web-gui/backend && ELODIN_RELAY_WS_URL=ws://localhost:9090 USE_DIRECT_DAQ=false npm run dev 2>&1"
CMD_WEB_FRONTEND="printf '\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n' && sleep 3 && cd $PROJECT/web-gui/frontend && npm run dev 2>&1"
CMD_SIDECAR="printf '\n  ══ CALIBRATION SIDECAR — HTTP :8100, WS :8101 ══\n\n' && cd $PROJECT && PYTHONPATH=$PROJECT exec python3 scripts/calibration/calibration_server.py 2>/dev/null || PYTHONPATH=$PROJECT exec $HOME/fsw/venv/bin/python3 scripts/calibration/calibration_server.py"

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

tmux select-pane -t "$SESSION:main.2"

echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  Pipeline: UDP → daq_bridge → DB → relay → backend → UI     │"
echo "│  0: Elodin DB  1: Relay :9090  2: Backend :8081             │"
echo "│  3: DAQ Bridge (→DB)  4: Frontend  5: Sidecar               │"
echo "│  Optional: run board_simulator for synthetic data            │"
echo "│  Ctrl+B arrows=switch  D=detach                              │"
echo "└─────────────────────────────────────────────────────────────┘"
tmux attach -t "$SESSION"
