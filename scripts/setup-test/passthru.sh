#!/usr/bin/env bash
# passthru.sh — the dispatcher hands each project only the flags it takes.
#
# Usage: bash scripts/setup-test/passthru.sh   (from anywhere; no installs)
#
# setup.sh passes its extra flags on to the per-project scripts, and every one
# of those stops on a flag it does not know -- so `setup.sh --all --no-hook`
# (daq-server's flag) failed feed-twin, pid-designer and firmware before they
# installed anything. This checks flags_for (scripts/setup_common.sh), which
# the dispatcher filters by, against each script: what it keeps, and that the
# script's own parser takes all of it -- by running the script with the kept
# flags and --help last, which parses left to right and exits 0 before any
# install. Exits non-zero on the first mismatch.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/setup_common.sh"

FLAGS=(--yes --no-hook --ci --no-build --no-frontend --no-native --with-toolchain)

# What each project's own parser declares, by hand -- the expectation. A case,
# not an associative array: macOS's bash is 3.2.
want() {
  case "$1" in
    pid-designer/setup.sh)    echo "--yes --no-frontend" ;;
    star-openrocket/setup.sh) echo "--yes --ci --no-frontend" ;;
    feed-twin/setup.sh)       echo "--yes --no-frontend" ;;
    EngineDesign/setup.sh)    echo "--yes --ci --no-frontend --no-native" ;;
    firmware/setup.sh)        echo "--yes --with-toolchain" ;;
    daq-server/setup.sh)      echo "--yes --no-hook --no-build" ;;
  esac
}

bad=0
for script in pid-designer/setup.sh star-openrocket/setup.sh feed-twin/setup.sh \
              EngineDesign/setup.sh firmware/setup.sh daq-server/setup.sh; do
  got="$(flags_for "$REPO_ROOT/$script" "${FLAGS[@]}" | tr '\n' ' ' | sed 's/ $//')"
  if [ "$got" != "$(want "$script")" ]; then
    echo "  ✗ $script: kept '$got', its parser takes '$(want "$script")'"
    bad=1
    continue
  fi
  # shellcheck disable=SC2086
  if ! bash "$REPO_ROOT/$script" $got --help >/dev/null 2>&1; then
    echo "  ✗ $script refuses the flags kept for it: $got"
    bad=1
    continue
  fi
  echo "  ✓ $script takes: $got"
done

[ "$bad" = "0" ] && echo "✓ every project is handed only flags it takes"
exit "$bad"
