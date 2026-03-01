#!/bin/bash
# Minimal stack: data → DB only. No backend, frontend, relay, or sidecar.
# Use this to verify the pipeline: UDP → daq_bridge → Elodin DB.
# Once this works, run start_tmux_dev.sh for the full stack.

SESSION="sensor-db-only"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Kill everything that could interfere
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux kill-session -t "sensor-dev" 2>/dev/null || true
pkill -f "elodin-db run.*2240" 2>/dev/null || true
pkill -f "elodin-relay" 2>/dev/null || true
pkill -f "daq_bridge" 2>/dev/null || true
pkill -f "board_simulator" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch.*server.ts" 2>/dev/null || true
pkill -f "calibration_server.py" 2>/dev/null || true
for port in 8081 8082 9090 3000; do
  pid=$(lsof -ti:$port 2>/dev/null) || true
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null || true
done
fuser -k 8081/tcp 8082/tcp 9090/tcp 3000/tcp 2>/dev/null || true
sleep 2

ELODIN_DB_DIR="$HOME/.local/share/elodin/daq_live"
HAVE_EXISTING_DB=false
pgrep -f "elodin-db run.*2240" >/dev/null 2>&1 && HAVE_EXISTING_DB=true
[ -d "$ELODIN_DB_DIR" ] || [ -d "${ELODIN_DB_DIR}_metadata" ] && HAVE_EXISTING_DB=true

if [ "$HAVE_EXISTING_DB" = true ]; then
  echo ""
  echo "Existing Elodin DB process or data found. Start fresh for clean test?"
  read -r -p "  [y/N] " REPLY
  if [[ "$REPLY" =~ ^[yY] ]]; then
    pkill -f "elodin-db run.*2240" 2>/dev/null || true
    rm -rf "$ELODIN_DB_DIR" "${ELODIN_DB_DIR}_metadata" 2>/dev/null || true
    echo "  Cleared."
  fi
  echo ""
fi

ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
if [ ! -x "$ELODIN_DB_BIN" ]; then
  echo "❌ elodin-db not found at $ELODIN_DB_BIN. Install with: cargo install elodin-db (or use your Elodin installer)"
  exit 1
fi

DAQ_BIN="$PROJECT/build/FSW/daq_bridge"
[ ! -x "$DAQ_BIN" ] && DAQ_BIN="$PROJECT/FSW/build/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  echo "❌ daq_bridge not found. Build: cd $PROJECT && mkdir -p build && cd build && cmake .. && make daq_bridge"
  exit 1
fi

CMD_DB="printf '\n  ══ ELODIN DB — :2240 (data lands here) ══\n\n' && mkdir -p $HOME/.local/share/elodin && RUST_LOG=info exec $ELODIN_DB_BIN run '[::]:2240' '$HOME/.local/share/elodin/daq_live'"
CMD_DAQ="printf '\n  ══ DAQ BRIDGE — UDP :5006 → Elodin DB ══\n\n' && sleep 2 && cd $PROJECT && exec $DAQ_BIN config/config.toml 2>&1"
CMD_SIM="printf '\n  ══ BOARD SIMULATOR — sends UDP to :5006 ══\n\n' && sleep 3 && cd $PROJECT && exec python3 scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 2>&1"

tmux new-session  -d -s "$SESSION" -n main -x 160 -y 50 "bash --norc --noprofile -c \"$CMD_DB\""
tmux set-option -t "$SESSION" remain-on-exit on
tmux split-window -h -t "$SESSION:main.0" "bash --norc --noprofile -c \"$CMD_DAQ\""
tmux split-window -v -t "$SESSION:main.0" "bash --norc --noprofile -c \"$CMD_SIM\""

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│  DATA → DB ONLY (no backend/frontend/relay)              │"
echo "│  0: Elodin DB :2240  1: DAQ Bridge  2: Board Simulator  │"
echo "│  Verify: elodin editor $ELODIN_DB_DIR                   │"
echo "│  Stop:   ./scripts/startup/stop_tmux.sh                  │"
echo "└─────────────────────────────────────────────────────────┘"
tmux attach -t "$SESSION"
