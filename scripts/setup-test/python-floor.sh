#!/usr/bin/env bash
# python-floor.sh — setup picks a Python new enough, or says it cannot.
#
# Usage: bash scripts/setup-test/python-floor.sh   (no installs, no venvs)
#
# lib/feedtwin and lib/stardesign require Python >= 3.11, and feed-twin's
# setup.sh and dev.sh built their venv with whatever `python3` was: on a Mac
# the system 3.9 beside Homebrew's python3.11, on Ubuntu 22.04 3.10, and pip
# then stopped on requires-python. This checks python_at_least
# (scripts/setup_common.sh) on a PATH of stand-ins: an old `python3` beside a
# python3.11 picks the 3.11; an old `python3` alone is refused. Needs a real
# Python 3.11 or newer on this machine to stand in for the new one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/setup_common.sh"

REAL="$(python_at_least 11)" || { echo "  ! no Python 3.11+ here to stand in with; skipped"; exit 0; }
STUBS="$(mktemp -d)"
trap 'rm -rf "$STUBS"' EXIT
mkdir -p "$STUBS/old" "$STUBS/both"

# An old python3: fails any version check, says 3.9 when asked.
old() {
  printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo "Python 3.9.6"; exit 0; }\nexit 1\n' > "$1/python3"
  chmod +x "$1/python3"
}
old "$STUBS/old"
old "$STUBS/both"
printf '#!/bin/sh\nexec "%s" "$@"\n' "$REAL" > "$STUBS/both/python3.11"
chmod +x "$STUBS/both/python3.11"

bad=0
got="$(PATH="$STUBS/both" python_at_least 11)" || got="(none)"
if [ "$got" = "$STUBS/both/python3.11" ]; then
  echo "  ✓ an old python3 beside a python3.11: picks python3.11"
else
  echo "  ✗ an old python3 beside a python3.11: picked $got"; bad=1
fi
if got="$(PATH="$STUBS/old" python_at_least 11)"; then
  echo "  ✗ an old python3 alone: picked $got"; bad=1
else
  echo "  ✓ an old python3 alone: refused"
fi
exit "$bad"
