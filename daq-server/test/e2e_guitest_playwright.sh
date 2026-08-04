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
# Sensor rate: unset → production rates (10 Hz, 50 Hz encoder), so running this
# locally exercises the stack the way it actually runs. CI sets SIM_SENSOR_HZ=5
# (see .github/workflows/daq-server-ci.yml) — a 4-core runner cannot carry an
# 11-process stack plus Chromium at full rate, and the resulting starvation, not
# any defect, was what kept these specs red.
export SIM_SENSOR_HZ="${SIM_SENSOR_HZ:-}"
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
  echo "  Backend /api/debug (boardScanRateHz per group)"
  echo "═══════════════════════════════════════════════════════════════"
  # A group at exactly 0 means Elodin's live stream delivered nothing for it —
  # see docs/LOSSLESS_LIVE_INGESTION.md. Which groups starve varies per run, so
  # capture the actual numbers rather than inferring them from spec output.
  curl -sf "$BACKEND_CHECK" 2>/dev/null | python3 -m json.tool 2>/dev/null \
    || echo "  (/api/debug unreachable — backend already down?)"

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

# Gate on data reaching the backend, then let the stack settle before asserting.
#
# Deliberately NOT "every group must report": only pt1 has ever populated
# boardScanRateHz in this stack — the other six read "---" even on runs that
# otherwise pass, so requiring all seven blocks every run. Whether the other
# groups *should* populate is a real question, but it is not this gate's job to
# answer and it must not be a merge blocker.
#
# So: require at least one group (proves UDP -> bridge -> Elodin -> backend
# works), then keep polling a short settle window while new groups keep
# appearing, so the specs start against a stack that has stopped changing rather
# than one mid-startup. Report the final per-group state either way, and proceed.
echo "Waiting for board sim data (boardScanRateHz) ..."
SIM_DATA_OK=0
group_state() {
  curl -sf "$BACKEND_CHECK" 2>/dev/null | python3 -c '
import json, sys
try:
    rates = (json.load(sys.stdin).get("boardScanRateHz") or {})
except Exception:
    print("live=0 |")
    sys.exit(0)
live = [g for g, v in rates.items() if (v or 0) > 0]
parts = " ".join(f"{g}={float(v or 0):.1f}" for g, v in sorted(rates.items()))
print(f"live={len(live)} | {parts}")
' 2>/dev/null || echo "live=0 |"
}
for _ in $(seq 1 "${SIM_DATA_WAIT_S:-90}"); do
  state="$(group_state)"
  if [ "${state%% *}" != "live=0" ]; then
    SIM_DATA_OK=1
    echo "  OK — $state"
    break
  fi
  sleep 1
  echo -n "."
done

# Settle: give late groups a chance to appear so the specs assert against a
# stable stack. Capped, and never fatal.
if [ "$SIM_DATA_OK" = "1" ]; then
  settle="${SIM_SETTLE_S:-15}"
  echo "  Settling ${settle}s for any remaining groups ..."
  sleep "$settle"
  echo "  Final board groups: $(group_state)"
fi

if [ "$SIM_DATA_OK" != "1" ]; then
  echo ""
  echo "❌ No board group reported any data within ${SIM_DATA_WAIT_S:-90}s — nothing" >&2
  echo "   reached the backend at all, so the content specs cannot pass. Skipping" >&2
  echo "   Playwright; see the counters and pane logs below for which stage stalled." >&2
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
