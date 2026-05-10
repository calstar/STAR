#!/bin/bash
# Stop all Sensor System processes, tmux sessions, and ports.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Stopping Sensor System tmux sessions and processes..."

# ── Tmux sessions ─────────────────────────────────────────────────────────────
for session in sensor-dev sensor-db-only sensor-logs sensor; do
    tmux kill-session -t "$session" 2>/dev/null || true
done

# ── C++ FSW services ──────────────────────────────────────────────────────────
pkill -f "daq_bridge"                  2>/dev/null || true
pkill -f "calibration_service"         2>/dev/null || true
pkill -f "sequencer_service"           2>/dev/null || true
pkill -f "actuator_service"            2>/dev/null || true
pkill -f "heartbeat_service"           2>/dev/null || true
pkill -f "config_broadcast_service"    2>/dev/null || true
pkill -f "controller_service"          2>/dev/null || true
pkill -f "ota_service"                 2>/dev/null || true
pkill -f "board_simulator"             2>/dev/null || true

# ── Elodin DB ─────────────────────────────────────────────────────────────────
pkill -f "elodin-db run.*2240"         2>/dev/null || true

# ── Web GUI (frontend + backend) ──────────────────────────────────────────────
# Repo-anchored only — do not use pkill -f "node.*server" (matches IDE remote Node).
pkill -f "next dev"                    2>/dev/null || true
pkill -f "${REPO_ROOT}/diablo_server/backend.*server\.ts" 2>/dev/null || true
pkill -f "${REPO_ROOT}/diablo_server/backend.*server-legacy\.ts" 2>/dev/null || true
pkill -f "${REPO_ROOT}/diablo_server/backend.*elodin-relay\.ts" 2>/dev/null || true
pkill -f "${REPO_ROOT}/diablo_server/backend.*dist/server\.js" 2>/dev/null || true

# ── Python calibration sidecar ────────────────────────────────────────────────
pkill -f "calibration_server.py"       2>/dev/null || true

# ── Systemd user services (stop AND disable restart so they don't come back) ──
for svc in sensor-calibration sensor-daq sensor-actuator sensor-controller sensor-heartbeat sensor-config-broadcast sensor-backend sensor-frontend sensor-sidecar sensor-elodin; do
    if systemctl --user is-active --quiet "${svc}.service" 2>/dev/null; then
        echo "  Stopping systemd service: $svc"
        systemctl --user stop "${svc}.service" 2>/dev/null || true
    fi
done

# ── Brief grace period then force-kill anything still holding ports ───────────
sleep 0.5

for port in 9999 9998 9997 8081 8082 3000 2240 5005; do
    pid=$(ss -tlpn "sport = :${port}" 2>/dev/null | grep -oP '(?<=pid=)\d+' | head -1)
    if [ -n "$pid" ]; then
        echo "  Force-killing PID $pid still on port $port"
        kill -9 "$pid" 2>/dev/null || true
    fi
done

echo "✅ All sessions and processes stopped."
