# Actuator Pipeline & start_tmux_dev.sh

## start_tmux_dev.sh — What It Does

Launches the full stack in a single tmux session. Order matters:

| Pane | Component | Role |
|------|-----------|------|
| 0 | Elodin DB | Raw data storage (port 2240). **Single subscriber** rule: only the relay gets the stream |
| 1 | Elodin Relay | Connects to DB first (sleep 2s). Fans out TABLE packets to backend/sidecar via WS :9090 |
| 2 | Backend | Connects to relay, serves UI. Runs controller loop, sends actuator commands |
| 3 | DAQ Bridge | Listens UDP :5006, parses boards → Elodin. **Sends SERVER_HEARTBEAT** (see below) |
| 4 | Frontend | Next.js on :3000 |
| 5 | Sidecar | Python calibration_server (HTTP :8100, WS :8101) |
| 6 | Board Simulator | `board_simulator.py` → UDP :5006 (PT, actuator heartbeats, sensor data) |
| 7 | Calibration Service | C++ reads RAW from Elodin, writes CALIBRATED |
| 8 | Controller Service | C++ reads CALIBRATED, outputs PWM to actuators |
| 9 | Actuator Service | C++ TCP :9998. Receives `STATE:GSE\n`, sends UDP actuator commands |

**Routing:** When `actuator_service` is built and `ACTUATOR_SERVICE_ENABLED=true`:
- State transitions → backend sends `STATE:<name>\n` to TCP :9998 → actuator_service sends UDP.
- Backend does **not** send actuator UDP directly.

When actuator_service is **not** running:
- Backend sends actuator UDP directly to boards (port 5005).

---

## Actuator Pipeline — Messages Sent to Boards

Boards listen on **UDP port 5005**. All commands use the same 6-byte header:

```
packet_type (1B) | version (1B) | timestamp_ms (4B LE)
```

### 1. SERVER_HEARTBEAT (type 2) — from **daq_bridge** only

- **Who:** `daq_bridge` (not backend)
- **Where:** UDP **broadcast** to `server_heartbeat.broadcast_ip` (e.g. 192.168.2.255) on port 5005
- **Interval:** `server_heartbeat.interval_ms` (default 1000)
- **Format:** 7 bytes total: type=2, version=0, timestamp(4), engine_state(1)
- **Purpose:** Boards learn server IP for sending SENSOR_DATA and heartbeats

**Critical:** Backend comment says "SERVER_HEARTBEAT is owned by daq_bridge". Backend has `sendServerHeartbeatUDP()` but it's routed via the same socket for engine-state sync — the main heartbeat source is daq_bridge.

---

### 2. ACTUATOR_COMMAND (type 4) — from **backend** or **actuator_service**

- **Format:** Header(6) + num_commands(1) + [channel_id(1), state(1)] per command
- **State:** 0=OFF, 1=ON (after NC/NO conversion in backend)
- **Destination:** Unicast to each board IP:5005

**Path A — actuator_service:**  
`STATE:GSE\n` over TCP → actuator_service → `construct_actuator_command_packet()` → UDP to board IPs (from state_machine_actuators.csv)

**Path B — backend direct:**  
State transition → `applyActuatorsForState()` → `sendActuatorCommandUDP()` → UDP to board IPs

**NC/NO:** Backend converts GUI open/closed using `actuator_roles` (e.g. `["NO", 1, 12]`).  
Bug risk: Wrong NO/NC mapping flips valve states (e.g. LOX Press).

---

### 3. PWM_ACTUATOR_COMMAND (type 10) — from **controller_service** or **backend**

- **Format:** Header(6) + num_commands(1) + [channel_id(1), duration_ms(4), duty_cycle(4), frequency(4)] per command
- **When:** FIRE state — controller loop drives Fuel Press / LOX Press duty

**Path A — C++ controller:** controller_service reads CALIBRATED from Elodin, computes duty, sends UDP

**Path B — Backend:** `USE_CPP_CONTROLLER=false` → backend `controller-loop.ts` sends PWM via `sendPWMActuatorCommandUDP()`

---

### 4. ACTUATOR_CONFIG (type 6) — from **backend**

- **When:** First time an actuator board connects (heartbeat received)
- **Requires:** Exactly one board marked `designated_survivor: true` in config
- **Format:** Header(6) + is_abort_controller(1) + N(1) + N×[actuator_ip(4), actuator_id(1), vent_state(1), abort_state(1)] + X(1) + X×[pt_ip(4), sensor_id(1), threshold_adc(4)] + enable_serial(1)
- **Includes:** Abort actuator list, abort PT thresholds (from calibration inverse), designated survivor IP
- **Failure mode:** No designated survivor → `buildActuatorConfigPacket` returns null → config never sent

---

### 5. SENSOR_CONFIG (type 5) — from **backend**

- **When:** Sense board (PT, etc.) first connects via heartbeat
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

1. **Duplicate command sources:** Backend and actuator_service can both send actuator commands. With actuator_service enabled, backend should only forward state over TCP; if both send UDP, boards get conflicting commands.

2. **SERVER_HEARTBEAT targeting:** daq_bridge broadcasts to `broadcast_ip` (e.g. 192.168.2.255). If the network interface or subnet is wrong, boards never receive it and stay in “WaitingForServer”.

3. **ACTUATOR_CONFIG blocked:** Needs `designated_survivor` set for exactly one actuator board. Without it, actuator boards never get abort config and may not behave correctly.

4. **NC/NO in config:** `actuator_roles` must match hardware (e.g. `["NO", 1, 12]` vs `["NC", 1, 12]`). Incorrect type inverts valve logic.

5. **actuator_service board list:** C++ actuator_service parses only `boards.actuator_board` and `boards.actuator_board_2`. Additional actuator boards in config are ignored unless the code is extended.

6. **Port and IP mismatch:** Boards expect commands on 5005. Config `actuator_cmd_port` and `server_heartbeat.broadcast_port` must both be 5005 for the intended setup.

## State Change Flow (Frontend → Actuator Service)

When actuator_service is running and `ACTUATOR_SERVICE_ENABLED=true`:

1. User changes state in frontend (e.g. GSE → ARMED).
2. Frontend sends WebSocket command `{ commandType: 'state', data: { newState: 'ARMED' } }`.
3. Backend receives, validates transition, calls `forwardStateToActuatorService('ARMED', 9998)`.
4. Backend opens TCP to `127.0.0.1:9998`, sends `STATE:Armed\n`, closes.
5. actuator_service receives string, parses `state_machine_actuators.csv`, sends UDP ACTUATOR_COMMAND to each board IP from config.

Log line to confirm: `[ActuatorService] State ARMED → TCP :9998 (actuator_service will send UDP to boards)`.

## Tuning Spike Rejection (PT Data)

Env overrides for PSI jump limits (backend):

- `PSI_MAX_JUMP` — max allowed PSI jump for normal PTs (default 1000). Set higher to allow faster transients, lower to reject more aggressively.
- `HP_PT_MAX_JUMP` — for high-pressure 4-20mA PTs (default 500).

Example: `PSI_MAX_JUMP=2000 HP_PT_MAX_JUMP=1000 npm run dev`

## Parse Failures (Messages Not Read)

When `parseElodinPacket` returns null, backend logs `[Relay] TABLE packet not parsed #N (packetId=0xHH,0xLL, len=L)`. First 5 and every 100th are logged. Set `ELODIN_DEBUG=1` to log every failure. Common causes:

- Packet ID not handled in elodin-protocol.ts
- Payload too short for expected layout
- Entity map mismatch (channelToEntityMap not loaded from config)
