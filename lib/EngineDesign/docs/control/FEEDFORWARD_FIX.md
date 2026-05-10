# Feedforward System Fix: Tank Pressures vs Feed Pressures

## Problem Identified

The controller was incorrectly using **feed pressures** (P_d_F, P_d_O) when calling the engine physics, but the engine expects **tank/ullage pressures** (P_u_F, P_u_O) to drive mass flow rates.

## Physics Flow

The correct feedforward/coupled system is:

```
Tank/Ullage Pressures (P_u_F, P_u_O)
    ↓
Engine Physics (PintleEngineRunner)
    ↓
Mass Flow Rates (mdot_F, mdot_O)
    ↓
Ullage Volume Changes (V_u increases as propellant consumed)
    ↓
Ullage Pressure Changes (P_u decreases via ideal gas: P = nRT/V)
    ↓
Feed Pressures (P_d lag behind P_u with time constant tau_line)
```

**Key Insight**: Tank pressures (P_u) **drive** mass flow, not feed pressures (P_d). Feed pressures are downstream and lag behind.

## Changes Made

### 1. DDP Solver (`ddp_solver.py`)
- **forward_rollout**: Changed from `x_k[4], x_k[5]` (P_d) to `x_k[IDX_P_U_F], x_k[IDX_P_U_O]` (P_u)
- **cost_derivatives**: Changed sensitivity checks from `IDX_P_D_F, IDX_P_D_O` to `IDX_P_U_F, IDX_P_U_O`
- **forward_line_search**: Changed from feed pressures to tank pressures

### 2. Safety Filter (`safety_filter.py`)
- Changed all `estimate_from_pressures` calls to use `x[IDX_P_U_F], x[IDX_P_U_O]` instead of `x[4], x[5]`

### 3. Robustness (`robustness.py`)
- **update_bounds**: Changed from `x_meas[4], x_meas[5]` to `x_meas[IDX_P_U_F], x_meas[IDX_P_U_O]`

### 4. Controller (`controller.py`)
- Changed from `meas.P_d_fuel, meas.P_d_ox` to `meas.P_u_fuel, meas.P_u_ox`

### 5. Reference Generation (`reference.py`)
- Changed from `meas.P_d_fuel, meas.P_d_ox` to `meas.P_u_fuel, meas.P_u_ox`
- Updated fallback thrust estimate to use tank pressures

### 6. Engine Wrapper (`engine_wrapper.py`)
- Updated documentation to clarify that `estimate_from_pressures` expects tank/ullage pressures
- Added notes that parameter names (P_d_F, P_d_O) are kept for backward compatibility but function expects P_u

## What Remains Correct

These uses of feed pressures (P_d) are **correct** and should remain:

1. **Injector Pressure Drop Calculations** (`constraints.py`):
   - `injector_dp_F = P_d_F - P_ch` ✓ (P_d is at injector face)

2. **Feed Line Dynamics** (`dynamics.py`):
   - `P_d_next = P_d + dt * (P_u - P_d) / tau_line` ✓ (feed lags behind tank)

3. **State Updates** (`controller.py`):
   - Setting `x[IDX_P_D_F] = meas.P_d_fuel` ✓ (feed is part of state)

4. **Parameter Identification** (`identify.py`):
   - Identifying `tau_line` from P_d response ✓ (feed lag identification)

5. **Logging** (`logging.py`):
   - Logging both P_u and P_d ✓ (both are measured)

## Impact

This fix ensures:
- ✅ Engine physics receives correct tank pressures (not lagged feed pressures)
- ✅ Mass flow calculations are based on actual driving pressures
- ✅ Feedforward coupling is correctly modeled: P_u → mdot → V_u → P_u
- ✅ Feed pressures correctly lag behind tank pressures

## Testing

After this fix, verify:
1. Controller predictions match actual engine behavior
2. Mass flow rates are consistent with tank pressures
3. Feed pressure lag is correctly modeled (P_d follows P_u with delay)
4. Constraint checking uses correct injector pressure drops (P_d - P_ch)



