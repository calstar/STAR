#!/bin/bash
# Run a command and compare its stdout with a golden file.
#
#   check_golden.sh <golden stem> <variant|-> <command> [args...]
#
# The golden is <stem>.<variant>.txt, or <stem>.txt when the variant is "-". The C++ outputs are
# bit-exact numbers, and those depend on the platform and the optimisation level as well as on the
# code (clang -O2 on arm64 contracts a*b+c into an FMA; Apple's libm is not glibc's), so each
# <os>-<arch>-<build type> has its own golden. A variant with no golden is SKIPPED (exit 77, which
# CTest reports as skipped), never silently passed: generate one on main's behaviour with
# CHAR_UPDATE=1.
#
# CHAR_UPDATE=1 writes the output to the golden instead (only ever on main's behaviour).
set -uo pipefail
stem="$1"
variant="$2"
shift 2
if [ "$variant" = "-" ]; then golden="$stem.txt"; else golden="$stem.$variant.txt"; fi
out="$(mktemp "${TMPDIR:-/tmp}/char_cal_out.XXXXXX")"
trap 'rm -f "$out" "$out.diff"' EXIT
"$@" > "$out"
rc=$?
if [ "$rc" != 0 ]; then
  echo "check_golden: '$*' exited $rc" >&2
  exit 1
fi
if [ "${CHAR_UPDATE:-0}" = 1 ]; then
  mkdir -p "$(dirname "$golden")"
  cp "$out" "$golden"
  echo "check_golden: wrote $golden ($(wc -l < "$golden") lines)"
  exit 0
fi
if [ ! -f "$golden" ]; then
  echo "check_golden: SKIPPED — no golden for variant '$variant' ($golden). Generate one on" \
       "main's behaviour with CHAR_UPDATE=1." >&2
  exit 77
fi
if ! diff -u "$golden" "$out" > "$out.diff"; then
  echo "check_golden: output differs from $(basename "$golden")" \
       "($(grep -c '^[-+][^-+]' "$out.diff") changed lines):" >&2
  head -n 120 "$out.diff" >&2
  exit 1
fi
echo "check_golden: $(basename "$golden") matches ($(wc -l < "$golden") lines)"
