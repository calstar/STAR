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

### Initial Setup

```bash
# Clone repository with submodules
git clone --recursive <repository-url>
cd sensor_system

# OR if already cloned, initialize submodules
git submodule update --init --recursive
```

### Build

```bash
mkdir -p build
cd build
cmake ..
cmake --build .
```

## External Dependencies

This repository uses git submodules for external dependencies:

- **external/DAQv2-Comms**: ESP32 Ethernet communication library for Diablo DAQ system
- **external/DiabloAvionics**: DiabloAvionics firmware and board code

To update submodules to latest versions:
```bash
git submodule update --remote --recursive
```

To update a specific submodule:
```bash
cd external/DAQv2-Comms
git pull origin main
cd ../..
git add external/DAQv2-Comms
git commit -m "Update DAQv2-Comms submodule"
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
