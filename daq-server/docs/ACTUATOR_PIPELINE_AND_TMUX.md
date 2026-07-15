# Actuator Pipeline & start_tmux_dev.sh

## start_tmux_dev.sh — What It Does

Launches the full stack in a single tmux session (`deploy/startup/start_tmux_dev.sh`),
using the **thin backend** (`server.ts` connects directly to the Elodin DB — no
relay). The legacy monolithic backend lives in `start_tmux_dev_legacy.sh`. Panes
are created left-to-right in this order:

| Pane | Component | Role |
|------|-----------|------|
| 0 | Board Simulator | `sim/board_simulator.py` → UDP :5006. **Disabled** unless `USE_SIM=1` |
| 1 | DAQ Bridge | `build/bin/daq_bridge` — listens UDP :5006, parses boards → Elodin |
| 2 | Elodin DB | `elodin-db run [::]:2240` — raw + calibrated data land here |
| 3 | Calibration Service | `build/bin/calibration_service` — reads RAW from Elodin, writes CALIBRATED |
| 4 | Backend | `server.ts` (tsx) — HTTP+WS on :8081, connects directly to Elodin DB :2240 |
| 5 | Frontend | Next.js (`npm run dev`) on :3000 |
| 6 | Heartbeat Service | `build/bin/heartbeat_service` (C++ preferred, Python fallback) — broadcasts SERVER_HEARTBEAT |
| 7 | Config Broadcast Service | `build/bin/config_broadcast_service` — sends ACTUATOR_CONFIG/SENSOR_CONFIG |
| 8 | Sequencer Service | `build/bin/sequencer_service` — TCP :9998 command/actuator service |
| 9 | OTA Service | `build/bin/ota_service` — TCP :9997 (Ethernet OTA flash) |
| 10 | Controller Service | `build/bin/controller_service` — reads CALIBRATED, outputs PWM to actuators |

Notes:
- All binaries build into `build/bin/`.
- The data logger and the legacy Elodin relay / Python calibration sidecar are
  **not** part of this stack (they exist only in `start_tmux_dev_legacy.sh` /
  `start_web_gui.sh`).
- The backend's `ACTUATOR_SERVICE_PORT` (default 9998) points at the
  **sequencer_service** TCP command port.

**Command routing:** state transitions and manual actuator commands go from the
frontend → backend (WS) → **sequencer_service** over TCP :9998 as text commands
(`TRANSITION:`, `ACTUATOR:`, …). The sequencer's `ActuatorCommander`
(`diablo_server/services/sequencer/ActuatorCommander.cpp`) sends the UDP
ACTUATOR_COMMAND packets to boards. The thin backend does **not** send actuator
UDP directly.

---

## Actuator Pipeline — Messages Sent to Boards

Boards listen on **UDP port 5005**. All commands use the same 6-byte header:

```
packet_type (1B) | version (1B) | timestamp_ms (4B LE)
```

### 1. SERVER_HEARTBEAT (type 2) — from **heartbeat_service** (preferred) or **daq_bridge**

- **Who:** `heartbeat_service` (`build/bin/heartbeat_service`, C++ preferred; Python fallback `archive/legacy/python-services/heartbeat_service.py`). `daq_bridge` also sends one (engine_state=0) when running.
- **Where:** UDP **broadcast** to `server_heartbeat.broadcast_ip` (e.g. 192.168.2.255) on port 5005
- **Interval:** `server_heartbeat.interval_ms` (default 1000)
- **Format:** 7 bytes total: type=2, version=0, timestamp(4), engine_state(1)
- **Purpose:** Boards learn server IP and engine state; watchdog for connection loss

**Modular:** The thin backend does **not** send SERVER_HEARTBEAT — `heartbeat_service` does (started by `start_tmux_dev.sh`).

---

### 2. ACTUATOR_COMMAND (type 4) — from **sequencer_service**

- **Format:** Header(6) + num_commands(1) + [channel_id(1), state(1)] per command
- **State:** 0=OFF, 1=ON (after NC/NO conversion)
- **Destination:** Unicast to each board IP:5005

**Path:** state transition → backend sends `TRANSITION:<csvName>\n` over TCP :9998 →
`sequencer_service` → `ActuatorCommander` (`diablo_server/services/sequencer/ActuatorCommander.cpp`,
`construct_actuator_command_packet()`) → UDP to board IPs. The board IPs and
actuator-role mapping come from `[boards.*]` and `[actuator_roles]` in
`config/config.toml`; the per-state actuator positions come from
`config/state_machine_actuators.csv`.

**NC/NO:** open/closed is converted using `actuator_roles` (e.g. `["NO", 1, 12]`).
Bug risk: wrong NO/NC mapping flips valve states (e.g. LOX Press).

---

### 3. PWM_ACTUATOR_COMMAND (type 10) — from **controller_service**

- **Format:** Header(6) + num_commands(1) + [channel_id(1), duration_ms(4), duty_cycle(4), frequency(4)] per command
- **When:** FIRE state — `controller_service` reads CALIBRATED data from Elodin,
  computes Fuel Press / LOX Press duty, and sends the PWM commands over UDP.

---

### 4. ACTUATOR_CONFIG (type 6) — from **config_broadcast_service**

- **When:** An actuator board first connects (heartbeat received)
- **Requires:** Exactly one board marked `designated_survivor = true` in config
- **Format:** Header(6) + is_abort_controller(1) + N(1) + N×[actuator_ip(4), actuator_id(1), vent_state(1), abort_state(1)] + X(1) + X×[pt_ip(4), sensor_id(1), threshold_adc(4)] + enable_serial(1)
- **Includes:** Abort actuator list, abort PT thresholds (from calibration inverse), designated survivor IP
- **Failure mode:** No designated survivor → config packet not built → config never sent

(Sent by `diablo_server/services/config_broadcast/config_broadcast_service_main.cpp`.)

---

### 5. SENSOR_CONFIG (type 5) — from **config_broadcast_service**

- **When:** A sense board (PT, etc.) first connects via heartbeat
- **Format:** num_sensors, sensor_ids, reference_voltage, necessary_for_abort, controller_ip (if abort), enable_serial

---

### 6. ABORT (type 7) — from **backend**

- **When:** State transitions to ENGINE_ABORT, GSE_ABORT, EMERGENCY_ABORT, or ABORT
- **Format:** Header only (6 bytes)
- **Destination:** Broadcast to 255.255.255.255:5005 (or config broadcast_ip)

---

### 7. ABORT_DONE (type 8) — from **backend**

- **When:** 3 seconds after ABORT
- **Format:** Header only

---

## Likely Issue Areas

1. **SERVER_HEARTBEAT targeting:** the heartbeat broadcasts to `broadcast_ip` (e.g. 192.168.2.255). If the network interface or subnet is wrong, boards never receive it and stay in "WaitingForServer".

2. **ACTUATOR_CONFIG blocked:** needs `designated_survivor = true` set for exactly one actuator board. Without it, actuator boards never get abort config and may not behave correctly.

3. **NC/NO in config:** `actuator_roles` must match hardware (e.g. `["NO", 1, 12]` vs `["NC", 1, 12]`). Incorrect type inverts valve logic.

4. **Port and IP mismatch:** boards expect commands on 5005. Config `actuator_cmd_port` and `server_heartbeat.broadcast_port` must both be 5005 for the intended setup.

## State Change Flow (Frontend → Sequencer)

1. User changes state in frontend (e.g. GSE → ARMED).
2. Frontend sends a WebSocket command to the backend.
3. Backend validates the transition and calls `sendToActuatorService("TRANSITION:<csvName>\n")` (`diablo_server/backend/src/server.ts`).
4. Backend opens TCP to `127.0.0.1:9998` (the `sequencer_service` command port), sends the line, and reads `OK\n` / `ERR:<reason>\n`.
5. `sequencer_service` looks up the per-state actuator positions from `config/state_machine_actuators.csv` and sends UDP ACTUATOR_COMMAND packets to each board IP from config.

The sequencer's TCP text protocol verbs are `TRANSITION:<state>`, `ACTUATOR:<role>:<0|1>`, `DEBUG_MODE:<0|1>`, `EXTEND_FIRE`, and `RELOAD_CONFIG` (see `diablo_server/services/sequencer/sequencer_main.cpp`).

## Parse Failures (Messages Not Read)

When `parseElodinPacket` returns null, the backend logs that a TABLE packet was not parsed (with the `packetId` and length). Set `ELODIN_DEBUG=1` to log every failure. Common causes:

- Packet ID not handled in elodin-protocol.ts
- Payload too short for expected layout
- Entity map mismatch (channelToEntityMap not loaded from config)
