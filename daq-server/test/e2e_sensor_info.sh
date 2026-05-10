#!/usr/bin/env bash
# Run Playwright Sensor Info E2E against a stack that is ALREADY running.
#
# Presets (NEXT_PUBLIC_* must match how you started the thin backend):
#   • integration — same ports as test_integration.sh (default TEST_BACKEND_WS_PORT=8181):
#       export NEXT_PUBLIC_API_URL=http://127.0.0.1:${TEST_BACKEND_WS_PORT:-8181}
#       export NEXT_PUBLIC_WS_URL=ws://127.0.0.1:${TEST_BACKEND_WS_PORT:-8181}
#   • dev (guitest / start_tmux_dev): deploy/startup/start_tmux_dev.sh sets NEXT_PUBLIC_* to
#     THIN_WS_PORT (default 8081) when launching `npm run dev` — do not rely on .env.local alone.
#
# Next.js: if something is already serving PLAYWRIGHT_BASE_URL (e.g. guitest on :3000), this script
# reuses it and does NOT start a second dev server or kill :3000 on exit.
#
# Usage:
#   # Terminal 1: guitest (or any stack with backend :8081 + Next :3000)
#   # Terminal 2:
#   bash test/e2e_sensor_info.sh
#
# Env:
#   PLAYWRIGHT_BASE_URL   default http://127.0.0.1:3000
#   E2E_BACKEND_CHECK_URL optional; default ${NEXT_PUBLIC_API_URL:-http://127.0.0.1:8081}/api/debug
#   SKIP_BACKEND_CHECK    set to 1 to skip curl check (not recommended)
#   E2E_FORCE_START_NEXT  set to 1 to always npm run dev (fails if :3000 busy)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$REPO_ROOT/diablo_server/frontend"

PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:3000}"
BACKEND_CHECK="${E2E_BACKEND_CHECK_URL:-${NEXT_PUBLIC_API_URL:-http://127.0.0.1:8081}/api/debug}"

if [ "${SKIP_BACKEND_CHECK:-0}" != "1" ]; then
  echo "Checking backend at $BACKEND_CHECK ..."
  if ! curl -sf "$BACKEND_CHECK" >/dev/null; then
    echo "❌ Backend not reachable. Start the stack first (matching NEXT_PUBLIC_*)." >&2
    exit 1
  fi
  echo "  OK"
fi

if [ ! -d "$FRONTEND/node_modules/@playwright" ]; then
  echo "Installing Playwright (npm install in frontend)..."
  (cd "$FRONTEND" && npm install)
fi
(cd "$FRONTEND" && npx playwright install chromium)

WE_STARTED_NEXT=0
NEXT_PID=""

cleanup() {
  if [ "$WE_STARTED_NEXT" = "1" ] && [ -n "${NEXT_PID:-}" ] && kill -0 "$NEXT_PID" 2>/dev/null; then
    kill "$NEXT_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$NEXT_PID" 2>/dev/null || true
  fi
  if [ "$WE_STARTED_NEXT" = "1" ] && command -v fuser >/dev/null 2>&1; then
    fuser -k 3000/tcp 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ "${E2E_FORCE_START_NEXT:-0}" != "1" ] && curl -sf "${PLAYWRIGHT_BASE_URL}/sensor-info" >/dev/null 2>&1; then
  echo "Next.js already up at $PLAYWRIGHT_BASE_URL — reusing (guitest / existing dev server)."
else
  if [ "${E2E_FORCE_START_NEXT:-0}" != "1" ] && { command -v fuser >/dev/null 2>&1 && fuser 3000/tcp >/dev/null 2>&1; }; then
    echo "❌ Port 3000 is in use but ${PLAYWRIGHT_BASE_URL}/sensor-info did not respond." >&2
    echo "   Stop the other process or set PLAYWRIGHT_BASE_URL to match where Next is running." >&2
    exit 1
  fi
  API_URL="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:8081}"
  if [ -n "${NEXT_PUBLIC_WS_URL:-}" ]; then
    WS_URL="$NEXT_PUBLIC_WS_URL"
  else
    # Same port as API (e.g. 8181 for integration) when only NEXT_PUBLIC_API_URL is set
    PORT="${API_URL##*:}"
    PORT="${PORT%%/*}"
    WS_URL="ws://127.0.0.1:${PORT}"
  fi
  echo "Starting Next.js dev (NEXT_PUBLIC_API_URL=$API_URL NEXT_PUBLIC_WS_URL=$WS_URL)..."
  (cd "$FRONTEND" && PORT=3000 NEXT_PUBLIC_API_URL="$API_URL" NEXT_PUBLIC_WS_URL="$WS_URL" npm run dev) &
  NEXT_PID=$!
  WE_STARTED_NEXT=1

  echo -n "Waiting for Next.js at $PLAYWRIGHT_BASE_URL/sensor-info ..."
  for _ in $(seq 1 120); do
    if curl -sf "${PLAYWRIGHT_BASE_URL}/sensor-info" >/dev/null 2>&1; then
      echo " ready"
      break
    fi
    sleep 1
    echo -n "."
  done

  if ! curl -sf "${PLAYWRIGHT_BASE_URL}/sensor-info" >/dev/null 2>&1; then
    echo " TIMEOUT"
    exit 1
  fi
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

exit "$PW_EXIT"
