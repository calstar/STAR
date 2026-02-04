#!/bin/bash
# Test the full DAQ pipeline: fake generator -> daq_bridge -> elodin

set -e

DB_PATH="${1:-/tmp/elodin_test_db}"
DB_PORT="${2:-2240}"
UDP_PORT="${3:-8888}"
RATE_HZ="${4:-10}"

echo "🧪 Testing Full DAQ Pipeline"
echo "============================"
echo "DB path: $DB_PATH"
echo "DB port: $DB_PORT"
echo "UDP port: $UDP_PORT"
echo "Packet rate: $RATE_HZ Hz"
echo ""

# Check if executables exist (they're in build/daq_comms/ because daq_comms is a subdirectory)
if [ ! -f "./build/daq_comms/daq_bridge" ] && [ ! -f "./build/daq_bridge" ]; then
    echo "❌ daq_bridge not found. Build it first:"
    echo "   mkdir -p build && cd build && cmake .. && make"
    exit 1
fi

if [ ! -f "./build/daq_comms/fake_packet_generator" ] && [ ! -f "./build/fake_packet_generator" ]; then
    echo "❌ fake_packet_generator not found. Build it first:"
    echo "   mkdir -p build && cd build && cmake .. && make"
    exit 1
fi

# Determine executable paths (check subdirectory first, then root)
DAQ_BRIDGE="./build/daq_comms/daq_bridge"
FAKE_GEN="./build/daq_comms/fake_packet_generator"

if [ ! -f "$DAQ_BRIDGE" ]; then
    DAQ_BRIDGE="./build/daq_bridge"
fi

if [ ! -f "$FAKE_GEN" ]; then
    FAKE_GEN="./build/fake_packet_generator"
fi

# Kill any existing processes
echo "Cleaning up existing processes..."
pkill -f "elodin-db" 2>/dev/null || true
pkill -f "daq_bridge" 2>/dev/null || true
pkill -f "fake_packet_generator" 2>/dev/null || true
sleep 1

# Start Elodin database
echo "Starting Elodin database..."
elodin-db run "[::]:$DB_PORT" "$DB_PATH" > /tmp/elodin_db.log 2>&1 &
ELODIN_PID=$!
sleep 2

if ! kill -0 $ELODIN_PID 2>/dev/null; then
    echo "❌ Failed to start elodin-db"
    cat /tmp/elodin_db.log
    exit 1
fi
echo "✅ Elodin DB started (PID $ELODIN_PID)"

# Start DAQ bridge
echo "Starting DAQ bridge..."
"$DAQ_BRIDGE" "0.0.0.0" "$UDP_PORT" "127.0.0.1" "$DB_PORT" "config/sensor_routing.toml" > /tmp/daq_bridge.log 2>&1 &
DAQ_PID=$!
sleep 2

if ! kill -0 $DAQ_PID 2>/dev/null; then
    echo "❌ Failed to start daq_bridge"
    cat /tmp/daq_bridge.log
    kill $ELODIN_PID 2>/dev/null || true
    exit 1
fi
echo "✅ DAQ bridge started (PID $DAQ_PID)"

# Start fake packet generator
echo "Starting fake packet generator..."
"$FAKE_GEN" "127.0.0.1" "$UDP_PORT" "$RATE_HZ" > /tmp/fake_generator.log 2>&1 &
GENERATOR_PID=$!
sleep 1

if ! kill -0 $GENERATOR_PID 2>/dev/null; then
    echo "❌ Failed to start fake_packet_generator"
    cat /tmp/fake_generator.log
    kill $ELODIN_PID $DAQ_PID 2>/dev/null || true
    exit 1
fi
echo "✅ Fake generator started (PID $GENERATOR_PID)"
echo ""

echo "🎉 All components running!"
echo ""
echo "Monitor logs:"
echo "  tail -f /tmp/daq_bridge.log"
echo "  tail -f /tmp/fake_generator.log"
echo ""
echo "View in Elodin editor:"
echo "  elodin editor $DB_PATH"
echo ""
echo "Press Ctrl+C to stop all processes..."

# Cleanup function
cleanup() {
    echo ""
    echo "Stopping all processes..."
    kill $GENERATOR_PID $DAQ_PID $ELODIN_PID 2>/dev/null || true
    sleep 1
    echo "Done!"
    exit 0
}

trap cleanup INT TERM

# Wait and monitor
sleep 5
echo ""
echo "Checking pipeline health..."
echo ""

# Check if daq_bridge is processing packets
if grep -q "Frames decoded" /tmp/daq_bridge.log 2>/dev/null; then
    echo "✅ DAQ bridge is processing packets"
else
    echo "⚠️  DAQ bridge may not be receiving packets yet"
fi

# Show recent stats
echo ""
echo "Recent DAQ bridge stats:"
tail -n 5 /tmp/daq_bridge.log 2>/dev/null | grep -E "(Frames|Batches|Messages)" || echo "  (waiting for stats...)"

echo ""
echo "Pipeline is running. Check Elodin editor to see sensor data!"
echo ""

# Keep running until interrupted
wait
