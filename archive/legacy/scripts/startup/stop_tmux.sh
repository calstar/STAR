#!/bin/bash
# =============================================================================
# Sensor System tmux Shutdown
# Kills the tmux session and all associated processes
# Usage: ./scripts/startup/stop_tmux.sh [session_name]
# =============================================================================

SESSION="${1:-sensor}"

echo "Shutting down sensor system..."

# Kill tmux session (kills all panes/processes inside it)
if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux kill-session -t "$SESSION"
    echo "  ✅ tmux session '$SESSION' killed"
else
    echo "  ⚠️  No tmux session '$SESSION' found"
fi

# Mop up any stragglers
pkill -f "elodin-db run.*:2240" 2>/dev/null && echo "  ✅ Stopped elodin-db" || true
pkill -f "daq_bridge" 2>/dev/null && echo "  ✅ Stopped daq_bridge" || true
pkill -f "combined_gui.py" 2>/dev/null && echo "  ✅ Stopped Diablo GUI" || true
pkill -f "combined_fsw_gui" 2>/dev/null && echo "  ✅ Stopped FSW GUI" || true
pkill -f "next dev" 2>/dev/null && echo "  ✅ Stopped Web GUI Frontend" || true
pkill -f "tsx watch.*server.ts" 2>/dev/null && echo "  ✅ Stopped Web GUI Backend" || true

echo "Done."
