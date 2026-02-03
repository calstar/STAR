#!/bin/bash
# Stop DAQ Bridge and Database
# Usage: ./stop_daq.sh

set -e

echo "🛑 Stopping DAQ bridge and database..."

# Kill DAQ bridge processes
pkill -f "daq_bridge" 2>/dev/null && echo "✅ Stopped DAQ bridge" || echo "   No DAQ bridge running"

# Kill fake packet generator
pkill -f "fake_packet_generator" 2>/dev/null && echo "✅ Stopped packet generator" || echo "   No packet generator running"

# Kill Elodin database
pkill -f "elodin-db" 2>/dev/null && echo "✅ Stopped Elodin database" || echo "   No database running"

# Kill processes on ports
UDP_PORT=8888
ELODIN_PORT=2240

PIDS=$(lsof -t -i:$UDP_PORT 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
    echo "✅ Freed UDP port $UDP_PORT"
fi

PIDS=$(lsof -t -i:$ELODIN_PORT 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
    echo "✅ Freed Elodin port $ELODIN_PORT"
fi

sleep 1
echo ""
echo "✅ All DAQ processes stopped"



