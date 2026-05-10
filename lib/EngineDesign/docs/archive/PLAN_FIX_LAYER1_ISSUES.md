# PLAN: Fix Layer 1 Optimizer Issues

**Date**: 2025-12-31  
**Target File**: `engine/optimizer/layers/layer1_static_optimization.py`  
**Estimated Time**: 1 hour  
**Priority**: HIGH

---

## 🎯 OBJECTIVES

Fix all identified issues in the three-phase DE → CMA-ES → COBYLA optimizer to ensure:
1. All stages complete without premature termination
2. Accurate progress reporting
3. Optimal population sizes for noisy objectives
4. Better guidance for failed evaluations
5. More aggressive exploration in refinement stage

---

## 📋 TASK BREAKDOWN

### **Task 1: Fix Early Stopping (CRITICAL)** 🔴
**Priority**: P0  
**Estimated Time**: 10 minutes  
**Lines Affected**: 602-603, 962-963

**Current Behavior**:
- If objective is "good enough" during DE or CMA-ES, optimization stops immediately
- COBYLA refinement is skipped
- Missing 10-30% potential improvement

**Desired Behavior**:
- Let all stages complete
- Only allow early exit during COBYLA (final stage)
- Ensure full optimization pipeline runs

**Implementation Steps**:

1. **Modify CMA-ES early stopping** (Line 602-603):
```python
# BEFORE:
if opt_state.get("objective_satisfied", False):
    break

# AFTER:
# Allow CMA-ES to complete even if objective satisfied
# Final refinement in COBYLA may still improve solution
if opt_state.get("objective_satisfied", False):
    layer1_logger.info("Objective satisfied, but continuing to COBYLA for final refinement")
    # Don't break - let CMA-ES complete
```

2. **Modify objective function early exit** (Line 962-963):
```python
# BEFORE:
if opt_state.get('objective_satisfied', False):
    return opt_state.get('satisfied_obj', 0.0)

# AFTER:
# Only exit early during COBYLA stage (final refinement)
if opt_state.get('objective_satisfied', False):
    current_stage = opt_state.get('current_stage', '')
    if current_stage == 'COBYLA':
        # Final stage - safe to exit early
        return opt_state.get('satisfied_obj', 0.0)
    # For DE and CMA-ES, continue to allow later stages to refine
```

**Verification**:
- Run test and verify all three stages complete
- Check that COBYLA runs even when CMA-ES finds good solution
- Verify objective continues to improve in Stage 3

---

### **Task 2: Fix Progress Bar Calculation (MODERATE)** 🟡
**Priority**: P1  
**Estimated Time**: 15 minutes  
**Lines Affected**: 950

**Current Behavior**:
- Uses `max_iterations=5000` as denominator
- Actual budget is ~3250 evaluations
- Progress bar shows 65% when complete

**Desired Behavior**:
- Progress bar reaches 95% when optimization completes
- Accurate per-stage progress tracking
- Clear indication of which stage is running

**Implementation Steps**:

1. **Add helper function** (Insert before objective function, ~line 935):
```python
def _calculate_stage_progress(opt_state: dict, opt_config: Layer1OptimizerConfig) -> float:
    """Calculate progress percentage based on current stage and iterations.
    
    Progress allocation:
    - DE:     10% to 40% (30% range)
    - CMA-ES: 40% to 70% (30% range)  
    - COBYLA: 70% to 95% (25% range)
    
    Returns:
        progress: Float between 0.0 and 1.0
    """
    stage = opt_state.get('current_stage', 'DE')
    iteration = opt_state.get('iteration', 0)
    stage_start = opt_state.get('stage_start_iteration', 0)
    stage_iter = iteration - stage_start
    
    if stage == 'DE':
        # Stage 1: 10% to 40%
        stage_budget = opt_config.de_maxiter * opt_config.de_popsize
        stage_progress = min(stage_iter / max(1, stage_budget), 1.0)
        return 0.10 + 0.30 * stage_progress
    
    elif stage == 'CMA':
        # Stage 2: 40% to 70%
        # Approximate population size (will be 11-15 for 10D problem)
        approx_popsize = 4 + int(3 * np.log(11))  # ~11
        stage_budget = opt_config.cma_maxiter * approx_popsize
        stage_progress = min(stage_iter / max(1, stage_budget), 1.0)
        return 0.40 + 0.30 * stage_progress
    
    elif stage == 'COBYLA':
        # Stage 3: 70% to 95%
        stage_progress = min(stage_iter / max(1, opt_config.cobyla_maxiter), 1.0)
        return 0.70 + 0.25 * stage_progress
    
    else:
        # Unknown stage, default to 10%
        return 0.10
```

2. **Replace line 950**:
```python
# BEFORE:
progress = 0.10 + 0.80 * min(iteration / opt_config.max_iterations, 1.0)

# AFTER:
progress = _calculate_stage_progress(opt_state, opt_config)
```

**Verification**:
- Progress starts at 10%
- Progress reaches ~40% after DE
- Progress reaches ~70% after CMA-ES
- Progress reaches ~95% after COBYLA
- No sudden jumps in progress

---

### **Task 3: Increase CMA-ES Population Size (MODERATE)** 🟡
**Priority**: P1  
**Estimated Time**: 5 minutes  
**Lines Affected**: 579

**Current Behavior**:
- Population size = 11 for 10D problem
- Too small for noisy objective landscape
- Slow convergence in CMA-ES

**Desired Behavior**:
- Minimum population size = 15
- Better gradient estimation in noisy landscape
- Faster CMA-ES convergence

**Implementation Steps**:

1. **Modify line 579**:
```python
# BEFORE:
popsize = min(32, max(8, 4 + int(3 * np.log(len(x_after_de) + 1))))

# AFTER:
# Increase minimum population for noisy objectives
# Standard formula gives ~11 for 10D, but noisy objectives need larger populations
popsize = min(40, max(15, 4 + int(3 * np.log(len(x_after_de) + 1))))
```

**Budget Impact**:
- Before: 200 iters × 11 pop = 2200 evals
- After: 200 iters × 15 pop = 3000 evals
- Total budget: 3850 evals (still < 5000)

**Verification**:
- Check that CMA-ES uses population >= 15
- Verify improved convergence rate in noisy regions
- Ensure total budget stays under 5000

---

### **Task 4: Add Injection Physics for Failed Evaluations (MINOR)** 🟠
**Priority**: P2  
**Estimated Time**: 20 minutes  
**Lines Affected**: 1058-1059 (insert after)

**Current Behavior**:
- Injection physics only computed if evaluation succeeds
- Failed designs get generic infeasibility penalty
- No guidance on why design failed

**Desired Behavior**:
- Always compute basic injection physics
- Use estimated flow rates for failed evaluations
- Provide optimizer with better failure mode information

**Implementation Steps**:

1. **Add estimated flow computation** (Insert after line 1058, in else clause):
```python
else:
    # Evaluation failed - compute injection physics with estimated flow rates
    # to guide optimizer toward better designs
    
    if has_pintle and A_lox_injector > 0 and A_fuel_injector > 0:
        # Estimate flow rates from target performance
        Cf_est = 1.5  # Typical thrust coefficient
        Pc_est_psi = 580.0
        Pc_est = Pc_est_psi * 6894.76  # Convert to Pa
        
        # Rough mass flow estimate: F = Cf * Pc * At
        mdot_total_est = target_thrust / (Cf_est * (Pc_est / target_P_exit))
        mdot_O_est = mdot_total_est * optimal_of / (1 + optimal_of)
        mdot_F_est = mdot_total_est / (1 + optimal_of)
        
        # Compute injection physics with estimates
        rho_O = 1140.0  # kg/m³
        rho_F = 780.0   # kg/m³
        sigma_O = 0.0134  # N/m (LOX surface tension)
        sigma_F = 0.026   # N/m (RP-1 surface tension)
        
        inj_physics_est = compute_injection_physics(
            mdot_O_est, mdot_F_est, A_lox_injector, A_fuel_injector,
            rho_O, rho_F, d_orifice, d_hyd_fuel,
            sigma_O, sigma_F, opt_config
        )
        
        # Apply penalties at 50% weight (since flow rates are estimates)
        # This guides optimizer without over-penalizing failed evaluations
        infeasibility_score += 0.5 * inj_physics_est["velocity_penalty"]
        infeasibility_score += 0.5 * inj_physics_est["weber_penalty"]
        infeasibility_score += 0.5 * inj_physics_est["reynolds_penalty"]
```

2. **Update comment at line 1060** to clarify this is for successful evaluations:
```python
# Injection Physics Check (for successful evaluations - use actual flow rates)
if eval_success:
```

**Verification**:
- Failed designs get differentiated penalties
- Optimizer converges faster by avoiding bad injection designs
- Infeasibility scores make physical sense

---

### **Task 5: Increase CMA-ES Initial Step Size (MINOR)** 🟠
**Priority**: P2  
**Estimated Time**: 2 minutes  
**Lines Affected**: 567

**Current Behavior**:
- Initial step size = 15% of median span
- Conservative exploration
- Slow initial CMA-ES iterations

**Desired Behavior**:
- Initial step size = 20% of median span
- More aggressive exploration of DE's promising region
- Faster CMA-ES convergence

**Implementation Steps**:

1. **Modify line 567**:
```python
# BEFORE:
sigma0 = float(np.median(span) * 0.15)

# AFTER:
# Slightly more aggressive initial step size for faster exploration
# CMA-ES will adapt down if needed
sigma0 = float(np.median(span) * 0.20)
```

**Verification**:
- CMA-ES explores more aggressively in early iterations
- Convergence rate improves
- No instabilities from larger step size

---

## 🔄 IMPLEMENTATION ORDER

Execute tasks in this order to minimize conflicts:

1. **Task 1** (Critical early stopping) - Must be first, affects all stages
2. **Task 3** (Population size) - Affects Task 2's progress calculation
3. **Task 2** (Progress bar) - Depends on Task 3's population size
4. **Task 5** (Step size) - Independent, quick win
5. **Task 4** (Injection physics) - Largest change, do last

---

## ✅ TESTING PLAN

### **Unit Tests** (Create in `tests/test_layer1_fixes.py`):

```python
def test_all_stages_complete():
    """Verify all three stages run even if early objective satisfaction."""
    # Set aggressive early stopping threshold
    # Verify DE, CMA-ES, and COBYLA all execute
    pass

def test_progress_bar_monotonic():
    """Verify progress increases monotonically and reaches 95%."""
    # Track progress values during optimization
    # Ensure no decreases
    # Ensure final progress >= 0.95
    pass

def test_cma_population_size():
    """Verify CMA-ES uses population >= 15."""
    # Check CMA-ES initialization
    # Assert popsize >= 15
    pass

def test_injection_physics_always_computed():
    """Verify injection physics penalties applied even on failure."""
    # Create design that fails evaluation
    # Verify infeasibility_score includes injection penalties
    pass

def test_stage_progress_boundaries():
    """Verify progress transitions at stage boundaries."""
    # Check progress at stage transitions
    # DE end: ~40%
    # CMA-ES end: ~70%
    # COBYLA end: ~95%
    pass
```

### **Integration Test** (Run actual optimization):

```bash
# Run full optimization and verify:
cd /home/adnan/EngineDesign
python -c "
from engine.optimizer.layers.layer1_static_optimization import run_layer1_optimization
from engine.pipeline.config_schemas import load_config
from engine.core.runner import PintleEngineRunner

config = load_config('configs/default.yaml')
runner = PintleEngineRunner(config)

requirements = {
    'target_thrust': 7000.0,
    'optimal_of_ratio': 2.3,
    'min_stability_margin': 1.2,
    'min_Lstar': 0.95,
    'max_Lstar': 1.27,
    'max_chamber_outer_diameter': 0.15,
    'max_nozzle_exit_diameter': 0.101,
}

result_config, results = run_layer1_optimization(
    config, runner, requirements, 
    target_burn_time=30.0,
    tolerances={'thrust': 0.10},
    pressure_config={'max_lox_pressure_psi': 700, 'max_fuel_pressure_psi': 850},
    report_every_n=10,
)

print('Optimization complete!')
print(f'Stages completed: {results.get(\"stages_completed\", [])}')
print(f'Final objective: {results[\"convergence_info\"][\"final_objective\"]}')
"
```

---

## 📊 SUCCESS CRITERIA

### **Functional Requirements**:
- ✅ All three stages complete in every optimization run
- ✅ Progress bar reaches 90-95% at completion
- ✅ CMA-ES uses population size >= 15
- ✅ Injection physics computed for all evaluations
- ✅ Total evaluation budget < 5000

### **Performance Requirements**:
- ✅ 10-30% improvement from COBYLA refinement
- ✅ Faster CMA-ES convergence with larger population
- ✅ Better failure mode handling with injection physics

### **Code Quality Requirements**:
- ✅ No linter errors
- ✅ All functions documented
- ✅ Type hints maintained
- ✅ Backward compatible (no API changes)

---

## 🚀 DEPLOYMENT

### **Pre-Deployment Checklist**:
- [ ] All 5 tasks completed
- [ ] Unit tests pass
- [ ] Integration test succeeds
- [ ] No linter errors
- [ ] Documentation updated
- [ ] LAYER1_REVIEW.md updated with "FIXED" status

### **Rollback Plan**:
If issues arise:
```bash
git checkout HEAD~1 -- engine/optimizer/layers/layer1_static_optimization.py
```

### **Post-Deployment Verification**:
- Run 3 full optimizations and verify:
  - All complete successfully
  - Progress bars look correct
  - Results quality maintained or improved

---

## 📝 NOTES

### **Backward Compatibility**:
All changes are internal to `layer1_static_optimization.py`. No API changes, so no impact on:
- `backend/routers/optimizer.py`
- `frontend/src/components/Layer1Optimization.tsx`
- Any other calling code

### **Performance Impact**:
- Slightly longer runtime (~10-15%) due to:
  - Larger CMA-ES population (11→15)
  - Full stage completion (no early stopping)
- Better results offset longer runtime
- Total runtime still < 30 minutes for typical problems

### **Future Enhancements** (Not in this plan):
- Parallel DE evaluation (`workers=-1`)
- Adaptive cache tolerance per stage
- Warm start from previous runs
- Multi-objective optimization support

---

## ⏱️ TIME ESTIMATE SUMMARY

| Task | Priority | Time | Complexity |
|------|----------|------|------------|
| Task 1: Early stopping | P0 | 10 min | Low |
| Task 2: Progress bar | P1 | 15 min | Medium |
| Task 3: Population size | P1 | 5 min | Low |
| Task 4: Injection physics | P2 | 20 min | Medium |
| Task 5: Step size | P2 | 2 min | Low |
| **Testing** | - | 15 min | - |
| **Documentation** | - | 5 min | - |
| **TOTAL** | - | **~72 min** | - |

---

## 👤 IMPLEMENTATION TEAM

**Developer**: AI Assistant  
**Reviewer**: Adnan (User)  
**Tester**: Automated + Manual

---

**Status**: 🟡 READY TO IMPLEMENT  
**Next Step**: Begin Task 1 (Fix Early Stopping)

