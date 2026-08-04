#!/usr/bin/env bash
# daq-server aliases — source this file from ~/.bashrc or ~/.zshrc:
#   echo "source ~/STAR/daq-server/tools/aliases.sh" >> ~/.bashrc   # adjust to your clone path
#
# Or source it manually for the current shell session:
#   source <path-to-STAR>/daq-server/tools/aliases.sh
#
# All aliases are prefixed `daq-` because STAR is a monorepo and these only
# apply to the daq-server subtree.
#
# NOTE: paths are derived from this file's location, so the aliases always act
# on THE checkout you sourced them from. If your shell still sources a copy in
# an old pre-monorepo checkout (~/Diablo-FSW, ~/sensor_system), daq-build /
# daq-test-int will silently operate on the wrong repo — check
# `grep aliases.sh ~/.bashrc`.

_DAQ_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Build ─────────────────────────────────────────────────────────────────────
# USE_SIM is a runtime env var (launch scripts / calibration_service), not a
# compile flag — sim and hardware use identical binaries.
alias daq-build="cd '$_DAQ_ROOT' && bash scripts/build.sh"
alias daq-build-fast="cd '$_DAQ_ROOT/build' && cmake --build . --parallel \$(nproc)"
alias daq-build-frontend="bash '$_DAQ_ROOT/deploy/startup/ensure_frontend_build.sh'"

# ── Tests ─────────────────────────────────────────────────────────────────────
alias daq-test-frontend="cd '$_DAQ_ROOT/diablo_server/frontend' && npm run test"
alias daq-test-frontend-watch="cd '$_DAQ_ROOT/diablo_server/frontend' && npm run test:watch"
alias daq-test-int="cd '$_DAQ_ROOT' && bash test/test_integration.sh"
alias daq-playwright="bash '$_DAQ_ROOT/test/e2e_guitest_playwright.sh'"

# ── Dev stack ─────────────────────────────────────────────────────────────────
# These go through ./dev.sh, the same front door every STAR project has, so
# there is one implementation to keep working. It still runs
# deploy/startup/start_tmux_dev.sh underneath.
#
# daq-gui     → real hardware (USE_SIM unset), attaches to the session
# daq-guitest → fake data via board_simulator (USE_SIM=1), attaches
# The session is started detached either way, so it survives closing the
# terminal — detach with Ctrl-B then D and it keeps running.
alias daq-gui="bash '$_DAQ_ROOT/dev.sh' --attach"
alias daq-guitest="bash '$_DAQ_ROOT/dev.sh' --sim-attach"
alias daq-stopgui="bash '$_DAQ_ROOT/dev.sh' --stop"
alias daq-status="bash '$_DAQ_ROOT/dev.sh' --status"
alias daq-logs="bash '$_DAQ_ROOT/dev.sh' --logs"
alias daq-backend="cd '$_DAQ_ROOT/diablo_server/backend' && npx tsx src/server.ts"
alias daq-frontend="cd '$_DAQ_ROOT/diablo_server/frontend' && npm run dev"

echo "[daq-server aliases] Loaded from $_DAQ_ROOT"
