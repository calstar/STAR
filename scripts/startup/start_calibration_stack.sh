#!/usr/bin/env bash
# Calibration Stack Startup Script
# Launches Elodin DB, DAQ bridge, and Calibration GUI in tmux

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Calibration Stack Startup ===${NC}"

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo -e "${RED}Error: tmux is not installed${NC}"
    exit 1
fi

# Kill existing tmux session if it exists
if tmux has-session -t calibration_stack 2>/dev/null; then
    echo -e "${YELLOW}Killing existing calibration_stack session...${NC}"
    tmux kill-session -t calibration_stack
    sleep 1
fi

# Create new tmux session
echo -e "${GREEN}Creating tmux session: calibration_stack${NC}"
tmux new-session -d -s calibration_stack -x 200 -y 60

# ── Pane 0: Elodin Database ────────────────────────────────────────────────
echo -e "${GREEN}Starting Elodin DB...${NC}"
# Start Elodin DB directly (bypassing the source requirement which has interactive prompts)
tmux send-keys -t calibration_stack:0.0 \
    "cd $REPO_ROOT" C-m
sleep 0.3
# Kill any existing elodin-db on port 2240
tmux send-keys -t calibration_stack:0.0 \
    "pkill -f 'elodin-db run.*calibration_db' 2>/dev/null || true" C-m
sleep 0.3
# Start elodin-db (non-interactive)
tmux send-keys -t calibration_stack:0.0 \
    "if command -v elodin-db &> /dev/null; then elodin-db run calibration_db '[::]:2240' 2>&1; else echo 'Error: elodin-db not found in PATH. Install with: cargo install elodin-db'; fi" \
    C-m

# Wait for DB to start
sleep 3

# ── Pane 1: DAQ Bridge ─────────────────────────────────────────────────────
echo -e "${GREEN}Starting DAQ Bridge...${NC}"
tmux split-window -h -t calibration_stack:0.0
tmux send-keys -t calibration_stack:0.1 \
    "cd $REPO_ROOT && if [ -d build ]; then cd build && ./FSW/daq_bridge ../config/config.toml; else echo 'Build directory not found. Run: mkdir -p build && cd build && cmake .. && make'; fi" \
    C-m

# ── Pane 2: Calibration GUI ───────────────────────────────────────────────
echo -e "${GREEN}Starting Calibration GUI...${NC}"
tmux split-window -v -t calibration_stack:0.1
sleep 0.3
tmux send-keys -t calibration_stack:0.2 \
    "cd $REPO_ROOT/scripts/calibration" C-m
sleep 0.3
tmux send-keys -t calibration_stack:0.2 \
    "python3 calibration_orchestrator_gui.py" \
    C-m

# ── Pane 3: Status/Logs (optional) ────────────────────────────────────────
tmux split-window -v -t calibration_stack:0.0
tmux send-keys -t calibration_stack:0.3 \
    "cd $REPO_ROOT && echo '=== Calibration Stack Status ===' && echo '' && echo 'Pane 0: Elodin DB (port 2240)' && echo 'Pane 1: DAQ Bridge' && echo 'Pane 2: Calibration GUI' && echo '' && echo 'Press Ctrl+B then D to detach' && echo 'Press Ctrl+B then X to close pane' && echo '' && while true; do clear; echo '=== Process Status ==='; ps aux | grep -E '(elodin-db|daq_bridge|calibration_orchestrator_gui)' | grep -v grep || echo 'No processes found'; sleep 5; done" \
    C-m

# Set pane titles
tmux select-pane -t calibration_stack:0.0 -T "Elodin DB"
tmux select-pane -t calibration_stack:0.1 -T "DAQ Bridge"
tmux select-pane -t calibration_stack:0.2 -T "Calibration GUI"
tmux select-pane -t calibration_stack:0.3 -T "Status"

# Focus on GUI pane
tmux select-pane -t calibration_stack:0.2

# Instructions
echo ""
echo -e "${GREEN}✅ Calibration stack started in tmux session: calibration_stack${NC}"
echo ""
echo -e "${YELLOW}Commands:${NC}"
echo "  tmux attach -t calibration_stack                    # Attach to session"
echo "  ./scripts/startup/stop_calibration_stack.sh        # Stop everything (recommended)"
echo "  tmux kill-session -t calibration_stack             # Stop everything (alternative)"
echo ""
echo -e "${YELLOW}Inside tmux:${NC}"
echo "  Ctrl+B then D    # Detach (keeps running)"
echo "  Ctrl+B then X    # Close current pane"
echo "  Ctrl+B then arrow keys  # Switch panes"
echo ""
echo -e "${GREEN}Session ready!${NC}"
echo ""
echo -e "${YELLOW}To attach to the session, run:${NC}"
echo "  tmux attach -t calibration_stack"
echo ""
# Only attach if we're in an interactive terminal
if [ -t 0 ]; then
    echo -e "${GREEN}Attaching to session...${NC}"
    sleep 1
    tmux attach -t calibration_stack 2>/dev/null || echo "  (Run 'tmux attach -t calibration_stack' manually)"
else
    echo -e "${YELLOW}Not in interactive terminal. Run 'tmux attach -t calibration_stack' to view.${NC}"
fi
