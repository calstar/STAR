# LOX Press Actuator Verification

## Configuration
- **Actuator Name**: "LOX Press"
- **Channel**: 8
- **Type**: NO (Normally Open)
- **Config Key**: `"LOX Press"` in `config.toml` actuator_roles

## Conversion Logic
For NO actuators:
- GUI OPEN (1) → Hardware OFF (0) - Valve is open (de-powered)
- GUI CLOSED (0) → Hardware ON (1) - Valve is closed (powered)

## Expected Behavior by State

| State | CSV Value | GUI State | Hardware State | Description |
|-------|-----------|-----------|----------------|-------------|
| Idle | OPEN | 1 | 0 (OFF) | De-powered, valve open |
| Armed | CLOSE | 0 | 1 (ON) | Powered to close |
| Fuel Fill | CLOSE | 0 | 1 (ON) | Closed |
| Ox Fill | CLOSE | 0 | 1 (ON) | Closed |
| Press Standby | CLOSE | 0 | 1 (ON) | Closed |
| GN2 Low Press | CLOSE | 0 | 1 (ON) | Closed |
| GN2 Low Vent | CLOSE | 0 | 1 (ON) | Closed |
| Fuel Press | CLOSE | 0 | 1 (ON) | Closed |
| Fuel Vent | CLOSE | 0 | 1 (ON) | Closed |
| **Ox Press** | **OPEN** | **1** | **0 (OFF)** | **Open for pressurization** |
| Ox Vent | CLOSE | 0 | 1 (ON) | Closed |
| GN2 High Press | CLOSE | 0 | 1 (ON) | Closed |
| GN2 High Vent | CLOSE | 0 | 1 (ON) | Closed |
| Calibrate | CLOSE | 0 | 1 (ON) | Closed |
| Ready | CLOSE | 0 | 1 (ON) | Closed |
| **Fire** | **OPEN** | **1** | **0 (OFF)** | **Open (controller PWM)** |
| **Vent** | **OPEN** | **1** | **0 (OFF)** | **Open for venting** |
| **Engine Abort** | **OPEN** | **1** | **0 (OFF)** | **Open for abort** |
| GSE Abort | CLOSE | 0 | 1 (ON) | Closed |
| **Emergency Abort** | **OPEN** | **1** | **0 (OFF)** | **Open for emergency** |

## Key States Where LOX Press Should Be OPEN (Hardware OFF)
1. **Idle** - De-powered state
2. **Ox Press** - Pressurization state
3. **Fire** - Controller takes over via PWM
4. **Vent** - Venting state
5. **Engine Abort** - Abort sequence
6. **Emergency Abort** - Emergency abort

## Debugging
Check server logs for:
- `🔍 LOX Press DEBUG:` messages showing actuator type lookup
- Conversion values: `val`, `actuatorType`, `hardwareState`
- Verify `actuatorType` is `NO` (not `NC`)

## Potential Issues
1. **Actuator type lookup failing** - If `getActuatorType("LOX Press")` returns `NC` instead of `NO`, all commands will be inverted
2. **Config key mismatch** - If config key doesn't exactly match "LOX Press" (case/whitespace)
3. **CSV parsing issue** - If CSV value is being read incorrectly
