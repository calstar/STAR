# Configuration Files

This directory holds the DAQ server configuration. For the full flight-vs-ground
configuration walkthrough (operational modes, sensor assignments, config
structure), see [`../docs/CONFIGURATION_GUIDE.md`](../docs/CONFIGURATION_GUIDE.md).

## Files

| File | Purpose |
|------|---------|
| `config.toml` | Base config with all sections documented; the default dev config. |
| `config_flight_daq.toml` | Flight DAQ — flight sensors/actuators. Network `192.168.3.0/24`. |
| `config_ground_daq.toml` | Ground DAQ — GSE sensors + hotfire. Network `192.168.2.0/24`. |
| `config_sitl.toml` | Software-in-the-loop config. |
| `system_config.json` | Runtime system state snapshot. |
| `state_transitions.csv` | Allowed engine state transitions. |
| `state_machine_actuators.csv` | Actuator positions per state. |
| `state_machine_actuator_delays.csv` | Per-actuator delays applied on transitions. |
| `countdown_state.json` | Persisted countdown state. |

## Usage

```bash
# Ground DAQ (development / hotfire)
./build/bin/daq_bridge config/config_ground_daq.toml

# Flight DAQ (flight operations)
./build/bin/daq_bridge config/config_flight_daq.toml
```

During hotfire, set `[hotfire].enabled = true` in `config_ground_daq.toml` to
route all sensors (including flight sensors) to the ground DAQ.

## Ports (from `config.toml`)

- `5006` — sensor data (boards → bridge)
- `5005` — control/broadcast (bridge → boards: heartbeats, actuator commands)
- `2240` — Elodin DB

(The split `config_*_daq.toml` files set `[system.network] bind_port = 5005`.)
