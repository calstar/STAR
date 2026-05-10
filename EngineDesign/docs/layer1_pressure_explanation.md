# Layer 1 End Pressure Calculation Explanation

## Overview
Even though Layer 1 is described as "static optimization" (evaluates at t=0), it **still optimizes the full pressure curve shape** including end pressures. This document explains how end pressures are calculated.

## Calculation Flow

### Step 1: Optimizer Variables → Pressure Segments
The optimizer has variables for each pressure curve segment:
- **Location**: `main_optimizer.py` lines 249-254
- **Variables per segment** (5 total):
  1. `type` (0=linear, 1=blowdown)
  2. `duration_ratio` (0-1, fraction of burn time)
  3. `start_pressure_ratio` (0.1-1.0, ratio of base pressure)
  4. **`end_pressure_ratio`** (0.1-1.0, ratio of base pressure) ← **This is the key!**
  5. `decay_tau_ratio` (for blowdown segments)

### Step 2: Convert Ratios to Absolute Pressures
**Location**: `helpers.py` function `segments_from_optimizer_vars()` (lines 84-180)

For each segment:
```python
# Line 165-166 in helpers.py
start_pressure_psi = start_ratio * base_pressure_psi
end_pressure_psi = end_ratio * base_pressure_psi
```

Where:
- `base_pressure_psi` = Initial pressure (`P_O_start_psi` or `P_F_start_psi`)
- `end_ratio` = Optimizer variable `x[idx_base + 3]` (clipped to 0.1-1.0)
- **Result**: `end_pressure_psi` = `end_ratio × initial_pressure`

### Step 3: Extract End Pressure from Last Segment
**Location**: `main_optimizer.py` lines 494-518

```python
# For LOX:
if lox_segments:
    lox_end_psi = lox_segments[-1]["end_pressure_psi"]  # Last segment's end pressure
    lox_end_ratio = lox_end_psi / max_lox_P_psi  # Convert to ratio of MAX pressure

# For Fuel:
if fuel_segments:
    fuel_end_psi = fuel_segments[-1]["end_pressure_psi"]  # Last segment's end pressure
    fuel_end_ratio = fuel_end_psi / max_fuel_P_psi  # Convert to ratio of MAX pressure
```

### Step 4: Store in Results
**Location**: `main_optimizer.py` lines 1988, 1991

```python
coupled_results["optimized_pressure_curves"]["lox_end_psi"] = lox_segments[-1]["end_pressure_psi"]
coupled_results["optimized_pressure_curves"]["fuel_end_psi"] = fuel_segments[-1]["end_pressure_psi"]
```

## Key Points

1. **End pressures come from optimizer variables**: The optimizer directly controls `end_pressure_ratio` for each segment (variable index `idx_base + 3`).

2. **End pressure = end_ratio × initial_pressure**: 
   - If `end_ratio = 0.8` and `initial_pressure = 400 psi`
   - Then `end_pressure = 0.8 × 400 = 320 psi`

3. **Last segment determines final end pressure**: If you have multiple segments, only the **last segment's** `end_pressure_psi` is used as the final end pressure.

4. **Why you see end pressures in Layer 1**: Even though Layer 1 evaluates at t=0, it still optimizes the **full curve shape** including end pressures. This is because:
   - The optimizer needs to know the full pressure profile to make good decisions
   - Layer 2 will use these curves for time-varying analysis
   - The end pressure affects the overall burn characteristics

## Example Calculation

Assume:
- Initial LOX pressure: `P_O_start_psi = 400 psi`
- Optimizer sets `end_pressure_ratio = 0.75` for the last segment
- Max LOX pressure: `max_lox_P_psi = 500 psi`

Calculation:
1. `lox_end_psi = 0.75 × 400 = 300 psi` (absolute end pressure)
2. `lox_end_ratio = 300 / 500 = 0.6` (ratio of max pressure, for display)

## Code References

- **Optimizer variable bounds**: `main_optimizer.py` line 352
- **Segment creation**: `helpers.py` lines 84-180
- **End pressure extraction**: `main_optimizer.py` lines 494-518
- **Result storage**: `main_optimizer.py` lines 1988, 1991

