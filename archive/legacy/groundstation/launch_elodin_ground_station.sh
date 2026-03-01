#!/bin/bash
# Launch Elodin-Integrated Ground Station GUI

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "🚀 Launching Diablo FSW Ground Station (Elodin Integrated)"
echo "============================================================"
echo ""
echo "This version uses Elodin as the central data store:"
echo "  • Commands written to Elodin DB"
echo "  • FSW reads commands from Elodin"
echo "  • FSW writes telemetry to Elodin"
echo "  • GUI reads telemetry from Elodin"
echo "  • Complete audit trail in database"
echo ""
echo "Prerequisites:"
echo "  ✓ Elodin database must be running on port 2240"
echo "  ✓ FSW must be running with ElodinCommandHandler"
echo ""
echo "Default connection:"
echo "  Host: 127.0.0.1"
echo "  Port: 2240 (Elodin DB)"
echo ""

# Check if Elodin DB is running
if ! nc -z 127.0.0.1 2240 2>/dev/null; then
    echo "⚠️  WARNING: Elodin DB does not appear to be running on port 2240"
    echo ""
    echo "Start Elodin DB with:"
    echo "  elodin-db run '[::]:2240' ~/.local/share/elodin/diablo_fsw"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check Python dependencies
if ! python3 -c "import PyQt6" 2>/dev/null; then
    echo "❌ PyQt6 not found. Installing..."
    pip3 install PyQt6 pyqtgraph numpy
fi

# Launch GUI
cd "$SCRIPT_DIR"
python3 ground_station_elodin_gui.py

echo ""
echo "Ground Station GUI closed."
