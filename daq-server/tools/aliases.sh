#!/usr/bin/env bash
# Project aliases — source this file from ~/.bashrc or ~/.zshrc:
#   echo "source ~/STAR/daq-server/tools/aliases.sh" >> ~/.bashrc   # adjust to your clone path
#
# Or source it manually for the current shell session:
#   source <path-to-STAR>/daq-server/tools/aliases.sh
#
# NOTE: paths are derived from this file's location, so the aliases always act
# on THE checkout you sourced them from. If your shell still sources a copy in
# an old pre-monorepo checkout (~/Diablo-FSW, ~/sensor_system), build/int will
# silently operate on the wrong repo — check `grep aliases.sh ~/.bashrc`.

_DIABLO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Build ─────────────────────────────────────────────────────────────────────
# USE_SIM is a runtime env var (launch scripts / calibration_service), not a
# compile flag — sim and hardware use identical binaries.
alias build="cd '$_DIABLO_ROOT' && bash scripts/build.sh"
alias diablo-build="cd '$_DIABLO_ROOT' && bash scripts/build.sh"
alias diablo-build-fast="cd '$_DIABLO_ROOT/build' && cmake --build . --parallel \$(nproc)"
alias build-frontend="bash '$_DIABLO_ROOT/deploy/startup/ensure_frontend_build.sh'"

# ── Tests ─────────────────────────────────────────────────────────────────────
alias test-frontend="cd '$_DIABLO_ROOT/diablo_server/frontend' && npm run test"
alias test-frontend-watch="cd '$_DIABLO_ROOT/diablo_server/frontend' && npm run test:watch"
alias int="cd '$_DIABLO_ROOT' && bash test/test_integration.sh"
alias test-integration="cd '$_DIABLO_ROOT' && bash test/test_integration.sh"

# ── Dev stack ─────────────────────────────────────────────────────────────────
alias guitest="cd '$_DIABLO_ROOT' && bash deploy/startup/start_tmux_dev.sh"
alias stopgui="cd '$_DIABLO_ROOT' && bash deploy/startup/stop_tmux.sh"
alias diablo-backend="cd '$_DIABLO_ROOT/diablo_server/backend' && npx tsx src/server.ts"
alias diablo-frontend="cd '$_DIABLO_ROOT/diablo_server/frontend' && npm run dev"

echo "[Diablo aliases] Loaded from $_DIABLO_ROOT"
