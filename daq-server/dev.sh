#!/usr/bin/env bash
# DAQ server dev stack.
#
# This is a front door, not a reimplementation. The DAQ stack is eleven
# coordinated processes (simulator, daq_bridge, elodin-db, calibration,
# backend, frontend build, heartbeat, config broadcast, sequencer, OTA,
# controller) with real ordering constraints between them, and that lives in
# deploy/startup/start_tmux_dev.sh. All this does is give it the same flags as
# every other project's ./dev.sh.
#
#   ./dev.sh                 start detached
#   ./dev.sh --sim           start detached with the board simulator (no hardware)
#   ./dev.sh -a, --attach    start if needed, then attach
#   ./dev.sh --stop          stop it
#   ./dev.sh --restart       stop, then start
#   ./dev.sh --status        show whether it is up and which ports are listening
#   ./dev.sh --logs [name]   follow logs (sim daq db calibration backend
#                            frontend heartbeat config sequencer ota controller)
#
# --sim is the flag people actually want day to day: it runs the whole pipeline
# against simulated boards, so you need no test stand.
#
# Ports (override with the same env vars the startup script reads):
#   backend HTTP+WS  THIN_WS_PORT              (8081)
#   web GUI          served by the backend     (3000)
#   sequencer TCP    THIN_ACTUATOR_SERVICE_PORT (9998)
#   OTA TCP          OTA_SERVICE_CMD_PORT      (9997)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="sensor-dev"
LOGDIR="/tmp/gui_logs"
WS_PORT="${THIN_WS_PORT:-8081}"
GUI_PORT="${DAQ_GUI_PORT:-3000}"

running() { command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; }

# Listener table, not a /dev/tcp connect: connecting to a closed port hangs
# under WSL2 instead of being refused.
port_open() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$port" 2>/dev/null)" ]
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    timeout 1 bash -c "echo > /dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
  fi
}

start() {
  local attach="$1"
  if running; then
    echo "  daq-server is already running."
    [ "$attach" = "1" ] && exec tmux attach -t "$SESSION"
    summary
    return 0
  fi
  TMUX_ATTACH=0 bash "$HERE/deploy/startup/start_tmux_dev.sh"
  if [ "$attach" = "1" ]; then
    exec tmux attach -t "$SESSION"
  fi
  summary
}

summary() {
  echo ""
  echo "  daq-server is running (tmux session: $SESSION)"
  echo ""
  printf '    %-12s %s\n' "Web GUI"  "http://localhost:$GUI_PORT"
  printf '    %-12s %s\n' "API + WS" "http://localhost:$WS_PORT"
  echo ""
  echo "    attach   ./dev.sh --attach       (Ctrl-B then arrows to switch panes, D to detach)"
  echo "    logs     ./dev.sh --logs backend"
  echo "    stop     ./dev.sh --stop"
  echo ""
}

status() {
  if running; then
    echo "  daq-server: running (session $SESSION)"
  else
    echo "  daq-server: stopped"
  fi
  for entry in "Web GUI:$GUI_PORT" "API + WS:$WS_PORT" "Sequencer:${THIN_ACTUATOR_SERVICE_PORT:-9998}" "Elodin DB:2240"; do
    local label="${entry%:*}" port="${entry##*:}"
    if port_open "$port"; then
      printf '    %-12s :%-6s listening\n' "$label" "$port"
    else
      printf '    %-12s :%-6s not listening\n' "$label" "$port"
    fi
  done
  echo "    logs in $LOGDIR"
}

logs() {
  local want="${1:-}"
  if [ -n "$want" ]; then
    [ -f "$LOGDIR/$want.log" ] || { echo "no log '$want' in $LOGDIR" >&2; exit 1; }
    exec tail -f "$LOGDIR/$want.log"
  fi
  local all=("$LOGDIR"/*.log)
  [ -e "${all[0]}" ] || { echo "no logs yet in $LOGDIR" >&2; exit 1; }
  exec tail -f "${all[@]}"
}

usage() {
  cat <<'EOF'
daq-server dev stack

  ./dev.sh                 start detached
  ./dev.sh --sim           start detached with the board simulator (no hardware)
  ./dev.sh -a, --attach    start if needed, then attach to the tmux session
  ./dev.sh --sim-attach    --sim and --attach together
  ./dev.sh --stop          stop it
  ./dev.sh --restart       stop, then start fresh
  ./dev.sh --status        show whether it is up and which ports are listening
  ./dev.sh --logs [name]   follow logs (sim daq db calibration backend frontend
                           heartbeat config sequencer ota controller)
  ./dev.sh -h, --help      this message

Starting when a session is already up attaches to it rather than restarting.
start_tmux_dev.sh tears the whole stack down before rebuilding it, so use
--restart when that is what you actually want.

Ports (override with the env vars the startup script reads):
  backend HTTP+WS  THIN_WS_PORT               (8081)
  web GUI          served by the backend      (3000)
  sequencer TCP    THIN_ACTUATOR_SERVICE_PORT (9998)
  OTA TCP          OTA_SERVICE_CMD_PORT       (9997)

Logs are written to /tmp/gui_logs.
EOF
}

case "${1:-}" in
  "")                start 0 ;;
  --sim)             export USE_SIM=1; start 0 ;;
  -a|--attach)       start 1 ;;
  --sim-attach)      export USE_SIM=1; start 1 ;;
  --stop|--down)     bash "$HERE/deploy/startup/stop_tmux.sh" ;;
  --restart)         bash "$HERE/deploy/startup/stop_tmux.sh"; sleep 1; start 0 ;;
  --status)          status ;;
  --logs)            logs "${2:-}" ;;
  -h|--help)         usage ;;
  *)
    echo "unknown option: $1" >&2
    echo "" >&2
    usage >&2
    exit 2
    ;;
esac
