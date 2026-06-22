# Flash Script Documentation

This directory contains `flash.sh`, which deploys executables, libraries, and
configuration files to target systems (local or remote).

> **Status / caveat:** `flash.sh` predates the current build layout and is
> partially stale. Binaries now build into **`build/bin/`**, but the script only
> searches `build/`, `build/FSW/`, and `build/daq_comms/` — so it will not find
> them until its search path is updated to include `build/bin/`. Several
> executables in its list (`send_all_sensors_from_config`,
> `send_all_message_types`, `esp32_pt_streamer`, `fake_esp32_packet_gen`,
> `sitl_simulator`, `test_imu_calibration`) and the startup scripts it copies
> (`scripts/startup/*.sh`) no longer exist. The libraries (`libdaq_comms_lib.so`,
> `libfsw_daq_lib.so`) and config files are still valid. Treat the lists below as
> describing the script's current (stale) behavior, not a working deploy.

## Overview

The flash script handles deployment of:
- **Executables**: `daq_bridge` (and `test_robust_ddp`). The service binaries
  (`sequencer_service`, `controller_service`, `calibration_service`,
  `heartbeat_service`, `config_broadcast_service`, `ota_service`,
  `data_logger_service`) build into `build/bin/` and should be flashed too once
  the script's search path is fixed.
- **Libraries**: `libdaq_comms_lib.so`, `libfsw_daq_lib.so`
- **Config Files**: Flight/ground DAQ configurations
- **Scripts**: startup scripts (currently points at removed `scripts/startup/*`)

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
./flash/flash.sh -h 192.168.2.100 -e daq_bridge
```

## Target Structure

Files are flashed to the following structure:

```
/opt/sensor_system/         # default target (-t to override)
├── bin/
│   ├── daq_bridge
│   └── ...                  # other binaries from build/bin/
├── lib/
│   ├── libdaq_comms_lib.so
│   └── libfsw_daq_lib.so
├── etc/
│   ├── config_flight_daq.toml
│   ├── config_ground_daq.toml
│   └── config.toml
└── scripts/                 # only if the (stale) startup scripts are restored
```

## Dependencies

The flash script handles all current program dependencies:

### Executables (in `flash.sh`'s list; * = no longer a build target)

- `daq_bridge` - Main DAQ bridge with state machine
- `test_robust_ddp` - Robust DDP controller test (if built)
- `send_all_sensors_from_config` *
- `send_all_message_types` *
- `test_fsw_simulator` *
- `esp32_pt_streamer` *
- `fake_esp32_packet_gen` *
- `sitl_simulator` *
- `test_imu_calibration` *

The current service binaries — `sequencer_service`, `controller_service`,
`calibration_service`, `heartbeat_service`, `config_broadcast_service`,
`ota_service`, `data_logger_service` — are NOT in the script's list and should be
added.

### Libraries
- `libdaq_comms_lib.so` - DAQ communications library (`daq_comms_lib`: messages, parser, transport, UDP)
- `libfsw_daq_lib.so` - FSW DAQ library (`fsw_daq_lib`: config, routing, elodin, control/state machine, calibration)

### Runtime Dependencies
- **Eigen3** - Must be installed on target system
- **pthread** - Standard library
- **rt** - Real-time library

## Remote Flashing

For remote flashing, ensure:
1. SSH access is configured
2. Target directory is writable
3. Required dependencies (Eigen3, etc.) are installed on target

## Notes

- The script searches for executables in `build/`, `build/FSW/`, and `build/daq_comms/`. **Note:** current binaries land in `build/bin/`, which the script does not yet search — fix the search path before relying on it.
- Libraries are automatically added to library cache on local systems
- Scripts are made executable automatically
- Missing files are skipped with warnings
