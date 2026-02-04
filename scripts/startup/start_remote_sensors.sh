#!/bin/bash
set -e

GROUNDSTATION_IP=${1:-"192.168.1.100"}
PORT=${2:-"2240"}

echo "Starting Remote Sensors..."
echo "Connecting to ground station at $GROUNDSTATION_IP:$PORT"

# Kill any existing processes
pkill -f "fake_sensor_generator" || true

# Start sensor generator
echo "Starting sensor generator..."
./scripts/fake_sensor_generator_remote $GROUNDSTATION_IP $PORT &
SENSOR_PID=$!

echo "Remote sensors started!"
echo "Sensor PID: $SENSOR_PID"

# Wait for user to stop
echo "Press Ctrl+C to stop sensors"
trap "kill $SENSOR_PID; exit" INT
wait
