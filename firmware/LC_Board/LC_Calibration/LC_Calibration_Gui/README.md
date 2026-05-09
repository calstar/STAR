# LC Calibration GUI

Live plotting GUI for LC (Load Cell) calibration data from the LC_Calibration firmware.

Receives DAQv2-Comms SENSOR_DATA packets over UDP from LC_Calibration firmware,
decodes them, and displays real-time voltage plots for each LC connector (1, 2, 3, 6, 7).

## Requirements

Install the required Python packages:

```bash
pip install -r requirements.txt
```

On macOS, if you encounter segfaults with PyQt6, the requirements file will automatically use PyQt5 instead.

## Usage

1. Upload the `LC_Calibration` firmware to your ESP32-S3 board
2. Connect the board to your computer via Ethernet (same network)
3. Ensure the firmware's `receiverIP` matches your computer's IP address (default: 192.168.2.20)
4. Run the GUI:

```bash
python lc_calibration_gui.py [-p 5006] [-a 0.0.0.0]
```

Options:
- `-p, --port`: UDP port to listen on (default: 5006)
- `-a, --address`: Bind address (default: 0.0.0.0)

5. The GUI will automatically start listening for UDP packets and display real-time voltage plots

## Features

- **Real-time plotting**: Live voltage plots for LC connectors 1, 2, 3, 6, 7
- **Individual channel control**: Toggle visibility of each connector
- **Statistics**: Current voltage readings and packet rate
- **Export to CSV**: Save collected data for analysis
- **Autoscale**: Automatically adjust Y-axis range or set manually
- **Ethernet communication**: No serial port conflicts

## Network Configuration

The firmware is configured with:
- **Board IP**: 192.168.2.100
- **Receiver IP**: 192.168.2.20 (your computer)
- **UDP Port**: 5006

To change these settings, modify the firmware's `staticIP` and `receiverIP` variables in `src/main.cpp`.

## Notes

- The firmware reads each LC connector as a differential measurement (pin 1 vs pin 2)
- Currently only reading ADC1 connectors: 1, 2, 3, 6, 7 (ADC2 is not soldered)
- Connectors 4-5 and 8-10 use ADC2 (not currently supported)
- The GUI displays all 10 connectors, but only connectors 1, 2, 3, 6, 7 will show data
- Uses DAQv2-Comms protocol for reliable packet transmission over Ethernet
