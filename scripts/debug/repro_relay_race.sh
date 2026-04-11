#!/bin/bash
# Reproduction script for the Elodin Relay resubscription race condition.
# This script intentionally delays the DAQ Bridge to test if the Relay
# recovers after several failed subscription attempts.
#
# Usage: bash scripts/debug/repro_relay_race.sh

PROJECT="/home/aidan/Diablo-FSW"
mkdir -p /tmp/race_logs
DB_DIR="/tmp/race_db"
rm -rf "$DB_DIR" 2>/dev/null || true

# 1. Start Elodin DB
echo "🚀 Starting Elodin DB..."
/home/aidan/.cargo/bin/elodin-db run '[::]:2240' "$DB_DIR" > /tmp/race_logs/db.log 2>&1 &
DB_PID=$!
sleep 2

# 2. Start Relay
echo "🚀 Starting Relay (will start retrying every 5s)..."
cd "$PROJECT/web-gui/backend"
npm run relay > /tmp/race_logs/relay.log 2>&1 &
RELAY_PID=$!
sleep 2

# 3. Start Backend
echo "🚀 Starting Thin Backend..."
WS_PORT=8083 ELODIN_RELAY_URL=ws://localhost:9090 ACTUATOR_SERVICE_PORT=9998 npx tsx watch src/server.ts > /tmp/race_logs/backend.log 2>&1 &
BACKEND_PID=$!

echo "⏳ Waiting 130 seconds for Relay to exceed its initial 2-minute threshold (24 attempts)..."
sleep 130

# 4. Start DAQ Bridge
echo "🚀 Starting DAQ Bridge NOW (Should trigger recovery in the Relay)..."
cd "$PROJECT"
./build/FSW/daq_bridge config/config.toml > /tmp/race_logs/daq.log 2>&1 &
DAQ_PID=$!
sleep 2

# 5. Start Simulator
echo "🚀 Starting Board Simulator..."
./.venv/bin/python scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 > /tmp/race_logs/sim.log 2>&1 &
SIM_PID=$!

echo "⏳ Waiting 20 seconds to see if data flows..."
sleep 20

tail -n 10 /tmp/race_logs/relay.log
echo "---"
curl -s http://127.0.0.1:8083/stats | jq . || echo "Backend check failed"

# Cleanup
echo "🧹 Cleaning up..."
kill $DB_PID $RELAY_PID $BACKEND_PID $DAQ_PID $SIM_PID
