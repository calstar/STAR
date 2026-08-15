# DAQv2-Comms

The **wire protocol** for the Diablo DAQ system — the single source of truth for
every packet exchanged between the ESP32 avionics boards (`firmware/`) and the
ground DAQ server (`daq-server/`). It defines the packet types, the board/engine
state enums, and the serialize/parse routines both sides use, so the two never
drift out of sync.

Packaged as an Arduino library (`library.properties`, target `esp32`). It is
**vendored** into this monorepo — the firmware consumes it through a symlink at
`firmware/libraries/DAQv2-Comms`, and the daq-server builds it as the
`daqv2_comms` CMake target. It is *not* added as a git submodule.

## Overview

Boards and the server talk over UDP/Ethernet. Every message is a small,
**packed** binary struct: a 6-byte header followed by a type-specific body
(some bodies are variable-length). All multi-byte fields are sent in the
struct's native little-endian layout. The matching `create_*` (serialize) and
`parse_*` (deserialize) helpers are the only supported way to build and read
packets — don't hand-pack buffers.

```
┌─────────────── PacketHeader (6 bytes) ───────────────┐
│ packet_type : 1   version : 1   timestamp : 4 (ms)   │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
              type-specific body (fixed or variable length)
```

`version` is the protocol version (`DIABLO_COMMS_VERSION`, currently `0`).
Sizing limits live in `DAQv2-Comms.h`: up to `MAX_SENSORS_PER_BOARD` (10) and
`MAX_ACTUATORS_PER_BOARD` (10) per board, `MAX_CHUNKS_PER_PACKET` (10), and
`MAX_PACKET_SIZE` (512 bytes).

## Packet types

`PacketType` (`DiabloEnums.h`) — direction is board↔server:

| # | Type | Direction | Purpose |
|---|---|---|---|
| 1 | `BOARD_HEARTBEAT` | board → server | liveness; carries firmware SHA-256 hash, board ID, engine + board state |
| 2 | `SERVER_HEARTBEAT` | server → boards | liveness; broadcasts the current engine state |
| 3 | `SENSOR_DATA` | board → server | variable-length sensor readings (chunks of timestamped datapoints) |
| 4 | `ACTUATOR_COMMAND` | server → board | open/close actuator commands |
| 5 | `SENSOR_CONFIG` | server → board | which sensors a board owns + its identity |
| 6 | `ACTUATOR_CONFIG` | server → board | actuator mapping + abort response config |
| 7 | `ABORT` | server → boards | trigger abort |
| 8 | `ABORT_DONE` | board → server | abort sequence completed |
| 9 | `CLEAR_ABORT` | server → boards | release abort state |
| 10 | `PWM_ACTUATOR_COMMAND` | server → board | proportional (PWM duty) actuator command |
| 11 | `NO_CONNECTION_ABORT` | board ↔ board | autonomous abort on lost server link |
| 12 | `SELF_TEST` | board → server | startup self-test results (ADC, per-sensor) |
| 13 | `ENVIRONMENTAL_DATA` | board → server | temperature / environmental telemetry |
| 14 | `STACKLIGHT_COMMAND` | server → board | stacklight (status tower) control |

State enums travel inside several of these packets:

- **`BoardState`** — a board's own state machine: `SETUP`, `ACTIVE`,
  `CONNECTION_LOSS_DETECTED`, the abort variants (`NO_CONNECTION_ABORT`,
  `PT_ABORT`, `STANDALONE_ABORT`, …), `SELF_TEST`.
- **`EngineState`** — the system-wide state the server broadcasts to all boards:
  `SAFE`, `PRESSURIZING`, `LOX_FILL`, `FIRING`, `POST_FIRE`.

## Source layout

```
src/
├── DAQv2-Comms.h        # umbrella include + version & size constants
├── DiabloEnums.h        # PacketType, BoardState, EngineState
├── DiabloPackets.h      # packed on-wire structs (PacketHeader + bodies)
│                        #   and high-level collection structs (e.g.
│                        #   SensorDataChunkCollection) used before serializing
├── DiabloPacketUtils.h  # create_*() / parse_*() declarations
└── DiabloPacketUtils.cpp# their implementations
```

## Usage

Serialize into a caller-owned buffer, then send it:

```cpp
#include "DAQv2-Comms.h"
using namespace Diablo;

uint8_t buf[MAX_PACKET_SIZE];

// Board → server heartbeat
BoardHeartbeatPacket hb{};
hb.board_id     = BOARD_ID;
hb.engine_state = EngineState::SAFE;
hb.board_state  = BoardState::ACTIVE;
memcpy(hb.firmware_hash, FIRMWARE_HASH, 32);
size_t n = create_board_heartbeat_packet(hb, /*timestamp_ms=*/millis(), buf, sizeof(buf));
udp.write(buf, n);
```

Parse on receipt — every `parse_*` takes the raw buffer + length and returns
`false` if the buffer is malformed or too short:

```cpp
ServerHeartbeatPacket sh{};
if (parse_server_heartbeat_packet(buf, len, sh)) {
    engine_state = sh.engine_state;
}
```

`create_*` returns the number of bytes written (`0` on error, e.g. buffer too
small). See `DiabloPacketUtils.h` for the full set: heartbeats, sensor data,
sensor/actuator config, actuator commands (binary + PWM), abort, self-test,
environmental, and stacklight packets.

## Conventions

- On-wire structs are `__attribute__((packed))` — never add fields without
  bumping `DIABLO_COMMS_VERSION` and updating both firmware and server.
- The "collection" structs (e.g. `SensorDataChunkCollection`) are the
  ergonomic, *non-packed* representation used to assemble data before calling
  `create_sensor_data_packet`; only the packed structs go over the wire.
