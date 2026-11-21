#!/usr/bin/env bash
# End-to-end check of the Motors & Configuration tab against the live stack (UI :5178, API :8004):
# edit separation (one configuration), deployment (all configurations) and an ignition delay in the
# browser, save the .ork, and ask OpenRocket 24.12 itself (tools/oracle) what the saved file flies.
#   OPENROCKET_JAR=/path/OpenRocket-24.12.jar tools/e2e/run.sh
# Needs Playwright (require('playwright'); set NODE_PATH if it is installed globally).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/gold"
node "$here/motors_config.js" "$work/edited.ork"
cp "$root/tests/rockets/Two stage high power rocket.ork" "$work/original.ork"
GOLDEN_DIR="$work/gold" "$root/tools/oracle/run.sh" "$work/edited.ork" "$work/original.ork"
python3 "$here/compare_events.py" "$work/gold/edited.json" "$work/gold/original.json"
