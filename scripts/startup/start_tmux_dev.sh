#!/bin/bash
SESSION="sensor-dev"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Check if services are already running via systemd
if systemctl --user is-active --quiet sensor-backend.service; then
  echo "⚠️  Systemd services are currently running!"
  echo "   This dev script will clash with them. Please stop them first:"
  echo "   systemctl --user stop sensor-backend sensor-frontend sensor-sidecar sensor-elodin"
  exit 1
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
pkill -f "elodin-db run.*2240" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch.*server.ts" 2>/dev/null || true
sleep 1

CMD_DB="printf '\n  ══ ELODIN DB (optional) — :2240 ══\n\n' && mkdir -p $HOME/.local/share/elodin && export SENSOR_KDL_PATH=$PROJECT/archive/legacy/panels/sensor-system.kdl && RUST_LOG=info exec $HOME/.cargo/bin/elodin-db run '[::]:2240' '$HOME/.local/share/elodin/daq_live' --config $PROJECT/archive/legacy/panels/config.lua"
CMD_SIDECAR="printf '\n  ══ CALIBRATION SIDECAR — HTTP :8100, WS :8101 ══\n\n' && cd $PROJECT && PYTHONPATH=$PROJECT exec $HOME/fsw/venv/bin/python3 scripts/calibration/calibration_server.py"
CMD_WEB_BACKEND="printf '\n  ══ WEB GUI BACKEND — WS :8081 ══\n\n' && cd $PROJECT/web-gui/backend && USE_DIRECT_DAQ=true npm run dev 2>&1"
CMD_WEB_FRONTEND="printf '\n  ══ WEB GUI FRONTEND — HTTP :3000 ══\n\n' && sleep 3 && cd $PROJECT/web-gui/frontend && npm run dev 2>&1"

tmux new-session  -d -s "$SESSION" -n main -x 220 -y 60 \
  "bash --norc --noprofile -c \"$CMD_DB\""

tmux set-option -t "$SESSION" remain-on-exit on

tmux split-window -h -t "$SESSION:main.0" \
  "bash --norc --noprofile -c \"$CMD_WEB_BACKEND\""

tmux split-window -v -t "$SESSION:main.0" \
  "bash --norc --noprofile -c \"$CMD_WEB_FRONTEND\""

tmux split-window -v -t "$SESSION:main.1" \
  "bash --norc --noprofile -c \"$CMD_SIDECAR\""

tmux select-pane -t "$SESSION:main.1"

echo "┌────────────────────────────────────────┐"
echo "│  tmux: $SESSION                        │"
echo "│  0: Elodin DB       1: Backend         │"
echo "│  2: Frontend        3: Sidecar         │"
echo "│  Ctrl+B arrows=switch  D=detach        │"
echo "└────────────────────────────────────────┘"
tmux attach -t "$SESSION"
