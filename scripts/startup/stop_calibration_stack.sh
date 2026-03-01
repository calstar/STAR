#!/usr/bin/env bash
# Calibration Stack Shutdown Script
# Stops the calibration stack tmux session and all associated processes

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Calibration Stack Shutdown ===${NC}"

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo -e "${RED}Error: tmux is not installed${NC}"
    exit 1
fi

# Check if session exists
if ! tmux has-session -t calibration_stack 2>/dev/null; then
    echo -e "${YELLOW}No calibration_stack session found${NC}"
    exit 0
fi

echo -e "${YELLOW}Stopping calibration stack processes...${NC}"

# Kill processes gracefully first
echo -e "${GREEN}Sending SIGTERM to processes...${NC}"

# Kill Elodin DB
pkill -f "elodin-db run.*calibration_db" 2>/dev/null && echo "  ✅ Elodin DB stopped" || echo "  ⚠️  Elodin DB not running"

# Kill DAQ Bridge
pkill -f "daq_bridge.*config.toml" 2>/dev/null && echo "  ✅ DAQ Bridge stopped" || echo "  ⚠️  DAQ Bridge not running"

# Kill Calibration GUI
pkill -f "calibration_orchestrator_gui.py" 2>/dev/null && echo "  ✅ Calibration GUI stopped" || echo "  ⚠️  Calibration GUI not running"

# Wait a moment for graceful shutdown
sleep 2

# Force kill if still running
echo -e "${YELLOW}Checking for remaining processes...${NC}"
if pgrep -f "elodin-db.*calibration_db" > /dev/null; then
    echo -e "${RED}Force killing Elodin DB...${NC}"
    pkill -9 -f "elodin-db.*calibration_db" 2>/dev/null
fi

if pgrep -f "daq_bridge.*config.toml" > /dev/null; then
    echo -e "${RED}Force killing DAQ Bridge...${NC}"
    pkill -9 -f "daq_bridge.*config.toml" 2>/dev/null
fi

if pgrep -f "calibration_orchestrator_gui.py" > /dev/null; then
    echo -e "${RED}Force killing Calibration GUI...${NC}"
    pkill -9 -f "calibration_orchestrator_gui.py" 2>/dev/null
fi

# Kill tmux session
echo -e "${GREEN}Killing tmux session: calibration_stack${NC}"
tmux kill-session -t calibration_stack 2>/dev/null && echo "  ✅ Session killed" || echo "  ⚠️  Session already dead"

# Final check
sleep 1
if pgrep -f "(elodin-db|daq_bridge|calibration_orchestrator_gui)" > /dev/null; then
    echo -e "${RED}⚠️  Some processes may still be running:${NC}"
    pgrep -af "(elodin-db|daq_bridge|calibration_orchestrator_gui)" | grep -v grep || true
else
    echo -e "${GREEN}✅ All calibration stack processes stopped${NC}"
fi
