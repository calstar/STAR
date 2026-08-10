#!/usr/bin/env bash
# STAR monorepo shell aliases — source from ~/.bashrc or ~/.zshrc:
#   echo "source ~/STAR/scripts/aliases.sh" >> ~/.bashrc   # adjust to your clone path
#
# Or for the current shell only:
#   source <path-to-STAR>/scripts/aliases.sh
#
# Run `star-help` at any time to print the full list.
#
# Every project gets the same six verbs, so you never have to remember which
# convention a given project follows:
#
#     <project>           cd there
#     <project>-dev       start it (detached — survives closing the terminal)
#     <project>-attach    start if needed, then attach
#     <project>-stop      stop it
#     <project>-status    up? which ports are listening?
#     <project>-logs      follow logs
#
# where <project> is one of: daq engine pid landing auth
#
# These are thin wrappers over each project's ./dev.sh, which is the real
# interface — the aliases just save you the cd. Anything project-specific
# (builds, test suites) is defined further down.
#
# NOTE: paths are derived from this file's location, so the aliases always act
# on THE checkout you sourced them from. If your shell still sources a copy in
# an old checkout, they will silently operate on the wrong repo — check
# `grep aliases.sh ~/.bashrc`.

# Left defined on purpose: the functions below resolve paths through it at call
# time.
_STAR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

# ── Repo ──────────────────────────────────────────────────────────────────────

alias star="cd '$_STAR_ROOT'"

# ── The uniform per-project set ───────────────────────────────────────────────
#
# Deliberately generated from one list rather than written out five times: the
# point is that they cannot drift apart.
#
# `engine`, not `ed` -- a bare `ed` alias would shadow /bin/ed.

for _star_entry in \
  "daq:$_STAR_ROOT/daq-server" \
  "engine:$_STAR_ROOT/EngineDesign" \
  "pid:$_STAR_ROOT/pid-designer" \
  "landing:$_STAR_ROOT/landing" \
  "auth:$_STAR_ROOT/auth"
do
  _star_p="${_star_entry%%:*}"
  _star_d="${_star_entry#*:}"
  alias "$_star_p=cd '$_star_d'"
  alias "$_star_p-dev=bash '$_star_d/dev.sh'"
  alias "$_star_p-attach=bash '$_star_d/dev.sh' --attach"
  alias "$_star_p-stop=bash '$_star_d/dev.sh' --stop"
  alias "$_star_p-status=bash '$_star_d/dev.sh' --status"
  alias "$_star_p-logs=bash '$_star_d/dev.sh' --logs"
done
unset _star_entry _star_p _star_d

# Every project at once. Functions, not aliases, because they loop.
star-status() {
  local p d
  for p in daq engine pid landing auth; do
    d="$(_star_dir "$p")"
    bash "$d/dev.sh" --status
  done
}

star-stop() {
  local p d
  for p in daq engine pid landing auth; do
    d="$(_star_dir "$p")"
    bash "$d/dev.sh" --stop
  done
}

_star_dir() {
  case "$1" in
    daq)     printf '%s' "$_STAR_ROOT/daq-server" ;;
    engine)  printf '%s' "$_STAR_ROOT/EngineDesign" ;;
    pid)     printf '%s' "$_STAR_ROOT/pid-designer" ;;
    landing) printf '%s' "$_STAR_ROOT/landing" ;;
    auth)    printf '%s' "$_STAR_ROOT/auth" ;;
  esac
}

# Prefer a project's virtualenv python when it has one.
_star_python() {
  if [ -x "$1/.venv/bin/python3" ]; then
    printf '%s' "$1/.venv/bin/python3"
  else
    printf '%s' "python3"
  fi
}

# ── Tests ─────────────────────────────────────────────────────────────────────

# daq-server: unit (fast), integration (full pipeline), E2E (browser).
alias daq-test="cd '$_STAR_ROOT/daq-server/diablo_server/frontend' && npm run test"
alias daq-test-watch="cd '$_STAR_ROOT/daq-server/diablo_server/frontend' && npm run test:watch"
alias daq-test-int="cd '$_STAR_ROOT/daq-server' && bash test/test_integration.sh"
alias daq-test-e2e="bash '$_STAR_ROOT/daq-server/test/e2e_guitest_playwright.sh'"

engine-test() { ( cd "$_STAR_ROOT/EngineDesign" && "$(_star_python "$_STAR_ROOT/EngineDesign")" -m pytest "$@" ); }
auth-test()   { ( cd "$_STAR_ROOT/auth"         && "$(_star_python "$_STAR_ROOT/auth")"         -m pytest "$@" ); }

# No suites yet. Defined anyway so the uniform set has no holes -- and so this
# says so out loud instead of exiting 0 and looking like everything passed.
pid-test()     { echo "pid-designer has no test suite yet."; return 1; }
landing-test() { echo "landing has no test suite yet."; return 1; }

# ── Builds ────────────────────────────────────────────────────────────────────

# USE_SIM is a runtime env var (launch scripts / calibration_service), not a
# compile flag — sim and hardware use identical binaries.
alias daq-build="cd '$_STAR_ROOT/daq-server' && bash scripts/build.sh"
alias daq-build-fast="cd '$_STAR_ROOT/daq-server/build' && cmake --build . --parallel \$(nproc)"
alias daq-build-frontend="bash '$_STAR_ROOT/daq-server/deploy/startup/ensure_frontend_build.sh'"

alias engine-build="cd '$_STAR_ROOT/EngineDesign/frontend' && npm run build"
alias pid-build="cd '$_STAR_ROOT/pid-designer/frontend' && npm run build"
alias landing-build="cd '$_STAR_ROOT/landing' && npm run build"

# ── daq-server extras ─────────────────────────────────────────────────────────

# The flag people want day to day: the whole pipeline against simulated boards,
# no test stand needed.
alias daq-sim="bash '$_STAR_ROOT/daq-server/dev.sh' --sim"

# Run one process on its own, outside the tmux stack.
alias daq-backend="cd '$_STAR_ROOT/daq-server/diablo_server/backend' && npx tsx src/server.ts"
alias daq-frontend="cd '$_STAR_ROOT/daq-server/diablo_server/frontend' && npm run dev"

# Older names, kept: they appear throughout the daq-server docs.
alias daq-gui="bash '$_STAR_ROOT/daq-server/dev.sh' --attach"
alias daq-guitest="bash '$_STAR_ROOT/daq-server/dev.sh' --sim-attach"
alias daq-stopgui="bash '$_STAR_ROOT/daq-server/dev.sh' --stop"
alias daq-playwright="bash '$_STAR_ROOT/daq-server/test/e2e_guitest_playwright.sh'"
alias daq-test-frontend="cd '$_STAR_ROOT/daq-server/diablo_server/frontend' && npm run test"
alias daq-test-frontend-watch="cd '$_STAR_ROOT/daq-server/diablo_server/frontend' && npm run test:watch"

# ── Production stack ──────────────────────────────────────────────────────────
#
# These act on the deployed stack, not your dev environment. star-down stops
# every container (volumes survive; star-up brings it back).

alias star-up="cd '$_STAR_ROOT' && docker compose up -d --build"
alias star-down="cd '$_STAR_ROOT' && docker compose down"
alias star-deploy-logs="cd '$_STAR_ROOT' && docker compose logs -f"

# ── Help ──────────────────────────────────────────────────────────────────────

star-help() {
  cat <<EOF
STAR aliases  (from $_STAR_ROOT)

Every project: daq  engine  pid  landing  auth
  <project>            cd there
  <project>-dev        start detached (survives closing the terminal)
  <project>-attach     start if needed, then attach   (Ctrl-B then D to leave)
  <project>-stop       stop it
  <project>-status     up? which ports are listening?
  <project>-logs       follow logs
  <project>-test       run its tests
  <project>-build      build it            (engine, pid, landing; see daq-build)

Repo
  star                 cd to the repo root
  star-status          status of every project
  star-stop            stop every dev stack
  star-help            this message

daq-server
  daq-sim              start with simulated boards (no test stand)
  daq-build            full C++ build          daq-build-fast    incremental
  daq-build-frontend   rebuild the SPA
  daq-test             frontend unit tests     daq-test-watch    watch mode
  daq-test-int         integration test (full pipeline)
  daq-test-e2e         Playwright E2E
  daq-backend          backend alone           daq-frontend      vite dev alone
  (daq-gui / daq-guitest / daq-stopgui / daq-playwright still work)

Production stack — acts on the deployment, not your dev environment
  star-up              docker compose up -d --build
  star-down            docker compose down
  star-deploy-logs     docker compose logs -f

Ports: engine 5173/8000 · pid 5174/8001 · landing 5175 · auth 5000
       daq 3000 (GUI) / 8081 (API+WS).  All five can run at once.
EOF
}

echo "[STAR aliases] Loaded from $_STAR_ROOT — run 'star-help' for the list"
