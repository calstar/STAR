#!/usr/bin/env bash
# firmware/setup.sh — per-project setup for the ESP32 board firmware.
#
# Standalone: `bash firmware/setup.sh` from the repo root gets you to a state
# where `pio run` or `pio test -e native` works in any Hotfire_Code/ project.
# Also invoked by the top-level dispatcher `setup.sh --firmware`.
#
# What it installs:
#   1. Python 3 (Linux only; macOS ships Python 3)
#   2. PlatformIO via pip --user  (pinned to match .github/workflows/firmware-ci.yml)
#   3. Verifies the DAQv2-Comms symlink is intact (Windows-symlinks foot-gun)
#
# Flags:
#   --with-toolchain   Also pre-download the ESP32-S3 toolchain (~500 MB;
#                      otherwise happens on first `pio run` — same end state)
#   --yes / -y         Accept prompts (non-interactive)
#   --help / -h        Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../scripts/setup_common.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIRMWARE_DIR="$SCRIPT_DIR"

WITH_TOOLCHAIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-toolchain) WITH_TOOLCHAIN=1 ;;
    --yes|-y)         export SETUP_YES=1 ;;
    --help|-h)
      awk '/^#!/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) fail "Unknown flag: $1 (try --help)" ;;
  esac
  shift
done

OS="$(detect_os)"
step "firmware setup — OS: $OS"

# ─── 1. Python 3 ─────────────────────────────────────────────────────────────
step "Python 3"

if ! command -v python3 >/dev/null 2>&1; then
  if is_linux; then
    ensure_apt_packages python3 python3-pip
  else
    fail "python3 not found. Install Python 3.11+ (brew install python@3.11 on macOS)"
  fi
fi
ok "python3: $(python3 --version)"

# ─── 2. PlatformIO ───────────────────────────────────────────────────────────
step "PlatformIO CLI"

if command -v pio >/dev/null 2>&1; then
  ok "pio already installed: $(pio --version 2>/dev/null | head -1)"
else
  info "pip3 install --user platformio"
  # --break-system-packages fallback for Ubuntu 22.04+ PEP 668.
  pip3 install --user --quiet platformio \
    || pip3 install --user --quiet --break-system-packages platformio \
    || fail "PlatformIO install failed"

  # Locate the pip --user bin dir to hint about $PATH.
  PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  if is_macos; then
    PY_USER_BIN="$HOME/Library/Python/$PY_VER/bin"
  else
    PY_USER_BIN="$HOME/.local/bin"
  fi

  if ! command -v pio >/dev/null 2>&1; then
    warn "PlatformIO installed but 'pio' not on \$PATH. Add to your shell rc:"
    warn "  export PATH=\"$PY_USER_BIN:\$PATH\""
    warn "Then re-open your shell and run \`pio --version\` to confirm."
  else
    ok "PlatformIO installed: $(pio --version | head -1)"
  fi
fi

# ─── 3. DAQv2-Comms symlink sanity ───────────────────────────────────────────
step "DAQv2-Comms symlink"

LINK="$FIRMWARE_DIR/libraries/DAQv2-Comms"
TARGET="$REPO_ROOT/lib/DAQv2-Comms"

if [ -L "$LINK" ]; then
  RESOLVED="$(cd "$FIRMWARE_DIR/libraries" && cd "$(readlink DAQv2-Comms)" 2>/dev/null && pwd || true)"
  if [ -n "$RESOLVED" ] && [ "$RESOLVED" = "$TARGET" ]; then
    ok "Symlink OK: firmware/libraries/DAQv2-Comms -> lib/DAQv2-Comms"
  else
    warn "Symlink present but resolves to unexpected path: $RESOLVED"
  fi
elif [ -f "$LINK" ]; then
  # Almost certainly a Windows clone without core.symlinks — the "symlink"
  # is a plain text file containing the link target. Explains many "libs
  # missing" build failures on fresh Windows clones.
  fail "firmware/libraries/DAQv2-Comms is a regular file, not a symlink.
        You likely cloned on Windows without symlinks enabled.
        Fix: git config --global core.symlinks true, then re-clone.
        (Or use WSL — strongly recommended.)"
else
  fail "firmware/libraries/DAQv2-Comms is missing entirely — repo is malformed."
fi

# ─── 4. Optional: pre-download ESP32-S3 toolchain ────────────────────────────
if [ "$WITH_TOOLCHAIN" = "1" ]; then
  step "Pre-downloading ESP32-S3 toolchain (~500 MB)"
  if ! command -v pio >/dev/null 2>&1; then
    warn "pio not on \$PATH yet — skipping toolchain pre-download."
    warn "Re-run with \$PATH fixed, or the first \`pio run\` will fetch it."
  else
    # Any hotfire project pulls the toolchain via `pio pkg install`.
    (cd "$FIRMWARE_DIR/Hotfire_Code/PT_Hotfire" && pio pkg install)
    ok "Toolchain cached"
  fi
fi

step "firmware setup complete"

cat <<EOF

Next steps:

  1. Run the host unit tests (fast, no board needed):
       cd firmware/Hotfire_Code/Hotfire_Tests
       pio test -e native

  2. Compile-check a flight project (fetches ESP32 toolchain on first run):
       cd firmware/Hotfire_Code/PT_Hotfire
       pio run

  3. Compile-check all flight projects at once:
       for p in PT TC RTD LC Actuator; do
         (cd firmware/Hotfire_Code/\${p}_Hotfire && pio run) || exit 1
       done

EOF
