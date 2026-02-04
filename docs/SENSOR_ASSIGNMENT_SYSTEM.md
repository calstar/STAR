# Sensor Assignment and Configuration System

## Overview

The sensor assignment system manages the distribution of sensors to boards, IP assignment, and configuration distribution. The FSW (Flight Software) side assigns IP addresses and sensor configurations to boards, which then report back their assigned sensors.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              FSW Configuration Manager                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐      ┌──────────────┐                │
│  │   IP         │      │   Sensor    │                │
│  │ Assignment   │      │ Assignment  │                │
│  └──────┬───────┘      └──────┬───────┘                │
│         │                      │                        │
│         └──────────┬────────────┘                        │
│                    │                                    │
│         ┌──────────▼──────────┐                        │
│         │  Config Generator  │                        │
│         │  (SENSOR_CONFIG)   │                        │
│         └──────────┬──────────┘                        │
│                    │                                    │
│         ┌──────────▼──────────┐                        │
│         │   UDP Socket       │                        │
│         │   Send to Board    │                        │
│         └────────────────────┘                        │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
         ┌────────────────────┐
         │   Board (ESP32)    │
         │  Receives Config   │
         │  Configures Sensors│
         └────────────────────┘
```

## System States

### GSE (Ground Support Equipment)
- **Network**: `192.168.2.0/24`
- **IP Range**: `192.168.2.100-150`
- **Components**:
  - Pressurant Fill (PT_HPF, PT_MPF, PT_LPF)
  - Fuel Fill (PT_FF)
  - LOX Fill (PT_OF)

### FLIGHT (Rocket System)
- **Network**: `192.168.3.0/24`
- **IP Range**: `192.168.3.100-150`
- **Sensors**:
  - High Pressure (PT_HP)
  - COPV Post Regulator (PT_LP)
  - Fuel Upstream/Downstream (PT_FUP, PT_FDP)
  - Oxidizer Upstream/Downstream (PT_OUP, PT_ODP)

## Sensor Definitions

### Flight Pressure Sensors

| Sensor ID | Name | Max PSI | Purpose | Board | Channel |
|-----------|------|---------|---------|-------|---------|
| PT_HP | High Pressure PT | 5000 | High pressure reading | 0 | 0 |
| PT_LP | COPV PT Post Regulator | 1000 | COPV post regulator | 0 | 1 |
| PT_FUP | Upstream Fuel PT | 1000 | Fuel upstream | 1 | 0 |
| PT_FDP | Downstream Fuel PT | 1000 | Fuel downstream | 1 | 1 |
| PT_OUP | Upstream Oxidizer PT | 1000 | Oxidizer upstream | 2 | 0 |
| PT_ODP | Downstream Oxidizer PT | 1000 | Oxidizer downstream | 2 | 1 |

### GSE Pressure Sensors

| Sensor ID | Name | Max PSI | Purpose | Component | Board | Channel |
|-----------|------|---------|---------|-----------|-------|---------|
| PT_OF | LOX Fill PT | 1000 | LOX fill pressure | LOX Fill | 10 | 0 |
| PT_FF | Fuel Fill PT | 1000 | Fuel fill pressure | Fuel Fill | 11 | 0 |
| PT_HPF | High Pressure Fill PT | 5000 | High pressure fill | Pressurant Fill | 12 | 0 |
| PT_MPF | Medium Pressure Fill PT | 2000 | Medium pressure fill | Pressurant Fill | 12 | 1 |
| PT_LPF | Low Pressure Fill PT | 1000 | Low pressure fill | Pressurant Fill | 12 | 2 |

## IP Assignment Algorithm

IP addresses are assigned deterministically based on MAC address:

```cpp
// Hash MAC address
uint32_t mac_hash = hash_mac(mac_address);

// Choose IP range based on system state
if (system_state == GSE) {
    base_ip = "192.168.2.0";
    range = 100-150;
} else {
    base_ip = "192.168.3.0";
    range = 100-150;
}

// Calculate IP octet
ip_octet = range_start + (mac_hash % (range_end - range_start + 1));
assigned_ip = base_ip + "." + ip_octet;
```

**Benefits:**
- Same board always gets same IP
- Survives reboots
- No conflicts
- Works with static IPs too

## Configuration Packet Format

FSW sends `SENSOR_CONFIG` packets to boards:

```
PacketHeader (6 bytes):
  packet_type = SENSOR_CONFIG (5)
  version = 0
  timestamp = millis()

Body:
  num_sensors (1 byte)
  sensor_ids[] (N bytes, channel IDs)
  necessary_for_abort (1 byte)
  controller_ip (4 bytes, if necessary_for_abort)
```

**Example:**
- Board 0 (Flight): `[5, 0, timestamp, 2, 0, 1, 0]`
  - 2 sensors: channels 0, 1
  - Sensors: PT_HP (ch0), PT_LP (ch1)

## Workflow

### 1. Board Discovery
1. Board sends `BOARD_HEARTBEAT` packet
2. FSW receives heartbeat
3. FSW assigns IP address based on MAC
4. FSW assigns sensors based on board_id and system state

### 2. Configuration Distribution
1. FSW generates `SENSOR_CONFIG` packet
2. FSW sends packet to board's assigned IP
3. Board receives config and configures sensors
4. Board sends acknowledgment (optional)

### 3. Sensor Data Collection
1. Board reads sensors according to configuration
2. Board sends `SENSOR_DATA` packets
3. DAQ Bridge receives and routes to Elodin
4. Data appears in Elodin editor

## Usage Example

```cpp
// Initialize FSW config manager
fsw::FSWConfigManager fsw_config;
fsw_config.initialize("0.0.0.0", 5008);
fsw_config.set_system_state(config::SystemState::GSE);

// Process board heartbeat
auto heartbeat = parse_board_heartbeat(packet_data, packet_size);
std::string assigned_ip = fsw_config.process_board_heartbeat(
    heartbeat, source_ip, mac_address);

// Manually assign sensors (optional)
fsw_config.assign_sensors(10, {"PT_OF"}, 0);

// Send config to board
fsw_config.send_config_to_board(10);
```

## Configuration File Structure

```toml
[system]
state = "GSE"  # or "FLIGHT"

[system.gse]
base_ip = "192.168.2.0"
ip_range_start = 100
ip_range_end = 150

[system.flight]
base_ip = "192.168.3.0"
ip_range_start = 100
ip_range_end = 150

[sensors.flight.pt]
PT_HP = { board_id = 0, channel = 0, max_psi = 5000 }
PT_LP = { board_id = 0, channel = 1, max_psi = 1000 }
# ... etc

[sensors.gse.pt]
PT_OF = { board_id = 10, channel = 0, max_psi = 1000, component = "lox_fill" }
# ... etc
```

## Next Steps

1. **Actuators**: Add actuator assignments
2. **RTDs**: Add RTD sensor assignments
3. **TCs**: Add thermocouple assignments
4. **LCs**: Add load cell assignments
5. **Validation**: Verify sensor assignments match hardware
6. **Error Handling**: Robust error handling for failed assignments
7. **Persistence**: Save assignments to config file

