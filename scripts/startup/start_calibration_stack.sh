#!/usr/bin/env bash
# Robust Calibration Stack Startup
# Pipeline: Elodin DB → Relay (first subscriber) → DAQ bridge → Calibration server
# Calibration server: RobustCalibrationFramework (TLS, Bayesian, RLS, GLR) + AutonomousCalibrationEngine
#
# Usage: ./scripts/startup/start_calibration_stack.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== Robust Calibration Stack ===${NC}"
echo "  TLS + Bayesian + RLS + GLR drift + Empirical Bayes + Active learning"
echo ""

# Prereqs
if ! command -v tmux &>/dev/null; then
  echo -e "${RED}Error: tmux required. Install: sudo apt install tmux${NC}"
  exit 1
fi
if ! command -v elodin-db &>/dev/null && [ ! -x "$HOME/.cargo/bin/elodin-db" ]; then
  echo -e "${RED}Error: elodin-db required. Install: cargo install elodin-db${NC}"
  exit 1
fi

# Kill existing
if tmux has-session -t calibration_stack 2>/dev/null; then
  echo -e "${YELLOW}Killing existing calibration_stack...${NC}"
  tmux kill-session -t calibration_stack
  sleep 1
fi

# Build
DAQ_BIN="$REPO_ROOT/build/FSW/daq_bridge"
[ ! -x "$DAQ_BIN" ] && DAQ_BIN="$REPO_ROOT/FSW/build/daq_bridge"
if [ ! -x "$DAQ_BIN" ]; then
  echo -e "${YELLOW}Building daq_bridge...${NC}"
  mkdir -p "$REPO_ROOT/build" && cd "$REPO_ROOT/build"
  [ ! -f CMakeCache.txt ] && cmake ..
  make -j"$(nproc)" daq_bridge 2>/dev/null || true
  cd "$REPO_ROOT"
fi

ELODIN_DB_DIR="${ELODIN_DB_DIR:-$HOME/.local/share/elodin/calibration}"
mkdir -p "$(dirname "$ELODIN_DB_DIR")"

echo -e "${GREEN}Creating tmux session: calibration_stack${NC}"
tmux new-session -d -s calibration_stack -x 200 -y 60

# Pane 0: Elodin DB
tmux send-keys -t calibration_stack:0.0 "cd $REPO_ROOT" C-m
tmux send-keys -t calibration_stack:0.0 "elodin-db run '[::]:2240' $ELODIN_DB_DIR" C-m
sleep 2
echo -e "${GREEN}✅ Elodin DB :2240${NC}"

# Pane 1: Relay (must connect before DAQ bridge writes — first subscriber gets stream)
tmux split-window -h -t calibration_stack:0.0
tmux send-keys -t calibration_stack:0.1 "cd $REPO_ROOT/web-gui/backend" C-m
tmux send-keys -t calibration_stack:0.1 "[ -d node_modules ] || npm install --silent" C-m
tmux send-keys -t calibration_stack:0.1 "npm run relay" C-m
sleep 2
echo -e "${GREEN}✅ Relay :9090${NC}"

# Pane 2: DAQ Bridge
tmux split-window -v -t calibration_stack:0.1
tmux send-keys -t calibration_stack:0.2 "cd $REPO_ROOT && $DAQ_BIN config/config.toml" C-m
sleep 1
echo -e "${GREEN}✅ DAQ bridge (UDP :5006 → Elodin)${NC}"

# Pane 3: Calibration server (robust Python sidecar)
tmux split-window -v -t calibration_stack:0.0
if [ "${USE_ROBUST_CALIBRATION:-1}" = "0" ]; then
  CAL_BIN="$REPO_ROOT/build/FSW/calibration_service"
  [ ! -x "$CAL_BIN" ] && CAL_BIN="$REPO_ROOT/FSW/build/calibration_service"
  if [ -x "$CAL_BIN" ]; then
    tmux send-keys -t calibration_stack:0.3 "cd $REPO_ROOT" C-m
    tmux send-keys -t calibration_stack:0.3 "$CAL_BIN --config config/config.toml --elodin-host 127.0.0.1 --relay-host 127.0.0.1 --relay-port 9091" C-m
    echo -e "${GREEN}✅ Calibration service (C++) — polynomial PT/TC/RTD/LC → DB${NC}"
  else
    tmux send-keys -t calibration_stack:0.3 "cd $REPO_ROOT" C-m
    tmux send-keys -t calibration_stack:0.3 "PYTHONPATH=$REPO_ROOT python3 scripts/calibration/calibration_server.py" C-m
    echo -e "${GREEN}✅ Calibration server :8100 (robust TLS/Bayesian/RLS/GLR)${NC}"
  fi
else
  tmux send-keys -t calibration_stack:0.3 "cd $REPO_ROOT" C-m
  tmux send-keys -t calibration_stack:0.3 "PYTHONPATH=$REPO_ROOT python3 scripts/calibration/calibration_server.py" C-m
  echo -e "${GREEN}✅ Calibration server :8100 (robust TLS/Bayesian/RLS/GLR)${NC}"
fi
sleep 1

# Pane 4: Calibration GUI (optional)
tmux split-window -v -t calibration_stack:0.2
tmux send-keys -t calibration_stack:0.4 "cd $REPO_ROOT/scripts/calibration" C-m
tmux send-keys -t calibration_stack:0.4 "python3 calibration_orchestrator_gui.py" C-m
echo -e "${GREEN}✅ Calibration GUI${NC}"

# Pane titles
tmux select-pane -t calibration_stack:0.0 -T "Elodin DB"
tmux select-pane -t calibration_stack:0.1 -T "Relay"
tmux select-pane -t calibration_stack:0.2 -T "DAQ Bridge"
tmux select-pane -t calibration_stack:0.3 -T "Calibration Server"
tmux select-pane -t calibration_stack:0.4 -T "Calibration GUI"

echo ""
echo -e "${GREEN}✅ Robust calibration stack running${NC}"
echo ""
echo -e "${YELLOW}Pipeline:${NC} UDP :5006 → daq_bridge → Elodin → relay :9090 → calibration_server → Elodin (PT_Cal)"
echo -e "${YELLOW}Stop:${NC}     ./scripts/startup/stop_calibration_stack.sh"
echo -e "${YELLOW}Attach:${NC}   tmux attach -t calibration_stack"
echo ""

if [ -t 0 ]; then
  sleep 1
  tmux attach -t calibration_stack 2>/dev/null || true
fi
