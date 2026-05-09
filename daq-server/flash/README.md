# Flash Script Documentation

This directory contains scripts for flashing executables, libraries, and configuration files to target systems (local or remote). It integrates with the external `calstar/flash` cross-platform installer system.

## Overview

The flash script handles deployment of:
- **Executables**: `daq_bridge`, `send_all_sensors_from_config`, `send_all_message_types`, etc.
- **Libraries**: `libdaq_comms_lib.so`, `libfsw_daq_lib.so`
- **Config Files**: Flight/ground DAQ configurations
- **Scripts**: Startup and system scripts

## Integration with External Flash

This script works alongside the `external/flash` repository which provides:
- Cross-platform system setup (macOS, Linux, Windows/WSL)
- Python environment setup
- Elodin editor/database installation
- Development tools installation

**To set up a new system:**
1. First run the external flash installer: `external/flash/install.sh`
2. Then use this script to deploy built executables: `flash/flash.sh`

## Usage

### Basic Usage

```bash
# Flash everything to local system
./flash/flash.sh

# Flash to remote host
./flash/flash.sh -h 192.168.2.100

# Flash with custom user
./flash/flash.sh -h 192.168.2.100 -u jetson
```

### Options

- `-h, --host HOST`: Target host (IP or hostname) for remote flashing
- `-u, --user USER`: SSH user (default: root)
- `-b, --build-dir DIR`: Build directory (default: build)
- `-t, --target-dir DIR`: Target installation directory (default: /opt/sensor_system)
- `-e, --executable EXE`: Flash only specific executable
- `-l, --library LIB`: Flash only specific library
- `-c, --config`: Flash only config files
- `-s, --scripts`: Flash only scripts
- `-a, --all`: Flash everything (default)

### Examples

```bash
# Flash only daq_bridge executable
./flash/flash.sh -e daq_bridge

# Flash only libraries
./flash/flash.sh -l libdaq_comms_lib.so

# Flash only config files
./flash/flash.sh -c

# Flash to remote Jetson
./flash/flash.sh -h 192.168.2.50 -u jetson -t /home/jetson/sensor_system

# Flash specific executable to remote
./flash/flash.sh -h 192.168.2.100 -e send_all_sensors_from_config
```

## Target Structure

Files are flashed to the following structure:

```
/opt/sensor_system/
├── bin/
│   ├── daq_bridge
│   ├── send_all_sensors_from_config
│   ├── send_all_message_types
│   └── ...
├── lib/
│   ├── libdaq_comms_lib.so
│   └── libfsw_daq_lib.so
├── etc/
│   ├── config_flight_daq.toml
│   ├── config_ground_daq.toml
│   └── config.toml
└── scripts/
    ├── startup_daq_db.sh
    ├── startup_daq_bridge.sh
    └── ...
```

## Dependencies

The flash script handles all current program dependencies:

### Executables
- `daq_bridge` - Main DAQ bridge (FSW) with state machine
- `send_all_sensors_from_config` - Test program for sending sensors from config
- `send_all_message_types` - Test program for all message types
- `test_fsw_simulator` - FSW simulator for testing
- `esp32_pt_streamer` - ESP32 PT streamer
- `fake_esp32_packet_gen` - Fake ESP32 packet generator
- `sitl_simulator` - SITL simulator (if built)
- `test_robust_ddp` - Robust DDP controller test (if built)
- `test_imu_calibration` - IMU calibration test (if built)

### Libraries
- `libdaq_comms_lib.so` - DAQ communications library (messages, parser, transport, UDP)
- `libfsw_daq_lib.so` - FSW DAQ library (config, routing, elodin, control/state machine, calibration)

### New Dependencies (State Machine & UDP)
- `PressureStateMachine` - State machine with UDP actuator command sending
- `DiabloBoardPacketParser` - Packet parser for actuator commands
- `UDPSocket` - UDP transport for sending commands to boards
- `ElodinClient` - Elodin database client for reading pressure data

### Runtime Dependencies
- **Eigen3** - Must be installed on target system (handled by external/flash)
- **pthread** - Standard library
- **rt** - Real-time library

## Remote Flashing

For remote flashing, ensure:
1. SSH access is configured
2. Target directory is writable
3. Required dependencies (Eigen3, etc.) are installed on target (use external/flash/install.sh first)

## Notes

- The script automatically searches for executables in `build/`, `build/FSW/`, and `build/daq_comms/`
- Libraries are automatically added to library cache on local systems
- Scripts are made executable automatically
- Missing files are skipped with warnings
- Integrates with external flash installer for system setup

## External Flash Installer

The `external/flash` repository provides cross-platform installation:
- System package installation (cmake, git, python, etc.)
- Python virtual environment setup
- Elodin editor/database installation
- OpenCV installation
- Development tools (bashdb, etc.)

Run `external/flash/install.sh` on a new system before deploying executables.
