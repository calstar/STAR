#!/bin/bash

# Check if database is running
if ! pgrep -f "elodin-db" > /dev/null; then
    echo "ERROR: Database not running"
    exit 1
fi

# Check if sensors are running
if ! pgrep -f "fake_sensor_generator" > /dev/null; then
    echo "ERROR: Sensors not running"
    exit 1
fi

# Check network connectivity
if ! nc -z ${GROUNDSTATION_IP:-"192.168.1.100"} 2240; then
    echo "ERROR: Cannot connect to ground station"
    exit 1
fi

echo "All systems operational"


