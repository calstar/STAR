# Quick Start: Ground Station GUI

## 🚀 Get Up and Running in 5 Minutes

### Step 1: Install Python Dependencies

```bash
pip3 install PyQt6 pyqtgraph numpy
```

### Step 2: Build the Example FSW Program

```bash
cd /home/kushmahajan/Diablo-FSW
mkdir -p build && cd build

# Build the ground station example
g++ -std=c++17 -pthread \
    ../FSW/examples/ground_station_integration_example.cpp \
    ../FSW/comms/src/GroundStationInterface.cpp \
    -I../FSW/comms/include \
    -I../utl \
    -o gs_example

# Or if you have CMake setup:
# cmake .. -DBUILD_EXAMPLES=ON
# make gs_example
```

### Step 3: Launch FSW Example

Terminal 1:
```bash
cd /home/kushmahajan/Diablo-FSW/build
./gs_example
```

You should see:
```
==================================================
  Diablo FSW - Ground Station Integration Demo
==================================================

✅ Ground Station Interface started successfully
   Waiting for ground station connections...
   Command port: 2241
   Telemetry port: 2242

💡 Launch ground_station_gui.py to connect
   Press Ctrl+C to exit
```

### Step 4: Launch Ground Station GUI

Terminal 2:
```bash
cd /home/kushmahajan/Diablo-FSW/groundstation
./launch_ground_station.sh

# Or directly:
# python3 ground_station_gui.py
```

### Step 5: Connect and Control

In the GUI:

1. **Connect**
   - Click "Connect to FSW"
   - Status should turn green: "Connected"

2. **Watch Telemetry**
   - Real-time sensor data streaming
   - Pressure plots updating
   - Temperature plots updating
   - Engine status displayed

3. **Send Commands**
   - Click "STANDBY" → FSW transitions to STANDBY state
   - Click "START IGNITION" → FSW starts ignition sequence
   - Move thrust slider → FSW updates thrust
   - Click valve "Set" buttons → FSW moves valves

4. **Emergency Controls**
   - Click "⚠️ ABORT" → FSW initiates abort sequence
   - Click "🛑 E-STOP" → FSW emergency shutdown

## 🎯 What You Should See

### FSW Terminal
```
→ Transitioned to STANDBY
📥 ENGINE START command received
✅ Transitioning to IGNITION_SEQUENCE
→ Transitioned to STEADY_STATE
📥 SET THRUST command: 75.0%
📥 VALVE CONTROL command: valve=0 position=50%
```

### GUI Display
```
┌─────────────────────────────────────────┐
│ Status: Connected                        │
│ Engine: STEADY_STATE                     │
│ Thrust: 11250.5 N                       │
│ Chamber: 825.3 PSI                      │
│ Chamber Temp: 523.1 °C                  │
└─────────────────────────────────────────┘

[Live Plots Updating with Real Data]

Event Log:
[12:34:56.123] ✅ Connected to FSW
[12:35:02.456] 📤 Commanded state transition: STANDBY
[12:35:08.789] 🚀 Engine start commanded
[12:35:15.234] 🔧 Valve 0 commanded to 50%
```

## 🧪 Test Scenarios

### Test 1: Basic State Transitions

1. Connect GUI to FSW
2. Click states in order: STANDBY → PRE-IGN CHECKS → IGNITION PREP → START IGNITION
3. Watch FSW console confirm each transition
4. Click SHUTDOWN
5. Confirm return to STANDBY

### Test 2: Thrust Control

1. Ensure engine in STEADY_STATE
2. Move thrust slider to 25%
3. Watch chamber pressure increase in GUI
4. Move thrust slider to 75%
5. Watch chamber pressure increase further
6. Set thrust to 0%
7. Watch chamber pressure decrease

### Test 3: Valve Control

1. Set valve 0 (LOX Main) to 50%
2. Set valve 1 (Fuel Main) to 50%
3. Confirm FSW reports valve positions
4. Set both valves to 100%
5. Set both valves back to 0%

### Test 4: Emergency Procedures

1. Click "⚠️ ABORT"
2. Confirm FSW enters ABORT state
3. Confirm thrust goes to 0
4. Confirm all valves close
5. Reconnect and test E-STOP

## 📊 Expected Performance

| Metric | Value |
|--------|-------|
| Telemetry Rate | 10 Hz (100ms interval) |
| Command Latency | <10ms (local), <100ms (network) |
| GUI Update Rate | 10 Hz |
| Heartbeat Interval | 1 second |
| Max Clients | 5 simultaneous |

## 🔧 Troubleshooting

### "Address already in use"

**Problem**: Port 2241 or 2242 already in use

**Solution**:
```bash
# Find and kill process using port
lsof -ti:2241 | xargs kill -9
lsof -ti:2242 | xargs kill -9

# Or change ports in code
```

### GUI shows "Connection Refused"

**Problem**: FSW not running or ports blocked

**Solution**:
1. Check FSW is running: `ps aux | grep gs_example`
2. Check ports are listening: `netstat -an | grep 2241`
3. Check firewall: `sudo ufw allow 2241` (if using UFW)

### No telemetry data displayed

**Problem**: Telemetry port not connected

**Solution**:
1. Check FSW console for "Ground station connected" message
2. Restart GUI
3. Check GUI event log for socket errors

### Commands not executing

**Problem**: Command handlers not registered or validation failing

**Solution**:
1. Check FSW console for command validation errors
2. Verify timestamp in commands is recent
3. Check state machine allows requested transition

## 🎓 Next Steps

### Integrate with Your FSW

Replace the example with your actual FSW components:

```cpp
// In your main.cpp:
#include "GroundStationInterface.hpp"

// Create interface
auto gs_interface = std::make_shared<GroundStationInterface>(gs_config);
gs_interface->initialize();
gs_interface->start();

// Register YOUR command handlers
gs_interface->registerCommandHandler(
    GroundStationInterface::CommandType::ENGINE_START,
    [&](const auto& cmd) {
        return your_engine_controller->start();
    }
);

// Send YOUR telemetry
while (running) {
    auto sensor_data = your_sensor_system->getAllData();
    gs_interface->sendSensorData(sensor_data);
    
    auto engine_status = your_engine_controller->getStatus();
    gs_interface->sendEngineStatus(engine_status);
    
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
}
```

### Add Custom Commands

1. **Add to Python GUI** (`ground_station_gui.py`):
```python
class CommandType(Enum):
    # ... existing commands ...
    YOUR_CUSTOM_COMMAND = 10

# Add button in GUI
self.custom_btn = QtWidgets.QPushButton("Your Action")
self.custom_btn.clicked.connect(self._send_custom_command)

def _send_custom_command(self):
    command = Command(
        command_type=CommandType.YOUR_CUSTOM_COMMAND,
        parameters={'param1': 123.0},
        timestamp=time.time(),
        command_id=0
    )
    self.protocol.send_command(command)
```

2. **Add to C++ FSW** (`GroundStationInterface.hpp`):
```cpp
enum class CommandType {
    // ... existing commands ...
    YOUR_CUSTOM_COMMAND = 10
};

// In main:
gs_interface->registerCommandHandler(
    GroundStationInterface::CommandType::YOUR_CUSTOM_COMMAND,
    [](const Command& cmd) {
        // Your handler code
        return true;
    }
);
```

### Add Custom Telemetry

1. **Generate data in FSW**:
```cpp
std::map<std::string, double> custom_data;
custom_data["your_metric_1"] = 123.45;
custom_data["your_metric_2"] = 678.90;
gs_interface->sendSensorData(custom_data);
```

2. **Display in GUI**:
```python
def _update_telemetry_display(self, telemetry: TelemetryData):
    if 'your_metric_1' in telemetry.data:
        value = telemetry.data['your_metric_1']
        self.your_display_label.setText(f"Your Metric: {value:.2f}")
```

## 📚 Additional Resources

- **Full Documentation**: `groundstation/README_GROUND_STATION_GUI.md`
- **Protocol Specification**: See README for message format details
- **Example Code**: `FSW/examples/ground_station_integration_example.cpp`
- **Header Files**:
  - `FSW/comms/include/GroundStationInterface.hpp`
  - `FSW/comms/include/CommunicationProtocol.hpp`

## 🆘 Getting Help

If you encounter issues:

1. Check FSW console output for error messages
2. Check GUI event log for connection/communication errors
3. Verify network connectivity: `ping 127.0.0.1`
4. Check firewall settings
5. Review example code for correct usage patterns
6. Enable debug logging in both FSW and GUI

## 🎉 Success!

If you see:
- ✅ GUI connected (green status)
- ✅ Telemetry streaming (plots updating)
- ✅ Commands executing (FSW responding)
- ✅ State transitions working (engine state changing)

**Congratulations!** Your ground station GUI is fully operational and communicating bidirectionally with your FSW.

---

**Happy Commanding! 🚀**

