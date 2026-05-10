# Robustness Module Documentation

## Overview

The robustness module maintains residual bounds `w_bar` for each state component and provides tube propagation for robust control. It implements adaptive uncertainty estimation and interval-based uncertainty propagation.

## Functions

### `update_bounds(state, x_prev, x_meas, u_prev, cfg, ...) -> None`

Updates residual bounds `w_bar` and disturbance bias `beta` based on measured vs. predicted state residuals.

**Parameters:**
- `state`: `ControllerState` (mutated in place)
- `x_prev`: Previous state `x[k-1]`
- `x_meas`: Measured state `x_meas[k]`
- `u_prev`: Previous control `u[k-1]`
- `cfg`: `ControllerConfig` (contains `rho`, `eta`)
- `engine_wrapper`: Optional `EngineWrapper` for mass flow estimation
- `mdot_F`, `mdot_O`: Optional mass flows [kg/s] (required if wrapper not provided)
- `dt`: Optional time step [s] (defaults to `cfg.dt`)

**Algorithm:**
1. Compute predicted state: `x_pred = f(x_prev, u_prev)`
2. Compute residual: `residual = x_meas - x_pred`
3. Update bounds (EMA): `w_bar = rho * w_bar + (1 - rho) * abs(residual)`
4. Inflate: `w_bar *= (1 + eta)`
5. Update bias: `beta = rho * beta + (1 - rho) * mean(residual)`

**Notes:**
- Mutates `state.w_bar_array` (per-state-component bounds)
- Also updates `state.w_bar` dict for backward compatibility
- Updates `state.beta` (disturbance bias estimate)

### `tube_propagate(x_lo, x_hi, u, w_bar, dt, params, mdot_F, mdot_O) -> (x_lo_next, x_hi_next)`

Propagates uncertainty tube through dynamics.

**Parameters:**
- `x_lo`: Lower bound of state uncertainty
- `x_hi`: Upper bound of state uncertainty
- `u`: Control input
- `w_bar`: Residual bounds (uncertainty per state component)
- `dt`: Time step [s]
- `params`: `DynamicsParams`
- `mdot_F`, `mdot_O`: Mass flows [kg/s]

**Returns:**
- `x_lo_next`: Lower bound of next state
- `x_hi_next`: Upper bound of next state

**Algorithm:**
- `x_lo_next = f(x_lo, u) - w_bar`
- `x_hi_next = f(x_hi, u) + w_bar`
- Clamp to ensure `x_lo_next <= x_hi_next` and non-negativity

### `get_w_bar_array(state) -> np.ndarray`

Gets `w_bar` as numpy array (per-state-component bounds).

### `set_w_bar_array(state, w_bar) -> None`

Sets `w_bar` from numpy array (also updates dict format).

## Residual Bounds Update

The residual bounds `w_bar` are maintained per state component using exponential moving average:

```
w_bar[k] = rho * w_bar[k-1] + (1 - rho) * abs(residual[k])
w_bar[k] *= (1 + eta)  # Inflation
```

Where:
- `residual[k] = x_meas[k] - f(x_prev[k-1], u_prev[k-1])`
- `rho`: Retention factor (0 < rho < 1), higher = slower adaptation
- `eta`: Robustness margin (0 < eta), adds safety margin

**Properties:**
- Bounds increase when residuals spike
- Bounds adapt slowly (controlled by `rho`)
- Bounds are inflated by `eta` for safety margin

## Disturbance Bias

The disturbance bias `beta` tracks slow drift:

```
beta[k] = rho * beta[k-1] + (1 - rho) * mean(residual[k])
```

This captures systematic errors (e.g., sensor bias, model drift).

## Tube Propagation

Uncertainty tubes are propagated using interval arithmetic:

```
x_lo_next = f(x_lo, u) - w_bar
x_hi_next = f(x_hi, u) + w_bar
```

**Properties:**
- Tube widens with each step (due to `w_bar` addition)
- Accounts for model uncertainty
- Used in robust DDP for constraint satisfaction under uncertainty

## Usage Examples

### Update Bounds from Measurements

```python
from engine.control.robust_ddp import update_bounds, EngineWrapper

wrapper = EngineWrapper(config)
state = ControllerState()

# At each control tick:
x_prev = ...  # Previous state
x_meas = ...  # Measured state (from sensors)
u_prev = ...  # Previous control

# Update bounds
update_bounds(
    state, x_prev, x_meas, u_prev, cfg,
    engine_wrapper=wrapper, dt=cfg.dt
)

# Access bounds
w_bar = get_w_bar_array(state)
print(f"COPV uncertainty: {w_bar[IDX_P_COPV]/1e6:.2f} MPa")
```

### Propagate Uncertainty Tube

```python
from engine.control.robust_ddp import tube_propagate, DynamicsParams

# Initial uncertainty tube
x_nom = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
w_bar = np.array([1e5, 1e5, 1e5, 1e5, 1e5, 1e5, 1e-4, 1e-4])

x_lo = x_nom - w_bar
x_hi = x_nom + w_bar

# Propagate
params = DynamicsParams.from_config(cfg)
x_lo_next, x_hi_next = tube_propagate(
    x_lo, x_hi, u, w_bar, cfg.dt,
    params, mdot_F, mdot_O
)

# Tube width
width = x_hi_next - x_lo_next
print(f"Tube width: {width/1e6} MPa (for pressures)")
```

### Robust DDP Integration

```python
# In DDP rollout with uncertainty:
for k in range(N):
    # Get uncertainty bounds
    w_bar = get_w_bar_array(state)
    
    # Propagate nominal trajectory
    x_nom_next = step(x_nom, u, dt, params, mdot_F, mdot_O)
    
    # Propagate uncertainty tube
    x_lo_next, x_hi_next = tube_propagate(
        x_lo, x_hi, u, w_bar, dt, params, mdot_F, mdot_O
    )
    
    # Check constraints on worst case (upper bound)
    if not is_safe(x_hi_next, eng_est, cfg):
        # Constraint violation in worst case
        cost += large_penalty
    
    # Update for next step
    x_lo, x_hi = x_lo_next, x_hi_next
```

## Configuration Parameters

From `ControllerConfig`:
- `rho`: Retention factor for EMA (0 < rho < 1)
  - Higher = slower adaptation, more stable bounds
  - Lower = faster adaptation, more responsive
- `eta`: Robustness margin (0 < eta)
  - Adds safety margin to bounds
  - Typical: 0.01-0.1 (1-10% margin)

## Testing

Comprehensive unit tests in `tests/test_robust_ddp_robustness.py`:

- **Bounds increase with residual spike**: Verifies bounds grow when residuals spike
- **EMA behavior**: Tests exponential moving average formula
- **Inflation**: Verifies bounds are inflated by `eta`
- **Tube propagation widens**: Verifies uncertainty tubes widen
- **Beta update**: Tests disturbance bias estimation
- **Input validation**: Tests error handling

Run tests with:
```bash
python -m unittest tests.test_robust_ddp_robustness -v
```

## Notes

1. **Per-State-Component Bounds**: `w_bar` is maintained as array with one bound per state component, allowing different uncertainty levels for different states.

2. **Backward Compatibility**: `w_bar` is stored both as array (`w_bar_array`) and dict (`w_bar`) for compatibility.

3. **Mass Flow Requirement**: `update_bounds` requires mass flows to compute predicted state. Can provide via `engine_wrapper` or directly.

4. **Tube Propagation**: Simple interval propagation. For more sophisticated methods (zonotopes, polytopes), see advanced robust control literature.

5. **Non-Negativity**: All bounds and tube bounds are clamped to be non-negative (for pressures and volumes).

6. **Convergence**: With constant residuals, bounds converge to steady-state value (not grow unbounded).

