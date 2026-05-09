#!/bin/bash
# Test script to send fake PT messages directly to Elodin DB
# Replicates FSW's test pattern: data -> DB (bypassing parser)

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <db_port> [message_count]"
    echo "Example: $0 2240 10"
    exit 1
fi

DB_PORT="$1"
MESSAGE_COUNT="${2:-10}"

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Check if executable exists
TEST_BIN="$PROJECT_ROOT/build/daq_comms/send_fake_pt"
if [ ! -f "$TEST_BIN" ]; then
    echo "❌ Error: send_fake_pt not found at $TEST_BIN"
    echo "   Build it first: cmake --build build --target send_fake_pt"
    exit 1
fi

echo "🧪 Testing PT Message -> DB Pipeline"
echo "===================================="
echo "DB Port: $DB_PORT"
echo "Messages: $MESSAGE_COUNT"
echo ""

# Run the test
"$TEST_BIN" "$DB_PORT" "$MESSAGE_COUNT"

echo ""
echo "✅ Test complete!"
echo "   Check Elodin editor to see if messages appear"
