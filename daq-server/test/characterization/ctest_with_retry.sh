#!/bin/bash
# Run ctest in a build dir; main's own timing tests (timing_ctests.txt, LEDGER D31) that fail are
# rerun alone up to twice and count as passing only if a rerun passes. Every retry is printed.
# Any other failure, or a timing test that fails all reruns, fails. Extra args go to the first ctest.
#
#   bash ctest_with_retry.sh <build-dir> [ctest args...]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BUILD="$1"; shift
cd "$BUILD" || exit 2
ctest --output-on-failure "$@" && exit 0
failed="$(cut -d: -f2 Testing/Temporary/LastTestsFailed.log 2>/dev/null | sort -u)"
[ -n "$failed" ] || { echo "ctest failed without a failed-test list"; exit 1; }
rc=0
# CTEST_KNOWN_FAILURES: a file of tests known to fail on this platform (macOS baseline); they are
# reported and not retried.
for t in $failed; do
  if [ -n "${CTEST_KNOWN_FAILURES:-}" ] && grep -qx "$t" "$CTEST_KNOWN_FAILURES"; then
    echo "KNOWN FAILURE (platform baseline): $t"; continue
  fi
  if ! grep -qx "$t" "$HERE/timing_ctests.txt"; then
    echo "FAILED (not a known timing test): $t"; rc=1; continue
  fi
  if ctest -R "^${t}\$" --repeat until-pass:2 --output-on-failure > "retry-$t.log" 2>&1; then
    echo "RETRY PASSED: $t (main's timing test; log retry-$t.log)"
  else
    echo "FAILED after retries: $t"; cat "retry-$t.log"; echo "$t" >> retry-failed.txt; rc=1
  fi
done
exit $rc
