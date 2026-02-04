# Sensor System - DiabloAvionics DAQ

## Overview

Sensor data acquisition system for rocket flight and ground support equipment (GSE). Uses DiabloAvionics packet format for communication with ESP32 sensor boards.

## Architecture

- **Flight DAQ**: Handles flight sensors and actuators (192.168.3.0/24)
- **Ground DAQ**: Handles GSE sensors and during hotfire (192.168.2.0/24)
- **Packet Format**: DiabloAvionics 6-byte header (no magic, no checksum, little-endian)
- **Database**: Elodin for time-series data storage and visualization

## Quick Start

### Ground DAQ (Development/Hotfire)
```bash
# Start Elodin database
./scripts/startup/startup_daq_db.sh

# Start Ground DAQ
./build/daq_comms/daq_bridge config/config_ground_daq.toml
```

### Flight DAQ (Flight Operations)
```bash
# Start Flight DAQ
./build/daq_comms/daq_bridge config/config_flight_daq.toml
```

## Configuration

See `config/README.md` for detailed configuration documentation.

- **config_flight_daq.toml**: Flight sensors and actuators
- **config_ground_daq.toml**: GSE sensors, hotfire mode (all sensors)

## Sensor Assignments

### Flight Sensors (Flight DAQ)
- PT_HP, PT_LP (Board 0)
- PT_FUP, PT_FDP (Board 1)
- PT_OUP, PT_ODP (Board 2)
- RTDs, TCs, LCs, Actuators (to be added)

### GSE Sensors (Ground DAQ)
- PT_OF (Board 10 - LOX Fill)
- PT_FF (Board 11 - Fuel Fill)
- PT_HPF, PT_MPF, PT_LPF (Board 12 - Pressurant Fill)
- RTDs, TCs, LCs (to be added)

## Building

```bash
mkdir -p build
cd build
cmake ..
cmake --build .
```

## Documentation

See `docs/README.md` for complete documentation.

## Key Features

- ✅ DiabloAvionics packet parsing (actual format)
- ✅ Board discovery and IP assignment
- ✅ Sensor-to-board mapping
- ✅ GSE/FLIGHT state management
- ✅ Elodin database integration
- ✅ Split Flight/Ground DAQ configurations
