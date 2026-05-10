#!/usr/bin/env bash
# Project aliases — source this file from ~/.bashrc or ~/.zshrc:
#   echo "source ~/Diablo-FSW/tools/aliases.sh" >> ~/.bashrc
#
# Or source it manually for the current shell session:
#   source ~/Diablo-FSW/tools/aliases.sh

_DIABLO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Build ─────────────────────────────────────────────────────────────────────
alias diablo-build="cd '$_DIABLO_ROOT' && bash scripts/build.sh"
alias diablo-build-fast="cd '$_DIABLO_ROOT/build' && cmake --build . --parallel \$(nproc)"

# ── Tests ─────────────────────────────────────────────────────────────────────
alias test-frontend="cd '$_DIABLO_ROOT/diablo_server/frontend' && npm run test"
alias test-frontend-watch="cd '$_DIABLO_ROOT/diablo_server/frontend' && npm run test:watch"
alias test-integration="cd '$_DIABLO_ROOT' && bash test/test_integration.sh"

# ── Dev stack ─────────────────────────────────────────────────────────────────
alias guitest="cd '$_DIABLO_ROOT' && bash deploy/startup/start_tmux_dev.sh"
alias diablo-backend="cd '$_DIABLO_ROOT/diablo_server/backend' && npx tsx src/server.ts"
alias diablo-frontend="cd '$_DIABLO_ROOT/diablo_server/frontend' && npm run dev"

echo "[Diablo aliases] Loaded. Run 'test-frontend' to run frontend unit tests."
