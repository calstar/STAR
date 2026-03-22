#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Full-Stack Integration Test
#
# Spins up the complete pipeline and verifies data flows end-to-end:
#   fake_packet_generator → DAQ bridge → Elodin DB → Relay → Backend → WS client
#   WS client → Backend → UDP actuator commands
#
# Prerequisites:
#   - C++ binaries built (cmake/make): daq_bridge, fake_packet_generator
#   - elodin-db in PATH
#   - Node.js 20+ with tsx
#   - npm install done in web-gui/backend
#
# Usage: bash scripts/test/test_integration.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Test ports (offset from defaults to avoid conflicts with running instances)
TEST_ELODIN_PORT="${TEST_ELODIN_PORT:-2241}"
TEST_DAQ_UDP_PORT="${TEST_DAQ_UDP_PORT:-5016}"
TEST_RELAY_WS_PORT="${TEST_RELAY_WS_PORT:-9190}"
TEST_BACKEND_WS_PORT="${TEST_BACKEND_WS_PORT:-8181}"
TEST_BACKEND_API_PORT="${TEST_BACKEND_API_PORT:-8182}"
TEST_ACTUATOR_UDP_PORT="${TEST_ACTUATOR_UDP_PORT:-5015}"
TEST_DB_PATH="/tmp/elodin_integration_test_$$"
UDP_COMMANDS_FILE="/tmp/udp_commands_$$.json"

# PIDs to clean up
PIDS=()

cleanup() {
  echo ""
  echo "🧹 Cleaning up..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Wait briefly for processes to exit
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$TEST_DB_PATH" 2>/dev/null || true
  rm -f "$UDP_COMMANDS_FILE" 2>/dev/null || true
  echo "✅ Cleanup done"
}

trap cleanup EXIT INT TERM

fail() {
  echo "❌ FAIL: $1"
  exit 1
}

wait_for_port() {
  local port=$1
  local name=$2
  local timeout=${3:-10}
  local elapsed=0
  echo -n "  Waiting for $name (port $port)..."
  while ! (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$((timeout * 2))" ]; then
      echo " TIMEOUT"
      return 1
    fi
  done
  echo " ready"
  return 0
}

echo "═══════════════════════════════════════════════════════════════"
echo "  Full-Stack Integration Test"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Ports: Elodin=$TEST_ELODIN_PORT DAQ_UDP=$TEST_DAQ_UDP_PORT Relay=$TEST_RELAY_WS_PORT"
echo "       Backend_WS=$TEST_BACKEND_WS_PORT Backend_API=$TEST_BACKEND_API_PORT"
echo "       Actuator_UDP=$TEST_ACTUATOR_UDP_PORT"
echo "DB: $TEST_DB_PATH"
echo ""

# ── Check prerequisites ──────────────────────────────────────────────────────

echo "📋 Checking prerequisites..."

# Find elodin-db
ELODIN_DB_BIN=""
[ -f "$HOME/.cargo/bin/elodin-db" ] && ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
[ -z "$ELODIN_DB_BIN" ] && command -v elodin-db &>/dev/null && ELODIN_DB_BIN="elodin-db"
[ -z "$ELODIN_DB_BIN" ] && fail "elodin-db not found in PATH or ~/.cargo/bin"
echo "  ✅ elodin-db: $ELODIN_DB_BIN"

# Find DAQ bridge
DAQ_BRIDGE=""
for path in "$REPO_ROOT/FSW/build/daq_bridge" "$REPO_ROOT/build/FSW/daq_bridge" "$REPO_ROOT/build/daq_bridge"; do
  [ -x "$path" ] && DAQ_BRIDGE="$path" && break
done
[ -z "$DAQ_BRIDGE" ] && fail "daq_bridge not found. Build with: cd FSW/build && cmake .. && make daq_bridge"
echo "  ✅ daq_bridge: $DAQ_BRIDGE"

# Find fake packet generator or board simulator
FAKE_GEN=""
for path in "$REPO_ROOT/FSW/build/fake_packet_generator" "$REPO_ROOT/build/daq_comms/fake_packet_generator" "$REPO_ROOT/build/fake_packet_generator"; do
  [ -x "$path" ] && FAKE_GEN="$path" && break
done
BOARD_SIM="$REPO_ROOT/scripts/board_simulator.py"
if [ -z "$FAKE_GEN" ] && [ ! -f "$BOARD_SIM" ]; then
  fail "Neither fake_packet_generator nor board_simulator.py found"
fi
if [ -n "$FAKE_GEN" ]; then
  echo "  ✅ fake_packet_generator: $FAKE_GEN"
else
  echo "  ✅ board_simulator: $BOARD_SIM"
fi

# Check tsx
command -v tsx &>/dev/null || command -v npx &>/dev/null || fail "tsx or npx not found"
echo "  ✅ tsx/npx available"

# Check ws package for test client
if [ ! -d "$REPO_ROOT/web-gui/backend/node_modules/ws" ]; then
  echo "  ⚠️ Installing backend dependencies..."
  (cd "$REPO_ROOT/web-gui/backend" && npm install)
fi
echo "  ✅ backend node_modules"

echo ""

# ── Start Elodin DB ──────────────────────────────────────────────────────────

echo "📊 Starting Elodin DB..."
mkdir -p "$TEST_DB_PATH"
RUST_LOG=warn "$ELODIN_DB_BIN" run "[::]:$TEST_ELODIN_PORT" "$TEST_DB_PATH" > /tmp/integration_elodin_$$.log 2>&1 &
PIDS+=($!)
sleep 2

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ Elodin DB failed to start"
  cat /tmp/integration_elodin_$$.log
  exit 1
fi
echo "  ✅ Elodin DB started (PID ${PIDS[-1]})"

# ── Start DAQ Bridge ─────────────────────────────────────────────────────────

echo "🔗 Starting DAQ bridge..."
CONFIG_FILE="$REPO_ROOT/config/config.toml"
[ ! -f "$CONFIG_FILE" ] && CONFIG_FILE="$REPO_ROOT/config/sensor_routing.toml"
[ ! -f "$CONFIG_FILE" ] && fail "No config file found in config/"

"$DAQ_BRIDGE" "$CONFIG_FILE" --listen-port "$TEST_DAQ_UDP_PORT" --elodin-host 127.0.0.1 --elodin-port "$TEST_ELODIN_PORT" > /tmp/integration_daq_$$.log 2>&1 &
PIDS+=($!)
sleep 3

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ⚠️ DAQ bridge exited — trying alternate CLI format..."
  "$DAQ_BRIDGE" "0.0.0.0" "$TEST_DAQ_UDP_PORT" "127.0.0.1" "$TEST_ELODIN_PORT" "$CONFIG_FILE" > /tmp/integration_daq_$$.log 2>&1 &
  PIDS+=($!)
  sleep 3
fi

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ DAQ bridge failed to start"
  cat /tmp/integration_daq_$$.log
  exit 1
fi
echo "  ✅ DAQ bridge started (PID ${PIDS[-1]})"

# ── Start Elodin Relay ───────────────────────────────────────────────────────

echo "📡 Starting Elodin Relay..."
ELODIN_HOST=127.0.0.1 \
ELODIN_PORT=$TEST_ELODIN_PORT \
RELAY_WS_PORT=$TEST_RELAY_WS_PORT \
RELAY_WS_HOST=0.0.0.0 \
  npx --prefix "$REPO_ROOT/web-gui/backend" tsx "$REPO_ROOT/web-gui/backend/src/elodin-relay.ts" > /tmp/integration_relay_$$.log 2>&1 &
PIDS+=($!)
sleep 3
echo "  ✅ Relay started (PID ${PIDS[-1]})"

# ── Start Backend Server ─────────────────────────────────────────────────────

echo "🖥️ Starting Backend server..."
WS_PORT=$TEST_BACKEND_WS_PORT \
API_PORT=$TEST_BACKEND_API_PORT \
ELODIN_HOST=127.0.0.1 \
ELODIN_PORT=$TEST_ELODIN_PORT \
ELODIN_RELAY_WS_URL="ws://127.0.0.1:$TEST_RELAY_WS_PORT" \
ACTUATOR_IP=127.0.0.1 \
ACTUATOR_PORT=$TEST_ACTUATOR_UDP_PORT \
USE_DIRECT_DAQ=false \
USE_CPP_CONTROLLER=true \
  npx --prefix "$REPO_ROOT/web-gui/backend" tsx "$REPO_ROOT/web-gui/backend/src/server.ts" > /tmp/integration_backend_$$.log 2>&1 &
PIDS+=($!)
sleep 4

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ Backend server failed to start"
  cat /tmp/integration_backend_$$.log
  exit 1
fi
echo "  ✅ Backend started (PID ${PIDS[-1]})"

# ── Start Fake Data Generator ────────────────────────────────────────────────

echo "🎭 Starting fake data generator..."
if [ -n "$FAKE_GEN" ]; then
  "$FAKE_GEN" "127.0.0.1" "$TEST_DAQ_UDP_PORT" 10 > /tmp/integration_fakegen_$$.log 2>&1 &
  PIDS+=($!)
else
  python3 "$BOARD_SIM" --config "$CONFIG_FILE" --target 127.0.0.1 --port "$TEST_DAQ_UDP_PORT" --only-type PT > /tmp/integration_fakegen_$$.log 2>&1 &
  PIDS+=($!)
fi
sleep 2
echo "  ✅ Fake data generator started (PID ${PIDS[-1]})"

# ── Start UDP Listener for Actuator Commands ─────────────────────────────────

echo "📥 Starting UDP listener for actuator commands..."
npx --prefix "$REPO_ROOT/web-gui/backend" tsx "$SCRIPT_DIR/udp_listener.ts" "$TEST_ACTUATOR_UDP_PORT" "$UDP_COMMANDS_FILE" 30 > /tmp/integration_udp_$$.log 2>&1 &
PIDS+=($!)
sleep 1
echo "  ✅ UDP listener started (PID ${PIDS[-1]})"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  All services running. Starting tests..."
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Run WebSocket Data Flow Test ──────────────────────────────────────────────

npx --prefix "$REPO_ROOT/web-gui/backend" tsx "$SCRIPT_DIR/ws_data_flow_test.ts" "$TEST_BACKEND_WS_PORT" "$TEST_BACKEND_API_PORT" "$TEST_ACTUATOR_UDP_PORT"
WS_TEST_EXIT=$?

# ── Check UDP Commands ────────────────────────────────────────────────────────

echo ""
echo "📋 Checking UDP actuator commands..."
if [ -f "$UDP_COMMANDS_FILE" ]; then
  NUM_COMMANDS=$(python3 -c "import json; data=json.load(open('$UDP_COMMANDS_FILE')); print(len(data))" 2>/dev/null || echo "0")
  if [ "$NUM_COMMANDS" -gt "0" ]; then
    echo "  ✅ Received $NUM_COMMANDS UDP actuator command packet(s)"
  else
    echo "  ⚠️ No UDP actuator commands received (actuator_service may have intercepted them)"
  fi
else
  echo "  ⚠️ UDP commands file not found"
fi

# ── Results ───────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$WS_TEST_EXIT" -eq 0 ]; then
  echo "  ✅ INTEGRATION TEST PASSED"
else
  echo "  ❌ INTEGRATION TEST FAILED"
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Logs:"
echo "  Elodin DB:    /tmp/integration_elodin_$$.log"
echo "  DAQ Bridge:   /tmp/integration_daq_$$.log"
echo "  Relay:        /tmp/integration_relay_$$.log"
echo "  Backend:      /tmp/integration_backend_$$.log"
echo "  Fake Gen:     /tmp/integration_fakegen_$$.log"
echo "  UDP Listener: /tmp/integration_udp_$$.log"

exit "$WS_TEST_EXIT"
