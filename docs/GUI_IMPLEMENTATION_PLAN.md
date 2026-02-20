# FSW GUI Implementation Plan

## Overview
Create a GUI similar to DiabloAvionics `combined_gui.py` but integrated with the FSW stack, including state machine control.

## Components Needed

### 1. Top Bar Widget
- **Pressure Gauges**: GN2 (green), ETH (red), LOX (blue) - vertical bars
- **Abort Buttons**: ABORT (orange), EMERGENCY ABORT (red)
- **Settings Button**: Navigate to settings page
- **Current State Display**: Shows current state machine state (e.g., "CURRENT STATE: Idle")

### 2. State Machine Control Panel
- **State Buttons** (matching FSW PressureStateMachine):
  - Row 1: Idle, Armed, Fuel Fill, Ox Fill, Quick Fire, GN2 Press, Fuel Press
  - Row 2: Fuel Vent, Ox Press, Ox Vent, High Press, GN2 Vent, Fire, Vent
- **Button Behavior**: 
  - Highlight active state
  - Enable/disable based on allowed transitions
  - Send state transition commands to FSW

### 3. Sensor Plot Widget (Left 66%)
- **Real-time Pressure Plots**: Multiple colored lines for different sensors
- **Statistics Panel**: Network stats, sensor readings
- **Auto-scale Toggle**: Y-axis auto-scaling
- **Save Buttons**: Save pressures CSV, Save events CSV

### 4. Actuator Control Widget (Right 33%)
- **2x5 Grid**: 10 actuators with ON/OFF buttons
- **Voltage Display**: Show current voltage readings
- **Actuator Labels**: Customizable labels per actuator
- **State Highlighting**: Highlight active state (ON/OFF)

### 5. Settings Page
- **Sensor Settings**: Labels, calibration, mappings
- **Actuator Settings**: Labels, IP/port configuration
- **Display Settings**: Y-axis limits, window size, colors
- **Network Settings**: Actuator IP, ports, bind address

## Integration Points

### With FSW Stack:
1. **Elodin Database**: Read sensor data from Elodin channels
2. **PressureStateMachine**: Send state transition commands
3. **Actuator Commands**: Send UDP commands to actuator board
4. **Board Discovery**: Display discovered boards and sensors

### Network Communication:
- **UDP Receiver**: Listen on port 5006 for sensor data packets
- **UDP Sender**: Send actuator commands to board IP:5005
- **State Commands**: Send state transitions via Elodin or direct UDP

## File Structure

```
scripts/gui/
├── combined_fsw_gui.py          # Main GUI application
├── widgets/
│   ├── top_bar_widget.py        # Top bar with gauges and abort
│   ├── sensor_plot_widget.py    # Sensor data visualization
│   ├── actuator_control_widget.py  # Actuator ON/OFF controls
│   ├── state_machine_widget.py  # State machine buttons
│   └── settings_widget.py       # Settings page
├── fsw_integration/
│   ├── elodin_client.py         # Elodin database client
│   ├── state_machine_client.py  # FSW state machine interface
│   └── actuator_client.py       # Actuator command sender
└── fsw_gui_config.json          # Configuration file
```

## Implementation Steps

1. ✅ Create base structure and UDP receiver
2. ⏳ Create top bar widget with pressure gauges
3. ⏳ Create sensor plot widget
4. ⏳ Create actuator control widget
5. ⏳ Create state machine control widget
6. ⏳ Create settings widget
7. ⏳ Integrate with Elodin database
8. ⏳ Connect to FSW PressureStateMachine
9. ⏳ Add state transition logic
10. ⏳ Testing and refinement

## State Machine Integration

The GUI needs to:
1. **Query Current State**: Get current state from PressureStateMachine
2. **Get Allowed Transitions**: Query which states can be transitioned to
3. **Send Transitions**: Send state transition requests
4. **Monitor State Changes**: Update UI when state changes
5. **Handle Abort**: Immediately transition to ABORT state

## Next Steps

1. Complete the base GUI file with all widgets
2. Add Elodin integration for sensor data
3. Add state machine command interface
4. Test with real sensor data
5. Refine UI/UX based on feedback



