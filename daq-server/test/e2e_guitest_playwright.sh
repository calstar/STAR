#!/usr/bin/env bash
# Start the same stack as `guitest` (USE_SIM=1 → deploy/startup/start_tmux_dev.sh) in a
# detached tmux session, wait for backend + Next, run Playwright Sensor Info E2E, then stop
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

echo "Waiting for Next.js at ${PLAYWRIGHT_BASE_URL}/sensor-info ..."
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
  echo "❌ Next.js /sensor-info did not become ready in time." >&2
  exit 1
fi

export PLAYWRIGHT_BASE_URL
set +e
(cd "$FRONTEND" && npx playwright test e2e)
PW_EXIT=$?
set -e

if [ "$PW_EXIT" -eq 0 ]; then
  echo "Playwright E2E: passed"
else
  echo "Playwright E2E: failed"
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
