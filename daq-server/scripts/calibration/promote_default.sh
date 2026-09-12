#!/usr/bin/env bash
# Promote the current live calibration to the version-controlled default.
#
# The live store (cubic_calibration.json) is gitignored runtime state — it is rewritten on every
# point capture, Zero-All, and Clear. cubic_calibration.default.json is the tracked snapshot the
# calibration service seeds a fresh checkout / new machine from (copied into place on first run
# when the live file is missing).
#
# Run this once you have a known-good calibration on one machine, then commit the default so every
# other computer boots with the same cal:
#
#   bash daq-server/scripts/calibration/promote_default.sh
#   git add daq-server/scripts/calibration/calibrations/cubic_calibration.default.json
#   git commit -m "calibration: promote <what> as default"
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$here/calibrations"
live="$dir/cubic_calibration.json"
default="$dir/cubic_calibration.default.json"

if [[ ! -f "$live" ]]; then
  echo "No live calibration at $live — capture some points first." >&2
  exit 1
fi

cp "$live" "$default"
echo "Promoted live calibration -> $default"
echo "Now: git add '$default' && git commit"
