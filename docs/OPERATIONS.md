# Operations Guide - DAQ Sensor System

## Pre-Flight Checklist

### 1. Start Elodin Database

```bash
elodin-db /tmp/elodin_test_db 2240
```

Verify it's running:
```bash
ps aux | grep elodin-db
```

### 2. Start DAQ Bridge

```bash
./build/daq_bridge 0.0.0.0 8888 127.0.0.1 2240 config/sensor_routing.toml
```

Or use the simulated stack script:
```bash
./scripts/run_simulated_stack.sh
```

### 3. Verify Sensor Data Flow

Open Elodin editor:
```bash
elodin editor /tmp/elodin_test_db
```

Check that sensor tables are updating:
- `pt_chamber_raw`
- `pt_fuel_inlet_raw`
- `tc_exhaust_raw`
- `rtd_fuel_raw`
- `lc_thrust_raw`

### 4. Verify Embedded Connection

Check DAQ bridge logs for:
- "Frames decoded" count increasing
- No "Frames dropped" or "Decryption failures"
- "Messages published" count matches sensor count

## During Operation

### Monitoring

Watch DAQ bridge output for:
- Frame decode statistics (every 10 seconds)
- Publish failures (should be 0)
- Sequence gaps (indicates packet loss)

### Troubleshooting

**No data in Elodin:**
1. Check embedded system is sending packets: `tcpdump -i any -n udp port 8888`
2. Verify DAQ bridge is receiving: Check logs for "Frames decoded"
3. Verify routing config matches embedded channel IDs

**High packet loss:**
1. Check network connection between embedded and groundstation
2. Verify UDP port is not blocked by firewall
3. Check embedded system is not dropping packets

**Elodin connection lost:**
1. Restart Elodin database: `pkill -f elodin-db && elodin-db /tmp/elodin_test_db 2240`
2. Restart DAQ bridge (it will reconnect automatically)

## Post-Flight

### Data Export

Elodin data is stored in the database file (`/tmp/elodin_test_db`). Export using Elodin tools:

```bash
elodin export /tmp/elodin_test_db --format csv --output flight_data.csv
```

### Shutdown

```bash
# Stop DAQ bridge
pkill -f daq_bridge

# Stop Elodin database (saves data)
pkill -f elodin-db
```

## Configuration

### Sensor Routing

Edit `config/sensor_routing.toml` to add/remove sensors or change table mappings.

### Network Settings

Default ports:
- UDP receive: 8888
- Elodin DB: 2240

Change in command line arguments or update scripts.

## Emergency Procedures

### Complete System Restart

```bash
# Kill all processes
pkill -f elodin-db
pkill -f daq_bridge

# Wait 2 seconds
sleep 2

# Restart
elodin-db /tmp/elodin_test_db 2240 &
sleep 2
./build/daq_bridge 0.0.0.0 8888 127.0.0.1 2240 config/sensor_routing.toml &
```

### Data Recovery

If Elodin database becomes corrupted:
1. Check for backup files: `ls -la /tmp/elodin_test_db*`
2. Restore from backup if available
3. If no backup, data may be lost (consider adding backup automation)

## Future Enhancements

- [ ] Automatic backup of Elodin database
- [ ] Health monitoring and alerting
- [ ] Remote monitoring dashboard
- [ ] Automatic restart on failure
- [ ] Log rotation and archival



