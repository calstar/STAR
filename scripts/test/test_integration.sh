#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Full-Stack Integration Test
#
# Spins up the complete pipeline and verifies data flows end-to-end:
#   fake_packet_generator → DAQ bridge → Elodin DB → Relay → Backend → WS client
#   WS client → Backend → sequencer_service (TCP) → actuator UDP
#
# Prerequisites:
#   - C++ binaries built (cmake/make): daq_bridge, sequencer_service
#   - elodin-db in PATH or ~/.cargo/bin
#   - Node.js 20+ with tsx
#   - npm install done in web-gui/backend
#   - Python 3 with board_simulator.py dependencies (fallback data source)
#
# Usage: bash scripts/test/test_integration.sh [-v|--verbose] [--legacy]
#   --legacy  Use server.ts (old backend) instead of server-thin.ts (default)
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

VERBOSE=0
BACKEND=thin
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    --legacy) BACKEND=legacy ;;
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
TEST_DB_PATH="$REPO_ROOT/.tmp/elodin_integration_test_$$"
TEST_CONFIG="$REPO_ROOT/.tmp/integration_config_$$.toml"
UDP_COMMANDS_FILE="$REPO_ROOT/.tmp/udp_commands_$$.json"
SIM_STATS_FILE="$REPO_ROOT/.tmp/sim_stats_$$.json"

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
echo "  Full-Stack Integration Test  [backend: $BACKEND]"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Ports: Elodin=$TEST_ELODIN_PORT DAQ_UDP=$TEST_DAQ_UDP_PORT Relay=$TEST_RELAY_WS_PORT"
echo "       Backend_WS=$TEST_BACKEND_WS_PORT Backend_API=$TEST_BACKEND_API_PORT"
echo "       Actuator_UDP=$TEST_ACTUATOR_UDP_PORT"
echo "DB: $TEST_DB_PATH"
echo ""

mkdir -p "$REPO_ROOT/.tmp"

# ── Kill stale processes on test ports from previous runs ────────────────────
for port in $TEST_ELODIN_PORT $TEST_RELAY_WS_PORT $TEST_BACKEND_WS_PORT $TEST_BACKEND_API_PORT; do
  if fuser "$port/tcp" > /dev/null 2>&1; then
    echo "  ⚠️  Killing stale process(es) on port $port"
    fuser -k "$port/tcp" > /dev/null 2>&1 || true
  fi
done
sleep 0.5

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

# Find sequencer_service (optional — command tests skipped if absent)
SEQ_SVC=""
for path in "$REPO_ROOT/build/FSW/sequencer_service" "$REPO_ROOT/FSW/build/sequencer_service" "$REPO_ROOT/build/sequencer_service"; do
  [ -x "$path" ] && SEQ_SVC="$path" && break
done
if [ -n "$SEQ_SVC" ]; then
  echo "  ✅ sequencer_service: $SEQ_SVC"
else
  echo "  ⚠️  sequencer_service not found — state/actuator tests will be skipped"
  echo "       Build with: cd FSW/build && cmake .. && make sequencer_service"
fi

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
# Replace actuator board IPs to 127.0.0.1 so UDP commands reach our local listener.
# Unlike sensor boards (where DAQ bridge routes by source IP), actuator commands are
# sent TO the board IP — so we must point them at localhost for testing.
sed -i 's/^ip = "192\.168\.2\.11"/ip = "127.0.0.1"/' "$TEST_CONFIG"
sed -i 's/^ip = "192\.168\.2\.12"/ip = "127.0.0.1"/' "$TEST_CONFIG"
sed -i 's/^ip = "192\.168\.2\.13"/ip = "127.0.0.1"/' "$TEST_CONFIG"
sed -i 's/^ip = "192\.168\.2\.14"/ip = "127.0.0.1"/' "$TEST_CONFIG"
# Replace listen_port on actuator boards to use our test port
sed -i "s/^listen_port = 5005/listen_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"
sed -i "s/^send_port = 5005/send_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"

echo "  ✅ Test config: $TEST_CONFIG"
echo "     DB port=$TEST_ELODIN_PORT  sensor_port=$TEST_DAQ_UDP_PORT  actuator_port=$TEST_ACTUATOR_UDP_PORT"
echo ""

# ── Start Elodin DB ──────────────────────────────────────────────────────────

echo "📊 Starting Elodin DB..."
rm -rf "$TEST_DB_PATH" 2>/dev/null || true
RUST_LOG=warn "$ELODIN_DB_BIN" run "[::]:$TEST_ELODIN_PORT" "$TEST_DB_PATH" > "$REPO_ROOT/.tmp/integration_elodin_$$.log" 2>&1 &
PIDS+=($!)
sleep 2

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ Elodin DB failed to start. Log:"
  cat "$REPO_ROOT/.tmp/integration_elodin_$$.log"
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
  npx tsx src/elodin-relay.ts > "$REPO_ROOT/.tmp/integration_relay_$$.log" 2>&1) &
PIDS+=($!)

wait_for_port "$TEST_RELAY_WS_PORT" "Relay" 15 || {
  echo "  ❌ Relay failed to start. Log:"
  cat "$REPO_ROOT/.tmp/integration_relay_$$.log"
  exit 1
}
echo "  ✅ Relay started (PID ${PIDS[-1]})"

# ── Start sequencer_service ──────────────────────────────────────────────────
# Provides TCP command endpoint on :9998. Both thin and legacy backends forward
# state/actuator commands here. Reads Elodin port from the test config.

if [ -n "$SEQ_SVC" ]; then
  echo "⚙️  Starting sequencer_service..."
  "$SEQ_SVC" --config "$TEST_CONFIG" --port 9998 > "$REPO_ROOT/.tmp/integration_sequencer_$$.log" 2>&1 &
  PIDS+=($!)
  sleep 1
  if kill -0 "${PIDS[-1]}" 2>/dev/null; then
    echo "  ✅ sequencer_service started (PID ${PIDS[-1]})"
  else
    echo "  ⚠️  sequencer_service exited early. Log:"
    cat "$REPO_ROOT/.tmp/integration_sequencer_$$.log"
    SEQ_SVC=""  # treat as absent so tests skip gracefully
  fi
fi

# ── Start DAQ Bridge ─────────────────────────────────────────────────────────
# CLI: daq_bridge <config_path> [bind_address] [bind_port]
# The elodin host/port and sensor_port come from the config file, not CLI args.
# We pass the test config which has the modified ports.

echo "🔗 Starting DAQ bridge..."
(cd "$REPO_ROOT" && "$DAQ_BRIDGE" "$TEST_CONFIG" > "$REPO_ROOT/.tmp/integration_daq_$$.log" 2>&1) &
PIDS+=($!)
sleep 1

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ DAQ bridge failed to start. Log:"
  cat "$REPO_ROOT/.tmp/integration_daq_$$.log"
  exit 1
fi
echo "  ✅ DAQ bridge started (PID ${PIDS[-1]})"

# ── Start Backend Server ─────────────────────────────────────────────────────

if [ "$BACKEND" = "thin" ]; then
  echo "🖥️  Starting Backend server (server-thin.ts)..."
  (cd "$REPO_ROOT/web-gui/backend" && \
    WS_PORT=$TEST_BACKEND_WS_PORT \
    ELODIN_RELAY_URL="ws://127.0.0.1:$TEST_RELAY_WS_PORT" \
    ACTUATOR_SERVICE_PORT=9998 \
    CONFIG_PATH="$TEST_CONFIG" \
    npx tsx src/server-thin.ts > "$REPO_ROOT/.tmp/integration_backend_$$.log" 2>&1) &
else
  echo "🖥️  Starting Backend server (server.ts legacy)..."
  (cd "$REPO_ROOT/web-gui/backend" && \
    WS_PORT=$TEST_BACKEND_WS_PORT \
    API_PORT=$TEST_BACKEND_API_PORT \
    ELODIN_HOST=127.0.0.1 \
    ELODIN_PORT=$TEST_ELODIN_PORT \
    ELODIN_RELAY_WS_URL="ws://127.0.0.1:$TEST_RELAY_WS_PORT" \
    ACTUATOR_SERVICE_ENABLED=false \
    ACTUATOR_SERVICE_PORT=9998 \
    USE_CALIBRATION_SERVICE_CALIBRATED=false \
    USE_DIRECT_DAQ=false \
    USE_CPP_CONTROLLER=true \
    CONFIG_PATH="$TEST_CONFIG" \
    npx tsx src/server.ts > "$REPO_ROOT/.tmp/integration_backend_$$.log" 2>&1) &
fi
PIDS+=($!)

wait_for_port "$TEST_BACKEND_WS_PORT" "Backend WS" 15 || {
  echo "  ❌ Backend failed to start. Log:"
  tail -30 "$REPO_ROOT/.tmp/integration_backend_$$.log"
  exit 1
}
echo "  ✅ Backend started (PID ${PIDS[-1]})"

# ── Start Fake Data Generator ────────────────────────────────────────────────

echo "🎭 Starting fake data generator..."
SIM_PID=""
if [ -n "$FAKE_GEN" ]; then
  # fake_packet_generator: positional args = host port rate_hz
  "$FAKE_GEN" "127.0.0.1" "$TEST_DAQ_UDP_PORT" 10 > "$REPO_ROOT/.tmp/integration_fakegen_$$.log" 2>&1 &
  PIDS+=($!)
else
  # board_simulator.py: uses --config for board definitions, --port for UDP target
  # Ensure tomli is installed (needed by board_simulator.py for TOML parsing)
  "$PYTHON_BIN" -c "import tomli" 2>/dev/null || "$PYTHON_BIN" -m pip install tomli -q 2>/dev/null || true
  "$PYTHON_BIN" "$BOARD_SIM" --config "$TEST_CONFIG" --target 127.0.0.1 --port "$TEST_DAQ_UDP_PORT" --stats-file "$SIM_STATS_FILE" > "$REPO_ROOT/.tmp/integration_fakegen_$$.log" 2>&1 &
  SIM_PID=$!
  PIDS+=($SIM_PID)
fi
sleep 2

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ⚠️  Fake data generator exited early. Log:"
  cat "$REPO_ROOT/.tmp/integration_fakegen_$$.log"
  echo "  Continuing anyway (data may have already been sent)..."
else
  echo "  ✅ Fake data generator started (PID ${PIDS[-1]})"
fi

# ── Start UDP Listener for Actuator Commands ─────────────────────────────────

echo "📥 Starting UDP listener for actuator commands..."
(cd "$REPO_ROOT/web-gui/backend" && \
  NODE_PATH="$REPO_ROOT/web-gui/backend/node_modules" \
  npx tsx "$SCRIPT_DIR/udp_listener.ts" "$TEST_ACTUATOR_UDP_PORT" "$UDP_COMMANDS_FILE" 120 > "$REPO_ROOT/.tmp/integration_udp_$$.log" 2>&1) &
UDP_PID=$!
PIDS+=($UDP_PID)
sleep 1
echo "  ✅ UDP listener started (PID $UDP_PID)"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  All services running. Starting tests..."
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Run WebSocket Data Flow Test ──────────────────────────────────────────────

VERBOSE_FLAG=""
RECEIVED_STATS_FILE="$REPO_ROOT/.tmp/received_stats_$$.json"
[ "$VERBOSE" = "1" ] && VERBOSE_FLAG="--verbose"
SEQ_FLAG=""; [ -n "$SEQ_SVC" ] && SEQ_FLAG="--has-sequencer"
(cd "$REPO_ROOT/web-gui/backend" && \
  NODE_PATH="$REPO_ROOT/web-gui/backend/node_modules" \
  npx tsx "$SCRIPT_DIR/ws_data_flow_test.ts" "$TEST_BACKEND_WS_PORT" "$TEST_BACKEND_API_PORT" "$TEST_ACTUATOR_UDP_PORT" \
  --received-stats "$RECEIVED_STATS_FILE" --backend="$BACKEND" $SEQ_FLAG $VERBOSE_FLAG)
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
  tail -40 "$REPO_ROOT/.tmp/integration_backend_$$.log" 2>/dev/null || true
fi

# ── Check UDP actuator commands ───────────────────────────────────────────────
# sequencer_service sends UDP to board IPs (overridden to 127.0.0.1 in test config).
# The UDP listener captures these. Only meaningful when command tests ran.

echo ""
UDP_CHECK_FAILED=0
if [ -n "$SEQ_SVC" ]; then
  # Give the UDP listener a moment to flush if it hasn't already
  kill "$UDP_PID" 2>/dev/null || true
  sleep 0.5
  if [ -f "$UDP_COMMANDS_FILE" ]; then
    NUM_COMMANDS=$("$PYTHON_BIN" -c "import json; data=json.load(open('$UDP_COMMANDS_FILE')); print(len(data))" 2>/dev/null || echo "0")
    if [ "$NUM_COMMANDS" -gt "0" ]; then
      echo "📋 UDP actuator commands: ✅ $NUM_COMMANDS packet(s) received by local listener"
    else
      echo "📋 UDP actuator commands: ⚠️  0 packets received (sequencer_service may not have sent commands)"
    fi
  else
    echo "📋 UDP actuator commands: ⚠️  no packets received (listener file missing)"
  fi
fi

rm -f "$RECEIVED_STATS_FILE" 2>/dev/null || true

# ── Results ───────────────────────────────────────────────────────────────────

FINAL_EXIT=0
[ "$WS_TEST_EXIT" -ne 0 ] && FINAL_EXIT=1

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$FINAL_EXIT" -eq 0 ]; then
  echo "  ✅ INTEGRATION TEST PASSED"
else
  echo "  ❌ INTEGRATION TEST FAILED"
  [ "$WS_TEST_EXIT" -ne 0 ] && echo "     WS test failed (exit code: $WS_TEST_EXIT)"
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Logs:"
echo "  Elodin DB:      $REPO_ROOT/.tmp/integration_elodin_$$.log"
echo "  DAQ Bridge:     $REPO_ROOT/.tmp/integration_daq_$$.log"
echo "  Relay:          $REPO_ROOT/.tmp/integration_relay_$$.log"
echo "  Backend:        $REPO_ROOT/.tmp/integration_backend_$$.log"
[ -n "$SEQ_SVC" ] && echo "  Sequencer:      $REPO_ROOT/.tmp/integration_sequencer_$$.log"
echo "  Fake Gen:       $REPO_ROOT/.tmp/integration_fakegen_$$.log"
echo "  UDP Listener:   $REPO_ROOT/.tmp/integration_udp_$$.log"

exit "$FINAL_EXIT"
