#!/usr/bin/env bash
# Robust Calibration Stack Shutdown

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}=== Stopping Robust Calibration Stack ===${NC}"

# Order: stop consumers first, then producers
pkill -f "calibration_server.py" 2>/dev/null && echo "  ✅ Calibration server" || true
pkill -f "calibration_orchestrator_gui" 2>/dev/null && echo "  ✅ Calibration GUI" || true
pkill -f "elodin-relay" 2>/dev/null && echo "  ✅ Relay" || true
pkill -f "daq_bridge.*config.toml" 2>/dev/null && echo "  ✅ DAQ bridge" || true
pkill -f "elodin-db run" 2>/dev/null && echo "  ✅ Elodin DB" || true

sleep 2

# Force kill if needed
for pat in "calibration_server" "calibration_orchestrator" "elodin-relay" "daq_bridge" "elodin-db"; do
  pgrep -f "$pat" >/dev/null && pkill -9 -f "$pat" 2>/dev/null || true
done

if tmux has-session -t calibration_stack 2>/dev/null; then
  tmux kill-session -t calibration_stack 2>/dev/null && echo "  ✅ Tmux session" || true
fi

echo -e "${GREEN}✅ Calibration stack stopped${NC}"
