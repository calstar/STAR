#!/usr/bin/env bash
set -e

# Cross-platform IPv6 address handling
get_ipv6_bind_address() {
    local port="$1"
    # Use printf to avoid shell globbing issues with [::] syntax
    printf '[::]:%s' "$port"
}

echo "Starting Ground Station..."

# Kill any existing processes
pkill -f "elodin-db" || true
pkill -f "sensor_data_viewer" || true

# Clean up old database
rm -rf ~/.local/share/elodin/test_db*

# Start database
echo "Starting Elodin database..."
elodin-db run "$(get_ipv6_bind_address 2240)" ~/.local/share/elodin/test_db &
DB_PID=$!

# Wait for database to start
sleep 5

# Start data viewer
echo "Starting data viewer..."
python3 groundstation/scripts/sensor_data_viewer.py --host 0.0.0.0 --port 2240 &
VIEWER_PID=$!

echo "Ground station started!"
echo "Database PID: $DB_PID"
echo "Viewer PID: $VIEWER_PID"
echo "Access viewer at: http://localhost:8080"

# Wait for user to stop
echo "Press Ctrl+C to stop all services"
trap "kill $DB_PID $VIEWER_PID; exit" INT
wait
