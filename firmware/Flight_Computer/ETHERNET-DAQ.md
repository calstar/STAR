# Flight-computer Ethernet to DAQ

The flight computer now has a W5500 UDP transport and a DAQv2 packet producer. `app_start()` starts the network task after chip bring-up, when a deployment supplies an enabled configuration. Sensor and GNSS tasks copy selected fields into a 16-entry queue without waiting. Their eMMC logging continues independently.

**Deployment is incomplete.** The default configuration disables networking. We still need the board's assigned MAC/IP, board ID, DAQ endpoint and channel schema. The DAQ server currently lacks a flight-computer board type: its unknown-board fallback interprets sensor packets as PT data. Do not enable this sender on the shared DAQ until server routing and calibration match the agreed flight channels. This change does not add that routing or a dashboard.

## Protocol and driver

The wire format is `lib/daq-protocol`, protocol version **0**, also used by the other boards:

- `BOARD_HEARTBEAT` (1): 41 bytes, sent once per second. SETUP until a valid sensor configuration arrives; ACTIVE afterwards. The configured hash occupies the existing 32-byte hash field; zero means no hash supplied, not a verified image.
- `SENSOR_DATA` (3): the six-byte header, one chunk, and selected `(channel:uint8, value:uint32)` pairs. Integers and millisecond timestamps are little-endian. Record timestamps use the board millisecond clock at the producer handoff; the eMMC records retain their original microsecond acquisition timestamps.
- `SERVER_HEARTBEAT` (2) and `SENSOR_CONFIG` (5): accepted only from the configured server IP, with exact length/version checks. Configuration selects channels 1–10 from the configured source map. Duplicate, unknown or unmapped channels are rejected. The reference-voltage byte does not change the flight sensors. Configurations requiring abort-controller participation are rejected. The print-mode byte is validated but does not enable a console or log stream.

Five seconds without a valid server packet clears configuration and stops sensor transmission. Board heartbeats continue. A changed channel selection drops pending samples. Network commands never dispatch actuator or flight-state operations. Packet compatibility does not confer command compatibility with a hotfire actuator board.

`chips/w5500_udp.c` implements socket 0 in UDP mode, with 2 KiB RX/TX rings, stable reads of hardware counters, split ring-wrap transfers, whole-datagram receive and asynchronous SEND_OK/TIMEOUT handling. The task owns SPI2 access through `board_spi`, with a shared 20 ms deadline per service iteration. It retries interface setup after one second on bus/link/send failure. Unsent data and samples older than one second are dropped. A full producer queue drops the new sample. There is no retransmission or delivery acknowledgement at the DAQ application level.

The driver uses static IPv4 configuration. DHCP, address discovery, OTA and Ethernet self-test-report transmission are outside this change. It does not change CubeMX pins, clocks or the reset sequence. SPI2 is mode 0; the board layer selects ETH_CS and releases it on both success and failure.

Sources: [W5500 datasheet v1.1.0](https://docs.wiznet.io/img/products/w5500/W5500_ds_v110e.pdf), the [component list](https://starberkeley.notion.site/Flight-Computer-components-3be50d7304ab806498d3cb20449516c2), and the newer board facts in [STM32-UPLOAD-REQUIREMENTS.md](STM32-UPLOAD-REQUIREMENTS.md) and [issue #137](https://github.com/calstar/STAR/issues/137). The component list does not assign network addresses or DAQ channels; its older battery/GNSS descriptions do not override the confirmed board notes.

## Deployment configuration

The default hook now stores the user-provided bench placeholder **192.168.2.20:5006** as the board's local IPv4 address and UDP receive port. This is a stand-in, not a confirmed reservation. It is not the DAQ server address. The server endpoint, board ID, MAC, subnet/gateway and channel mapping still need configuration; `enabled` remains false. A strong deployment override replaces the entire hook, so it must retain these local values if the bench uses them.

Provide a strong definition of `daq_board_config()` in a hand-written `app/*.c` file. PlatformIO includes it automatically. Assign:

| Field | Required value |
|---|---|
| `enabled` | `true` only for the configured deployment |
| `board_id` | Team-assigned ID, nonzero |
| `network.mac` | Unique unicast MAC; W5500 has no factory MAC |
| `network.ip` | Placeholder `192.168.2.20`; confirm before deployment |
| `network.subnet`, `network.gateway` | Bench network settings, still unassigned |
| `network.port` | Placeholder `5006`; confirm against the active DAQ profile |
| `server_ip`, `server_port` | DAQ host and sensor listener port from that profile |
| `firmware_hash` | Build hash if available; otherwise zero |
| `sources[0..9]` | Source for channel 1 through 10; unused entries `DAQ_NONE` |

The other hotfire boards commonly send to port 5006. Read the active profile for the board receive port and endpoint; the legacy `config_flight_daq.toml` is not evidence of an assigned address for this board. Static addresses need reservations/exclusions in the ground DHCP configuration to avoid collisions.

Source choices are in `app/daq_records.h`. They include IMU temperature, gyro and acceleration axes; high-g axes; barometer temperature and pressure; GNSS latitude, longitude, altitude, N/E/D velocity, fix type and satellite count. Select at most ten sources for this board's DAQ channels. Each record emits only its own selected fields, so a new IMU sample does not replay stale GPS data. Wider channel inventories require an agreed protocol/server extension.

Values retain the units in `app/records.h`: raw signed sensor counts, barometer centidegrees C and Pa, latitude/longitude in 1e-7 degrees, GNSS altitude in mm and velocity in mm/s. Signed quantities use sign-extended two's-complement `uint32_t` values on the wire. The server must decode these types before applying units. `daq_publish()` also accepts a caller-supplied channel/value sample when another producer needs the transport.

## Verification

From the repository root:

```sh
cmake -S firmware/Flight_Computer/tests/ethernet -B /tmp/star-ethernet -DSELF_TEST_SANITIZERS=ON
cmake --build /tmp/star-ethernet
ctest --test-dir /tmp/star-ethernet --output-on-failure
pio run -d firmware/Flight_Computer -e flight
```

Host tests compare sensor and heartbeat bytes against the shared DAQ library and parse them with its production parser. They exercise signed record conversion, configuration validation, millisecond rollover, UDP ring and pointer wrap, short buffers, malformed receive lengths, unstable hardware counters, bus failures, task queue saturation, source-IP filtering, send timeout and cable loss. The task tests compile the production task against fake CMSIS queues and SPI transactions. These tests do not establish Ethernet signal integrity, actual scheduling margins, packet loss at full sensor rate or ingestion into the live database.

Before declaring the task complete on hardware:

1. Confirm the address and channel contract, and add the matching DAQ routing without the PT fallback.
2. Build and flash according to `STM32-UPLOAD-REQUIREMENTS.md` on the isolated bench network.
3. Confirm heartbeat/config exchange and the selected sensor values at the DAQ receiver. Check negative gyro/GNSS values and millisecond timestamps.
4. Unplug/reconnect Ethernet and restart the server. Confirm recovery, continued sensor acquisition/eMMC logging, and no stale telemetry replay.
5. Measure packet loss, queue pressure, SPI service time and task stack high-water use at the intended sensor rates. Check the RTOS heap after adding the queue and task.
