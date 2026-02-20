# FSW Combined GUI

A comprehensive ground station GUI for the FSW sensor system, similar to DiabloAvionics `combined_gui.py` but fully integrated with the FSW stack and Elodin database.

## Features

### Core Components

1. **Top Bar**
   - Pressure gauges: GN2 (green), ETH (red), LOX (blue)
   - Current state display
   - ABORT and EMERGENCY ABORT buttons
   - SETTINGS navigation button

2. **State Machine Control**
   - All state buttons: Idle, Armed, Fuel Fill, Ox Fill, Quick Fire, GN2 Press, Fuel Press, Fuel Vent, Ox Press, Ox Vent, High Press, GN2 Vent, Fire, Vent
   - Highlights current active state
   - Sends state transitions via Elodin database

3. **Sensor Plot Widget** (Left 66%)
   - Real-time pressure data visualization
   - Multiple colored lines for different sensors
   - Auto-scale Y-axis toggle
   - Network statistics
   - Live sensor readings panel

4. **Actuator Control Widget** (Right 33%)
   - 2x5 grid of actuator controls
   - ON/OFF (OPEN/CLOSED) buttons for each actuator
   - Voltage readings display
   - Customizable actuator labels

### Integration

- **Elodin Database**: Primary data source for sensor data and command interface
- **UDP Receiver**: Fallback for direct DiabloAvionics packet reception
- **State Machine**: Commands sent via Elodin, FSW reads and executes
- **Actuator Control**: Commands sent via Elodin or direct UDP

## Requirements

```bash
pip install PyQt6 pyqtgraph numpy
```

## Usage

### Basic Usage

```bash
python3 scripts/gui/combined_fsw_gui.py
```

### With Elodin Database

1. Start Elodin database:
   ```bash
   ./scripts/startup/startup_daq_db.sh
   ```

2. Start DAQ bridge (if using UDP fallback):
   ```bash
   ./build/FSW/daq_bridge config/config.toml 0.0.0.0 5006
   ```

3. Run GUI:
   ```bash
   python3 scripts/gui/combined_fsw_gui.py
   ```

## Configuration

Configuration is stored in `scripts/gui/fsw_gui_config.json`:

```json
{
  "actuators": {
    "1": "Fuel Main",
    "2": "LOX Main",
    ...
  },
  "sensors": {
    "1": "GN2 Regulated",
    "2": "Fuel Upstream",
    ...
  },
  "network": {
    "actuator_ip": "192.168.2.201",
    "actuator_port": 5005,
    "receive_port": 5006,
    "bind_address": "0.0.0.0"
  },
  "display": {
    "window_seconds": 40.0,
    "y_axis_min": 0.0,
    "y_axis_max": 200.0,
    "y_axis_autoscale": true
  },
  "mappings": {
    "GN2": 1,
    "ETH": 2,
    "LOX": 3
  }
}
```

## Architecture

### Data Flow

1. **Sensor Data**:
   - Boards → UDP → DAQ Bridge → Elodin Database → GUI
   - OR: Boards → UDP → GUI (direct fallback)

2. **Commands**:
   - GUI → Elodin Database → FSW → Actuator Boards
   - OR: GUI → UDP → Actuator Boards (direct)

3. **State Machine**:
   - GUI → Elodin (STATE_TRANSITION command) → FSW PressureStateMachine

### Elodin Integration

The GUI uses Elodin as the primary communication channel:

- **Reads**: Sensor data (PT_DATA, TC_DATA, IMU_DATA)
- **Writes**: Commands (STATE_TRANSITION, ACTUATOR_COMMAND)
- **Queries**: Historical telemetry data

### State Machine States

Matches FSW `PressureStateMachine::SystemState`:

- `Idle` - System idle
- `Armed` - System armed
- `Fuel Fill` - Fuel tank filling
- `Ox Fill` - Oxidizer tank filling
- `GN2 Low Press` - GN2 low pressure pressurization
- `GN2 Vent` - GN2 venting
- `Fuel Press` - Fuel pressurization
- `Fuel Vent` - Fuel venting
- `Ox Press` - Oxidizer pressurization
- `Ox Vent` - Oxidizer venting
- `GN2 High Press` - GN2 high pressure pressurization
- `GN2 High Vent` - GN2 high venting
- `Vent` - General vent state
- `Calibrate` - Calibration state
- `Ready` - Ready for fire
- `Fire` - Fire state
- `Abort` - Abort state
- `Quick Fire` - Quick fire sequence
- `High Press` - High pressure state

## Troubleshooting

### Elodin Connection Failed

- Ensure Elodin database is running: `./scripts/startup/startup_daq_db.sh`
- Check Elodin is listening on `127.0.0.1:2240`
- GUI will fall back to UDP receiver if Elodin unavailable

### No Sensor Data

- Check DAQ bridge is running and receiving packets
- Verify network configuration (IP addresses, ports)
- Check Elodin database is receiving data
- Try UDP fallback mode

### State Transitions Not Working

- Verify FSW is reading commands from Elodin
- Check Elodin connection status in GUI
- Ensure state transition is allowed from current state

## Similar to DiabloAvionics GUI

This GUI is designed to match the functionality and layout of `external/DiabloAvionics/test_guis/combined_gui.py`:

- ✅ Same layout (sensor plot left, actuator control right)
- ✅ Same top bar with pressure gauges
- ✅ Same state machine button layout
- ✅ Same actuator control interface
- ✅ Enhanced with Elodin integration
- ✅ Integrated with FSW stack

## Future Enhancements

- Settings page for configuration
- Historical data replay
- Calibration interface
- Advanced plotting options
- Multi-board support
- Event logging and playback



