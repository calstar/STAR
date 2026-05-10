#!/bin/bash

# Development script to run both backend and frontend together
# Usage: ./dev.sh

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting EngineDesign development servers...${NC}"

# Cleanup function to kill background processes on exit
cleanup() {
    echo -e "\n${BLUE}Shutting down servers...${NC}"
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start backend
echo -e "${BLUE}Starting backend on http://localhost:8000${NC}"
cd "$PROJECT_ROOT"

# Kill any process using port 8000 (works on both macOS and Linux)
# Try multiple times to ensure port is free
for attempt in {1..3}; do
    if command -v lsof > /dev/null 2>&1; then
        # macOS/Linux with lsof
        PIDS=$(lsof -ti:8000 2>/dev/null || true)
        if [ -n "$PIDS" ]; then
            echo -e "${BLUE}Killing process(es) on port 8000 (attempt $attempt)...${NC}"
            echo "$PIDS" | xargs kill -9 2>/dev/null || true
            sleep 2
        else
            break  # Port is free
        fi
    elif command -v fuser > /dev/null 2>&1; then
        # Linux alternative
        if fuser 8000/tcp > /dev/null 2>&1; then
            echo -e "${BLUE}Killing process on port 8000 (attempt $attempt)...${NC}"
            fuser -k 8000/tcp 2>/dev/null || true
            sleep 2
        else
            break  # Port is free
        fi
    else
        break  # No tool available
    fi
done

# Use python -m uvicorn to avoid broken conda environment issues
python3 -m uvicorn backend.main:app --reload --port 8000 &
BACKEND_PID=$!

# Wait a moment to check if backend started successfully
sleep 2
if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo -e "${RED}ERROR: Backend failed to start. Port 8000 may still be in use.${NC}"
    echo -e "${BLUE}Try running: lsof -ti:8000 | xargs kill -9${NC}"
    exit 1
fi

# Check if frontend dependencies are installed
if [ ! -d "$PROJECT_ROOT/frontend/node_modules" ]; then
    echo -e "${BLUE}Installing frontend dependencies...${NC}"
    cd "$PROJECT_ROOT/frontend"
    npm install
fi

# Start frontend
echo -e "${BLUE}Starting frontend on http://localhost:5173${NC}"
cd "$PROJECT_ROOT/frontend"
# Suppress MESA/OpenGL warnings in WSL2 (harmless but noisy)
export LIBGL_ALWAYS_SOFTWARE=1 2>/dev/null || true
npm run dev 2>&1 | grep -v "MESA\|ZINK\|glx\|drisw" &
FRONTEND_PID=$!

echo -e "${GREEN}Both servers running! Press Ctrl+C to stop.${NC}"

# Wait for both processes
wait

