# Orchestrator Fixes and Controller Integration Plan

## Current Orchestrator Bugs

1. **Packet Parsing Issues**:
   - Manual packet parsing is fragile and doesn't handle all packet types
   - No proper error handling for malformed packets
   - Channel ID mapping from sensor_id is incorrect (sensor_id is 0-indexed, channels are 1-indexed)

2. **Queue Management**:
   - Queue can overflow silently (maxlen=5000 but no monitoring)
   - No backpressure handling
   - Race conditions between queue drain and packet reception

3. **State Management**:
   - `collecting` flag can get stuck if exception occurs
   - No timeout handling for collection phase
   - References dictionary can have stale entries

4. **Missing Features**:
   - No controller integration
   - No actuator command/status communication
   - No pressure control loop

## Fixes Needed

### 1. Use Proper Packet Parser
- Import and use `DiabloPacketParser` from `comms.packet_parser` (if it exists)
- Or create a robust parser that handles all packet types correctly

### 2. Fix Channel ID Mapping
```python
# Current (WRONG):
key = (stype, sid)  # sid is 0-indexed from packet

# Should be:
channel_id = sid + 1  # Convert 0-indexed to 1-indexed
key = (stype, channel_id)
```

### 3. Add Error Handling
- Wrap packet parsing in try/except
- Log malformed packets instead of silently dropping
- Add queue overflow warnings

### 4. Controller Integration

#### Architecture:
```
┌─────────────────┐
│  Orchestrator   │
│  (Calibration)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────┐
│  Controller     │◄────►│  Actuators   │
│  (RobustDDP)    │      │  (UDP 5005)  │
└────────┬────────┘      └──────────────┘
         │
         ▼
┌─────────────────┐
│  Sensors        │
│  (UDP 5006)     │
└─────────────────┘
```

#### Implementation Steps:

1. **Add Controller Module**:
   - Create Python wrapper for RobustDDPController (or use C++ via ctypes)
   - Initialize controller with config from `config.toml`

2. **Actuator Communication**:
   - UDP sender on port 5005 (actuator command port)
   - UDP receiver for actuator status/current sense (port 5006)
   - Parse actuator status packets

3. **Control Loop**:
   - Read calibrated PT pressures
   - Compute control command via controller
   - Send actuator commands
   - Monitor actuator status for feedback

4. **Integration Points**:
   - Phase 1: Calibration only (no control)
   - Phase 2: Calibration + Control loop
   - New Phase 3: Control-only mode (skip calibration)

## Implementation Priority

1. **Critical Bugs** (Fix First):
   - Channel ID mapping
   - Packet parsing error handling
   - Queue overflow protection

2. **Controller Integration** (Next):
   - Actuator UDP communication
   - Controller wrapper
   - Control loop integration

3. **Enhanced Features** (Later):
   - Pressure setpoint tracking
   - Safety interlocks
   - Logging/telemetry



