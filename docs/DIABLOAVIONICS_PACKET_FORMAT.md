# DiabloAvionics Actual Packet Format

## Overview

After cloning and analyzing the actual DiabloAvionics and DAQv2-Comms repositories, the **real packet format is completely different** from FSW's PacketProtocol. The boards use a much simpler format.

## Packet Header (6 bytes)

```
Offset  Size  Field          Description
------  ----  -----          -----------
0       1     packet_type    PacketType enum (BOARD_HEARTBEAT=1, SENSOR_DATA=3, etc.)
1       1     version        Protocol version (currently 0)
2       4     timestamp      Timestamp in milliseconds (uint32_t, little-endian)
```

**NO magic number, NO checksum, NO sequence numbers!**

## Packet Types

```cpp
enum class PacketType : uint8_t {
    BOARD_HEARTBEAT = 1,
    SERVER_HEARTBEAT = 2,
    SENSOR_DATA = 3,
    ACTUATOR_COMMAND = 4,
    SENSOR_CONFIG = 5,
    ACTUATOR_CONFIG = 6,
    ABORT = 7,
    ABORT_DONE = 8,
    CLEAR_ABORT = 9
};
```

## Board Types

```cpp
enum class BoardType : uint8_t {
    UNKNOWN = 0,
    PRESSURE_TRANSDUCER = 1,
    LOAD_CELL = 2,
    RTD = 3,
    THERMOCOUPLE = 4,
    ACTUATOR = 5
};
```

## Board Heartbeat Packet

**Structure:**
```
Header (6 bytes):
  - packet_type = BOARD_HEARTBEAT (1)
  - version = 0
  - timestamp = millis() (uint32_t)

Body (4 bytes):
  - board_type (1 byte): BoardType enum
  - board_id (1 byte): Board identifier (0-15)
  - engine_state (1 byte): EngineState enum
  - board_state (1 byte): BoardState enum
```

**Total: 10 bytes**

## Sensor Data Packet

**Structure:**
```
Header (6 bytes):
  - packet_type = SENSOR_DATA (3)
  - version = 0
  - timestamp = millis() (uint32_t)

Body Header (2 bytes):
  - num_chunks (1 byte): Number of data chunks
  - num_sensors (1 byte): Number of sensors per chunk

For each chunk:
  - chunk_timestamp (4 bytes): uint32_t timestamp for this chunk
  - For each sensor (num_sensors times):
    - sensor_id (1 byte): Sensor ID on board (0-indexed)
    - data (4 bytes): uint32_t sensor value (can represent float via memcpy)
```

**Example:**
- 1 chunk, 2 sensors = 6 + 2 + 4 + (2 * 5) = 22 bytes
- 1 chunk, 10 sensors = 6 + 2 + 4 + (10 * 5) = 62 bytes

## Key Differences from FSW PacketProtocol

| Feature | FSW PacketProtocol | Actual DiabloAvionics |
|---------|-------------------|----------------------|
| **Header Size** | 26 bytes | 6 bytes |
| **Magic Number** | ✅ 0xDEADBEEF | ❌ None |
| **Checksum** | ✅ CRC16 | ❌ None |
| **Sequence Number** | ✅ Yes | ❌ None |
| **Priority** | ✅ Yes | ❌ None |
| **Sensor Count** | In header | In body |
| **Endianness** | Network (big-endian) | Little-endian |
| **Timestamp** | Nanoseconds (uint64_t) | Milliseconds (uint32_t) |

## Board Identification

Boards are identified by:
- **Board Type**: PT, TC, RTD, LC, Actuator
- **Board ID**: 0-15 (4 bits)
- **MAC Address**: Used for IP assignment (ESP32 MAC)

## IP Assignment

From the code, boards use:
- **Static IP assignment**: Based on MAC address or hardcoded
- **Network**: 192.168.2.x (example)
- **Port**: 5005-5006 (UDP)

Example from Multi_Board_Comms_Testing:
```cpp
IPAddress staticIP(192, 168, 2, 100);  // Primary board
IPAddress secondaryIP(192, 168, 2, 101); // Secondary board
const int localPort = 5005;
const int secondaryPort = 5006;
```

## Sensor Data Format

Each sensor datapoint:
- **sensor_id**: 0-indexed sensor on board
- **data**: uint32_t (4 bytes) that can represent:
  - Raw ADC counts (for PT, TC, RTD, LC)
  - Float values (via memcpy conversion)

**Example from PT board:**
```cpp
uint32_t adc_value = readADC(channel);
chunk.add_datapoint(channel_id, adc_value);
```

## Packet Serialization

All packets use **little-endian** byte order (Arduino/ESP32 native).

**Example Sensor Data Packet Creation:**
```cpp
std::vector<SensorDataChunkCollection> chunks;
SensorDataChunkCollection chunk(timestamp_ms, num_sensors);
chunk.add_datapoint(0, sensor0_value);
chunk.add_datapoint(1, sensor1_value);
chunks.push_back(chunk);

size_t packet_size = create_sensor_data_packet(chunks, num_sensors, buffer, buffer_size);
udp.write(buffer, packet_size);
```

## What This Means for Our System

1. **Our PacketParser is WRONG** - It uses FSW format, not actual board format
2. **Need new parser** - Must match 6-byte header + simple body format
3. **Board discovery** - Use BOARD_HEARTBEAT packets, not announcement packets
4. **IP assignment** - Based on MAC address, not board signature hash
5. **Sensor detection** - Parse SENSOR_DATA packets to count sensors

## Next Steps

1. Create new `DiabloBoardPacketParser` matching actual format
2. Update `SensorFramePipeline` to use new parser
3. Update board discovery to listen for BOARD_HEARTBEAT packets
4. Update IP assignment to use MAC address
5. Update sensor detection to parse actual sensor data packets
