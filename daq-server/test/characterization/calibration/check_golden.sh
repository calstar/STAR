#!/bin/bash
# Run a command and compare its stdout with a golden file.
#
#   check_golden.sh <golden> <command> [args...]
#
# One golden per output, shared by every build type, OS and arch. Text compares exactly and
# floating numbers within 4 ULP of the golden value, or the named family limit in tolerances.txt
# (golden_compare.py says exactly how); a
# failure names the field and its ULP distance.
#
# CHAR_UPDATE=1 writes the output to the golden instead (only ever on main's behaviour, from the
# Release build).
set -uo pipefail
golden="$1"
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
out="$(mktemp "${TMPDIR:-/tmp}/char_cal_out.XXXXXX")"
trap 'rm -f "$out" "$out.err"' EXIT
"$@" > "$out"
rc=$?
if [ "$rc" != 0 ]; then
  echo "check_golden: '$*' exited $rc" >&2
  exit 1
fi
if [ "${CHAR_UPDATE:-0}" = 1 ]; then
  mkdir -p "$(dirname "$golden")"
  cp "$out" "$golden"
  chmod 644 "$golden"
  echo "check_golden: wrote $golden ($(wc -l < "$golden") lines)"
  exit 0
fi
if [ ! -f "$golden" ]; then
  echo "check_golden: no golden at $golden (generate on main's behaviour with CHAR_UPDATE=1)" >&2
  exit 1
fi
if ! python3 "$HERE/golden_compare.py" --tolerances "$HERE/tolerances.txt" "$golden" "$out" 2> "$out.err"; then
  head -n 120 "$out.err" >&2
  rm -f "$out.err"
  echo "check_golden: output differs from $(basename "$golden")" >&2
  exit 1
fi
rm -f "$out.err"
echo "check_golden: $(basename "$golden") matches ($(wc -l < "$golden") lines, floats within 4 ULP or tolerances.txt)"
