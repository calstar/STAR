# Flight-computer Ethernet to DAQ

The flight computer now has a W5500 UDP transport and a DAQv2 packet producer. `app_start()` starts the network task after chip bring-up, when a deployment supplies an enabled configuration. Sensor and GNSS tasks copy selected fields into a 16-entry queue without waiting. Their eMMC logging continues independently.

**Deployment is incomplete.** Issue [#180](https://github.com/calstar/STAR/issues/180) proposes board ID 81, board address 192.168.2.81:5005 and server 192.168.2.20:5006. The default configuration now stores these values and derives a local unicast MAC from the STM32 UID, but keeps networking disabled pending Inez's sign-off and the remaining protocol/server work. The DAQ server currently lacks a flight-computer board type: its unknown-board fallback interprets sensor packets as PT data. Do not enable this sender on the shared DAQ until server routing and calibration match the agreed flight channels. This change does not add that routing or a dashboard.

## Protocol and driver

The wire format is `lib/daq-protocol`, protocol version **0**, also used by the other boards:

- `BOARD_HEARTBEAT` (1): 41 bytes, sent once per second. SETUP until a valid sensor configuration arrives; ACTIVE afterwards. The configured hash occupies the existing 32-byte hash field; zero means no hash supplied, not a verified image.
- `SENSOR_DATA` (3): the six-byte header, one chunk, and selected `(channel:uint8, value:uint32)` pairs. Integers and millisecond timestamps are little-endian. Record timestamps use the board millisecond clock at the producer handoff; the eMMC records retain their original microsecond acquisition timestamps.
- `SERVER_HEARTBEAT` (2) and `SENSOR_CONFIG` (5): accepted through the discovery/pinning policy below, with exact length/version checks. Configuration selects channels 1–10 from the configured source map. Duplicate, unknown or unmapped channels are rejected. The reference-voltage byte does not change the flight sensors. Configurations requiring abort-controller participation are rejected. The print-mode byte is validated but does not enable a console or log stream.

Ten seconds without a valid server packet clears configuration and stops sensor transmission. With `discover_server` enabled, heartbeats initially go to 255.255.255.255:5006. The first valid SERVER_HEARTBEAT or supported SENSOR_CONFIG pins the server IP; foreign hosts cannot replace it until expiry or interface reconnection. On expiry heartbeats return to broadcast. Invalid packets and unsupported configurations cannot claim the server or extend its lifetime. Discovery provides no authentication; use it only on the agreed bench network. Setting `discover_server = false` retains fixed-server filtering. A changed channel selection drops pending samples. Network commands never dispatch actuator or flight-state operations. Packet compatibility does not confer command compatibility with a hotfire actuator board.

`chips/w5500_udp.c` implements socket 0 in UDP mode, with 2 KiB RX/TX rings, stable reads of hardware counters, split ring-wrap transfers, whole-datagram receive and asynchronous SEND_OK/TIMEOUT handling. The task owns SPI2 access through `board_spi`, with a shared 20 ms deadline per service iteration. It retries interface setup after one second on bus/link/send failure. Unsent data and samples older than one second are dropped. A full producer queue drops the new sample. There is no retransmission or delivery acknowledgement at the DAQ application level.

The driver uses static IPv4 configuration. DHCP, address discovery, OTA and Ethernet self-test-report transmission are outside this change. It does not change CubeMX pins, clocks or the reset sequence. SPI2 is mode 0; the board layer selects ETH_CS and releases it on both success and failure.

Sources: [W5500 datasheet v1.1.0](https://docs.wiznet.io/img/products/w5500/W5500_ds_v110e.pdf), the [component list](https://starberkeley.notion.site/Flight-Computer-components-3be50d7304ab806498d3cb20449516c2), and the newer board facts in [STM32-UPLOAD-REQUIREMENTS.md](STM32-UPLOAD-REQUIREMENTS.md) and [issue #137](https://github.com/calstar/STAR/issues/137). The component list does not assign network addresses or DAQ channels; its older battery/GNSS descriptions do not override the confirmed board notes.

## Deployment configuration

The disabled default hook now follows the proposal in #180. This supersedes the earlier user-provided local `.20:5006` placeholder: `.20:5006` belongs to the **server**, while the proposed **board** is `.81:5005`. These remain proposed values, not approval to connect the board.

The MAC uses FNV-1a-64 over all twelve UID bytes (each word least-significant byte first), retains the low six bytes, clears the multicast bit and sets the locally-administered bit. It is deterministic, but compressing 96 bits into 46 address bits cannot guarantee uniqueness. Read the resulting `config.network.mac` in the debugger, check for a collision, and register that exact value in the deployed `[boards.*].mac` and bench reservations. No physical board UID has been read here. The default gateway remains zero because no router was assigned; the proposed server is on the local /24.

Provide a strong definition of `daq_board_config()` in a hand-written `app/*.c` file. PlatformIO includes it automatically. Assign:

| Field | Required value |
|---|---|
| `enabled` | `true` only for the configured deployment |
| `board_id` | Proposed 81; awaiting sign-off |
| `network.mac` | UID-derived local unicast MAC; register and collision-check |
| `network.ip` | Proposed `192.168.2.81` |
| `network.subnet`, `network.gateway` | `255.255.255.0`; zero gateway for local subnet |
| `network.port` | Proposed board receive port `5005` |
| `server_ip`, `server_port` | Proposed `192.168.2.20:5006`; discovery may learn a different IP |
| `discover_server` | Default true: broadcast, learn, pin, expire after 10 seconds |
| `firmware_hash` | Build hash if available; otherwise zero |
| `sources[0..9]` | Source for channel 1 through 10; unused entries `DAQ_NONE` |

The other hotfire boards commonly send to port 5006. Read the active profile for the board receive port and endpoint; the legacy `config_flight_daq.toml` is not evidence of an assigned address for this board. Static addresses need reservations/exclusions in the ground DHCP configuration to avoid collisions. The current driver still opens directly with the static address. A DHCP client, lease renewal and the five-second fallback requested in #180 remain to be implemented.

Source choices are in `app/daq_records.h`. They include IMU temperature, gyro and acceleration axes; high-g axes; barometer temperature and pressure; GNSS latitude, longitude, altitude, N/E/D velocity, fix type and satellite count. Select at most ten sources for this board's DAQ channels. Each record emits only its own selected fields, so a new IMU sample does not replay stale GPS data. Wider channel inventories require an agreed protocol/server extension.

Values retain the units in `app/records.h`: raw signed sensor counts, barometer centidegrees C and Pa, latitude/longitude in 1e-7 degrees, GNSS altitude in mm and velocity in mm/s. Signed quantities use sign-extended two's-complement `uint32_t` values on the wire. The server must decode these types before applying units. `daq_publish()` also accepts a caller-supplied channel/value sample when another producer needs the transport.

## Remaining implementation from issue #180

- **Protocol decision:** Inez's checklist still leaves Option A (`FLIGHT_DATA`) versus Option B (the existing ten-channel SENSOR_DATA path) unchecked. The firmware still uses Option B. Do not describe it as a complete Option A implementation.
- **Option A wire contract:** allocate a packet type in `lib/daq-protocol`, define explicit record framing/versioning and batching, and preserve each record's microsecond timestamp and signed values. The actual record header is `app/records.h`, not `src/app/records.h`. REC_HEALTH is only a type constant; there is no health payload layout or producer yet. Specify its fields before adding a decoder. Keep the Ethernet SELF_TEST handshake separate from the existing radio SelfTest frame.
- **Rates and batching:** the proposed IMU/high-g/baro/GNSS rates produce 3,590 payload bytes/s before health records and framing (18×100 + 7×100 + 12×50 + 49×10). Ten packets/s therefore requires batching and producer decimation. The existing 16-entry queue stores individual samples, so it needs a deliberate buffering design for approximately 26 non-health records per 100 ms batch. Full-rate eMMC logging must remain unchanged.
- **DHCP:** implement discovery/request, validate replies and lease timing, select static .81 after five seconds without a lease, and define renewal/rebinding behavior. No DHCP traffic is implemented by server discovery.
- **DAQ routing:** add the flight board kind and wire identity, an explicitly selected profile entry, the proposed Elodin 0x26 schema, FLIGHT_DATA parsing if Option A is approved, and backend/frontend decoding. The profile must contain the measured MAC; do not invent a reservation. No live profile was changed here.
- **Handshake:** implement the matching config-broadcast case and agree how a flight-only bench profile gets configuration when the service currently requires a designated-survivor actuator. Do not silently remove that condition for hotfire profiles. The current sender goes SETUP→ACTIVE on accepted SENSOR_CONFIG; the network SELF_TEST stage proposed by #180 is still missing.
- **Approval and hardware:** #180 requires sign-off before enablement. After implementation, validate DHCP/static fallback, server loss/rediscovery, real DAQ values, ignored actuator/abort traffic and queue pressure. Run server checks hermetically, per `daq-server/CLAUDE.md`.

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
