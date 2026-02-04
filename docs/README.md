# Documentation

## Essential Documentation

### System Architecture
- **DIABLOAVIONICS_PACKET_FORMAT.md** - Actual DiabloAvionics packet format (6-byte header, little-endian)
- **DIABLOAVIONICS_ANALYSIS.md** - Complete analysis of DiabloAvionics and DAQv2-Comms systems
- **SENSOR_ASSIGNMENT_SYSTEM.md** - Sensor assignment, IP assignment, and configuration distribution
- **CONFIGURATION_GUIDE.md** - Flight DAQ vs Ground DAQ configuration guide
- **ELODIN_GROUNDSTATION_SETUP.md** - Elodin database and ground station setup
- **CLEANUP_SUMMARY.md** - Summary of cleanup and reorganization

### Configuration
- **config/README.md** - Configuration file documentation

## Quick Reference

### Flight DAQ (`config_flight_daq.toml`)
- **Network**: `192.168.3.0/24` (IP range 100-150)
- **Handles**: Flight sensors and actuators during flight
- **Sensors**: PT_HP, PT_LP, PT_FUP, PT_FDP, PT_OUP, PT_ODP
- **Use**: Flight operations
- **During Hotfire**: Everything connects to ground DAQ instead

### Ground DAQ (`config_ground_daq.toml`)
- **Network**: `192.168.2.0/24` (IP range 100-150)
- **Handles**: GSE sensors, and during hotfire (ALL sensors connect here)
- **Sensors**: PT_OF, PT_FF, PT_HPF, PT_MPF, PT_LPF
- **Use**: Development, testing, hotfire
- **During Flight**: Flight sensors/actuators go to flight DAQ, everything else stays here

## Usage

```bash
# Ground DAQ (development/hotfire)
./build/daq_comms/daq_bridge config/config_ground_daq.toml

# Flight DAQ (flight operations)
./build/daq_comms/daq_bridge config/config_flight_daq.toml

# Hotfire Mode: Set hotfire.enabled = true in config_ground_daq.toml
```

## Operational Modes

1. **Development**: Use Ground DAQ config
2. **Hotfire**: Use Ground DAQ config with `hotfire.enabled = true` (all sensors)
3. **Flight**: Use Flight DAQ for flight sensors, Ground DAQ for GSE sensors

