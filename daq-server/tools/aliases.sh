#!/usr/bin/env bash
# Moved to scripts/aliases.sh at the repo root, which now covers every project
# (daq, engine, pid, landing, auth) with one uniform set of verbs.
#
# This shim stays so the `source .../daq-server/tools/aliases.sh` line already
# in people's ~/.bashrc keeps working. Every daq-* alias is still defined --
# see `star-help`.
#
# Nothing to change; point new setups at scripts/aliases.sh instead.

source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)/scripts/aliases.sh"
