# Elodin Database Debugging

## Current Status
- ✅ Connection to Elodin DB works (verified with strace)
- ✅ Data is being sent (26 bytes per message, confirmed by strace)
- ✅ Database directories are being created (data is being written)
- ✅ Serialization follows Elodin protocol format
- ❌ Messages not appearing in Elodin editor

## Verification Steps

### 1. Check Database Path
Make sure you're opening the correct database:
```bash
elodin editor ~/.local/share/elodin/test_pt_db
```

### 2. Verify Data is Being Written
```bash
# Check database size
du -sh ~/.local/share/elodin/test_pt_db

# List database directories (each represents a table/entity)
ls -lh ~/.local/share/elodin/test_pt_db
```

### 3. Test with Sensor System
Test the sensor system's Elodin integration:
```bash
# Start database
source scripts/startup_daq_db.sh test_db 2240

# Run sensor system test
./build/diablo_fsw config/config_base.toml

# Check data in editor
elodin editor ~/.local/share/elodin/test_db
```

### 4. Check VTable Registration
The VTable messages are being sent (139, 72, 68, 76, 86 bytes). Verify:
- VTable packet_id matches data packet_id
- Component names match exactly
- Entity IDs are correct

### 5. Verify Message Formats
Our serialization follows Elodin protocol:
- Header: len (4 bytes), type (1 byte), packet_id (2 bytes), request_id (1 byte)
- Body: message fields in correct order (matching VTable schema)

## Potential Issues

1. **VTable Registration Timing**: Maybe Elodin needs more time to process VTables before data arrives
2. **Component Name Mismatch**: Component names must match exactly between VTable and data
3. **Packet ID Mismatch**: VTableMsg.id must match the packet_id in data messages
4. **Database State**: Database might need to be recreated

## Next Steps

1. Try increasing the delay after VTable registration (currently 2 seconds)
2. Verify component names match exactly (case-sensitive)
3. Verify VTable registration completes before data transmission
4. Try recreating the database from scratch


