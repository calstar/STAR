#!/usr/bin/env bash
set -euo pipefail

# Sensor System Shutdown Script
# Gracefully shuts down all sensor system components

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🛑 Shutting down Sensor System...${NC}"

# Session names to clean up
SESSION_NAMES=("complete_sensor_system" "sensor_system" "groundstation" "jetson_sensors")

# Gracefully kill processes with SIGINT (Ctrl+C signal)
echo -e "${BLUE}📡 Stopping sensor processes...${NC}"
pkill -2 -f fake_sensor_generator || true
pkill -2 -f fake_sensor_generator_remote || true
pkill -2 -f sensor_data_viewer.py || true
pkill -2 -f view_sensor_data.py || true
pkill -2 -f startup_db.sh || true

# Give processes time to clean up gracefully
sleep 2

echo -e "${BLUE}🗄️  Stopping database processes...${NC}"
pkill -2 -f elodin-db || true

# Give database time to flush and close properly
sleep 2

# Kill tmux sessions
for SESSION_NAME in "${SESSION_NAMES[@]}"; do
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo -e "${BLUE}🖥️  Killing tmux session '$SESSION_NAME'...${NC}"
        tmux kill-session -t "$SESSION_NAME"
        echo -e "${GREEN}✅ Session '$SESSION_NAME' terminated.${NC}"
    else
        echo -e "${YELLOW}ℹ️  No tmux session named '$SESSION_NAME' found.${NC}"
    fi
done

# Kill tmux server (just in case)
if pgrep -x tmux > /dev/null; then
    echo -e "${BLUE}🖥️  Forcing tmux server shutdown...${NC}"
    tmux kill-server || true
fi

# Final cleanup - kill any remaining stray processes
echo -e "${BLUE}🧹 Final cleanup of remaining processes...${NC}"
pkill -f fake_sensor_generator || true
pkill -f elodin-db || true
pkill -f sensor_data_viewer || true
pkill -f view_sensor_data || true

# Clean up any leftover socket connections
echo -e "${BLUE}🔌 Checking for leftover connections on port 2240...${NC}"
if lsof -i:2240 >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Found processes still using port 2240${NC}"
    lsof -i:2240 | head -10
    echo -e "${BLUE}Attempting to clean up...${NC}"
    fuser -k 2240/tcp 2>/dev/null || true
else
    echo -e "${GREEN}✅ Port 2240 is clean${NC}"
fi

echo
echo -e "${GREEN}🎉 Sensor System shutdown complete!${NC}"
echo -e "${BLUE}All processes stopped and tmux sessions cleaned up.${NC}"
echo
