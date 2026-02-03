# Ground Station GUI - Bidirectional FSW Control

## Overview

The Ground Station GUI provides **bidirectional communication** with the Diablo Flight Software:

```
┌─────────────────────────┐         ┌──────────────────────────┐
│   Ground Station GUI    │         │    Flight Software       │
│      (Python/PyQt6)     │         │      (C++ FSW)           │
├─────────────────────────┤         ├──────────────────────────┤
│                         │         │                          │
│  📤 COMMANDS            │─────────▶│  📥 Command Handler      │
│  ─────────────────      │  TCP    │  ──────────────────      │
│  • State transitions    │  :2241  │  • State machine         │
│  • Engine control       │         │  • Engine controller     │
│  • Valve actuation      │         │  • Valve controller      │
│  • Abort/E-Stop         │         │  • Safety systems        │
│                         │         │                          │
│  📥 TELEMETRY           │◀─────────│  📤 Telemetry Sender     │
│  ─────────────────      │  TCP    │  ──────────────────      │
│  • Sensor data          │  :2242  │  • PT, TC, IMU sensors   │
│  • Engine status        │         │  • Engine state          │
│  • System health        │         │  • System diagnostics    │
│  • Safety alerts        │         │  • Heartbeat             │
│                         │         │                          │
└─────────────────────────┘         └──────────────────────────┘
```

## Features

### Downstream Commands (GUI → FSW)

1. **State Machine Control**
   - Transition between engine states (STANDBY → IGNITION → STEADY_STATE → SHUTDOWN)
   - Emergency ABORT
   - Emergency SHUTDOWN (E-STOP)

2. **Engine Control**
   - Start/Stop engine
   - Thrust command (0-100%)
   - Mixture ratio command (O/F ratio)

3. **Valve Control**
   - Position control for all valves (0-100%)
   - Rate-limited actuation
   - Emergency close

4. **Configuration**
   - Update system parameters
   - Calibration commands

### Upstream Telemetry (FSW → GUI)

1. **Real-time Sensor Data**
   - Pressure transducers (PT1-PT16)
   - Thermocouples (TC1-TC8)
   - IMU data (accel, gyro)
   - GPS position/velocity

2. **Engine Status**
   - Current state
   - Thrust output
   - Mixture ratio
   - Performance metrics

3. **System Health**
   - Component status
   - Safety interlock states
   - Fault reports

4. **Live Plotting**
   - Real-time pressure plots
   - Temperature trends
   - Thrust performance

## Installation

### Prerequisites

```bash
# Python dependencies
pip install PyQt6 pyqtgraph numpy

# C++ dependencies (for FSW side)
# - C++17 compiler
# - POSIX sockets (Linux/macOS)
```

### Setup

1. **Build FSW with Ground Station Interface**

```bash
cd /home/kushmahajan/Diablo-FSW
mkdir -p build && cd build
cmake .. -DENABLE_GROUND_STATION=ON
make
```

2. **Launch FSW with Ground Station Server**

```bash
# In your FSW main.cpp, add:
# #include "GroundStationInterface.hpp"
# 
# GroundStationInterface::Config gs_config;
# gs_config.command_port = 2241;
# gs_config.telemetry_port = 2242;
# auto gs_interface = std::make_shared<GroundStationInterface>(gs_config);
# gs_interface->initialize();
# gs_interface->start();

./your_fsw_executable
```

3. **Launch Ground Station GUI**

```bash
cd /home/kushmahajan/Diablo-FSW/groundstation
python3 ground_station_gui.py
```

## Usage

### Connecting to FSW

1. Enter FSW IP address (default: 127.0.0.1 for local testing)
2. Enter command port (default: 2241)
3. Click "Connect to FSW"
4. Status should change to "Connected" (green)

### Sending Commands

#### State Machine Transitions

```
INITIALIZATION → STANDBY → PRE-IGN CHECKS → IGNITION PREP → 
START IGNITION → STEADY STATE → SHUTDOWN
```

Click the state buttons in the State Machine panel to command transitions.

#### Engine Control

1. **Thrust Control**
   - Move slider to set desired thrust percentage
   - Value sent immediately when slider is released

2. **Mixture Ratio**
   - Adjust slider to set O/F ratio (1.0 - 4.0)

3. **Start/Stop**
   - Click "Start Engine" to begin engine sequence
   - Click "Stop Engine" for controlled shutdown

#### Valve Control

Each valve has:
- Position slider (0-100%)
- Current position display
- "Set" button to send command

#### Emergency Controls

⚠️ **ABORT** - Initiates emergency abort sequence (reversible)
🛑 **E-STOP** - Emergency shutdown (immediate valve closure)

### Monitoring Telemetry

#### Status Display

Real-time display of:
- Current engine state
- Thrust output
- Chamber pressure
- Chamber temperature

#### Live Plots

Three plot tabs:
1. **Pressure** - All PT sensors
2. **Temperature** - All TC sensors  
3. **Thrust** - Engine performance

#### Event Log

Scrolling log of all:
- Commands sent
- Status updates
- Warnings/errors

## Integration with FSW

### C++ Side (FSW)

Add to your FSW `main.cpp`:

```cpp
#include "GroundStationInterface.hpp"

int main() {
    // ... existing FSW initialization ...
    
    // Create ground station interface
    GroundStationInterface::Config gs_config;
    gs_config.command_port = 2241;
    gs_config.telemetry_port = 2242;
    
    auto gs_interface = std::make_shared<GroundStationInterface>(gs_config);
    
    if (!gs_interface->initialize()) {
        std::cerr << "Failed to initialize ground station interface" << std::endl;
        return 1;
    }
    
    // Register command handlers
    gs_interface->registerCommandHandler(
        GroundStationInterface::CommandType::ENGINE_START,
        [&](const GroundStationInterface::Command& cmd) {
            std::cout << "Starting engine..." << std::endl;
            // Call your engine start function
            // engine_controller->start();
            return true;
        }
    );
    
    gs_interface->registerCommandHandler(
        GroundStationInterface::CommandType::ENGINE_ABORT,
        [&](const GroundStationInterface::Command& cmd) {
            std::cout << "ABORT!" << std::endl;
            // Call your abort function
            // state_machine->requestAbort("Ground station command");
            return true;
        }
    );
    
    // Start ground station interface
    gs_interface->start();
    
    // Main FSW loop
    while (running) {
        // ... your FSW logic ...
        
        // Send telemetry to ground station
        std::map<std::string, double> sensor_data;
        sensor_data["PT1_pressure"] = getPT1Pressure();
        sensor_data["PT2_pressure"] = getPT2Pressure();
        sensor_data["TC1_temperature"] = getTC1Temperature();
        // ... more sensors ...
        
        gs_interface->sendSensorData(sensor_data);
        
        std::map<std::string, double> engine_status;
        engine_status["state"] = static_cast<double>(current_engine_state);
        engine_status["thrust"] = current_thrust;
        engine_status["mixture_ratio"] = current_mixture_ratio;
        
        gs_interface->sendEngineStatus(engine_status);
        
        std::this_thread::sleep_for(std::chrono::milliseconds(100)); // 10 Hz
    }
    
    gs_interface->stop();
    return 0;
}
```

### Using the Bridge Helper

For easier integration:

```cpp
#include "GroundStationInterface.hpp"

// Create bridge
auto gs_interface = std::make_shared<GroundStationInterface>(gs_config);
gs_interface->initialize();
gs_interface->start();

FSWGroundStationBridge bridge(gs_interface);

// Setup handlers (connects to your FSW components)
bridge.setupStateMachineHandlers(/* your state machine */);
bridge.setupEngineControlHandlers(/* your engine controller */);
bridge.setupValveControlHandlers(/* your valve controller */);

// Start automatic telemetry streaming at 10 Hz
bridge.startTelemetryStreaming(std::chrono::milliseconds(100));

// In your FSW loop, just update data:
while (running) {
    // Collect latest data
    std::map<std::string, double> sensor_data = collectSensorData();
    std::map<std::string, double> engine_status = getEngineStatus();
    std::map<std::string, double> system_health = getSystemHealth();
    
    // Update bridge (it will stream automatically)
    bridge.updateSensorTelemetry(sensor_data);
    bridge.updateEngineStatus(engine_status);
    bridge.updateSystemHealth(system_health);
    
    // Your control loop
    // ...
}

bridge.stopTelemetryStreaming();
```

## Protocol Specification

### Message Format

All messages use binary packet format:

```
[Header (8 bytes)] [Payload (variable)]

Header:
  - packet_length (4 bytes, uint32): Total packet length including header
  - message_type (1 byte, uint8): Message type enum
  - priority (1 byte, uint8): Priority level (0=CRITICAL, 1=HIGH, 2=NORMAL, 3=LOW)
  - sequence/reserved (2 bytes, uint16): Sequence number or reserved

Payload:
  - JSON-encoded data
```

### Command Message (Ground Station → FSW)

```json
{
  "command_type": 3,
  "parameters": {
    "thrust_percent": 75.0,
    "mixture_ratio": 2.5
  },
  "timestamp": 1738627200.123,
  "command_id": 42,
  "requires_confirmation": true
}
```

### Telemetry Message (FSW → Ground Station)

```json
{
  "timestamp": 1738627200.456,
  "data": {
    "PT1_pressure": 450.3,
    "PT2_pressure": 448.7,
    "TC1_temperature": 523.1,
    "engine_state": 10,
    "thrust_actual": 12500.5
  }
}
```

## Port Configuration

| Port | Purpose | Protocol | Direction |
|------|---------|----------|-----------|
| 2241 | Commands | TCP | GUI → FSW |
| 2242 | Telemetry | TCP | FSW → GUI |

**Note**: TCP is used for reliability. For high-frequency telemetry (>100 Hz), consider UDP with sequence numbers.

## Safety Features

### Command Validation

All commands are validated before execution:
- ✅ Timestamp check (reject stale commands)
- ✅ Parameter range validation
- ✅ State machine interlock checks
- ✅ Safety system approval

### Confirmation Required

Critical commands require confirmation:
- Engine start/stop
- State transitions
- Configuration changes

Non-critical commands execute immediately:
- ABORT (immediate)
- E-STOP (immediate)
- Heartbeat (automatic)

### Heartbeat Monitoring

- FSW sends heartbeat every 1 second
- GUI monitors heartbeat
- Alert if heartbeat lost for >3 seconds

## Troubleshooting

### "Connection Refused"

**Problem**: Cannot connect to FSW

**Solutions**:
1. Check FSW is running with ground station interface enabled
2. Verify ports 2241, 2242 are not blocked by firewall
3. Check IP address (use `127.0.0.1` for local testing)
4. Ensure FSW called `gs_interface->start()`

### "No Telemetry Received"

**Problem**: Connected but no data displayed

**Solutions**:
1. Verify FSW is calling `sendSensorData()` / `sendEngineStatus()`
2. Check telemetry port (2242) is connected
3. Look at FSW console for telemetry send messages
4. Check for socket errors in GUI event log

### "Commands Not Executed"

**Problem**: Commands sent but FSW doesn't respond

**Solutions**:
1. Verify command handlers are registered in FSW
2. Check FSW command processing thread is running
3. Look for validation errors in FSW console
4. Ensure state machine allows requested transition

### "GUI Freezes"

**Problem**: GUI becomes unresponsive

**Solutions**:
1. Check network connection (lost connection can block GUI)
2. Reduce telemetry rate if too high
3. Clear event log if too large
4. Restart GUI

## Advanced Configuration

### Custom Ports

```python
# In ground_station_gui.py, modify:
self.protocol = FSWCommunicationProtocol(
    fsw_host="192.168.1.100",  # Remote FSW IP
    command_port=3000,          # Custom command port
    telemetry_port=3001         # Custom telemetry port
)
```

```cpp
// In FSW:
GroundStationInterface::Config gs_config;
gs_config.command_port = 3000;
gs_config.telemetry_port = 3001;
```

### High-Frequency Telemetry

For rates >100 Hz, consider UDP telemetry:

```cpp
// Modify GroundStationInterface to use UDP for telemetry
gs_config.telemetry_protocol = ProtocolType::UDP_TELEMETRY;
```

### Multiple Ground Stations

FSW supports multiple simultaneous ground station connections:

```cpp
gs_config.max_clients = 5;  // Allow up to 5 ground stations
```

## Future Enhancements

- [ ] Add Elodin database integration for historical data playback
- [ ] Add voice alerts for critical events
- [ ] Add flight trajectory visualization
- [ ] Add camera feed integration
- [ ] Add test sequence scripting
- [ ] Add data recording/playback
- [ ] Add custom dashboard layouts
- [ ] Add mobile app support

## Contributing

To add new commands:

1. Add to `CommandType` enum in both Python and C++
2. Add command handler in FSW
3. Add GUI button/control in ground_station_gui.py

To add new telemetry:

1. Add to `MessageType` enum
2. Add telemetry update in FSW loop
3. Add display widget in GUI

## License

Part of Diablo FSW project.

