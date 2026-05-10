# Constraints Module Documentation

## Overview

The constraints module provides hard constraint checking and soft constraint margin computation for the robust DDP controller. It validates state and engine estimates against safety limits and operational constraints.

## Functions

### `is_safe(x, eng_est, cfg) -> bool`

Returns `True` if all hard constraints are satisfied, `False` otherwise.

**Parameters:**
- `x`: State vector `[P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O, V_u_F, V_u_O]`
- `eng_est`: `EngineEstimate` from engine wrapper
- `cfg`: `ControllerConfig` with constraint limits

**Returns:**
- `safe`: `True` if all constraints satisfied, `False` otherwise

### `constraint_values(x, eng_est, cfg) -> Dict[str, float]`

Computes constraint violation margins and soft constraint distances.

**Parameters:**
- `x`: State vector
- `eng_est`: Engine estimate
- `cfg`: Controller configuration

**Returns:**
Dictionary with constraint values:
- **Hard constraints** (positive = violation, negative = satisfied)
- **Soft constraints** (margins, negative = safe with margin)
- **Headroom flags** (1.0 = insufficient, 0.0 = sufficient)

### `get_constraint_summary(constraints) -> Dict[str, Any]`

Generates human-readable summary of constraint status.

## Hard Constraints

### 1. COPV Minimum Pressure

**Constraint:** `P_copv >= P_copv_min`

**Violation:** `copv_min = P_copv_min - P_copv` (positive if violated)

**Margin:** `copv_margin = P_copv - P_copv_min` (distance above minimum)

### 2. Ullage Maximum Pressure

**Constraint:** `P_u_F <= P_u_max`, `P_u_O <= P_u_max`

**Violation:** 
- `ullage_max_F = P_u_F - P_u_max` (positive if violated)
- `ullage_max_O = P_u_O - P_u_max` (positive if violated)

**Margin:**
- `ullage_margin_F = P_u_max - P_u_F` (distance below maximum)
- `ullage_margin_O = P_u_max - P_u_O` (distance below maximum)

### 3. Mixture Ratio

**Constraint:** `MR_min <= MR <= MR_max`

**Violations:**
- `MR_min = MR_min - MR` (positive if MR < MR_min)
- `MR_max = MR - MR_max` (positive if MR > MR_max)

**Margins:**
- `MR_margin_low = MR - MR_min` (distance above minimum)
- `MR_margin_high = MR_max - MR` (distance below maximum)

### 4. Injector Stiffness

**Constraint:** `(P_d_i - P_ch) >= eps_i * P_ch` for `i ∈ {F, O}`

This ensures sufficient injector pressure drop for stable operation.

**Violation:**
- `injector_stiffness_F = eps_i * P_ch - (P_d_F - P_ch)` (positive if violated)
- `injector_stiffness_O = eps_i * P_ch - (P_d_O - P_ch)` (positive if violated)

**Margin:**
- `injector_stiffness_margin_F = (P_d_F - P_ch) - eps_i * P_ch`
- `injector_stiffness_margin_O = (P_d_O - P_ch) - eps_i * P_ch`

### 5. Headroom for Actuation

**Constraint:** `(P_reg - P_u_i) >= dp_min` for effective pressurization

This flags when control authority is insufficient (solenoid cannot effectively pressurize).

**Flag:**
- `headroom_insufficient_F = 1.0` if `(P_reg - P_u_F) < dp_min`, else `0.0`
- `headroom_insufficient_O = 1.0` if `(P_reg - P_u_O) < dp_min`, else `0.0`

**Margin:**
- `headroom_margin_F = (P_reg - P_u_F) - dp_min`
- `headroom_margin_O = (P_reg - P_u_O) - dp_min`

## Usage Examples

### Basic Safety Check

```python
from engine.control.robust_ddp import is_safe, constraint_values, EngineWrapper

wrapper = EngineWrapper(config)
x = np.array([30e6, 24e6, 3e6, 3.5e6, 2.5e6, 3e6, 0.01, 0.01])
eng_est = wrapper.estimate_from_pressures(x[IDX_P_D_F], x[IDX_P_D_O])

# Check if safe
if is_safe(x, eng_est, cfg):
    print("State is safe")
else:
    print("State violates constraints")
```

### Detailed Constraint Analysis

```python
constraints = constraint_values(x, eng_est, cfg)

# Check specific constraints
if constraints["copv_min"] > 0:
    print(f"COPV pressure too low: {constraints['copv_min']/1e6:.2f} MPa violation")

if constraints["MR_max"] > 0:
    print(f"Mixture ratio too high: {constraints['MR_max']:.2f} violation")

# Check margins
print(f"COPV margin: {constraints['copv_margin']/1e6:.2f} MPa")
print(f"Ullage margin (fuel): {constraints['ullage_margin_F']/1e6:.2f} MPa")

# Check headroom
if constraints["headroom_insufficient_F"] > 0.5:
    print("Warning: Insufficient headroom for fuel pressurization")
```

### Constraint Summary

```python
from engine.control.robust_ddp import get_constraint_summary

constraints = constraint_values(x, eng_est, cfg)
summary = get_constraint_summary(constraints)

print(f"Safe: {summary['safe']}")
print(f"Violations: {summary['violations']}")
print(f"Margins: {summary['margins']}")
print(f"Headroom flags: {summary['headroom_flags']}")
```

## Integration with DDP

In DDP cost function, constraints can be penalized:

```python
def cost_function(x, u, eng_est, cfg):
    # Base cost (thrust tracking, etc.)
    cost = base_cost(x, u, eng_est, cfg)
    
    # Constraint violations (penalize)
    constraints = constraint_values(x, eng_est, cfg)
    for key, violation in constraints.items():
        if key.endswith("_min") or key.endswith("_max") or "stiffness" in key:
            if violation > 0:  # Violation
                cost += 1e6 * violation  # Large penalty
    
    return cost
```

Or use as hard constraints in optimization:

```python
def constraint_function(x, u, eng_est, cfg):
    constraints = constraint_values(x, eng_est, cfg)
    return np.array([
        -constraints["copv_min"],      # g(x) <= 0 form
        constraints["ullage_max_F"],
        constraints["ullage_max_O"],
        -constraints["MR_min"],
        constraints["MR_max"],
        -constraints["injector_stiffness_F"],
        -constraints["injector_stiffness_O"],
    ])
```

## Edge Cases

1. **NaN Handling**: If `MR` or `P_ch` are NaN, constraints return `np.inf` (violation)
2. **Boundary Conditions**: Exactly at constraint boundary is considered safe (violation = 0)
3. **Invalid Engine Estimate**: Returns violations for all engine-dependent constraints

## Testing

Comprehensive unit tests are provided in `tests/test_robust_ddp_constraints.py`:

- Individual constraint tests (COPV, ullage, MR, injector stiffness, headroom)
- Multiple violation detection
- Edge cases (boundaries, NaN handling)
- Constraint summary generation

Run tests with:
```bash
python -m unittest tests.test_robust_ddp_constraints -v
```

