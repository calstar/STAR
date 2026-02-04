# Configuration Guide

## Overview

The sensor system uses split configurations for Flight DAQ and Ground Systems DAQ to handle different operational modes.

## Configuration Files

### `config.toml`
Base configuration with common settings. Not used directly - serves as reference.

### `config_flight_daq.toml`
**Flight DAQ Configuration**
- **Network**: `192.168.3.0/24` (IP range 100-150)
- **Port**: `5005`
- **Handles**: Flight sensors and actuators
- **Use Case**: Flight operations
- **During Hotfire**: Everything connects to ground DAQ instead

**Flight Sensors:**
- PT_HP, PT_LP (Board 0)
- PT_FUP, PT_FDP (Board 1)
- PT_OUP, PT_ODP (Board 2)
- RTDs, TCs, LCs, Actuators (to be added)

### `config_ground_daq.toml`
**Ground Systems DAQ Configuration**
- **Network**: `192.168.2.0/24` (IP range 100-150)
- **Port**: `5005`
- **Handles**: GSE sensors and during hotfire (all sensors)
- **Use Case**: Development, testing, hotfire
- **During Flight**: Flight sensors/actuators go to flight DAQ, everything else stays here

**GSE Sensors:**
- PT_OF (Board 10 - LOX Fill)
- PT_FF (Board 11 - Fuel Fill)
- PT_HPF, PT_MPF, PT_LPF (Board 12 - Pressurant Fill)
- RTDs, TCs, LCs (to be added)

## Usage

### Ground DAQ (Development/Hotfire)
```bash
# Start Ground DAQ
./build/daq_comms/daq_bridge config/config_ground_daq.toml
```

### Flight DAQ (Flight Operations)
```bash
# Start Flight DAQ
./build/daq_comms/daq_bridge config/config_flight_daq.toml
```

### Hotfire Mode
During hotfire, set `[hotfire].enabled = true` in `config_ground_daq.toml` to route all sensors (including flight sensors) to ground DAQ.

## Operational Modes

### Development Mode
- Use: `config_ground_daq.toml`
- All GSE sensors connect to ground DAQ
- Flight sensors can be tested here too

### Hotfire Mode
- Use: `config_ground_daq.toml` with `hotfire.enabled = true`
- **ALL sensors** (including flight sensors) connect to ground DAQ
- Single point of data collection for hotfire testing

### Flight Mode
- Use: `config_flight_daq.toml` for flight sensors/actuators
- Use: `config_ground_daq.toml` for GSE sensors
- **Split operation**: Flight sensors on flight DAQ, GSE sensors on ground DAQ

## Network Configuration

### Flight DAQ Network
```
Base IP: 192.168.3.0
Range: 192.168.3.100-150
Port: 5005
```

### Ground DAQ Network
```
Base IP: 192.168.2.0
Range: 192.168.2.100-150
Port: 5005
```

## Sensor Assignments

### Flight System (Flight DAQ)
| Board ID | Sensors | Channels | Purpose |
|----------|---------|----------|---------|
| 0 | PT_HP, PT_LP | 0, 1 | High pressure + COPV |
| 1 | PT_FUP, PT_FDP | 0, 1 | Fuel upstream/downstream |
| 2 | PT_OUP, PT_ODP | 0, 1 | Oxidizer upstream/downstream |

### GSE System (Ground DAQ)
| Board ID | Sensors | Channels | Component |
|----------|---------|----------|-----------|
| 10 | PT_OF | 0 | LOX Fill |
| 11 | PT_FF | 0 | Fuel Fill |
| 12 | PT_HPF, PT_MPF, PT_LPF | 0, 1, 2 | Pressurant Fill |

## Configuration Structure

Each config file contains:

```toml
[system]
mode = "FLIGHT" or "GROUND"
state = "FLIGHT" or "GSE"

[system.network]
base_ip = "192.168.X.0"
ip_range_start = 100
ip_range_end = 150
bind_address = "0.0.0.0"
bind_port = 5005

[database]
db_host = "127.0.0.1"
db_port = 2240

[sensors.flight.pt] or [sensors.gse.pt]
PT_XXX = { board_id = X, channel = Y, max_psi = Z }

[hotfire]  # Ground DAQ only
enabled = false
include_flight_sensors = true
```

## Switching Between Modes

1. **Development**: Use `config_ground_daq.toml`
2. **Hotfire**: Use `config_ground_daq.toml` with `hotfire.enabled = true`
3. **Flight**: Use `config_flight_daq.toml` for flight sensors, `config_ground_daq.toml` for GSE

## Next Steps

- Add RTD, TC, LC sensor assignments
- Add actuator assignments
- Implement hotfire mode switching
- Add validation for sensor assignments
