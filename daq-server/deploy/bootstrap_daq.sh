#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-shot DAQ-server bootstrap (native systemd --user deploy).
#
# Clone → deps (apt + Node + elodin-db) → build C++ → build SPA → install units →
# start the web layer. Idempotent: safe to re-run to update an existing box.
#
# Run as the DAQ USER (not root). Only apt needs sudo; everything else is user-space.
#   bash deploy/bootstrap_daq.sh                 # from an existing checkout, or:
#   curl -LsSf <raw-url>/bootstrap_daq.sh | BRANCH=main bash
#
# Env knobs:
#   BRANCH        git branch to deploy            (default: main)
#   DAQ_CLONE     where to clone/find the repo    (default: ~/STAR-daq)
#   REPO_URL      git remote                      (default: https://github.com/calstar/STAR.git)
#   USE_SIM       1 = build/run without hardware  (default: 0)
#   START         1 = enable+start web layer      (default: 1; 0 = build/install only)
#
# Fixes the historical setup pitfalls: single elodin-db version pinned to what CI
# validates; every step actually runs (no commented-out installs); elodin-db is
# HARD-VERIFIED after install (a missing DB is a loud failure here, not a silent
# 5-second unit respawn later).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Single source of truth: match the version CI installs + validates against ──
# (.github/workflows/daq-server-ci.yml pins the same v0.16.1; keep these in lockstep.)
ELODIN_VERSION="v0.16.1"

BRANCH="${BRANCH:-main}"
DAQ_CLONE="${DAQ_CLONE:-$HOME/STAR-daq}"
REPO_URL="${REPO_URL:-https://github.com/calstar/STAR.git}"
USE_SIM="${USE_SIM:-0}"
START="${START:-1}"

CARGO_BIN="$HOME/.cargo/bin"
ELODIN_BIN="$CARGO_BIN/elodin-db"

c_ok(){ printf '\033[32m✅ %s\033[0m\n' "$*"; }
c_info(){ printf '\033[36m▶  %s\033[0m\n' "$*"; }
c_warn(){ printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
c_die(){ printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || c_die "Run as the DAQ user, NOT root (sudo re-roots ~/.cargo, ~/.config, and the repo). Only apt uses sudo, internally."

# ── 1. apt prerequisites (the only sudo) ──────────────────────────────────────
c_info "apt prerequisites"
sudo apt-get update
sudo apt-get install -y \
  build-essential cmake ninja-build libeigen3-dev pkg-config \
  python3 python3-venv zlib1g-dev libssl-dev curl git
c_ok "build deps installed"

# ── 2. Node 20+ ───────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 20 ] 2>/dev/null; then
  c_ok "Node $(node -v) already present"
else
  c_info "installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  c_ok "Node $(node -v) installed"
fi

# ── 3. elodin-db (pinned, prebuilt-first with source fallback, HARD-verified) ──
install_elodin() {
  mkdir -p "$CARGO_BIN"
  local url="https://github.com/elodin-sys/elodin/releases/download/${ELODIN_VERSION}/elodin-db-installer.sh"
  c_info "installing elodin-db ${ELODIN_VERSION} (prebuilt installer)"
  if curl --proto '=https' --tlsv1.2 -LsSf "$url" | sh; then
    return 0
  fi
  c_warn "prebuilt installer failed (expected on ARM64/glibc, e.g. Jetson — prebuilt is musl-only). Building from source…"
  command -v cargo >/dev/null 2>&1 || { curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; . "$HOME/.cargo/env"; }
  . "$HOME/.cargo/env" 2>/dev/null || true
  local src="/tmp/elodin-src-$$"; rm -rf "$src"
  git clone --depth 1 --branch "$ELODIN_VERSION" https://github.com/elodin-sys/elodin.git "$src"
  # The crate root has moved between elodin releases (libs/db vs libs/db/cli) — try both
  # rather than pin one that may be wrong for this tag. Binary installs as impeller2-cli.
  ( cd "$src" && (cargo install --path libs/db/cli || cargo install --path libs/db) )
  rm -rf "$src"
  [ -x "$ELODIN_BIN" ] || { [ -x "$CARGO_BIN/impeller2-cli" ] && ln -sf impeller2-cli "$ELODIN_BIN"; }
}

if [ -x "$ELODIN_BIN" ] && "$ELODIN_BIN" --version >/dev/null 2>&1; then
  c_ok "elodin-db already installed: $("$ELODIN_BIN" --version 2>/dev/null || echo present)"
else
  install_elodin
fi
# HARD verify — a box that reaches here without a runnable elodin-db must fail NOW,
# not crash-loop sensor-elodin every 5s later with nothing in `systemctl --user --failed`.
[ -x "$ELODIN_BIN" ] || c_die "elodin-db not installed at $ELODIN_BIN"
"$ELODIN_BIN" --version >/dev/null 2>&1 || c_die "elodin-db at $ELODIN_BIN is present but won't run (arch/deps mismatch)"
case ":$PATH:" in *":$CARGO_BIN:"*) : ;; *) c_warn "$CARGO_BIN is not on PATH — units use the absolute path, but add it to your shell profile" ;; esac
c_ok "elodin-db verified: $("$ELODIN_BIN" --version)"

# ── 4. Clone or update the repo ───────────────────────────────────────────────
if [ -d "$DAQ_CLONE/.git" ]; then
  c_info "updating $DAQ_CLONE → origin/$BRANCH"
  git -C "$DAQ_CLONE" fetch --depth 1 origin "$BRANCH"
  git -C "$DAQ_CLONE" checkout -f -B "$BRANCH" FETCH_HEAD
else
  c_info "cloning $REPO_URL ($BRANCH) → $DAQ_CLONE"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DAQ_CLONE"
fi
DAQ="$DAQ_CLONE/daq-server"
[ -f "$DAQ/scripts/build.sh" ] || c_die "$DAQ/scripts/build.sh missing — is $DAQ_CLONE the STAR monorepo?"
c_ok "repo at $(git -C "$DAQ_CLONE" rev-parse --short HEAD) ($BRANCH)"

# ── 5. Build C++ (also materializes config.toml from the active/default profile) ──
c_info "building C++ (USE_SIM=$USE_SIM)"
( cd "$DAQ" && USE_SIM="$USE_SIM" bash scripts/build.sh )
c_ok "C++ built → $DAQ/build/bin"

# ── 6. Web GUI deps + SPA build ───────────────────────────────────────────────
c_info "installing web-gui deps + building the SPA"
( cd "$DAQ/diablo_server/backend"  && (npm ci || npm install) )
( cd "$DAQ/diablo_server/frontend" && (npm ci || npm install) )
( cd "$DAQ" && FRONTEND_FORCE_BUILD=1 bash deploy/startup/ensure_frontend_build.sh )
c_ok "SPA built → diablo_server/frontend/dist"

# ── 7. Install systemd --user units ───────────────────────────────────────────
c_info "installing systemd --user units"
bash "$DAQ/deploy/systemd/install_services.sh"
c_ok "units installed (WorkingDirectory → $DAQ)"

# ── 8. Enable + start the always-on web layer ─────────────────────────────────
if [ "$START" = "1" ]; then
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    c_warn "'systemctl --user' bus not available in this shell — skipping start."
    c_warn "Fix (headless): 'loginctl enable-linger $USER' then log in fresh (or: export XDG_RUNTIME_DIR=/run/user/\$(id -u)); then re-run with START=1."
  else
    loginctl enable-linger "$USER" 2>/dev/null || true
    systemctl --user daemon-reload
    c_info "enabling + starting the web layer"
    systemctl --user enable --now sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat
    sleep 2
    systemctl --user --no-pager status sensor-backend | head -5 || true
    c_ok "web layer up — API :8081, SPA :3000. Session pipeline starts on demand (GUI Session button)."
  fi
else
  c_info "START=0 — built + installed only; not enabling services."
fi

# ── 9. Firewall: allow inbound board UDP on the board-LAN NIC (ufw only, idempotent) ──
# The host firewall blocks the boards' UDP otherwise — the boards send sensor data / heartbeats /
# self-test / logs to :5006 and the FSW config manager listens on :5008. (5005 is server→board,
# outbound, already allowed.) Interface-scoped so only the board LAN can reach these ports.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  IFACE="${BOARD_IFACE:-$(ip -o -4 addr show 2>/dev/null | awk '$4 ~ /^192\.168\.2\./ {print $2; exit}')}"
  if [ -n "$IFACE" ]; then
    c_info "ufw: allowing inbound board UDP on $IFACE (5006 sensor data, 5008 FSW config)"
    sudo ufw allow in on "$IFACE" from 192.168.2.0/24 to any port 5006 proto udp comment 'DAQ sensor data'
    sudo ufw allow in on "$IFACE" from 192.168.2.0/24 to any port 5008 proto udp comment 'DAQ FSW config'
    c_ok "firewall rules applied"
  else
    c_warn "ufw active but no NIC on 192.168.2.x yet — set the board NIC to 192.168.2.20/24 first, then either re-run this script or add manually:"
    echo "    sudo ufw allow in on <iface> from 192.168.2.0/24 to any port 5006 proto udp comment 'DAQ sensor data'"
    echo "    sudo ufw allow in on <iface> from 192.168.2.0/24 to any port 5008 proto udp comment 'DAQ FSW config'"
  fi
else
  c_info "ufw not active — skipping firewall rules (nothing blocking board UDP)."
fi

echo
c_ok "DAQ bootstrap complete."
echo "  Verify:  curl -s localhost:8081/api/debug | head ;  curl -sI localhost:3000 | head -1"
echo "  Logs:    journalctl --user -u sensor-backend -f"
echo "  Config:  edit via the GUI Config tab (profiles); config.toml is generated from config/profiles/*.toml"
[ "$USE_SIM" = "1" ] && echo "  No-hardware run:  bash $DAQ/deploy/startup/start_systemd_sim.sh"
echo "  Network reminder: the board-LAN NIC must be statically 192.168.2.20/24 (firmware targets 192.168.2.20:5006)."
