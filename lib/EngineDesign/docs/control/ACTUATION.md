# Actuation Module Documentation

## Overview

The actuation module (`actuation.py`) converts relaxed controls `u~` in `[0, 1]` to actual actuation commands for solenoid drivers. It handles quantization, dwell time enforcement, and provides two execution backends: PWM and binary.

## Features

1. **Duty Quantization**: Quantizes controls to discrete duty levels (e.g., 0, 0.01, 0.02, ..., 1.0)
2. **Dwell Time Enforcement**: Enforces minimum time between control changes
3. **Two Execution Backends**:
   - **PWM**: Outputs duty cycle for next window (preferred)
   - **Binary**: Pure on/off with threshold or sigma-delta modulation
4. **State Updates**: Updates dwell timers in `ControllerState`

## API

### Main Function

```python
def compute_actuation(
    u_relaxed: np.ndarray,
    state: ControllerState,
    cfg: ControllerConfig,
    dt: Optional[float] = None,
    backend: ExecutionBackend = ExecutionBackend.PWM,
    u_prev_relaxed: Optional[np.ndarray] = None,
    sigma_delta_state: Optional[dict[str, float]] = None,
) -> ActuationCommand:
```

**Parameters**:
- `u_relaxed`: Relaxed control vector `(N_CONTROL,)` in `[0, 1]` - `[u_F, u_O]`
- `state`: Controller state (for dwell timers and previous controls)
- `cfg`: Controller configuration
- `dt`: Time step [s] (defaults to `cfg.dt`)
- `backend`: Execution backend (`PWM` or `BINARY`)
- `u_prev_relaxed`: Previous relaxed control (optional, uses `state.u_prev` if None)
- `sigma_delta_state`: Sigma-delta accumulator state for binary backend (optional)

**Returns**:
- `ActuationCommand` object containing:
  - `u_F_onoff`, `u_O_onoff`: Binary on/off commands
  - `duty_F`, `duty_O`: Duty cycle commands `[0, 1]`
  - `u_F_quantized`, `u_O_quantized`: Quantized relaxed controls
  - `backend`: Backend used
  - `dwell_timer_F`, `dwell_timer_O`: Updated dwell timers

## Processing Pipeline

1. **Quantization**: Round to nearest multiple of `duty_quantization`
2. **Dwell Enforcement**: Check if minimum dwell time satisfied before allowing change
3. **Backend Conversion**: Convert to PWM duty or binary on/off

## Duty Quantization

Quantizes control to discrete grid:
```
u_quantized = round(u / duty_quantization) * duty_quantization
```

**Example**:
- `duty_quantization = 0.01` (1% steps)
- `u = 0.753` → `u_quantized = 0.75`
- `u = 0.127` → `u_quantized = 0.13`

## Dwell Time Enforcement

Enforces minimum time between control changes:

1. **Control Changed**: If `|u_new - u_prev| > tolerance`:
   - If `dwell_timer >= dwell_time`: Allow change, reset timer to 0
   - If `dwell_timer < dwell_time`: Keep previous control, increment timer
2. **Control Unchanged**: Increment timer

**Purpose**: Prevents excessive switching that could:
- Damage solenoids
- Cause pressure oscillations
- Exceed hardware switching limits

## Execution Backends

### Backend 1: PWM (Pulse-Width Modulation)

**Preferred method** for most applications.

- Output: Continuous duty cycle `[0, 1]`
- Implementation: `duty = u_quantized` (after dwell enforcement)
- Binary on/off: `onoff = duty > 0.0`

**Advantages**:
- Smooth control
- Precise duty matching
- Low switching frequency (only when duty changes)

### Backend 2: Binary (Pure On/Off)

**Fallback method** when PWM is not available.

Two modes:

#### Mode A: Threshold Method

- Output: `1` if `duty_desired > threshold`, else `0`
- Default threshold: `0.5`
- Simple but can cause chattering

#### Mode B: Sigma-Delta Modulation

- Output: Binary sequence with average duty matching `duty_desired`
- Algorithm:
  ```
  accumulator += duty_desired
  if accumulator >= 1.0:
      output = 1
      accumulator -= 1.0
  else:
      output = 0
  ```
- Provides average duty matching without high-frequency chatter

**Advantages**:
- Works with simple on/off solenoids
- Sigma-delta provides smooth average behavior

**Disadvantages**:
- Higher switching frequency (binary backend)
- Less precise than PWM

## State Updates

After computing actuation, update controller state:

```python
update_state_dwell_timers(state, cmd)
```

This updates:
- `state.dwell_timers["P_u_fuel"]` = `cmd.dwell_timer_F`
- `state.dwell_timers["P_u_ox"]` = `cmd.dwell_timer_O`
- `state.u_prev["P_u_fuel"]` = `cmd.u_F_quantized`
- `state.u_prev["P_u_ox"]` = `cmd.u_O_quantized`

## Usage Example

```python
from engine.control.robust_ddp import (
    compute_actuation,
    ExecutionBackend,
    update_state_dwell_timers,
)
from engine.control.robust_ddp.data_models import ControllerState, ControllerConfig
import numpy as np

# Setup
cfg = ControllerConfig(
    dwell_time=0.05,  # 50 ms minimum dwell
    duty_quantization=0.01,  # 1% steps
)
state = ControllerState(
    u_prev={"P_u_fuel": 0.5, "P_u_ox": 0.5},
    dwell_timers={"P_u_fuel": 0.1, "P_u_ox": 0.1},
)

# DDP solver output (relaxed controls)
u_relaxed = np.array([0.75, 0.45])

# Compute actuation (PWM backend)
cmd = compute_actuation(
    u_relaxed=u_relaxed,
    state=state,
    cfg=cfg,
    backend=ExecutionBackend.PWM,
)

# Use commands
print(f"Fuel duty: {cmd.duty_F:.2%}")
print(f"Oxidizer duty: {cmd.duty_O:.2%}")
print(f"Fuel on/off: {cmd.u_F_onoff}")
print(f"Oxidizer on/off: {cmd.u_O_onoff}")

# Update state
update_state_dwell_timers(state, cmd)
```

## Binary Backend with Sigma-Delta

For binary backend with sigma-delta modulation:

```python
# Initialize sigma-delta state (accumulator)
sigma_delta_state = {"F": 0.0, "O": 0.0}

# Compute actuation
cmd = compute_actuation(
    u_relaxed=u_relaxed,
    state=state,
    cfg=cfg,
    backend=ExecutionBackend.BINARY,
    sigma_delta_state=sigma_delta_state,
)

# Update sigma-delta state (for next iteration)
# This would be done internally in a full implementation
# For now, sigma-delta state is not automatically updated
```

## Configuration Parameters

- `dwell_time`: Minimum time between control changes [s] (default: 0.05 s)
- `duty_quantization`: Duty cycle quantization step (default: 0.01 = 1%)
- `binary_threshold`: Threshold for binary threshold method (default: 0.5)

## Implementation Details

### Quantization Algorithm

```python
n_steps = round(u / duty_quantization)
u_quantized = n_steps * duty_quantization
u_quantized = clip(u_quantized, 0.0, 1.0)
```

### Dwell Enforcement Algorithm

```python
control_changed = abs(u_new - u_prev) > tolerance
if control_changed:
    if dwell_timer >= dwell_time:
        return u_new, 0.0  # Allow change, reset timer
    else:
        return u_prev, dwell_timer + dt  # Keep previous, increment timer
else:
    return u_new, dwell_timer + dt  # No change, increment timer
```

### Sigma-Delta Algorithm

```python
accumulator += duty_desired
if accumulator >= 1.0:
    output = 1
    accumulator -= 1.0
else:
    output = 0
```

## Limitations

1. **Constant Bounds**: Dwell time and quantization are constant (could be adaptive)
2. **Simple Sigma-Delta**: First-order sigma-delta (could use higher-order for better performance)
3. **State Management**: Sigma-delta state must be managed externally (could be in `ControllerState`)

## Future Improvements

1. **Adaptive Quantization**: Adjust quantization based on control authority
2. **Higher-Order Sigma-Delta**: Use second-order or higher for better noise shaping
3. **State Management**: Store sigma-delta state in `ControllerState`
4. **Min Pulse Width**: Enforce minimum pulse width for binary backend
5. **Dead Band**: Add dead band around zero to prevent chattering

