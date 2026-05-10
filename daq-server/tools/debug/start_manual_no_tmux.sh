#!/bin/bash
# Diagnostic script to start the core Elodin dev stack without tmux.
# Usage: USE_SIM=1 bash scripts/debug/start_manual_no_tmux.sh

PROJECT="/home/aidan/Diablo-FSW"
mkdir -p /tmp/manual_logs
DB_DIR="/tmp/manual_db"
rm -rf "$DB_DIR" 2>/dev/null || true

# 1. Start Elodin DB
echo "🚀 Starting Elodin DB..."
/home/aidan/.cargo/bin/elodin-db run '[::]:2240' "$DB_DIR" > /tmp/manual_logs/db.log 2>&1 &
DB_PID=$!
sleep 2

# 2. Start Relay
echo "🚀 Starting Relay..."
cd "$PROJECT/diablo_server/backend"
npm run relay > /tmp/manual_logs/relay.log 2>&1 &
RELAY_PID=$!
sleep 2

# 3. Start Backend
echo "🚀 Starting Thin Backend..."
WS_PORT=8081 ELODIN_RELAY_URL=ws://localhost:9090 ACTUATOR_SERVICE_PORT=9998 npx tsx watch src/server.ts > /tmp/manual_logs/backend.log 2>&1 &
BACKEND_PID=$!
sleep 5

# 4. Start DAQ Bridge
echo "🚀 Starting DAQ Bridge..."
cd "$PROJECT"
./build/FSW/daq_bridge config/config.toml > /tmp/manual_logs/daq.log 2>&1 &
DAQ_PID=$!
sleep 10

# 5. Simulator (Optional)
if [ "${USE_SIM:-0}" = "1" ]; then
    echo "🚀 Starting Board Simulator..."
    ./.venv/bin/python sim/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 > /tmp/manual_logs/sim.log 2>&1 &
    SIM_PID=$!
fi

echo "---"
echo "All services started. Logs at /tmp/manual_logs/"
echo "PIDs: $DB_PID $RELAY_PID $BACKEND_PID $DAQ_PID $SIM_PID"
echo "---"
echo "Press Ctrl+C to stop all services."

# Trap Ctrl+C to stop all services
trap "kill $DB_PID $RELAY_PID $BACKEND_PID $DAQ_PID $SIM_PID; exit" INT
wait
