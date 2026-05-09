# DiabloAvionics Network Configuration

## Overview

This document describes how DiabloAvionics boards communicate and how to configure the DAQ bridge to receive their packets.

## Board Network Configuration

### Default Board IPs
- **Sensor boards (PT, LC, RTD)**: `192.168.2.101` (or other 192.168.2.x)
- **Actuator board**: `192.168.2.201`
- **Network**: `192.168.2.0/24` (subnet mask: `255.255.255.0`)

### Board Receiver Configuration

Boards send sensor data to a **receiver IP** configured in firmware:

| Board Type | receiverIP | receiverPort | Notes |
|------------|------------|--------------|-------|
| Actuator_Testing | `192.168.2.20` | `5006` | Most common |
| PT_BOARD_Multi | `192.168.2.20` | `5007` | Different port to avoid conflict |
| PT_BOARD_v1 | `192.168.2.1` | `5006` | Older firmware |
| Motor | `192.168.2.1` | `5006` | |
| RTD_Board | `192.168.1.1` | `5006` | Different subnet! |

**Most common configuration**: `192.168.2.20:5006`

### Board Local Ports

Boards listen on these ports for commands:
- **Actuator commands**: `5005` (UDP)
- **Sensor data**: Sent to receiver IP on `5006` or `5007` (UDP)

## GUI Configuration

The `combined_gui.py` uses:
- **Bind address**: `0.0.0.0` (all interfaces)
- **Receive port**: `5006` (default, configurable)
- **Actuator IP**: `192.168.2.201` (default)
- **Actuator port**: `5005` (default)

## DAQ Bridge Configuration

### Required Setup

1. **Computer IP must match board's receiverIP**:
   ```bash
   # If board sends to 192.168.2.20:
   sudo ip addr add 192.168.2.20/24 dev <interface>
   
   # If board sends to 192.168.2.1:
   sudo ip addr add 192.168.2.1/24 dev <interface>
   ```

2. **DAQ bridge binds to 0.0.0.0:5006** (or board's receiverPort):
   ```bash
   ./build/FSW/daq_bridge config/config.toml 0.0.0.0 5006
   ```

3. **Network interface auto-detection**:
   - DAQ bridge now auto-detects the interface with 192.168.2.x IP
   - Previously hardcoded to "eth0", now detects correctly

### Packet Format

DiabloAvionics uses a simple 6-byte header:
```
Header (6 bytes):
  packet_type (1 byte): 3 = SENSOR_DATA
  version (1 byte): 0
  timestamp (4 bytes): uint32_t milliseconds (little-endian)

Body:
  num_chunks (1 byte)
  num_sensors (1 byte)
  For each chunk:
    chunk_timestamp (4 bytes, uint32_t)
    For each sensor:
      sensor_id (1 byte)
      data (4 bytes, uint32_t)
```

## Troubleshooting

### No Packets Received

1. **Check board's receiverIP**:
   - Look at Serial monitor output
   - Should show: `receiverIP = IPAddress(...)`
   - Or: `Send to: X.X.X.X:XXXX`

2. **Verify computer IP matches**:
   ```bash
   ip addr show | grep 192.168.2
   ```
   - Must match board's receiverIP

3. **Check port**:
   ```bash
   sudo netstat -ulnp | grep 5006
   ```
   - DAQ bridge should be listening

4. **Test with GUI**:
   ```bash
   cd external/DiabloAvionics/test_guis
   python3 combined_gui.py
   ```
   - If GUI receives data, boards are working
   - Compare GUI config to DAQ bridge config

5. **Verify network connectivity**:
   ```bash
   # From board Serial monitor, ping computer IP
   # Or check ARP table:
   arp -a | grep 192.168.2
   ```

### Common Issues

1. **Wrong IP**: Computer has `192.168.2.201` but board sends to `192.168.2.20`
   - **Fix**: Change computer IP to match board's receiverIP

2. **Wrong port**: Board sends to port `5007` but DAQ bridge listens on `5006`
   - **Fix**: Start DAQ bridge on correct port

3. **Wrong interface**: Discovery uses "eth0" but actual interface is "enx00e04c680240"
   - **Fix**: Auto-detection now handles this (fixed in code)

4. **No ARP entry**: Board doesn't appear in ARP table
   - **Cause**: Board and computer not on same network
   - **Fix**: Verify subnet masks match, check physical connection

## Example Configurations

### Actuator Board (192.168.2.201)
```cpp
IPAddress staticIP(192, 168, 2, 201);
IPAddress receiverIP(192, 168, 2, 20);  // Sends to computer
const int receiverPort = 5006;
const int localPort = 5005;  // Listens for commands
```

### PT Board (192.168.2.101)
```cpp
IPAddress staticIP(192, 168, 2, 101);
IPAddress receiverIP(192, 168, 2, 20);  // Sends to computer
const int receiverPort = 5007;  // Different port
const int localPort = 5005;
```

### Computer Setup
```bash
# Set IP to match board's receiverIP
sudo ip addr add 192.168.2.20/24 dev enx00e04c680240

# Start DAQ bridge
./build/FSW/daq_bridge config/config.toml 0.0.0.0 5006
```

## References

- DiabloAvionics Repository: `external/DiabloAvionics/`
- GUI Code: `external/DiabloAvionics/test_guis/combined_gui.py`
- Board Firmware Examples:
  - `external/DiabloAvionics/ADC_Testing/Actuator_Testing/src/main.cpp`
  - `external/DiabloAvionics/PT_Board/PT_BOARD_Multi/PT_BOARD_Multi_Send/src/main.cpp`
