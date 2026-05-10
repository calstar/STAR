# PLAN: Fix Layer 1 Optimizer Issues (Based on Original Implementation Plan)

**Date**: 2025-12-31  
**Context**: Original plan implemented successfully, but practical testing revealed optimization opportunities  
**Target File**: `engine/optimizer/layers/layer1_static_optimization.py`  
**Estimated Time**: 45 minutes  
**Priority**: MEDIUM (refinements, not critical bugs)

---

## 📊 ANALYSIS: Original Plan vs Current Issues

### ✅ **Successfully Implemented (No Changes Needed)**
- Three-stage deterministic optimizer (DE → CMA-ES → COBYLA)
- Configuration dataclass with all parameters
- Physical constraints (Weber, Reynolds, velocity)
- Exit pressure prioritization (weight = 5e5)
- Cf bounds [1.3, 1.8]
- O/F tolerance 12%
- Reporting frequency control
- Deterministic seeding (seed=42)

### ⚠️ **Optimization Opportunities Found**

The implementation follows the original plan correctly, but practical considerations suggest improvements:

1. **Early Stopping** - Intentionally designed to exit when satisfied, but skips valuable COBYLA refinement
2. **Progress Bar** - Not addressed in original plan, currently inaccurate
3. **Population Size** - Original formula is correct but could be tuned for noisy objectives
4. **Injection Physics** - Only computed on success, could guide optimizer better on failures

---

## 🎯 REVISED IMPLEMENTATION PLAN

### **Task 1: Smart Early Stopping** 🟡
**Priority**: P1 (Optimization, not bug fix)  
**Rationale**: Original plan had early stopping, but COBYLA refinement valuable  
**Time**: 8 minutes

**Change**: Make early stopping conditional on stage

**Location**: Lines 602-603, 962-963

**Implementation**:
```python
# Line 602-603 (in CMA-ES loop):
if opt_state.get("objective_satisfied", False):
    # Satisfied during CMA-ES - but COBYLA refinement may still help
    layer1_logger.info("Objective satisfied in CMA-ES - proceeding to COBYLA for final polish")
    # Continue to COBYLA instead of breaking

# Line 962-963 (in objective function):
if opt_state.get('objective_satisfied', False):
    # Only exit early if in final stage (COBYLA)
    current_stage = opt_state.get('current_stage', '')
    if current_stage == 'COBYLA':
        return opt_state.get('satisfied_obj', 0.0)
    # For DE/CMA-ES, log but continue to allow full pipeline
```

**Expected Impact**: 5-15% additional improvement from COBYLA polish

---

### **Task 2: Accurate Progress Tracking** 🟡
**Priority**: P1 (UX improvement)  
**Rationale**: Original plan didn't specify progress calculation, current implementation confusing  
**Time**: 12 minutes

**Change**: Stage-aware progress calculation

**Location**: Line 950

**Implementation**:
```python
# Add helper function before objective (around line 935):
def _calculate_stage_progress(opt_state: dict, opt_config: Layer1OptimizerConfig) -> float:
    """Calculate accurate progress based on stage completion.
    
    Progress allocation (matching original plan's budget):
    - DE:     10% → 40% (750 evals ≈ 22% of budget)
    - CMA-ES: 40% → 70% (2400 evals ≈ 69% of budget)
    - COBYLA: 70% → 95% (300 evals ≈ 9% of budget)
    """
    stage = opt_state.get('current_stage', 'DE')
    iteration = opt_state.get('iteration', 0)
    stage_start = opt_state.get('stage_start_iteration', 0)
    stage_iter = iteration - stage_start
    
    if stage == 'DE':
        # Original plan: 50 iter × 15 pop = 750 evals
        budget = opt_config.de_maxiter * opt_config.de_popsize
        progress = min(stage_iter / max(1, budget), 1.0)
        return 0.10 + 0.30 * progress
    
    elif stage == 'CMA':
        # Original plan: 200 iter × ~12 pop ≈ 2400 evals
        # Population: 4 + 3*ln(n) ≈ 11 for n=10
        est_popsize = 4 + int(3 * np.log(11))
        budget = opt_config.cma_maxiter * est_popsize
        progress = min(stage_iter / max(1, budget), 1.0)
        return 0.40 + 0.30 * progress
    
    elif stage == 'COBYLA':
        # Original plan: 300 iterations
        progress = min(stage_iter / max(1, opt_config.cobyla_maxiter), 1.0)
        return 0.70 + 0.25 * progress
    
    return 0.10  # Default fallback

# Replace line 950:
# OLD: progress = 0.10 + 0.80 * min(iteration / opt_config.max_iterations, 1.0)
# NEW:
progress = _calculate_stage_progress(opt_state, opt_config)
```

**Expected Impact**: Clear, accurate progress reporting

---

### **Task 3: Optional Population Size Tuning** 🟢
**Priority**: P2 (Optional optimization)  
**Rationale**: Original formula correct, but can tune for noisy objectives  
**Time**: 3 minutes

**Change**: Optional increase for noisy landscapes (user can revert if not helpful)

**Location**: Line 579

**Implementation**:
```python
# ORIGINAL (keep as comment for reference):
# popsize = min(32, max(8, 4 + int(3 * np.log(len(x_after_de) + 1))))
# Standard CMA-ES formula: 4 + 3*ln(n) ≈ 11 for n=10

# OPTIONAL TUNING: Increase for noisy objectives (discrete vars + cache quantization)
popsize = min(40, max(12, 4 + int(3 * np.log(len(x_after_de) + 1))))
# For n=10: max(12, 11) = 12 (modest increase)
# Budget impact: 200 × 12 = 2400 evals (same as original plan estimate)
```

**Note**: This is a **conservative tuning**, not a fundamental change. Original plan estimated ~2400 evals for CMA-ES, this matches that exactly.

**Expected Impact**: Slightly more robust in noisy regions (5-10% better convergence)

---

### **Task 4: Optional Injection Physics Guidance** 🟢
**Priority**: P3 (Nice to have)  
**Rationale**: Original plan computes physics only on success, adding fallback helps optimizer  
**Time**: 15 minutes

**Change**: Compute estimated injection physics for failed evaluations

**Location**: After line 1058 (in else clause)

**Implementation**:
```python
else:
    # Evaluation failed
    # OPTIONAL ENHANCEMENT: Provide injection physics guidance even on failure
    # This helps optimizer understand *why* design failed
    
    if has_pintle and A_lox_injector > 0 and A_fuel_injector > 0:
        # Estimate flow rates from target performance
        Cf_est = 1.5
        Pc_est_psi = 580.0
        Pc_est = Pc_est_psi * 6894.76
        
        # Rough estimate: mdot = F / (Cf * Pc / P_ambient)
        mdot_total_est = target_thrust / (Cf_est * (Pc_est / target_P_exit))
        mdot_O_est = mdot_total_est * optimal_of / (1 + optimal_of)
        mdot_F_est = mdot_total_est / (1 + optimal_of)
        
        # Physical constants (from original plan)
        rho_O = 1140.0
        rho_F = 780.0
        sigma_O = 0.0134
        sigma_F = 0.026
        
        # Compute injection physics with estimates
        inj_physics_est = compute_injection_physics(
            mdot_O_est, mdot_F_est, A_lox_injector, A_fuel_injector,
            rho_O, rho_F, d_orifice, d_hyd_fuel,
            sigma_O, sigma_F, opt_config
        )
        
        # Apply at 50% weight (flow rates are estimates)
        infeasibility_score += 0.5 * inj_physics_est["velocity_penalty"]
        infeasibility_score += 0.5 * inj_physics_est["weber_penalty"]
        infeasibility_score += 0.5 * inj_physics_est["reynolds_penalty"]
```

**Expected Impact**: 5-10% faster convergence by avoiding bad injection designs earlier

---

### **Task 5: Optional Step Size Tuning** 🟢
**Priority**: P3 (Nice to have)  
**Rationale**: Original plan uses 15%, slightly more aggressive may help  
**Time**: 2 minutes

**Change**: Modest increase in initial CMA-ES exploration

**Location**: Line 567

**Implementation**:
```python
# ORIGINAL (keep as comment):
# sigma0 = float(np.median(span) * 0.15)  # 15% as per original plan

# OPTIONAL TUNING: Slightly more aggressive for faster initial exploration
sigma0 = float(np.median(span) * 0.18)  # 18% (modest increase)
# CMA-ES will adapt down if too aggressive, so low risk
```

**Expected Impact**: Marginal (~2-5% faster early iterations)

---

## 🎯 TASK PRIORITY MATRIX

| Task | Priority | Value | Risk | Time |
|------|----------|-------|------|------|
| Task 1: Smart Early Stopping | P1 🟡 | High | Low | 8 min |
| Task 2: Progress Tracking | P1 🟡 | High | None | 12 min |
| Task 3: Population Tuning | P2 🟢 | Medium | None | 3 min |
| Task 4: Injection Guidance | P3 🟢 | Medium | Low | 15 min |
| Task 5: Step Size Tuning | P3 🟢 | Low | None | 2 min |

**Recommended Implementation**:
- **Minimum**: Tasks 1-2 (20 minutes, high value)
- **Recommended**: Tasks 1-3 (23 minutes, balanced)
- **Maximum**: All tasks (40 minutes, complete refinement)

---

## 🧪 TESTING PLAN

### **Test 1: Stage Completion**
```python
# Verify all three stages complete
def test_stage_completion():
    # Run optimization
    result = run_layer1_optimization(...)
    
    # Check logs for stage completion messages
    assert "Stage 1 (DE):" in logs
    assert "Stage 2 (CMA-ES):" in logs  
    assert "Stage 3 (COBYLA):" in logs
```

### **Test 2: Progress Accuracy**
```python
# Verify progress reaches 90-95%
def test_progress_accuracy():
    progress_values = []
    
    def track_progress(stage, progress, msg):
        progress_values.append(progress)
    
    run_layer1_optimization(..., update_progress=track_progress)
    
    assert max(progress_values) >= 0.90
    assert all(progress_values[i] <= progress_values[i+1] for i in range(len(progress_values)-1))
```

### **Test 3: Determinism**
```python
# Verify deterministic results (as per original plan)
def test_determinism():
    result1 = run_layer1_optimization(config, ...)
    result2 = run_layer1_optimization(config, ...)
    
    assert np.allclose(result1['best_x'], result2['best_x'])
```

### **Test 4: Budget Compliance**
```python
# Verify total evaluations match original plan
def test_budget():
    result = run_layer1_optimization(...)
    total_evals = result['convergence_info']['total_evaluations']
    
    # Original plan: ~3450 evals (750 + 2400 + 300)
    assert total_evals < 5000  # Hard limit
    assert 2500 < total_evals < 4000  # Expected range
```

---

## 📋 IMPLEMENTATION CHECKLIST

### **Pre-Implementation**
- [x] Review original implementation plan
- [x] Identify optimization opportunities
- [x] Prioritize changes
- [ ] Get user approval on priority (P1, P2, or P3)

### **Implementation (P1 - Recommended)**
- [ ] Task 1: Smart early stopping (8 min)
- [ ] Task 2: Progress tracking (12 min)
- [ ] Task 3: Population tuning (3 min)

### **Optional Implementation (P2-P3)**
- [ ] Task 4: Injection guidance (15 min)
- [ ] Task 5: Step size tuning (2 min)

### **Testing**
- [ ] Run test suite
- [ ] Verify determinism maintained
- [ ] Check budget compliance
- [ ] Validate progress accuracy

### **Documentation**
- [ ] Update LAYER1_REVIEW.md with "REFINED" status
- [ ] Add comments explaining changes from original plan
- [ ] Document performance improvements

---

## 🎯 RECOMMENDATION

**Implement P1 tasks (Tasks 1-3) only** for the following reasons:

1. **Low Risk**: Changes are conservative refinements, not architectural changes
2. **High Value**: Progress accuracy crucial for UX, early stopping affects results quality
3. **Fast**: 23 minutes total implementation time
4. **Preserves Intent**: Honors original plan while optimizing for practical use

**P2-P3 tasks are optional** and can be added later if benchmarking shows they're beneficial.

---

## 🚀 READY TO PROCEED?

**Option A (Recommended)**: Implement P1 tasks only (23 min)
- Task 1: Smart early stopping
- Task 2: Progress tracking
- Task 3: Population tuning

**Option B (Conservative)**: Implement P1 tasks 1-2 only (20 min)
- Task 1: Smart early stopping
- Task 2: Progress tracking
- Skip population tuning (keep original formula)

**Option C (Complete)**: Implement all tasks (40 min)
- All P1, P2, P3 tasks
- Full refinement suite

---

**Which option would you like?** (A recommended, B conservative, C complete)

