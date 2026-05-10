# Layer 1 Static Optimization - Complete Guide

## Table of Contents
1. [Overview](#overview)
2. [Key Design Decisions](#key-design-decisions)
3. [Function Breakdown](#function-breakdown)
4. [Optimization Variables](#optimization-variables)
5. [Objective Function Deep Dive](#objective-function-deep-dive)
6. [Optimization Strategy](#optimization-strategy)
7. [Validation Logic](#validation-logic)
8. [Common Pitfalls](#common-pitfalls)

---

## Overview

**Layer 1** is the first major optimization step in the engine design pipeline. Its job is to find a **good starting point** for the engine geometry and initial tank pressures.

### What Layer 1 Optimizes (Static Only)

Layer 1 optimizes **time-independent** quantities:
- **Engine geometry**: throat area, chamber length (L*), expansion ratio, chamber diameter
- **Injector geometry**: pintle tip diameter, gap height, number of orifices, orifice diameter
- **Initial tank pressures**: single starting pressure for LOX and fuel tanks

### What Layer 1 Does NOT Optimize

- **Time-varying pressure curves**: Layer 2 handles pressure decay over the burn
- **Thermal protection thickness**: Handled in Layer 2/3
- **Flight trajectory**: Handled in Layer 4

### Why This Separation?

**Separation of concerns**: By splitting static geometry from time-varying behavior, we:
1. **Reduce complexity**: Each layer has a focused, manageable problem
2. **Improve convergence**: Optimizers work better on smaller, focused problems
3. **Enable reuse**: Layer 1 results can feed multiple Layer 2 strategies

**Validation**: Layer 1 finds a geometry that works at a single operating point (initial conditions). Layer 2 then optimizes how pressures change over time to maintain performance.

---

## Key Design Decisions

### Decision 1: Why Only Initial Pressures?

**Choice**: Layer 1 optimizes a single initial pressure per tank, not pressure curves.

**Reasoning**:
- Initial pressures determine the starting thrust and O/F ratio
- Time-varying pressure decay is a separate problem (handled in Layer 2)
- This keeps Layer 1 focused and fast

**Validation**: This is correct because:
- Rocket engines typically start at peak thrust (initial pressures)
- Pressure decay is driven by propellant consumption, not geometry
- Layer 2 can optimize curves once geometry is fixed

### Decision 2: Why Disable Thermal Protection?

**Choice**: Layer 1 disables ablative cooling and graphite inserts during evaluation.

**Reasoning**:
- Thermal protection affects time-varying behavior (recession over burn)
- Layer 1 evaluates at a single point in time (t=0)
- Including thermal effects would require time-series evaluation, which is Layer 2's job

**Validation**: This is correct because:
- At t=0, there's no recession yet (no burn time)
- Thermal effects only matter over the full burn duration
- Layer 2/3 handle thermal optimization with time-series analysis

### Decision 3: Why Clip Variables to Bounds?

**Choice**: Every optimization variable is clipped to bounds before use.

**Reasoning**:
- Optimizers can suggest values outside physical limits
- Clipping prevents invalid geometries (negative diameters, etc.)
- Ensures all intermediate calculations are valid

**Validation**: This is correct because:
- Prevents runtime errors from invalid geometries
- Keeps optimizer in feasible region
- Some optimizers (like L-BFGS-B) respect bounds, but clipping is defensive

### Decision 4: Why Two-Phase Optimization?

**Choice**: Use global search (CMA-ES or DE) followed by local refinement (L-BFGS-B).

**Reasoning**:
- Global search finds promising regions
- Local refinement fine-tunes the solution
- This hybrid approach is more robust than either alone

**Validation**: This is correct because:
- Objective function has multiple local minima
- Global search avoids getting stuck
- Local refinement improves precision efficiently

---

## Function Breakdown

### `create_layer1_apply_x_to_config()`

**Purpose**: Factory function that creates a converter from optimizer variables to engine config.

**Why a factory?** The converter needs access to `bounds`, `max_chamber_od`, and `max_nozzle_exit` which are calculated in the main function. A factory lets us inject these dependencies.

**What it does**:
1. Takes optimizer vector `x` (10 variables)
2. Clips each variable to bounds
3. Calculates derived geometry (chamber volume, contraction ratio, etc.)
4. Updates config object with all geometry
5. Returns config + initial pressures

**Key calculations**:

```python
# Chamber volume from L* and throat area
V_chamber = Lstar * A_throat

# Inner diameter = outer diameter - wall thickness
D_chamber_inner = D_chamber_outer - TOTAL_WALL_THICKNESS_M

# Chamber area from inner diameter
A_chamber = π * (D_chamber_inner / 2)²

# Contraction ratio (chamber area / throat area)
contraction_ratio = A_chamber / A_throat
```

**Why these calculations?**
- L* (characteristic length) determines chamber volume for proper mixing
- Wall thickness is fixed (1 inch total = 0.0254m)
- Contraction ratio affects flow acceleration into throat

**Validation**: These are standard rocket engine design relationships.

### `run_layer1_global_search()`

**Purpose**: Lightweight global search to improve the starting point.

**Why lightweight?** Only uses 150 function evaluations max. This is a "warm-up" phase, not the main optimization.

**What it does**:
1. **Phase 1**: Random sampling (5-20 points)
   - Samples uniformly within bounds
   - Tracks best point found
2. **Phase 2**: Short differential evolution (if available)
   - Runs for a few iterations only
   - Uses small population (8 individuals)

**Why this approach?**
- Random sampling is cheap and explores broadly
- DE is more systematic but expensive
- Limited budget keeps runtime reasonable

**Validation**: This is a reasonable warm-up strategy. The main optimization (CMA-ES or DE + L-BFGS-B) does the heavy lifting.

### `run_layer1_optimization()` - Main Function

This is the orchestrator. It:
1. Sets up logging
2. Extracts requirements
3. Calculates bounds and initial guess
4. Defines objective function
5. Runs optimization
6. Validates results
7. Packages output

Let's break down each section:

---

## Optimization Variables

Layer 1 optimizes **10 variables**:

| Index | Variable | Bounds | Description |
|-------|----------|--------|-------------|
| 0 | `A_throat` | `[min_injector_area*1.1, 0.01]` | Throat area [m²] |
| 1 | `Lstar` | `[min_Lstar, max_Lstar]` | Characteristic length [m] |
| 2 | `expansion_ratio` | `[4.0, 12.0]` | Nozzle expansion ratio |
| 3 | `D_chamber_outer` | `[0.5*max_od, max_od]` | Chamber outer diameter [m] |
| 4 | `d_pintle_tip` | `[0.010, 0.025]` | Pintle tip diameter [m] |
| 5 | `h_gap` | `[0.0003, 0.001]` | Fuel gap height [m] |
| 6 | `n_orifices` | `[10, 18]` | Number of LOX orifices (integer) |
| 7 | `d_orifice` | `[0.0012, 0.0025]` | LOX orifice diameter [m] |
| 8 | `P_O_start_psi` | `[50-95% of max]` | Initial LOX pressure [psi] |
| 9 | `P_F_start_psi` | `[50-95% of max]` | Initial fuel pressure [psi] |

### Why These Bounds?

**Throat area lower bound**: Must be larger than injector area (LOX + fuel). Prevents injector from being larger than throat, which would cause flow issues.

**L* bounds**: From requirements. L* determines mixing quality. Too low = poor mixing, too high = excessive chamber length.

**Expansion ratio**: 4-12 is reasonable for sea-level operation. Higher ratios are for vacuum.

**Chamber diameter**: Constrained by physical limits (tank diameter, etc.).

**Injector bounds**: Sized for target mass flow. Previous bounds allowed 5-6× more flow than needed, causing high thrust coefficient (Cf) issues.

**Pressure bounds**: 50-95% of max. Below 50% = too low for good performance. Above 95% = too close to max (safety margin).

### Initial Guess Strategy

The code centers initial guesses in bounds:

```python
x0 = [
    A_throat_init,                    # Calculated from target thrust
    (min_Lstar + max_Lstar) / 2,     # Center of L* range
    8.0,                              # Reasonable for sea level
    (min_od + max_od) / 2,            # Center diameter
    (bounds[4][0] + bounds[4][1]) / 2,  # Center pintle
    # ... etc
]
```

**Why center?** Gives optimizer room to explore in both directions. Starting at bounds limits exploration.

**Validation**: This is a standard approach. Some optimizers benefit from starting near expected solution, but centering is safer for global search.

---

## Objective Function Deep Dive

The objective function is the **heart** of the optimizer. It evaluates how good a candidate design is.

### Structure

```python
obj = (
    Cf_penalty +           # Highest priority
    stability_weight +      # Second priority
    thrust_penalty +        # Third priority
    of_penalty +           # Fourth priority
    exit_pressure_penalty + # Fifth priority
    length_penalty +        # Soft preference
    bounds_penalty +        # Constraint enforcement
    extra_penalties         # Very bad cases
)
```

### Priority Order Explained

**1. Cf (Thrust Coefficient) - Highest Priority**

**Why?** Cf indicates nozzle expansion quality. If Cf is wrong, the nozzle is poorly designed (over/under-expanded).

**Target**: 1.6 (ideal for sea level)
**Acceptable range**: 1.3 - 1.8
**Penalty structure**:
- Below 1.3: `800.0 * (deficit²)` - quadratic penalty
- Above 1.8: `800.0 * (excess²)` - quadratic penalty
- Within range: `50.0 * (deviation²)` - gentle penalty toward target

**Why quadratic?** Smooth penalties help gradient-based optimizers (L-BFGS-B) converge. Linear penalties create discontinuities.

**Validation**: This is correct. Cf is a critical performance metric. High penalty weight ensures optimizer prioritizes it.

**2. Stability - Second Priority**

**Why?** Unstable engines are dangerous and won't work. Must be stable before optimizing performance.

**Penalty structure**:
- Unstable state: `100.0 * (1.0 + (1.0 - score)²)`
- Score below minimum: `score_deficit * 100.0`
- Margin below 80% of required: `10.0 * (1.0 - margin/required)`

**Why multiple checks?** Stability has multiple failure modes:
- Chugging (low-frequency oscillations)
- Acoustic (high-frequency oscillations)
- Feed system (pressure oscillations)

**Validation**: This is correct. Stability is a hard constraint (must pass) but we use penalties to guide optimizer.

**3. Thrust - Third Priority**

**Why?** Must hit target thrust, but Cf and stability are more fundamental.

**Penalty**: `(thrust_error²) * 250.0`

**Why 250.0?** Lower than Cf (800.0) but higher than O/F (300.0). This weighting reflects priority.

**Validation**: This is correct. Thrust is important but can be adjusted by changing pressures. Geometry (affecting Cf) is harder to fix.

**4. O/F Ratio - Fourth Priority**

**Why?** O/F affects efficiency, but it's easier to adjust than geometry.

**Penalty**: `(of_error²) * 300.0`

**Why 300.0?** Between thrust (250.0) and exit pressure (80.0). O/F is important for efficiency but not as critical as thrust.

**Validation**: This is correct. O/F can be tuned by adjusting injector areas or pressures. Geometry changes are more expensive.

**5. Exit Pressure - Fifth Priority**

**Why?** Matching atmospheric pressure improves performance, but it's less critical than other factors.

**Penalty**: `(exit_pressure_error²) * 80.0`

**Why 80.0?** Lowest weight. Exit pressure matching is nice-to-have, not essential.

**Validation**: This is correct. Over/under-expansion reduces efficiency but doesn't break the engine.

### Constraint Handling

**Hard constraints** (reject immediately):
- Injector area > throat area: Returns `1e6` penalty
- O/F area ratio error > 80%: Returns `1e5` penalty

**Why hard constraints?** These indicate fundamentally broken designs. No point evaluating them.

**Soft constraints** (penalize but allow):
- Bounds violations: Quadratic penalty
- Very bad O/F/thrust: Extra penalties

**Why soft?** Sometimes optimizer needs to explore slightly outside bounds to find good solutions. Hard constraints can block this.

**Validation**: This is a standard approach. Hard constraints for impossible designs, soft for suboptimal ones.

### Early Exit Logic

**Removed**: Code comments indicate early stopping was removed because it caused suboptimal solutions.

**Why removed?** Early stopping can prevent optimizer from finding better solutions. Let it run to completion.

**Current behavior**: Logs good solutions but continues optimization.

**Validation**: This is correct. Early stopping is risky. Better to let optimizer converge naturally.

---

## Optimization Strategy

### Phase 1: Global Search

**Option A: CMA-ES** (if available)

**What is CMA-ES?** Covariance Matrix Adaptation Evolution Strategy. A state-of-the-art evolutionary algorithm.

**Why CMA-ES?**
- Handles noisy, non-convex objectives well
- Adapts step sizes per dimension automatically
- Good for engineering optimization problems

**Configuration**:
```python
sigma0 = median(span) * 0.15  # 15% of median range
CMA_stds[i] = desired_step / sigma0  # Per-dimension scaling
popsize = min(32, max(8, 4 + 3*log(dim)))  # Adaptive population
```

**Why per-dimension scaling?** Variables have different ranges. Expansion ratio (4-12) needs larger steps than gap height (0.0003-0.001).

**Validation**: This is correct. CMA-ES is well-suited for this problem type.

**Option B: Differential Evolution** (fallback)

**What is DE?** Population-based evolutionary algorithm. Simpler than CMA-ES but still effective.

**Configuration**:
```python
maxiter=20
popsize=10
mutation=(0.5, 1.0)
recombination=0.7
```

**Why these settings?** Conservative settings to keep runtime reasonable. Main optimization happens in Phase 2.

**Validation**: This is correct. DE is a reliable fallback.

### Phase 2: Local Refinement

**Method**: L-BFGS-B (Limited-memory BFGS with bounds)

**What is L-BFGS-B?** Quasi-Newton method that uses gradient information to find local minima.

**Why L-BFGS-B?**
- Fast convergence near optimum
- Respects bounds
- Good for smooth objectives

**Configuration**:
```python
maxiter=max_iterations
maxfun=min(max_iterations * 3, 500)  # Cap function evaluations
ftol=1e-6  # Function tolerance (tight)
gtol=1e-5  # Gradient tolerance (tight)
maxls=50   # Aggressive line search
```

**Why tight tolerances?** Want precise solutions. L-BFGS-B is efficient, so we can afford tight convergence.

**Why cap maxfun?** Prevents excessive evaluations if optimizer struggles.

**Validation**: This is correct. L-BFGS-B is standard for constrained optimization.

### Why Two Phases?

**Global search** finds promising region. **Local refinement** fine-tunes solution.

**Analogy**: Global search = "find the right city", local refinement = "find the right street address".

**Validation**: This hybrid approach is standard practice in engineering optimization.

---

## Validation Logic

After optimization, we validate the result:

### Validation Checks

1. **Thrust check**: `thrust_error < thrust_tol * 1.0`
2. **O/F check**: `of_error < 0.15` (15% tolerance)
3. **Stability check**: 
   - State ∈ {stable, marginal}
   - Score ≥ effective_min_score
   - All margins ≥ effective_margin * 0.95

### Why These Tolerances?

**Thrust**: Uses requirement tolerance (typically 10%). Must hit target.

**O/F**: 15% is relaxed because O/F can vary. Exact match less critical than thrust.

**Stability**: 95% of required margin (5% tolerance). Stability is critical, so we're strict.

**Validation**: These tolerances are reasonable. Thrust is most important, O/F is flexible.

### Failure Reasons

If validation fails, code builds detailed failure reasons:

```python
failure_reasons = []
if not thrust_check_passed:
    failure_reasons.append(f"Thrust error {error}% > {tol}% limit")
# ... etc
```

**Why detailed reasons?** Helps debug and understand what went wrong.

**Validation**: This is good practice. Clear error messages help users.

---

## Common Pitfalls

### Pitfall 1: Injector Area > Throat Area

**Problem**: If injector flow area exceeds throat area, flow can't accelerate properly.

**Solution**: Code enforces `injector_area < throat_area` with hard constraint.

**Why it happens**: Optimizer might try to increase injector size to increase mass flow, but throat area limits total flow.

**Validation**: This constraint is physically correct.

### Pitfall 2: High Cf (Thrust Coefficient)

**Problem**: Cf > 1.8 indicates over-expanded nozzle or excess thrust.

**Root cause**: Injector too large → excess mass flow → excess thrust → high Cf.

**Solution**: Code reduced injector bounds (max_d_orifice: 4mm → 2.5mm, max_n_orifices: 20 → 18).

**Why this works**: Smaller injector = less mass flow = proper thrust = correct Cf.

**Validation**: This fix addresses the root cause.

### Pitfall 3: Non-Finite Values

**Problem**: NaN or Inf can appear in calculations (e.g., division by zero).

**Solution**: Code checks `np.isfinite()` and provides fallbacks:

```python
if not np.isfinite(L_chamber):
    L_chamber = 0.2  # Default fallback
```

**Why this matters**: Non-finite values break optimizers.

**Validation**: This is defensive programming. Good practice.

### Pitfall 4: Integer Variables

**Problem**: `n_orifices` is integer, but optimizer treats it as continuous.

**Solution**: Code rounds to nearest integer:

```python
n_orifices = int(round(np.clip(x[6], bounds[6][0], bounds[6][1])))
```

**Why this works**: Optimizer can suggest 14.7 orifices, we round to 15. Small error is acceptable.

**Better approach**: Use mixed-integer optimization, but that's more complex.

**Validation**: Rounding is acceptable for this problem. Exact integer optimization would be better but is overkill.

### Pitfall 5: Pressure Units

**Problem**: Code mixes psi and Pa. Easy to make unit errors.

**Solution**: Code uses `psi_to_Pa = 6894.76` conversion factor consistently.

**Where it matters**:
- Bounds: psi (user-friendly)
- Calculations: Pa (SI units)
- Config: Can be either (check units)

**Validation**: Unit conversion is correct. `1 psi = 6894.76 Pa`.

---

## Summary

Layer 1 static optimization:

1. **Optimizes**: Geometry + initial pressures (static only)
2. **Strategy**: Global search (CMA-ES/DE) + local refinement (L-BFGS-B)
3. **Objective**: Weighted sum of penalties (Cf > Stability > Thrust > O/F > Exit P)
4. **Output**: Optimized config + initial pressures for Layer 2

**Key insights**:
- Separation of static vs. time-varying is correct
- Two-phase optimization is robust
- Priority order in objective is well-designed
- Constraint handling is appropriate

**Validation**: The design is sound. Choices are justified and follow best practices.



