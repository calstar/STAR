# Quick Start: Elodin Groundstation Test

## 🚀 5-Terminal Setup (Copy-Paste Ready)

### Terminal 1: Elodin Database
```bash
cd /home/kush-mahajan/sensor_system
./scripts/test/test_elodin_groundstation.sh 2240 test_groundstation
```

### Terminal 2: Fake Sensor Data
```bash
cd /home/kush-mahajan/sensor_system
./build/daq_comms/send_fake_pt 2240 1000
# Or continuous: while true; do ./build/daq_comms/send_fake_pt 2240 10; sleep 1; done
```

### Terminal 3: FSW Simulator
```bash
cd /home/kush-mahajan/sensor_system
cmake --build build --target test_fsw_simulator
./build/test_fsw_simulator 2240
```

### Terminal 4: Groundstation GUI
```bash
cd /home/kush-mahajan/sensor_system/groundstation
python3 ground_station_elodin_gui.py
```
**In GUI:** Connect to `127.0.0.1:2240`, then send commands!

### Terminal 5: Elodin Editor
```bash
elodin editor ~/.local/share/elodin/test_groundstation
```

## ✅ Validation Checklist

- [ ] Elodin DB running (Terminal 1 shows "✅ Elodin database started")
- [ ] Sensor data flowing (Terminal 2 sending messages)
- [ ] FSW simulator running (Terminal 3 shows "✅ Connected")
- [ ] GUI connected (Terminal 4 shows green "Connected" status)
- [ ] Elodin Editor open (Terminal 5 shows database)

## 🧪 Test Commands

**In Groundstation GUI:**
1. Click "Start Engine" → Check Terminal 3 for command execution
2. Set thrust slider to 50% → Check Terminal 3 for thrust update
3. Click "ABORT" → Check Terminal 3 for abort command

**In Elodin Editor:**
- Query: `SELECT * FROM commands ORDER BY timestamp DESC LIMIT 10`
- View: `RAWPTPESSAGE` table for sensor data
- View: `ENGINE_STATUS` table for state/thrust

## 📊 Expected Flow

```
GUI sends command → Elodin DB → FSW Simulator receives → 
FSW writes status → Elodin DB → GUI displays update
```

All data visible in Elodin Editor!

## 🐛 Troubleshooting

**Can't connect?**
- Check Elodin DB is running: `ps aux | grep elodin-db`
- Check port: `netstat -tuln | grep 2240`

**No data?**
- Verify VTables registered (check Terminal 2 output)
- Check Elodin DB logs: `tail -f /tmp/elodin_db.log`

**Commands not working?**
- Verify GUI is connected (green status)
- Check FSW simulator is polling (Terminal 3 output)

---

**Full docs:** `docs/ELODIN_GROUNDSTATION_SETUP.md`

