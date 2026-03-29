#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Full-Stack Integration Test
#
# Spins up the complete pipeline and verifies data flows end-to-end:
#   fake_packet_generator → DAQ bridge → Elodin DB → Backend → WS client
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
#   --legacy  Use server-legacy.ts (old monolithic backend) instead of server.ts (default)
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
TEST_BACKEND_WS_PORT="${TEST_BACKEND_WS_PORT:-8181}"
TEST_BACKEND_API_PORT="${TEST_BACKEND_API_PORT:-8182}"
TEST_ACTUATOR_UDP_PORT="${TEST_ACTUATOR_UDP_PORT:-5015}"
TEST_STARTUP_LISTEN_PORT="${TEST_STARTUP_LISTEN_PORT:-5014}"
TEST_CONTROLLER_PORT="${TEST_CONTROLLER_PORT:-9997}"
TEST_DB_PATH="$REPO_ROOT/.tmp/elodin_integration_test_$$"
TEST_CONFIG="$REPO_ROOT/.tmp/integration_config_$$.toml"
UDP_COMMANDS_FILE="$REPO_ROOT/.tmp/udp_commands_$$.json"
SIM_STATS_FILE="$REPO_ROOT/.tmp/sim_stats_$$.json"

# PIDs to clean up
PIDS=()

# Process names that the integration test launches. Used by both pre-flight
# cleanup (kill zombies from a previous crashed run) and post-test cleanup.
INTEGRATION_PROCESS_NAMES=(
  daq_bridge
  sequencer_service
  heartbeat_service
  config_broadcast_service
  calibration_service
  controller_service
  board_simulator
  board_startup_sim
)

# Kill any leftover processes from a previous integration test run that may
# still be holding ports.  Only targets processes whose command line contains
# our repo path or the well-known binary names, to avoid killing unrelated
# processes.
kill_stale_integration_processes() {
  local label="${1:-}"
  local killed=0
  for name in "${INTEGRATION_PROCESS_NAMES[@]}"; do
    # pkill -f matches the full command line; anchor to our repo to avoid
    # killing unrelated system processes with similar names.
    pkill -f "$REPO_ROOT.*$name" 2>/dev/null && killed=$((killed + 1)) || true
  done
  # Backend server (tsx src/server.ts) — match on the server.ts path
  pkill -f "$REPO_ROOT/web-gui/backend.*server\.ts" 2>/dev/null && killed=$((killed + 1)) || true
  # Elodin DB — match on the test DB path pattern
  pkill -f "elodin.*integration_test" 2>/dev/null && killed=$((killed + 1)) || true
  # Also kill any process bound to our test ports
  for port in $TEST_ELODIN_PORT $TEST_DAQ_UDP_PORT $TEST_BACKEND_WS_PORT $TEST_ACTUATOR_UDP_PORT $TEST_STARTUP_LISTEN_PORT; do
    lsof -ti ":$port" 2>/dev/null | xargs kill 2>/dev/null || true
  done
  if [ "$killed" -gt 0 ]; then
    sleep 1
    # SIGKILL stragglers
    for name in "${INTEGRATION_PROCESS_NAMES[@]}"; do
      pkill -9 -f "$REPO_ROOT.*$name" 2>/dev/null || true
    done
    pkill -9 -f "$REPO_ROOT/web-gui/backend.*server\.ts" 2>/dev/null || true
    pkill -9 -f "elodin.*integration_test" 2>/dev/null || true
    [ -n "$label" ] && echo "  $label: killed $killed stale process group(s)"
  fi
}

cleanup() {
  echo ""
  echo "🧹 Cleaning up..."
  # First kill tracked PIDs (graceful, then force)
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  # Then sweep for anything that escaped PID tracking (e.g. child processes)
  kill_stale_integration_processes
  if [ -n "${INTEGRATION_SAVE_LOGS:-}" ]; then
    mkdir -p /tmp/integration_logs
    cp "$REPO_ROOT/.tmp/integration_"*"_$$.log" /tmp/integration_logs/ 2>/dev/null || true
    echo "  (INTEGRATION_SAVE_LOGS: copied integration_*.log to /tmp/integration_logs/)"
  fi
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
echo "Ports: Elodin=$TEST_ELODIN_PORT DAQ_UDP=$TEST_DAQ_UDP_PORT"
echo "       Backend_WS=$TEST_BACKEND_WS_PORT Backend_API=$TEST_BACKEND_API_PORT"
echo "       Actuator_UDP=$TEST_ACTUATOR_UDP_PORT Startup_listen=$TEST_STARTUP_LISTEN_PORT"
echo "DB: $TEST_DB_PATH"
echo ""

mkdir -p "$REPO_ROOT/.tmp"

# ── macOS loopback aliases for board simulator ────────────────────────────────
# On Linux, 127.0.0.x all resolve to lo. On macOS, only 127.0.0.1 works unless
# we add explicit aliases. The board_simulator binds each board to a distinct
# 127.0.0.{2+index} IP so the DAQ bridge can route by source address.
if [ "$(uname)" = "Darwin" ]; then
  LOOPBACK_IPS=(2 3 4 5 6 7 8 9 60 61)
  NEED_ALIAS=false
  for i in "${LOOPBACK_IPS[@]}"; do
    if ! ifconfig lo0 2>/dev/null | grep -q "127.0.0.$i "; then
      NEED_ALIAS=true
      break
    fi
  done
  if [ "$NEED_ALIAS" = true ]; then
    echo "🔧 Adding macOS loopback aliases for board simulator (requires sudo)..."
    for i in "${LOOPBACK_IPS[@]}"; do
      sudo ifconfig lo0 alias "127.0.0.$i" up 2>/dev/null || true
    done
    echo "  ✅ Loopback aliases added (127.0.0.{2-9,60,61})"
  fi
fi

# ── Kill stale listeners on test ports (cross-platform: lsof on macOS, fuser on Linux) ──
kill_port() {
  local port=$1 proto=${2:-tcp}
  local pids
  if command -v fuser &>/dev/null; then
    fuser -k "$port/$proto" > /dev/null 2>&1 || true
  else
    # macOS: use lsof
    if [ "$proto" = "udp" ]; then
      pids=$(lsof -nP -iUDP:"$port" -t 2>/dev/null) || true
    else
      pids=$(lsof -nP -iTCP:"$port" -t 2>/dev/null) || true
    fi
    for p in $pids; do
      kill -9 "$p" 2>/dev/null || true
    done
  fi
}

for port in $TEST_ACTUATOR_UDP_PORT $TEST_STARTUP_LISTEN_PORT $TEST_DAQ_UDP_PORT; do
  kill_port "$port" udp
done
sleep 0.3

for port in $TEST_ELODIN_PORT $TEST_BACKEND_WS_PORT $TEST_BACKEND_API_PORT; do
  kill_port "$port" tcp
done
# FSWConfigManager in daq_bridge binds to UDP 5008 (hardcoded); kill stale holders
kill_port 5008 udp
sleep 0.5

# ── Build C++ binaries ───────────────────────────────────────────────────────

echo "🔨 Building C++ binaries..."
FSW_BUILD_DIR="$REPO_ROOT/FSW/build"
if [ ! -d "$FSW_BUILD_DIR" ]; then
  mkdir -p "$FSW_BUILD_DIR"
  (cd "$FSW_BUILD_DIR" && cmake ..)
fi
(cd "$FSW_BUILD_DIR" && make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)" \
  daq_bridge sequencer_service heartbeat_service config_broadcast_service calibration_service controller_service 2>&1) \
  || fail "C++ build failed"
echo "  ✅ C++ binaries built"
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

CONFIG_BROADCAST_SVC=""
for path in "$REPO_ROOT/build/FSW/config_broadcast_service" "$REPO_ROOT/FSW/build/config_broadcast_service" "$REPO_ROOT/build/config_broadcast_service"; do
  [ -x "$path" ] && CONFIG_BROADCAST_SVC="$path" && break
done
if [ -n "$CONFIG_BROADCAST_SVC" ]; then
  echo "  ✅ config_broadcast_service: $CONFIG_BROADCAST_SVC"
else
  echo "  ⚠️  config_broadcast_service C++ binary not found — using Python fallback if needed"
fi

HEARTBEAT_SVC=""
for path in "$REPO_ROOT/build/FSW/heartbeat_service" "$REPO_ROOT/FSW/build/heartbeat_service" "$REPO_ROOT/build/heartbeat_service"; do
  [ -x "$path" ] && HEARTBEAT_SVC="$path" && break
done
if [ -n "$HEARTBEAT_SVC" ]; then
  echo "  ✅ heartbeat_service: $HEARTBEAT_SVC"
else
  echo "  ⚠️  heartbeat_service not found — DAQ bridge will send SERVER_HEARTBEAT (heartbeat_service disabled in test config)"
fi

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

# Find controller_service (optional — controller tests skipped if absent)
CONTROLLER_SVC=""
for path in "$REPO_ROOT/build/FSW/controller_service" "$REPO_ROOT/FSW/build/controller_service" "$REPO_ROOT/build/controller_service"; do
  [ -x "$path" ] && CONTROLLER_SVC="$path" && break
done
if [ -n "$CONTROLLER_SVC" ]; then
  echo "  ✅ controller_service: $CONTROLLER_SVC"
else
  echo "  ⚠️  controller_service not found — controller tests will be skipped"
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

# Cross-platform in-place sed (macOS requires -i '', Linux requires -i)
sedi() {
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

cp "$CONFIG_FILE" "$TEST_CONFIG"
# Replace database port (under [database] section)
sedi "s/^port = 2240/port = $TEST_ELODIN_PORT/" "$TEST_CONFIG"
# Replace sensor_port (under [network] section)
sedi "s/^sensor_port = 5006/sensor_port = $TEST_DAQ_UDP_PORT/" "$TEST_CONFIG"
# Replace actuator_cmd_port (under [network] section)
sedi "s/^actuator_cmd_port = 5005/actuator_cmd_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"
# Point heartbeat broadcast to localhost to avoid sending to the real subnet
sedi 's/^broadcast_ip = .*/broadcast_ip = "127.0.0.1"/' "$TEST_CONFIG"
# Align SERVER_HEARTBEAT UDP with the same port as udp_listener (actuator/control path in CI)
sedi "s/^broadcast_port = 5005/broadcast_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"
# NOTE: Do NOT replace board IPs — the DAQ bridge routes by source IP.
# The board_simulator falls back to 127.0.0.{2+index} when config IPs
# (192.168.2.x) aren't bindable, and the DAQ bridge has matching fallback
# logic for 127.0.0.x addresses. Replacing all IPs to 127.0.0.1 makes the
# bridge treat every board as the same one (only one sensor type gets through).
# Replace actuator board IPs to 127.0.0.1 so UDP commands reach our local listener.
# Unlike sensor boards (where DAQ bridge routes by source IP), actuator commands are
# sent TO the board IP — so we must point them at localhost for testing.
sedi 's/^ip = "192\.168\.2\.11"/ip = "127.0.0.1"/' "$TEST_CONFIG"
sedi 's/^ip = "192\.168\.2\.12"/ip = "127.0.0.1"/' "$TEST_CONFIG"
sedi 's/^ip = "192\.168\.2\.13"/ip = "127.0.0.1"/' "$TEST_CONFIG"
sedi 's/^ip = "192\.168\.2\.14"/ip = "127.0.0.1"/' "$TEST_CONFIG"
# Encoder board #1 (config [boards.encoder_board_61]) — dedicated loopback so sim can bind without colliding
sedi 's/^ip = "192\.168\.2\.61"/ip = "127.0.0.61"/' "$TEST_CONFIG"
# Replace listen_port on actuator boards to use our test port
sedi "s/^listen_port = 5005/listen_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"
sedi "s/^send_port = 5005/send_port = $TEST_ACTUATOR_UDP_PORT/" "$TEST_CONFIG"

# Integration-only: startup E2E (SETUP → SELF_TEST). Encoder uses production [boards.encoder_board_61] + IP sed above.
# Set fallback duty cycles so controller publishes to Elodin even without sensor data
sedi 's/^fallback_fuel_duty_cycle = 0.0/fallback_fuel_duty_cycle = 0.1/' "$TEST_CONFIG"
sedi 's/^fallback_ox_duty_cycle = 0.0/fallback_ox_duty_cycle = 0.1/' "$TEST_CONFIG"

cat >> "$TEST_CONFIG" << EOF

[boards.integration_startup]
enabled = true
type = "PT"
board_id = 60
ip = "127.0.0.60"
send_port = $TEST_DAQ_UDP_PORT
listen_port = $TEST_STARTUP_LISTEN_PORT
num_sensors = 1
active_connectors = [1]
voltage_reference = 1
necessary_for_abort = false
enable_serial_printing = false
designated_survivor = false
EOF

# heartbeat_service enabled=true makes daq_bridge set send_from_daq_bridge=false.
# If the C++ heartbeat_service binary exists we start it (production-like). Otherwise disable
# the service in config so daq_bridge still emits SERVER_HEARTBEAT for Test 7.
if [ -z "$HEARTBEAT_SVC" ]; then
  HS_TMP="${TEST_CONFIG}.hsfix.$$"
  awk '
    /^\[heartbeat_service\]/ { in_hs = 1 }
    /^\[/ {
      if ($0 !~ /^\[heartbeat_service\]/) in_hs = 0
    }
    in_hs && /^enabled = true/ { sub(/^enabled = true/, "enabled = false") }
    { print }
  ' "$TEST_CONFIG" > "$HS_TMP" && mv "$HS_TMP" "$TEST_CONFIG"
fi

echo "  ✅ Test config: $TEST_CONFIG"
echo "     DB port=$TEST_ELODIN_PORT  sensor_port=$TEST_DAQ_UDP_PORT  actuator_port=$TEST_ACTUATOR_UDP_PORT"
echo ""

# ── Pre-flight: kill zombies from previous crashed runs ──────────────────────
kill_stale_integration_processes "Pre-flight"

# ── Start Elodin DB ──────────────────────────────────────────────────────────

echo "📊 Starting Elodin DB..."
rm -rf "$TEST_DB_PATH" 2>/dev/null || true
RUST_LOG=debug "$ELODIN_DB_BIN" run "[::]:$TEST_ELODIN_PORT" "$TEST_DB_PATH" > "$REPO_ROOT/.tmp/integration_elodin_$$.log" 2>&1 &
PIDS+=($!)
sleep 2

if ! kill -0 "${PIDS[-1]}" 2>/dev/null; then
  echo "  ❌ Elodin DB failed to start. Log:"
  cat "$REPO_ROOT/.tmp/integration_elodin_$$.log"
  exit 1
fi
echo "  ✅ Elodin DB started (PID ${PIDS[-1]})"

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

# ── Heartbeat service (SERVER_HEARTBEAT UDP when [heartbeat_service] enabled) ─
if [ -n "$HEARTBEAT_SVC" ]; then
  echo "💓 Starting heartbeat_service..."
  "$HEARTBEAT_SVC" --config "$TEST_CONFIG" \
    --elodin-host 127.0.0.1 \
    --elodin-port "$TEST_ELODIN_PORT" \
    --broadcast-ip 127.0.0.1 \
    --broadcast-port "$TEST_ACTUATOR_UDP_PORT" \
    > "$REPO_ROOT/.tmp/integration_heartbeat_$$.log" 2>&1 &
  PIDS+=($!)
  sleep 0.5
  if kill -0 "${PIDS[-1]}" 2>/dev/null; then
    echo "  ✅ heartbeat_service started (PID ${PIDS[-1]})"
  else
    echo "  ❌ heartbeat_service failed to start. Log:"
    cat "$REPO_ROOT/.tmp/integration_heartbeat_$$.log"
    exit 1
  fi
fi

# ── Config broadcast (SENSOR_CONFIG / ACTUATOR_CONFIG to boards) ────────────
if [ "${INTEGRATION_SKIP_STARTUP_E2E:-0}" != "1" ]; then
  echo "📻 Starting config_broadcast_service..."
  if [ -n "$CONFIG_BROADCAST_SVC" ]; then
    ("$CONFIG_BROADCAST_SVC" --config "$TEST_CONFIG" --interval-ms 1500 > "$REPO_ROOT/.tmp/integration_config_broadcast_$$.log" 2>&1) &
  else
    (cd "$REPO_ROOT" && PYTHONPATH="$REPO_ROOT/scripts/services:$REPO_ROOT/scripts/calibration" \
      "$PYTHON_BIN" scripts/services/config_broadcast_service.py --config "$TEST_CONFIG" --interval-ms 1500 \
      > "$REPO_ROOT/.tmp/integration_config_broadcast_$$.log" 2>&1) &
  fi
  PIDS+=($!)
  sleep 0.5
  echo "  ✅ config_broadcast_service started (PID ${PIDS[-1]})"
fi

# ── Start Backend Server ─────────────────────────────────────────────────────

if [ "$BACKEND" = "thin" ]; then
  echo "🖥️  Starting Backend server (server.ts)..."
  (cd "$REPO_ROOT/web-gui/backend" && \
    WS_PORT=$TEST_BACKEND_WS_PORT \
    ELODIN_HOST=127.0.0.1 \
    ELODIN_PORT=$TEST_ELODIN_PORT \
    ACTUATOR_SERVICE_PORT=9998 \
    CONFIG_PATH="$TEST_CONFIG" \
    npx tsx src/server.ts > "$REPO_ROOT/.tmp/integration_backend_$$.log" 2>&1) &
else
  echo "🖥️  Starting Backend server (server-legacy.ts)..."
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
    npx tsx src/server-legacy.ts > "$REPO_ROOT/.tmp/integration_backend_$$.log" 2>&1) &
fi
PIDS+=($!)

wait_for_port "$TEST_BACKEND_WS_PORT" "Backend WS" 15 || {
  echo "  ❌ Backend failed to start. Log:"
  tail -30 "$REPO_ROOT/.tmp/integration_backend_$$.log"
  exit 1
}
echo "  ✅ Backend started (PID ${PIDS[-1]})"

# ── Start Calibration Service ────────────────────────────────────────────────

CALIB_SVC=""
for path in "$REPO_ROOT/build/FSW/calibration_service" "$REPO_ROOT/FSW/build/calibration_service" "$REPO_ROOT/build/calibration_service"; do
  [ -x "$path" ] && CALIB_SVC="$path" && break
done
if [ -n "$CALIB_SVC" ]; then
  echo "🔬 Starting calibration_service..."
  "$CALIB_SVC" --config "$TEST_CONFIG" --elodin-host 127.0.0.1 --elodin-port "$TEST_ELODIN_PORT" \
    > "$REPO_ROOT/.tmp/integration_calibration_$$.log" 2>&1 &
  PIDS+=($!)
  sleep 1
  if kill -0 "${PIDS[-1]}" 2>/dev/null; then
    echo "  ✅ calibration_service started (PID ${PIDS[-1]})"
  else
    echo "  ⚠️  calibration_service failed to start. Log:"
    tail -10 "$REPO_ROOT/.tmp/integration_calibration_$$.log"
  fi
else
  echo "  ⚠️  calibration_service not found — calibrated data tests will show 0 entities"
fi

# ── Start Controller Service ─────────────────────────────────────────────────
if [ -n "$CONTROLLER_SVC" ]; then
  echo "🎛️  Starting controller_service..."
  "$CONTROLLER_SVC" --config "$TEST_CONFIG" \
    --elodin-host 127.0.0.1 --elodin-port "$TEST_ELODIN_PORT" \
    --control-port "$TEST_CONTROLLER_PORT" \
    > "$REPO_ROOT/.tmp/integration_controller_$$.log" 2>&1 &
  PIDS+=($!)
  sleep 1
  if kill -0 "${PIDS[-1]}" 2>/dev/null; then
    echo "  ✅ controller_service started (PID ${PIDS[-1]})"
  else
    echo "  ⚠️  controller_service failed to start. Log:"
    tail -10 "$REPO_ROOT/.tmp/integration_controller_$$.log"
    CONTROLLER_SVC=""
  fi
fi

# ── Start Fake Data Generator ────────────────────────────────────────────────

echo "🎭 Starting fake data generator..."
SIM_PID=""
if [ -n "$FAKE_GEN" ]; then
  # fake_packet_generator: positional args = host port rate_hz
  "$FAKE_GEN" "127.0.0.1" "$TEST_DAQ_UDP_PORT" 10 > "$REPO_ROOT/.tmp/integration_fakegen_$$.log" 2>&1 &
  PIDS+=($!)
else
  # board_simulator.py: uses --config for board definitions, --port for UDP target
  # --low-noise: constant ADC values per channel for calibration spike detection
  "$PYTHON_BIN" -c "import tomli" 2>/dev/null || "$PYTHON_BIN" -m pip install tomli -q 2>/dev/null || true
  "$PYTHON_BIN" "$BOARD_SIM" --config "$TEST_CONFIG" --target 127.0.0.1 --port "$TEST_DAQ_UDP_PORT" --low-noise --stats-file "$SIM_STATS_FILE" > "$REPO_ROOT/.tmp/integration_fakegen_$$.log" 2>&1 &
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
CTRL_FLAG=""; [ -n "$CONTROLLER_SVC" ] && CTRL_FLAG="--has-controller"
PYTHON_BIN="${PYTHON_BIN:-python3}"
export TEST_DAQ_UDP_PORT TEST_STARTUP_LISTEN_PORT BOARD_STARTUP_SIM="$REPO_ROOT/scripts/board_startup_sim.py" PYTHON_BIN
export INTEGRATION_SKIP_STARTUP_E2E
# Test 9 (SELF_TEST E2E): log every SELF_TEST.* SENSOR_UPDATE on the WS client
[ "$VERBOSE" = "1" ] && export INTEGRATION_SELFTEST_DEBUG=1
(cd "$REPO_ROOT/web-gui/backend" && \
  NODE_PATH="$REPO_ROOT/web-gui/backend/node_modules" \
  npx tsx "$SCRIPT_DIR/ws_data_flow_test.ts" "$TEST_BACKEND_WS_PORT" "$TEST_BACKEND_API_PORT" "$TEST_ACTUATOR_UDP_PORT" \
  --received-stats "$RECEIVED_STATS_FILE" \
  --udp-commands "$UDP_COMMANDS_FILE" \
  --seq-log "$REPO_ROOT/.tmp/integration_sequencer_$$.log" \
  --backend-log "$REPO_ROOT/.tmp/integration_backend_$$.log" \
  --controller-log "$REPO_ROOT/.tmp/integration_controller_$$.log" \
  --backend="$BACKEND" $SEQ_FLAG $CTRL_FLAG $VERBOSE_FLAG)
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
# UDP actuator commands are now validated internally by ws_data_flow_test.ts
# test_UdpActuatorCommands(). The script waits 500ms for packets to flush.
echo ""

if [ -n "$SEQ_SVC" ]; then
  kill "$UDP_PID" 2>/dev/null || true
fi

rm -f "$RECEIVED_STATS_FILE" 2>/dev/null || true

# Elodin State Sync is asserted inside ws_data_flow_test.ts (Test 6 + /stats); no duplicate line here.

# ── Results ───────────────────────────────────────────────────────────────────

FINAL_EXIT=0
UDP_CHECK_FAILED=${UDP_CHECK_FAILED:-0}
[ "$WS_TEST_EXIT" -ne 0 ] && FINAL_EXIT=1
[ "$UDP_CHECK_FAILED" -ne 0 ] && FINAL_EXIT=1

echo ""
echo "═══════════════════════════════════════════════════════════════"
if [ "$FINAL_EXIT" -eq 0 ]; then
  echo "  ✅ INTEGRATION TEST PASSED"
else
  echo "  ❌ INTEGRATION TEST FAILED"
  [ "$WS_TEST_EXIT" -ne 0 ] && echo "     WS test failed (exit code: $WS_TEST_EXIT)"
  [ "$UDP_CHECK_FAILED" -ne 0 ] && echo "     UDP test failed (0 or dropped packets)"
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Logs:"
echo "  Elodin DB:      $REPO_ROOT/.tmp/integration_elodin_$$.log"
echo "  DAQ Bridge:     $REPO_ROOT/.tmp/integration_daq_$$.log"
echo "  Backend:        $REPO_ROOT/.tmp/integration_backend_$$.log"
[ -n "$SEQ_SVC" ] && echo "  Sequencer:      $REPO_ROOT/.tmp/integration_sequencer_$$.log"
[ -n "$CONTROLLER_SVC" ] && echo "  Controller:     $REPO_ROOT/.tmp/integration_controller_$$.log"
echo "  Calibration:    $REPO_ROOT/.tmp/integration_calibration_$$.log"
echo "  Fake Gen:       $REPO_ROOT/.tmp/integration_fakegen_$$.log"
echo "  UDP Listener:   $REPO_ROOT/.tmp/integration_udp_$$.log"

exit "$FINAL_EXIT"
