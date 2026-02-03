# DAQ Sensor System Protocol Specification

## Version 1.0

This document describes the encrypted sensor packet protocol used between embedded systems (ESP32/Jetson) and the groundstation DAQ bridge.

## Frame Format

### Frame Header (16 bytes)

```
Offset  Size  Field          Description
------  ----  -----          -----------
0       1     magic          Magic byte for frame sync (0xAA)
1       1     version        Protocol version (0x01)
2       2     sequence_id    Sequence number (big-endian, wraps at 65535)
4       4     timestamp_ms   Timestamp in milliseconds since epoch
8       2     payload_size   Size of encrypted payload in bytes
10      1     sensor_count   Number of sensor samples in payload
11      1     flags          Status flags (reserved)
12      4     crc32          CRC32 checksum of header (excluding CRC field)
```

### Payload Structure

The payload is encrypted and contains a sequence of sensor samples. Each sample starts with a 1-byte sensor type identifier:

- `0x01`: Pressure Transducer (PT)
- `0x02`: Thermocouple (TC)
- `0x03`: RTD
- `0x04`: Load Cell (LC)

Following the sensor type byte is the sensor-specific data structure:

#### PT Sample (10 bytes)
```
Offset  Size  Field              Description
------  ----  -----              -----------
0       1     channel_id         Sensor channel identifier
1       4     raw_adc_counts     Raw ADC reading (uint32_t)
5       4     sample_timestamp_ms Embedded timestamp in milliseconds
9       1     status_flags      Status/health flags
```

#### TC Sample (10 bytes)
Same structure as PT sample.

#### RTD Sample (10 bytes)
Same structure as PT sample, but `raw_adc_counts` represents resistance measurement.

#### LC Sample (10 bytes)
Same structure as PT sample.

## Encryption

Currently uses a simple XOR cipher with a 16-byte key for development. This should be replaced with AES-128-GCM or similar in production.

### Decryption Process

1. Extract encrypted payload from frame
2. XOR each byte with corresponding key byte (wrapping key if payload is longer)
3. Result is decrypted payload ready for unpacking

## Sequence Numbers

Sequence numbers increment with each frame and wrap at 65535. The receiver tracks expected sequence numbers to detect packet loss.

## Sensor Channel IDs

Channel IDs are assigned per sensor type:
- PT channels: 0-15
- TC channels: 0-15
- RTD channels: 0-15
- LC channels: 0-15

## Command Protocol (Future)

Command frames will use a similar structure but with different magic byte (0xBB) and payload format. This will be documented in a future version.

## Example Frame

```
Header:
  AA 01 00 42 12 34 56 78 00 64 05 00 12 34 56 78

Payload (encrypted, 100 bytes):
  [encrypted sensor samples...]
```

## References

- Embedded-side implementation: [DAQv2-Comms](https://github.com/calstar/DAQv2-Comms)
- Groundstation implementation: `daq_comms/` directory



