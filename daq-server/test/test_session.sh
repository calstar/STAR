#!/bin/bash
# Session-control integration test: brings the stack up in the SAME systemd
# config the server uses (sim overlay, no hardware), then drives the run-session
# feature over the WebSocket and asserts the full lifecycle — start → real
# pipeline up + data flowing → auto-stop warnings → auto-stop → Discard cleanup,
# plus Save + extend. This is the first CI coverage of the systemd session path
# (the rest of CI only exercises the inert `off`/launch-site mode).
#
# Usage:  bash test/test_session.sh          (from daq-server/ or repo root)
# Env:    SESSION_WARN_LEADS_MS (default 20000,10000), SESSION_TEST_DURATION_MS (30000)
set -uo pipefail

DAQ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # daq-server/
cd "$DAQ_DIR"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export SESSION_WARN_LEADS_MS="${SESSION_WARN_LEADS_MS:-20000,10000}"
export SESSION_TEST_DURATION_MS="${SESSION_TEST_DURATION_MS:-30000}"
export SKIP_FRONTEND=1   # WS test hits :8081 directly; no GUI/Vite build needed
export SKIP_CPP_BUILD="${SKIP_CPP_BUILD:-1}"  # CI supplies prebuilt binaries

PIPELINE_UNITS="sensor-elodin sensor-daq sensor-calibration sensor-controller sensor-actuator sensor-simulator"
fail() { echo "❌ $*"; teardown; exit 1; }
teardown() { bash "$DAQ_DIR/deploy/startup/stop_systemd_sim.sh" >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "═══ Session control integration test ═══"

# 1. Bring up the web+support layer in systemd sim mode (fast warn leads injected).
bash "$DAQ_DIR/deploy/startup/start_systemd_sim.sh" || fail "harness failed to start"

# 2. Wait for the backend WS to accept connections.
echo -n "  waiting for backend WS :8081"
for _ in $(seq 1 40); do
  (echo >/dev/tcp/127.0.0.1/8081) 2>/dev/null && break
  echo -n .; sleep 1
done
echo
(echo >/dev/tcp/127.0.0.1/8081) 2>/dev/null || fail "backend WS never came up"

# 3. Pipeline must be idle before any run (session-gated, not auto-started).
for u in $PIPELINE_UNITS; do
  [ "$(systemctl --user is-active "$u")" = "active" ] && fail "$u active before any run started"
done
echo "  ✅ pipeline idle before start"

# 4. Drive the full session lifecycle over the WebSocket.
#    NODE_PATH → backend node_modules so the test's `ws` import resolves (the
#    test file lives in test/, which has no node_modules — same as ws_data_flow_test).
( cd "$DAQ_DIR/diablo_server/backend" \
  && NODE_PATH="$DAQ_DIR/diablo_server/backend/node_modules" \
     npx tsx "$DAQ_DIR/test/session_flow_test.ts" ) || fail "session_flow_test failed"

# 5. Pipeline must be torn down again after the runs complete.
sleep 3
for u in $PIPELINE_UNITS; do
  [ "$(systemctl --user is-active "$u")" = "active" ] && fail "$u still active after runs finished"
done
echo "  ✅ pipeline torn down after runs"

echo "✅ Session control integration test PASSED"
