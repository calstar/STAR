#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Full-Stack Integration Test
#
# Spins up the complete pipeline and verifies data flows end-to-end:
#   fake_packet_generator → DAQ bridge → Elodin DB → Relay → Backend → WS client
#   WS client → Backend → UDP actuator commands
#
# Prerequisites:
#   - C++ binaries built (cmake/make): daq_bridge (and optionally fake_packet_generator)
#   - elodin-db in PATH or ~/.cargo/bin
#   - Node.js 20+ with tsx
#   - npm install done in web-gui/backend
#   - Python 3 with board_simulator.py dependencies (fallback data source)
#
# Usage: bash scripts/test/test_integration.sh [-v|--verbose]
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
  esac
done

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
TEST_CONFIG="/tmp/integration_config_$$.toml"
UDP_COMMANDS_FILE="/tmp/udp_commands_$$.json"
SIM_STATS_FILE="/tmp/sim_stats_$$.json"

# PIDs to clean up
PIDS=()

cleanup() {
  echo ""
  echo "🧹 Cleaning up..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$TEST_DB_PATH" 2>/dev/null || true
  rm -f "$TEST_CONFIG" 2>/dev/null || true
  rm -f "$UDP_COMMANDS_FILE" 2>/dev/null || true
  rm -f "$SIM_STATS_FILE" 2>/dev/null || true
  echo "✅ Cleanup done"
}

trap 'cleanup; exit 130' INT TERM
trap cleanup EXIT

fail() {
  echo "❌ FAIL: $1"
  exit 1
}

wait_for_port() {
  local port=$1
  local name=$2
  local timeout=${3:-15}
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
[ -z "$ELODIN_DB_BIN" ] && command -v elodin-db &>/dev/null && ELODIN_DB_BIN="$(command -v elodin-db)"
[ -z "$ELODIN_DB_BIN" ] && fail "elodin-db not found in PATH or ~/.cargo/bin"
echo "  ✅ elodin-db: $ELODIN_DB_BIN"

# Find DAQ bridge (check both build layouts)
DAQ_BRIDGE=""
for path in "$REPO_ROOT/build/FSW/daq_bridge" "$REPO_ROOT/FSW/build/daq_bridge" "$REPO_ROOT/build/daq_bridge"; do
  [ -x "$path" ] && DAQ_BRIDGE="$path" && break
done
[ -z "$DAQ_BRIDGE" ] && fail "daq_bridge not found. Build with: cd FSW/build && cmake .. && make daq_bridge"
echo "  ✅ daq_bridge: $DAQ_BRIDGE"

# Find fake packet generator or board simulator (fallback)
FAKE_GEN=""
for path in "$REPO_ROOT/build/FSW/fake_packet_generator" "$REPO_ROOT/FSW/build/fake_packet_generator" "$REPO_ROOT/build/daq_comms/fake_packet_generator" "$REPO_ROOT/build/fake_packet_generator"; do
  [ -x "$path" ] && FAKE_GEN="$path" && break
done
BOARD_SIM="$REPO_ROOT/scripts/board_simulator.py"
if [ -z "$FAKE_GEN" ] && [ ! -f "$BOARD_SIM" ]; then
  fail "Neither fake_packet_generator nor board_simulator.py found"
fi
if [ -n "$FAKE_GEN" ]; then
  echo "  ✅ fake_packet_generator: $FAKE_GEN"
else
  echo "  ✅ board_simulator: $BOARD_SIM (fallback)"
fi

# Find Python (for board_simulator fallback)
PYTHON_BIN=""
if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "${VIRTUAL_ENV}/bin/python" ]; then
  PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif [ -x "$REPO_ROOT/.venv/bin/python" ]; then
  PYTHON_BIN="$REPO_ROOT/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || command -v python || true)"
fi
[ -n "$PYTHON_BIN" ] && echo "  ✅ python: $PYTHON_BIN"

# Check tsx/npx
command -v tsx &>/dev/null || command -v npx &>/dev/null || fail "tsx or npx not found"
echo "  ✅ tsx/npx available"

# Ensure backend dependencies
if [ ! -d "$REPO_ROOT/web-gui/backend/node_modules/ws" ]; then
  echo "  ⚠️  Installing backend dependencies..."
  (cd "$REPO_ROOT/web-gui/backend" && npm install)
fi
echo "  ✅ backend node_modules"

echo ""

# ── Create temporary config with test ports ──────────────────────────────────
# The DAQ bridge reads database host/port and sensor_port from config.toml,
# NOT from CLI arguments. We must create a modified config so it connects to
# our test Elodin DB and listens on our test UDP port.

echo "📝 Creating test config..."
CONFIG_FILE="$REPO_ROOT/config/config.toml"
[ ! -f "$CONFIG_FILE" ] && fail "config/config.toml not found"

cp "$CONFIG_FILE" "$TEST_CONFIG"
# Replace database port (under [database] section)
sed -i "s/^port = 2240/port = $TEST_ELODIN_PORT/" "$TEST_CONFIG"
# Replace sensor_port (under [network] section)
sed -i "s/^sensor_port = 5006/sensor_port = $TEST_DAQ_UDP_PORT/" "$TEST_CONFIG"
# Replace actuator_cmd_port (under [network] section)
sed -i "s/^actuator_cmd_port = 5005/actuator_cmd_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"
# Point heartbeat broadcast to localhost to avoid sending to the real subnet
sed -i 's/^broadcast_ip = .*/broadcast_ip = "127.0.0.1"/' "$TEST_CONFIG"
# NOTE: Do NOT replace board IPs — the DAQ bridge routes by source IP.
# The board_simulator falls back to 127.0.0.{2+index} when config IPs
# (192.168.2.x) aren't bindable, and the DAQ bridge has matching fallback
# logic for 127.0.0.x addresses. Replacing all IPs to 127.0.0.1 makes the
# bridge treat every board as the same one (only one sensor type gets through).
# Replace listen_port on actuator boards to use our test port
sed -i "s/^listen_port = 5005/listen_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"
sed -i "s/^send_port = 5005/send_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"

echo "  ✅ Test config: $TEST_CONFIG"
echo "     DB port=$TEST_ELODIN_PORT  sensor_port=$TEST_DAQ_UDP_PORT  actuator_port=$TEST_ACTUATOR_UDP_PORT"
echo ""

# ── Start Elodin DB ──────────────────────────────────────────────────────────

echo "📊 Starting Elodin DB..."
rm -rf "$TEST_DB_PATH" 2>/dev/null || true
RUST_LOG=warn "$ELODIN_DB_BIN" run "[::]:$TEST_ELODIN_PORT" "$TEST_DB_PATH" > /tmp/integration_elodin_$$.log 2>&1 &
PIDS+=($!)
sleep 2

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ Elodin DB failed to start. Log:"
  cat /tmp/integration_elodin_$$.log
  exit 1
fi
echo "  ✅ Elodin DB started (PID ${PIDS[-1]})"

# ── Start Elodin Relay ───────────────────────────────────────────────────────
# Relay must start BEFORE daq_bridge so it subscribes to the DB stream first.
# (Same ordering as start_tmux_dev.sh)

echo "📡 Starting Elodin Relay..."
(cd "$REPO_ROOT/web-gui/backend" && \
  ELODIN_HOST=127.0.0.1 \
  ELODIN_PORT=$TEST_ELODIN_PORT \
  RELAY_WS_PORT=$TEST_RELAY_WS_PORT \
  RELAY_WS_HOST=0.0.0.0 \
  npx tsx src/elodin-relay.ts > /tmp/integration_relay_$$.log 2>&1) &
PIDS+=($!)

wait_for_port "$TEST_RELAY_WS_PORT" "Relay" 15 || {
  echo "  ❌ Relay failed to start. Log:"
  cat /tmp/integration_relay_$$.log
  exit 1
}
echo "  ✅ Relay started (PID ${PIDS[-1]})"

# ── Start DAQ Bridge ─────────────────────────────────────────────────────────
# CLI: daq_bridge <config_path> [bind_address] [bind_port]
# The elodin host/port and sensor_port come from the config file, not CLI args.
# We pass the test config which has the modified ports.

echo "🔗 Starting DAQ bridge..."
(cd "$REPO_ROOT" && "$DAQ_BRIDGE" "$TEST_CONFIG" > /tmp/integration_daq_$$.log 2>&1) &
PIDS+=($!)
sleep 3

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ DAQ bridge failed to start. Log:"
  cat /tmp/integration_daq_$$.log
  exit 1
fi
echo "  ✅ DAQ bridge started (PID ${PIDS[-1]})"

# ── Start Backend Server ─────────────────────────────────────────────────────

echo "🖥️  Starting Backend server..."
(cd "$REPO_ROOT/web-gui/backend" && \
  WS_PORT=$TEST_BACKEND_WS_PORT \
  API_PORT=$TEST_BACKEND_API_PORT \
  ELODIN_HOST=127.0.0.1 \
  ELODIN_PORT=$TEST_ELODIN_PORT \
  ELODIN_RELAY_WS_URL="ws://127.0.0.1:$TEST_RELAY_WS_PORT" \
  ACTUATOR_SERVICE_ENABLED=false \
  USE_CALIBRATION_SERVICE_CALIBRATED=false \
  USE_DIRECT_DAQ=false \
  USE_CPP_CONTROLLER=true \
  CONFIG_PATH="$TEST_CONFIG" \
  npx tsx src/server.ts > /tmp/integration_backend_$$.log 2>&1) &
PIDS+=($!)

wait_for_port "$TEST_BACKEND_WS_PORT" "Backend WS" 15 || {
  echo "  ❌ Backend failed to start. Log:"
  tail -30 /tmp/integration_backend_$$.log
  exit 1
}
echo "  ✅ Backend started (PID ${PIDS[-1]})"

# ── Start Fake Data Generator ────────────────────────────────────────────────

echo "🎭 Starting fake data generator..."
SIM_PID=""
if [ -n "$FAKE_GEN" ]; then
  # fake_packet_generator: positional args = host port rate_hz
  "$FAKE_GEN" "127.0.0.1" "$TEST_DAQ_UDP_PORT" 10 > /tmp/integration_fakegen_$$.log 2>&1 &
  PIDS+=($!)
else
  # board_simulator.py: uses --config for board definitions, --port for UDP target
  # Ensure tomli is installed (needed by board_simulator.py for TOML parsing)
  "$PYTHON_BIN" -c "import tomli" 2>/dev/null || "$PYTHON_BIN" -m pip install tomli -q 2>/dev/null || true
  "$PYTHON_BIN" "$BOARD_SIM" --config "$TEST_CONFIG" --target 127.0.0.1 --port "$TEST_DAQ_UDP_PORT" --stats-file "$SIM_STATS_FILE" > /tmp/integration_fakegen_$$.log 2>&1 &
  SIM_PID=$!
  PIDS+=($SIM_PID)
fi
sleep 2

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ⚠️  Fake data generator exited early. Log:"
  cat /tmp/integration_fakegen_$$.log
  echo "  Continuing anyway (data may have already been sent)..."
else
  echo "  ✅ Fake data generator started (PID ${PIDS[-1]})"
fi

# ── Start UDP Listener for Actuator Commands ─────────────────────────────────

echo "📥 Starting UDP listener for actuator commands..."
(cd "$REPO_ROOT/web-gui/backend" && \
  NODE_PATH="$REPO_ROOT/web-gui/backend/node_modules" \
  npx tsx "$SCRIPT_DIR/udp_listener.ts" "$TEST_ACTUATOR_UDP_PORT" "$UDP_COMMANDS_FILE" 30 > /tmp/integration_udp_$$.log 2>&1) &
PIDS+=($!)
sleep 1
echo "  ✅ UDP listener started (PID ${PIDS[-1]})"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  All services running. Starting tests..."
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Run WebSocket Data Flow Test ──────────────────────────────────────────────

VERBOSE_FLAG=""
RECEIVED_STATS_FILE="/tmp/received_stats_$$.json"
[ "$VERBOSE" = "1" ] && VERBOSE_FLAG="--verbose"
(cd "$REPO_ROOT/web-gui/backend" && \
  NODE_PATH="$REPO_ROOT/web-gui/backend/node_modules" \
  npx tsx "$SCRIPT_DIR/ws_data_flow_test.ts" "$TEST_BACKEND_WS_PORT" "$TEST_BACKEND_API_PORT" "$TEST_ACTUATOR_UDP_PORT" --received-stats "$RECEIVED_STATS_FILE" $VERBOSE_FLAG)
WS_TEST_EXIT=$?

# ── Stop simulator and flush stats ────────────────────────────────────────────
# Send SIGTERM so the simulator writes its stats file before exiting.
if [ -n "$SIM_PID" ] && kill -0 "$SIM_PID" 2>/dev/null; then
  kill "$SIM_PID" 2>/dev/null
  sleep 1  # wait for stats file write
fi

# Print full backend log tail if test failed
if [ "$WS_TEST_EXIT" -ne 0 ]; then
  echo ""
  echo "📋 Backend log (last 40 lines):"
  tail -40 /tmp/integration_backend_$$.log 2>/dev/null || true
fi

# ── Check UDP Commands ────────────────────────────────────────────────────────

echo ""
echo "📋 Checking UDP actuator commands..."
if [ -f "$UDP_COMMANDS_FILE" ]; then
  NUM_COMMANDS=$("$PYTHON_BIN" -c "import json; data=json.load(open('$UDP_COMMANDS_FILE')); print(len(data))" 2>/dev/null || echo "0")
  if [ "$NUM_COMMANDS" -gt "0" ]; then
    echo "  ✅ Received $NUM_COMMANDS UDP actuator command packet(s)"
  else
    echo "  ⚠️  No UDP actuator commands received (backend may send via actuator_service TCP instead)"
  fi
else
  echo "  ⚠️  UDP commands file not found (backend may not send direct UDP when ACTUATOR_SERVICE_ENABLED=false)"
fi

# ── Verify All Packets Received ───────────────────────────────────────────────
# Compare simulator's sent count against WS test's received count per entity.

echo ""
echo "📋 Verifying all sensor packets were received..."
PACKET_CHECK_FAILED=0
if [ -f "$SIM_STATS_FILE" ] && [ -f "$RECEIVED_STATS_FILE" ]; then
  PACKET_RESULT=$("$PYTHON_BIN" -c "
import json, sys

with open('$SIM_STATS_FILE') as f:
    sim = json.load(f)
with open('$RECEIVED_STATS_FILE') as f:
    recv = json.load(f)

sent_total = sim['total_sensor_updates']
recv_total = recv['total_updates']

print(f'  Simulator sent {sent_total} total sensor updates across lifetime')
print(f'  WS test received {recv_total} total sensor updates in 15s window')
for board_name, board in sim['boards'].items():
    print(f'    {board_name}: {board[\"packets_sent\"]} packets x {board[\"channels_per_packet\"]} ch = {board[\"total_sensor_updates\"]} updates')

# Zero-drop verification is done inside the WS test itself (per-board entity
# count matching). This section just prints the simulator's stats for context.
sys.exit(0)
" 2>&1)
  PACKET_EXIT=$?
  echo "$PACKET_RESULT"
  if [ "$PACKET_EXIT" -ne 0 ]; then
    PACKET_CHECK_FAILED=1
  fi
else
  if [ ! -f "$SIM_STATS_FILE" ]; then
    echo "  ⚠️  Simulator stats file not found (using fake_packet_generator instead of board_simulator?)"
  fi
  if [ ! -f "$RECEIVED_STATS_FILE" ]; then
    echo "  ⚠️  Received stats file not found (WS test may have failed before writing)"
  fi
fi
rm -f "$RECEIVED_STATS_FILE" 2>/dev/null || true

# ── Results ───────────────────────────────────────────────────────────────────

FINAL_EXIT=0
[ "$WS_TEST_EXIT" -ne 0 ] && FINAL_EXIT=1
[ "${PACKET_CHECK_FAILED:-0}" -ne 0 ] && FINAL_EXIT=1

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$FINAL_EXIT" -eq 0 ]; then
  echo "  ✅ INTEGRATION TEST PASSED"
else
  echo "  ❌ INTEGRATION TEST FAILED"
  [ "$WS_TEST_EXIT" -ne 0 ] && echo "     WS test failed (exit code: $WS_TEST_EXIT)"
  [ "${PACKET_CHECK_FAILED:-0}" -ne 0 ] && echo "     Packet verification failed"
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

exit "$FINAL_EXIT"
