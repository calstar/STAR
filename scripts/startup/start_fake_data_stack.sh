#!/bin/bash
# Full fake-data stack for validation without hardware.
# Validates: PT spiking behavior, actuator heartbeats, calibration, controller, etc.
#
# Pipeline: board_simulator → UDP:5006 → daq_bridge → Elodin DB → relay → backend → UI
# Board simulator sends DiabloAvionics-format packets (heartbeats + sensor data).

set -e

SESSION="sensor-fake"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT"

# Check deps
if ! command -v elodin-db &>/dev/null && [ ! -f "$HOME/.cargo/bin/elodin-db" ]; then
  echo "❌ elodin-db not found. Install: cargo install elodin-db"
  exit 1
fi
ELODIN_DB_BIN="${ELODIN_DB:-$HOME/.cargo/bin/elodin-db}"
[ ! -x "$ELODIN_DB_BIN" ] && ELODIN_DB_BIN="elodin-db"

# Kill existing
pkill -f "elodin-db run.*2240" 2>/dev/null || true
pkill -f "elodin-relay" 2>/dev/null || true
pkill -f "daq_bridge" 2>/dev/null || true
pkill -f "board_simulator" 2>/dev/null || true
pkill -f "tsx watch.*server" 2>/dev/null || true
pkill -f "calibration_server" 2>/dev/null || true
pkill -f "controller_service" 2>/dev/null || true
pkill -f "actuator_service" 2>/dev/null || true
for port in 8081 8082 9090 3000; do fuser -k $port/tcp 2>/dev/null || true; done
sleep 2

# Build FSW
DAQ_BIN="$PROJECT/build/FSW/daq_bridge"
[ ! -x "$DAQ_BIN" ] && DAQ_BIN="$PROJECT/FSW/build/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  echo "⚙️ Building daq_bridge..."
  mkdir -p "$PROJECT/build" && cd "$PROJECT/build"
  [ ! -f CMakeCache.txt ] && cmake ..
  make -j$(nproc) daq_bridge calibration_service controller_service actuator_service 2>/dev/null || true
  cd "$PROJECT"
fi

ELODIN_DB_DIR="$HOME/.local/share/elodin/daq_fake"
mkdir -p "$HOME/.local/share/elodin"

echo "🚀 Starting fake-data validation stack..."
echo "   DB: $ELODIN_DB_DIR  |  Port: 2240"
echo ""

# 1. Elodin DB
$ELODIN_DB_BIN run "[::]:2240" "$ELODIN_DB_DIR" > /tmp/elodin_fake.log 2>&1 &
sleep 1
echo "✅ Elodin DB"

# 2. Relay (must connect before daq_bridge writes)
cd "$PROJECT/web-gui/backend"
[ ! -d node_modules ] && npm install --silent
npm run relay > /tmp/relay_fake.log 2>&1 &
sleep 2
echo "✅ Elodin relay :9090"

# 3. DAQ bridge
cd "$PROJECT"
$DAQ_BIN config/config.toml > /tmp/daq_fake.log 2>&1 &
sleep 2
echo "✅ DAQ bridge (UDP :5006 → Elodin)"

# 4. Board simulator (PT + actuator heartbeats + sensor data)
# Add loopback aliases so simulator binds to 192.168.2.21, .22 (revert before real hardware)
[ -x "$PROJECT/scripts/setup_sim_network.sh" ] && "$PROJECT/scripts/setup_sim_network.sh" || true
# Add --low-noise for smoother PT signal when validating spike behavior
python3 scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 ${LOW_NOISE:+--low-noise} > /tmp/sim_fake.log 2>&1 &
sleep 1
echo "✅ Board simulator (PT, actuator heartbeats → :5006)"

# 5. Backend
cd "$PROJECT/web-gui/backend"
ACTUATOR_SVC_ENV="ACTUATOR_SERVICE_ENABLED=false"
[ -x "$PROJECT/build/FSW/actuator_service" ] && ACTUATOR_SVC_ENV="ACTUATOR_SERVICE_ENABLED=true ACTUATOR_SERVICE_PORT=9998"
ELODIN_RELAY_WS_URL=ws://localhost:9090 USE_DIRECT_DAQ=false $ACTUATOR_SVC_ENV npm run dev > /tmp/backend_fake.log 2>&1 &
sleep 3
echo "✅ Backend :8081"

# 6. Calibration sidecar
cd "$PROJECT"
PYTHONPATH="$PROJECT" python3 scripts/calibration/calibration_server.py > /tmp/sidecar_fake.log 2>&1 &
sleep 1
echo "✅ Calibration sidecar"

# 7. Controller service (optional)
if [ -x "$PROJECT/build/FSW/controller_service" ]; then
  $PROJECT/build/FSW/controller_service --config config/config.toml --elodin-host 127.0.0.1 > /tmp/ctrl_fake.log 2>&1 &
  echo "✅ Controller service"
fi

# 8. Actuator service (optional)
if [ -x "$PROJECT/build/FSW/actuator_service" ]; then
  $PROJECT/build/FSW/actuator_service --config config/config.toml --port 9998 > /tmp/actuator_fake.log 2>&1 &
  echo "✅ Actuator service"
fi

# 9. Frontend
cd "$PROJECT/web-gui/frontend"
[ ! -d node_modules ] && npm install --silent
npm run dev > /tmp/frontend_fake.log 2>&1 &
sleep 2
echo "✅ Frontend :3000"

echo ""
echo "┌─────────────────────────────────────────────────────────────────────────┐"
echo "│  Fake data stack running — validate before plugging to hardware         │"
echo "│  Frontend:  http://localhost:3000                                        │"
echo "│  Backend:   :8081  |  Relay: :9090  |  DB: :2240                        │"
echo "│  Board simulator sends PT + actuator heartbeats to UDP :5006             │"
echo "│  Logs: /tmp/*_fake.log                                                  │"
echo "│  Stop: pkill -f 'elodin-db|daq_bridge|board_simulator|elodin-relay'       │"
echo "└─────────────────────────────────────────────────────────────────────────┘"
echo ""
echo "  Check: Dashboard gauges, board status (heartbeats), calibration, controller"
echo ""

# Optional: attach to logs
if [ "${1:-}" = "log" ]; then
  tail -f /tmp/daq_fake.log /tmp/backend_fake.log
else
  wait
fi
