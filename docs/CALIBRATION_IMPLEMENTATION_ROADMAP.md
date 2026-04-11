# Calibration Stack Implementation Roadmap

## Paper vs. Current Implementation

This document maps the paper "A Unified Mathematical Framework for Autonomous Pressure Transducer Calibration" to the codebase and identifies implementation gaps.

---

## 1. Environmental-Robust Basis Functions

| Paper | Current | Gap |
|-------|---------|-----|
| 9 parameters (φ₀–φ₈) | 6 parameters | **Expand to 9** |
| Voltage-based φ(v, e) | ADC-norm based | Paper uses voltage; we use ADC. Need voltage conversion or align paper to ADC. |
| φ₆ = v·T·H (temp-humidity) | Missing | Add |
| φ₇ = v²·V·M (vibration-mounting) | Missing | Add |
| φ₈ = A·v³ (aging-nonlinearity) | Missing | Add |

**Action**: Expand `RobustCalibrationFramework.environmental_robust_basis_functions` to 9-parameter basis matching paper Eqs. (φ₀–φ₈).

---

## 2. Allan Variance Analysis

| Paper | Current | Gap |
|-------|---------|-----|
| Section 3: Allan variance | **Not implemented** | **New module** |
| Noise decomposition: Q, B, K, R | None | Build `allan_variance.py` |
| PSD → Allan variance mapping | None | Implement Algorithm 1 |
| Informs σ_meas(v, τ) | Fixed uncertainty | Use Allan-derived σ in calibration |

**Action**: Create `scripts/calibration/allan_variance.py` with:
- `compute_allan_variance(timeseries, tau0)` 
- `fit_noise_coefficients(sigma_A_squared, tau)` → Q, B, K, R
- `measurement_uncertainty(tau)` from Eq. (σ_meas²)

---

## 3. Stochastic Bias Modeling (Gauss-Markov)

| Paper | Current | Gap |
|-------|---------|-----|
| Section 4: db/dt = -b/τ_b + w_b | **Not implemented** | **New** |
| Multi-state bias (fast, medium, slow) | None | Add bias state to prediction |
| Discrete-time: b_{k+1} = Φ_b b_k + w_b | None | Integrate into RLS/Kalman |

**Action**: Add `GaussMarkovBiasModel` to `robust_calibration.py`:
- 3-state bias: τ_fast=1s, τ_medium=100s, τ_slow=10⁴s
- Predict: include h^T b in pressure prediction
- Update: bias state in recursive update

---

## 4. Hierarchical Bayesian (3-Level)

| Paper | Current | Gap |
|-------|---------|-----|
| Level 1: μ_pop, Σ_pop | AdaptivePriorEvolution | ✓ Exists |
| Level 2: θ_j | θ_mean, θ_cov per channel | ✓ Exists |
| Level 3: p_ji | CalibrationPoint | ✓ Exists |
| Population prior **persistence** | learned_prior.json | ✓ Exists |
| Human calibration: w = 10⁶ | Fixed uncertainty | Use 10⁻⁶ for human points |

**Action**: Ensure human calibration points use `uncertainty=1e-3` (σ²=10⁻⁶) so they dominate posterior.

---

## 5. Cross-Sensor Knowledge Transfer

| Paper | Current | Gap |
|-------|---------|-----|
| **consensus_enabled** flag | OperationMode in calibration_robustness | Exists but **not wired** |
| Test mode: consensus ON | RobustnessManager has mode | Not used in orchestrator |
| Flight mode: consensus OFF | Same | **Wire mode to orchestrator** |
| Consensus: ŷ_consensus = Σ w_j ŷ_j / Σ w_j | **Not implemented** | **New** |
| Agreement score | None | Add |
| Self-calibration when α≥0.6, agreement>0.6 | Active learning only | **Add consensus-based self-cal** |
| Cross-sensor covariance C_cross | None | Add for transfer |

**Action**: 
1. Wire `consensus_enabled` from config/orchestrator to calibration logic.
2. Implement consensus computation (test mode only).
3. Implement agreement score.
4. Add self-calibration when consensus + agreement thresholds met.
5. Add C_cross estimation and transfer.

---

## 6. Adaptive Uncertainty Quantification

| Paper | Current | Gap |
|-------|---------|-----|
| Heteroscedastic: σ²(v,e) = σ_base² + α_v v² + ... | env_variance_base only | **Expand** |
| Extrapolation uncertainty σ_extrap | None | **Add** |
| Total: σ_pred² = σ_meas + φ'Σφ + σ_extrap + h'Σ_b h | Partial (φ'Σφ) | Complete |
| Disagreement inflation ρ_inflate | None | **Add** |
| Agreement deflation | None | **Add** |

**Action**: Extend `predict_pressure_with_uncertainty` with full 4-term variance model and inflation/deflation.

---

## 7. Progressive Autonomy

| Paper | Current | Gap |
|-------|---------|-----|
| Multi-factor: α = 0.4α_cal + 0.3α_unc + 0.2α_agree + 0.1α_quality | None | **New** |
| α_cal = min(1, N_j/5) | get_confidence_level (LOW/MEDIUM/HIGH) | Replace with numeric α |
| α_unc = exp(-σ²/σ_ref²) | None | Add |
| α_agree = fraction of |r|<2σ over window | None | Add |
| α_quality = 1 - NRMSE | rmse in summary | Add |
| Self-cal when α≥0.6, agreement>0.6 | ActiveLearningAgent requests | Add consensus-based self-cal |

**Action**: Create `AutonomyScore` class with 4 factors; use in self-calibration and consensus weighting.

---

## 8. Zero-Point Calibration

| Paper | Current | Gap |
|-------|---------|-----|
| Single zero-point → propagate to all PTs | clear_calibration + zero_all | **Add propagation** |
| Zero-point: (v_j, 0, e, 10⁻⁶) | zero_all sets pressure=0 | Need to propagate to other PTs |
| Full-range extrapolation from prior | Population prior used | ✓ Prior exists |

**Action**: When human provides zero-point for PT j, add (v_k, 0, e_k, 0.01) for all k≠j.

---

## 9. Implementation Order

Recommended sequence:

1. **Phase A – Foundation**
   - [ ] Expand basis to 9 parameters (robust_calibration.py)
   - [ ] Wire consensus_enabled from config to orchestrator
   - [ ] Add zero-point propagation

**Phase A (DONE):**
- [x] Expand basis to 9 parameters (robust_calibration.py)
- [x] Wire consensus_enabled from config to orchestrator
- [x] Add zero-point propagation (propagate_zero_point, human σ²=10⁻⁶)

2. **Phase B (DONE) – Uncertainty & Autonomy**
   - [x] Allan variance module (allan_variance.py)
   - [x] Full uncertainty model (4 terms + extrapolation)
   - [x] Multi-factor autonomy score (α_cal, α_unc, α_agree, α_quality)

3. **Phase C (DONE) – Consensus & Transfer**
   - [x] Consensus computation (test mode only)
   - [x] Agreement score
   - [x] Self-calibration when α≥0.6, agreement>0.6
   - [ ] Cross-sensor covariance C_cross (deferred)

4. **Phase D (DONE) – Bias & Refinement**
   - [x] Gauss-Markov bias model (GaussMarkovBiasModel, 3-state τ=1/100/10⁴s)
   - [x] Inflation/deflation (agreement-based in _run_consensus_and_self_cal)
   - [x] Human calibration weight 10⁶ (σ=1e-3 in calibration_server)

---

## 10. Config Additions

```toml
[calibration]
consensus_enabled = true   # false for flight mode

[calibration.autonomy]
alpha_cal_weight = 0.4
alpha_unc_weight = 0.3
alpha_agree_weight = 0.2
alpha_quality_weight = 0.1
self_cal_threshold = 0.6
agreement_threshold = 0.6

[calibration.zero_point]
propagate_to_all = true
propagation_uncertainty = 0.01
```

---

## 11. File Changes Summary

| File | Changes |
|------|---------|
| `robust_calibration.py` | 9-param basis, Gauss-Markov bias, full uncertainty |
| `autonomous_calibration_engine.py` | Autonomy score, consensus integration |
| `calibration_orchestrator.py` | consensus_enabled, zero propagation, consensus loop |
| `calibration_robustness.py` | Mode → consensus_enabled wiring |
| `allan_variance.py` | **New file** |
| `config/config.toml` | New calibration sections |
