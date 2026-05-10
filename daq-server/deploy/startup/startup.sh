#!/usr/bin/env bash

# Sensor System Startup Script
# This script sets up the environment for the sensor system

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Set the root sensor directory
export ROOT_SENSOR_DIR="$SCRIPT_DIR"

# Add the sensor system to PATH
export PATH="$ROOT_SENSOR_DIR/scripts:$PATH"

# Set up environment variables
export SENSOR_CONFIG_DIR="$ROOT_SENSOR_DIR/config"
export SENSOR_SHELL_DIR="$ROOT_SENSOR_DIR/shell"

# Default configuration file
export DEFAULT_CONFIG="$SENSOR_CONFIG_DIR/config_base.toml"

echo "🚀 Sensor System Environment Setup Complete!"
echo "   Root Directory: $ROOT_SENSOR_DIR"
echo "   Config Directory: $SENSOR_CONFIG_DIR"
echo "   Default Config: $DEFAULT_CONFIG"
echo ""
echo "Available commands:"
echo "  - tmux_start_sensors.sh <config> <db_name>  : Start the sensor system"
echo "  - tmux kill-session -t sensor_system        : Stop the sensor system"
echo "  - tmux attach -t sensor_system              : Attach to running system"
echo ""
echo "Example usage:"
echo "  source startup.sh"
echo "  tmux_start_sensors.sh config/config_base.toml test_db"
