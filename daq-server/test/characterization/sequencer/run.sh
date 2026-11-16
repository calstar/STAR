#!/bin/bash
# Sequencer / controller golden master: sequencer_service and controller_service driven over TCP,
# every actuator datagram they emit captured on 127.0.0.1 and compared with golden/.
#
#   bash test/characterization/sequencer/run.sh                 # compare
#   CHAR_UPDATE=1 bash test/characterization/sequencer/run.sh   # rewrite goldens (main's behaviour only)
#   CHAR_SEQ_REPEAT=3 ...                                       # run each session 3x, fail on any difference
#   CHAR_SEQ_ONLY='entry/Fire' ...                              # a subset (regex on session names)
#
# Each actuator board is captured on its own loopback address, 127.0.0.<board_id>: on macOS those
# need lo0 aliases, and without them the suite FAILS (listing them) rather than skip.
# Starts the real binaries, so it takes the machine-wide stack lock itself (re-entrant under
# gate.sh). Off the stand only: it refuses on star-rfs or a host with a board-LAN address, and every
# config it writes is rewritten to loopback only (harness.patch_config asserts it).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CHAR="$(cd "$HERE/.." && pwd -P)"

if [ "$(hostname)" = "star-rfs" ] || { command -v ip >/dev/null && ip -4 -o addr | grep -q ' 192\.168\.2\.'; } \
  || ifconfig 2>/dev/null | grep -q 'inet 192\.168\.2\.'; then
  echo "sequencer char: this is the stand (star-rfs / board LAN). Refusing to run." >&2
  exit 3
fi

exec bash "$CHAR/with_stack_lock.sh" python3 "$HERE/char_sequencer.py" "$@"
