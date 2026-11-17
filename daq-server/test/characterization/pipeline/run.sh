#!/bin/bash
# Pipeline characterization: board_simulator → daq_bridge → elodin-db → calibration_service →
# backend (server.ts) → WebSocket + HTTP, with sequencer_service behind the backend's command path.
# Two scripted sessions (session.ts) are recorded, normalised (normalize.py) and compared against
# goldens (characterize.py). CHAR_UPDATE=1 rewrites the goldens instead.
#
#   bash test/characterization/pipeline/run.sh            # both sessions
#   bash test/characterization/pipeline/run.sh pt         # one routed PT board, the full script → golden/
#   bash test/characterization/pipeline/run.sh boards     # every simulated board type → golden/boards/
#   bash test/characterization/pipeline/run.sh stalesub   # D-SUB: a subscription accepted inside a
#                                                        # re-registration window → golden/stalesub/
#   bash test/characterization/pipeline/run.sh operator   # a WS client whose X-Auth-Email is in
#                                                        # operators.txt (H8b) → golden/operator/
#   bash test/characterization/pipeline/run.sh holds      # an accepted timed hold (OK:<ms>), then
#                                                        # :9998 stalled and down → golden/holds/
#   bash test/characterization/pipeline/run.sh startlog   # the backend alone: its startup log to the
#                                                        # end of the synchronous start → golden/startlog/
#   bash test/characterization/pipeline/run.sh selftest   # a board whose SELF_TEST reports one failed
#                                                        # connector (self_test_fail_<id>) → golden/selftest/
#   bash test/characterization/pipeline/run.sh unrecognized  # a heartbeating board the backend's config
#                                                        # does not expect (unrecognized_<id>) → golden/unrecognized/
#
# "boards" needs the board_id loopback aliases (127.0.0.<id>) on macOS ("stalesub" needs
# 127.0.0.22); it fails, never skips, when one is missing. Linux has all of 127/8.
#
# Takes the machine-wide stack lock itself (re-entrant under gate.sh / run.sh). Off the stand
# only. Every service runs against a private fixture tree in .tmp/char_pipeline_<pid>/ with its
# board IPs on loopback and its ports in 264xx; nothing in the checkout is moved or written.
#
# Env: CHAR_BUILD_DIR (default build-gate/ or build/), CHAR_KEEP=1 keeps the fixture and logs,
#      CHAR_CAPTURE_ONLY=<path> copies the raw capture there and skips the comparison,
#      CHAR_UNDER_LOAD=1 says the machine is under deliberate synthetic load (set by whoever starts
#      it): the self-test rule then tolerates not-received boards (README P12).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../../.." && pwd -P)"   # daq-server/

if [ "${DAQ_STACK_LOCK_HELD:-}" = "" ]; then
  # with_stack_lock.sh puts the lock in the repository's common git dir. An export with no .git
  # (the Linux leg's `git archive`, a deployed stand) has none, so name the lock outright rather
  # than let it ask git. Nothing else in this harness or the stack it runs calls git.
  if ! git -C "$ROOT" rev-parse --git-common-dir > /dev/null 2>&1; then
    export DAQ_STACK_LOCK="${DAQ_STACK_LOCK:-${TMPDIR:-/tmp}/daq-stack.lock}"
  fi
  exec bash "$ROOT/test/characterization/with_stack_lock.sh" bash "$HERE/run.sh" "$@"
fi

MODE="${1:-all}"
if [ "$MODE" = all ]; then
  rc=0
  bash "$HERE/run.sh" pt || rc=1
  bash "$HERE/run.sh" nocal || rc=1
  bash "$HERE/run.sh" boards || rc=1
  bash "$HERE/run.sh" stalesub || rc=1
  bash "$HERE/run.sh" operator || rc=1
  bash "$HERE/run.sh" holds || rc=1
  bash "$HERE/run.sh" startlog || rc=1
  bash "$HERE/run.sh" selftest || rc=1
  bash "$HERE/run.sh" unrecognized || rc=1
  exit $rc
fi
case "$MODE" in pt|nocal|boards|stalesub|operator|holds|startlog|selftest|unrecognized) ;;
  *) echo "usage: run.sh [pt|nocal|boards|stalesub|operator|holds|startlog|selftest|unrecognized]" >&2; exit 2 ;; esac

if [ "$(hostname)" = "star-rfs" ] || { command -v ip >/dev/null && ip -4 -o addr | grep -q ' 192\.168\.2\.'; } \
  || ifconfig 2>/dev/null | grep -q 'inet 192\.168\.2\.'; then
  echo "pipeline: this is the stand (star-rfs / board LAN). Refusing to run." >&2
  exit 3
fi

# The boards session sends as every simulated board from 127.0.0.<board_id>. Same list as
# test/test_integration.sh: every board_id octet in config_base.toml plus the startup board (60).
# stalesub sends only as pt_board_2 (22).
if { [ "$MODE" = boards ] || [ "$MODE" = stalesub ]; } && [ "$(uname)" = "Darwin" ]; then
  missing=()
  ALIASES="11 12 13 14 21 22 25 31 32 41 42 51 52 60 61 71"; [ "$MODE" = stalesub ] && ALIASES=22
  for i in $ALIASES; do
    ifconfig lo0 2>/dev/null | grep -q "inet 127\.0\.0\.$i " || missing+=("127.0.0.$i")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "pipeline: the $MODE session needs loopback aliases that are missing: ${missing[*]}" >&2
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
FXMODE="$MODE"; case "$MODE" in nocal|operator|holds|startlog|selftest) FXMODE=pt ;; esac  # the pt fixture, one routed board
"$PY" "$HERE/make_fixture.py" "$ROOT" "$FX" "$FX/ports.json" "$FXMODE"
# selftest: the simulator reports pt_board's connector 3 as failed (--fail-connector, opt-in,
# LEDGER D48(1)); its default packet is proven byte-identical first, with no ports involved.
SIM_FAIL=""
if [ "$MODE" = selftest ]; then
  SIM_FAIL="21:3"
  "$PY" "$HERE/sim_selftest_check.py" || exit 1
fi

if [ "$MODE" = holds ]; then
  # A state that takes a timed hold. The shipped config has none (test_integration.sh builds one
  # too, for the same reason: a reference stand config should not grow a state so CI can measure
  # one), so the fixture's CSVs get a `Flow Test` column -- reachable from Press Standby and back,
  # the gate valve open, staggered 0.4 s on the way in -- and config.toml the `[[states]]` +
  # `[flow]` block exactly as test/test_integration.sh writes it (id 21, 800 ms, max 5000). One
  # step test_integration.sh does not take: ten rows of the shipped state_transitions.csv are a
  # cell short (NEEDS-REPAIR.md; both parsers read a row left-aligned and a missing cell as "not
  # allowed"), so a column appended to such a row lands under the previous header -- Press Standby's
  # `1` under Emergency Abort, and the hold is refused. test_integration.sh never sees that because
  # it enters Flow Test with debug mode on, which bypasses the table (SequencerService.cpp). Here
  # every row is first padded with `0` to the header's width, which neither parser can tell from a
  # missing cell, so the new column is the only change the sequencer reads. The
  # three patched CSVs are copies beside the originals under config/, and [state_machine] points
  # at them by the same relative form: the C++ services resolve it against cwd (the fixture) and
  # the backend's loaders against cwd/../.. (char/backend), whereas an absolute path is found by
  # the sequencer only (make_fixture.py, README "Frozen behaviour"), which would freeze a backend
  # that never learned the column.
  "$PY" - "$FX/config" <<'PYEOF'
import csv, os, sys
cfg_dir = sys.argv[1]

def load(name):
    with open(os.path.join(cfg_dir, name)) as f:
        return [r for r in csv.reader(f)]

def save(name, rows):
    with open(os.path.join(cfg_dir, name), 'w', newline='') as f:
        csv.writer(f).writerows(rows)

NAME = 'Flow Test'
RETURN = 'Press Standby'
GATE = 'Fuel Main'
GATE_DELAY = '0.4'

# Transitions: reachable only from the hub, and able to get back to it -- the sequencer refuses to
# make a state holdable at all if it cannot reach its return target.
t = load('state_transitions.csv')
width = len(t[0])
t[0].append(NAME)
for r in t[1:]:
    r.extend(['0'] * (width - len(r)))  # the short rows (see above), to the header's width
    r.append('1' if r[0] == RETURN else '0')
t.append([NAME] + ['1' if h in (RETURN, NAME) else '0' for h in t[0][1:]])
save('holds_state_transitions.csv', t)

# Actuators: the gate opens, everything else stays shut.
a = load('state_machine_actuators.csv')
a[0].append(NAME)
for r in a[1:]:
    r.append('OPEN' if r[0] == GATE else 'CLOSE')
save('holds_state_machine_actuators.csv', a)

# Delays: the gate is staggered on the way IN only, so the hold comes out as requested + gate delay.
d = load('state_machine_actuator_delays.csv')
d[0].append(NAME)
for r in d[1:]:
    r.append(GATE_DELAY if r[0] == GATE else '0')
save('holds_state_machine_actuator_delays.csv', d)
PYEOF
  CFG="$FX/config/config.toml"
  sed -i.bak \
    -e 's|^transitions_csv = .*|transitions_csv = "config/holds_state_transitions.csv"|' \
    -e 's|^actuator_csv = .*|actuator_csv = "config/holds_state_machine_actuators.csv"|' \
    -e 's|^actuator_delay_csv = .*|actuator_delay_csv = "config/holds_state_machine_actuator_delays.csv"|' \
    "$CFG" && rm -f "$CFG.bak"
  cat >> "$CFG" <<EOF

[[states]]
id = 21
name = "Flow Test"
is_flow = true

[flow]
return_target = "Press Standby"
duration_ms = 800
max_ms = 5000
gate_actuator = "Fuel Main"
EOF
fi

# The backend runs from a copy of its own source under the fixture (srv/, the same layout as
# daq-server/), so everything it resolves relative to its own file lands in the fixture rather
# than in the checkout: its PT calibration (calibration.ts: <srv>/calibration/*.json, newest by
# mtime -- in a checkout every committed file shares one mtime, so the pick was filesystem order:
# macOS got one dated file, a Linux export another with no coefficients), /api/cubic_calibration
# (<srv>/scripts/calibration/calibrations), the state-CSV loaders (<srv>/../config = the
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
# unrecognized: the backend reads its own copy of the config (make_fixture.py config_backend/);
# every service keeps $CFG.
BACKEND_CFG="$CFG"; [ "$MODE" = unrecognized ] && BACKEND_CFG="$FX/config_backend/config.toml"

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
wait_log() {  # pid name fixed-string seconds -- the service's own line, or a loud failure
  local i=0
  until grep -qF -- "$3" "$FX/logs/$2.log" 2>/dev/null; do
    alive "$1" "$2"
    sleep 0.25; i=$((i + 1))
    [ $i -lt $(($4 * 4)) ] || { echo "pipeline: $2 never logged '$3' within $4 s" >&2; tail -20 "$FX/logs/$2.log" >&2; exit 5; }
  done
}

start_backend() {  # the one backend command every session and startlog run (env as production's)
  (cd "$FX/char/backend" && exec env -u USE_SIM -u RUNNING_CONFIG_PATH -u COUNTDOWN_STATE_PATH \
    -u SESSION_STATE_PATH -u VIDEO_CONFIG_PATH -u VIDEO_SECRETS_PATH -u REPLAY_MODE -u ELODIN_DEBUG \
    -u THIN_VERBOSE_CONNECTION_LOG -u THIN_HEARTBEAT_DIAG_LOG -u THIN_STATS_LOG \
    -u SESSION_WARN_LEADS_MS -u SESSION_WARN_LEAD_MS \
    HOME="$FX/home" WS_PORT=$P_WS GUI_PORT=0 ELODIN_HOST=127.0.0.1 ELODIN_PORT=$P_ELODIN \
    ACTUATOR_SERVICE_PORT=$P_SEQ CONTROLLER_SERVICE_PORT=$P_CTRL OTA_SERVICE_PORT=$P_OTA \
    LOG_INGEST_PORT=$P_LOG_UDP CONFIG_PATH="$BACKEND_CFG" SESSION_SERVICE_MODE=mock \
    DAQ_CALIBRATIONS_DIR="$FX/scripts/calibration/calibrations" \
    DAQ_OPERATORS_FILE="$FX/operators.txt" STAR_DHCP_HOSTS="$FX/no-dhcp-hosts" \
    VIDEO_GATEWAY_HOST=127.0.0.1 VIDEO_GATEWAY_API_PORT=$P_VID_API \
    VIDEO_GATEWAY_WEBRTC_PORT=$P_VID_RTC VIDEO_AGENT_PORT=$P_VID_AGENT \
    "$TSX" "$SRV/diablo_server/backend/src/server.ts") > "$FX/logs/backend.log" 2>&1 &
  PIDS+=($!)
}

if [ "$MODE" = startlog ]; then
  # G12 (DESIGN-WP6 §6.3 startup-log diff, LEDGER D96): the backend alone, nothing listening on
  # any of its ports, stopped once it has logged the last synchronous line of its listen callback.
  # startlog.py cuts there and normalises; what the process printed before it -- import-time
  # lines of the state-CSV loaders, then server.ts's top level in order -- is the golden.
  START_MS="$("$PY" -c 'import time; print(int(time.time()*1000))')"
  start_backend; BE=${PIDS[-1]}
  wait_log $BE backend "[ThinServer] Actuator service: localhost:" 30
  kill $BE; wait $BE 2>/dev/null || true
  cat > "$FX/context.json" <<EOF
{"now_ms": $START_MS, "mode": "$MODE", "logs": "$FX/logs",
 "paths": {"$FX/config": "<cfgdir>", "$FX/home": "<home>", "$FX": "<fx>", "$ROOT": "<daq>"},
 "ports": $(cat "$FX/ports.json" | "$PY" -c 'import json,sys; print(json.dumps({str(v): k for k, v in json.load(sys.stdin).items()}))')}
EOF
  OUT="$FX/out"; mkdir -p "$OUT"
  "$PY" "$HERE/startlog.py" "$FX/logs/backend.log" "$FX/context.json" "$OUT/backend_startup.txt" \
    || { echo "pipeline: startlog never reached the end mark" >&2; cat "$OUT/backend_startup.txt" >&2; exit 5; }
  GOLD="$HERE/golden/startlog"
  if [ "${CHAR_UPDATE:-0}" = 1 ]; then
    mkdir -p "$GOLD"; cp "$OUT"/* "$GOLD/"; echo "pipeline[$MODE]: goldens rewritten (1 file in golden/startlog)"; exit 0
  fi
  if diff -ru "$GOLD" "$OUT"; then echo "pipeline[$MODE]: PASS"; else
    echo "pipeline[$MODE]: FAIL — the backend's startup log differs from golden/startlog (diff above)" >&2; exit 1; fi
  exit 0
fi

# Start order: DB, sequencer, bridge, calibration, backend, (config broadcast), sim -- production's
# (lifecycle/ freezes it), not test_integration.sh's, which put calibration_service after the
# backend. Both registrars (daq_bridge and calibration_service each register the calibrated
# tables) must have finished before the backend subscribes: the startup board 60 sits on PT slot
# 10, whose uint8 table ids wrap onto PT2.CH1 ([0x20,0x21] raw, [0x20,0x31] calibrated), so each
# registrar registers those ids as PT10.CH1 and, a moment later (~130 ms on Linux arm64, ~3 ms on
# macOS), as PT2.CH1 again. elodin-db binds a VTableStream to the table's components at subscribe
# time: a backend subscription accepted inside that window stays on the PT10 components and
# delivers nothing for the rest of the run, with no refusal to retry (D-SLOT / D-SUB,
# docs/remaster/LEDGER.md D41) -- the boards golden lost PT2_Cal.CH1 on Linux exactly so. The
# goldens freeze board 60 (the validator's slot-10 error, its setup/lost lifecycle), so the board
# stays and the backend instead starts only after each registrar has logged completing its
# registration. Each wait is bounded by the same 30 s cap as the backend's own port wait: on an
# idle machine both lines come within ~3 s (the bridge's includes its hard-coded 1.5 s drain).
"$ELODIN_DB" run "127.0.0.1:$P_ELODIN" "$FX/elodin_db" > "$FX/logs/elodin.log" 2>&1 &
PIDS+=($!); wait_port $P_ELODIN elodin 15

(cd "$FX" && exec "$BIN/sequencer_service" --config "$CFG" --port $P_SEQ) > "$FX/logs/sequencer.log" 2>&1 &
PIDS+=($!); SEQ_PID=$!; wait_port $P_SEQ sequencer 15
# The holds session stops, resumes and finally terminates the sequencer itself (session.ts holds):
# it learns the PID from ports.json, rewritten here because the file is written -- and read by
# make_fixture.py -- before the sequencer exists. context.json's port inversion below leaves this
# key out, or every PID-valued number in the capture would be rewritten as a port.
"$PY" -c 'import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["sequencer_pid"] = int(sys.argv[2]); json.dump(d, open(p, "w"))' \
  "$FX/ports.json" "$SEQ_PID"
# At boot the sequencer publishes every valve de-energized (ActuatorCommander publishInitialState:
# a normally-open valve reads 1) and then applies the boot state's column (Fuel Main → 0). Whether
# the backend, subscribing a moment later, records that transient 1 in its history was a race
# (macOS missed it, Linux under load caught it). A subscriber that arrives later is handed the
# table's latest row by elodin-db, and when the initial publish and the boot-state application
# land in one client flush (which a loaded machine makes likely) that row is the transient 1: the
# backend's first CH7 sample under load was 1, the 0 following ~1 s later with the republish. So
# wait for the initial publish and two state applications after it -- the boot one and a 1 Hz
# republish, which is its own flush -- before starting the backend.
i=0
until awk '/Published initial state/ {seen=1; next} seen && /commands for state/ {n++} END {exit !(n >= 2)}' \
      "$FX/logs/sequencer.log" 2>/dev/null; do
  sleep 0.25; i=$((i + 1))
  [ $i -lt 120 ] || { echo "pipeline: sequencer never applied its boot state" >&2; tail -20 "$FX/logs/sequencer.log" >&2; exit 5; }
done

# The bridge logs this line after its last registration message and the 1.5 s drain that follows
# (daq_bridge_main.cpp); the DB has long since processed every table it registered.
(cd "$FX" && exec "$BIN/daq_bridge" "$CFG") > "$FX/logs/daq_bridge.log" 2>&1 &
PIDS+=($!); wait_log "${PIDS[-1]}" daq_bridge "[Elodin] Drain complete, ready for TABLE data" 30

# calibration_service logs this line once every calibrated table is registered and its own raw
# subscriptions are sent (calibration_main.cpp connect_and_register).
CAL_DONE="[Cal] Connected to Elodin, registered calibrated VTables, subscribed."
start_calibration() {
  (cd "$FX" && exec env -u CAL_BACKUP_PATH -u CAL_VERBOSE "$BIN/calibration_service" --config "$CFG" \
    --adjustments "$FX/adjustments.json" --elodin-host 127.0.0.1 --elodin-port $P_ELODIN) \
    > "$FX/logs/calibration.log" 2>&1 &
  PIDS+=($!); wait_log "${PIDS[-1]}" calibration "$CAL_DONE" 30
}
if [ "$MODE" != stalesub ]; then
  start_calibration
else
  # stalesub: the D-SUB window, made deterministic. Registrar A is calibration_service run on a
  # config holding only the startup board (slot 10): it re-registers [0x20,0x31] -- PT2_Cal.CH1 as
  # the bridge just left it -- as PT10_Cal.CH1, and is stopped once it has logged doing so (the
  # table outlives its connection). The backend then starts and subscribes with every table
  # registered, so [0x20,0x31] is accepted, bound to the PT10 components. Only after the backend's
  # passes are done does the real calibration_service start and register PT10 then PT2 again. No
  # racing anywhere: every step waits on the service's own line.
  mkdir -p "$FX/regA"
  (cd "$FX/regA" && exec env -u CAL_BACKUP_PATH -u CAL_VERBOSE "$BIN/calibration_service" \
    --config "$FX/registrar_a.toml" --adjustments "$FX/regA/adjustments.json" \
    --elodin-host 127.0.0.1 --elodin-port $P_ELODIN) > "$FX/logs/registrar_a.log" 2>&1 &
  REGA=$!; PIDS+=($REGA); wait_log $REGA registrar_a "$CAL_DONE" 30
  kill $REGA
  i=0
  while kill -0 $REGA 2>/dev/null; do
    sleep 0.25; i=$((i + 1))
    [ $i -lt 40 ] || { echo "pipeline: registrar A still alive 10 s after SIGTERM" >&2; kill -9 $REGA; exit 5; }
  done
  wait $REGA 2>/dev/null || true
fi

# The backend runs from char/backend: its state-CSV loaders (state-csv/state-actuators.ts,
# state-csv/state-transitions.ts) look in <cwd>/../../config, as production's cwd
# (diablo_server/backend) sees daq-server/config.
start_backend; wait_port $P_WS backend 30

# The simulator sends each board's SELF_TEST once, at start. The backend subscribes to the
# self-test tables in passes capped by the request-id space; a result published before the pass
# that covers its table never reaches it (seen on Linux: board 21's sensors 2-10 lost). Start the
# simulator only after a pass with nothing left queued, and then one more pass (the backend runs
# one every 5 s): a pass only SENDS its subscriptions, and on a loaded Linux box the self-tests of
# four boards still beat the DB's processing of them. The second pass always comes: the LabJack
# T7's tables ([0x26, …]) have no t7_bridge here, so the DB refuses them and the backend re-sends
# them on its backoff.
i=0
until awk '/VTableStream: sent/ { if (done) more = 1; else if ($0 !~ /queued for the next pass/) done = 1 }
           END { exit !more }' "$FX/logs/backend.log" 2>/dev/null; do
  sleep 0.25; i=$((i + 1))
  [ $i -lt 240 ] || { echo "pipeline: backend never finished subscribing" >&2; tail -20 "$FX/logs/backend.log" >&2; exit 5; }
done
[ "$MODE" != stalesub ] || start_calibration  # the re-registration, after the subscription

# --low-noise: constant ADC per channel. No timing pathologies, no --allow-ip-fallback: the pt
# sim config enables only pt_board, at 127.0.0.1; the boards one every board at 127.0.0.<id>.
"$PY" "$ROOT/sim/board_simulator.py" --config "$FX/sim_config.toml" --target 127.0.0.1 \
  --port $P_DAQ_UDP --low-noise --skip-startup ${SIM_FAIL:+--fail-connector "$SIM_FAIL"} > "$FX/logs/sim.log" 2>&1 &
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
{"now_ms": $START_MS, "mode": "$MODE", "logs": "$FX/logs",
 "gui_points_per_second": $(sed -n "/^\[gui\]/,/^\[/s/^points_per_second = \([0-9.]*\)/\1/p" "$CFG"),
 "paths": {"$FX/config": "<cfgdir>", "$FX/home": "<home>", "$FX": "<fx>",
           "$ROOT": "<daq>"},
 "ports": $(cat "$FX/ports.json" | "$PY" -c 'import json,sys; print(json.dumps({str(v): k for k, v in json.load(sys.stdin).items() if k != "sequencer_pid"}))'),
 "under_load": $([ "${CHAR_UNDER_LOAD:-0}" = 1 ] && echo true || echo false),
 "selftest_expected": $("$PY" "$HERE/selftest_expected.py" "$FX/sim_config.toml" "$CFG" ${SIM_FAIL:+--fail "$SIM_FAIL"})}
EOF

if [ -n "${CHAR_CAPTURE_ONLY:-}" ]; then
  cp "$CAPTURE" "$CHAR_CAPTURE_ONLY"; cp "$FX/context.json" "$CHAR_CAPTURE_ONLY.context.json"
  echo "pipeline: capture saved to $CHAR_CAPTURE_ONLY"; exit 0
fi

OUT="$FX/out"
"$PY" "$HERE/characterize.py" "$CAPTURE" "$FX/context.json" "$OUT"
GOLD="$HERE/golden"; [ "$MODE" = pt ] || GOLD="$HERE/golden/$MODE"
if [ "${CHAR_UPDATE:-0}" = 1 ]; then
  mkdir -p "$GOLD"; rm -f "$GOLD"/*.txt; cp "$OUT"/* "$GOLD/"
  echo "pipeline[$MODE]: goldens rewritten ($(ls "$OUT" | wc -l | tr -d ' ') files in ${GOLD#$HERE/})"
  exit 0
fi
if diff -ru -x boards -x nocal -x stalesub -x operator -x holds -x startlog -x selftest -x unrecognized "$GOLD" "$OUT"; then
  echo "pipeline[$MODE]: PASS"
else
  echo "pipeline[$MODE]: FAIL — observable behaviour differs from ${GOLD#$HERE/} (diff above)" >&2
  exit 1
fi
