#!/bin/bash
# Quick launch script for Ground Station GUI

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "🚀 Launching Diablo FSW Ground Station GUI"
echo "================================================"
echo ""
echo "Prerequisites:"
echo "  ✓ FSW must be running with GroundStationInterface enabled"
echo "  ✓ Ports 2241 (commands) and 2242 (telemetry) must be available"
echo ""
echo "Default connection:"
echo "  Host: 127.0.0.1"
echo "  Command Port: 2241"
echo "  Telemetry Port: 2242"
echo ""

# Check Python dependencies
if ! python3 -c "import PyQt6" 2>/dev/null; then
    echo "❌ PyQt6 not found. Installing..."
    pip3 install PyQt6 pyqtgraph numpy
fi

# Launch GUI
cd "$SCRIPT_DIR"
python3 ground_station_gui.py

echo ""
echo "Ground Station GUI closed."

