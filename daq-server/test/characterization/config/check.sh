#!/bin/bash
# Characterization area "config": run every loader over every input and diff against golden/.
#
#   check.sh cpp <dir of char_config_dump> <dir of state_script_check>   (ctest runs this)
#   check.sh ts                                                          (run.sh runs this)
#   check.sh py                                                          (run.sh runs this)
#
# CHAR_UPDATE=1 rewrites the goldens instead of comparing (only ever on main's behaviour).
# Always runs from this directory, with inputs named relative to it, so messages that echo a path
# are machine independent and the loaders' cwd-relative fallbacks (config/..., ../config/...)
# resolve to nothing. Opens no sockets.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$HERE" || exit 2
MODE="${1:-}"
CFG=../../../config
BAD=fixtures/bad
fail=0
count=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/char-config.XXXXXX")" || exit 2
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# compare <golden relative to golden/> <file with actual output>
compare() {
  local golden="golden/$1" actual="$2"
  count=$((count + 1))
  if [ "${CHAR_UPDATE:-}" = 1 ]; then
    mkdir -p "$(dirname "$golden")"
    cp "$actual" "$golden"
    return
  fi
  if [ ! -f "$golden" ]; then
    echo "MISSING golden $golden (run with CHAR_UPDATE=1 on main's behaviour)"
    fail=1
  elif ! diff -u "$golden" "$actual" > "$WORK/diff.txt"; then
    echo "DIFF $golden"
    head -60 "$WORK/diff.txt"
    fail=1
  fi
}

# A name for an input path: config/profiles/default/config.toml -> profiles__default__config.toml
slug() { echo "$1" | sed -e "s#^$CFG/##" -e 's#^fixtures/##' -e 's#/#__#g'; }

# The state-machine tables each config is checked against: its own profile's, else the default
# profile's (what config/ holds after the default profile deploys).
csv_dir_for() {
  case "$1" in
    "$CFG"/profiles/*/config.toml) dirname "$1" ;;
    *) echo "$CFG/profiles/default" ;;
  esac
}

TRACKED_TOMLS=(
  "$CFG/config_base.toml" "$CFG/config_flight_daq.toml" "$CFG/config_ground_daq.toml"
  "$CFG/config_sitl.toml" "$CFG"/profiles/*/config.toml
)
BAD_TOMLS=("$BAD"/*.toml "$BAD/does_not_exist.toml")

run_cpp() {
  local bin toolbin out="$WORK/out.txt"
  bin="$(cd "$1" && pwd -P)" || return 2
  toolbin="$(cd "$2" && pwd -P)" || return 2
  local dump="$bin/char_config_dump"
  [ -x "$dump" ] || { echo "no $dump"; return 2; }

  "$dump" --fixed > "$out"; compare cpp/fixed.txt "$out"

  local f d name
  for f in "${TRACKED_TOMLS[@]}" "${BAD_TOMLS[@]}"; do
    d="$(csv_dir_for "$f")"
    name="$(slug "$f")"
    "$dump" --config "$f" --transitions "$d/state_transitions.csv" \
      --actuators "$d/state_machine_actuators.csv" \
      --delays "$d/state_machine_actuator_delays.csv" --config-dir "$(dirname "$f")" > "$out"
    compare "cpp/config/$name.txt" "$out"
    for svc in stacklight daq_bridge; do
      "$bin/char_cfg_$svc" "$f" > "$out"; compare "cpp/$svc/$name.txt" "$out"
    done
    # config_broadcast reads config/state_machine_actuators.csv relative to its cwd before the
    # path config names, as the deployed service does from daq-server/: give it that layout.
    rm -rf "$WORK/cb"; mkdir -p "$WORK/cb/config"
    [ -f "$f" ] && cp "$f" "$WORK/cb/config/config.toml"
    cp "$d/state_machine_actuators.csv" "$WORK/cb/config/"
    (cd "$WORK/cb" && "$bin/char_cfg_config_broadcast" config/config.toml) > "$out"
    compare "cpp/config_broadcast/$name.txt" "$out"
  done

  # Malformed state-machine tables, against the default profile's config.toml.
  local dflt="$CFG/profiles/default"
  for f in "$BAD"/csv/transitions_*.csv "$BAD"/csv/missing_file.csv; do
    "$dump" --config "$dflt/config.toml" --transitions "$f" \
      --actuators "$dflt/state_machine_actuators.csv" \
      --delays "$dflt/state_machine_actuator_delays.csv" --config-dir "$dflt" > "$out"
    sed -n '/^=== StateMachine$/,/^=== ActuatorCommander$/p' "$out" > "$out.sm"
    compare "cpp/csv/$(basename "$f" .csv).txt" "$out.sm"
  done
  for f in "$BAD"/csv/actuators_*.csv "$BAD"/csv/delays_*.csv; do
    local acts="$dflt/state_machine_actuators.csv" dels="$dflt/state_machine_actuator_delays.csv"
    case "$f" in */actuators_*) acts="$f" ;; *) dels="$f" ;; esac
    "$dump" --config "$dflt/config.toml" --transitions "$dflt/state_transitions.csv" \
      --actuators "$acts" --delays "$dels" --config-dir "$dflt" > "$out"
    sed -n '/^=== ActuatorCommander$/,/^=== load_dynamic_states$/p' "$out" > "$out.ac"
    compare "cpp/csv/$(basename "$f" .csv).txt" "$out.ac"
  done

  # Scripts: the parser and validator through the library, and the operator-facing checker.
  local twin="$CFG/profiles/digital-twin" s state rc
  for s in "$twin"/scripts/*.script "$BAD"/scripts/*.script; do
    name="$(slug "$s")"
    "$dump" --script "$s" > "$out"; compare "cpp/script_parse/$name.txt" "$out"
    for state in "Dynamic Test" "Idle"; do
      "$dump" --config "$twin/config.toml" --transitions "$twin/state_transitions.csv" \
        --actuators "$twin/state_machine_actuators.csv" \
        --delays "$twin/state_machine_actuator_delays.csv" --config-dir "$twin" \
        --script "$s" --state "$state" > "$out"
      sed -n '/^=== script /,$p' "$out" > "$out.s"
      compare "cpp/script_validate/$name.${state// /_}.txt" "$out.s"
      "$toolbin/state_script_check" --config "$twin/config.toml" --state "$state" \
        --transitions "$twin/state_transitions.csv" "$s" > "$out.o" 2> "$out.e"
      rc=$?
      { echo "=== stdout"; cat "$out.o"; echo "=== stderr"; cat "$out.e"; echo "=== exit $rc"; } > "$out"
      compare "cpp/state_script_check/$name.${state// /_}.txt" "$out"
    done
  done
  # The checker's own refusals: bad arguments, unreadable files, a config with no states.
  local i=0
  while IFS= read -r line; do
    i=$((i + 1))
    eval "set -- $line"
    "$toolbin/state_script_check" "$@" > "$out.o" 2> "$out.e"
    rc=$?
    { echo "=== args $line"; echo "=== stdout"; cat "$out.o"; echo "=== stderr"; cat "$out.e";
      echo "=== exit $rc"; } > "$out"
    compare "cpp/state_script_check/refusal_$i.txt" "$out"
  done <<EOF
--help
--config $twin/config.toml --state Idle
--bogus x
--config $BAD/no_such.toml --state Idle $twin/scripts/dynamic_test.script
--config $twin/config.toml --state Idle $BAD/scripts/no_such.script
--config $BAD/missing_sections.toml --state Idle $twin/scripts/dynamic_test.script
--config $BAD/malformed.toml --state Idle $twin/scripts/dynamic_test.script
--config $BAD/slug_collision.toml --state Armed $twin/scripts/dynamic_test.script
--config $twin/config.toml --state Idle --transitions $BAD/csv/missing_file.csv $twin/scripts/dynamic_test.script
--config $twin/config.toml --state 'No Such State' $twin/scripts/dynamic_test.script
EOF
}

run_ts() {
  local backend=../../../diablo_server/backend out="$WORK/ts"
  mkdir -p "$out"
  # The TS loaders read and write under the config directory (getConfigPath self-heals by copying
  # a profile into config.toml), so they run against a scratch copy of config/, never the tree.
  cp -R "$CFG" "$WORK/config"
  rm -f "$WORK/config/config.toml" "$WORK/config/.active_profile" "$WORK/config"/*.csv
  rm -rf "$WORK/config/scripts"
  mkdir -p "$WORK/calibrations"
  (cd "$backend" && CHAR_CFG_HERE="$HERE" CHAR_CFG_WORK="$WORK" CHAR_CFG_OUT="$out" \
    CONFIG_PATH="$WORK/config/config.toml" DAQ_CALIBRATIONS_DIR="$WORK/calibrations" \
    VIDEO_CONFIG_PATH="$WORK/config/video.json" \
    npx --no-install tsx "$HERE/ts_dump.ts") > "$WORK/ts.log" 2>&1 || {
    echo "ts_dump failed:"; cat "$WORK/ts.log"; return 1; }
  local f
  while IFS= read -r f; do
    compare "ts/${f#"$out"/}" "$f"
  done < <(find "$out" -type f | LC_ALL=C sort)
}

run_py() {
  local out="$WORK/py.txt"
  python3 py_dump.py > "$out" 2>&1
  compare py/check_toml_no_underscore_ints.txt "$out"
}

case "$MODE" in
  cpp) run_cpp "${2:?bin dir}" "${3:?tool bin dir}" || fail=1 ;;
  ts) run_ts || fail=1 ;;
  py) run_py || fail=1 ;;
  *) echo "usage: check.sh cpp <bin> <toolbin> | ts | py" >&2; exit 2 ;;
esac

if [ "${CHAR_UPDATE:-}" = 1 ]; then
  echo "config/$MODE: wrote $count golden(s)"
elif [ "$fail" = 0 ]; then
  echo "config/$MODE: $count golden(s) match"
else
  echo "config/$MODE: FAIL"
  exit 1
fi
