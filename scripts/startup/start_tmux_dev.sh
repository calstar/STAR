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

# Build C++ binaries (ensures daq_bridge, sequencer, heartbeat, etc. are up to date)
echo "🔨 Building C++ binaries..."
ROOT_BUILD="$PROJECT/build"
NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
SIM_FLAG="-DUSE_SIM=${USE_SIM:-0}"
# Always reconfigure to ensure SIM flag is applied correctly
cmake -S "$PROJECT" -B "$ROOT_BUILD" "$SIM_FLAG" -Wno-dev 2>/dev/null || { echo "❌ CMake configure failed"; exit 1; }
cmake --build "$ROOT_BUILD" -j"$NPROC" 2>&1 | tail -5 || { echo "❌ C++ build failed"; exit 1; }
echo "  ✅ C++ binaries built"

# Ensure web-gui dependencies are installed (tmux panes assume they exist).
if [ ! -d "$PROJECT/web-gui/backend/node_modules" ]; then
  echo "📦 Installing web-gui backend dependencies..."
  (cd "$PROJECT/web-gui/backend" && npm install) || { echo "❌ backend npm install failed"; exit 1; }
fi
if [ ! -d "$PROJECT/web-gui/frontend/node_modules" ]; then
  echo "📦 Installing web-gui frontend dependencies..."
  (cd "$PROJECT/web-gui/frontend" && npm install) || { echo "❌ frontend npm install failed"; exit 1; }
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
pkill -9 -f "build/FSW/daq_bridge\|FSW/build/daq_bridge" 2>/dev/null || true
pkill -9 -f "build/FSW/sequencer_service\|FSW/build/sequencer_service" 2>/dev/null || true
pkill -9 -f "build/FSW/heartbeat_service\|FSW/build/heartbeat_service" 2>/dev/null || true
pkill -9 -f "build/FSW/config_broadcast_service\|FSW/build/config_broadcast_service" 2>/dev/null || true
pkill -9 -f "build/FSW/calibration_service\|FSW/build/calibration_service" 2>/dev/null || true
pkill -9 -f "build/FSW/controller_service\|FSW/build/controller_service" 2>/dev/null || true
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

OTA_BIN="$PROJECT/build/FSW/ota_service"
if [ ! -x "$OTA_BIN" ]; then
  OTA_BIN="$PROJECT/FSW/build/ota_service"
fi
pkill -f "ota_service" 2>/dev/null || true

# wait_for_elodin: poll until Elodin DB is accepting TCP connections on port 2240.
# Replaces fixed sleep delays so services start as soon as the DB is ready.
WAIT_FOR_ELODIN='echo "  ⏳ Waiting for Elodin DB (port 2240)..." && for i in $(seq 1 30); do (echo >/dev/tcp/127.0.0.1/2240) 2>/dev/null && break; sleep 1; done'

# Publisher: writes UDP sensor data → Elodin DB. Without this, nothing is written to the DB.
DAQ_BIN="$PROJECT/build/FSW/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  DAQ_BIN="$PROJECT/FSW/build/daq_bridge"
fi
# DAQ must wait for Elodin DB to be ready.
CMD_LOG_DAQ="/tmp/gui_logs/daq.log"
CMD_DAQ='printf "\n  ══ DAQ BRIDGE (writes to Elodin — UDP from config → DB) ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && exec '"$DAQ_BIN"' config/config.toml 2>&1 | tee '"$CMD_LOG_DAQ"

# Controller Service: Reads CALIBRATED DB → UDP out + Diagnostics DB
CTRL_BIN="$PROJECT/build/FSW/controller_service"
if [ ! -x "$CTRL_BIN" ]; then
  CTRL_BIN="$PROJECT/FSW/build/controller_service"
fi
CTRL_LUT="${LUT_PATH:-$PROJECT/output/lut/controller_policy_fsw.bin}"
CTRL_OPTS="--config config/config.toml --elodin-host 127.0.0.1"
[ -f "$CTRL_LUT" ] && CTRL_OPTS="$CTRL_OPTS --lut-path $CTRL_LUT"
CMD_LOG_CTRL="/tmp/gui_logs/controller.log"
CMD_CTRL='printf "\n  ══ CONTROLLER SERVICE (DB Calibrated → Actuators) ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && exec '"$CTRL_BIN"' '"$CTRL_OPTS"' 2>&1 | tee '"$CMD_LOG_CTRL"

# Sequencer service: state machine + actuator UDP (same TCP :9998 text protocol as server.ts)
SEQ_BIN="$PROJECT/build/FSW/sequencer_service"
if [ ! -x "$SEQ_BIN" ]; then
  SEQ_BIN="$PROJECT/FSW/build/sequencer_service"
fi
if [ -x "$SEQ_BIN" ]; then
  CMD_LOG_SEQUENCER="/tmp/gui_logs/sequencer.log"
  CMD_SEQUENCER='printf "\n  ══ SEQUENCER SERVICE (TCP :9998 — TRANSITION / ACTUATOR / …) ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && exec '"$SEQ_BIN"' --config config/config.toml --port 9998 2>&1 | tee '"$CMD_LOG_SEQUENCER"
else
  CMD_SEQUENCER='printf "\n  ❌ sequencer_service not found. Build: cd FSW/build && cmake .. && make sequencer_service\n\n" && sleep infinity'
fi

CMD_LOG_DB="/tmp/gui_logs/db.log"
CMD_DB='printf "\n  ══ ELODIN DB — :2240 (raw data lands here only) ══\n\n" && mkdir -p '"$HOME"'/.local/share/elodin && RUST_LOG=debug exec '"$ELODIN_DB_BIN"' run "[::]:2240" "'"$ELODIN_DB_DIR"'" 2>&1 | tee '"$CMD_LOG_DB"

# Thin backend connects directly to Elodin DB (no relay needed)
THIN_WS_PORT="${THIN_WS_PORT:-8081}"
THIN_ACT_PORT="${THIN_ACTUATOR_SERVICE_PORT:-9998}"
CMD_LOG_BACKEND="/tmp/gui_logs/backend.log"
CMD_WEB_BACKEND='printf "\n  ══ BACKEND — HTTP+WS :'"${THIN_WS_PORT}"' (server.ts → Elodin DB :2240) ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"'/web-gui/backend && WS_PORT='"$THIN_WS_PORT"' ELODIN_HOST=127.0.0.1 ELODIN_PORT=2240 ACTUATOR_SERVICE_PORT='"$THIN_ACT_PORT"' npx tsx watch src/server.ts 2>&1 | tee '"$CMD_LOG_BACKEND"

CMD_LOG_FRONTEND="/tmp/gui_logs/frontend.log"
CMD_WEB_FRONTEND='printf "\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n" && sleep 3 && cd '"$PROJECT"'/web-gui/frontend && OTA_SERVICE_PORT='"$OTA_CMD_PORT"' NEXT_PUBLIC_WS_URL=ws://127.0.0.1:'"${THIN_WS_PORT}"' npm run dev 2>&1 | tee '"$CMD_LOG_FRONTEND"

if [ -x "$OTA_BIN" ]; then
  CMD_LOG_OTA="/tmp/gui_logs/ota.log"
  CMD_OTA='printf "\n  ══ ETHERNET OTA SERVICE — TCP :'"${OTA_CMD_PORT}"' (pio build+flash here) ══\n\n" && exec '"$OTA_BIN"' --port '"$OTA_CMD_PORT"' 2>&1 | tee '"$CMD_LOG_OTA"
else
  CMD_OTA='printf "\n  ❌ ota_service not built — cd FSW/build && cmake .. && make ota_service\n\n" && sleep infinity'
fi

# Board simulator (pane 0); set USE_SIM=1 to run (default off for real hardware)
if [ "${USE_SIM:-0}" = "1" ]; then
  CMD_LOG_SIM="/tmp/gui_logs/sim.log"
  CMD_SIM='printf "\n  ══ BOARD SIMULATOR — UDP → :5006 (All Boards) ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && ([ -x scripts/setup_sim_network.sh ] && scripts/setup_sim_network.sh || true) && exec '"$PYTHON_BIN"' scripts/board_simulator.py --config config/config.toml --target 127.0.0.1 --port 5006 2>&1 | tee '"$CMD_LOG_SIM"
else
  CMD_SIM='printf "\n  ══ BOARD SIMULATOR — DISABLED (USE_SIM=1 to enable) ══\n\n" && sleep infinity'
fi
# Heartbeat service: C++ preferred (flight-ready), Python fallback — poll /api/engine_state on thin HTTP port
HEARTBEAT_BIN="$PROJECT/build/FSW/heartbeat_service"
[ ! -x "$HEARTBEAT_BIN" ] && HEARTBEAT_BIN="$PROJECT/FSW/build/heartbeat_service"
HB_BACKEND_URL="http://127.0.0.1:${THIN_WS_PORT}"
# Python heartbeat polls /api/engine_state; C++ reads sequencer state from Elodin (no backend URL).
CMD_LOG_HB="/tmp/gui_logs/heartbeat.log"
CMD_HEARTBEAT='printf "\n  ══ HEARTBEAT SERVICE — SERVER_HEARTBEAT to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$PYTHON_BIN"' scripts/services/heartbeat_service.py --config config/config.toml --backend-url '"$HB_BACKEND_URL"' 2>&1 | tee '"$CMD_LOG_HB"
[ -x "$HEARTBEAT_BIN" ] && CMD_HEARTBEAT='printf "\n  ══ HEARTBEAT SERVICE (C++) — SERVER_HEARTBEAT to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$HEARTBEAT_BIN"' --config config/config.toml 2>&1 | tee '"$CMD_LOG_HB"
# Config broadcast service: C++ preferred (flight-ready), Python fallback
CONFIG_BIN="$PROJECT/build/FSW/config_broadcast_service"
[ ! -x "$CONFIG_BIN" ] && CONFIG_BIN="$PROJECT/FSW/build/config_broadcast_service"
CMD_LOG_CONFIG="/tmp/gui_logs/config.log"
CMD_CONFIG='printf "\n  ══ CONFIG BROADCAST SERVICE — config packets to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$PYTHON_BIN"' scripts/services/config_broadcast_service.py --config config/config.toml 2>&1 | tee '"$CMD_LOG_CONFIG"
[ -x "$CONFIG_BIN" ] && CMD_CONFIG='printf "\n  ══ CONFIG BROADCAST SERVICE (C++) — config packets to boards ══\n\n" && sleep 6 && cd '"$PROJECT"' && exec '"$CONFIG_BIN"' --config config/config.toml 2>&1 | tee '"$CMD_LOG_CONFIG"
# Calibration service: reads raw DB PT/TC packets, publishes calibrated ones
CALIB_BIN="$PROJECT/build/FSW/calibration_service"
[ ! -x "$CALIB_BIN" ] && CALIB_BIN="$PROJECT/FSW/build/calibration_service"
CMD_LOG_CALIBRATION="/tmp/gui_logs/calibration.log"
CMD_CALIBRATION='printf "\n  ══ CALIBRATION SERVICE — DB Raw → DB Calibrated ══\n\n" && '"$WAIT_FOR_ELODIN"' && cd '"$PROJECT"' && exec '"$CALIB_BIN"' --config config/config.toml 2>&1 | tee '"$CMD_LOG_CALIBRATION"

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

  # Simulator (if USE_SIM=1)
  if [ "${USE_SIM:-0}" = "1" ]; then
    nohup bash -c "cd '$PROJECT' && exec '$PYTHON_BIN' engine_sim/board_simulator.py --config config/config.toml" >> "$LOGDIR/sim.log" 2>&1 &
    echo "    Simulator:    PID $! → $LOGDIR/sim.log"
    sleep 1
  fi

  # DAQ bridge
  nohup bash -c "cd '$PROJECT' && exec '$DAQ_BIN' config/config.toml" >> "$LOGDIR/daq.log" 2>&1 &
  echo "    DAQ bridge:   PID $! → $LOGDIR/daq.log"

  # Calibration service
  nohup bash -c "cd '$PROJECT' && exec '$CALIB_BIN' --config config/config.toml" >> "$LOGDIR/calibration.log" 2>&1 &
  echo "    Calibration:  PID $! → $LOGDIR/calibration.log"

  # Sequencer
  if [ -x "$SEQ_BIN" ]; then
    nohup bash -c "cd '$PROJECT' && exec '$SEQ_BIN' --config config/config.toml --port 9998" >> "$LOGDIR/sequencer.log" 2>&1 &
    echo "    Sequencer:    PID $! → $LOGDIR/sequencer.log"
  fi

  # Heartbeat
  nohup bash -c "cd '$PROJECT' && exec '$PYTHON_BIN' scripts/services/heartbeat_service.py --config config/config.toml" >> "$LOGDIR/heartbeat.log" 2>&1 &
  echo "    Heartbeat:    PID $! → $LOGDIR/heartbeat.log"

  # Config broadcast
  if [ -x "$CONFIG_BIN" ]; then
    nohup bash -c "cd '$PROJECT' && exec '$CONFIG_BIN' --config config/config.toml" >> "$LOGDIR/config.log" 2>&1 &
    echo "    Config:       PID $! → $LOGDIR/config.log"
  fi

  # Controller
  if [ -x "$CTRL_BIN" ]; then
    nohup bash -c "cd '$PROJECT' && exec '$CTRL_BIN' $CTRL_OPTS" >> "$LOGDIR/controller.log" 2>&1 &
    echo "    Controller:   PID $! → $LOGDIR/controller.log"
  fi

  # Backend (wait a moment for DB-dependent services)
  sleep 2
  nohup bash -c "cd '$PROJECT/web-gui/backend' && WS_PORT='${THIN_WS_PORT}' ELODIN_HOST=127.0.0.1 ELODIN_PORT=2240 ACTUATOR_SERVICE_PORT='${THIN_ACT_PORT}' exec npx tsx watch src/server.ts" >> "$LOGDIR/backend.log" 2>&1 &
  echo "    Backend:      PID $! → $LOGDIR/backend.log"

  # Frontend
  nohup bash -c "cd '$PROJECT/web-gui/frontend' && NEXT_PUBLIC_WS_URL='ws://127.0.0.1:${THIN_WS_PORT}' exec npm run dev" >> "$LOGDIR/frontend.log" 2>&1 &
  echo "    Frontend:     PID $! → $LOGDIR/frontend.log"

  echo ""
  echo "  ✅ Stack running. Logs: /tmp/gui_logs/"
  echo "  Pipeline: Sim → UDP → daq_bridge → Elodin DB → calibration → backend :${THIN_WS_PORT} → frontend :3000"
  echo ""
}

if tmux new-session -d -s "$SESSION" -n main -x 240 -y 70 \
  "bash --norc --noprofile -c '$CMD_SIM'" 2>/dev/null; then

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
  tmux attach -t "$SESSION"
else
  echo "  ⚠️  tmux unavailable (no TTY?) — falling back to background processes"
  launch_background
fi
