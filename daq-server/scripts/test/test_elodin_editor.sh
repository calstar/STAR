#!/bin/bash
# Test script to verify Elodin editor can see messages

set -e

DB_PATH="/tmp/elodin_test_db"
DB_PORT="2240"

# Clean up any existing processes
pkill -f "daq_bridge\|elodin-db\|fake_packet" 2>/dev/null || true
fuser -k ${DB_PORT}/tcp 8888/udp 2>/dev/null || true
sleep 1

# Remove old database (if it's a file)
rm -f "$DB_PATH" 2>/dev/null || true
# If it's a directory, remove its contents
rm -rf "$DB_PATH"/* 2>/dev/null || true

echo "Starting Elodin database..."
elodin-db run "[::]:${DB_PORT}" "$DB_PATH" > /tmp/db.log 2>&1 &
DB_PID=$!
sleep 2

echo "Starting DAQ bridge..."
./build/daq_comms/daq_bridge "0.0.0.0" "8888" "127.0.0.1" "${DB_PORT}" "config/sensor_routing.toml" > /tmp/bridge.log 2>&1 &
BRIDGE_PID=$!
sleep 2

echo "Sending test packets..."
timeout 5 ./build/daq_comms/fake_packet_generator "127.0.0.1" "8888" "10" > /dev/null 2>&1 || true

sleep 2

echo ""
echo "=== Bridge Statistics ==="
tail -15 /tmp/bridge.log | grep -E "(Stats|Processed|published|decoded)" || tail -10 /tmp/bridge.log

echo ""
echo "=== Database Status ==="
tail -5 /tmp/db.log || echo "No DB log output"

echo ""
echo "=== Test Complete ==="
echo "To view messages in editor, run:"
echo "  elodin editor $DB_PATH"
echo ""
echo "Or connect via network:"
echo "  elodin editor 127.0.0.1:${DB_PORT}"
echo ""

# Keep processes running for manual testing
echo "Processes are still running. Press Ctrl+C to stop, or run:"
echo "  kill $BRIDGE_PID $DB_PID"

wait
