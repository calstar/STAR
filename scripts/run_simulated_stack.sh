#!/bin/bash
# Run simulated DAQ stack for development/testing
# This script starts elodin-db and daq_bridge with a fake packet generator

set -e

DB_PATH="${1:-/tmp/elodin_test_db}"
DB_PORT="${2:-2240}"
UDP_PORT="${3:-8888}"

echo "🚀 Starting simulated DAQ stack..."
echo "  DB path: $DB_PATH"
echo "  DB port: $DB_PORT"
echo "  UDP port: $UDP_PORT"

# Kill any existing processes
pkill -f "elodin-db" 2>/dev/null || true
pkill -f "daq_bridge" 2>/dev/null || true
sleep 1

# Start Elodin database
echo "Starting Elodin database..."
elodin-db run "[::]:$DB_PORT" "$DB_PATH" &
ELODIN_PID=$!
sleep 2

# Check if elodin-db started successfully
if ! kill -0 $ELODIN_PID 2>/dev/null; then
    echo "❌ Failed to start elodin-db"
    exit 1
fi

# Start DAQ bridge
echo "Starting DAQ bridge..."
DAQ_BRIDGE="./build/daq_comms/daq_bridge"
if [ ! -f "$DAQ_BRIDGE" ]; then
    DAQ_BRIDGE="./build/daq_bridge"
fi

if [ -f "$DAQ_BRIDGE" ]; then
    "$DAQ_BRIDGE" "0.0.0.0" "$UDP_PORT" "127.0.0.1" "$DB_PORT" "config/sensor_routing.toml" &
    DAQ_PID=$!
else
    echo "❌ daq_bridge not found. Build it first: mkdir -p build && cd build && cmake .. && make"
    kill $ELODIN_PID 2>/dev/null || true
    exit 1
fi

sleep 1

# Check if daq_bridge started successfully
if ! kill -0 $DAQ_PID 2>/dev/null; then
    echo "❌ Failed to start daq_bridge"
    kill $ELODIN_PID 2>/dev/null || true
    exit 1
fi

echo "✅ Stack started successfully!"
echo ""
echo "Processes:"
echo "  Elodin DB: PID $ELODIN_PID"
echo "  DAQ Bridge: PID $DAQ_PID"
echo ""
echo "To stop:"
echo "  kill $ELODIN_PID $DAQ_PID"
echo ""
echo "To view in Elodin editor:"
echo "  elodin editor $DB_PATH"
echo ""
echo "To send test packets:"
echo "  ./build/fake_packet_generator localhost $UDP_PORT 10"

# Wait for user interrupt
trap "echo 'Stopping...'; kill $ELODIN_PID $DAQ_PID 2>/dev/null; exit" INT TERM

wait

