# Layer 1 Optimizer - Quick Diagnostic Guide

## How to Read the Objective Component Logs

### 1. Check if Solution is Feasible

**Look for this line:**
```
✓ FEASIBLE SOLUTION - All constraints satisfied
```
or
```
⚠️  INFEASIBLE SOLUTION - Constraint Violations Present
```

### 2. Infeasible Solution → Focus on Constraints

When infeasible, check these metrics:

| Metric | Normal Range | If Outside Range |
|--------|-------------|------------------|
| Stability Score | > 0.75 | Increase chamber length or adjust geometry |
| Thrust Error | < 10% | Adjust throat area bounds or target thrust |
| O/F Ratio Error | < 15% | Adjust injector geometry bounds |

**Common infeasibility causes:**
- Stability score too low → Geometry can't achieve stable combustion
- Very high thrust error → Throat area bounds too restrictive  
- High O/F error → Injector orifice/gap constraints incompatible

### 3. Feasible Solution → Analyze Contributors

When feasible, look at component contributions:

```
Objective Component Contributions:
  Thrust Error²:        4.225000e-05 × 100.0    = 4.225000e-03
  O/F Error²:           4.708900e-04 × 10.0     = 4.708900e-03
```

**Which component dominates?**

| Dominant Component | Contribution | Action |
|-------------------|-------------|--------|
| Thrust Error² | > 90% of total | Check throat area bounds, increase search range |
| O/F Error² | > 50% of total | Check injector geometry bounds |
| Exit Pressure | > 30% of total | Check expansion ratio bounds |
| Cf regularization | > 20% of total | May be OK, prevents unphysical Cf values |

### 4. Track Stage-by-Stage Progress

**Expected pattern:**

```
Stage 1 (DE):     obj = 0.015000  ← Initial exploration
Stage 2 (CMA-ES): obj = 0.002500  ← ~83% improvement
Stage 3 (COBYLA): obj = 0.000250  ← ~90% improvement
```

**Problem indicators:**
- No improvement from Stage 1 → 2: CMA-ES may need more iterations
- No improvement from Stage 2 → 3: Already well-optimized, or COBYLA stuck
- Still infeasible after Stage 3: Bounds too restrictive or target infeasible

## Quick Fixes

### Problem: Stuck in Infeasibility All 3 Stages

**Solution:** Loosen bounds in `configs/default.yaml`
```yaml
design_requirements:
  max_chamber_outer_diameter: 0.20  # Increase from 0.15
  max_nozzle_exit_diameter: 0.15    # Increase from 0.10
  min_Lstar: 0.80                   # Decrease from 0.95
  max_Lstar: 1.50                   # Increase from 1.27
```

### Problem: Feasible but High Thrust Error Dominates

**Solution:** Widen throat area search space
```python
# In layer1_static_optimization.py bounds definition
bounds[0] = (min_A_throat_safe * 0.8, 3.5e-3)  # Wider upper bound
```

### Problem: High O/F Error Even When Feasible

**Solution:** Check injector geometry bounds
```python
# Increase orifice diameter range
opt_config.min_d_orifice_m = 0.0015  # Smaller minimum
opt_config.max_d_orifice_m = 0.0035  # Larger maximum
```

### Problem: CMA-ES Makes No Progress

**Solution:** Increase iterations in `Layer1OptimizerConfig`
```python
opt_config.cma_maxiter = 300  # Increase from 200
```

## Objective Value Interpretation

| Objective Value | Meaning | Status |
|----------------|---------|--------|
| > 1e8 | Infeasible | ❌ Constraints violated |
| 1e-2 to 1e8 | Feasible, poor | ⚠️ Far from target |
| 1e-3 to 1e-2 | Feasible, acceptable | ✓ Within reasonable range |
| 1e-4 to 1e-3 | Feasible, good | ✓✓ Close to target |
| < 1e-4 | Feasible, excellent | ✓✓✓ Very close to target |

## Log File Location

```
output/logs/layer1_static_<timestamp>.log
```

Search for: **"Best Objective Component Breakdown"**

---

**Pro Tip:** Compare the Stage 1, 2, and 3 breakdowns side-by-side to see which components improve most at each stage!
