# DiabloAvionics System Analysis

## Overview

After cloning and analyzing the actual [DiabloAvionics](https://github.com/calstar/DiabloAvionics) and [DAQv2-Comms](https://github.com/calstar/DAQv2-Comms) repositories, we've discovered the **real packet format** used by the sensor boards. This is **completely different** from FSW's PacketProtocol.

## Key Findings

### 1. **Packet Format is MUCH Simpler**

**Actual Format (from DAQv2-Comms):**
- **Header**: 6 bytes (packet_type + version + timestamp)
- **NO magic number**
- **NO checksum**
- **NO sequence numbers**
- **Little-endian** byte order (Arduino/ESP32 native)

**FSW PacketProtocol (for Jetson):**
- **Header**: 26 bytes (magic + version + type + priority + sizes + sequence + timestamp + checksum)
- **Big-endian** (network byte order)
- **Full validation** (checksums, sequences)

### 2. **Board Identification**

Boards are identified by:
- **Board Type**: PT (1), LC (2), RTD (3), TC (4), Actuator (5)
- **Board ID**: 0-15 (4 bits, sent in heartbeat)
- **MAC Address**: ESP32 MAC address (used for IP assignment)

**NOT** by complex signatures with hardware/firmware versions!

### 3. **IP Assignment**

From the code examples:
- **Static IPs**: Hardcoded in board firmware (e.g., `192.168.2.100`, `192.168.2.101`)
- **Network**: `192.168.2.x` subnet
- **Ports**: `5005`, `5006`, `5007` (UDP)

**Example from PT_Board:**
```cpp
IPAddress staticIP(192, 168, 2, 101);
IPAddress receiverIP(192, 168, 2, 20);
const int receiverPort = 5007;
```

### 4. **Sensor Data Packet Structure**

```
Header (6 bytes):
  packet_type = SENSOR_DATA (3)
  version = 0
  timestamp = millis() (uint32_t, little-endian)

Body Header (2 bytes):
  num_chunks (1 byte)
  num_sensors (1 byte)

For each chunk:
  chunk_timestamp (4 bytes, uint32_t, little-endian)
  For each sensor (num_sensors times):
    sensor_id (1 byte, 0-indexed)
    data (4 bytes, uint32_t, little-endian)
```

**Example: PT board with 10 sensors, 1 chunk**
- Total: 6 + 2 + 4 + (10 * 5) = **62 bytes**

### 5. **Board Heartbeat Packet**

```
Header (6 bytes):
  packet_type = BOARD_HEARTBEAT (1)
  version = 0
  timestamp = millis()

Body (4 bytes):
  board_type (1 byte): BoardType enum
  board_id (1 byte): 0-15
  engine_state (1 byte): EngineState enum
  board_state (1 byte): BoardState enum
```

**Total: 10 bytes**

## Board Types and Sensor Counts

From analyzing the board code:

### PT Board (`PT_BOARD_Multi_Send`)
- **Sensors**: 10 PTs (connectors 1-10)
- **IP**: `192.168.2.101`
- **Port**: `5007`
- **Data**: Voltage readings converted to uint32_t via `memcpy`

### RTD Board (`RTD_Main`)
- **Sensors**: Variable (depends on connectors)
- **Data**: Resistance measurements

### LC Board (`LC_Simple_Test`)
- **Sensors**: Variable
- **Data**: Force measurements

### Multi-Board Testing
- **Primary**: `192.168.2.100:5005`
- **Secondary**: `192.168.2.101:5006`
- Sends SENSOR_DATA packets between boards

## Configuration Implications

### What We Need to Do

1. **Update Packet Parser** ✅
   - Use `DiabloBoardPacketParser` (6-byte header)
   - Parse little-endian data
   - Handle BOARD_HEARTBEAT for discovery
   - Handle SENSOR_DATA for sensor readings

2. **Board Discovery** ✅
   - Listen for BOARD_HEARTBEAT packets
   - Extract board_type and board_id
   - Use MAC address for IP assignment (or static IPs from config)
   - Track boards by IP address

3. **Sensor Detection** ✅
   - Parse SENSOR_DATA packets
   - Count unique sensor_id values
   - Infer board type from packet source or heartbeat

4. **IP Assignment Strategy**
   - **Option A**: Use static IPs from config (like boards do)
   - **Option B**: Assign based on MAC address hash
   - **Option C**: Use DHCP with MAC-based reservations

5. **Config File Updates**
   - Auto-populate sensor counts from packet analysis
   - Track board IPs and types
   - Map sensor IDs to channels

## Differences Summary

| Aspect | FSW PacketProtocol | Actual DiabloAvionics |
|--------|-------------------|---------------------|
| **Use Case** | Jetson → Ground Station | ESP32 Boards → Ground Station |
| **Header Size** | 26 bytes | 6 bytes |
| **Magic Number** | ✅ 0xDEADBEEF | ❌ None |
| **Checksum** | ✅ CRC16 | ❌ None |
| **Sequence** | ✅ Yes | ❌ None |
| **Priority** | ✅ Yes | ❌ None |
| **Endianness** | Big-endian (network) | Little-endian (native) |
| **Timestamp** | Nanoseconds (uint64_t) | Milliseconds (uint32_t) |
| **Sensor Format** | Type + ID + Data + Timestamp + Quality | ID + Data (simpler) |
| **Board ID** | Complex signature | Simple board_type + board_id |

## Implementation Status

✅ **Created `DiabloBoardPacketParser`** - Matches actual format
✅ **Updated `SensorFramePipeline`** - Uses new parser
✅ **Updated `BoardDiscovery`** - Handles BOARD_HEARTBEAT packets
✅ **Sensor Detection** - Parses SENSOR_DATA to count sensors
🔄 **IP Assignment** - Needs MAC address extraction from network layer
🔄 **Config Updates** - Needs integration with dynamic config manager

## Next Steps

1. **Extract MAC addresses** from UDP packets (if possible) or use ARP table
2. **Update IP assignment** to use MAC-based deterministic assignment
3. **Track board types** per IP address for sensor type inference
4. **Update config generation** to use actual sensor counts from packets
5. **Test with real boards** to validate packet parsing

## References

- [DiabloAvionics Repository](https://github.com/calstar/DiabloAvionics)
- [DAQv2-Comms Library](https://github.com/calstar/DAQv2-Comms)
- Packet format defined in: `external/DAQv2-Comms/src/DiabloPackets.h`
- Packet utilities: `external/DAQv2-Comms/src/DiabloPacketUtils.cpp`
- Board examples: `external/DiabloAvionics/PT_Board/`, `RTD_Board/`, `LC_Board/`

