#!/usr/bin/env bash
# Start the same stack as `guitest` (USE_SIM=1 → deploy/startup/start_tmux_dev.sh) in a
# detached tmux session, wait for backend + GUI, run Playwright Sensor Info E2E, then stop
# everything the same way as README `stopgui` (deploy/startup/stop_tmux.sh).
#
# Usage (from repo root):
#   bash test/e2e_guitest_playwright.sh
#
# Env:
#   SKIP_STOP_GUI=1       — do not run stop_tmux.sh at the end (leave stack running)
#   E2E_GUITEST_CLEAN_START=1 — run stop_tmux.sh *before* starting (kill existing sensor-dev)
#   PLAYWRIGHT_BASE_URL   — default http://127.0.0.1:3000
#   Same Playwright / backend checks as test/e2e_sensor_info.sh
#
# C++ build: runs `USE_SIM=1 bash scripts/build.sh` before tmux (same as manually running `build`
# then Playwright). start_tmux skips a duplicate build via SKIP_CPP_BUILD=1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$REPO_ROOT/diablo_server/frontend"

PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:3000}"
BACKEND_CHECK="${E2E_BACKEND_CHECK_URL:-http://127.0.0.1:8081/api/debug}"

cd "$REPO_ROOT"

if [ "${E2E_GUITEST_CLEAN_START:-0}" = "1" ]; then
  echo "E2E_GUITEST_CLEAN_START=1 — stopping any existing stack first..."
  bash "$REPO_ROOT/deploy/startup/stop_tmux.sh"
  sleep 2
fi

if [ ! -d "$FRONTEND/node_modules/@playwright" ]; then
  echo "Installing Playwright (npm install in frontend)..."
  (cd "$FRONTEND" && npm install)
fi
(cd "$FRONTEND" && npx playwright install chromium)

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  C++ build (USE_SIM=1, same as scripts/build.sh / \`build\` alias)"
echo "═══════════════════════════════════════════════════════════════"
export USE_SIM=1
bash "$REPO_ROOT/scripts/build.sh"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Starting guitest stack (USE_SIM=1, detached tmux — no attach)"
echo "═══════════════════════════════════════════════════════════════"
export TMUX_ATTACH=0
# Record the backend's periodic ingest counters. Without this a failed run cannot
# distinguish "Elodin delivered nothing" (entityUpdates=0) from "the GUI stream
# downsampler dropped everything" (entityUpdates>0, broadcasts=0).
export THIN_STATS_LOG=1
# Uniform 5 Hz instead of production 10 Hz / 50 Hz-encoder. These specs check that
# the GUI renders live data, not that the stack sustains hardware rates, and the
# encoder alone was ~39% of UDP traffic (5x rate, exempt from envelope
# downsampling). Cuts total pipeline load ~60% so an 11-process stack plus
# Chromium fits in a 4-core runner. Override with SIM_SENSOR_HZ.
export SIM_SENSOR_HZ="${SIM_SENSOR_HZ:-5}"
SKIP_CPP_BUILD=1 bash "$REPO_ROOT/deploy/startup/start_tmux_dev.sh"

echo ""
echo "Waiting for thin backend at $BACKEND_CHECK ..."
for _ in $(seq 1 120); do
  if curl -sf "$BACKEND_CHECK" >/dev/null 2>&1; then
    echo "  OK"
    break
  fi
  sleep 1
  echo -n "."
done
if ! curl -sf "$BACKEND_CHECK" >/dev/null 2>&1; then
  echo ""
  echo "❌ Backend did not become ready in time." >&2
  exit 1
fi

echo "Waiting for GUI at ${PLAYWRIGHT_BASE_URL}/sensor-info ..."
for _ in $(seq 1 180); do
  if curl -sf "${PLAYWRIGHT_BASE_URL}/sensor-info" >/dev/null 2>&1; then
    echo "  OK"
    break
  fi
  sleep 1
  echo -n "."
done
if ! curl -sf "${PLAYWRIGHT_BASE_URL}/sensor-info" >/dev/null 2>&1; then
  echo ""
  echo "❌ GUI /sensor-info did not become ready in time." >&2
  exit 1
fi

# Dump each stack pane's log tail while the stack is still up — in CI these files
# vanish with the runner, and "all boards DISCONNECTED" class failures can only be
# diagnosed from the sim/bridge/backend panes.
dump_stack_logs() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Backend ingest counters ([ThinServer] Stats, THIN_STATS_LOG=1)"
  echo "═══════════════════════════════════════════════════════════════"
  # Pulled out separately because backend.log's tail fills with WS conn_open/
  # conn_close noise, burying these. entityUpdates=0 means Elodin delivered
  # nothing; entityUpdates>0 with broadcasts=0 means the downsampler ate it.
  if [ -f /tmp/gui_logs/backend.log ]; then
    # Command substitution rather than `grep | tail || echo`: that form only
    # reports "no matches" because pipefail is set, and would silently print
    # nothing if pipefail were ever dropped from the set -e line above.
    local stats
    stats="$(grep -F '[ThinServer] Stats:' /tmp/gui_logs/backend.log | tail -10 || true)"
    if [ -n "$stats" ]; then
      echo "$stats"
    else
      echo "  (no Stats lines — backend never reached its 5s tick, or THIN_STATS_LOG was unset)"
    fi
  else
    echo "  (no backend.log)"
  fi

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Stack logs (/tmp/gui_logs/*.log — last 40 lines each)"
  echo "═══════════════════════════════════════════════════════════════"
  for log in /tmp/gui_logs/*.log; do
    [ -f "$log" ] || continue
    echo ""
    echo "── $log ──"
    tail -40 "$log" || true
  done
}

# Hard gate on EVERY board group reporting, not merely one. The content specs
# assert on all 8 boards and every channel, so starting them while only some
# groups are live produces hundreds of "---" placeholder failures that bury the
# cause — observed repeatedly, with four groups flat at 0 while three flowed.
# Waiting for the whole stack, then asserting, makes the run sequential rather
# than overlapping with startup.
echo "Waiting for ALL board groups to report (boardScanRateHz) ..."
SIM_DATA_OK=0
for _ in $(seq 1 "${SIM_DATA_WAIT_S:-90}"); do
  if curl -sf "$BACKEND_CHECK" 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
rates = d.get("boardScanRateHz") or {}
expected = ("pt1", "pt2", "tc", "rtd", "lc", "act", "enc")
missing = [g for g in expected if not (rates.get(g) or 0) > 0]
if missing:
    sys.stderr.write("still zero: " + ",".join(missing) + "\n")
    sys.exit(1)
sys.exit(0)
' 2>/tmp/e2e_gate_missing.txt; then
    SIM_DATA_OK=1
    echo "  OK"
    break
  fi
  sleep 1
  echo -n "."
done

if [ "$SIM_DATA_OK" != "1" ]; then
  echo ""
  echo "❌ Not every board group reported within ${SIM_DATA_WAIT_S:-90}s, so the content" >&2
  echo "   specs cannot pass. Skipping Playwright." >&2
  if [ -s /tmp/e2e_gate_missing.txt ]; then
    echo "   Groups never seen: $(tail -1 /tmp/e2e_gate_missing.txt)" >&2
  fi
  echo "   See the ingest counters and pane logs below for which stage stalled." >&2
  dump_stack_logs
  PW_EXIT=1
else
  export PLAYWRIGHT_BASE_URL
  set +e
  (cd "$FRONTEND" && npx playwright test e2e)
  PW_EXIT=$?
  set -e

  if [ "$PW_EXIT" -eq 0 ]; then
    echo "Playwright E2E: passed"
  else
    echo "Playwright E2E: failed"
    dump_stack_logs
  fi
fi

if [ "${SKIP_STOP_GUI:-0}" != "1" ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Stopping stack (deploy/startup/stop_tmux.sh — README stopgui)"
  echo "═══════════════════════════════════════════════════════════════"
  bash "$REPO_ROOT/deploy/startup/stop_tmux.sh"
else
  echo "SKIP_STOP_GUI=1 — leaving tmux stack running."
fi

exit "$PW_EXIT"
