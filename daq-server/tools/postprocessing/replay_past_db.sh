#!/bin/bash
# Run the web GUI against a past Elodin DB (replay only: no daq_bridge, simulator, or controller).
#
# Usage:
#   ./replay_past_db.sh <DB_NAME>
#   ./replay_past_db.sh daq_20260306_043134
#
# DB_NAME is a directory under ~/.local/share/elodin/ or a full path.
# Requires: elodin-db, Node.js 20+

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# The GUI lives in star_server/, two levels up from tools/postprocessing.
BACKEND_DIR="$SCRIPT_DIR/../../star_server/backend"
FRONTEND_DIR="$SCRIPT_DIR/../../star_server/frontend"

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <DB_NAME>"
  echo "  DB_NAME: name under ~/.local/share/elodin/ (e.g. daq_20260306_043134) or full path"
  echo ""
  echo "Available DBs under ~/.local/share/elodin/:"
  find "$HOME/.local/share/elodin" -maxdepth 1 -mindepth 1 -printf '  %f\n' 2>/dev/null || echo "  (none or directory missing)"
  exit 1
fi

DB_NAME="$1"
if [[ "$DB_NAME" == */* ]]; then
  DB_PATH="$(realpath "$DB_NAME")"
else
  DB_PATH="$HOME/.local/share/elodin/$DB_NAME"
fi

if [[ ! -d "$DB_PATH" ]]; then
  echo "❌ DB not found: $DB_PATH"
  exit 1
fi

ELODIN_PORT="${ELODIN_PORT:-2240}"
ELODIN_DB_BIN=""
[ -f "$HOME/.cargo/bin/elodin-db" ] && ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
[ -z "$ELODIN_DB_BIN" ] && command -v elodin-db &>/dev/null && ELODIN_DB_BIN="elodin-db"
if [[ -z "$ELODIN_DB_BIN" ]]; then
  echo "❌ elodin-db not found. Install it or ensure it's on PATH."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found."
  exit 1
fi

# Stop any existing elodin-db on our port so we can bind the past DB
if lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
  echo "📊 Stopping existing elodin-db on port $ELODIN_PORT..."
  pkill -f "elodin-db run.*$ELODIN_PORT" 2>/dev/null || true
  sleep 2
  if lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
    echo "❌ Port $ELODIN_PORT still in use. Free it and retry."
    exit 1
  fi
fi

echo "📂 Replay DB: $DB_PATH"

# Decode with the config the run was RECORDED with, not today's. The session copied it beside the
# run dir as <run>.toml (service-controller.ts snapshotRunConfig). It decides what every table
# means — sensor roles, and for a LabJack T7 which calibrated table is psi, °C or kg — so replaying
# an old run against a since-edited config mislabels channels or drops T7 data outright.
# Copied into a scratch dir rather than pointed at in place: the backend seeds a profiles/ folder
# beside whatever CONFIG_PATH names, and that must not land in the Elodin data directory.
RUN_CONFIG="$DB_PATH.toml"
if [[ -f "$RUN_CONFIG" ]]; then
  REPLAY_CONFIG_DIR="$(mktemp -d -t replay_config.XXXXXX)"
  cp "$RUN_CONFIG" "$REPLAY_CONFIG_DIR/config.toml"
  export CONFIG_PATH="$REPLAY_CONFIG_DIR/config.toml"
  echo "🧾 Decoding with the run's own config: $RUN_CONFIG"
else
  echo "⚠️  No $RUN_CONFIG (run predates config snapshots) — decoding with the deployed config"
fi
echo "📊 Starting Elodin DB on port $ELODIN_PORT (--replay = stream stored data as live telemetry)..."
RUST_LOG=warn "$ELODIN_DB_BIN" run "[::]:$ELODIN_PORT" "$DB_PATH" --replay > /tmp/elodin_db_replay.log 2>&1 &
ELODIN_PID=$!
sleep 2
if ! lsof -i:$ELODIN_PORT &>/dev/null 2>&1; then
  echo "❌ Elodin DB failed to start. Check /tmp/elodin_db_replay.log"
  kill $ELODIN_PID 2>/dev/null || true
  exit 1
fi
echo "   ✅ Elodin DB ready"

echo "📡 Starting Elodin relay..."
cd "$BACKEND_DIR"
if [[ ! -d "node_modules" ]]; then
  echo "📦 Installing backend dependencies..."
  npm install
fi
npm run relay &
RELAY_PID=$!
cd ..
sleep 3

echo "📡 Starting WebSocket server (REPLAY_MODE=1, sidecar disabled)..."
cd "$BACKEND_DIR"
REPLAY_MODE=1 ELODIN_RELAY_WS_URL=ws://localhost:9090 USE_DIRECT_DAQ=false npm run dev &
BACKEND_PID=$!
cd ..
sleep 2

echo "🌐 Starting frontend (Vite)..."
cd "$FRONTEND_DIR"
if [[ ! -d "node_modules" ]]; then
  echo "📦 Installing frontend dependencies..."
  npm install
fi
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ Replay GUI started — past DB: $DB_NAME"
echo "   📡 Relay: ws://localhost:9090"
echo "   📡 WebSocket: http://localhost:8081"
echo "   🌐 Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop all services."

trap 'echo "Stopping..."; kill $BACKEND_PID $FRONTEND_PID $RELAY_PID $ELODIN_PID 2>/dev/null; [[ -n "${REPLAY_CONFIG_DIR:-}" ]] && rm -r -- "$REPLAY_CONFIG_DIR"; exit' INT TERM
wait
