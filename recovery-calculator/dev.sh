#!/usr/bin/env bash
# recovery-calculator/dev.sh — backend :8100 + frontend :5273.
#
# PLAN.md §11.1: the ports are load-bearing, not cosmetic. EngineDesign/dev.sh
# force-kills whatever holds 8000, so sharing a port would let one app silently
# kill the other. This app owns 8100 and 5273 and touches nothing else.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKEND_PORT=8100
FRONTEND_PORT=5273

GREEN='\033[0;32m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo -e "\n${BLUE}Shutting down...${NC}"
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup EXIT INT TERM

# ─── venv ────────────────────────────────────────────────────────────────────
if [ ! -x .venv/bin/uvicorn ]; then
  echo -e "${BLUE}Creating .venv and installing requirements...${NC}"
  [ -d .venv ] || python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements.txt
  # The design core shared with EngineDesign and pid-designer. Not in
  # requirements.txt: the path that reaches it differs between a checkout
  # and a Docker build context (see Dockerfile.api).
  .venv/bin/pip install --quiet -e ../lib/stardesign
fi
PYTHON_CMD="$SCRIPT_DIR/.venv/bin/python3"

# ─── free the backend port ───────────────────────────────────────────────────
# Only ours. Deliberately never touches 8000 or 8001.
for attempt in 1 2 3; do
  PIDS=$(lsof -ti:"$BACKEND_PORT" 2>/dev/null || true)
  [ -z "$PIDS" ] && break
  echo -e "${BLUE}Freeing port $BACKEND_PORT (attempt $attempt)${NC}"
  echo "$PIDS" | xargs -r kill -9 2>/dev/null || true
  sleep 1
done

# ─── backend ─────────────────────────────────────────────────────────────────
echo -e "${GREEN}Backend  → http://localhost:$BACKEND_PORT  (docs at /docs)${NC}"
"$PYTHON_CMD" -m uvicorn backend.main:app --reload --port "$BACKEND_PORT" &
BACKEND_PID=$!

# uvicorn exits silently on an import error, and the frontend would then sit
# on its 6 s timeout per request while falling back to fixtures -- which looks
# like "physics not written yet" rather than "backend is broken". Catch it.
sleep 2
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo -e "${RED}Backend died on startup. Run it directly to see why:${NC}"
  echo "  cd $SCRIPT_DIR && .venv/bin/python -m uvicorn backend.main:app --port $BACKEND_PORT"
  exit 1
fi

# ─── frontend ────────────────────────────────────────────────────────────────
if [ -d frontend ]; then
  if [ ! -d frontend/node_modules ]; then
    echo -e "${BLUE}Installing frontend dependencies...${NC}"
    (cd frontend && (npm ci --silent 2>/dev/null || npm install --silent))
  fi
  echo -e "${GREEN}Frontend → http://localhost:$FRONTEND_PORT${NC}"
  # WSL2 software-renders WebGL and floods stderr with MESA/ZINK noise that
  # buries anything useful. Same handling as EngineDesign/dev.sh.
  (cd frontend && LIBGL_ALWAYS_SOFTWARE=1 npm run dev 2>&1 \
     | grep -vE "MESA|ZINK|libGL|glx" ) &
  FRONTEND_PID=$!
else
  echo -e "${BLUE}No frontend/ — backend only.${NC}"
fi

wait
