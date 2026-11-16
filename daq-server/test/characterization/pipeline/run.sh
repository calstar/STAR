#!/bin/bash
# Pipeline characterization: board_simulator → daq_bridge → elodin-db → calibration_service →
# backend (server.ts) → WebSocket + HTTP, with sequencer_service behind the backend's command path.
# One scripted session (session.ts) is recorded, normalised (normalize.py) and compared against
# golden/ (characterize.py). CHAR_UPDATE=1 rewrites the goldens instead.
#
#   bash test/characterization/pipeline/run.sh
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

if [ "$(hostname)" = "star-rfs" ] || { command -v ip >/dev/null && ip -4 -o addr | grep -q ' 192\.168\.2\.'; } \
  || ifconfig 2>/dev/null | grep -q 'inet 192\.168\.2\.'; then
  echo "pipeline: this is the stand (star-rfs / board LAN). Refusing to run." >&2
  exit 3
fi

BUILD="${CHAR_BUILD_DIR:-}"
if [ -z "$BUILD" ]; then
  for b in "$ROOT/build-gate" "$ROOT/build"; do [ -x "$b/bin/daq_bridge" ] && BUILD="$b" && break; done
fi
BIN="$BUILD/bin"
for b in daq_bridge sequencer_service calibration_service; do
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
# The backend's state-CSV loaders try <daq-server>/config/<csv> (via __dirname) before the
# fixture's. Those files are generated deploy artefacts (gitignored); if a checkout has them they
# would silently replace the fixture's tables.
for f in state_machine_actuators.csv state_transitions.csv state_machine_actuator_delays.csv; do
  if [ -e "$ROOT/config/$f" ]; then
    echo "pipeline: $ROOT/config/$f exists (a deployed profile) and would shadow the fixture's" >&2
    echo "          state tables in the backend; move it aside to run this." >&2
    exit 2
  fi
done

# Private port range. 5008 is the one port daq_bridge hard-codes (FSWConfigManager); the stack
# lock is what keeps it free.
P_ELODIN=26401 P_DAQ_UDP=26402 P_WS=26403 P_ACT_UDP=26404 P_LOG_UDP=26405
P_SEQ=26406 P_CTRL=26407 P_HB_UDP=26408 P_VID_API=26411 P_VID_RTC=26412 P_VID_AGENT=26413 P_OTA=26414

mkdir -p "$ROOT/.tmp"
FX="$ROOT/.tmp/char_pipeline_$$"
rm -rf "$FX"; mkdir -p "$FX/logs"
PIDS=()
cleanup() {
  set +e
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
 "sequencer":$P_SEQ,"controller":$P_CTRL,"hb_udp":$P_HB_UDP,"video_api":$P_VID_API,
 "video_webrtc":$P_VID_RTC,"video_agent":$P_VID_AGENT,"ota":$P_OTA}
EOF
"$PY" "$HERE/make_fixture.py" "$ROOT" "$FX" "$FX/ports.json"
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

# Same start order as test/test_integration.sh: DB, sequencer, bridge, backend, calibration, sim.
"$ELODIN_DB" run "127.0.0.1:$P_ELODIN" "$FX/elodin_db" > "$FX/logs/elodin.log" 2>&1 &
PIDS+=($!); wait_port $P_ELODIN elodin 15

(cd "$FX" && exec "$BIN/sequencer_service" --config "$CFG" --port $P_SEQ) > "$FX/logs/sequencer.log" 2>&1 &
PIDS+=($!); wait_port $P_SEQ sequencer 15

(cd "$FX" && exec "$BIN/daq_bridge" "$CFG") > "$FX/logs/daq_bridge.log" 2>&1 &
PIDS+=($!); sleep 1; alive "${PIDS[-1]}" daq_bridge

# The backend loads its own PT calibration (calibration.ts loadPTCalibration) from the newest
# daq-server/calibration/calibration*.json BY MTIME. A checkout, and a `git archive` export even
# more so, gives those committed files equal mtimes; the tie then falls to directory order, which
# differs by filesystem: macOS picked calibration_2026-02-25T03-44-09.json, Linux a file with no
# coefficients, so calibrationFilePath came out null. Pin the order the file names state: each
# file's mtime becomes the timestamp in its name. Content is untouched (git sees no change).
"$PY" - "$ROOT/calibration" <<'PYEOF'
import os, re, sys, calendar
d = sys.argv[1]
for name in os.listdir(d):
    m = re.fullmatch(r"calibration_(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)\.json", name)
    if m:
        t = calendar.timegm(tuple(int(x) for x in m.groups()) + (0, 0, 0))
        os.utime(os.path.join(d, name), (t, t))
PYEOF

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
  "$TSX" "$BACKEND/src/server.ts") > "$FX/logs/backend.log" 2>&1 &
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

# --low-noise: constant ADC per channel. No timing pathologies, no --allow-ip-fallback: the sim
# config enables only pt_board, at 127.0.0.1.
"$PY" "$ROOT/sim/board_simulator.py" --config "$FX/sim_config.toml" --target 127.0.0.1 \
  --port $P_DAQ_UDP --low-noise --skip-startup > "$FX/logs/sim.log" 2>&1 &
PIDS+=($!); sleep 1; alive "${PIDS[-1]}" sim

if [ -n "${CHAR_HOLD:-}" ]; then  # debugging: leave the stack up for poking, then tear down
  echo "pipeline: stack up (ws :$P_WS, fixture $FX); holding ${CHAR_HOLD}s"; sleep "$CHAR_HOLD"; exit 0
fi

START_MS="$("$PY" -c 'import time; print(int(time.time()*1000))')"
CAPTURE="$FX/capture.json"
(cd "$BACKEND" && NODE_PATH="$BACKEND/node_modules" "$TSX" "$HERE/session.ts" $P_WS "$CAPTURE") \
  > "$FX/logs/session.log" 2>&1 || { echo "pipeline: session failed" >&2; tail -30 "$FX/logs/session.log" >&2; tail -30 "$FX/logs/backend.log" >&2; exit 6; }

cat > "$FX/context.json" <<EOF
{"now_ms": $START_MS,
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
if [ "${CHAR_UPDATE:-0}" = 1 ]; then
  rm -rf "$HERE/golden"; mkdir -p "$HERE/golden"; cp "$OUT"/* "$HERE/golden/"
  echo "pipeline: goldens rewritten ($(ls "$HERE/golden" | wc -l | tr -d ' ') files)"
  exit 0
fi
if diff -ru "$HERE/golden" "$OUT"; then
  echo "pipeline: PASS"
else
  echo "pipeline: FAIL — the pipeline's observable behaviour differs from golden/ (diff above)" >&2
  exit 1
fi
