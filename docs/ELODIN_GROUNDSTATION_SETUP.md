# Elodin Groundstation Setup & Test Guide

Complete walkthrough for setting up and testing the Elodin-integrated groundstation with fake sensor data.

## 🎯 Overview

This setup validates the complete pipeline:
```
Groundstation GUI → Elodin DB → FSW Simulator → Elodin DB → GUI/Editor
```

**Key Components:**
1. **Elodin Database** - Central time-series database
2. **Fake Sensor Generator** - Sends PT/TC/RTD data to Elodin
3. **FSW Simulator** - Reads commands, writes telemetry
4. **Groundstation GUI** - Sends commands, displays telemetry
5. **Elodin Editor** - Visualizes all data

## 🚀 Quick Start (5 Terminals)

### Terminal 1: Start Elodin Database

```bash
cd /home/kush-mahajan/sensor_system
./scripts/test/test_elodin_groundstation.sh 2240 test_groundstation
```

This will:
- Start Elodin database on port 2240
- Create database at `~/.local/share/elodin/test_groundstation`
- Keep running until Ctrl+C

**Expected output:**
```
🧪 Elodin Groundstation Test Setup
===================================
Database: /home/kush-mahajan/.local/share/elodin/test_groundstation
Port: 2240

📊 Starting Elodin database...
✅ Elodin database started (PID: 12345)
```

### Terminal 2: Generate Fake Sensor Data

```bash
cd /home/kush-mahajan/sensor_system
./build/daq_comms/send_fake_pt 2240 1000
```

This sends 1000 fake PT messages to Elodin. For continuous streaming:

```bash
# Continuous streaming (send every 100ms)
while true; do
    ./build/daq_comms/send_fake_pt 2240 10
    sleep 1
done
```

**Expected output:**
```
🧪 Sending fake RawPTMessage to Elodin
===================================
DB: 127.0.0.1:2240
Messages: 1000

✅ Connected to Elodin DB
✅ Registered VTables
📤 Sending 1000 RawPTMessage(s)...
  Sent #1 (channel=0, adc=1000)
  Sent #2 (channel=1, adc=1010)
  ...
```

### Terminal 3: Start FSW Simulator (Optional)

If you have a FSW simulator that reads commands from Elodin:

```bash
cd /home/kush-mahajan/sensor_system
# Build the simulator
cmake --build build --target test_fsw_simulator

# Run it
./build/test_fsw_simulator 2240
```

**Expected output:**
```
🤖 FSW Simulator for Elodin Groundstation Test
================================================
DB: 127.0.0.1:2240
State: STANDBY

✅ Connected to Elodin DB
✅ Registered VTables
🔄 Starting simulation loop...
   - Polling for commands every 100ms
   - Writing engine status every 1s
```

**Note:** If you don't have a FSW simulator, the groundstation GUI can still send commands to Elodin, and you can verify they're being written using the Elodin editor.

### Terminal 4: Start Groundstation GUI

```bash
cd /home/kush-mahajan/sensor_system/groundstation
python3 ground_station_elodin_gui.py
```

**GUI Usage:**
1. **Connect**: Enter `127.0.0.1` and `2240`, click "Connect to Elodin"
2. **Send Commands**: 
   - Click state buttons (STANDBY, IGNITION, etc.)
   - Use thrust slider and "Set Thrust" button
   - Click "ABORT" for emergency stop
3. **View Telemetry**: 
   - Live plots update automatically
   - Status panel shows current state
   - Event log shows all commands

**Expected output:**
```
✅ Connected to Elodin DB at 127.0.0.1:2240
📤 Sent command to Elodin: ENGINE_START
📤 Sent command to Elodin: SET_THRUST
```

### Terminal 5: Open Elodin Editor

```bash
elodin editor ~/.local/share/elodin/test_groundstation
```

This opens the Elodin editor where you can:
- View all sensor data in real-time
- See command messages
- Query historical data
- Export data for analysis

## 📊 Data Flow Validation

### 1. Verify Sensor Data is Flowing

**In Elodin Editor:**
- Open the database
- Look for `RAWPTPESSAGE` table
- You should see data points appearing in real-time
- Check timestamps are increasing

**In Groundstation GUI:**
- Telemetry plots should update
- Pressure values should be visible
- Status panel shows sensor data

### 2. Verify Commands are Being Written

**Send a command from GUI:**
- Click "Start Engine" button
- Check GUI event log: "📤 Commanded state: PRE_IGNITION"

**In Elodin Editor:**
- Query: `SELECT * FROM commands ORDER BY timestamp DESC LIMIT 10`
- Should see command messages with type "ENGINE_START"

**In FSW Simulator (if running):**
- Should see: "📥 Executing command: ENGINE_START"
- State should transition

### 3. Verify Telemetry is Being Written

**In Elodin Editor:**
- Check `ENGINE_STATUS` table (if FSW simulator is running)
- Should see state and thrust values updating

**In Groundstation GUI:**
- Status panel should show current engine state
- Thrust display should update

## 🧪 Test Scenarios

### Test 1: Basic Command Flow

```
1. Start Elodin DB (Terminal 1)
2. Start Groundstation GUI (Terminal 4)
3. Connect GUI to Elodin
4. Click "Start Engine" button
5. Verify in Elodin Editor: command appears in database
6. Verify in GUI: event log shows command sent
```

**Expected Result:** Command appears in Elodin database within 100ms

### Test 2: Sensor Data Streaming

```
1. Start Elodin DB (Terminal 1)
2. Start Fake Sensor Generator (Terminal 2)
3. Open Elodin Editor (Terminal 5)
4. Watch RAWPTPESSAGE table
```

**Expected Result:** Data points appear continuously, timestamps increasing

### Test 3: End-to-End Pipeline

```
1. Start Elodin DB (Terminal 1)
2. Start Fake Sensor Generator (Terminal 2) - continuous
3. Start FSW Simulator (Terminal 3)
4. Start Groundstation GUI (Terminal 4)
5. Open Elodin Editor (Terminal 5)

Test sequence:
- Send "Start Engine" command from GUI
- Verify FSW simulator receives command
- Verify engine status updates in Elodin
- Verify GUI displays updated state
- Verify Elodin Editor shows all data
```

**Expected Result:** Complete round-trip: GUI → Elodin → FSW → Elodin → GUI/Editor

### Test 4: State Machine Control

```
1. All components running
2. Send state transitions from GUI:
   - STANDBY → PRE_IGNITION
   - PRE_IGNITION → IGNITION
   - IGNITION → STARTUP
   - STARTUP → STEADY_STATE
3. Verify state changes in:
   - FSW Simulator console
   - GUI status panel
   - Elodin Editor (query ENGINE_STATUS)
```

**Expected Result:** State transitions visible in all components

## 🔍 Debugging

### Check Elodin Connection

```bash
# Test TCP connection
telnet 127.0.0.1 2240

# Check if database exists
ls -la ~/.local/share/elodin/test_groundstation/
```

### Check Command Flow

**In Groundstation GUI:**
- Enable debug logging (if available)
- Check event log for command send confirmations

**In Elodin Editor:**
```sql
-- Query recent commands
SELECT * FROM commands ORDER BY timestamp DESC LIMIT 10;

-- Count commands
SELECT COUNT(*) FROM commands;
```

### Check Telemetry Flow

**In Elodin Editor:**
```sql
-- Query sensor data
SELECT * FROM RAWPTPESSAGE ORDER BY timestamp DESC LIMIT 100;

-- Check data rate
SELECT COUNT(*), MIN(timestamp), MAX(timestamp) 
FROM RAWPTPESSAGE;
```

### Common Issues

**Issue: GUI can't connect to Elodin**
- Check Elodin DB is running: `ps aux | grep elodin-db`
- Check port is correct: `netstat -tuln | grep 2240`
- Check firewall isn't blocking

**Issue: Commands not appearing in Elodin**
- Check GUI connection status (should be green)
- Check Elodin DB logs: `tail -f /tmp/elodin_db.log`
- Verify packet format matches Elodin protocol

**Issue: Sensor data not appearing**
- Check fake sensor generator is running
- Verify VTables are registered (check generator output)
- Check Elodin Editor is connected to correct database

**Issue: FSW simulator not receiving commands**
- Verify FSW simulator is polling Elodin (check console output)
- Check command packet_id matches what FSW expects
- Verify command format matches FSW's parser

## 📈 Performance Validation

### Data Rate Test

```bash
# Send high-rate data
./build/daq_comms/send_fake_pt 2240 10000

# Monitor Elodin performance
# Check Elodin Editor: data should appear smoothly
# Check GUI: plots should update without lag
```

### Command Latency Test

1. Send command from GUI
2. Measure time until:
   - Command appears in Elodin (query database)
   - FSW simulator receives command (check console)
   - Response appears in Elodin

**Expected:** < 200ms end-to-end latency

## ✅ Success Criteria

Your setup is working correctly if:

✅ **Sensor Data:**
- Fake sensor generator sends data to Elodin
- Data appears in Elodin Editor
- GUI displays live plots

✅ **Commands:**
- GUI sends commands to Elodin
- Commands appear in Elodin database
- FSW simulator receives and executes commands (if running)

✅ **Telemetry:**
- FSW simulator writes status to Elodin
- Status appears in Elodin Editor
- GUI displays current state

✅ **End-to-End:**
- Complete round-trip works
- All data persists in Elodin
- Historical queries work
- Multiple clients can connect

## 🎓 Next Steps

Once basic setup works:

1. **Add More Sensor Types:**
   - Extend fake generator to send TC, RTD, IMU data
   - Register additional VTables
   - Add plots to GUI

2. **Implement Real FSW Integration:**
   - Replace simulator with actual FSW
   - Use ElodinCommandHandler in FSW
   - Connect real sensors

3. **Add Advanced Features:**
   - Historical data playback
   - Data export
   - Custom dashboards
   - Multi-mission support

## 📚 Related Documentation

- `groundstation/ELODIN_INTEGRATION_GUIDE.md` - Detailed Elodin integration
- `groundstation/README_GROUND_STATION_GUI.md` - GUI documentation
- `daq_comms/test/send_fake_pt.cpp` - Fake sensor generator source
- Elodin documentation: https://elodin.dev

---

**Ready to test! 🚀**

