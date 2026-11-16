#!/bin/bash
# Pipeline characterization: board_simulator → daq_bridge → elodin-db → calibration_service →
# backend (server.ts) → WebSocket + HTTP, with sequencer_service behind the backend's command path.
# Two scripted sessions (session.ts) are recorded, normalised (normalize.py) and compared against
# goldens (characterize.py). CHAR_UPDATE=1 rewrites the goldens instead.
#
#   bash test/characterization/pipeline/run.sh            # both sessions
#   bash test/characterization/pipeline/run.sh pt         # one routed PT board, the full script → golden/
#   bash test/characterization/pipeline/run.sh boards     # every simulated board type → golden/boards/
#
# "boards" needs the board_id loopback aliases (127.0.0.<id>) on macOS; it fails, never skips,
# when one is missing. Linux has all of 127/8.
#
# Takes the machine-wide stack lock itself (re-entrant under gate.sh / run.sh). Off the stand
# only. Every service runs against a private fixture tree in .tmp/char_pipeline_<pid>/ with its
# board IPs on loopback and its ports in 264xx; nothing in the checkout is moved or written.
#
# Env: CHAR_BUILD_DIR (default build-gate/ or build/), CHAR_KEEP=1 keeps the fixture and logs,
#      CHAR_CAPTURE_ONLY=<path> copies the raw capture there and skips the comparison.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../../.." && pwd -P)"   # daq-server/

if [ "${DAQ_STACK_LOCK_HELD:-}" = "" ]; then
  exec bash "$ROOT/test/characterization/with_stack_lock.sh" bash "$HERE/run.sh" "$@"
fi

MODE="${1:-all}"
if [ "$MODE" = all ]; then
  rc=0
  bash "$HERE/run.sh" pt || rc=1
  bash "$HERE/run.sh" nocal || rc=1
  bash "$HERE/run.sh" boards || rc=1
  exit $rc
fi
case "$MODE" in pt|nocal|boards) ;; *) echo "usage: run.sh [pt|nocal|boards]" >&2; exit 2 ;; esac

if [ "$(hostname)" = "star-rfs" ] || { command -v ip >/dev/null && ip -4 -o addr | grep -q ' 192\.168\.2\.'; } \
  || ifconfig 2>/dev/null | grep -q 'inet 192\.168\.2\.'; then
  echo "pipeline: this is the stand (star-rfs / board LAN). Refusing to run." >&2
  exit 3
fi

# The boards session sends as every simulated board from 127.0.0.<board_id>. Same list as
# test/test_integration.sh: every board_id octet in config_base.toml plus the startup board (60).
if [ "$MODE" = boards ] && [ "$(uname)" = "Darwin" ]; then
  missing=()
  for i in 11 12 13 14 21 22 25 31 32 41 42 51 52 60 61 71; do
    ifconfig lo0 2>/dev/null | grep -q "inet 127\.0\.0\.$i " || missing+=("127.0.0.$i")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "pipeline: the boards session needs loopback aliases that are missing: ${missing[*]}" >&2
    echo "          add them (as test_integration.sh does):" >&2
    echo "          for i in 11 12 13 14 21 22 25 31 32 41 42 51 52 60 61 71; do sudo ifconfig lo0 alias 127.0.0.\$i up; done" >&2
    exit 7
  fi
fi

BUILD="${CHAR_BUILD_DIR:-}"
if [ -z "$BUILD" ]; then
  for b in "$ROOT/build-gate" "$ROOT/build"; do [ -x "$b/bin/daq_bridge" ] && BUILD="$b" && break; done
fi
BIN="$BUILD/bin"
for b in daq_bridge sequencer_service calibration_service config_broadcast_service; do
  [ -x "$BIN/$b" ] || { echo "pipeline: $BIN/$b missing — run scripts/build.sh" >&2; exit 2; }
done
# elodin-db: the version CI and setup.sh pin. Another version is a different DB with different
# wire behaviour (0.14.2 answers this stack's subscriptions with VTableNotFound/InvalidMsgId and
# delivers nothing), so it is refused rather than recorded. ELODIN_DB overrides the lookup.
ELODIN_PIN="0.16.1"
ELODIN_DB="${ELODIN_DB:-$HOME/.cargo/bin/elodin-db}"
[ -x "$ELODIN_DB" ] || ELODIN_DB="$(command -v elodin-db || true)"
[ -n "$ELODIN_DB" ] || { echo "pipeline: elodin-db not found" >&2; exit 2; }
ELODIN_VER="$("$ELODIN_DB" --version 2>/dev/null | awk '{print $2}')"
if [ "$ELODIN_VER" != "$ELODIN_PIN" ]; then
  echo "pipeline: $ELODIN_DB is elodin-db $ELODIN_VER; this golden needs $ELODIN_PIN (the CI pin)." >&2
  echo "          Point ELODIN_DB at a $ELODIN_PIN binary (release elodin-db-<arch>.tar.gz)." >&2
  exit 2
fi
BACKEND="$ROOT/diablo_server/backend"
TSX="$BACKEND/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "pipeline: $TSX missing — npm ci in diablo_server/backend" >&2; exit 2; }
PY="$(command -v python3)"

# Private port range. 5008 is the one port daq_bridge hard-codes (FSWConfigManager); the stack
# lock is what keeps it free.
P_ELODIN=26401 P_DAQ_UDP=26402 P_WS=26403 P_ACT_UDP=26404 P_LOG_UDP=26405
P_SEQ=26406 P_CTRL=26407 P_HB_UDP=26408 P_START=26409 P_VID_API=26411 P_VID_RTC=26412 P_VID_AGENT=26413 P_OTA=26414

mkdir -p "$ROOT/.tmp"
FX="$ROOT/.tmp/char_pipeline_${MODE}_$$"
rm -rf "$FX"; mkdir -p "$FX/logs"
PIDS=()
cleanup() {
  set +e
  # config_broadcast_service is started by session.ts (boards), which records its PID here.
  [ -f "$FX/config_broadcast.pid" ] && PIDS+=("$(cat "$FX/config_broadcast.pid")")
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  if [ "${CHAR_KEEP:-0}" = 1 ]; then echo "pipeline: kept $FX"; else rm -rf "$FX"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for port in $P_ELODIN $P_WS $P_SEQ; do
  if (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
    echo "pipeline: port $port is already in use — another stack is up outside the lock" >&2; exit 4
  fi
done

cat > "$FX/ports.json" <<EOF
{"elodin":$P_ELODIN,"daq_udp":$P_DAQ_UDP,"ws":$P_WS,"act_udp":$P_ACT_UDP,"log_udp":$P_LOG_UDP,
 "sequencer":$P_SEQ,"controller":$P_CTRL,"hb_udp":$P_HB_UDP,"startup_udp":$P_START,"video_api":$P_VID_API,
 "video_webrtc":$P_VID_RTC,"video_agent":$P_VID_AGENT,"ota":$P_OTA}
EOF
FXMODE="$MODE"; [ "$MODE" = nocal ] && FXMODE=pt
"$PY" "$HERE/make_fixture.py" "$ROOT" "$FX" "$FX/ports.json" "$FXMODE"

# The backend runs from a copy of its own source under the fixture (srv/, the same layout as
# daq-server/), so everything it resolves relative to its own file lands in the fixture rather
# than in the checkout: its PT calibration (calibration.ts: <srv>/calibration/*.json, newest by
# mtime -- in a checkout every committed file shares one mtime, so the pick was filesystem order:
# macOS got one dated file, a Linux export another with no coefficients), /api/cubic_calibration
# (<srv>/scripts/calibration/calibrations), the legacy state-CSV loaders (<srv>/../config = the
# fixture's), the state-script checker (<srv>/build). The source is copied unchanged from this
# checkout at every run, so a change to it is what runs. pt: one calibration file, chosen by name;
# nocal: none.
SRV="$FX/srv"
mkdir -p "$SRV/diablo_server/backend" "$SRV/calibration" "$SRV/scripts/calibration"
cp -R "$BACKEND/src" "$BACKEND/package.json" "$SRV/diablo_server/backend/"
ln -s "$BACKEND/node_modules" "$SRV/diablo_server/backend/node_modules"
cp -R "$ROOT/diablo_server/shared" "$SRV/diablo_server/shared"
ln -s "$FX/scripts/calibration/calibrations" "$SRV/scripts/calibration/calibrations"
ln -s "$BUILD" "$SRV/build"
[ "$MODE" = nocal ] || cp "$ROOT/calibration/calibration_2026-02-25T03-44-09.json" "$SRV/calibration/"
CFG="$FX/config/config.toml"

wait_port() {  # port name seconds
  local i=0
  while ! (echo >/dev/tcp/127.0.0.1/$1) 2>/dev/null; do
    sleep 0.25; i=$((i + 1))
    [ $i -lt $(($3 * 4)) ] || { echo "pipeline: $2 never listened on :$1" >&2; tail -20 "$FX/logs/$2.log" >&2; exit 5; }
  done
}
alive() {  # pid name
  kill -0 "$1" 2>/dev/null || { echo "pipeline: $2 exited early" >&2; tail -20 "$FX/logs/$2.log" >&2; exit 5; }
}

# Same start order as test/test_integration.sh: DB, sequencer, bridge, (config broadcast),
# backend, calibration, sim.
"$ELODIN_DB" run "127.0.0.1:$P_ELODIN" "$FX/elodin_db" > "$FX/logs/elodin.log" 2>&1 &
PIDS+=($!); wait_port $P_ELODIN elodin 15

(cd "$FX" && exec "$BIN/sequencer_service" --config "$CFG" --port $P_SEQ) > "$FX/logs/sequencer.log" 2>&1 &
PIDS+=($!); wait_port $P_SEQ sequencer 15
# At boot the sequencer publishes every valve de-energized (ActuatorCommander publishInitialState:
# a normally-open valve reads 1) and then applies the boot state's column (Fuel Main → 0). Whether
# the backend, subscribing a moment later, records that transient 1 in its history was a race
# (macOS missed it, Linux caught it). The initial publish happens on the sequencer's Elodin
# connect, which on a loaded machine can come from its retry thread after the boot state was
# applied; the 1 Hz republish then corrects it. So wait for the initial publish and a republish
# after it before starting the backend.
i=0
until awk '/Published initial state/ {seen=1; next} seen && /commands for state/ {found=1} END {exit !found}' \
      "$FX/logs/sequencer.log" 2>/dev/null; do
  sleep 0.25; i=$((i + 1))
  [ $i -lt 120 ] || { echo "pipeline: sequencer never applied its boot state" >&2; tail -20 "$FX/logs/sequencer.log" >&2; exit 5; }
done

(cd "$FX" && exec "$BIN/daq_bridge" "$CFG") > "$FX/logs/daq_bridge.log" 2>&1 &
PIDS+=($!); sleep 1; alive "${PIDS[-1]}" daq_bridge


# The backend runs from char/backend: its state-CSV loaders (legacy/state-actuators.ts,
# legacy/state-transitions.ts) look in <cwd>/../../config, as production's cwd
# (diablo_server/backend) sees daq-server/config.
(cd "$FX/char/backend" && exec env -u USE_SIM -u RUNNING_CONFIG_PATH -u COUNTDOWN_STATE_PATH \
  -u SESSION_STATE_PATH -u VIDEO_CONFIG_PATH -u VIDEO_SECRETS_PATH -u REPLAY_MODE -u ELODIN_DEBUG \
  -u THIN_VERBOSE_CONNECTION_LOG -u THIN_HEARTBEAT_DIAG_LOG -u THIN_STATS_LOG \
  -u SESSION_WARN_LEADS_MS -u SESSION_WARN_LEAD_MS \
  HOME="$FX/home" WS_PORT=$P_WS GUI_PORT=0 ELODIN_HOST=127.0.0.1 ELODIN_PORT=$P_ELODIN \
  ACTUATOR_SERVICE_PORT=$P_SEQ CONTROLLER_SERVICE_PORT=$P_CTRL OTA_SERVICE_PORT=$P_OTA \
  LOG_INGEST_PORT=$P_LOG_UDP CONFIG_PATH="$CFG" SESSION_SERVICE_MODE=mock \
  DAQ_CALIBRATIONS_DIR="$FX/scripts/calibration/calibrations" \
  DAQ_OPERATORS_FILE="$FX/operators.txt" STAR_DHCP_HOSTS="$FX/no-dhcp-hosts" \
  VIDEO_GATEWAY_HOST=127.0.0.1 VIDEO_GATEWAY_API_PORT=$P_VID_API \
  VIDEO_GATEWAY_WEBRTC_PORT=$P_VID_RTC VIDEO_AGENT_PORT=$P_VID_AGENT \
  "$TSX" "$SRV/diablo_server/backend/src/server.ts") > "$FX/logs/backend.log" 2>&1 &
PIDS+=($!); wait_port $P_WS backend 30

(cd "$FX" && exec env -u CAL_BACKUP_PATH -u CAL_VERBOSE "$BIN/calibration_service" --config "$CFG" \
  --adjustments "$FX/adjustments.json" --elodin-host 127.0.0.1 --elodin-port $P_ELODIN) \
  > "$FX/logs/calibration.log" 2>&1 &
PIDS+=($!); sleep 1; alive "${PIDS[-1]}" calibration

# The simulator sends each board's SELF_TEST once, at start. The backend subscribes to the
# self-test tables in passes capped by the request-id space; a result published before the pass
# that covers its table never reaches it (seen on Linux: board 21's sensors 2-10 lost). Start the
# simulator only after a pass with nothing left queued.
i=0
until grep 'VTableStream: sent' "$FX/logs/backend.log" 2>/dev/null | grep -vq 'queued for the next pass'; do
  sleep 0.25; i=$((i + 1))
  [ $i -lt 240 ] || { echo "pipeline: backend never finished subscribing" >&2; tail -20 "$FX/logs/backend.log" >&2; exit 5; }
done
sleep 1

# --low-noise: constant ADC per channel. No timing pathologies, no --allow-ip-fallback: the pt
# sim config enables only pt_board, at 127.0.0.1; the boards one every board at 127.0.0.<id>.
"$PY" "$ROOT/sim/board_simulator.py" --config "$FX/sim_config.toml" --target 127.0.0.1 \
  --port $P_DAQ_UDP --low-noise --skip-startup > "$FX/logs/sim.log" 2>&1 &
PIDS+=($!); sleep 1; alive "${PIDS[-1]}" sim

if [ -n "${CHAR_HOLD:-}" ]; then  # debugging: leave the stack up for poking, then tear down
  echo "pipeline: stack up (ws :$P_WS, fixture $FX); holding ${CHAR_HOLD}s"; sleep "$CHAR_HOLD"; exit 0
fi

START_MS="$("$PY" -c 'import time; print(int(time.time()*1000))')"
CAPTURE="$FX/capture.json"
(cd "$BACKEND" && NODE_PATH="$BACKEND/node_modules" PYTHON_BIN="$PY" \
  BOARD_STARTUP_SIM="$ROOT/sim/board_startup_sim.py" CHAR_DAQ_UDP_PORT=$P_DAQ_UDP \
  CHAR_STARTUP_PORT=$P_START CHAR_CONFIG_BROADCAST="$BIN/config_broadcast_service" \
  CHAR_CONFIG="$CFG" CHAR_FIXTURE="$FX" "$TSX" "$HERE/session.ts" $P_WS "$CAPTURE" "$MODE") \
  > "$FX/logs/session.log" 2>&1 || { echo "pipeline: session failed" >&2; tail -30 "$FX/logs/session.log" >&2; tail -30 "$FX/logs/backend.log" >&2; exit 6; }

cat > "$FX/context.json" <<EOF
{"now_ms": $START_MS, "gui_points_per_second": $(sed -n "/^\[gui\]/,/^\[/s/^points_per_second = \([0-9.]*\)/\1/p" "$CFG"),
 "paths": {"$FX/config": "<cfgdir>", "$FX/home": "<home>", "$FX": "<fx>",
           "$ROOT": "<daq>"},
 "ports": $(cat "$FX/ports.json" | "$PY" -c 'import json,sys; print(json.dumps({str(v): k for k, v in json.load(sys.stdin).items()}))')}
EOF

if [ -n "${CHAR_CAPTURE_ONLY:-}" ]; then
  cp "$CAPTURE" "$CHAR_CAPTURE_ONLY"; cp "$FX/context.json" "$CHAR_CAPTURE_ONLY.context.json"
  echo "pipeline: capture saved to $CHAR_CAPTURE_ONLY"; exit 0
fi

OUT="$FX/out"
"$PY" "$HERE/characterize.py" "$CAPTURE" "$FX/context.json" "$OUT"
GOLD="$HERE/golden"; [ "$MODE" = boards ] && GOLD="$HERE/golden/boards"
[ "$MODE" = nocal ] && GOLD="$HERE/golden/nocal"
if [ "${CHAR_UPDATE:-0}" = 1 ]; then
  mkdir -p "$GOLD"; rm -f "$GOLD"/*.txt; cp "$OUT"/* "$GOLD/"
  echo "pipeline[$MODE]: goldens rewritten ($(ls "$OUT" | wc -l | tr -d ' ') files in ${GOLD#$HERE/})"
  exit 0
fi
if diff -ru -x boards -x nocal "$GOLD" "$OUT"; then
  echo "pipeline[$MODE]: PASS"
else
  echo "pipeline[$MODE]: FAIL — observable behaviour differs from ${GOLD#$HERE/} (diff above)" >&2
  exit 1
fi
