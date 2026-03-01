#!/bin/bash
SESSION="sensor-logs"

# Ensure services exist/are running
if ! systemctl --user is-active --quiet sensor-backend.service; then
  echo "⚠️  Services do not appear to be running."
  echo "   Start them with: systemctl --user start sensor-backend sensor-frontend sensor-sidecar sensor-elodin"
  echo "   (or run scripts/systemd/install_services.sh first)"
  sleep 2
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true

tmux new-session  -d -s "$SESSION" -n logs -x 220 -y 60 \
  "journalctl --user-unit=sensor-elodin.service -f"
tmux set-option -t "$SESSION" remain-on-exit on

tmux split-window -h -t "$SESSION:logs.0" \
  "journalctl --user-unit=sensor-backend.service -f"

tmux split-window -v -t "$SESSION:logs.0" \
  "journalctl --user-unit=sensor-frontend.service -f"

tmux split-window -v -t "$SESSION:logs.1" \
  "journalctl --user-unit=sensor-sidecar.service -f"

tmux select-pane -t "$SESSION:logs.1"

echo "┌────────────────────────────────────────┐"
echo "│  tmux: $SESSION                        │"
echo "│  0: Elodin DB logs  1: Backend logs    │"
echo "│  2: Frontend logs   3: Sidecar logs    │"
echo "│  Ctrl+C to stop following logs locally │"
echo "└────────────────────────────────────────┘"
tmux attach -t "$SESSION"
