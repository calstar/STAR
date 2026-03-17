# Controller Stack & Elodin DB Writes

## Controller Stack Status

| Component | Status | Notes |
|-----------|--------|-------|
| **C++ RobustDDPController** | ✅ Implemented | Full DDP solver, dynamics, constraints |
| **C++ ControllerService** | ✅ Implemented | PWM output, relay subscriber, Elodin publisher |
| **C++ ControllerLUT** | ✅ Implemented | Policy LUT bypass, multilinear interpolation |
| **Python RobustDDPController** | ✅ Implemented | engine_sim, engine LUT, policy LUT |
| **Engine LUT** | ✅ Implemented | Stems from engine config + tank pressure range |
| **Policy LUT** | ✅ Implemented | DDP → u_safe_F/O over grid |
| **Safety filter** | ✅ Implemented | Tube-based constraint enforcement |
| **Actuation** | ✅ Implemented | PWM, dwell, quantization |

## Elodin DB Write Pattern

Flight software (autopilot, navigation) writes to Elodin using:

1. **TCP connection** to Elodin DB (default port 2240)
2. **VTable registration** — register schema once before publishing
3. **TABLE packet** — `publish(packet_id, payload)` where payload is postcard-encoded

### Example: Navigation (from archive/legacy)

```cpp
std::array<uint8_t, 2> packet_id{NAV_ID, 0};
write_to_elodindb(packet_id, navigation_message);
```

### Example: Controller (C++ ControllerService)

```cpp
elodin_client_->publish(0x4000, actuation_msg);   // Actuation
elodin_client_->publish(0x4100, diagnostics_msg); // Diagnostics
elodin_client_->publish(0x4200, measurement_msg);  // Measurement
```

### Packet IDs (sensor_system convention)

| Message | Packet ID | Bytes |
|---------|-----------|-------|
| Controller actuation | [0x40, 0x00] | 19 |
| Controller diagnostics | [0x41, 0x00] | 62 |
| Controller measurement | [0x42, 0x00] | 80 |
| PSM state transition | [0x43, 0x00] | 11 |
| Fire state |
|---------|-----------|-------|
| Calibrated PT CHn | [0x20, 0x10+n] | 21 |
| Calibrated TC CHn | [0x21, 0x10+n] | 21 |
| Calibrated RTD CHn | [0x22, 0x10+n] | 21 |
| Calibrated LC CHn | [0x23, 0x10+n] | 21 |

## Who Writes What to Elodin

| Source | Messages | When |
|--------|----------|------|
| **Calibration server** (Python) | Calibrated PT, TC, RTD, LC [0x20,0x21,0x22,0x23] | When processing raw ADC from relay |
| **C++ ControllerService** | Actuation, diagnostics, measurement, fire state [0x40–0x44] | Every loop tick when Elodin connected |
| **C++ PressureStateMachine** | PSM state transition [0x43] | On state entry when PSM runs (e.g. SITL) |
| **Web backend** | Registers VTables | On Elodin connect |
| **Web backend** | Controller actuation/diagnostics | When `use_cpp_controller=false` (Python controller mode) |
| **Web backend** | PSM state transition [0x43] | On every state transition (GUI-driven) so CONTROLLER.state.to_state is in DB |

## Navigation State

- **Packet ID**: [0x45, 0x00]
- **VTable**: Registered by web backend on Elodin connect (`elodin-vtable-navigation.ts`)
- **Payload**: 112 bytes — U64 timestamp_ns + 13×F64 (pos_ned, vel_ned, quat, acc_ned)

Autopilot/navigation writes:
```cpp
elodin_client->publish({0x45, 0x00}, navigation_payload);
```

## Ensuring Calibrated & Controller in DB

- **Calibrated**: Run `calibration_server.py` (sidecar). It connects to Elodin and writes calibrated PT/TC/RTD/LC when it receives raw ADC.
- **Controller**: Run `controller_service` (C++) with `--elodin-host`. It writes actuation, diagnostics, measurement every tick.

## Board Heartbeat Pipeline

```
Boards (UDP) → daq_bridge → Elodin DB → relay (ws :9090) → backend → UI
```

- **Packet ID**: [0x10, board_id] (1–64)
- **daq_bridge** receives BOARD_HEARTBEAT over UDP, publishes to Elodin via HeartbeatRouter
- **Relay** must connect to Elodin first (single-subscriber model); subscribes to [0x10, 1]..[0x10, 64]
- **Backend** parses heartbeats in `handleElodinPacket`, updates `boardsStatus`

### Troubleshooting (boards show DISCONNECTED)

1. **Startup order**: Relay → daq_bridge → backend. If controller_service connects to Elodin before the relay, it becomes the subscriber and the relay gets no data.
2. **Diagnostics**:
   - `RELAY_DEBUG_HEARTBEAT=1` on relay: logs each heartbeat packet received from Elodin
   - `HEARTBEAT_DEBUG=1` on backend: logs each heartbeat parsed
   - Relay logs a warning every 15s if it receives TABLE packets but no 0x10 heartbeats
3. **Check**: `/api/debug` — `heartbeatPacketsReceived` vs `relayPacketsReceived`. If relayPacketsReceived > 0 but heartbeatPacketsReceived = 0, heartbeats are not reaching the backend (check relay logs with RELAY_DEBUG_HEARTBEAT).

## Verification: What Gets Downsampled

**Controller measurement (10% sample):**

- **Code**: `FSW/src/control/ControllerService.cpp` lines 657–658
- **Logic**: `if (tick % 10 == 0) { writeMeasurementToDB(meas); }`
- **Console**: Same condition — `[Controller] tick=N` prints every 10th tick
- **Verify**: Run `./build/FSW/controller_service --config config/config.toml --elodin-host 127.0.0.1` — observe ticks 0, 10, 20, 30, 40… (every 10th tick)
- **At 10 Hz**: ~1 measurement write/sec vs ~10 actuation + ~10 diagnostics writes/sec

**Calibrated data (100 Hz throttle):**

- **Code**: `scripts/calibration/calibration_server.py` lines 179–183
- **Config**: `[calibration.sidecar] write_interval_sec = 0.01` (config.toml line 673)
- **Logic**: Per-channel throttle; skips write if `now - last_write < interval`
- **Effect**: Max ~100 calibrated writes/sec per channel
