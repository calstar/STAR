#!/usr/bin/env bash
# Hotbench demo stack: EngineDesign + pid-designer + feed-twin, on their own
# ports, over a curated copy of the team's data.
#
# Why a separate stack rather than ./dev.sh in each app: a demo has to be
# repeatable and safe. The dev servers (8000/8001/8003, 5173/5174/5177) run on
# the team's live working data -- every import, stand and design anyone has
# made -- and a demo click there writes into it. This stack runs the same code
# from the same checkout, but every byte it reads or writes lives under one
# demo data root, seeded by COPYING the items worth showing. Nothing here moves,
# rewrites or deletes the originals, and nothing here touches the dev servers,
# their ports or their tmux sessions.
#
#   scripts/demo.sh               start detached (tmux session star-demo), wait, print URLs
#   scripts/demo.sh --reload      same, with uvicorn --reload (for a night of code edits)
#   scripts/demo.sh --reset       re-seed the demo data (old copy is moved aside), start, curate
#   scripts/demo.sh --restart     stop, then start (keeps the last --reload choice)
#   scripts/demo.sh --stop        stop it
#   scripts/demo.sh --status      what is up, and do the three apps see each other
#   scripts/demo.sh --logs [svc]  follow logs (all services if omitted)
#   scripts/demo.sh --attach      attach to the tmux session (Ctrl-B then D to leave)
#
# Conventions follow scripts/dev_common.sh (detached tmux, one script file per
# pane, listener-table port checks, wait-until-ready before printing URLs). It
# is not sourced: that file runs one project per session with tiled panes, and
# its port-freeing kills whatever holds a port, which is not a risk worth taking
# next to somebody's dev stack.

set -euo pipefail

# ── Where things are ───────────────────────────────────────────────────────

STAR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Everything the demo produces lives outside the repo, beside it, so git never
# sees it and a `git clean` never takes it.
DEMO_ROOT="${DEMO_ROOT:-$(cd "$STAR_ROOT/.." && pwd)/hotbench-investor}"
DEMO_DATA="${DEMO_DATA:-$DEMO_ROOT/demo-data}"
DEMO_LOGS="${DEMO_LOGS:-$DEMO_ROOT/demo-logs}"
# Vite's dependency cache. Each app's dev server keeps it in its own
# node_modules/.vite; two Vites on one checkout sharing that folder re-optimise
# over each other and break the other one's open tab. Ours goes here instead.
DEMO_CACHE="${DEMO_CACHE:-$DEMO_ROOT/demo-cache}"

# Fixed, not configurable: the name is how --stop finds what to stop, and it
# must never be one of the dev sessions (star-engine-design, star-pid-designer,
# star-feed-twin).
DEMO_SESSION="star-demo"

ENGINE_API_PORT="${DEMO_ENGINE_API_PORT:-8100}"
PID_API_PORT="${DEMO_PID_API_PORT:-8101}"
FEEDTWIN_API_PORT="${DEMO_FEEDTWIN_API_PORT:-8103}"
ENGINE_UI_PORT="${DEMO_ENGINE_UI_PORT:-5273}"
PID_UI_PORT="${DEMO_PID_UI_PORT:-5274}"
FEEDTWIN_UI_PORT="${DEMO_FEEDTWIN_UI_PORT:-5277}"

# The developer stack's ports. The demo refuses to use them whatever the
# environment says: freeing a port is part of stopping, and these are not ours.
RESERVED_PORTS=(8000 8001 8003 5173 5174 5177)

# Interpreters: the ones the dev servers run on today.
#
# EngineDesign runs on the framework Python 3.11 (lib/feedtwin and
# lib/stardesign installed editable there), not EngineDesign/.venv -- that venv
# is older (feedtwin 0.1.0 metadata, no httpx, which Layer X's pid-designer pull
# needs). feed-twin and pid-designer run on their own .venv, as their dev.sh do.
_framework_py="/Library/Frameworks/Python.framework/Versions/3.11/bin/python3"
if [ -z "${DEMO_ENGINE_PYTHON:-}" ]; then
  if [ -x "$_framework_py" ]; then
    DEMO_ENGINE_PYTHON="$_framework_py"
  else
    DEMO_ENGINE_PYTHON="$(command -v python3 || true)"
  fi
fi
ENGINE_PYTHON="$DEMO_ENGINE_PYTHON"
PID_PYTHON="${DEMO_PID_PYTHON:-$STAR_ROOT/pid-designer/.venv/bin/python3}"
FEEDTWIN_PYTHON="${DEMO_FEEDTWIN_PYTHON:-$STAR_ROOT/feed-twin/.venv/bin/python3}"
NODE_BIN="${DEMO_NODE:-$(command -v node || true)}"

# How long to wait for every service before giving up. EngineDesign is the slow
# one (numba warm-up plus the router graph; tens of seconds on a cold cache),
# and a Vite's first start optimises its dependencies into a fresh cache.
READY_TIMEOUT="${DEMO_READY_TIMEOUT:-180}"

# ── The curated data set ───────────────────────────────────────────────────
#
# What the demo shows, by id. Edit these and run --reset to change it.
#
# feed-twin library artifacts (first 12 hex of the sha256 of their bytes):
#   a22f706b60be  LE4 (6)            the stand drawing (Rocket + GSE pages)
#   727858dd44db  Copv Study Gn2     shipped study drawing
#   41c9a39ac34b  Copv Study He      shipped study drawing
#   b82571fb933d  Ethalox Stand      shipped stand drawing
#   d8d0f8b3073b  ethalox 6800N doublet 578psia 2026-10-05 drilled  (the engine, with its card;
#                 shown in the demo as its design, "Ethalox 7200N Doublet")
# Left out: the other LE4 imports (LE4, LE4 (1), LE4 DAQ test) and the
# card-less "ethalox doublet 7000N". Stands, runs and hookups follow the
# artifacts: a stand or a run is kept only when its drawing and engine are.
# a22f706b60be and d8d0f8b3073b (with its card) are the twin's bundled sample
# (feed-twin/backend/sample): their bytes are copied from there, and if the
# team's library ever loses them the twin's own sample route puts them back
# after start (_curate). Runs are the team's lit burns only: a rehearsal's runs
# live in the demo copy alone, so a --reset clears them.
FEEDTWIN_KEEP="a22f706b60be 727858dd44db 41c9a39ac34b b82571fb933d d8d0f8b3073b"
# The engine goes by its Hotbench Engine design's name in the demo copy
# (artifact=design id), not the upload's "ethalox 6800N doublet 578psia
# 2026-10-05 drilled". The team's own library keeps its name.
FEEDTWIN_ENGINE_NAMED="d8d0f8b3073b=ethalox-7200n-doublet"
# The demo stand's own state table (_curate): the DAQ's table with the rows of
# these states changed to close these valves. The DAQ's file
# (feed-twin/backend/statemachines/diablo_actuators.csv) is not touched; see
# docs/investor/demo-runbook.md, "The stand's state table".
DEMO_ABORT_STATES="Engine Abort|Emergency Abort"
DEMO_ABORT_CLOSES="Fuel Main|LOX Main|Fuel Press|LOX Press"

# pid-designer: whose diagrams, and which. The scratch ones (untitled*,
# diagram-3, claude-repro, handoff-test-*, le4-e2e) and the test user
# teammate@test.local are left out.
PID_KEEP_USERS="local"
PID_KEEP_DOCS="le4 ethalox-stand-7200n-helium"
# The team's LE4 drawing lives only in feed-twin's library (it was uploaded
# there, not pulled from pid-designer), and pid-designer's own "LE4" is the
# single-page September draft. The demo copy of pid-designer gets the stand
# drawing as a diagram of its own, marked the main diagram, so the editor opens
# on the same stand the cockpit fires -- under the name the twin and Layer X
# show it by. It was "LE4 Stand" here and "LE4 (6)" there, and nothing on
# screen said they were one drawing. Not the other way round: an uploaded
# drawing's hookup is kept under the name it was uploaded as (feed-twin
# backend/main.py _lineage, "name:LE4"), so renaming the twin's copy drops the
# demo stand's saved hookup and state table.
PID_STAND_FROM="a22f706b60be"
PID_STAND_ID="le4-stand"
PID_STAND_NAME="LE4 (6)"

# EngineDesign: the team's design. "Design 1" (the default-named first draft,
# untouched since 2026-09-08) is left out. Layer X keeps the stand measurements
# and DAQ channel map it was given; its old runs (2026-10-01..04, earlier code)
# and its own upload of an older LE4 are left out -- it reads the stand drawings
# from the demo feed-twin library instead.
ENGINE_KEEP_USERS="local"
ENGINE_KEEP_DOCS="ethalox-7200n-doublet"
ENGINE_LAYERX_KEEP="measurements channels"

# ── Small helpers ──────────────────────────────────────────────────────────

say()  { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf '  error: %s\n' "$*" >&2; exit 1; }

_have_tmux() { command -v tmux >/dev/null 2>&1; }

_session_running() {
  _have_tmux && tmux has-session -t "=$DEMO_SESSION" 2>/dev/null
}

# Is anything listening on this port? The listener table, as in dev_common.sh:
# a /dev/tcp probe of a closed port can hang instead of being refused.
_port_open() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

_port_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

# Did this demo start the process holding a port? Only then may it be killed.
# A uvicorn API is ours when its command line names the port; under --reload the
# socket is shared with a multiprocessing worker, which is ours when its parent
# is. A UI is ours when it is our vite-serve helper on that port.
_owned_pid() {
  local pid="$1" port="$2" cmd ppid pcmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *uvicorn*"--port $port"|*uvicorn*"--port $port "*) return 0 ;;
    *demo-vite-serve.mjs*" $port "*) return 0 ;;
    *multiprocessing*)
      ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
      [ -n "$ppid" ] || return 1
      pcmd="$(ps -o command= -p "$ppid" 2>/dev/null || true)"
      case "$pcmd" in *uvicorn*"--port $port"|*uvicorn*"--port $port "*) return 0 ;; esac
      ;;
  esac
  return 1
}

# Stop what this demo left on a port. Anything else holding it is reported and
# left alone.
_free_port() {
  local port="$1" pid pids mine=""
  pids="$(_port_pids "$port")"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    if _owned_pid "$pid" "$port"; then
      mine="$mine $pid"
    else
      warn "port $port is held by pid $pid, which the demo did not start: $(ps -o command= -p "$pid" 2>/dev/null | cut -c1-120)"
    fi
  done
  [ -n "$mine" ] || return 0
  # shellcheck disable=SC2086
  kill $mine 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6; do
    _port_open "$port" || return 0
    sleep 0.5
  done
  # shellcheck disable=SC2086
  kill -9 $mine 2>/dev/null || true
}

_http_ok() {
  curl -fsS -m 4 -o /dev/null "$1" 2>/dev/null
}

_html_ok() {
  curl -fsS -m 8 "$1" 2>/dev/null | grep -qi '<html'
}

# ── Services ───────────────────────────────────────────────────────────────
#
# Parallel arrays, in start order: APIs first, so a UI that probes its backend
# once on mount finds it.

SVC_NAMES=(engine-api pid-api feedtwin-api engine-ui pid-ui feedtwin-ui)
SVC_LABELS=("EngineDesign API" "pid-designer API" "feed-twin API" "EngineDesign" "P&ID Designer" "Feed Twin")
SVC_PORTS=("$ENGINE_API_PORT" "$PID_API_PORT" "$FEEDTWIN_API_PORT" "$ENGINE_UI_PORT" "$PID_UI_PORT" "$FEEDTWIN_UI_PORT")
SVC_PROBES=(
  "http://127.0.0.1:$ENGINE_API_PORT/api/health"
  "http://127.0.0.1:$PID_API_PORT/api/health"
  "http://127.0.0.1:$FEEDTWIN_API_PORT/api/health"
  "http://127.0.0.1:$ENGINE_UI_PORT/"
  "http://127.0.0.1:$PID_UI_PORT/"
  "http://127.0.0.1:$FEEDTWIN_UI_PORT/"
)

_mode_file() { printf '%s' "$DEMO_LOGS/.mode"; }

_last_mode() {
  cat "$(_mode_file)" 2>/dev/null || echo "stable"
}

# The command each service runs. Written to a file per service, as dev_common.sh
# does: tmux hands a command to /bin/sh -c, and a payload that quotes paths
# inside quotes is how a window ends up silently dead.
_service_command() {
  local name="$1" reload="$2" reload_flags=""
  case "$name" in
    engine-api)
      # EngineDesign imports lib/feedtwin (Layer X) and lib/stardesign; both are
      # editable installs uvicorn does not watch by default.
      [ "$reload" = "1" ] && reload_flags="--reload --reload-dir . --reload-dir ../lib/feedtwin --reload-dir ../lib/stardesign"
      cat <<EOF
cd $(printf '%q' "$STAR_ROOT/EngineDesign")
export USERDATA_DIR=$(printf '%q' "$DEMO_DATA/engine-design/userdata")
export PYTHONPATH=$(printf '%q' "$STAR_ROOT/lib/stardesign")
export PID_DESIGNER_URL=http://127.0.0.1:$PID_API_PORT
# Layer X reads the feed twin's library from disk (engine/layerx/sources.py),
# not over HTTP: point it at the demo copy, or it lists the team's real one.
export LAYERX_FEEDTWIN_LIBRARY=$(printf '%q' "$DEMO_DATA/feed-twin/library")
# Every Evaluate runs the engine with its debug log on: written to
# output/logs under the working directory -- the repo -- and echoed a block per
# call to the console. Keep the file with the demo's logs and the console to
# warnings, so the log a presenter tails says what went wrong, not every Pc.
export ENGINE_DESIGN_LOG_DIR=$(printf '%q' "$DEMO_LOGS/engine-design")
export ENGINE_DESIGN_CONSOLE_LOG_LEVEL=WARNING
exec $(printf '%q' "$ENGINE_PYTHON") -m uvicorn backend.main:app --host 127.0.0.1 --port $ENGINE_API_PORT $reload_flags
EOF
      ;;
    pid-api)
      [ "$reload" = "1" ] && reload_flags="--reload --reload-dir . --reload-dir ../lib/stardesign"
      cat <<EOF
cd $(printf '%q' "$STAR_ROOT/pid-designer")
export USERDATA_DIR=$(printf '%q' "$DEMO_DATA/pid-designer/userdata")
export PYTHONPATH=$(printf '%q' "$STAR_ROOT/lib/stardesign")
exec $(printf '%q' "$PID_PYTHON") -m uvicorn backend.main:app --host 127.0.0.1 --port $PID_API_PORT $reload_flags
EOF
      ;;
    feedtwin-api)
      [ "$reload" = "1" ] && reload_flags="--reload --reload-dir . --reload-dir ../lib/feedtwin --reload-dir ../lib/stardesign"
      cat <<EOF
cd $(printf '%q' "$STAR_ROOT/feed-twin")
export USERDATA_DIR=$(printf '%q' "$DEMO_DATA/feed-twin/userdata")
# The artifact library (drawings, engines, cards, hookups, overrides). Unset, it
# is feed-twin/backend/library -- the team's real one.
export FEEDTWIN_LIBRARY=$(printf '%q' "$DEMO_DATA/feed-twin/library")
export ENGINE_DESIGN_URL=http://127.0.0.1:$ENGINE_API_PORT
export PID_DESIGNER_URL=http://127.0.0.1:$PID_API_PORT
exec $(printf '%q' "$FEEDTWIN_PYTHON") -m uvicorn backend.main:app --host 127.0.0.1 --port $FEEDTWIN_API_PORT $reload_flags
EOF
      ;;
    engine-ui)
      # The Vite config reads its API port from the same variable dev.sh sets.
      cat <<EOF
cd $(printf '%q' "$STAR_ROOT/EngineDesign/frontend")
export ENGINE_DESIGN_API_PORT=$ENGINE_API_PORT
export LIBGL_ALWAYS_SOFTWARE=1
exec $(printf '%q' "$NODE_BIN") $(printf '%q' "$DEMO_LOGS/panes/demo-vite-serve.mjs") . $ENGINE_UI_PORT $(printf '%q' "$DEMO_CACHE/vite/engine-design")
EOF
      ;;
    pid-ui)
      cat <<EOF
cd $(printf '%q' "$STAR_ROOT/pid-designer/frontend")
export PID_DESIGNER_API_PORT=$PID_API_PORT
exec $(printf '%q' "$NODE_BIN") $(printf '%q' "$DEMO_LOGS/panes/demo-vite-serve.mjs") . $PID_UI_PORT $(printf '%q' "$DEMO_CACHE/vite/pid-designer")
EOF
      ;;
    feedtwin-ui)
      cat <<EOF
cd $(printf '%q' "$STAR_ROOT/feed-twin/frontend")
export FEED_TWIN_API_PORT=$FEEDTWIN_API_PORT
exec $(printf '%q' "$NODE_BIN") $(printf '%q' "$DEMO_LOGS/panes/demo-vite-serve.mjs") . $FEEDTWIN_UI_PORT $(printf '%q' "$DEMO_CACHE/vite/feed-twin")
EOF
      ;;
  esac
}

# A Vite dev server for one app with the cache moved out of the app's
# node_modules (see DEMO_CACHE) and the port strict, so a taken port fails
# loudly instead of Vite quietly moving to the next one. Uses each app's own
# Vite and its own vite.config, exactly as `npm run dev` would.
_write_vite_helper() {
  cat > "$DEMO_LOGS/panes/demo-vite-serve.mjs" <<'EOF'
// Written by scripts/demo.sh. Usage: node demo-vite-serve.mjs <frontend dir> <port> <cache dir>
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, port, cacheDir] = process.argv.slice(2)
const root = resolve(dir)
const viteDir = join(root, 'node_modules', 'vite')
const pkg = JSON.parse(readFileSync(join(viteDir, 'package.json'), 'utf8'))
let entry = pkg.exports?.['.'] ?? pkg.module ?? pkg.main
if (typeof entry === 'object') entry = entry.import?.default ?? entry.import ?? entry.default
const { createServer } = await import(pathToFileURL(join(viteDir, entry)).href)

const server = await createServer({
  root,
  cacheDir,
  server: { port: Number(port), strictPort: true, host: '127.0.0.1' },
})
await server.listen()
server.printUrls()
EOF
}

_write_pane_script() {
  local name="$1" reload="$2" path="$DEMO_LOGS/panes/$1.sh" log="$DEMO_LOGS/$1.log"
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Written by scripts/demo.sh -- regenerated on every start.\n'
    # A clean slate for what decides where data goes: a variable left in the
    # tmux server's environment must not point the demo at real data or a
    # bucket. AUTH_USERS_URL off: the sharing roster comes from the demo data.
    printf 'unset USERDATA_DIR FEEDTWIN_LIBRARY LAYERX_FEEDTWIN_LIBRARY LAYERX_DRAWINGS LAYERX_STATEMACHINES FEEDTWIN_ROOT\n'
    printf 'unset ENGINE_S3_BUCKET PID_S3_BUCKET FEEDTWIN_S3_BUCKET OPENROCKET_S3_BUCKET AUTH_USERS_URL STAR_ADMINS VIRTUAL_ENV\n'
    printf 'unset PYTHONPATH\n'
    # Unbuffered, so a log line lands in the log when it happens, not when a
    # pipe buffer fills -- the line you need is the one before the crash.
    printf 'export PYTHONUNBUFFERED=1\n'
    # A short, fixed PATH rather than whatever the shell that ran demo.sh had:
    # the interpreters are called by absolute path, and what the services spawn
    # themselves (git for feed-twin's version stamp, esbuild inside Vite) lives
    # in the system and Homebrew dirs.
    printf 'export PATH=%q\n' "$(dirname "$NODE_BIN"):$(dirname "$ENGINE_PYTHON"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    printf "printf '\\\\n  == %%s ==\\\\n\\\\n' %q\n" "$name"
    printf '{\n'
    _service_command "$name" "$reload"
    printf '} 2>&1 | tee %q\n' "$log"
  } > "$path"
  chmod +x "$path"
  printf '%s' "$path"
}

# ── Seeding the demo data ──────────────────────────────────────────────────
#
# Copy, never move. The sources are read; only DEMO_DATA is written. A marker
# file says the folder is ours, which is what --reset checks before it moves an
# old copy aside.

_seed_marker() { printf '%s' "$DEMO_DATA/.hotbench-demo-data"; }

_seeded() { [ -f "$(_seed_marker)" ]; }

_seed() {
  [ -e "$DEMO_DATA" ] && die "$DEMO_DATA exists but has no .hotbench-demo-data marker (a seed that failed?); move it aside and run again"
  say "seeding demo data in $DEMO_DATA"
  # Built beside the target and renamed into place, so a seed that fails half
  # way leaves nothing that looks seeded.
  local building="$DEMO_DATA.seeding-$$"
  mkdir -p "$building"
  STAR_ROOT="$STAR_ROOT" DEMO_DATA="$building" \
  FEEDTWIN_KEEP="$FEEDTWIN_KEEP" FEEDTWIN_ENGINE_NAMED="$FEEDTWIN_ENGINE_NAMED" \
  PID_KEEP_USERS="$PID_KEEP_USERS" PID_KEEP_DOCS="$PID_KEEP_DOCS" \
  PID_STAND_FROM="$PID_STAND_FROM" PID_STAND_ID="$PID_STAND_ID" PID_STAND_NAME="$PID_STAND_NAME" \
  ENGINE_KEEP_USERS="$ENGINE_KEEP_USERS" ENGINE_KEEP_DOCS="$ENGINE_KEEP_DOCS" \
  ENGINE_LAYERX_KEEP="$ENGINE_LAYERX_KEEP" DEMO_DATA_FINAL="$DEMO_DATA" \
  python3 - <<'PY' || { rm -rf "$building"; die "seeding failed; nothing was changed"; }
"""Copy the curated slice of the team's data into DEMO_DATA. Reads the sources,
writes only under DEMO_DATA, and records what it kept and left in SEED.json."""
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

star = Path(os.environ["STAR_ROOT"])
out = Path(os.environ["DEMO_DATA"])
now = datetime.now(timezone.utc).isoformat()
words = lambda k: os.environ.get(k, "").split()
report = {"seeded_at": now, "source": str(star)}


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except (OSError, ValueError):
        return default


def dump(path, data, indent=2):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=indent) + ("\n" if indent == 2 else ""), "utf-8")


def copy(src, dst):
    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, symlinks=False, dirs_exist_ok=False)
    else:
        shutil.copy2(src, dst)


def strip_lock(record):
    """A checkout copied from the live store would name a session that is not
    running here; the demo starts every design free."""
    return {k: v for k, v in record.items() if k not in ("lockedBy", "lockedAt", "lockHeartbeat")}


# ── feed-twin library ────────────────────────────────────────────────────
src_lib = star / "feed-twin" / "backend" / "library"
dst_lib = out / "feed-twin" / "library"
keep = words("FEEDTWIN_KEEP")
manifest = load(src_lib / "manifest.json", [])
kept = [e for e in manifest if e.get("id") in keep]

# The twin's bundled sample (backend/sample/sample.json): the LE4 stand drawing
# and the engine with its card, byte copies of library artifacts. Where a kept
# id is one of them, its bytes come from there, so the demo does not hang on
# the team's library still holding them.
import hashlib

sample_dir = star / "feed-twin" / "backend" / "sample"
sample = {}
for s in (load(sample_dir / "sample.json", {}) or {}).get("artifacts", []):
    try:
        data = (sample_dir / s["file"]).read_bytes()
    except (OSError, KeyError):
        continue
    sample[hashlib.sha256(data).hexdigest()[:12]] = s
missing = sorted(set(keep) - {e["id"] for e in kept})
# An id the team's library lacks but the sample carries is put back by the
# twin's own sample route after start (POST /api/library/sample, in _curate).
via_sample = [i for i in missing if i in sample]
missing = [i for i in missing if i not in sample]
if missing:
    sys.exit(f"feed-twin library has no artifact {', '.join(missing)}: nothing seeded")
(dst_lib / "blobs").mkdir(parents=True, exist_ok=True)
from_sample = []
for e in kept:
    s = sample.get(e["id"])
    if s is not None:
        copy(sample_dir / s["file"], dst_lib / "blobs" / e["filename"])
        if s.get("card"):
            copy(sample_dir / s["card"], dst_lib / "blobs" / f"{e['id']}.card.json")
        from_sample.append(f"{e['id']}  {s['file']}" + (f" + {s['card']}" if s.get("card") else ""))
    else:
        copy(src_lib / "blobs" / e["filename"], dst_lib / "blobs" / e["filename"])
    # Attachments (an engine's card) sit beside the blob as <id>.<name>.json.
    for att in sorted((src_lib / "blobs").glob(f"{e['id']}.*.json")):
        if not (dst_lib / "blobs" / att.name).exists():
            copy(att, dst_lib / "blobs" / att.name)

# The engine by its Hotbench Engine design's name (FEEDTWIN_ENGINE_NAMED), so
# the twin and the engine tool call it one thing. The demo copy only.
ed_index = load(star / "EngineDesign" / ".userdata" / "local" / "engine" / "index.json", []) or []
renamed = []
for pair in words("FEEDTWIN_ENGINE_NAMED"):
    artifact, _, design = pair.partition("=")
    name = next((r.get("name") for r in ed_index if r.get("id") == design), None)
    for e in kept:
        if e["id"] == artifact and name and e["name"] != name:
            renamed.append(f"{artifact}  {e['name']!r} -> {name!r}")
            e["name"] = name
# The library's own format: a plain list, indent=1 (backend/library.py _write).
dump(dst_lib / "manifest.json", kept, indent=1)


def lineage(e):
    """backend/main.py _lineage: what a drawing's hookup is kept under."""
    m = re.match(r"^(pid-designer|engine-design):(.*)@", e.get("source", ""))
    if m:
        owner, _, doc = m.group(2).rpartition("/")
        return f"{m.group(1)}:{owner}/{doc}"
    if e.get("source", "").startswith("shipped:"):
        return e["source"]
    return "name:" + re.sub(r"\s*\(\d+\)$", "", e.get("name", "")).strip()


# Records (hookups) belong to a drawing's lineage; keep those of kept drawings.
lineages = {lineage(e) for e in kept if e.get("kind") == "diagram"}
records_kept = []
for folder in sorted(p for p in src_lib.iterdir() if p.is_dir() and p.name != "blobs"):
    for rec in sorted(folder.glob("*.json")):
        data = load(rec, {})
        if isinstance(data, dict) and data.get("key") in lineages:
            copy(rec, dst_lib / folder.name / rec.name)
            records_kept.append(f"{folder.name}/{data['key']}")
# Operator overrides are kept by drawing name.
names = {e["name"] for e in kept}
overrides = {k: v for k, v in (load(src_lib / "overrides.json", {}) or {}).items() if k in names}
if overrides:
    dump(dst_lib / "overrides.json", overrides, indent=1)
report["feed_twin_library"] = {
    "kept": [f"{e['id']}  {e['kind']:7s}  {e['name']}" for e in kept],
    "left_out": [f"{e['id']}  {e['kind']:7s}  {e['name']}" for e in manifest if e.get("id") not in keep],
    "records": records_kept,
    "overrides": sorted(overrides),
    "bytes_from_sample": from_sample,
    "put_back_by_sample_route": via_sample,
    "renamed": renamed,
}

# ── feed-twin stands and runs ────────────────────────────────────────────
src_ud = star / "feed-twin" / ".userdata"
dst_ud = out / "feed-twin" / "userdata"
dst_ud.mkdir(parents=True, exist_ok=True)
stands_kept, stands_left, runs_kept, runs_left = [], [], [], []
for user in sorted(p for p in src_ud.iterdir() if p.is_dir() and not p.name.startswith(".")) if src_ud.is_dir() else []:
    index = load(user / "stand" / "index.json", [])
    mine = []
    for rec in index:
        body = load(user / "stand" / rec["id"] / "current.json", {}) or {}
        if body.get("diagram") in keep and body.get("engine") in keep:
            copy(user / "stand" / rec["id"], dst_ud / user.name / "stand" / rec["id"])
            mine.append(strip_lock(rec))
            stands_kept.append(f"{user.name}/{rec['id']}  {rec.get('name')}")
        else:
            stands_left.append(f"{user.name}/{rec['id']}  {rec.get('name')}  (drawing {body.get('diagram')}, engine {body.get('engine')})")
    if mine:
        dump(dst_ud / user.name / "stand" / "index.json", mine)
    for run in sorted((user / "runs").glob("*.json")):
        record = load(run, {}) or {}
        inputs = record.get("inputs") or {}
        # Lit burns only: a record of a trickle after an abort, or a cold flow,
        # is not a burn to show (D-01).
        lit = ((record.get("outcome") or {}).get("thrust_mean_N") or 0) > 0
        if lit and inputs.get("diagram") in keep and inputs.get("engine") in keep:
            copy(run, dst_ud / user.name / "runs" / run.name)
            runs_kept.append(f"{user.name}/{run.stem}")
        else:
            runs_left.append(f"{user.name}/{run.stem}")
report["feed_twin_userdata"] = {
    "stands_kept": stands_kept, "stands_left_out": stands_left,
    "runs_kept": runs_kept, "runs_left_out": len(runs_left),
}


def curate_designs(src_root, dst_root, app, keep_users, keep_docs, keep_layerx=None):
    """One design tool's <user>/<app> tree: the kept users, the kept designs in
    their index, and whatever else sits there (configs/, ...) unless it is a
    design that was not kept or a Layer X folder not listed."""
    kept_docs, left_docs, left_users, extras = [], [], [], []
    for user in sorted(p for p in src_root.iterdir() if p.is_dir() and not p.name.startswith(".")) if src_root.is_dir() else []:
        if user.name not in keep_users:
            left_users.append(user.name)
            continue
        src_app = user / app
        dst_app = dst_root / user.name / app
        index = load(src_app / "index.json", [])
        ids = {r.get("id") for r in index}
        mine = []
        for rec in index:
            if rec.get("id") in keep_docs and (src_app / rec["id"]).is_dir():
                copy(src_app / rec["id"], dst_app / rec["id"])
                mine.append(strip_lock(rec))
                kept_docs.append(f"{user.name}/{rec['id']}  {rec.get('name')}")
            else:
                left_docs.append(f"{user.name}/{rec['id']}  {rec.get('name')}")
        dump(dst_app / "index.json", mine)
        for child in sorted(src_app.iterdir()) if src_app.is_dir() else []:
            if child.name in ids or child.name == "index.json" or child.name.startswith("."):
                continue
            if child.name == "layerx" and keep_layerx is not None:
                for part in sorted(child.iterdir()):
                    if part.name in keep_layerx:
                        copy(part, dst_app / "layerx" / part.name)
                        extras.append(f"{user.name}/{app}/layerx/{part.name}")
                    else:
                        extras.append(f"(left out) {user.name}/{app}/layerx/{part.name}")
                continue
            copy(child, dst_app / child.name)
            extras.append(f"{user.name}/{app}/{child.name}")
    return {"kept": kept_docs, "left_out": left_docs, "users_left_out": left_users, "other": extras}


# ── pid-designer ─────────────────────────────────────────────────────────
pid_src = star / "pid-designer" / ".userdata"
pid_dst = out / "pid-designer" / "userdata"
report["pid_designer"] = curate_designs(pid_src, pid_dst, "pid", words("PID_KEEP_USERS"), words("PID_KEEP_DOCS"))

# The stand drawing as a diagram of its own, owned by the local user, set as
# the main (featured) diagram and in the STAR set (lib/stardesign documents.py).
stand_from = os.environ.get("PID_STAND_FROM", "")
stand_id = os.environ.get("PID_STAND_ID", "")
stand_name = os.environ.get("PID_STAND_NAME", "")
if stand_from and stand_id:
    entry = next((e for e in kept if e["id"] == stand_from), None)
    if stand_from in sample:
        drawing = load(sample_dir / sample[stand_from]["file"])
        entry = entry or {"name": sample[stand_from].get("name", stand_from)}
    else:
        drawing = load(src_lib / "blobs" / entry["filename"])
    owner = (words("PID_KEEP_USERS") or ["local"])[0]
    app_dir = pid_dst / owner / "pid"
    index = load(app_dir / "index.json", [])
    if not any(r.get("id") == stand_id for r in index):
        dump(app_dir / stand_id / "current.json", {"nodes": drawing.get("nodes", []), "edges": drawing.get("edges", [])}, indent=None)
        index.insert(0, {"id": stand_id, "name": stand_name, "createdAt": now, "updatedAt": now,
                         "sharedWith": [], "archived": False})
        dump(app_dir / "index.json", index)
    site = pid_dst / ".site" / "pid"
    dump(site / "featured.json", {"owner": owner, "id": stand_id, "setBy": owner, "setAt": now})
    star_set = [{"owner": owner, "id": r["id"], "addedBy": owner, "addedAt": now} for r in index]
    dump(site / "star.json", star_set)
    report["pid_designer"]["main_diagram"] = f"{owner}/{stand_id}  {stand_name}  (from feed-twin {stand_from} {entry['name']})"
    report["pid_designer"]["star_set"] = [f"{e['owner']}/{e['id']}" for e in star_set]

# ── EngineDesign ─────────────────────────────────────────────────────────
ed_src = star / "EngineDesign" / ".userdata"
ed_dst = out / "engine-design" / "userdata"
report["engine_design"] = curate_designs(ed_src, ed_dst, "engine", words("ENGINE_KEEP_USERS"),
                                         words("ENGINE_KEEP_DOCS"), keep_layerx=words("ENGINE_LAYERX_KEEP"))

dump(out / "SEED.json", report)
(out / ".hotbench-demo-data").write_text(f"seeded {now} from {star}\n", "utf-8")


def show(title, items):
    print(f"    {title}")
    for item in items:
        print(f"      {item}")


show("feed-twin library", report["feed_twin_library"]["kept"]
     + [f"(renamed) {r}" for r in renamed] + [f"(after start, from the sample) {i}" for i in via_sample])
show("feed-twin stands", stands_kept or ["(none)"])
print(f"      runs kept: {len(runs_kept)}")
show("pid-designer diagrams", ([report['pid_designer'].get('main_diagram', '')] if stand_id else []) + report["pid_designer"]["kept"])
show("EngineDesign designs", report["engine_design"]["kept"])
print(f"    (what was left out, and why: {Path(os.environ['DEMO_DATA_FINAL']) / 'SEED.json'})")
PY
  mv "$building" "$DEMO_DATA"
}

_reset_data() {
  if [ -e "$DEMO_DATA" ]; then
    _seeded || die "$DEMO_DATA exists but is not a demo data folder (no .hotbench-demo-data marker); refusing to move it"
    local aside
    aside="$DEMO_DATA.prev-$(date +%Y%m%d-%H%M%S)"
    mv "$DEMO_DATA" "$aside"
    say "previous demo data moved to $aside"
  fi
  _seed
}

# ── Curating through the apps ──────────────────────────────────────────────
#
# What a copy cannot do, done once after a fresh seed through the running
# twin's own routes, so its own checks pass on it -- a hookup it would refuse
# is refused here too:
#   1. the sample route (POST /api/library/sample): the featured stand is in
#      the library, put back if the seed could not copy it;
#   2. a pull of pid-designer's copy of the stand drawing: the same drawing, so
#      the twin keeps it as an alias and reports the stand current (D-48);
#   3. the stand's own state table (DEMO_ABORT_STATES close DEMO_ABORT_CLOSES),
#      saved as the stand drawing's hookup -- the suggested wiring unchanged,
#      checked -- and put on every stand document on that drawing that carries
#      a hookup of its own (one without a table would run the DAQ's).
# A marker records it was done; --reset (a fresh seed) does it again.

_curated_marker() { printf '%s' "$DEMO_DATA/.hotbench-demo-curated"; }

_curate() {
  [ -f "$(_curated_marker)" ] && return 0
  say "curating the demo data through the apps"
  FT="http://127.0.0.1:$FEEDTWIN_API_PORT" DEMO_DATA="$DEMO_DATA" \
  PID_STAND_ID="$PID_STAND_ID" PID_OWNER="${PID_KEEP_USERS%% *}" \
  ABORT_STATES="$DEMO_ABORT_STATES" ABORT_CLOSES="$DEMO_ABORT_CLOSES" \
  python3 - <<'PY' || { warn "curating failed (above); the demo stand runs the DAQ's table as shipped. Fix it and run --reset."; return 1; }
"""Curate the demo copy through feed-twin's own API; see _curate above."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ft = os.environ["FT"]
done = {"curated_at": datetime.now(timezone.utc).isoformat()}


class Refused(RuntimeError):
    pass


def call(method, path, body=None):
    req = urllib.request.Request(
        ft + path,
        method=method,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as answer:
            return json.loads(answer.read() or b"null")
    except urllib.error.HTTPError as exc:
        raise Refused(f"{method} {path.split('?')[0]}: {exc.code} {exc.read().decode('utf-8', 'replace')[:300]}")


try:
    # 1. The featured stand (C2).
    library = call("POST", "/api/library/sample")
    diagram = next((a for a in library if a["kind"] == "diagram" and a.get("featured")), None)
    engine = next((a for a in library if a["kind"] == "engine" and a.get("featured")), None)
    if diagram is None or engine is None:
        raise Refused("the twin offers no featured drawing and engine after its sample route")
    done["featured"] = {"diagram": f"{diagram['id']}  {diagram['name']}", "engine": f"{engine['id']}  {engine['name']}"}

    # 2. The same drawing pulled from Hotbench P&ID (not fatal: freshness only).
    if os.environ.get("PID_STAND_ID"):
        try:
            pulled = call("POST", "/api/sources/pid-designer/import",
                          {"doc_id": os.environ["PID_STAND_ID"], "owner": os.environ.get("PID_OWNER") or "local"})
            same = pulled["artifact"]["id"] == diagram["id"]
            done["pulled"] = f"{os.environ['PID_STAND_ID']} -> {pulled['artifact']['id']}" + ("  (the featured drawing: alias kept)" if same else "  (NOT the featured drawing)")
        except (Refused, OSError, KeyError) as exc:
            done["pulled"] = f"not pulled: {exc}"

    # 3. The stand's own state table: the DAQ's, with the abort rows changed.
    where = "?" + urllib.parse.urlencode({"diagram": diagram["id"], "engine": engine["id"]})
    before = call("GET", "/api/hookup" + where)
    table = json.loads(json.dumps(before["machine_shipped"]))
    states = [s for s in os.environ["ABORT_STATES"].split("|") if s]
    closes = [a for a in os.environ["ABORT_CLOSES"].split("|") if a]
    names = [s["name"] for s in table["states"]]
    unknown = [s for s in states if s not in names] + [a for a in closes if a not in table["actuators"]]
    if unknown:
        raise Refused(f"the DAQ's table has no {', '.join(unknown)}; nothing saved")
    changed = {}
    for state in states:
        was = list(table["open"].get(state) or [])
        table["open"][state] = [a for a in was if a not in closes]
        changed[state] = [a for a in was if a in closes]
    check = call("POST", "/api/statemachine/check", table)
    if not check.get("ok"):
        raise Refused(f"the twin cannot read the edited table: {check.get('error')}")
    current = before["hookup"]
    body = {
        "valves": current.get("valves") or {},
        "knobs": current.get("knobs") or [],
        "aliases": current.get("aliases") or {},
        # Out of the API the box is always listed; an unwired hookup stays unwired.
        "channels": current.get("channels") if before.get("wired") else None,
        "rows": current.get("rows") or {},
        "machine": table,
    }
    call("PUT", "/api/hookup" + where, body)
    after = call("GET", "/api/hookup" + where)
    if not after.get("saved") or after.get("bound") != before.get("bound") or after.get("unmatched") != before.get("unmatched"):
        raise Refused("the saved hookup does not wire the stand as the suggestion did")
    left = [w for w in after.get("machine_warnings", []) if any(w.startswith(f"{s} commands") for s in states)]
    if left:
        raise Refused("the saved table still opens a main in an abort: " + " ".join(left))
    done["hookup"] = {
        "drawing": f"{diagram['id']}  {diagram['name']}  (lineage {after.get('lineage')})",
        "was_saved_before": bool(before.get("saved")),
        "closed": changed,
        "wiring_unchanged": True,
        "table_warnings_left": len(after.get("machine_warnings", [])),
    }

    # The stand documents on that drawing that carry their own hookup.
    stands_done = []
    for rec in call("GET", "/api/twin/stands"):
        q = "?" + urllib.parse.urlencode({"owner": rec.get("owner") or "local"})
        base = f"/api/twin/stands/{urllib.parse.quote(rec['id'])}"
        doc = call("GET", base + "/load" + q)
        own = doc.get("hookup") or {}
        if doc.get("diagram") != diagram["id"] or not own or own.get("machine") == table:
            continue
        if rec.get("lockedBy"):
            stands_done.append(f"{rec['id']}  {rec.get('name')}: held by {rec['lockedBy']}, NOT changed")
            continue
        call("POST", base + "/checkout" + q)
        try:
            call("POST", base + "/flush" + q, {**doc, "hookup": {**own, "machine": table}})
        finally:
            call("DELETE", base + "/checkout" + q)
        stands_done.append(f"{rec['id']}  {rec.get('name')}: its own hookup now carries the table")
    done["stands"] = stands_done
except (Refused, OSError, KeyError, ValueError) as exc:
    sys.exit(f"  error: {exc}")

marker = Path(os.environ["DEMO_DATA"]) / ".hotbench-demo-curated"
marker.write_text(json.dumps(done, indent=2) + "\n", "utf-8")
print(f"    featured      {done['featured']['diagram']}  +  {done['featured']['engine']}")
print(f"    pulled        {done.get('pulled', '-')}")
for state, gone in done["hookup"]["closed"].items():
    print(f"    {state:13s} now closes {', '.join(gone) or '(already closed)'}")
for line in done["stands"]:
    print(f"    stand         {line}")
PY
}

# ── Preflight ──────────────────────────────────────────────────────────────

_preflight() {
  local p r name
  _have_tmux || die "tmux is required (brew install tmux)"
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "node not found (set DEMO_NODE)"
  for p in "$ENGINE_API_PORT" "$PID_API_PORT" "$FEEDTWIN_API_PORT" "$ENGINE_UI_PORT" "$PID_UI_PORT" "$FEEDTWIN_UI_PORT"; do
    case "$p" in ''|*[!0-9]*) die "port '$p' is not a number" ;; esac
    for r in "${RESERVED_PORTS[@]}"; do
      [ "$p" = "$r" ] && die "port $p belongs to the dev stack; pick another DEMO_*_PORT"
    done
  done
  [ "$(printf '%s\n' "${SVC_PORTS[@]}" | sort -u | wc -l | tr -d ' ')" = "${#SVC_PORTS[@]}" ] \
    || die "two demo services were given the same port"
  [ -x "$ENGINE_PYTHON" ] || die "EngineDesign Python not found: $ENGINE_PYTHON (set DEMO_ENGINE_PYTHON)"
  [ -x "$PID_PYTHON" ] || die "pid-designer venv missing: $PID_PYTHON (run pid-designer/dev.sh once)"
  [ -x "$FEEDTWIN_PYTHON" ] || die "feed-twin venv missing: $FEEDTWIN_PYTHON (run feed-twin/dev.sh once)"
  PYTHONPATH="$STAR_ROOT/lib/stardesign" "$ENGINE_PYTHON" -c "import uvicorn, feedtwin, stardesign, httpx" 2>/dev/null \
    || die "$ENGINE_PYTHON cannot import uvicorn/feedtwin/stardesign/httpx"
  "$FEEDTWIN_PYTHON" -c "import uvicorn, feedtwin, stardesign" 2>/dev/null \
    || die "$FEEDTWIN_PYTHON cannot import uvicorn/feedtwin/stardesign (run feed-twin/dev.sh once)"
  PYTHONPATH="$STAR_ROOT/lib/stardesign" "$PID_PYTHON" -c "import uvicorn, stardesign" 2>/dev/null \
    || die "$PID_PYTHON cannot import uvicorn/stardesign (run pid-designer/dev.sh once)"
  for name in EngineDesign pid-designer feed-twin; do
    [ -d "$STAR_ROOT/$name/frontend/node_modules/vite" ] \
      || die "$name/frontend/node_modules is missing (run $name/dev.sh once, or npm install there)"
  done
}

# ── Commands ───────────────────────────────────────────────────────────────

_print_urls() {
  echo ""
  say "Hotbench demo is running (tmux session: $DEMO_SESSION, $(_last_mode))"
  echo ""
  printf '    %-16s %s\n' "EngineDesign"  "http://localhost:$ENGINE_UI_PORT"
  printf '    %-16s %s\n' "P&ID Designer" "http://localhost:$PID_UI_PORT"
  printf '    %-16s %s\n' "Feed Twin"     "http://localhost:$FEEDTWIN_UI_PORT"
  echo ""
  printf '    %-16s %s\n' "APIs" "http://127.0.0.1:$ENGINE_API_PORT/docs  :$PID_API_PORT/docs  :$FEEDTWIN_API_PORT/docs"
  printf '    %-16s %s\n' "data" "$DEMO_DATA"
  printf '    %-16s %s\n' "logs" "$DEMO_LOGS"
  echo ""
  say "status   scripts/demo.sh --status"
  say "stop     scripts/demo.sh --stop"
  echo ""
}

# Wait until every API answers its health route and every UI serves HTML, so
# the URLs printed are usable. A UI that probes its backend once on mount and
# finds nothing latches "not connected" until a manual reload.
_wait_ready() {
  local deadline=$(( SECONDS + READY_TIMEOUT )) i pending
  while [ "$SECONDS" -lt "$deadline" ]; do
    pending=0
    for i in "${!SVC_NAMES[@]}"; do
      if [ "$i" -lt 3 ]; then
        _http_ok "${SVC_PROBES[$i]}" || pending=1
      else
        _html_ok "${SVC_PROBES[$i]}" || pending=1
      fi
    done
    [ "$pending" -eq 0 ] && return 0
    sleep 1
  done
  echo ""
  for i in "${!SVC_NAMES[@]}"; do
    if [ "$i" -lt 3 ]; then _http_ok "${SVC_PROBES[$i]}" && continue; else _html_ok "${SVC_PROBES[$i]}" && continue; fi
    warn "${SVC_LABELS[$i]} (port ${SVC_PORTS[$i]}) is not answering after ${READY_TIMEOUT}s; last log lines:"
    tail -n 15 "$DEMO_LOGS/${SVC_NAMES[$i]}.log" 2>/dev/null | sed 's/^/      /' >&2 || true
  done
  return 1
}

_start() {
  local reload="$1" i name path

  if _session_running; then
    say "the demo is already running ($(_last_mode)); use --restart to change that"
    _print_urls
    return 0
  fi

  _preflight

  # A previous demo that died without --stop can still hold its ports. Free
  # those (ours only), then insist every port is clear before touching anything.
  for i in "${!SVC_PORTS[@]}"; do
    _free_port "${SVC_PORTS[$i]}"
    if _port_open "${SVC_PORTS[$i]}"; then
      die "port ${SVC_PORTS[$i]} (${SVC_LABELS[$i]}) is taken by something else; free it or set DEMO_*_PORT"
    fi
  done

  _seeded || _seed

  mkdir -p "$DEMO_LOGS/panes" "$DEMO_CACHE/vite"
  # Keep the previous run's logs one generation back: the interesting line is
  # usually in the run that just died.
  for name in "${SVC_NAMES[@]}"; do
    if [ -f "$DEMO_LOGS/$name.log" ]; then
      mv -f "$DEMO_LOGS/$name.log" "$DEMO_LOGS/$name.prev.log"
    fi
  done

  _write_vite_helper
  if [ "$reload" = "1" ]; then echo "reload" > "$(_mode_file)"; else echo "stable" > "$(_mode_file)"; fi

  for i in "${!SVC_NAMES[@]}"; do
    name="${SVC_NAMES[$i]}"
    path="$(_write_pane_script "$name" "$reload")"
    if [ "$i" -eq 0 ]; then
      tmux new-session -d -s "$DEMO_SESSION" -n "$name" -c "$STAR_ROOT" "bash $(printf '%q' "$path")"
      tmux set-option -t "$DEMO_SESSION" mouse on >/dev/null
    else
      tmux new-window -d -t "$DEMO_SESSION:" -n "$name" -c "$STAR_ROOT" "bash $(printf '%q' "$path")"
    fi
    # Per window, so a crash stays on screen to be read instead of the window
    # vanishing. Never -g: that would change the dev sessions too.
    tmux set-option -w -t "$DEMO_SESSION:$name" remain-on-exit on >/dev/null
  done

  say "starting ($(_last_mode)); waiting for six services (up to ${READY_TIMEOUT}s)..."
  if _wait_ready; then
    _curate || true
    _print_urls
  else
    warn "not everything came up; the session is left running for inspection (scripts/demo.sh --logs)"
    return 1
  fi
}

_stop() {
  local i name
  if _session_running; then
    # Ctrl-C first: uvicorn and Vite shut down cleanly on SIGINT, and a reloader
    # takes its worker with it. Then the session goes.
    for name in "${SVC_NAMES[@]}"; do
      tmux send-keys -t "$DEMO_SESSION:$name" C-c 2>/dev/null || true
    done
    local port busy
    for i in $(seq 1 16); do
      busy=0
      for port in "${SVC_PORTS[@]}"; do _port_open "$port" && busy=1; done
      [ "$busy" -eq 0 ] && break
      sleep 0.5
    done
    tmux kill-session -t "=$DEMO_SESSION" 2>/dev/null || true
    say "stopped $DEMO_SESSION"
  else
    say "the demo was not running"
  fi
  for i in "${!SVC_PORTS[@]}"; do
    _free_port "${SVC_PORTS[$i]}"
  done
  return 0
}

_status() {
  local i state health
  if _session_running; then
    say "demo: running (tmux session $DEMO_SESSION, $(_last_mode))"
  else
    say "demo: stopped"
  fi
  for i in "${!SVC_NAMES[@]}"; do
    if _port_open "${SVC_PORTS[$i]}"; then state="listening"; else state="-"; fi
    if [ "$i" -lt 3 ]; then
      _http_ok "${SVC_PROBES[$i]}" && health="healthy" || health="no answer"
    else
      _html_ok "${SVC_PROBES[$i]}" && health="serves html" || health="no answer"
    fi
    printf '    %-18s :%-6s %-10s %-12s\n' "${SVC_LABELS[$i]}" "${SVC_PORTS[$i]}" "$state" "$health"
  done
  _http_ok "${SVC_PROBES[2]}" || { say "data $DEMO_DATA  logs $DEMO_LOGS"; return 0; }

  # Do the three see each other, and is feed-twin on the demo library?
  echo ""
  local ft="http://127.0.0.1:$FEEDTWIN_API_PORT" ed="http://127.0.0.1:$ENGINE_API_PORT"
  LIB="$(curl -fsS -m 10 "$ft/api/library" 2>/dev/null || true)" \
  SRC="$(curl -fsS -m 20 "$ft/api/sources" 2>/dev/null || true)" \
  LX="$(curl -fsS -m 10 "$ed/api/layerx/status" 2>/dev/null || true)" \
  LXD="$(curl -fsS -m 30 "$ed/api/layerx/drawings" 2>/dev/null || true)" \
  python3 - <<'PY'
import json
import os


def j(key):
    try:
        return json.loads(os.environ.get(key) or "null")
    except ValueError:
        return None


lib, src, lx, lxd = j("LIB"), j("SRC"), j("LX"), j("LXD")
if lib is None:
    print("    feed-twin library   no answer")
else:
    print(f"    feed-twin library   {len(lib)} artifacts")
    for a in lib:
        card = "  + engine card" if a.get("card") else ""
        print(f"      {a['id']}  {a['kind']:7s} {a['name']}{card}")
if src is None:
    print("    feed-twin sources   no answer")
for s in src or []:
    ok = "reachable" if s.get("reachable") else "NOT reachable: " + (s.get("detail") or "")[:80]
    print(f"    feed-twin -> {s['label']:13s} {s['base_url']:24s} {ok}")
if lx is None:
    print("    Layer X status      no answer")
else:
    ftw = lx.get("feedtwin") or {}
    state = "available" if ftw.get("available") else f"UNAVAILABLE {ftw.get('error')}"
    print(f"    Layer X feedtwin    {state} (v{ftw.get('version')}), pid-designer at {lx.get('pid_designer_url')}")
if lxd is None:
    print("    Layer X drawings    no answer")
else:
    names = sorted({d.get("name", "?") for d in lxd})
    print(f"    Layer X drawings    {len(lxd)}: {', '.join(names)}")
PY
  if [ -f "$(_curated_marker)" ]; then
    say "curated (featured stand, abort rows, pull): $(_curated_marker)"
  else
    warn "not curated yet: the demo stand runs the DAQ's abort rows (start the stack, or --reset)"
  fi
  echo ""
  say "data $DEMO_DATA"
  say "logs $DEMO_LOGS"
}

_logs() {
  local want="${1:-}"
  if [ -n "$want" ]; then
    [ -f "$DEMO_LOGS/$want.log" ] || die "no log for '$want' in $DEMO_LOGS (services: ${SVC_NAMES[*]})"
    exec tail -f "$DEMO_LOGS/$want.log"
  fi
  local logs=() name
  for name in "${SVC_NAMES[@]}"; do
    [ -f "$DEMO_LOGS/$name.log" ] && logs+=("$DEMO_LOGS/$name.log")
  done
  [ "${#logs[@]}" -gt 0 ] || die "no logs yet in $DEMO_LOGS"
  exec tail -f "${logs[@]}"
}

_usage() {
  cat <<EOF
Hotbench demo stack -- EngineDesign, pid-designer and feed-twin on their own
ports over a curated copy of the team's data.

  scripts/demo.sh                 start detached and print the URLs
  scripts/demo.sh --reload        start with uvicorn --reload (code edits restart the APIs)
  scripts/demo.sh --reset         re-seed the demo data (the old copy is moved aside), then start
  scripts/demo.sh --restart       stop, then start (keeps the last reload choice;
                                  add --reload or --no-reload to change it)
  scripts/demo.sh --stop          stop it
  scripts/demo.sh --status        which services answer, and whether they see each other
  scripts/demo.sh --logs [svc]    follow logs (${SVC_NAMES[*]})
  scripts/demo.sh --attach        attach to the tmux session (Ctrl-B then D to detach)
  scripts/demo.sh -h, --help      this message

Ports  EngineDesign $ENGINE_UI_PORT (API $ENGINE_API_PORT), P&ID Designer $PID_UI_PORT (API $PID_API_PORT),
       Feed Twin $FEEDTWIN_UI_PORT (API $FEEDTWIN_API_PORT). Override with DEMO_ENGINE_API_PORT,
       DEMO_PID_API_PORT, DEMO_FEEDTWIN_API_PORT, DEMO_ENGINE_UI_PORT, DEMO_PID_UI_PORT,
       DEMO_FEEDTWIN_UI_PORT.
Data   $DEMO_DATA (DEMO_DATA)
Logs   $DEMO_LOGS (DEMO_LOGS)
EOF
}

# ── Entry point ────────────────────────────────────────────────────────────

main() {
  local action="start" reload="" reset=0 logs_for=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --reload)       reload=1 ;;
      --no-reload)    reload=0 ;;
      --reset)        reset=1 ;;
      --stop|--down)  action="stop" ;;
      --restart)      action="restart" ;;
      --status)       action="status" ;;
      --logs)         action="logs"; if [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then logs_for="$2"; shift; fi ;;
      -a|--attach)    action="attach" ;;
      -h|--help)      _usage; return 0 ;;
      *) warn "unknown option: $1"; _usage >&2; return 2 ;;
    esac
    shift
  done

  # --restart (and --reset of a running stack) keeps the mode it found unless
  # told otherwise, so an agent that restarts a --reload stack overnight does
  # not quietly turn reload off.
  if [ -z "$reload" ]; then
    reload=0
    if [ "$action" = "restart" ] || { [ "$reset" = "1" ] && _session_running; }; then
      [ "$(_last_mode)" = "reload" ] && reload=1
    fi
  fi

  case "$action" in
    start)
      if [ "$reset" = "1" ]; then _session_running && _stop; _reset_data; fi
      _start "$reload"
      ;;
    restart)
      _stop
      [ "$reset" = "1" ] && _reset_data
      _start "$reload"
      ;;
    stop)    _stop ;;
    status)  _status ;;
    logs)    _logs "$logs_for" ;;
    attach)
      _session_running || _start "$reload"
      exec tmux attach -t "=$DEMO_SESSION"
      ;;
  esac
}

main "$@"
