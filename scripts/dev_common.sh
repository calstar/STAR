#!/usr/bin/env bash
# Shared implementation behind every project's ./dev.sh.
#
# Each project's dev.sh declares what to run; this file decides how. That way
# `./dev.sh` means the same thing in EngineDesign/, pid-designer/, landing/ and
# daq-server/ -- same flags, same session naming, same log locations -- without
# each project reinventing process management.
#
# The default is a DETACHED tmux session: the stack keeps running after you
# close the terminal, so you can ssh in later and attach to look at a pane.
#
#   ./dev.sh                 start detached, print URLs
#   ./dev.sh --attach        start if needed, then attach
#   ./dev.sh --stop          stop it
#   ./dev.sh --restart       stop, then start detached
#   ./dev.sh --status        is it up, and which ports are listening
#   ./dev.sh --logs [pane]   tail a pane's log (all panes if omitted)
#   ./dev.sh --foreground    no tmux; run in this terminal, Ctrl-C to stop
#
# Usage from a project dev.sh:
#
#   source "$(dirname "$0")/../scripts/dev_common.sh"
#   dev_init engine-design "$(cd "$(dirname "$0")" && pwd)"
#   dev_pane backend  "python -m uvicorn backend.main:app --reload --port $PORT"
#   dev_pane frontend "cd frontend && npm run dev"
#   dev_service "Frontend" 5173 "http://localhost:5173"
#   dev_main "$@"

set -euo pipefail

DEV_PROJECT=""
DEV_ROOT=""
DEV_SESSION=""
DEV_LOGDIR=""

declare -a DEV_PANE_NAMES=()
declare -a DEV_PANE_CMDS=()
declare -a DEV_SERVICE_LABELS=()
declare -a DEV_SERVICE_PORTS=()
declare -a DEV_SERVICE_URLS=()

# Optional hook: a project may define dev_preflight() to install deps, build,
# or validate the environment. It runs once before any pane starts.

# ── Declaration API ────────────────────────────────────────────────────────

dev_init() {
  DEV_PROJECT="$1"
  DEV_ROOT="$2"
  DEV_SESSION="star-$1"
  DEV_LOGDIR="${STAR_DEV_LOGDIR:-/tmp/star-dev/$1}"
}

# dev_pane <name> <shell command>   -- runs with cwd = project root
dev_pane() {
  DEV_PANE_NAMES+=("$1")
  DEV_PANE_CMDS+=("$2")
}

# dev_service <label> <port> <url>  -- shown in the summary and by --status
dev_service() {
  DEV_SERVICE_LABELS+=("$1")
  DEV_SERVICE_PORTS+=("$2")
  DEV_SERVICE_URLS+=("$3")
}

# ── Helpers ────────────────────────────────────────────────────────────────

_dev_have_tmux() { command -v tmux >/dev/null 2>&1; }

_dev_session_running() {
  _dev_have_tmux && tmux has-session -t "$DEV_SESSION" 2>/dev/null
}

# Is anything listening on this port?
#
# Deliberately not bash's /dev/tcp: connecting to a closed port hangs there
# rather than being refused (reproduced under WSL2), which turns `--status`
# into a lockup. Asking the kernel for its listener table cannot hang, and is
# a more honest question anyway -- we want to know whether our service is up,
# not whether a connection succeeds.
_dev_port_open() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$port" 2>/dev/null)" ]
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    # No listener table available; bound the connect so it cannot wedge.
    timeout 1 bash -c "echo > /dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
  fi
}

# Free a port left behind by a previous run. Deliberately narrow: only the
# ports this project declared, never a blanket pkill on a process name.
_dev_free_port() {
  local port="$1" pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$port"/tcp 2>/dev/null || true)"
  fi
  [ -z "$pids" ] && return 0
  echo "  freeing port $port (pid $(echo "$pids" | tr '\n' ' '))"
  echo "$pids" | xargs -r kill -9 2>/dev/null || true
}

# Write each pane's command to its own script. tmux runs commands through
# /bin/sh -c, and quoting a payload that itself contains quotes is how panes
# end up silently dead -- a file has no quoting to get wrong.
_dev_write_pane_script() {
  local name="$1" cmd="$2" path="$DEV_LOGDIR/panes/$name.sh"
  mkdir -p "$DEV_LOGDIR/panes"
  cat > "$path" <<EOF
#!/usr/bin/env bash
cd $(printf '%q' "$DEV_ROOT")
printf '\n  ══ %s ══\n\n' $(printf '%q' "$name")
{
$cmd
} 2>&1 | tee $(printf '%q' "$DEV_LOGDIR/$name.log")
EOF
  chmod +x "$path"
  printf '%s' "$path"
}

_dev_run_preflight() {
  if declare -F dev_preflight >/dev/null; then
    dev_preflight
  fi
}

_dev_print_summary() {
  local i
  echo ""
  echo "  $DEV_PROJECT is running (tmux session: $DEV_SESSION)"
  if [ "${#DEV_SERVICE_URLS[@]}" -gt 0 ]; then
    echo ""
    for i in "${!DEV_SERVICE_URLS[@]}"; do
      printf '    %-12s %s\n' "${DEV_SERVICE_LABELS[$i]}" "${DEV_SERVICE_URLS[$i]}"
    done
  fi
  echo ""
  echo "    attach   ./dev.sh --attach       (Ctrl-B then D to detach again)"
  echo "    logs     ./dev.sh --logs"
  echo "    stop     ./dev.sh --stop"
  echo ""
}

# ── Commands ───────────────────────────────────────────────────────────────

_dev_start() {
  local attach="$1" i name path

  if _dev_session_running; then
    echo "  $DEV_PROJECT is already running."
    [ "$attach" = "1" ] && exec tmux attach -t "$DEV_SESSION"
    _dev_print_summary
    return 0
  fi

  if ! _dev_have_tmux; then
    echo "  tmux not found — running in the foreground instead."
    echo "  (install tmux to get a detached session you can ssh back into)"
    _dev_foreground
    return $?
  fi

  mkdir -p "$DEV_LOGDIR/panes"
  rm -f "$DEV_LOGDIR"/*.log

  for i in "${DEV_SERVICE_PORTS[@]:-}"; do
    [ -n "$i" ] && _dev_free_port "$i"
  done

  _dev_run_preflight

  for i in "${!DEV_PANE_NAMES[@]}"; do
    name="${DEV_PANE_NAMES[$i]}"
    path="$(_dev_write_pane_script "$name" "${DEV_PANE_CMDS[$i]}")"
    if [ "$i" -eq 0 ]; then
      tmux new-session -d -s "$DEV_SESSION" -n main "bash $path"
      # Panes stay visible after the process exits, so a crash is readable
      # instead of the pane vanishing.
      tmux set-option -t "$DEV_SESSION" remain-on-exit on >/dev/null
      tmux set-option -t "$DEV_SESSION" mouse on >/dev/null
    else
      tmux split-window -h -t "$DEV_SESSION:main" "bash $path"
      tmux select-layout -t "$DEV_SESSION:main" tiled >/dev/null
    fi
  done
  tmux select-layout -t "$DEV_SESSION:main" tiled >/dev/null

  if [ "$attach" = "1" ]; then
    exec tmux attach -t "$DEV_SESSION"
  fi
  _dev_print_summary
}

_dev_stop() {
  local i
  if _dev_session_running; then
    tmux kill-session -t "$DEV_SESSION"
    echo "  stopped $DEV_PROJECT ($DEV_SESSION)"
  else
    echo "  $DEV_PROJECT was not running"
  fi
  # tmux kills the pane's shell, but a child that daemonized or was slow to die
  # can still hold the port and make the next start fail confusingly.
  for i in "${DEV_SERVICE_PORTS[@]:-}"; do
    [ -n "$i" ] && _dev_port_open "$i" && _dev_free_port "$i"
  done
  return 0
}

_dev_status() {
  local i state
  if _dev_session_running; then
    echo "  $DEV_PROJECT: running (session $DEV_SESSION)"
  else
    echo "  $DEV_PROJECT: stopped"
  fi
  for i in "${!DEV_SERVICE_PORTS[@]}"; do
    if _dev_port_open "${DEV_SERVICE_PORTS[$i]}"; then
      state="listening"
    else
      state="not listening"
    fi
    printf '    %-12s :%-6s %-14s %s\n' \
      "${DEV_SERVICE_LABELS[$i]}" "${DEV_SERVICE_PORTS[$i]}" "$state" "${DEV_SERVICE_URLS[$i]}"
  done
  echo "    logs in $DEV_LOGDIR"
}

_dev_logs() {
  local want="${1:-}"
  if [ -n "$want" ]; then
    [ -f "$DEV_LOGDIR/$want.log" ] || { echo "no log for pane '$want' in $DEV_LOGDIR" >&2; return 1; }
    tail -f "$DEV_LOGDIR/$want.log"
    return
  fi
  local logs=("$DEV_LOGDIR"/*.log)
  [ -e "${logs[0]}" ] || { echo "no logs yet in $DEV_LOGDIR" >&2; return 1; }
  tail -f "${logs[@]}"
}

_dev_foreground() {
  local i name path
  declare -a pids=()

  mkdir -p "$DEV_LOGDIR/panes"
  for i in "${DEV_SERVICE_PORTS[@]:-}"; do
    [ -n "$i" ] && _dev_free_port "$i"
  done
  _dev_run_preflight

  # shellcheck disable=SC2317  # invoked via trap
  _dev_cleanup() {
    echo ""
    echo "  shutting down $DEV_PROJECT..."
    for p in "${pids[@]:-}"; do
      [ -n "$p" ] && kill "$p" 2>/dev/null || true
    done
    wait 2>/dev/null || true
  }
  trap _dev_cleanup EXIT INT TERM

  for i in "${!DEV_PANE_NAMES[@]}"; do
    name="${DEV_PANE_NAMES[$i]}"
    path="$(_dev_write_pane_script "$name" "${DEV_PANE_CMDS[$i]}")"
    bash "$path" &
    pids+=("$!")
    echo "  started $name (pid $!)"
  done

  echo ""
  for i in "${!DEV_SERVICE_URLS[@]}"; do
    printf '    %-12s %s\n' "${DEV_SERVICE_LABELS[$i]}" "${DEV_SERVICE_URLS[$i]}"
  done
  echo ""
  echo "  Ctrl-C to stop."
  wait
}

_dev_usage() {
  cat <<EOF
$DEV_PROJECT dev stack

  ./dev.sh                 start detached (keeps running; ssh in and attach)
  ./dev.sh -a, --attach    start if needed, then attach to the tmux session
  ./dev.sh --stop          stop it
  ./dev.sh --restart       stop, then start detached
  ./dev.sh --status        show whether it is up and which ports are listening
  ./dev.sh --logs [pane]   follow logs ($(IFS=,; echo "${DEV_PANE_NAMES[*]}"))
  ./dev.sh --foreground    run here without tmux, Ctrl-C to stop
  ./dev.sh -h, --help      this message

Logs are written to $DEV_LOGDIR.
EOF
}

# ── Entry point ────────────────────────────────────────────────────────────

dev_main() {
  case "${1:-}" in
    "")                 _dev_start 0 ;;
    -a|--attach)        _dev_start 1 ;;
    --stop|--down)      _dev_stop ;;
    --restart)          _dev_stop; _dev_start 0 ;;
    --status)           _dev_status ;;
    --logs)             _dev_logs "${2:-}" ;;
    --foreground|--fg)  _dev_foreground ;;
    -h|--help)          _dev_usage ;;
    *)
      echo "unknown option: $1" >&2
      echo "" >&2
      _dev_usage >&2
      return 2
      ;;
  esac
}
