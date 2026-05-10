# Safety Filter Documentation

## Overview

The safety filter module (`safety_filter.py`) provides a last-line-of-defense safety mechanism that ensures proposed control actions do not violate hard constraints. It computes reachable uncertainty tubes and filters unsafe actions by selecting the best safe alternative from a discrete candidate set.

## Features

1. **Reachable Tube Computation**: Propagates uncertainty tubes forward 1-3 steps
2. **Constraint Checking**: Checks if tube violates hard constraints (pressures, MR, injector stiffness)
3. **Safe Action Selection**: Finds best safe action from discrete candidate set if proposed is unsafe
4. **Cost-Based Selection**: Evaluates candidates by tube feasibility and immediate cost

## API

### Main Function

```python
def filter_action(
    x: np.ndarray,
    proposed: np.ndarray,
    state: ControllerState,
    cfg: ControllerConfig,
    engine_wrapper: Optional[EngineWrapper] = None,
    F_ref: Optional[float] = None,
    MR_ref: Optional[float] = None,
    num_steps: int = 2,
    dt: Optional[float] = None,
) -> np.ndarray:
```

**Parameters**:
- `x`: Current measured state `(N_STATE,)`
- `proposed`: Proposed relaxed control `(N_CONTROL,)` in `[0, 1]`
- `state`: Controller state (for `w_bar` residual bounds)
- `cfg`: Controller configuration
- `engine_wrapper`: Optional engine wrapper for performance estimation
- `F_ref`: Optional reference thrust [N] (for cost computation)
- `MR_ref`: Optional reference mixture ratio (for cost computation)
- `num_steps`: Number of steps to propagate tube (default: 2)
- `dt`: Time step [s] (defaults to `cfg.dt`)

**Returns**:
- `safe_action`: Safe relaxed control `(N_CONTROL,)` (may be same as proposed if safe)

## Algorithm

1. **Clamp Input**: Clamp proposed action to `[0, 1]`
2. **Get Residual Bounds**: Extract `w_bar` from controller state
3. **Check Safety**: Propagate tube and check constraints
4. **If Safe**: Return proposed action unchanged
5. **If Unsafe**: 
   - Generate discrete action candidates
   - Evaluate each candidate for safety and cost
   - Return best safe candidate (or zeros if none found)

## Reachable Tube Computation

The safety filter computes a reachable uncertainty tube:

1. **Initialize Tube**: `[x_lo, x_hi] = [x, x]` (point tube at current state)
2. **Propagate Forward**: For `num_steps` steps:
   - Estimate mass flows from current state
   - Propagate tube: `x_lo_next, x_hi_next = tube_propagate(x_lo, x_hi, u, w_bar, ...)`
   - Check if tube violates constraints
3. **Constraint Check**: Check worst-case (upper bound) for:
   - COPV minimum pressure
   - Ullage maximum pressure
   - Mixture ratio bounds
   - Injector stiffness

## Constraint Violations Checked

### Hard Constraints

1. **COPV Minimum**: `P_copv >= P_copv_min`
2. **Ullage Maximum**: `P_u_F <= P_u_max`, `P_u_O <= P_u_max`
3. **Mixture Ratio**: `MR_min <= MR <= MR_max`
4. **Injector Stiffness**: `(P_d_i - P_ch) >= eps_i * P_ch`

### Tube-Based Checking

The filter checks the **worst-case** (upper bound) of the uncertainty tube:
- For pressure constraints: checks `x_hi[component]`
- For engine constraints: uses upper bound feed pressures to estimate worst-case performance

## Safe Action Selection

If proposed action is unsafe, the filter:

1. **Generates Candidates**:
   - Binary candidates: `{(0,0), (0,1), (1,0), (1,1)}`
   - PWM candidates: Quantized duty pairs (e.g., `(0, 0.5, 1.0)` combinations)
   
2. **Evaluates Each Candidate**:
   - **Safety**: Checks if candidate produces safe tube
   - **Cost**: Computes immediate cost:
     ```
     cost = qGas * P_copv_drop + qF * (F - F_ref)^2 + qMR * (MR - MR_ref)^2
     ```
   
3. **Selects Best**: Chooses feasible candidate with minimum cost

4. **Fallback**: If no safe candidate found, returns `(0, 0)` (all solenoids closed)

## Usage Example

```python
from engine.control.robust_ddp import filter_action
from engine.control.robust_ddp.data_models import ControllerState, ControllerConfig
import numpy as np

# Setup
cfg = ControllerConfig(...)
state = ControllerState(w_bar_array=np.ones(8) * 0.1e6)
x_measured = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])

# DDP solver proposes action
u_proposed = np.array([0.9, 0.8])  # High control

# Filter for safety
u_safe = filter_action(
    x=x_measured,
    proposed=u_proposed,
    state=state,
    cfg=cfg,
    engine_wrapper=engine_wrapper,
    F_ref=5000.0,
    MR_ref=2.4,
    num_steps=2,
)

# Use safe action
if np.allclose(u_safe, u_proposed):
    print("Proposed action is safe")
else:
    print(f"Action filtered: {u_proposed} -> {u_safe}")
```

## Integration with Control Loop

The safety filter should be called **after** DDP solver but **before** actuation:

```python
# 1. DDP solver
solution = solve_ddp(x0, u_seq_init, F_ref, MR_ref, ...)
u_ddp = solution.u_seq[0]  # First control action

# 2. Safety filter
u_safe = filter_action(
    x=x_measured,
    proposed=u_ddp,
    state=state,
    cfg=cfg,
    engine_wrapper=engine_wrapper,
    F_ref=F_ref[0],
    MR_ref=MR_ref[0],
)

# 3. Actuation
cmd = compute_actuation(u_safe, state, cfg, ...)
```

## Configuration Parameters

- `P_u_max`: Maximum ullage pressure [Pa]
- `P_copv_min`: Minimum COPV pressure [Pa]
- `MR_min`, `MR_max`: Mixture ratio bounds
- `injector_dp_frac`: Minimum injector pressure drop fraction
- `qF`, `qMR`, `qGas`: Cost weights (for candidate evaluation)

## Implementation Details

### Tube Propagation

Uses `tube_propagate` from robustness module:
```python
x_lo_next = f(x_lo, u) - w_bar
x_hi_next = f(x_hi, u) + w_bar
```

### Mass Flow Estimation

For tube propagation, estimates mass flows from current state:
- Uses `engine_wrapper.estimate_from_pressures(P_d_F, P_d_O)`
- Falls back to zeros if estimation fails

### Candidate Generation

- **Binary**: Always includes `{(0,0), (0,1), (1,0), (1,1)}`
- **PWM**: Adds quantized combinations (e.g., `(0, 0.5, 1.0)` grid)
- Avoids explosion by using coarser grid for PWM candidates

### Cost Computation

Immediate cost for candidate evaluation:
```python
cost = qGas * (copv_cF * u_F + copv_cO * u_O + copv_loss)
     + qF * (F - F_ref)^2  # if F_ref provided
     + qMR * (MR - MR_ref)^2  # if MR_ref provided
```

## Limitations

1. **Conservative**: Uses worst-case (upper bound) for constraint checking
2. **Discrete Candidates**: Limited to discrete set (may miss optimal continuous solution)
3. **Short Horizon**: Only checks 1-3 steps ahead (may miss longer-term violations)
4. **Mass Flow Approximation**: Uses current state for mass flow estimation (doesn't propagate)

## Future Improvements

1. **Longer Horizon**: Check more steps ahead (with computational cost trade-off)
2. **Continuous Optimization**: Use optimization to find best safe action (not just discrete set)
3. **Propagated Mass Flows**: Estimate mass flows from propagated state
4. **Adaptive Candidates**: Generate candidates based on proposed action (local search)
5. **Soft Constraints**: Consider soft constraint margins in cost function
6. **Tube Tightening**: Use more sophisticated tube propagation (zonotopes, polytopes)

## Safety Guarantees

The safety filter provides **probabilistic safety**:
- If `w_bar` accurately captures uncertainty, tube-based checking provides safety guarantee
- If `w_bar` is too small, may miss violations
- If `w_bar` is too large, may be overly conservative

For **hard safety guarantees**, consider:
- Larger `w_bar` (more conservative)
- More steps in tube propagation
- Additional safety margins in constraints

