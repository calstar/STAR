# Configuration Files

## Overview

The sensor system uses split configurations for Flight DAQ and Ground Systems DAQ.

## Configuration Files

### `config.toml`
Base configuration file with common settings. Not used directly - use flight or ground configs.

### `config_flight_daq.toml`
**Flight DAQ Configuration**
- Used for flight sensors and actuators during flight operations
- Network: `192.168.3.0/24` (IP range 100-150)
- Handles: Flight PTs, RTDs, TCs, LCs, Actuators
- **During hotfire**: Everything connects to ground DAQ instead

### `config_ground_daq.toml`
**Ground Systems DAQ Configuration**
- Used for GSE sensors and during hotfire
- Network: `192.168.2.0/24` (IP range 100-150)
- Handles: GSE PTs, RTDs, TCs, LCs
- **During hotfire**: ALL sensors (including flight sensors) connect here
- **During flight**: Flight sensors/actuators go to flight DAQ, everything else stays here

## Usage

### Flight Operations
```bash
# Start Flight DAQ
./build/daq_comms/daq_bridge config/config_flight_daq.toml
```

### Ground Operations / Hotfire
```bash
# Start Ground DAQ
./build/daq_comms/daq_bridge config/config_ground_daq.toml
```

### Hotfire Mode
Set `[hotfire].enabled = true` in `config_ground_daq.toml` to route all sensors (including flight sensors) to ground DAQ.

## Sensor Assignments

### Flight Sensors (config_flight_daq.toml)
- PT_HP, PT_LP (Board 0)
- PT_FUP, PT_FDP (Board 1)
- PT_OUP, PT_ODP (Board 2)
- RTDs, TCs, LCs, Actuators (to be added)

### GSE Sensors (config_ground_daq.toml)
- PT_OF (Board 10 - LOX Fill)
- PT_FF (Board 11 - Fuel Fill)
- PT_HPF, PT_MPF, PT_LPF (Board 12 - Pressurant Fill)
- RTDs, TCs, LCs (to be added)

## Network Configuration

### Flight DAQ Network
- Base IP: `192.168.3.0`
- Range: `192.168.3.100-150`
- Port: `5005`

### Ground DAQ Network
- Base IP: `192.168.2.0`
- Range: `192.168.2.100-150`
- Port: `5005`

## Switching Between Modes

1. **Development/Testing**: Use `config_ground_daq.toml`
2. **Hotfire**: Use `config_ground_daq.toml` with `hotfire.enabled = true`
3. **Flight**: Use `config_flight_daq.toml`
