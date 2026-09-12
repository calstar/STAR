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

## Board registry (`[boards.*]`) and DHCP

Each `[boards.*]` entry pins a board's `ip` (always `192.168.2.<board_id>`) and
`board_id`. It also carries a `mac` field:

```toml
[boards.pt_board]
ip  = "192.168.2.21"
mac = "aa:bb:cc:dd:ee:ff"   # lowercase, colon-separated; blank = no static lease yet
board_id = 21
```

`mac` is the single source of truth for the board's **DHCP static reservation**
served by `star-dhcp` (`../deploy/dhcp/README.md`). A blank `mac` means the board
has no reservation yet and will pull a dynamic-pool address — read its MAC from
the lease table, fill it in here, and run `deploy/dhcp/reload_dhcp.sh`. The IP is
handed out unchanged, so filling in `mac` never renumbers a board.

## Ports (from `config.toml`)

- `5006` — sensor data (boards → bridge)
- `5005` — control/broadcast (bridge → boards: heartbeats, actuator commands)
- `2240` — Elodin DB

(The split `config_*_daq.toml` files set `[system.network] bind_port = 5005`.)
