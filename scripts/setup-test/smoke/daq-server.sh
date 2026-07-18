#!/usr/bin/env bash
# Smoke check: daq-server setup produced a working env.
# Delegates to daq-server/check_env.sh, which already validates:
#   - Python venv + key packages
#   - Node backend + frontend node_modules with expected deps
#   - cmake-built binaries in build/bin/ and shared libs in build/lib/
#   - Rust + elodin-db on PATH
# Runs from the repo root.
set -euo pipefail

# Make sure ~/.cargo/bin is on PATH — rustup writes ~/.cargo/env but a fresh
# non-login shell in the container/scratch dir won't have sourced it.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

bash daq-server/check_env.sh

echo "  ✓ daq-server smoke passed"
