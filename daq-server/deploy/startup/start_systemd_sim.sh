#!/bin/bash
# Dev/CI harness: run the DAQ stack in the SAME systemd config the server uses,
# but with a simulator overlay so no hardware is needed. This is the local
# equivalent of the production box — the session button (SESSION_SERVICE_MODE=
# systemd) actually starts/stops the real pipeline via `systemctl --user`.
#
# What this does NOT start: the per-run pipeline (elodin/daq/calibration/
# controller/actuator/simulator). Those are started BY THE SESSION BUTTON, exactly
# like production. This script only brings up the always-on web + support layer.
#
# Teardown: deploy/startup/stop_systemd_sim.sh
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # daq-server/
DAQ_DIR="$HOME/.config/daq"
SIM_CONFIG="$PROJECT/config/sim_config.toml"
PIPELINE_ENV="$DAQ_DIR/pipeline.env"
LINK="$HOME/sensor_system"

echo "▶ DAQ systemd sim harness"
echo "  project: $PROJECT"

# ── Preconditions ────────────────────────────────────────────────────────────
command -v systemctl >/dev/null || { echo "❌ systemctl not found"; exit 1; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# Probe the user bus with show-environment, NOT is-system-running: the latter
# exits non-zero on "degraded" (any failed unit), which is a false negative here.
if ! systemctl --user show-environment >/dev/null 2>&1; then
  # enable-linger starts a persistent user systemd instance even without a login session.
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" 2>/dev/null || true
  for _ in $(seq 1 30); do systemctl --user show-environment >/dev/null 2>&1 && break; sleep 1; done
fi
systemctl --user show-environment >/dev/null 2>&1 || {
  echo "❌ 'systemctl --user' is not available. On CI: enable-linger + export XDG_RUNTIME_DIR."; exit 1; }

ELODIN_DB_BIN="$HOME/.cargo/bin/elodin-db"
[ -x "$ELODIN_DB_BIN" ] || ELODIN_DB_BIN="$(command -v elodin-db || true)"
[ -n "$ELODIN_DB_BIN" ] || { echo "❌ elodin-db not found (install via cargo)"; exit 1; }

# ── C++ binaries (USE_SIM runtime flag; sim + hardware share binaries) ────────
if [ "${SKIP_CPP_BUILD:-0}" != "1" ] && [ ! -x "$PROJECT/build/bin/daq_bridge" ]; then
  echo "🔨 Building C++ binaries (USE_SIM=1)…"
  USE_SIM=1 bash "$PROJECT/scripts/build.sh"
fi

# ── Sim overlay: remapped config + pipeline.env ──────────────────────────────
# Board IPs 192.168.2.x → 127.0.0.x so the simulator can bind them on loopback,
# exactly as start_tmux_dev.sh does for its sim config.
mkdir -p "$DAQ_DIR"
sed 's/192\.168\.2\./127.0.0./g' "$PROJECT/config/config.toml" > "$SIM_CONFIG"
cat > "$PIPELINE_ENV" <<EOF
# Written by start_systemd_sim.sh — points the always-on backend at the remapped
# (no-hardware) config. The data source (live vs simulated) is chosen PER RUN from
# the Session screen: session-start writes USE_SIM + the pipeline's config into this
# file itself, so the harness no longer forces USE_SIM. Remove (stop_systemd_sim.sh)
# to return to a hardware config.
DAQ_CONFIG=$SIM_CONFIG
CONFIG_PATH=$SIM_CONFIG
EOF
# Optional: fast auto-stop warnings for the integration test (env passthrough).
[ -n "${SESSION_WARN_LEADS_MS:-}" ] && echo "SESSION_WARN_LEADS_MS=$SESSION_WARN_LEADS_MS" >> "$PIPELINE_ENV"
echo "  sim config: $SIM_CONFIG"
echo "  overlay:    $PIPELINE_ENV"

# ── Units expect WorkingDirectory=~/sensor_system ────────────────────────────
if [ -L "$LINK" ] || [ ! -e "$LINK" ]; then
  ln -sfn "$PROJECT" "$LINK"
  echo "  symlink:    $LINK → $PROJECT"
elif [ "$(cd "$LINK" && pwd)" != "$PROJECT" ]; then
  echo "⚠️  $LINK exists and is not this repo — leaving it as-is (units will use it)."
fi

# ── Install + reload units ───────────────────────────────────────────────────
bash "$PROJECT/deploy/systemd/install_services.sh" >/dev/null
systemctl --user daemon-reload

# ── Clean slate, then start only the always-on web + support layer ───────────
PIPELINE_UNITS="sensor-elodin sensor-daq sensor-calibration sensor-controller sensor-actuator sensor-simulator"
# SKIP_FRONTEND=1 omits the Vite dist build (CI/WS-only runs don't need the GUI;
# the backend still serves :8081 and, if dist already exists, :3000).
WEB_UNITS="sensor-backend sensor-config-broadcast sensor-heartbeat"
[ "${SKIP_FRONTEND:-0}" = "1" ] || WEB_UNITS="sensor-frontend $WEB_UNITS"
systemctl --user stop $PIPELINE_UNITS sensor-frontend $WEB_UNITS 2>/dev/null || true

echo "▶ Starting web + support layer (pipeline is started by the session button)…"
systemctl --user start $WEB_UNITS

echo ""
echo "✅ Up. Open http://localhost:3000  →  Session → Start run (brings the pipeline up)."
echo "   Live journal:   journalctl --user -f -u sensor-backend -u sensor-elodin -u sensor-daq"
echo "   Pipeline state: systemctl --user is-active sensor-elodin"
echo "   Tear down:      bash $PROJECT/deploy/startup/stop_systemd_sim.sh"
