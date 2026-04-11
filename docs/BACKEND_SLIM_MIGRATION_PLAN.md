# Backend Slim Migration Plan

Strip the Node.js backend of business logic; move it to C++ (FSW) or Python. Keep the backend as a thin relay.

## Current Backend Responsibilities

| Responsibility | Location | Used For |
|----------------|----------|----------|
| **Elodin relay client** | `elodin-relay-client.ts` | Subscribe to Elodin DB, forward packets to WebSocket |
| **Packet parsing** | `elodin-protocol.ts` | Parse binary packets → entity/component/value |
| **WebSocket server** | `server.ts` | Fan out to React clients |
| **PT calibration load** | `server.ts` | Abort threshold conversion (PSI→ADC), raw→psi fallback |
| **ACTUATOR_CONFIG build** | `server.ts` | Build packet with abort PT blocks, send to boards |
| **SENSOR_CONFIG build** | `server.ts` | Build packet for each sense board |
| **Config broadcast** | `server.ts` + `config_broadcast_service.py` | Python polls `/api/config_packets`, sends UDP |
| **Actuator commands** | `actuator-control.ts` | UDP commands to boards, state machine |
| **Calibration API** | `calibration-handler.ts` | zero_all, capture_reference, save/clear |
| **Calibration phase 2** | `calibration-phase2.ts` | Adjustments, robust calibration |
| **Config API** | `api-server.ts` | GET/POST config, sensor-config, pressure-limits |
| **Controller publish** | `controller-elodin-publisher.ts` | When `use_cpp_controller=false` |
| **Data logger** | `data-logger.ts` | Sensor log files |
| **OTA flash** | `ota-flash.ts`, `ota-build.ts` | Firmware OTA |

---

## Target: Minimal Backend

### Keep in Node (thin relay only)

- **WebSocket server** — connect to Elodin relay, forward to clients
- **Config API** — read/write config.toml for GUI (or move to Python REST)
- **Sensor config API** — derive from config for GUI (or move to Python)
- **Historical data** — optional; could query Elodin directly from frontend

### Remove from backend

- PT calibration loading
- ACTUATOR_CONFIG / SENSOR_CONFIG building
- Raw PT → PSI fallback (calibration sidecar already does this)
- Actuator UDP commands (move to C++ or Python)
- Calibration capture/zero_all (already in Python)

---

## Migration Path

### Phase 1: Config packet building → Python

**Move:** `buildActuatorConfigPacket`, `buildSensorConfigPacket`, `loadPTCalibrationCoeffs`, `invertPTPolynomial`

**To:** `scripts/services/config_broadcast_service.py` (or new `config_packet_builder.py`)

**Flow today:**
```
Backend builds packets → /api/config_packets → config_broadcast_service polls → sends UDP
```

**Flow after:**
```
Python config_broadcast_service:
  - Reads config.toml
  - Loads PT calibration from scripts/calibration/calibrations/
  - Builds ACTUATOR_CONFIG/SENSOR_CONFIG in Python
  - Sends UDP directly (no backend poll)
```

**Backend change:** Remove `getConfigPacketsToSend`, `buildActuatorConfigPacket`, `buildSensorConfigPacket`, `loadPTCalibrationCoeffs`, `invertPTPolynomial`. Delete `/api/config_packets` or make it return empty (config_broadcast_service becomes self-contained).

---

### Phase 2: Config broadcast service independence

**Today:** `config_broadcast_service.py` polls backend for packets.

**After:** Service reads config + calibration, builds packets itself. No backend dependency for config broadcast.

**C++ alternative:** `daq_bridge` already sends SENSOR_CONFIG proactively. Could extend daq_bridge to also send ACTUATOR_CONFIG (it reads config, has PT calibration). Then config_broadcast_service could be removed or simplified to daq_bridge-only.

---

### Phase 3: Actuator commands → C++

**Move:** UDP actuator commands, state-machine-driven transitions

**To:** `controller_service` or new `actuator_command_service` (C++)

**Flow today:**
```
React → WebSocket → Backend → UDP to actuator boards
```

**Flow after:**
```
React → WebSocket → ??? → C++ service → UDP
```

**Options:**
- Backend stays as WebSocket relay; forwards commands to C++ via TCP (e.g. controller_service already has TCP port for FIRE_START/FIRE_STOP)
- Or: Python service subscribes to Elodin for state, sends actuator commands via UDP (same as controller_service pattern)

---

### Phase 4: Calibration API → Python

**Move:** `calibration-handler.ts` (zero_all, capture_reference, save, clear)

**To:** `scripts/calibration/calibration_server.py` or `calibration_orchestrator.py`

**Already exists:** Python calibration scripts. Calibration API could be a REST endpoint in calibration_server that the GUI calls directly. Backend no longer needs calibration-handler.

---

### Phase 5: Raw PT → PSI fallback (remove)

**Today:** Backend converts raw PT to PSI when calibration sidecar isn't providing PT_Cal.

**After:** Rely on calibration_server.py always. If it's down, show raw or "—". Remove `ptCalibration` and fallback logic from server.

---

## Summary

| Component | Move To | Effort |
|-----------|---------|--------|
| ACTUATOR_CONFIG / SENSOR_CONFIG build | Python (config_broadcast_service) | Medium |
| PT calibration load for abort | Python (config_broadcast_service) | Low |
| PT raw→psi fallback | Remove (rely on calibration sidecar) | Low |
| Actuator UDP commands | C++ (controller_service) or Python | Medium |
| Calibration API | Python (calibration_server) | Medium |
| Config API | Keep or move to Python REST | Low |

**Backend after migration:** Elodin relay client + WebSocket server + minimal config API (for GUI). No packet building, no calibration, no actuator UDP.
