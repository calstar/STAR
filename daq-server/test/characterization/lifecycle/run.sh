#!/bin/bash
# Lifecycle characterization (startup, shutdown, reconnect, duplicate subscription, heartbeat
# loss, OTA). Binds loopback ports, so it holds the machine-wide stack lock itself (re-entrant
# when gate.sh / the suite's run.sh already hold it). CHAR_UPDATE=1 rewrites golden/ — main's
# behaviour only.
#
# Needs elodin-db at the version setup.sh pins; ELODIN_DB_BIN overrides ~/.cargo/bin/elodin-db.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$HERE/../with_stack_lock.sh" python3 "$HERE/lifecycle.py" "$@"
