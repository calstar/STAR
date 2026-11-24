#!/bin/bash
# WP6 G12 (DESIGN-WP6 §6.3, startup-log diff): start src/server.ts alone for 5 s with the pipeline
# fixture's environment (CONFIG_PATH = a 127.0.0.x fixture config, SESSION_SERVICE_MODE=mock,
# GUI_PORT=0, 264xx ports, no Elodin, no sequencer) at a base revision and at HEAD (or the working
# tree), and diff the first 60 lines of output after normalising timestamps, PIDs and the fixture
# path. Identical output is the pass; it catches a moved log line.
#
#   bash test/remaster-checks/wp6-startup-log.sh <base-rev> [head-rev]
#
# Binds the pipeline's WS port, so it takes the machine-wide stack lock itself (re-entrant under a
# holder). Off the stand only (make_fixture.py rewrites every board to loopback). The fixture is
# built from THIS checkout's config (WP6 changes no config); only the backend source differs.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"   # daq-server/
if [ "${DAQ_STACK_LOCK_HELD:-}" = "" ]; then
  exec bash "$ROOT/test/characterization/with_stack_lock.sh" bash "$HERE/wp6-startup-log.sh" "$@"
fi
if [ "$(hostname)" = "star-rfs" ] || ifconfig 2>/dev/null | grep -q 'inet 192\.168\.2\.'; then
  echo "wp6-startup-log: this is the stand. Refusing to run." >&2; exit 3
fi
BASE="${1:?base rev}"; HEADREV="${2:-}"
BACKEND="$ROOT/diablo_server/backend"
TSX="$BACKEND/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "wp6-startup-log: $TSX missing — npm ci in diablo_server/backend" >&2; exit 2; }
PY="$(command -v python3)"
P_ELODIN=26401 P_DAQ_UDP=26402 P_WS=26403 P_ACT_UDP=26404 P_LOG_UDP=26405
P_SEQ=26406 P_CTRL=26407 P_HB_UDP=26408 P_START=26409 P_VID_API=26411 P_VID_RTC=26412 P_VID_AGENT=26413 P_OTA=26414
SECONDS_UP="${WP6_STARTUP_SECONDS:-5}"
mkdir -p "$ROOT/.tmp"
WORK="$ROOT/.tmp/wp6_startup_$$"
rm -rf "$WORK"; mkdir -p "$WORK"
PIDS=()
cleanup() { set +e; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; sleep 0.5; for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; wait "$p" 2>/dev/null; done; [ "${CHAR_KEEP:-0}" = 1 ] && echo "kept $WORK" || rm -rf "$WORK"; }
trap cleanup EXIT

capture() {  # <label> <rev-or-empty> -> writes $WORK/<label>.norm
  local label="$1" rev="$2" FX="$WORK/$1" SRV
  mkdir -p "$FX/logs"
  cat > "$FX/ports.json" <<EOJ
{"elodin":$P_ELODIN,"daq_udp":$P_DAQ_UDP,"ws":$P_WS,"act_udp":$P_ACT_UDP,"log_udp":$P_LOG_UDP,
 "sequencer":$P_SEQ,"controller":$P_CTRL,"hb_udp":$P_HB_UDP,"startup_udp":$P_START,"video_api":$P_VID_API,
 "video_webrtc":$P_VID_RTC,"video_agent":$P_VID_AGENT,"ota":$P_OTA}
EOJ
  "$PY" "$ROOT/test/characterization/pipeline/make_fixture.py" "$ROOT" "$FX" "$FX/ports.json" pt > "$FX/logs/fixture.log"
  SRV="$FX/srv"
  mkdir -p "$SRV/diablo_server/backend" "$SRV/calibration" "$SRV/scripts/calibration"
  if [ -n "$rev" ]; then
    git -C "$(git -C "$ROOT" rev-parse --show-toplevel)" archive "$rev" daq-server/diablo_server/backend/src daq-server/diablo_server/backend/package.json \
      daq-server/diablo_server/shared | tar -x -C "$FX"
    mv "$FX/daq-server/diablo_server/backend/src" "$FX/daq-server/diablo_server/backend/package.json" "$SRV/diablo_server/backend/"
    mv "$FX/daq-server/diablo_server/shared" "$SRV/diablo_server/shared"
    rm -rf "$FX/daq-server"
  else
    cp -R "$BACKEND/src" "$BACKEND/package.json" "$SRV/diablo_server/backend/"
    cp -R "$ROOT/diablo_server/shared" "$SRV/diablo_server/shared"
  fi
  ln -s "$BACKEND/node_modules" "$SRV/diablo_server/backend/node_modules"
  ln -s "$FX/scripts/calibration/calibrations" "$SRV/scripts/calibration/calibrations"
  [ -n "${CHAR_BUILD_DIR:-}" ] && ln -s "$CHAR_BUILD_DIR" "$SRV/build"
  local CFG="$FX/config/config.toml"
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
  local pid=$!; PIDS+=($pid)
  sleep "$SECONDS_UP"
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  head -60 "$FX/logs/backend.log" \
    | sed -E -e "s#$FX#<fx>#g" -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/<iso>/g' \
             -e 's/[0-9]{13}/<ms>/g' -e 's/pid[=: ]+[0-9]+/pid <pid>/g' -e 's/"ts": ?[0-9]+/"ts":<ms>/g' \
    > "$WORK/$label.norm"
  echo "$label: $(wc -l < "$FX/logs/backend.log" | tr -d ' ') lines logged in ${SECONDS_UP}s"
}

capture base "$BASE"
capture head "$HEADREV"
if diff "$WORK/base.norm" "$WORK/head.norm"; then echo "startup log: identical ($(wc -l < "$WORK/head.norm" | tr -d ' ') lines compared)"; else echo "startup log: DIFFERS" >&2; exit 1; fi
