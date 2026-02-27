# System Verification Checklist

## Data Flow Verification

### 1. FSW → Elodin DB
- [ ] FSW sends sensor data via UDP/TCP to DAQ Bridge
- [ ] DAQ Bridge registers components in Elodin DB
- [ ] Components registered with correct entity names:
  - `PT_Cal.Fuel_Upstream` (channel 1)
  - `PT_Cal.GSE_Low` (channel 2)
  - `PT_Cal.GSE_Mid` (GSE Mid, board 2 connector 4)
  - `PT_Cal.Fuel_Downstream` (channel 4)
  - `PT_Cal.Ox_Upstream` (channel 5)
  - `PT_Cal.GN2_Regulated` (channel 6)
  - `PT_Cal.Ox_Downstream` (channel 7)
  - `ACT.LOX_Main` (channel 1)
  - `ACT.Fuel_Vent` (channel 2)
  - `ACT.Fuel_Press` (channel 3)
  - etc.

### 2. Elodin DB → Backend
- [ ] Backend connects to Elodin DB on port 2240
- [ ] Backend receives packets with correct packet IDs:
  - `[0x20, 0x01-0x0A]` for raw PT (channels 1-10)
  - `[0x20, 0x11-0x1A]` for calibrated PT (channels 1-10)
  - `[0x30, 0x01-0x0A]` for actuators (channels 1-10)
- [ ] Backend parses packets correctly:
  - 21-byte message format
  - Channel ID is 1-based (1-10)
  - Entity mapping matches DatabaseConfig.cpp

### 3. Backend → Frontend
- [ ] Backend broadcasts parsed data via WebSocket (port 8081)
- [ ] Frontend receives `SENSOR_UPDATE` messages
- [ ] Frontend stores data in Zustand store
- [ ] Components read from store and display data

## Packet Format Verification

### PT Raw Message (21 bytes)
```
Offset  Size  Type      Field
0       8     uint64_t  timestamp_ns
8       1     uint8_t   channel_id (1-based)
9       3     uint8_t[3] padding
12      4     uint32_t  raw_adc_counts
16      4     uint32_t  sample_ts_ms
20      1     uint8_t   status
```

### PT Calibrated Message (21 bytes)
```
Offset  Size  Type      Field
0       8     uint64_t  timestamp_ns
8       1     uint8_t   channel_id (1-based)
9       3     uint8_t[3] padding
12      4     float     pressure_psi
16      4     uint32_t  raw_adc_counts
20      1     uint8_t   calibration_status
```

### Actuator Message (21 bytes)
```
Offset  Size  Type      Field
0       8     uint64_t  timestamp_ns
8       1     uint8_t   channel_id (1-based)
9       3     uint8_t[3] padding
12      4     uint32_t  raw_adc_counts
16      4     uint32_t  sample_ts_ms
20      1     uint8_t   status
```

## Channel Mapping

### PT Sensors (channels 1-10)
- Channel 1: `PT_Cal.Fuel_Upstream`
- Channel 2: `PT_Cal.GSE_Low`
- Channel 3: `PT_Cal.PT_CH3` (board 1)
- GSE Mid: `PT_Cal.GSE_Mid` (board 2 connector 4)
- Channel 4: `PT_Cal.Fuel_Downstream`
- Channel 5: `PT_Cal.Ox_Upstream`
- Channel 6: `PT_Cal.GN2_Regulated`
- Channel 7: `PT_Cal.Ox_Downstream`
- Channel 8: `PT_Cal.PT_CH8`
- Channel 9: `PT_Cal.PT_CH9`
- Channel 10: `PT_Cal.PT_CH10`

### Actuators (channels 1-10)
- Channel 1: `ACT.LOX_Main`
- Channel 2: `ACT.Fuel_Vent`
- Channel 3: `ACT.Fuel_Press`
- Channel 4: `ACT.ACT_CH4`
- Channel 5: `ACT.GSE_Low_Vent`
- Channel 6: `ACT.LOX_Vent`
- Channel 7: `ACT.Fuel_Main`
- Channel 8: `ACT.LOX_Press`
- Channel 9: `ACT.Fuel_Fill_Vent`
- Channel 10: `ACT.Fuel_Fill_Press`

## Testing Steps

1. **Start Elodin DB**: `elodin-db run`
2. **Start DAQ Bridge**: Should register components
3. **Start Backend**: `cd web-gui/backend && npm run dev`
4. **Start Frontend**: `cd web-gui/frontend && npm run dev`
5. **Check Backend Logs**: Should show "✅ Connected to Elodin DB"
6. **Check Frontend**: Should show "Connected" status
7. **Send Test Data**: FSW should send sensor packets
8. **Verify Parsing**: Backend logs should show parsed packets
9. **Verify Display**: Frontend should show live data in plots

## Common Issues

### No Data in GUI
- Check Elodin DB is running and receiving data
- Check backend is connected to Elodin DB
- Check packet IDs match (0x20 for PT, 0x30 for actuators)
- Check channel mapping is correct (1-based)

### Wrong Entity Names
- Verify `DatabaseConfig.cpp` entity names match parser
- Check channel ID mapping (1-based, not 0-based)

### Connection Issues
- Check WebSocket server is running on port 8081
- Check Elodin DB is running on port 2240
- Check firewall settings
