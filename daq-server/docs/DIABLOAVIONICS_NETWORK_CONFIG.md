# DiabloAvionics Network Configuration

How the ESP32 avionics boards and the DAQ bridge are addressed on the wire. For
the packet layout itself (header, packet types, serialize/parse helpers) see the
wire-protocol source of truth: [`../../lib/DAQv2-Comms/README.md`](../../lib/DAQv2-Comms/README.md).

## Network layout

Boards and the DAQ server live on a dedicated Ethernet subnet (the DAQ
interface), separate from any WiFi/management network.

- **Ground DAQ**: `192.168.2.0/24` (see `config/config_ground_daq.toml`)
- **Flight DAQ**: `192.168.3.0/24` (see `config/config_flight_daq.toml`)

Board IPs are assigned per board type in `config/config.toml` under
`[boards.*]`. The current ground-DAQ scheme is:

| Board type | Example IPs (`[boards.*]`) |
|------------|----------------------------|
| PT (pressure transducer) | `192.168.2.21`, `192.168.2.22` |
| ACTUATOR | `192.168.2.11`–`192.168.2.14` |
| LC (load cell) | `192.168.2.41`, `192.168.2.42` |
| TC (thermocouple) | `192.168.2.51`, `192.168.2.52` |
| RTD | `192.168.2.31`, `192.168.2.32` |

Each board entry sets `type` and `ip`; see `config/README.md` for the full
schema.

## Ports

All ports come from `config/config.toml`:

- **`sensor_port = 5006`** — boards send `SENSOR_DATA` / `BOARD_HEARTBEAT` here;
  the DAQ bridge binds `bind_ip:sensor_port` (default `0.0.0.0:5006`).
- **`broadcast_port = 5005`** — boards listen here for control packets
  (`SERVER_HEARTBEAT`, `ACTUATOR_COMMAND`, `ABORT`, …). The server broadcasts to
  `broadcast_ip` (default `192.168.2.255`, the subnet broadcast — avoids WiFi
  routing of `255.255.255.255`).
- **`actuator_cmd_port = 5005`** — actuator command destination port on boards.

## DAQ bridge setup

The bridge reads its bind address and port from the config, but both can be
overridden positionally:

```bash
# config-driven (uses bind_ip / sensor_port from the TOML)
./build/bin/daq_bridge config/config.toml

# explicit bind address + port
./build/bin/daq_bridge config/config.toml 0.0.0.0 5006
```

The interface is auto-detected: `network_interface = "auto"` in `config.toml`
selects the interface holding a `192.168.2.x` address, so it no longer matters
whether the NIC is `eth0`, `enxXXXXXXXX`, etc.

To talk to boards, the host must have an address on the board subnet:

```bash
sudo ip addr add 192.168.2.20/24 dev <interface>
```

## Troubleshooting: no packets received

1. **Host IP on the board subnet?**
   ```bash
   ip addr show | grep 192.168.2
   ```
2. **Bridge listening on the right port?**
   ```bash
   sudo ss -ulnp | grep 5006
   ```
3. **Board reachable / in ARP table?**
   ```bash
   arp -a | grep 192.168.2
   ```
4. **Wrong port** — boards send to `5006`; if a board's firmware targets a
   different port, fix the firmware or override the bridge port (arg 3 above).
5. **Wrong interface** — handled by `network_interface = "auto"`; if it
   misfires, set `subnet`/the bind IP explicitly in `config.toml`.

## See also

- [`../../lib/DAQv2-Comms/README.md`](../../lib/DAQv2-Comms/README.md) — wire
  protocol (packet types, header, serialize/parse).
- [SENSOR_ASSIGNMENT_SYSTEM.md](SENSOR_ASSIGNMENT_SYSTEM.md) — how board IPs map
  to sensors and how config is distributed.
- [ADC_AND_ELODIN_DIAGNOSTICS.md](ADC_AND_ELODIN_DIAGNOSTICS.md) — diagnosing
  data that arrives at the bridge but not Elodin.
