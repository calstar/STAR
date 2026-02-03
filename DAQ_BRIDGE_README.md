# DAQ Bridge - Groundstation Sensor Data Pipeline

## Overview

The DAQ Bridge is the groundstation-side component that receives encrypted sensor packets from embedded systems (ESP32/Jetson), decrypts them, and publishes sensor data to the Elodin database.

## Architecture

```
Embedded System → UDP → DAQ Bridge → Elodin Database
     (ESP32)     (8888)   (decrypt/route)   (2240)
```

### Components

1. **Transport Layer** (`daq_comms/transport/`): UDP/TCP socket wrappers
2. **Protocol Layer** (`daq_comms/protocol/`): Frame decoding and decryption
3. **Streams Layer** (`daq_comms/streams/`): High-level sensor frame pipeline
4. **Elodin Client** (`daq_comms/elodin/`): Elodin database client wrapper
5. **Routing** (`daq_comms/routing/`): Maps sensor channels to Elodin tables

## Building

### Using Nix (Recommended)

```bash
# Enter development shell
nix develop

# Build
mkdir -p build && cd build
cmake ..
make daq_bridge

# Run
nix run .#daq-bridge
```

### Using CMake (Fallback)

```bash
mkdir -p build && cd build
cmake ..
make daq_bridge
```

## Running

### Basic Usage

```bash
./build/daq_bridge [udp_bind] [udp_port] [elodin_host] [elodin_port] [config]
```

Default arguments:
- `udp_bind`: `0.0.0.0` (bind to all interfaces)
- `udp_port`: `8888`
- `elodin_host`: `127.0.0.1`
- `elodin_port`: `2240`
- `config`: `config/sensor_routing.toml`

### Example

```bash
# Start Elodin database first
elodin-db /tmp/elodin_test_db 2240 &

# Start DAQ bridge
./build/daq_bridge 0.0.0.0 8888 127.0.0.1 2240 config/sensor_routing.toml
```

### Using the Simulated Stack Script

```bash
./scripts/run_simulated_stack.sh [db_path] [db_port] [udp_port]
```

This script starts both `elodin-db` and `daq_bridge` together.

## Configuration

### Sensor Routing Configuration

Edit `config/sensor_routing.toml` to map sensor channels to Elodin table IDs:

```toml
[sensor_channels.pt_chamber]
channel_id = 0
table_name = "pt_chamber_raw"
table_id = [0x20, 0x00]
sensor_type = "PT"
location = "chamber"
```

## Protocol

See `docs/PROTOCOL.md` for the complete protocol specification.

## Message Schemas

Sensor messages are defined in `daq_comms/include/messages/SensorMessages.hpp`:

- `RawPTMessage`: Pressure transducer samples
- `RawTCMessage`: Thermocouple samples
- `RawRTDMessage`: RTD samples
- `RawLCMessage`: Load cell samples

Each message contains:
- `timestamp_ns`: Monotonic timestamp in nanoseconds
- `channel_id`: Sensor channel identifier
- `raw_adc_counts`: Raw ADC reading (or resistance counts for RTD)
- `sample_timestamp_ms`: Embedded timestamp in milliseconds
- `status_flags`: Status/health flags

## Troubleshooting

### DAQ Bridge won't start

- Check that UDP port is not already in use: `netstat -ulnp | grep 8888`
- Verify Elodin database is running: `ps aux | grep elodin-db`

### No data in Elodin

- Check DAQ bridge logs for errors
- Verify sensor routing configuration matches embedded channel IDs
- Ensure embedded system is sending packets to correct UDP port

### Connection to Elodin fails

- Verify Elodin database is running: `elodin-db /tmp/elodin_test_db 2240`
- Check firewall rules if connecting to remote host
- Verify port 2240 is not blocked

## Development

### Adding New Sensor Types

1. Add sensor sample structure to `daq_comms/include/protocol/EncryptedFrame.hpp`
2. Add message type to `daq_comms/include/messages/SensorMessages.hpp`
3. Update unpacker in `EncryptedFrame.cpp`
4. Add routing logic in `SensorRouter.cpp`
5. Update `FrameToElodinMapper.cpp` to handle new type

### Testing

Use the simulated stack script to test with fake packet generators:

```bash
./scripts/run_simulated_stack.sh
# In another terminal:
./build/fake_diablo_packet_generator localhost 8888 sensor_data continuous
```

## Future Work

- [ ] TOML parsing for sensor routing configuration
- [ ] Real encryption (AES-128-GCM) instead of XOR
- [ ] Command protocol for sending control commands back to embedded
- [ ] Calibration pipeline integration
- [ ] Metrics and monitoring



