#!/bin/bash
# Full stack with the default server.ts (direct Elodin DB backend).
# Legacy monolithic backend is available via start_tmux_dev_legacy.sh.
#
# Thin backend: HTTP + WebSocket on WS_PORT (8081 here so frontend + data_logger defaults work).
# Backend connects directly to Elodin DB (no relay). Env: ELODIN_HOST, ELODIN_PORT, WS_PORT.
#
# Startup delays in each CMD_* keep pipeline safe (DB before DAQ) regardless of pane order.
# Command path: thin → TCP :9998 → sequencer_service (matches test_integration.sh).
# Tmux panes 0–10: sim, daq, db, calibration, thin backend, frontend, heartbeat, config, sequencer,
# ota, controller. Splits always target the highest-index pane so all 11 panes are created.

SESSION="sensor-dev"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Prefer: 1) bashrc-activated venv (VIRTUAL_ENV), 2) repo .venv, 3) PATH python3
PYTHON_BIN=""
if [ -n "$VIRTUAL_ENV" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then
  PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif [ -x "$PROJECT/.venv/bin/python" ]; then
  PYTHON_BIN="$PROJECT/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || command -v python || true)"
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "❌ python3 not found. Activate your venv (e.g. source ~/.bashrc) or run:"
  echo "   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

# Node.js must be modern enough for the web GUI tooling.
if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found. Install Node.js 20+ (recommended) and retry."
  exit 1
fi
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js 20+ required. Current: $(node -v)"
  exit 1
fi
if [ "$NODE_MAJOR" -ge 23 ]; then
  echo "⚠️  Node.js $(node -v) detected. If backend crashes, switch to Node 20/22."
fi

# Elodin DB binary (portable path: cargo bin or PATH).
ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
if [ ! -x "$ELODIN_DB_BIN" ]; then
  ELODIN_DB_BIN="$(command -v elodin-db || true)"
fi
if [ -z "$ELODIN_DB_BIN" ]; then
  echo "❌ elodin-db not found. Install it (cargo) and ensure it's on PATH."
  exit 1
fi

# Build C++ binaries — same as `build` / `bash scripts/build.sh` (USE_SIM respected).
# Set SKIP_CPP_BUILD=1 only if you already ran `USE_SIM=… bash scripts/build.sh` (e.g. Playwright E2E).
if [ "${SKIP_CPP_BUILD:-0}" = "1" ]; then
  echo "⏭️  Skipping C++ build (SKIP_CPP_BUILD=1 — binaries must already be built for this USE_SIM)."
else
  echo "🔨 Building C++ binaries..."
  export USE_SIM="${USE_SIM:-0}"
  bash "$PROJECT/scripts/build.sh" || { echo "❌ C++ build failed"; exit 1; }
  echo "  ✅ C++ binaries built"
fi

# Ensure web-gui dependencies are installed (tmux panes assume they exist).
if [ ! -d "$PROJECT/diablo_server/backend/node_modules" ]; then
  echo "📦 Installing web-gui backend dependencies..."
  (cd "$PROJECT/diablo_server/backend" && npm install) || { echo "❌ backend npm install failed"; exit 1; }
fi
if [ ! -d "$PROJECT/diablo_server/frontend/node_modules" ]; then
  echo "📦 Installing web-gui frontend dependencies..."
  (cd "$PROJECT/diablo_server/frontend" && npm install) || { echo "❌ frontend npm install failed"; exit 1; }
fi

# Check if services are already running via systemd
if systemctl --user is-active --quiet sensor-backend.service 2>/dev/null; then
  echo "⚠️  Systemd services are currently running!"
  echo "   Stop them first: systemctl --user stop sensor-elodin sensor-backend sensor-frontend sensor-sidecar sensor-actuator"
  exit 1
fi

DB_NAME="${ELODIN_DB_NAME:-daq_$(date +%Y%m%d_%H%M%S)}"
echo "Using DB Name: $DB_NAME"

ELODIN_DB_DIR="$HOME/.local/share/elodin/$DB_NAME"
# Always ensure Elodin is free before starting (we killed everything above already)
pkill -9 -f "elodin-db run" 2>/dev/null || true
fuser -k 2240/tcp 2>/dev/null || true
sleep 0.5

echo ""
echo "  Killing any existing stack processes before launching tmux..."
tmux kill-server 2>/dev/null || true
pkill -9 -f "elodin-db run" 2>/dev/null || true
fuser -k 2240/tcp 2>/dev/null || true
pkill -9 -f "build/bin/daq_bridge\|build/bin/daq_bridge" 2>/dev/null || true
pkill -9 -f "build/bin/sequencer_service\|build/bin/sequencer_service" 2>/dev/null || true
pkill -9 -f "build/bin/heartbeat_service\|build/bin/heartbeat_service" 2>/dev/null || true
pkill -9 -f "build/bin/config_broadcast_service\|build/bin/config_broadcast_service" 2>/dev/null || true
pkill -9 -f "build/bin/calibration_service\|build/bin/calibration_service" 2>/dev/null || true
pkill -9 -f "build/bin/controller_service\|build/bin/controller_service" 2>/dev/null || true
pkill -9 -f "board_simulator" 2>/dev/null || true
pkill -9 -f "next dev" 2>/dev/null || true
pkill -9 -f "tsx watch.*server\.ts\|tsx.*server\.ts" 2>/dev/null || true
fuser -k 8081/tcp 8082/tcp 9998/tcp 2>/dev/null || true
OTA_CMD_PORT="${OTA_SERVICE_CMD_PORT:-9997}"
fuser -k "${OTA_CMD_PORT}/tcp" 2>/dev/null || true
sleep 1
echo "  Done. Starting fresh stack."
echo ""

# Prepare log directory
mkdir -p /tmp/gui_logs
rm -f /tmp/gui_logs/*.log
OTA_CMD_PORT="${OTA_SERVICE_CMD_PORT:-9997}"

# When USE_SIM=1, remap board IPs from 192.168.2.x (real hardware subnet) to
# 127.0.0.x (loopback — the full /8 is routable on Linux). This lets the board
# simulator bind to the config IPs and config_broadcast_service actually reach them.
CONFIG_FILE="config/config.toml"
if [ "${USE_SIM:-0}" = "1" ]; then
  CONFIG_FILE="/tmp/gui_logs/sim_config.toml"
  sed 's/192\.168\.2\./127.0.0./g' "$PROJECT/config/config.toml" > "$CONFIG_FILE"
  echo "  📝 Sim config: board IPs remapped 192.168.2.x → 127.0.0.x"
  echo "     $CONFIG_FILE"
fi

OTA_BIN="$PROJECT/build/bin/ota_service"
if [ ! -x "$OTA_BIN" ]; then
  OTA_BIN="$PROJECT/build/bin/ota_service"
fi
pkill -f "ota_service" 2>/dev/null || true

# wait_for_elodin: poll until Elodin DB is accepting TCP connections on port 2240.
# Replaces fixed sleep delays so services start as soon as the DB is ready.
WAIT_FOR_ELODIN='echo "  ⏳ Waiting for Elodin DB (port 2240)..." && for i in $(seq 1 30); do (echo >/dev/tcp/127.0.0.1/2240) 2>/dev/null && break; sleep 1; done'

# wait_for_daq: poll daq.log until daq_bridge has registered VTables with Elodin.
# Without this, the backend may subscribe to VTableStreams that don't exist yet.
WAIT_FOR_DAQ='echo "  ⏳ Waiting for DAQ bridge VTables..." && for i in $(seq 1 60); do grep -q "Drain complete, ready for TABLE data" /tmp/gui_logs/daq.log 2>/dev/null && break; sleep 0.5; done && echo "  ✅ DAQ bridge ready"'

# wait_for_calibration: poll calibration.log until calibration_service has registered VTables.
# Backend and controller subscribe to calibrated data — must wait for these VTables to exist.
WAIT_FOR_CALIBRATION='echo "  ⏳ Waiting for calibration service VTables..." && for i in $(seq 1 60); do grep -q "registered calibrated VTables, subscribed" /tmp/gui_logs/calibration.log 2>/dev/null && break; sleep 0.5; done && echo "  ✅ Calibration service ready"'

# Publisher: writes UDP sensor data → Elodin DB. Without this, nothing is written to the DB.
DAQ_BIN="$PROJECT/build/bin/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  DAQ_BIN="$PROJECT/build/bin/daq_bridge"
fi
# DAQ must wait for Elodin DB to be ready.
CMD_LOG_DAQ="/tmp/gui_logs/daq.log"
CMD_DAQ='printf "\n  ══ DAQ BRIDGE (writes to Elodin — UDP from config → DB) ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && exec '"$DAQ_BIN"' '"$CONFIG_FILE"' 2>&1 | tee '"$CMD_LOG_DAQ"

# Controller Service: Reads CALIBRATED DB → UDP out + Diagnostics DB
CTRL_BIN="$PROJECT/build/bin/controller_service"
if [ ! -x "$CTRL_BIN" ]; then
  CTRL_BIN="$PROJECT/build/bin/controller_service"
fi
CTRL_LUT="${LUT_PATH:-$PROJECT/output/lut/controller_policy_fsw.bin}"
CTRL_OPTS="--config $CONFIG_FILE --elodin-host 127.0.0.1"
[ -f "$CTRL_LUT" ] && CTRL_OPTS="$CTRL_OPTS --lut-path $CTRL_LUT"
CMD_LOG_CTRL="/tmp/gui_logs/controller.log"
CMD_CTRL='printf "\n  ══ CONTROLLER SERVICE (DB Calibrated → Actuators) ══\n\n" && '"$WAIT_FOR_ELODIN"' && '"$WAIT_FOR_CALIBRATION"' && cd '"$PROJECT"' && exec '"$CTRL_BIN"' '"$CTRL_OPTS"' 2>&1 | tee '"$CMD_LOG_CTRL"

# Sequencer service: state machine + actuator UDP (same TCP :9998 text protocol as server.ts)
SEQ_BIN="$PROJECT/build/bin/sequencer_service"
if [ ! -x "$SEQ_BIN" ]; then
  SEQ_BIN="$PROJECT/build/bin/sequencer_service"
fi
if [ -x "$SEQ_BIN" ]; then
  CMD_LOG_SEQUENCER="/tmp/gui_logs/sequencer.log"
  CMD_SEQUENCER='printf "\n  ══ SEQUENCER SERVICE (TCP :9998 — TRANSITION / ACTUATOR / …) ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && exec '"$SEQ_BIN"' --config '"$CONFIG_FILE"' --port 9998 2>&1 | tee '"$CMD_LOG_SEQUENCER"
else
  CMD_SEQUENCER='printf "\n  ❌ sequencer_service not found. Build: cd build && cmake .. && make sequencer_service\n\n" && sleep infinity'
fi

CMD_LOG_DB="/tmp/gui_logs/db.log"
CMD_DB='printf "\n  ══ ELODIN DB — :2240 (raw data lands here only) ══\n\n" && mkdir -p '"$HOME"'/.local/share/elodin && RUST_LOG=debug exec '"$ELODIN_DB_BIN"' run "[::]:2240" "'"$ELODIN_DB_DIR"'" 2>&1 | tee '"$CMD_LOG_DB"

# Thin backend connects directly to Elodin DB (no relay needed)
THIN_WS_PORT="${THIN_WS_PORT:-8081}"
THIN_ACT_PORT="${THIN_ACTUATOR_SERVICE_PORT:-9998}"

# wait_for_backend: poll until the backend WS port is accepting connections.
# The board simulator must start AFTER the backend has subscribed to Elodin VTableStreams,
# otherwise self-test packets (one-shot during SETUP) are written to Elodin but never
# forwarded to the backend — the browser never sees self-test results.
WAIT_FOR_BACKEND='echo "  ⏳ Waiting for backend WS (port '"$THIN_WS_PORT"')..." && for i in $(seq 1 40); do (echo >/dev/tcp/127.0.0.1/'"$THIN_WS_PORT"') 2>/dev/null && break; sleep 1; done && echo "  ✅ Backend ready"'

CMD_LOG_BACKEND="/tmp/gui_logs/backend.log"
CMD_WEB_BACKEND='printf "\n  ══ BACKEND — HTTP+WS :'"${THIN_WS_PORT}"' (server.ts → Elodin DB :2240) ══\n\n" && '"$WAIT_FOR_ELODIN"' && '"$WAIT_FOR_DAQ"' && '"$WAIT_FOR_CALIBRATION"' && cd '"$PROJECT"'/diablo_server/backend && WS_PORT='"$THIN_WS_PORT"' ELODIN_HOST=127.0.0.1 ELODIN_PORT=2240 ACTUATOR_SERVICE_PORT='"$THIN_ACT_PORT"' npx tsx src/server.ts 2>&1 | tee '"$CMD_LOG_BACKEND"

CMD_LOG_FRONTEND="/tmp/gui_logs/frontend.log"
# Don't set NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL — the frontend auto-detects them from
# window.location.hostname at runtime, so remote devices hitting http://<host>:3000 can reach
# the backend on the same host. Hardcoding 127.0.0.1 here breaks LAN clients.
CMD_WEB_FRONTEND='printf "\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n" && sleep 3 && cd '"$PROJECT"'/diablo_server/frontend && OTA_SERVICE_PORT='"$OTA_CMD_PORT"' npm run dev 2>&1 | tee '"$CMD_LOG_FRONTEND"

if [ -x "$OTA_BIN" ]; then
  CMD_LOG_OTA="/tmp/gui_logs/ota.log"
  CMD_OTA='printf "\n  ══ ETHERNET OTA SERVICE — TCP :'"${OTA_CMD_PORT}"' (pio build+flash here) ══\n\n" && exec '"$OTA_BIN"' --port '"$OTA_CMD_PORT"' 2>&1 | tee '"$CMD_LOG_OTA"
else
  CMD_OTA='printf "\n  ❌ ota_service not built — cd build && cmake .. && make ota_service\n\n" && sleep infinity'
fi

# Board simulator (pane 0); set USE_SIM=1 to run (default off for real hardware)
# Waits for the backend WS port so the Elodin→backend pipeline is up before traffic.
# Full firmware lifecycle: SETUP → SENSOR_CONFIG → SELF_TEST → ACTIVE (no --skip-startup).
if [ "${USE_SIM:-0}" = "1" ]; then
  CMD_LOG_SIM="/tmp/gui_logs/sim.log"
  CMD_SIM='printf "\n  ══ BOARD SIMULATOR — UDP → :5006 (All Boards) ══\n\n" && '"$WAIT_FOR_BACKEND"' && cd '"$PROJECT"' && exec '"$PYTHON_BIN"' sim/board_simulator.py --config '"$CONFIG_FILE"' --target 127.0.0.1 --port 5006 2>&1 | tee '"$CMD_LOG_SIM"
else
  CMD_SIM='printf "\n  ══ BOARD SIMULATOR — DISABLED (USE_SIM=1 to enable) ══\n\n" && sleep infinity'
fi
# Heartbeat service: C++ preferred (flight-ready), Python fallback — poll /api/engine_state on thin HTTP port
HEARTBEAT_BIN="$PROJECT/build/bin/heartbeat_service"
[ ! -x "$HEARTBEAT_BIN" ] && HEARTBEAT_BIN="$PROJECT/build/bin/heartbeat_service"
HB_BACKEND_URL="http://127.0.0.1:${THIN_WS_PORT}"
# Python heartbeat polls /api/engine_state; C++ reads sequencer state from Elodin (no backend URL).
CMD_LOG_HB="/tmp/gui_logs/heartbeat.log"
CMD_HEARTBEAT='printf "\n  ══ HEARTBEAT SERVICE — SERVER_HEARTBEAT to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$PYTHON_BIN"' archive/legacy/python-services/heartbeat_service.py --config '"$CONFIG_FILE"' --backend-url '"$HB_BACKEND_URL"' 2>&1 | tee '"$CMD_LOG_HB"
[ -x "$HEARTBEAT_BIN" ] && CMD_HEARTBEAT='printf "\n  ══ HEARTBEAT SERVICE (C++) — SERVER_HEARTBEAT to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$HEARTBEAT_BIN"' --config '"$CONFIG_FILE"' 2>&1 | tee '"$CMD_LOG_HB"
# Config broadcast service: C++ preferred (flight-ready), Python fallback
CONFIG_BIN="$PROJECT/build/bin/config_broadcast_service"
[ ! -x "$CONFIG_BIN" ] && CONFIG_BIN="$PROJECT/build/bin/config_broadcast_service"
CMD_LOG_CONFIG="/tmp/gui_logs/config.log"
CMD_CONFIG='printf "\n  ══ CONFIG BROADCAST SERVICE — config packets to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$PYTHON_BIN"' archive/legacy/python-services/config_broadcast_service.py --config '"$CONFIG_FILE"' 2>&1 | tee '"$CMD_LOG_CONFIG"
[ -x "$CONFIG_BIN" ] && CMD_CONFIG='printf "\n  ══ CONFIG BROADCAST SERVICE (C++) — config packets to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$CONFIG_BIN"' --config '"$CONFIG_FILE"' 2>&1 | tee '"$CMD_LOG_CONFIG"
# Calibration service: reads raw DB PT/TC packets, publishes calibrated ones
CALIB_BIN="$PROJECT/build/bin/calibration_service"
[ ! -x "$CALIB_BIN" ] && CALIB_BIN="$PROJECT/build/bin/calibration_service"
CMD_LOG_CALIBRATION="/tmp/gui_logs/calibration.log"
CMD_CALIBRATION='printf "\n  ══ CALIBRATION SERVICE — DB Raw → DB Calibrated ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && exec '"$CALIB_BIN"' --config '"$CONFIG_FILE"' 2>&1 | tee '"$CMD_LOG_CALIBRATION"

# Split the rightmost (max index) pane each time so pane creation order is 0..11 as listed above.
# Re-tile after each split so widths stay usable. IMPORTANT: pass one shell string to tmux (like
# legacy scripts). Separate argv (bash --norc -c $q) does not run the command — panes exit → "dead".
tmux_split_right() {
  local last cmd escaped
  last=$(LC_ALL=C tmux list-panes -t "$SESSION:main" -F '#{pane_index}' | sort -n | tail -1)
  cmd="$1"
  # IMPORTANT: Do NOT wrap the -c payload in single quotes.
  # Your CMD_* strings contain embedded quotes (e.g. ''$VAR''), which would terminate
  # the outer single-quoted string and make panes immediately exit as "dead".
  # We POSIX-quote the payload so tmux (/bin/sh -c) can parse it reliably.
  escaped="$("$PYTHON_BIN" -c 'import shlex,sys; print(shlex.quote(sys.argv[1]))' "$cmd")"
  tmux split-window -h -t "$SESSION:main.${last}" \
    "bash --norc --noprofile -c ${escaped}"
  tmux select-layout -t "$SESSION:main" tiled
}

# ── Launch mode: tmux (interactive) or background (no-TTY fallback) ─────────

launch_background() {
  # Run all services as background processes (used when tmux is unavailable).
  mkdir -p /tmp/gui_logs
  local LOGDIR=/tmp/gui_logs

  echo ""
  echo "  📦 Launching services as background processes (no tmux available)"
  echo ""

  # Elodin DB first
  nohup bash -c "mkdir -p '$HOME/.local/share/elodin' && exec $ELODIN_DB_BIN run '[::]:2240' '$ELODIN_DB_DIR'" >> "$LOGDIR/db.log" 2>&1 &
  echo "    DB:           PID $! → $LOGDIR/db.log"

  # Wait for DB
  echo -n "    Waiting for Elodin DB..."
  for i in $(seq 1 30); do
    (echo >/dev/tcp/127.0.0.1/2240) 2>/dev/null && break
    sleep 1
    echo -n "."
  done
  echo " ready"

  # DAQ bridge
  nohup bash -c "cd '$PROJECT' && exec '$DAQ_BIN' '$CONFIG_FILE'" >> "$LOGDIR/daq.log" 2>&1 &
  echo "    DAQ bridge:   PID $! → $LOGDIR/daq.log"

  # Calibration service
  nohup bash -c "cd '$PROJECT' && exec '$CALIB_BIN' --config '$CONFIG_FILE'" >> "$LOGDIR/calibration.log" 2>&1 &
  echo "    Calibration:  PID $! → $LOGDIR/calibration.log"

  # Sequencer
  if [ -x "$SEQ_BIN" ]; then
    nohup bash -c "cd '$PROJECT' && exec '$SEQ_BIN' --config '$CONFIG_FILE' --port 9998" >> "$LOGDIR/sequencer.log" 2>&1 &
    echo "    Sequencer:    PID $! → $LOGDIR/sequencer.log"
  fi

  # Heartbeat
  nohup bash -c "cd '$PROJECT' && exec '$PYTHON_BIN' archive/legacy/python-services/heartbeat_service.py --config '$CONFIG_FILE'" >> "$LOGDIR/heartbeat.log" 2>&1 &
  echo "    Heartbeat:    PID $! → $LOGDIR/heartbeat.log"

  # Config broadcast
  if [ -x "$CONFIG_BIN" ]; then
    nohup bash -c "cd '$PROJECT' && exec '$CONFIG_BIN' --config '$CONFIG_FILE'" >> "$LOGDIR/config.log" 2>&1 &
    echo "    Config:       PID $! → $LOGDIR/config.log"
  fi

  # Controller — wait for calibration VTables (subscribes to calibrated PT data)
  if [ -x "$CTRL_BIN" ]; then
    echo -n "    Waiting for calibration service VTables (for controller)..."
    for i in $(seq 1 60); do
      grep -q "registered calibrated VTables, subscribed" "$LOGDIR/calibration.log" 2>/dev/null && break
      sleep 0.5
      echo -n "."
    done
    echo " ready"
    nohup bash -c "cd '$PROJECT' && exec '$CTRL_BIN' $CTRL_OPTS" >> "$LOGDIR/controller.log" 2>&1 &
    echo "    Controller:   PID $! → $LOGDIR/controller.log"
  fi

  # Backend — wait for DAQ bridge and calibration VTables before subscribing
  echo -n "    Waiting for DAQ bridge VTables..."
  for i in $(seq 1 60); do
    grep -q "Drain complete, ready for TABLE data" "$LOGDIR/daq.log" 2>/dev/null && break
    sleep 0.5
    echo -n "."
  done
  echo " ready"
  echo -n "    Waiting for calibration service VTables..."
  for i in $(seq 1 60); do
    grep -q "registered calibrated VTables, subscribed" "$LOGDIR/calibration.log" 2>/dev/null && break
    sleep 0.5
    echo -n "."
  done
  echo " ready"
  nohup bash -c "cd '$PROJECT/diablo_server/backend' && WS_PORT='${THIN_WS_PORT}' ELODIN_HOST=127.0.0.1 ELODIN_PORT=2240 ACTUATOR_SERVICE_PORT='${THIN_ACT_PORT}' exec npx tsx watch src/server.ts" >> "$LOGDIR/backend.log" 2>&1 &
  echo "    Backend:      PID $! → $LOGDIR/backend.log"

  # Frontend
  nohup bash -c "cd '$PROJECT/diablo_server/frontend' && exec npm run dev" >> "$LOGDIR/frontend.log" 2>&1 &
  echo "    Frontend:     PID $! → $LOGDIR/frontend.log"

  # Simulator LAST (if USE_SIM=1) — wait for backend; same args as tmux CMD_SIM (full startup)
  if [ "${USE_SIM:-0}" = "1" ]; then
    echo -n "    Waiting for backend WS (port ${THIN_WS_PORT})..."
    for i in $(seq 1 40); do
      (echo >/dev/tcp/127.0.0.1/${THIN_WS_PORT}) 2>/dev/null && break
      sleep 1
      echo -n "."
    done
    echo " ready"
    nohup bash -c "cd '$PROJECT' && exec '$PYTHON_BIN' sim/board_simulator.py --config '$CONFIG_FILE' --target 127.0.0.1 --port 5006" >> "$LOGDIR/sim.log" 2>&1 &
    echo "    Simulator:    PID $! → $LOGDIR/sim.log"
  fi

  echo ""
  echo "  ✅ Stack running. Logs: /tmp/gui_logs/"
  echo "  Pipeline: Sim → UDP → daq_bridge → Elodin DB → calibration → backend :${THIN_WS_PORT} → frontend :3000"
  echo ""
}

sim_escaped="$("$PYTHON_BIN" -c 'import shlex,sys; print(shlex.quote(sys.argv[1]))' "$CMD_SIM")"
if tmux new-session -d -s "$SESSION" -n main -x 240 -y 70 \
  "bash --norc --noprofile -c ${sim_escaped}" 2>/dev/null; then

  tmux set-option -t "$SESSION" remain-on-exit on
  tmux set-option -t "$SESSION" mouse on

  export USE_SIM="${USE_SIM:-0}"
  if [ "$USE_SIM" = "1" ]; then
    echo -e "\n  🔌 STARTING BOARD SIMULATOR (pane 0)"
  else
    echo -e "\n  🚫 BOARD SIMULATOR DISABLED (set USE_SIM=1 to enable) — pane 0"
  fi

  tmux_split_right "$CMD_DAQ"
  tmux_split_right "$CMD_DB"
  tmux_split_right "$CMD_CALIBRATION"
  tmux_split_right "$CMD_WEB_BACKEND"
  tmux_split_right "$CMD_WEB_FRONTEND"
  tmux_split_right "$CMD_HEARTBEAT"
  tmux_split_right "$CMD_CONFIG"
  tmux_split_right "$CMD_SEQUENCER"
  tmux_split_right "$CMD_OTA"
  tmux_split_right "$CMD_CTRL"

  tmux select-layout -t "$SESSION:main" tiled
  tmux select-pane -t "$SESSION:main.4"

  echo "┌─────────────────────────────────────────────────────────────┐"
  echo "│  Pipeline: UDP → daq_bridge → DB → backend → UI               │"
  echo "│  0: Simulator   1: DAQ bridge   2: Elodin DB                  │"
  echo "│  3: Calibration  4: Backend :${THIN_WS_PORT}  5: Frontend :3000 │"
  echo "│  6: Heartbeat   7: Config   8: Sequencer :9998                │"
  echo "│  9: Ethernet OTA :${OTA_CMD_PORT}  10: Controller                │"
  echo "│  USE_SIM=1 enables simulator                                  │"
  echo "│  Override: THIN_WS_PORT THIN_ACTUATOR_SERVICE_PORT OTA_SERVICE_CMD_PORT │"
  echo "│  Ctrl+B arrows=switch  D=detach                              │"
  echo "└─────────────────────────────────────────────────────────────┘"
  # TMUX_ATTACH=0: start session detached (automation / scripts). Default: attach for interactive use.
  if [ "${TMUX_ATTACH:-1}" != "0" ]; then
    tmux attach -t "$SESSION"
  else
    echo "  Tmux session '$SESSION' running detached (attach: tmux attach -t $SESSION)"
  fi
else
  echo "  ⚠️  tmux unavailable (no TTY?) — falling back to background processes"
  launch_background
fi
