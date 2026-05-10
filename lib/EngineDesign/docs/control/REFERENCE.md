# Reference Generation Documentation

## Overview

The reference generation module (`reference.py`) computes feasible reference trajectories for the robust DDP controller. It supports two modes: thrust command and altitude command, and projects desired references to feasible bounds with slew rate limiting.

## Features

1. **Two Command Modes**:
   - **Thrust Command**: User provides desired thrust profile (constant or piecewise schedule)
   - **Altitude Command**: Computes desired thrust from PD guidance law

2. **Feasible Reference Projection**:
   - Clamps to `[F_min(t), F_max(t)]` based on current pressures and actuation headroom
   - Limits slew rate: `|F_ref[k] - F_ref[k-1]| <= dF_max * dt`

3. **Mixture Ratio Reference**:
   - Defaults to mid-band: `MR_ref = (MR_min + MR_max) / 2`

## API

### Main Function

```python
def build_reference(
    nav: NavState,
    meas: Measurement,
    cmd: Command,
    cfg: ControllerConfig,
    horizon_N: int,
    engine_wrapper: Optional[EngineWrapper] = None,
    F_ref_prev: Optional[float] = None,
    dt: Optional[float] = None,
) -> Reference:
```

**Parameters**:
- `nav`: Current navigation state (altitude, velocity, tilt, mass)
- `meas`: Current sensor measurements (pressures)
- `cmd`: Control command (thrust desired or altitude goal)
- `cfg`: Controller configuration
- `horizon_N`: Prediction horizon length
- `engine_wrapper`: Optional engine wrapper for performance estimation
- `F_ref_prev`: Previous reference thrust (for slew rate limiting)
- `dt`: Time step [s] (defaults to `cfg.dt`)

**Returns**:
- `Reference` object containing:
  - `F_ref`: Reference thrust sequence `(N,)` [N]
  - `MR_ref`: Reference mixture ratio sequence `(N,)`
  - `F_min`: Minimum feasible thrust `(N,)` [N]
  - `F_max`: Maximum feasible thrust `(N,)` [N]
  - `feasible`: Feasibility flag `(N,)` (bool)

## Command Modes

### Mode A: Thrust Command

User provides desired thrust as:
- **Constant**: `thrust_desired = 5000.0` (5 kN constant)
- **Piecewise Schedule**: `thrust_desired = [(0.0, 1000.0), (0.05, 5000.0), (0.1, 3000.0)]`
  - List of `(time, thrust)` pairs
  - Linear interpolation between points
  - Extrapolation uses first/last value

**Example**:
```python
cmd = Command(
    command_type=CommandType.THRUST_DESIRED,
    thrust_desired=5000.0,  # or piecewise list
)
```

### Mode B: Altitude Command

Computes desired thrust from PD guidance:

```
a_cmd = kp * (h_goal - h) + kd * (vz_goal - vz)
F_des = m * (a_cmd + g) / cos(theta)
```

Where:
- `kp`: Proportional gain [1/s²] (default: 0.5)
- `kd`: Derivative gain [1/s] (default: 0.3)
- `h_goal`: Target altitude [m]
- `h`: Current altitude [m]
- `vz_goal`: Target vertical velocity [m/s] (default: 0.0)
- `vz`: Current vertical velocity [m/s]
- `m`: Vehicle mass [kg] (from `nav.mass_estimate` or default: 100.0)
- `g`: Gravity [9.81 m/s²]
- `theta`: Tilt angle [rad]

**Example**:
```python
cmd = Command(
    command_type=CommandType.ALTITUDE_GOAL,
    altitude_goal=200.0,  # 200 m target
)
```

**PD Gains** (optional, via `ControllerConfig`):
- `altitude_kp`: Proportional gain [1/s²] (default: 0.5)
- `altitude_kd`: Derivative gain [1/s] (default: 0.3)
- `altitude_vz_goal`: Target vertical velocity [m/s] (default: 0.0)
- `vehicle_mass`: Default vehicle mass [kg] (default: 100.0)

## Feasible Reference Projection

### Bounds Estimation

Maximum feasible thrust `F_max` depends on:
1. **Current Engine Performance**: Estimated from feed pressures
2. **Actuation Headroom**: `P_reg - P_u_i` must be >= `headroom_dp_min`
3. **COPV Pressure**: Must be >= `P_copv_min` for pressurization

Minimum feasible thrust `F_min`:
- Default: `0.0` (or minimum stable thrust if available)

### Slew Rate Limiting

Maximum slew rate: `dF_max` [N/s] (default: 10,000 N/s)

Projection algorithm (sequential clipping):
1. Clamp to bounds: `F = clip(F_des, [F_min, F_max])`
2. Limit slew rate: `F = clip(F, [F_prev - dF_max*dt, F_prev + dF_max*dt])`
3. Re-clamp to bounds: `F = clip(F, [F_min, F_max])`

**Slew Rate Parameter** (optional, via `ControllerConfig`):
- `thrust_slew_max`: Maximum thrust slew rate [N/s] (default: 10,000 N/s)

## Mixture Ratio Reference

Default mixture ratio reference:
```
MR_ref = (MR_min + MR_max) / 2
```

This provides a mid-band reference that maximizes margin to constraints.

## Usage Example

```python
from engine.control.robust_ddp import build_reference, Command, CommandType
from engine.control.robust_ddp.data_models import NavState, Measurement

# Setup
nav = NavState(h=100.0, vz=10.0, theta=0.0, mass_estimate=100.0)
meas = Measurement(
    P_copv=30e6, P_reg=24e6,
    P_u_fuel=3e6, P_u_ox=3.5e6,
    P_d_fuel=2.5e6, P_d_ox=3e6,
)
cmd = Command(
    command_type=CommandType.ALTITUDE_GOAL,
    altitude_goal=200.0,
)

# Build reference
ref = build_reference(
    nav=nav,
    meas=meas,
    cmd=cmd,
    cfg=cfg,
    horizon_N=50,
    engine_wrapper=engine_wrapper,
    F_ref_prev=5000.0,
)

# Use in DDP solver
solution = solve_ddp(
    x0=x0,
    u_seq_init=u_seq_init,
    F_ref=ref.F_ref,
    MR_ref=ref.MR_ref,
    ...
)
```

## Implementation Details

### Thrust Bounds Estimation

The `_estimate_thrust_bounds()` function:
1. Estimates current thrust from engine performance or pressures
2. Computes headroom factor based on `P_reg - P_u_i`
3. Computes COPV factor if COPV pressure is low
4. Applies safety margins and clamps to reasonable range

### Projection Algorithm

The `_project_thrust()` function implements sequential clipping:
- First clamps to bounds
- Then limits slew rate
- Finally re-clamps to bounds (in case slew limit pushed out)

This is a simple but effective convex projection suitable for real-time use.

## Limitations

1. **Time-Varying Bounds**: Current implementation uses constant bounds over the horizon. Full implementation would propagate state forward to compute time-varying bounds.

2. **Simplified Bounds**: Bounds estimation is simplified and may not capture all constraints (e.g., injector stiffness, MR limits).

3. **Constant MR Reference**: Mixture ratio reference is constant (mid-band). Could be optimized based on trajectory.

4. **Altitude Guidance**: PD guidance uses constant gains and simple model. Could be enhanced with trajectory following or optimal guidance.

## Future Improvements

1. **Time-Varying Bounds**: Propagate state forward to compute `F_min(t)`, `F_max(t)`
2. **Optimal MR Reference**: Compute MR reference that maximizes margin or performance
3. **Trajectory Following**: For altitude mode, follow a reference trajectory rather than constant command
4. **Constraint-Aware Bounds**: Include all constraints (MR, injector stiffness) in bounds computation
5. **Adaptive Gains**: Adjust PD gains based on flight phase or conditions

