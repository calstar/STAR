# EngineDesign Deep Review — Consolidated Findings

> Generated 2026-07-14 by a multi-agent code/physics review (7 parallel subsystem reviewers + consolidation).
> This file is git-ignored — it is a working document, not part of the repo.
>
> **Scope (the active pipeline, determined from git history):** `engine/native/` C kernel, `engine/core/` Python solver,
> `engine/optimizer/` layers 1–4, `engine/pipeline/` (CEA, combustion, thermal, stability, config), `copv/`,
> `backend/` routers, flight sim (`ui/flight_sim.py`), `engine/control/robust_ddp/`.
> **Excluded as deprecated:** `archive/scrap_files/`, `engine/pipeline/archive/`, `docs/archive/`.
>
> **Severity scale:** 5 = results wrong or feature broken in normal use · 4 = wrong results in realistic configs / big silent trap ·
> 3 = moderate accuracy or robustness impact · 2 = minor/latent · 1 = cosmetic or dormant.
>
> Part 1 is the deduplicated, ranked consolidation. Appendices A–G are the full, unedited subsystem reports
> (every finding with file:line, mechanism, and quantified impact — including lower-severity items not repeated in Part 1).

---

# Part 1 — Consolidated ranked report

> **Checklist status:** findings are tracked as `- [ ]` (open) / `- [x]` (fixed). Progress: **Tier 1 item 1 ✅**, **Tier 1 item 2 ✅** (dead orchestrator quarantined; live Layer 3 exception path hardened to fail closed). Appendices A–G below remain reference material, not checklist items.

**TL;DR:** The chamber-pressure closure, CEA plumbing, and the C port itself are in good shape — the C kernel is a faithful port and the core mass-balance math checks out. The damage is concentrated in five places: **(1)** reported thrust/Isp is systematically ~10–17% optimistic because efficiencies never reach the thrust equation; **(2)** the full multi-layer orchestrator (`main_optimizer.py`) is dead — it crashes right after Layer 1; **(3)** the thermal chain has three compounding heat-flux bugs (~3–5× throat heat load) plus dead soak-through checks; **(4)** the stability gate can certify unstable designs and can never fail on analysis errors; **(5)** the DDP controller is effectively non-functional as an optimizer (zero thrust gradient) and hardcodes the wrong propellant. Layer 2 also barely optimizes due to convergence-latch bugs.

---

## Tier 1 — Critical: wrong results or broken behavior in normal use

- [x] **1. Thrust/Isp overpredicted ~10–17% systematically** — `engine/core/nozzle.py:163-607` ✅ **FIXED** (`calculate_thrust` now computes delivered thrust on the RPA thrust-coefficient basis, `F(Pa) = ζ_n·Cf_vac·Pc·At − Pa·Ae`, with `Cf_vac` from the CEA cache; η_c\* rides in through the efficiency-reduced `Pc` from the chamber solve and η_noz = `nozzle_efficiency`, so delivered F/Isp carry both. The retired momentum method expanded from the ideal `Tc`; the tautological `F_total` vs `F_mom+F_pres` check went with it. `v_exit`/`P_exit`/`T_exit` are still reported frozen-isentropic as display/parity values and are *not* the delivered-thrust basis. The C fast path computes the same formula at `engine/native/src/ed_evaluate.c:69` — `ed_nozzle_solve`'s momentum-method `F` is dead in that path — and the two are held together live, per-field, by `tests/test_native_ab_parity.py::TestKernelStructParity` in the `native-parity` CI job.)
`v_exit` is computed from the raw ideal CEA chamber temperature; `η_c*` only enters the mass balance and cancels out of `Isp = F/(ṁg₀)`, and `nozzle_efficiency` (0.95) multiplies a `Cf` that's only used in a dead fallback branch (the validation check at `nozzle.py:603-608` compares `F_total` to `F_mom+F_pres`, which are identically equal — a tautology). With η_c*≈0.90, η_noz=0.95, every evaluate/optimize/time-series result overpredicts delivered F and Isp by ≈1/(0.90·0.95) ≈ **+17%**. Worse, at fixed Pc, computed F ∝ 1/η_c* — lower combustion efficiency *increases* thrust. The internal inconsistency is visible in the code itself: `chamber_solver.py:745-750` computes a validation Isp with the efficiencies applied, which disagrees with the returned Isp by exactly this factor. **This is the single most consequential physics bug — every design the tool has produced is sized against inflated performance.**

- [x] **2. The full multi-layer pipeline orchestrator is dead code that crashes** — `engine/optimizer/main_optimizer.py:237` ✅ **RESOLVED** (orchestrator was dead Streamlit-only code, superseded by the live backend path's direct Layer 2a + Layer 3 calls; quarantined to `archive/dead_code_20260715/`. Sub-items below.)
`optimized_pressure_curves.get("lox_start_psi", max_lox_P_psi * 0.8)` — `max_lox_P_psi` isn't assigned until line 365 (and `.get()` defaults evaluate eagerly), so `run_full_engine_optimization_with_flight_sim` raises `NameError` on every run, right after Layer 1. Additionally, it imports a module that doesn't exist (`layers/layer2_burn_candidate`, `main_optimizer.py:37-42`, silently set to `None`, then called → `TypeError` swallowed by a broad `except`), and three of its four Layer-2 invocations use a wrong function signature (guaranteed `TypeError`, also swallowed). The backend/React path survives only because it calls the layers directly. **Everything from line 237 to 1291 is unreachable; the CLI/Streamlit orchestration path is broken end-to-end.** (Related: its inline Layer 3 hardcodes `thermal_protection_valid = True` even when the liner burns through, `main_optimizer.py:1027`.)
  - [x] **NameError from `max_lox_P_psi`/`max_fuel_P_psi` use-before-assignment (line 237)** ✅ **FIXED** — hoisted both reads into the pressure-config block (~line 174), before their first use; removed the now-redundant reads at line 365.
  - [x] `layer2_burn_candidate` import fails silently to `None` (lines 37–42), then gets called → `TypeError` swallowed by broad `except`. ✅ **RESOLVED** — module was intentionally dissolved (commit `b0442522`: pressure work → Layer 2a, thermal-thickness work → Layer 3); the calling orchestrator is quarantined.
  - [x] Three of four Layer-2 invocations use a wrong function signature (guaranteed `TypeError`, also swallowed). ✅ **RESOLVED** — the triplicated broken blocks left the tree with the quarantined orchestrator.
  - [x] Inline Layer 3 hardcodes `thermal_protection_valid = True` even when the liner burns through (`main_optimizer.py:1027`). ✅ **RESOLVED** — the hardcode existed only in the dead inline Layer 3 (quarantined). The live Layer 3 (`layer3_thermal_protection.py:1004`) already computes `bool(ablative_ok and graphite_ok)`; separately hardened its exception path to fail closed (`thermal_protection_valid = False` on re-eval failure) rather than keep the optimistic default.

- [ ] **3. Layer 2 pressure optimization barely optimizes** — `engine/optimizer/layers/layer2_pressure.py`
Three interacting defects:
- **Convergence latch kills the search** (lines 1114–1165, 1231): five consecutive identical objectives — including five `1e6` failure penalties, common in DE's random initial population — permanently latches "converged" and short-circuits all remaining evaluations. And the rate-of-change latch has no phase guard (unlike its twin at line 874), so L-BFGS-B's finite-difference probes trip it inside the first gradient computation → the polish phase is a no-op. Effective search ≈ whatever DE sampled before the first latch.
- **Blowdown segment curves are discontinuous** (lines 130–133): `P(t)=P_end+ΔP·e^(−kt)` never reaches `P_end` (retains up to 90% of ΔP at k=0.1), so the generated curve has a pressure cliff at every segment boundary while monotonicity/slope constraints are checked on the nominal endpoints instead. The solver is fed physically impossible tank-pressure steps. Fix: normalize `(e^(−kt)−e^(−k))/(1−e^(−k))`.
- **Final decode uses the wrong pressure floors** (lines 2128–2163 vs 722–726): returned curves can dip below the 0.75·Pc chug-stability floor that was enforced during scoring — the curves you get back are not the curves that were evaluated. And the non-convergence fallback can silently return a flat hardcoded 5 MPa curve (line 63) when no progress callback is passed.

- [ ] **4. Thermal protection: heat load ~3–5× overestimated, and the checks that matter are dead** — `engine/pipeline/`
- `time_varying_solver.py:360`: dict-key mismatch — the code looks up `"h_g"` but the producer returns `"h_hot"`, so the convective coefficient is **always the 50,000 W/m²K fallback** (25–100× too high). This pins the graphite surface temperature at its 2,500 K clip every step and forces recession to the diffusion limit regardless of conditions.
- `regen_cooling.py:606-611`: gas radiation as gray body with ε=0.8 at full Tc⁴ — a soot-laden solid-motor value; realistic gas emissivity for LOX/CH4 products here is ~0.05–0.15. Radiation wrongly dominates chamber flux (~75% of it).
- `time_varying_solver.py:380-391`: the Bartz chamber→throat ratio (~6–9×) is applied to the **total** flux including that radiation, which doesn't scale with mass flux. Net throat heat load ≈40–50 MW/m² vs realistic 8–15.
- `thermal_analysis.py:100-117`: the steady-state wall temperature "solver" never uses the conduction resistances it builds — back-face temperatures come out at 10⁴–10⁶ K. Currently nothing consumes them, but the mechanism meant to check steel-case soak-through is therefore absent (no consumer checks case overtemperature at all), and the graphite backside coupling is dead code (`'T_stainless_throat' not in locals()` at line 455 is always True — it's assigned 500 lines later).
- **Net:** liner thicknesses come out conservative (oversized), so this isn't dangerous today, but every reported temperature, heat flux, and thermal margin is untrustworthy, and the one constraint that could pass an unsafe design (insulation/soak-through) doesn't exist.
  - [x] **Gas-side heat load reworked** ✅ — viscosity unit fix; single `gas_transport` provider; CEA frozen k/Pr/cp; wall solver fixed & validated vs Huzel Sample Calc 4-7; gas emissivity separated from wall emissivity; Bartz (eq. 4-13, `thermal/bartz.py`) replaces Dittus-Boelter, validated term-by-term vs Sample Calc 4-3; `Tc·η²` combustion correction fed into the chain; cooling→c\* via √ not linear.
  - [x] **Wall-temperature loop + bulk cp** ✅ — the misused 1200 K failure limit replaced by a bound [T_d, Taw]; ships the cold/conservative end; three `γR/(γ−1)` bulk-cp sites → equilibrium cp. (commit `f08d353e`)
  - [x] **Ablative liner survival = Huzel char depth** ✅ — `thermal/huzel_char_depth.py` (eqs. 4-36/4-37), imperial core + SI wrapper, validated term-by-term vs Sample Calc 4-6 (0.828/0.599 in) AND every Huzel→SI conversion pinned to an independent reference. Wired as `ablative.liner_survival`; material specs set to the Huzel A-4 baseline pending hot-fire data. (commits `96aa2443`, `b23a3bda`)
  - [x] **Legacy surface-recession model quarantined** ✅ — tagged `LEGACY_UNVALIDATED` at the source; UI relabeled "legacy, unvalidated" (charts left live per decision), trusted char depth surfaced alongside. (commit `c6355a8f`)
  - [ ] **TODO — clean up the live recession consumers.** "Leave live, labeled" was the interim call, so the unvalidated surface-recession output is still COMPUTED and drives real outputs: `runner.py`'s time-varying geometry-evolution loop (chamber/throat/exit L\* evolution, ~lines 990–1145) and the frontend recession charts (`backend/routers/timeseries.py`, `PressureCurveChart.tsx`). Decide the end state (replace the geometry-evolution driver with char depth / retire the recession charts / delete `thermal_analysis.calculate_required_ablative_thickness` which is already dead) and remove the quarantined path. The `time_varying_solver.py:360` `"h_g"`/`"h_hot"` key mismatch and the throat-ratio-on-total-flux bug (lines 380–391) live in this same recession path and should be resolved as part of that cleanup rather than patched in place.

- [ ] **5. Stability gate can certify unstable designs and cannot fail on errors** — `engine/pipeline/stability/analysis.py`
- Lines 329–348: gate margin = `1 + 0.3·tanh((GM−0.80)/0.20)` means the Layer-1 requirement of 1.2 corresponds to **gain margin 0.96 < 1** — a Nyquist-unstable loop meets the "1.2 margin" requirement; the tanh saturates so GM=2 barely scores above GM=1.
- Lines 704–727: any exception/NaN in the physical stability model yields neutral-pass fallbacks (acoustic 1.10, chug floored at 1.0) — **a broken analysis can never reject a design**.
- `stability/core.py:55-66` (and mirrored in `ed_stability_modes.c:133`): longitudinal modes use the quarter-wave set `(2n−1)·a/4L`; for a rigid injector face + choked compact nozzle the standard estimate is closed–closed `n·a/2L` — 1L frequency a **factor of 2 low**, wrong harmonic spacing, shifting every time-lag driving evaluation.
- `analysis.py:376-461` + defaults: acoustic drive can never exceed damping for *any* geometry with default n=0.5, M=0.2 — `any_unstable` is structurally unreachable; the acoustic screen cannot flag the phenomenon it exists for.
- `analysis.py:446`: chug feed-line length hardcoded 0.305 m (inertance ∝ length — a 1 m line is 3.3× off); lines 585–599 look up feed geometry under dead key `"lox"` and nonexistent field `"length"`, so defaults are always used.

- [ ] **6. Finite-rate chemistry: Arrhenius exponent off by 1000× and the blend is inverted** — `engine/pipeline/reaction_chemistry.py`
- Line 278: `Ea` values in J/mol divided by `R_gas = 8314` J/(kmol·K) → `exp(−0.003)` instead of `exp(−2.75)`: **reaction rates lose all temperature dependence**, Da overestimated ~600×, so the model always concludes "infinitely fast chemistry". Same bug in the dissociation factor (line 687).
- Line 882: the equilibrium/frozen blend is inverted — Da→∞ (fast chemistry) maps to ~frozen gamma, slow maps to equilibrium. Both `use_finite_rate_chemistry` and `use_shifting_equilibrium` are on in the canonical configs; net effect a persistent ~+0.07 on exit gamma → **~2–3% thrust/Isp bias** plus wrong P_exit for separation/altitude logic.

- [ ] **7. The DDP throttle controller is not actually optimizing** — `engine/control/robust_ddp/`
- `ddp_solver.py:544` + `engine_wrapper.py:74-98`: the cost gradient perturbs pressures by 1e-6 Pa, but the wrapper caches keyed on pressures rounded to 1e-3 Pa — the perturbed call returns the cached, unperturbed value, so **the thrust-tracking gradient is exactly zero**. Closed-loop thrust response comes entirely from a hardcoded heuristic (`controller.py:253-258`). The DDP machinery around it is also corrupted: gains ×2 post-solve break the Bellman recursion, line search starts at α=5–10 (`ddp_solver.py:474-485, 679-699`), and the constraint penalty gradient saturates for any violation >1 Pa (lines 349–355).
- `dynamics.py:164-173`: module-global state via function attributes (`step._T_copv_0` etc.), never reset by `controller.reset()` — cross-request contamination in the long-running backend, ±30% ullage/COPV pressure errors possible.
- `config_loader.py` + `backend/routers/control.py`: the controller hardcodes **LOX/RP-1** (ρ_fuel=800 vs methane's 422.6, MR band 1.5–3.0 with reference forced to 2.25 vs design 2.55) — it predates the propellant-switching rework and never reads the loaded engine config. If this subsystem matters, it needs a ground-up revisit; if not, it's a candidate for quarantine.

---

## Tier 2 — Major: wrong results in realistic configurations, or big silent traps

### Core solver physics
- [ ] **Pintle feed-loss coupling is dead code** (`injectors/pintle.py:106-199`): an indentation regression — the Bernoulli update block sits *outside* the loop (`if feed_iter < 2:` is always False after the loop), so feed Δp is evaluated at the initial 0.1 kg/s guess forever. For canonical numbers the solver sees ~1.7 kPa of feed loss instead of ~0.39 MPa → **pintle ṁ/Pc overpredicted by order 10%**. The impinging path got a proper fixed point in the June commits; pintle didn't. (Compare `coaxial.py:107-144`, where the same block is correctly inside the loop.)
- [ ] **Cd-reduction "closure" on spray violations is physically backwards** (`pintle.py:337`, `impinging.py:577`, `coaxial.py:244`): poor atomization doesn't reduce discharge, and cutting Cd lowers jet velocity, making We/SMD/x* violations *worse* — the loop monotonically walks Cd to its floor, silently distorting supply by −23% to −60% for any constraint-violating design.
- [ ] **Silent non-convergence acceptance** (`chamber_solver.py:311-317, 396-425`): if supply > demand across the bracket and the residual at Pc_max is < 0.1 kg/s **absolute** (3% of flow for 8 kN, ~100% for 200 N), it returns Pc=Pc_max as success with the warning commented out. The bracket top is also hardcoded at 0.85·min(P_tank), structurally forcing stiff low-loss designs into this branch.
- [ ] **Injection velocities are bulk, not jet** (`impinging.py:451`, `pintle.py:177`): `u = ṁ/(ρA_geom)` underestimates jet velocity by factor Cd (0.4–0.65). We low ~2.8×, D32 over ~1.5×, and pintle momentum ratio J biased by (Cd_O/Cd_F)² ≈ 0.38 — the optimizer compares designs on a distorted primary design parameter.
- [ ] **Cooling efficiency double-counts the c\* penalty** (`chamber_solver.py:969-995`): uses `1−f` where c\*∝√T₀ gives `√(1−f)` — overstates the c\* reduction by f/2 (~3% extra for 6% heat removal).

### Optimizer Layer 1
- [ ] **Worker and parent objectives disagree** (`layer1_static_optimization.py:3449` vs 1763): the parent (used by L-BFGS-B refinement and "new best" comparisons) omits the weight-500 `W_DP_CENTER` ΔP-centering term the CMA workers include — the two phases optimize different objectives; discrepancy up to 125 objective units (≈ a 13% thrust-error equivalent). The file header explicitly says these must stay identical.
- [ ] **Validation can pass on a boosted-pressure replay** (`layer1_static_optimization.py:4941-4968, 5109`): the final validation evaluate retries with tank pressures up to **1.72×** when starved, all pass/fail gates are computed on the boosted run, but nominal pressures are written to the returned config. A design that can't converge at its stated pressures can be reported VALID.
- [ ] **Pintle `n_orifices` silently forced to 14** (line 2519: bounds `(14, 14.1)`) — the exact "design parameters ignored" bug class the last commit claimed to fix; user YAML is overridden unless frozen explicitly.
- [ ] Hybrid mode is unseeded/non-reproducible and runs Stages C/D serially without the parallel kernel (lines 6373–6534); after 200 consecutive failures the objective returns 1e5, which *outranks* the 1e6 infeasibility floor (lines 3828–3831) — a spurious attractor in failing regions.

### CEA / thermochemistry
- [ ] **Silent grid clamping in ranges the optimizer explores** (`cea_cache.py:848-852`): eps grid starts at 4.0 but Layer 1 searches down to 3.0 (all candidates in [3,4) evaluated at 4.0 — flat objective band); solver bracket goes to 0.1 MPa vs grid floor 1.0 MPa; MR unconstrained during CMA vs grid 2.4–4.2 (methalox).
- [ ] **Canonical pintle config design point is outside its own grid** (`configs/canonical/pintle.yaml:36`): `design_MR: 2.55` is a stale kerolox value for a LOX/ethanol config whose own preset says MR_range [1.0, 2.5] and optimal 1.4 — the stamped geometry was solved at clamped MR 2.5, ~5–8% c\* error. The canonical impinging config is also internally inconsistent (geometry solved for 7000 N @ MR 2.55 vs stated requirements 8000 N @ 2.8).
- [ ] **Lenient cache metadata matching** (`cea_cache.py:299-404`): a cache built over different Pc/MR/eps ranges is accepted and *its* grid replaces the configured ranges — widening `MR_range` in YAML does nothing until the .npz is deleted.
- [ ] **`extra = "allow"` on the config schema** (`config_schemas.py:1473`, comment says "Reject unknown fields"): any YAML typo validates silently and reverts to defaults — the enabling hole for the whole "parameters ignored" bug family. Flipping this to `forbid` is probably the highest-leverage one-line fix in the repo.
- [ ] **Gasification model ignores the configured fuel** (`combustion_physics.py:187-194`, `chamber_solver.py:1357`): hardcoded RP-1-ish liquid properties (ρ=800 vs methane's 422.6, cp 2000 vs 3348, T_inj 293 K vs 112 K) — η_Lstar biased up to ~3–5 points for methalox.

### Flight sim / COPV / backend
- [ ] **Time-series summary ignores the flameout mask** (`backend/routers/timeseries.py:438-466`): total impulse/propellant integrate the raw arrays including phantom post-flameout thrust — `total_propellant_kg` can exceed the loaded propellant; impulse overcounted 10–50% when depletion happens mid-window.
- [ ] **N₂ Z-factor silently extrapolated far outside its table** (`copv/blowdown_solver.py:147-152`): `fill_value=None` means *extrapolate* (the NaN guard is dead code), and the table stops at 8.3 MPa while COPVs run 20–45 MPa → **3.5–14% error in COPV gas mass and the min-margin trace** — exactly the quantity Layer 2 gates on. Compounded by Z always being evaluated at T₀=300 K while the model cools the gas to ~230 K (`copv_solve_both.py:296-301`).
- [ ] **`/optimize-altitude` evaluations self-truncate quasi-randomly 0–2%** (`flight.py:827` + `ui/flight_sim.py:366-441`): exact-required propellant loads always trip the fuel-only safety pass (LOX never checked) and the underfill margin, so apogee(T) is noisy at the search resolution and the "optimal" burn time is biased.
- [ ] **Backend state races** (`backend/state.py:29`, `optimizer.py:469-1092`): background optimizer threads mutate the live `app_state.config`/`runner` while `/api/flight`, `/api/timeseries`, `/api/evaluate` read them — mixed-config results with no error, no locking. Plus one global `_stop_event` shared by all layers, flight endpoints run RocketPy+matplotlib synchronously on the event loop (server unresponsive for minutes), and a matplotlib diagram is rendered and discarded for every optimizer evaluation.
- [ ] Cd hardcoded 0.45, Mach-independent (`ui/flight_sim.py:862`) — for designs that transit transonic this alone is a 10–20% apogee error that propellant sizing inherits.

### Native C kernel
Structurally sound port (expression-level fidelity verified); the *guarantees around it* are weaker than advertised:
- The README's "cannot change results" claim is really a **±0.1% per-call band** on the chamber path, a **single-point one-time check** on the injector path (and the "Python" reference it compares against itself dispatches to the native injector once latched — divergence at other geometries is invisible), and **no check at all** on the stability fast tier (no golden vectors, no CTest).
- Stale CEA tables on cache switch (`native_injector.py:249-299`): the loaded-table bookkeeping is keyed on `id(cache)` "was loaded ever", with one table slot — alternating caches leaves the wrong propellant's tables loaded (mostly caught by the residual guard → silent loss of the entire 88× speedup; near-similar tables can pass within the guard band).
- `autobuild` races across ProcessPool workers (threading lock only; N workers cmake-build into the same directory → corrupt builds latching native off per-worker).
- `ed_max(NaN, 0)` returns 0 — NaN silently becomes "no cooling / cooling_eff=1.0" through `ed_cooling.c:43` when the regen diameter is unset (Python has a fallback chain; C doesn't).
- Golden tests cover exactly one config, one propellant, all 24 injector samples on the constraint-violating path, and the chamber golden test always SKIPs.

---

## Tier 3 — Moderate (condensed)

- [ ] `runner.py:769-773`: real per-step η_c\* from the coupled solver is overwritten with a fabricated constant 0.85 in results.
- [ ] `time_varying_solver.py:552`: chamber volume model jumps +20–30% at t=0 when graphite+ablative are both enabled (L\*/Pc discontinuity for the whole burn); lines 509/600: nozzle exit ablation ignores the `nozzle_ablative` flag; line 621: ambient hardcoded 101,325 Pa (~1–3% thrust bookkeeping error at altitude sites); lines 395–405: the TVS recession path silently bypasses the config-selected physics-based blowing model (falls back to constant 80% blockage because `gas_mass_flow_rate` isn't passed).
- [ ] Layer 3: binary search couples ablative/graphite through one joint feasibility bool (ablative driven toward its 25 mm bound when the graphite guess is infeasible, `layer3_thermal_protection.py:585-637`); permanently mutates the shared config (`use_turbulence_coupling=True` forced onto `app_state.config`, lines 224/934); with `sizing_only_mode: true` recession is never accumulated → minimum-bound insert passes as valid; the L-BFGS-B polish is a guaranteed no-op (objective quantized to 0.05 mm + cached).
- [ ] `x*` uses collision relative velocity as downstream convection speed (`impinging.py:509`) — asymmetric doublets can trivially "pass" the vaporization-length constraint; legacy time-march throat velocity missing a √2 (`runner.py:1070`); Rupe momentum criterion omits jet diameters (`impinging.py:50-72`).
- [ ] Config knobs that are plumbed but dead: `use_advanced_model`, `Pc_gate`, `use_spray_correction`, `vapor_pressure`, `solver.closure.tolerance`, `optimizer.num_workers`, `debug_strict`, `layer1_momentum_log_deadband_rel`, pintle `theta_orifice`/`A_entry` (optimized as a DOF the physics never reads), `A_hydraulic` (required but unreachable; docstring recommends a forbidden workflow), spray turbulence gains. Each is a silent "this setting does nothing".
- [ ] LOX `specific_heat: 2300` in all propellant presets is ~35% high (should be ≈1700 J/kg·K at 90 K).
- [ ] Trilinear CEA interpolation returns the lower corner (possibly NaN) when any corner is NaN — 3D path lacks the 2D path's valid-corner weighting (`cea_cache.py:793`).
- [ ] Layer 2 tests (`test_layer2_pc_constraint.py`, `test_layer2_of_pointwise.py`) contain **zero asserts** — always pass under pytest; one of them tests a production-dead function.
- [ ] Silent exception → fake data: timeseries blowdown evaluator maps any engine failure to zero-flow (`timeseries.py:892`); failed COPV solves are replaced by fabricated pressure curves and `min_margin_psi=50` (`copv_flight_helpers.py:69-88`).
- [ ] DDP support items: safety filter tests the wrong tube bound for the COPV *minimum* constraint (`safety_filter.py:179`); injector-stiffness constraint uses `eps_i`=1e-3 instead of `injector_dp_frac`=0.1 — 100× weaker than the safety filter checks, causing chattering (`constraints.py:178`); dwell-time valve protection is defeated by storing the requested rather than applied control (`actuation.py:300`).
- [ ] `enhanced.py` spatial stability: for impinging configs emits constant placeholders (margin 0.5, 30 Hz); its pintle branch is pre-rewrite heuristic code with invented coefficients that survived the stability rebuild.

---

## Dead / deprecated code map (safe to delete or quarantine)

Beyond the explicit `archive/` folders:

| Area | Dead items |
|---|---|
| `engine/core/` | `chamber_physics_fixed.py`, `chamber_graphite_geometry.py` (zero importers); `injectors/coaxial.py` dormant (no config/dispatch path) |
| `engine/pipeline/` | `spalding.py` (sole caller behind a `False` flag; its main solver crashes unconditionally — `clipping_count` never initialized), `iterative_sizing.py`, `recession_animation.py`, `validation.py`, `visualization.py` (empty) |
| `engine/pipeline/thermal/` | `ablative_sizing.py`, `graphite_geometry.py`, `graphite_variable_thickness.py` — only reachable via the orphaned Streamlit UI (`ui/design_optimization_view.py` has no callers, which kills `comprehensive_geometry_sizing.py`, `chamber_geometry_visualizer.py`, `optimizer/views/` with it) |
| `engine/optimizer/` | `run_layer1_global_search`, `run_layer2a_minimum_pressures`, `helpers.py` (UI-display only), triplicated broken Layer-2 blocks in `main_optimizer.py` |
| `copv/` | `copv_solve.py` (superseded), `test_blowdown_quick.py` (ImportError — imports a function that no longer exists), repro scripts with hardcoded `/home/adnan` paths |
| `backend/routers/` | `reproduce_masking.py` — not a router, runs a simulation at import, hardcoded `/home/adnan` path; should not live in `routers/` |
| `engine/control/robust_ddp/` | `copv_calculator.py`, `identify.py` (zero callers), `ControllerLogger` (instantiation commented out), `policy_lut.py`/`engine_lut_wrapper.py` (gated off by default) |
| `engine/native/` | stub files (`ed_nozzle.c`, `ed_evaluate.c`, pintle/coaxial stubs), `EdWorkspace` entirely vestigial, `ed_state_builder.py` duplicating `native_injector.build_state`, the dead Lefebvre branch (which *diverges from Python* and would surface if goldens were regenerated from a `model: lefebvre` config) |

---

## What checked out clean

The isentropic relations, area–Mach solver, orifice flow, impingement geometry, Rao nozzle arcs, chamber-length correlation, chug transfer-function formulation (impedances, inertance, chamber gain, residence time), transverse acoustic eigenvalues, tank capacity math, choked-flow relations, polytropic blowdown algebra, Layer-1's parallel worker architecture (no races found — ordering preserved, per-worker config rebuilds), and the C port's expression-level fidelity were all verified correct.

---

## Five fixes first

1. Apply η_c\* and nozzle efficiency to delivered thrust/Isp (`nozzle.py`) — everything downstream is sized against +17% performance.
2. Flip `extra="allow"` → `"forbid"` in `config_schemas.py` and delete/wire the ~12 dead config knobs — kills the recurring "parameters ignored" class at the root.
3. Fix the `"h_g"`/`"h_hot"` key bug + gas emissivity + Bartz-on-total-flux in the thermal chain — restores meaning to all thermal margins.
4. Fix the Layer 2 convergence latches and the segment-curve normalization — Layer 2 currently does almost no real optimization.
5. Fix the stability gate mapping (GM 0.96 ≠ margin 1.2) and make failed analyses fail instead of neutral-pass.

---

# Part 2 — Full subsystem reports (unedited reviewer output)


## Appendix A — Optimizer Layers 1-2 (engine/optimizer/)

I have now read all the target files and verified the key claims. Compiling the final report.

## Findings (severity-sorted)

### Severity 5

**F1. `run_full_engine_optimization_with_flight_sim` crashes with NameError immediately after Layer 1 — the full multi-layer pipeline is dead.**
- `EngineDesign/engine/optimizer/main_optimizer.py:237` — `P_O_start_psi = optimized_pressure_curves.get("lox_start_psi", max_lox_P_psi * 0.8)`. `max_lox_P_psi` is first assigned at line 365, *inside* a later `if use_time_varying` try-block. Python evaluates `.get()` defaults eagerly, so line 237 raises `NameError` unconditionally, on every run. Even if 237 were fixed, line 1284 (`"max_lox_pressure_psi": max_lox_P_psi`) would NameError whenever `use_time_varying=False` (assignment at 365 is branch-local). Same for `max_fuel_P_psi`.
- Impact: every caller of the main orchestrator (`ui/design_optimization_view.py:77`, `engine/optimizer/views/tabs.py:900`) fails after Layer 1 completes. The backend React path is unaffected because `backend/routers/optimizer.py:398` calls `run_layer1_optimization` directly. This also means everything from line 237 to 1291 of `main_optimizer.py` is currently unreachable in practice.

**F2. `run_layer2_burn_candidate` module does not exist — Layer 2b and Layer 3 in the full pipeline can never run.**
- `main_optimizer.py:37-42` imports `layers/layer2_burn_candidate` with `except ImportError: run_layer2_burn_candidate = None`. The file is absent from `engine/optimizer/layers/` (verified: only layer1/layer2_pressure/layer3/layer4 exist). Line 565 then calls `run_layer2_burn_candidate(...)` → `TypeError: 'NoneType' object is not callable`, swallowed by the enclosing `except Exception` at line 1039 ("Layer 3 optimization failed" warning). Burn-candidate validation, time-varying summary, and in-pipeline Layer 3 sizing silently never execute; results fall back to Layer-1 static values.

### Severity 4

**F3. Layer 2 convergence latch kills both the DE global search and the L-BFGS-B polish.**
- `engine/optimizer/layers/layer2_pressure.py:1114-1165` (`finish_evaluation`) and early-return at 1231-1237. Two problems, verified in code:
  1. The "identical objective" latch (5 consecutive identical values → `converged=True`) applies to *all* evaluations including failure penalties. Any 5 consecutive candidates returning exactly `1e6` (solver failures — common in DE's random initial population) permanently latch convergence; every subsequent evaluation short-circuits at line 1231 and returns the constant `best_obj`. The rest of the DE run is wasted.
  2. The rate-of-change latch (`small_change_count &gt;= 3` at line 1156) has **no phase guard**, unlike its twin in `layer2_callback` (line 874, explicitly `phase == "DE"` with the comment "Local optimizer needs to probe close points"). L-BFGS-B's finite-difference gradient probes change the objective by ≪0.1% between consecutive evaluations, so the latch trips within the first gradient computation, the objective becomes constant, the gradient is zero, and the local polish exits at its starting point. In practice the "fine-grid polish" phase is a no-op.
- Impact: Layer 2's effective search is roughly the DE evaluations that happen before the first latch, i.e., often only a handful of candidates. Final result quality is dominated by luck of the initial population.

**F4. Layer 2 "blowdown" segment curves are discontinuous — segment endpoints never reach their specified end pressure.**
- `layer2_pressure.py:130-133`: `P(t) = P_end + (P_start − P_end)·exp(−k·t_norm)` with `t_norm ∈ [0,1]` and `k ∈ [0.1, 2.0]`. At `t_norm=1` the value is `P_end + ΔP·e^(−k)`, not `P_end`. For k=0.1 the segment retains 90.5% of ΔP; the next segment then *starts* at the nominal `P_end` (line 234 / decode at 1042), producing an instantaneous cliff of up to ~90% of the segment's intended drop at every segment boundary. The comment at line 211 ("k can make them effectively linear when small") is backwards — small k makes the segment nearly *flat*, followed by a step discontinuity. The monotonicity/min-slope constraints (lines 991-1022) are enforced on nominal endpoints, not on the generated curve, so the actual curve violates the very slope/monotonic assumptions the constraints encode. The same unnormalized form exists in `helpers.py:66-71` (`P = P_end + ΔP·exp(−t/τ)`, τ down to 0.1·duration — less severe but same defect) — that one is display-only. Fix is normalizing: `(e^(−k t) − e^(−k)) / (1 − e^(−k))`.
- Impact: the time-series solver is fed physically impossible tank-pressure steps; the "optimized" k values mostly control the size of the artificial cliff rather than the decay shape.

### Severity 3

**F5. Pintle `n_orifices` from the user config is silently overridden to 14.**
- `layer1_static_optimization.py:2519` — pintle bounds entry `(14, 14.1)` for x[6]. A config-supplied `n_orifices` (extracted for x0 at line 2592, `default_n_orifices = int(n_orifices_in)`) is clipped to 14 by the bounds clip at line 2915-2916, and the "DOF" is effectively frozen at 14 for all pintle runs. This is exactly the "design parameters ignored" bug class named in the commit history; only an explicit `frozen_parameters.n_orifices` (which rewrites bounds[6] at line 2871-2879) escapes it. Impact: pintle injector search space silently loses one integer DOF and contradicts user YAML.

**F6. Parent `objective()` and worker `_compute_objective_value` disagree: the W_DP_CENTER term (weight 500) is missing from the parent.**
- Parent: `layer1_static_optimization.py:3449-3460` calls `injector_dp_ratio_penalty_weighted(...)` without `w_dp_center` (defaults to 0.0 per `injector_dp_penalty.py:140`). Worker: lines 1763-1775 pass `w_dp_center=W_DP_CENTER` (default 500, `constants` line 4260). The file header (lines 64-66) states these two paths "MUST stay identical" because parallel CMA ranks with the worker while L-BFGS-B refines with the parent. Consequences: (a) CMA and L-BFGS-B optimize different objectives — the refinement phase can push ΔP/Pc back to the 0.40 band edge that the CMA phase paid 500-weight to avoid; (b) `opt_state["best_objective"]` mixes worker values (with center term) and parent values (without), so "new best" comparisons across phases are inconsistent; at band edge the discrepancy is `500·0.25 = 125` objective units, equivalent to ~13% thrust error at W_THRUST=1e4 — far from negligible. (Also mirrored in the reported `injector_dp_penalty` in `final_performance` at line 5195-5208, which likewise omits the center term the optimizer actually minimized.)

**F7. Layer 1 can report VALID using a boosted-pressure replay while returning nominal pressures in the config.**
- `layer1_static_optimization.py:4941-4968` (`_validation_evaluate_boost`) retries the final `evaluate()` with tank-pressure scales up to **1.72×** when supply-starved; lines 5109-5124 then write *nominal* pressures back to the config while all validation gates (thrust at 5219-5228, ΔP gate 5350-5366, stability 5236-5277, `pressure_candidate_valid` 5382) are computed from the boosted evaluation. A design whose physics model can't even converge at its stated tank pressures can be returned as VALID with performance numbers taken at up to +72% pressure. It is flagged (`layer1_validation_replay_boosted_tanks`) but does not gate validity. Impact: invalid designs (potentially significantly off-thrust at real pressures) pass Layer-1 validation.

**F8. Layer 2 final curve decode uses the wrong pressure floors — returned curves can violate the stability floor that was enforced during optimization.**
- During optimization, `decode_segments_from_x` is called with the raised floors `local_min_lox_floor` / `local_min_fuel_floor` (= max(user floor, 0.75·Pc_initial), lines 722-726, 1256-1263). The **final** decode of the best x (lines 2128-2135) and the not-converged fallback (2156-2163) instead pass the original `min_lox_pressure_floor_pa` / `min_fuel_pressure_floor_pa`. When the floor binds, the returned/saved curves are *different* from the curves the objective actually scored, and can dip below the 75%-of-Pc chugging-stability floor. Quantified: with floor raised from 1 MPa to 0.75·3 MPa = 2.25 MPa, the returned tail pressures can be up to 1.25 MPa lower than what was evaluated.

**F9. Layer 2 non-convergence fallback can silently return a flat 5 MPa default curve.**
- `layer2_pressure.py:2148-2165` — in the "did not converge" branch, the `decode_segments_from_x(x0, ...)` call is indented *inside* `if update_progress:`. When no progress callback is supplied (e.g., library/script use), `lox_segments`/`fuel_segments` stay `None` and `generate_pressure_curve_from_segments(None, n)` returns the hard-coded `np.full(n, 5e6)` (line 63) — a constant 725 psi curve unrelated to the design's initial pressures, returned with `success` still False but with curves that downstream code will happily consume.

**F10. Duplicated/broken Layer-2 invocation blocks in `main_optimizer.py` (3 of 4 calls have a wrong signature).**
- `main_optimizer.py:319-458`: three near-identical copies of the "Layer 2" block call `run_layer2_pressure(..., requirements=..., runner=..., progress_callback=...)` — none of these keywords exist in the function signature (`layer2_pressure.py:539-569`), and required positionals (`peak_thrust`, `target_apogee_m`, ...) are missing → guaranteed `TypeError`, each swallowed and logged as "Layer 2 optimization failed". Only the fourth call (line 530) is correct. Besides log spam and confusion, if anyone "fixes" the signature the config would be re-optimized 4 times with `optimized_config` reassigned each time. (Currently moot due to F1, but it's the state of the mainline orchestrator.)

**F11. Layer 2 tests assert nothing.**
- `tests/test_layer2_pc_constraint.py` and `tests/test_layer2_of_pointwise.py` print `PASS`/`FAIL` strings but contain zero `assert` statements — under pytest they always pass. The Pc-drift constraint, pruning behavior, and pointwise-MR weighting they document are entirely unprotected against regression (e.g., F3/F4/F8 all slip through). Also, `test_layer2_of_pointwise.py` exercises `run_layer2a_minimum_pressures`, which is dead in production (see dead-code list), not the live objective path.

### Severity 2

**F12. Hybrid optimizer mode is non-reproducible and partially serial.**
- `layer1_static_optimization.py:6389` — `rng = np.random.default_rng()` unseeded; `run_cma_core` is called without `seed` throughout `run_hybrid_optimization` (6373, 6393, 6490, 6534), so CMA uses nondeterministic defaults. The legacy CMA path was explicitly fixed for this (comment at 4537: "Without an explicit seed, cma uses non-deterministic defaults → different optima each run") but the hybrid path was not, and `layer1_random_seed` has no effect there.
- Also Stage C (block re-opt, line 6490) and Stage D (refresh, 6534) omit `executor`/`integer_dims`, so those stages run sequential parent-side `objective()` — forfeiting the 88x parallel kernel for the majority of the hybrid budget, and (Stage C) evaluating each candidate twice via `true_objective_fn=block_obj_fn` (6494; second call usually a cache hit, but it inflates iteration counters/history).

**F13. `consecutive_failures &gt; 200` returns 1e5 — a *reward* relative to the infeasibility floor.**
- `layer1_static_optimization.py:3828-3831`: after 200 consecutive failed evaluations, `objective()` returns `1e5`, which ranks *better* than every infeasible-but-successful candidate (≥ `BASE_INFEAS`=1e6) and better than worker exception penalties (2e6-1e7). During a long failing streak in L-BFGS-B/serial phases this creates a spurious attractor in the failing region (it cannot become "best" since `eval_success` is False, but it distorts CMA ranking and L-BFGS line searches).

**F14. `layer1_momentum_log_deadband_rel` requirement is plumbed but never used; the log-target momentum term the docs describe is not in the objective.**
- The knob is read (`layer1_static_optimization.py:2971-2975`), shipped to workers in `constants_dict` (4274), exists in schema (`config_schemas.py:966`) and canonical YAMLs, but no code reads it from `constants` — `_compute_objective_value` and `objective()` both use only the band hinge `_impinging_momentum_hinge_squared`. `_impinging_momentum_log_target_squared` (lines 283-321, with an extensive design rationale about CMA needing the always-on gradient) is called only by tests. Users setting this key get silently nothing.

**F15. Layer 2 mandatory decay rate default forces ≥25 psi/s pressure drop.**
- `layer2_pressure.py:560` `min_pressure_slope_psi_per_sec: float = -25.0`, enforced per segment at 994-1004/1017-1019. Neither the backend router nor `main_optimizer` overrides it, so every non-dome-regulated design is forced to shed ≥25 psi/s × burn_time (e.g. ≥750 psi over 30 s) until the floor clamps — the optimizer is not allowed to explore flatter blowdown profiles even when the objective would prefer them. Combined with F4, the "slope" the constraint enforces isn't even what the generated curve does. If intentional as a blowdown-physics proxy, it belongs in config, not a hard-coded default.

**F16. Legacy ΔP band [0.15, 0.35] silently rewritten to [0.20, 0.40].**
- `injector_dp_penalty.py:31-33` and duplicated in `config_schemas.py:1275-1280`: a user who *deliberately* sets exactly (0.15, 0.35) gets (0.20, 0.40) with no warning. Any epsilon-different value (0.151) is honored. Physically, the band and center-pull themselves are sensible (guidance ΔP ≥ 15-25% Pc; 20-40% with soft pull to ~0.30 is a reasonable stiff-injector target), and `injector_dp_ratios_from_eval_result` correctly uses injector-face ΔP rather than tank−Pc.

**F17. Expansion-ratio DOF has a flat region due to exit-diameter clipping.**
- `layer1_static_optimization.py:1031-1039` (`_layer1_apply_chamber_geometry_to_config`): when `D_exit &gt; max_nozzle_exit` the config eps is silently clipped, but x[2] keeps moving in [4, 12]. With default `max_nozzle_exit=0.101` and realistic throats, clipping activates well inside the search box, creating a zero-gradient plateau in that dimension (CMA wastes samples; L-BFGS gradients vanish). Rejecting/penalizing instead of clipping, or shrinking the eps upper bound from `max_nozzle_exit`, would fix it.

### Severity 1 (noted)

- `main_optimizer.py:200` `target_P_exit = 1 * P_amb_launch` with comment "slightly under ambient" — factor is 1.0, comment stale.
- `main_optimizer.py` vs `layer1`: differing fallback defaults for max tank pressures (500 vs 700/850 psi) between line 365 and `layer1_static_optimization.py:2369-2370`.
- `layer1_static_optimization.py:3595-3597`: missing/non-finite Cf is scored as Cf=0.0 → constant 676-point penalty rather than neutral.
- `display_results.py:214-215`: x-array fallback indices 10/11 for tank pressures are wrong for pintle vectors (8/9); only matters if the named keys are absent.
- `_get_num_workers` / `debug_strict` (`layer1_static_optimization.py:1218-1226`, 4239) read `optimizer.num_workers` / `optimizer.debug_strict`, neither of which exists on `OptimizerConfig` (`config_schemas.py:1345-1351`) — both silently take defaults; the documented config knobs are inert.
- Layer 2 DE (`layer2_pressure.py:1968-1977`) has no `seed` → non-reproducible.

### Parallel-evaluation assessment (no critical race found)

Worker design is sound: `_init_worker` rebuilds config/runner per process; `ChamberSolver.residual` re-reads geometry from config on every call (explicit comment "critical for optimization where config is mutated in-place", `chamber_solver.py:138-146`), so in-place mutation + runner reuse is valid. `executor.map` preserves ordering, so results are not misattributed. Worker exceptions are converted to categorized finite penalties (1e7-scale), never crashes, and are counted/logged. Two consistency nits: worker/parent objective divergence is F6; cache hits count toward budget in `run_cma_core` but not in the legacy loop (minor budget accounting inconsistency). `es.tell(candidates, values)` feeds fitness computed on *snapped* vectors against unsnapped candidates — standard practice for integer dims, acceptable.

### Dead / unused optimizer code

- `run_layer2a_minimum_pressures` (`layer2_pressure.py:297-536`) — production-dead; only tests and `__init__` export.
- `segments_from_optimizer_vars_pressure` (`layer2_pressure.py:152-236`) — never called.
- `_layer1_candidate_rank_tuple` (`layer1_static_optimization.py:172`), `_layer1_secondary_weight_scale` (158), `_impinging_momentum_log_target_squared` (283), `_impinging_momentum_band_violation_squared` (324) — no production callers (last two test-only).
- `run_layer1_global_search` (`layer1_static_optimization.py:2080`) — imported by `main_optimizer.py:31` but never called anywhere.
- `helpers.py` entirely (`generate_segmented_pressure_curve`, `segments_from_optimizer_vars`, `optimizer_vars_from_segments`) — UI-display-only, not used by any optimizer layer; `main_optimizer.py:26-28` imports are unused.
- `main_optimizer.py:319-458` triplicated broken Layer-2 blocks (see F10) and ~5 copies of the same 12-line "LAYER 2" banner comment (lines 289-317, 342-358, 401-417, 483-498) — dead weight; `log_flags` (117-120) unused.
- `stream_injector_dp_raw_terms` (`injector_dp_penalty.py:175-178`) — deprecated, no callers; `w_dp_high` parameter is accepted everywhere but explicitly does nothing (`injector_dp_penalty.py:164`), while `W_DP_HIGH=480` is still configured and logged as if meaningful.
- `generate_blowdown_reference_curve` (`feed_pressure_model.py:59`) — viz-only, no callers found in optimizer path.

`feed_pressure_model.py` physics: no errors found in what's implemented — the dome-regulator supply-pressure-effect sign and magnitude (1%, i.e., 10 psi outlet rise per 1000 psi inlet drop) are reasonable; ripple is explicitly illustrative; `lockup_inlet_pa` droop is never exercised by `dome_regulated_tank_pair` (no caller passes it) and the assumed COPV inlet (1.2× tank pressure, decaying to 0.7×) is far below realistic COPV pressures, but both only shape a ±10-psi drift term, so the effect on results is negligible. Note there is no line-loss model here; feed losses live in the core `flows()` path (out of scope per task).</result>
<usage><subagent_tokens>335481</subagent_tokens><tool_uses>36</tool_uses><duration_ms>619366</duration_ms></usage>
</task-notification>


## Appendix B — Python Core Solver (engine/core/)

Review complete. All in-scope files read in full; supporting pipeline modules (config_schemas, feed_loss, combustion_eff/physics, spalding, stability, numerical_robustness) cross-checked where core behavior depends on them.

# DEAD / UNUSED FILES (not deep-reviewed)

- `EngineDesign/engine/core/chamber_physics_fixed.py` — no importers anywhere in the repo (only referenced from `docs/latex/04_compressible_flow_chamber.tex`). DEAD.
- `EngineDesign/engine/core/chamber_graphite_geometry.py` — no importers anywhere (the live graphite sizing is `engine/pipeline/thermal/graphite_geometry.py`). DEAD.
- `EngineDesign/engine/core/injectors/coaxial.py` — reachable only via the injector registry; no shipped config uses `type: coaxial`, dispatch has no coaxial geometry template (UI type-switch to coaxial raises), Layer-1 has no coaxial DOF. Dormant; reviewed lightly (2 findings noted below).
- `engine/core/nozzle_solver.py::generate_rao_moc_contour` — placeholder that always raises (dead branch inside a live file).

All other listed files are live from the active entry points (backend routers → `PintleEngineRunner`/`ChamberSolver`/geometry solver; optimizer → runner; runner → time_varying_solver).

# FINDINGS (severity-sorted)

## Severity 5

**F1. Reported thrust/Isp ignore both nozzle efficiency and c\* efficiency — systematic ~10–20% overprediction.**
`engine/core/nozzle.py` — `calculate_thrust`. The returned `F` is `F_momentum + F_pressure` (lines 573–575, 611) where `v_exit = M_exit·√(γ R T_exit)` with `T_exit` derived from the **raw CEA chamber temperature** (lines 229–233, 316–335, 527–536) — i.e., the fully ideal exit velocity. `mdot_total` is the actual injector flow, which at the solved operating point equals `Pc·At/(η_c*·c*_ideal)`. Hence `Isp = F/(ṁ g0) ≈ Isp_ideal`: the combustion-efficiency loss the chamber solver carefully computes cancels out of the reported Isp, and the config `chamber_geometry.nozzle_efficiency` (default 0.95) is **never applied to the returned F** — `Cf = efficiency·Cf_ideal` (line 265) is only used in `F_cf` (line 600), which is selected only if `PhysicsValidator.validate_thrust_equation(F_mom, F_pres, F_mom+F_pres)` fails — a tautology that always passes (line 603–608). Correct behavior per standard relations (Sutton/Huzel): `F_delivered ≈ η_Cf·Cf_ideal·Pc·At` with Pc already reflecting η_c\*, equivalently `v_exit_actual ≈ η_c*·λ·v_exit_ideal` (c\* ∝ √T0, v_e ∝ √T0). Quantified: with η_c\* ≈ 0.90 and η_noz = 0.95, F and Isp are overpredicted by ≈ 1/(0.90·0.95) ≈ **+17%**. Internal inconsistency confirms it: `chamber_solver.py:745–750` computes a validation Isp as `η_noz·Cf_ideal·Pc·At/(ṁ g0)`, which disagrees with the returned Isp by exactly that factor. Affects every evaluate/optimize/time-varying result.

## Severity 4

**F2. Pintle closure: feed-loss ⇄ mass-flow fixed point is dead code; feed Δp evaluated at hardcoded 0.1 kg/s guess.**
`engine/core/injectors/pintle.py:106–199`. The `for feed_iter in range(3):` loop body (lines 115–125) only recomputes `delta_p_feed` with **unchanged** mdot; the quick Bernoulli update block is gated by `if feed_iter &lt; 2:` at line 146, which sits **outside** the loop and is always False (`feed_iter == 2` after the loop). Compare `coaxial.py:107–144`, where the identical block is correctly **inside** the loop — this is an indentation regression in pintle. Consequence: each outer iteration does one Picard update with `P_inj = P_tank − Δp_feed(ṁ_guess)`, and the outer loop breaks as soon as **spray** constraints pass (usually iteration 0), so the returned mdot uses feed losses evaluated at the initial guess ṁ = 0.1 kg/s. Δp_feed is quadratic in ṁ (`feed_loss.py:90`): for the canonical pintle config (K0 = 2, A = 7.13e-5 m², LOX ρ = 1141), Δp_feed(1.5 kg/s) ≈ 0.39 MPa (~56 psi) vs Δp_feed(0.1) ≈ 1.7 kPa — the solver sees essentially zero feed loss and overpredicts injector Δp, mdot and solved Pc by order 10% for realistic line losses. There is **no convergence check on mdot at all** on this path (`solver.closure.tolerance` is ignored — see F18). The impinging path got a proper fixed point (`_converge_feed_orifice_coupling`) in the June 2026 commits; pintle did not.

**F3. Cd-reduction "closure" loop cuts mass flow in response to spray-quality violations — physically baseless and moves the wrong direction.**
`pintle.py:337–340`, `impinging.py:577–580`, `coaxial.py:244–247`. When `check_spray_constraints` fails (We &lt; We_min or x\* &gt; limit), the loop multiplies the Cd cap by `Cd_reduction_factor` (default 0.95) up to `max_iterations` (default 6) and returns the resulting reduced mdot. (a) There is no physical mechanism by which poor atomization reduces orifice discharge; (b) reducing Cd reduces u, which reduces We (∝u²) and increases D32 (Ingebo D32 ∝ u^−3/4) and x\* (∝ u^−1/2) — i.e., every reduction makes the violation *worse*, so the loop monotonically walks Cd toward `Cd_min` (floors 0.35 impinging, 0.15/0.20 pintle). Any design that violates a spray constraint gets its supply curve silently distorted by −23% (0.95⁵ over 6 iterations) up to −40/−60% at the Cd_min floor, corrupting the Pc balance and making the chamber residual discontinuous in Pc. Constraint violations should penalize/flag, not mutate flow physics.

## Severity 3

**F4. Chamber-pressure solver silently accepts non-converged Pc_max as the solution with a fixed 0.1 kg/s residual, and caps Pc at 0.85·min(P_tank).**
`engine/core/chamber_solver.py:311–317, 396–425`. If supply &gt; demand across the whole bracket and `residual(Pc_max) &lt; 0.1 kg/s` (absolute, not scaled to engine size), `Pc = Pc_max, success = True` and the warning is commented out. 0.1 kg/s is ~3% of flow for an 8 kN engine and ~100% for a 200 N engine — silent mass-balance error. The bracket top itself is `min(P_tank)·(1−0.15)` (hardcoded 15% "feed loss margin"), so stiff designs with total (feed+injector) Δp &lt; 15% of tank pressure are structurally forced into this silent-accept branch and reported at a wrong, capped Pc.

**F5. Coupled time-varying results: real η_c\* overwritten with fabricated constant 0.85.**
`engine/core/runner.py:769–773`. After `TimeVaryingCoupledSolver.get_results_dict()` returns a correct per-timestep `eta_cstar` array (`time_varying_solver.py:1152`, from solver diagnostics at line 286), the runner overwrites `cstar_ideal = cstar_actual/0.85` and `eta_cstar ≡ 0.85`. Any consumer of the time-series efficiency (UI plots, burn-time optimization) sees a constant fake 0.85.

**F6. Cooling-efficiency multiplier doubles the heat-loss penalty on c\*.**
`chamber_solver.py:969–995` (`_compute_cooling_efficiency`), applied multiplicatively to η_c\* in `combustion_eff.eta_cstar` (lines 175–188). Factor used: `1 − Q/(ṁ·cp·T0)`. Since c\* ∝ √T0, removing heat fraction f gives c\*-factor √(1−f) ≈ 1−f/2; the linear form overstates the c\* (and hence Pc/thrust) reduction by f/2 — e.g. 6% energy removal → ~3% extra c\* underprediction. Active whenever `use_cooling_coupling` and any cooling model is enabled.

**F7. Pintle `theta_orifice` (and `A_entry`) are optimizer design variables with zero effect in the core physics — remaining instance of "design parameters ignored".**
`config_schemas.py:31–41` defines them; `comprehensive_optimizer.py:89, 292` optimizes `theta_orifice` as a DOF and the UI displays it; but `engine/core/geometry.py` and `pintle.py` never read it — mass flow uses only areas, and `V_rel = √(u_O²+u_F²)` (`pintle.py:235`) hardcodes 90° impingement regardless of the configured orifice angle. `A_entry` (entry port area) is likewise unused (no entry-loss model). The optimizer can "improve" a parameter the reference solver doesn't respond to (only the stability post-analysis reads it).

**F8. Time-varying solver: chamber volume model discontinuity when graphite insert + ablative are enabled.**
`engine/pipeline/time_varying_solver.py:552–554`. In the graphite branch, `V_chamber_new = π/4·D_chamber²·L_chamber` (pure cylinder from initial diameter and total length), whereas the initial `cg.volume` is the L\*·At-based volume including the contraction taper. At the first step (recession ≈ 0) the volume jumps to the cylinder value (typically +20–30%), discontinuously changing L\*, η_c\*, and Pc for the whole burn. The non-graphite branch correctly perturbs `V_chamber_initial` via `update_chamber_geometry_from_ablation`.

**F9. Coupled solver ignores `ablative_cooling.nozzle_ablative`.**
`time_varying_solver.py:508–509, 600–606`: exit recession accumulates and `A_exit` is grown whenever ablative cooling is enabled, unconditionally. The legacy path honors the flag (`runner.py:1115`). For engines with an ablative chamber but non-ablative nozzle, eps and thrust/Isp drift spuriously over the burn.

**F10. Injection velocities are bulk (superficial), not jet velocities — biases We, SMD, x\*, J by the Cd factor.**
`impinging.py:451–452, 601–602`; `pintle.py:177–178, 201–202`. `u = ṁ/(ρ·A_geom)` underestimates the actual jet velocity (`≈ ṁ/(ρ·Cd·A)` or `Cv·√(2Δp/ρ)`) by factor ≈ Cd: 0.6 (impinging), 0.40 LOX / 0.65 fuel (pintle). Quantified: We low ×~2.8; Ingebo D32 (∝ u^−3/4) overpredicted ~1.5×; x\* over ~1.3×; and for pintle, J = ρ_O u_O²/(ρ_F u_F²) is biased by (Cd_O/Cd_F)² ≈ 0.38 — J/TMR is the primary pintle design parameter, so designs are compared on a distorted momentum ratio whenever the two streams have different Cd. Partly absorbed by calibrated prefactors (C_ingebo, pintle C), but the cross-design trends (which the optimizer exploits) are wrong.

## Severity 2

**F11. x\* uses collision relative velocity as downstream convection speed.** `impinging.py:509`, `pintle.py:265–268`. Droplets post-impingement convect at the momentum-averaged resultant velocity, not `u_rel`; for asymmetric doublets or small included angles, u_rel → 0 makes x\* → 0 and the vaporization-length constraint trivially "passes" even though droplets travel fast. The comment at `impinging.py:456–457` asserts u_rel drives residence length — incorrect physics.

**F12. Legacy time-march throat velocity missing factor 2.** `runner.py:1070`: `v_throat = √(γRTc/(γ+1))`; sonic velocity is a\* = √(2γRTc/(γ+1)) — underestimates by √2, biasing the throat recession heuristic multiplier low on the legacy (non-coupled) ablation path. (Coupled solver line 371 is correct.)

**F13. Strict graphite mode always uses the 300 K backside-temperature placeholder.** `time_varying_solver.py:455–460`: `if 'T_stainless_throat' not in locals()` is always true because `T_stainless_throat` is computed ~500 lines later (line 935/974) in the same function — the multi-layer thermal result never feeds the recession model that "strict mode" claims requires it.

**F14. Coaxial shear velocity wrong (if ever used).** `coaxial.py:214`: `U_rel = √(u_O² + u_F²)` for **parallel** coaxial streams; should be |u_O − u_F|. Overstates shear/breakup drastically when velocities are similar. Also hardcodes tank temperatures 90/300 K (lines 136–137, 163–164) ignoring `fluids.*.temperature` (pintle/impinging read config).

**F15. Geometry solver silently iterates on fallback Cf after CEA lookup failures.** `chamber_geometry_solver.py:237–251`: past iteration 0, any CEA cache failure substitutes `Cf = 1.5·η` and continues; the loop can "converge" A_throat on a guessed Cf with only a verbose-mode log line.

**F16. Native parity gate is one-time, first-geometry-only for direct `flows()` callers.** `closure.py:32–78`: `_NATIVE_OK` is latched process-wide after checking one config; subsequent different geometries use native without any per-call check at the flows() level (the chamber-level solve has a per-call residual guard, `chamber_solver.py:232–279`, but Layer-1 style direct `flows()` calls don't).

**F17. `momentum_ratio_R` omits jet diameters vs the Rupe criterion.** `impinging.py:50–72`; Layer-1 penalizes |R−1| (`layer1_static_optimization.py:244, 288`). Rupe's optimum-mixing criterion for unlike doublets is (ρ_F v_F² d_F)/(ρ_O v_O² d_O) ≈ 1; with asymmetric jets (supported, d_jet_O ≠ d_jet_F) targeting √(ρ_O v_O²/ρ_F v_F²) = 1 misses the mixing optimum by √(d_F/d_O). Also built on bulk velocities (F10).

**F18. `solver.closure.tolerance` config field is ignored everywhere.** Pintle/coaxial have no convergence check at all; impinging uses hardcoded `_FEED_ORIFICE_FP_TOL = 1e-6` (`impinging.py:14`). Same "config silently ignored" class the recent commit targeted.

**F19. Residual solved at `eps = cg.expansion_ratio` but final diagnostics at `eps = A_exit/A_throat`.** `chamber_solver.py:118–120` vs `626–627`. If the `expansion_ratio` field is stale relative to the areas (possible during ablation evolution before runner's line 871–872 resync, or hand-edited configs), the root that was solved and the reported CEA state use different table points. `calculate_thrust` then hard-errors on &gt;1e-4 mismatch (`nozzle.py:221–226`) while the chamber solve tolerated it.

## Severity 1 (latent / diagnostics-only)

- **F20** `chamber_solver.py:543–569`: `check_convergence` compares mass-flow residuals [kg/s] against `solver.tolerance` (1e-6, semantically the Pa xtol) — unit-inconsistent; benign at defaults only because dResidual/dPc ≈ 1e-6 kg/s/Pa. Interior-point NaN from `residual` is also not handled by brentq (endpoints only are pre-checked).
- **F21** `time_varying_solver.py:780–786`: `calculate_acoustic_modes(L, D, gamma, R, Tc)` — arguments (Tc, γ, R) permuted vs signature (`stability/analysis.py:162–168`); currently benign because only the product γ·R·T is used, but fragile (the fallback at 813–819 uses the correct order).
- **F22** `engine/pipeline/spalding.py:730, 763`: `clipping_count` never initialized — `solve_spalding_coupled` unconditionally raises UnboundLocalError when reached (first clip, or at line 763 in every call). Currently dead: only caller is behind `SPALDING_DIAGNOSTIC_ENABLED = False` with try/except fallback Bm=0.5 (`combustion_physics.py:332–370`). Would crash immediately if the diagnostic is enabled. (Active vaporization path is the gasification model, which was not found to have this issue.)
- **F23** `chamber_profiles.calculate_chamber_intrinsics:238`: A_avg = V/L\* ≡ A_throat (since L\* = V/At), so "velocity_mean"/"mach_number" are ~contraction-ratio (≈3×) too high, and Re uses L\* as length scale — diagnostics/stability inputs only. Pressure/temperature "profiles" also use L\* as a physical axis (display-only).
- **F24** `spray` turbulence knobs inert: `turbulence_breakup_gain` never applied (pintle forces `breakup_multiplier = 1.0`, `pintle.py:256–263`; impinging hardcodes 1.0) — config field with no effect (partially documented).
- **F25** `feed_loss.py:58–74` + `FeedSystemConfig`: `A_hydraulic` is a required field that is **always ignored** (required `d_inlet &gt; 0` takes precedence); the module docstring recommends a dual-line workflow ("A_hydraulic with d_inlet omitted") that the schema forbids. Shipped configs are numerically self-consistent, so no wrong results today — latent trap.
- **F26** Cosmetics/latent: duplicate `"Tc_ideal"` key in diagnostics (`chamber_solver.py:770/775`); `mach_solver.py:260` computes the non-converged `converged` flag from the pre-update residual rather than the final one; `time_varying_solver.py:394–395` dereferences `ablative_cooling.enabled` without a None check (crashes if the coupled solver is invoked directly with no ablative section); hardcoded `fuel_velocity=50 / lox_velocity=30` in spatial stability (`time_varying_solver.py:757–758`) despite u_O/u_F being available in diagnostics; no flow-separation check for overexpanded sea-level nozzles in `calculate_thrust` (Summerfield/Kalt-Badal criterion absent — thrust optimistic for heavily overexpanded operating points).

# Verified-correct items (checked, no issue)

Area–Mach relation and its derivative (`mach_solver.py`) match the standard isentropic forms; isentropic P/T/M exit relations and choked-throat ratios in `nozzle.py` are correct; incompressible orifice flow ṁ = Cd·A·√(2ρΔp) correct throughout; annulus area exact; impinging included angle θ_O+θ_F and law-of-cosines u_rel geometry correct; L_imp = s/(tanθ_O+tanθ_F) and pitch-circle D = n·s/π correct; Huzel &amp; Huang chamber-length formula (`chamber_geometry.py:92–106`) correct; barometric formula (`runner.py:29–57`) correct; brentq bracketing/tolerances sane at defaults; Rao nozzle arcs (1.5 Rt / 0.382 Rt, L = %·(√ε−1)Rt/tan15°) standard; acoustic transverse eigenvalues correctly use J′ roots.</result>
<usage><subagent_tokens>296790</subagent_tokens><tool_uses>42</tool_uses><duration_ms>817094</duration_ms></usage>
</task-notification>


## Appendix C — Native C Kernel (engine/native/)

All verification complete. Here is the final report.

---

# Native C Kernel Review — EngineDesign/engine/native/

**Overall:** The C port is unusually faithful — CEA trilinear interpolation, discharge/feed/spray helpers, the impinging fixed-point solver, combustion-efficiency physics, ablative cooling, and the chug/acoustic fast tiers all match the Python reference expression-for-expression, with constants verified against `physics_constants.py`/`constants.py`. The real problems are concentrated in the **binding/self-check layer** (stale CEA tables, single-point self-check, no guard at all on the stability path), **NaN-swallowing `ed_max` semantics**, and **build races**. Findings below, severity-sorted.

## Findings (severity 5 → 1)

**F1. [Sev 3] Stale/wrong CEA tables after cache switch — `native_injector.py:249, 266-299` (`_ensure_cea`)**
`_CEA_LOADED` is keyed by `id(cache)` and records "this cache was loaded *at some point*", not "is currently loaded". The native lib has exactly one table slot (`EdNative._tables_buf`). Two failure modes: (a) a process alternating between two `CEACache` objects (e.g., propellant/config switch, Layer-1 vs Layer-2 eps ranges) leaves the native side holding the *other* cache's tables for all subsequent `chamber_solve` calls; (b) `id()` reuse after GC makes a brand-new cache appear "already loaded", so its tables are never loaded at all. Impact: for grossly different tables the per-call residual guard rejects every native Pc (silent 100% fallback → the entire 88x speedup silently disappears); for *similar* tables (same propellant, different grid) the wrong-table Pc can pass the guard, changing Pc/Isp by up to the guard tolerance (~0.1%, see F6). Fix: track the currently-loaded cache identity (and a strong ref) and reload on change.

**F2. [Sev 3] Injector native path is guarded by a single-point, one-time self-check — `closure.py:32-78`**
`_NATIVE_OK` is set by comparing native vs Python mdot at the *first* `(P_tank_O, P_tank_F, Pc, config)` encountered, then trusted for the whole process. CMA-ES mutates the config geometry in place on every iterate, so the check covers one geometry out of thousands. Worse, the chamber solve's per-call guard (`chamber_solver.py:263`) evaluates the "Python" residual via `flows()`, which itself dispatches to the **native** injector once `_NATIVE_OK=True` — so an injector-level divergence at other geometries is invisible to both guards and propagates into all results, including nominal "Python fallback" results. The port itself is faithful (I found no live formula divergence on the Ingebo path), so this is a structural guarantee gap rather than an active wrong-number bug: the claim "self-checks … so enabling it cannot change results" is not what the code enforces for the injector path.

**F3. [Sev 3] No self-check and no golden test for the native stability fast tier — `stability/analysis.py:487-506`, `ed_stability_modes.c`**
`chug_margin_fast` and `fast_acoustic` native results are used directly; only an exception triggers fallback. There is no CTest for `ed_chug_margin_fast`/`ed_fast_acoustic` and no golden vectors. Any regression in the C sweep (e.g., a future edit to `unwrap_pi`) silently changes stability margins and the Layer-1 stability gates. (Current implementations match `chug.py:139-193` and `acoustic.py:150-172` line-for-line, including `np.unwrap` semantics and the `DampingCoeffs` defaults 0.02/0.03/1.0 — but the C API hardcodes those defaults, so if a caller ever passes custom `DampingCoeffs` in Python, native diverges silently.)

**F4. [Sev 3] `autobuild.ensure_lib` races across ProcessPool workers — `autobuild.py:20, 96-107`**
`_LOCK` is a `threading.Lock` (per-process). With `ED_USE_NATIVE=1`, every spawned worker's `closure` import calls `prewarm()`, so N workers concurrently run `cmake` configure+build into the *same* `build_auto_&lt;os&gt;_&lt;arch&gt;` directory. CMake cache corruption / linker file collisions cause build failures (latching native off in that worker → silent perf loss) and can leave a corrupt build dir that persists across runs; a worker can also `CDLL()` a DLL another process is mid-writing. Fix: an OS-level file lock (e.g., `msvcrt.locking`/`fcntl`) or per-PID build dir + atomic rename. Also note `-march=native` (`CMakeLists.txt:17,37-43`) makes a shared/networked build dir non-portable across heterogeneous machines.

**F5. [Sev 3] `hot_wall_flux` has no chamber-diameter fallback and NaN is silently swallowed to "no cooling" — `ed_cooling.c:43-45` + `ed_types.h:63-64`**
C uses `d = cooling.regen_chamber_inner_diameter` directly. Python (`regen_cooling.py:561-570`) falls back to `sqrt(4·chamber_area/π)` then `A_throat` when `config` is None or `chamber_inner_diameter` is null. If the regen block is absent/null (builder writes 0.0, `native_injector.py:96-104`), C computes `A_cross=0 → V_g=inf → Nu=inf → h_g=inf·k/0 → NaN` fluxes, and because `ed_max(NaN, 0.0)` returns `0.0` (comparison false → returns b), `ablative_heat_removed` silently becomes 0 and `cooling_eff=1.0` — vs Python's real value (canonical-class configs: cooling_eff ≈ 0.9-0.99, i.e., c* and Pc off by up to several %). The chamber-solve guard catches this per call (falls back), but `ed_cooling_evaluate` is a public API that returns a confidently wrong number, and this NaN→0 swallow generally masks invalid states everywhere `ed_max`/`ed_min` are used (Python's `max()`/`np` propagate NaN). Canonical config has the field set, so today this only bites non-canonical configs.

**F6. [Sev 2] The "cannot change results" guarantee is actually a ±0.1% band — `chamber_solver.py:228-229, 263-268`**
The per-call guard accepts native Pc when `|residual_python(Pc_native)| ≤ max(1e-3·mdot_total, 1e-3 kg/s)`. With canonical numbers (mdot≈2.3 kg/s, ∂residual/∂Pc ≈ At/c* ≈ 1.1e-6 kg/s/Pa), that admits Pc shifts up to ≈2 kPa on 2.08 MPa (≈0.1%), with proportional shifts in thrust/Isp/MR rebuilt downstream. In practice Brent and brentq agree to ~1e-9 relative on the same residual, so observed drift is far smaller — but the mechanism *bounds* divergence, it does not *prevent* it, and combined with F1/F2 the bound is the only protection.

**F7. [Sev 2] `clamp_idx` size_t underflow → NULL/OOB dereference on unloaded or degenerate tables — `ed_cea.c:27-32, 38-40, 87-89`**
With `n==0` (tables never loaded — e.g., `EdNative.cea_eval()` before `cea_load`, or `ed_chamber_solve` with a zeroed tables buffer that passes the bounds check), `i &gt; n - 1` computes `n-1 = SIZE_MAX`, `clamp_idx` returns 1, and `t-&gt;Pc_grid[0]`/`table[...]` dereference NULL → segfault instead of an error. With `n==1`, C reads `grid[1]` out of bounds (Python's `min(max(i,1), 0)` + negative indexing "works"). `ed_cea_eval` should validate `n_* &gt;= 2` and non-NULL table pointers. Normal Python flow guards this (`_ensure_cea` before `chamber_solve`), so it's a crash-on-misuse, not crash-in-normal-use.

**F8. [Sev 2] `ed_cea_load` leaks the previous allocation on reload — `ed_cea.c:177-179`**
`memset(out, 0, sizeof *out)` clobbers `out-&gt;_owned` before assigning the new buffer; the shim reuses one `_tables_buf` for every `cea_load`, so each newly-loaded cache leaks the prior tables (~1-2 MB for a 25³ grid). Bounded by the number of distinct caches per process; combine with the F1 fix (free-then-load on cache switch).

**F9. [Sev 2] Thread-safety of the binding layer — `ed_native.py:291-299`, `native_injector.py:27-32, 266-299`**
`load()` and `_nat()` singletons have no lock (double-construction race); the single shared `_tables_buf` can be rewritten by `_ensure_cea` on one thread while another thread's `chamber_solve` is reading it (the backend runs the Layer-1 optimizer in a ThreadPoolExecutor per comments in `cea_cache.py:432-439`). The C kernel itself is stateless/reentrant — the hazard is purely the shared table buffer and unlocked module globals. ProcessPool workers are safe (separate address spaces) apart from F4.

**F10. [Sev 2] Live Lefebvre branch in C diverges from Python and is one golden-regen away from surfacing — `ed_injector_impinging.c:174-192` vs `impinging.py:483-505`, `export_injector_golden.py:68`**
Python's impinging solver *always* uses Ingebo SMD with a gas-density Weber number (explicit comment: Lefebvre on this path produced "bogus ~1 µm D32"). The C branches on `spray.smd_model` and its Lefebvre arm computes liquid-density Weber with an `ue = sqrt(u² + (0.35·u_rel)²)` effective velocity, `we_corr_max` capping, and Lefebvre D32 — none of which exists in the current Python impinging path. Production is masked because `native_injector.py:161` hardcodes `smd_model = 1`, but `export_injector_golden.py:68` writes the YAML value — regenerating goldens from a `model: lefebvre` config would produce C≠Python We/D32/x*/constraint results (D32 off by orders of magnitude). The branch should be deleted or the exporter should mirror the forced-Ingebo rule.

**F11. [Sev 2] ctypes layout drift guard covers only `EdEngineState` — `ed_native.py:200-205`**
`EdInjectorResult`, `EdChamberDiagnostics`, `EdCeaResult`, `EdChugStream/Result`, `EdAcousticResult` mirrors are unchecked; a field added/reordered in the C headers silently reads garbage through ctypes. Ironically `ed_abi.c:14-15` already exports `ed_sizeof_stability_result`/`ed_sizeof_chamber_diagnostics` — they're just never asserted. One-line fixes.

**F12. [Sev 1] Missing geometry fallbacks in the C residual — `ed_chamber.c:54-55`**
`Ac = π(chamber_diameter/2)²` lacks Python's fallback chain (chamber_diameter → regen inner diameter → 0.08 m, floor 1e-6; `chamber_solver.py:1290-1300`), and `Dinj = imp_O.d_jet` lacks Python's `max(d, 1e-5)` floor and `sqrt(4Ac/π)` fallback (`chamber_solver.py:1269-1272`). Zero diameter makes `combustion_state` fail → residual NaN → clean fallback to Python (perf loss only, not wrong numbers); `d_jet &lt; 1e-5 m` would give a different `eta_mixing` but the per-call guard rejects it.

**F13. [Sev 1] Denormal-denominator semantics differ — `ed_chamber.c:45` vs `chamber_solver.py:111` (`safe_divide`)**
Python rejects `mdot_F &lt; 1e-12` and near-zero `cstar_actual` (returns NaN); C only checks `&lt;= 0` and would compute an astronomically large MR (then clamped by the CEA grid). Only reachable with denormal flows; guard-protected.

**F14. [Sev 1] Failure-mode mismatch: Python raises, C returns NaN — `ed_combustion_physics.c:32, 149-153` vs `combustion_physics.py:137-163`**
`U_rms &gt; 200 m/s`, `U_mix ≤ 0`, missing SMD, `eta &gt; 1`, invalid `cooling_efficiency` raise `ValueError` out of the Python residual (aborting the solve), while C returns NaN and treats the point as out-of-domain (Brent may still find a root elsewhere in the bracket). End behavior converges because the per-call guard re-runs the Python residual (which raises → fallback → Python raises), but the native solve can do extra work and the semantic difference matters if the guard is ever loosened.

**F15. [Sev 1] Brent convergence band is 4x scipy's — `ed_root_find.c:56`**
C uses the Numerical-Recipes band `2·rtol·|b| + 0.5·xtol`; scipy `zeros.c` uses `(xtol + rtol·|x|)/2`. With canonical `tolerance=1e-6` (→ rtol 1e-9) the difference is ~3e-3 Pa on 2 MPa — utterly negligible; noted only because the file claims byte-parity with scipy structure.

**F16. [Sev 1] `closure_max_iterations = 0` returns seed garbage as ED_OK — `ed_injector_impinging.c:81, 90, 221`**
The outer loop body never runs and the function returns the 0.1 kg/s seed mdots with Cd=0, We=0 as a successful result; Python instead crashes with `NameError` (`delta_p_feed_O` unbound). Pathological config only; the one-time self-check would catch it at session start.

**F17. [Sev 1] Fluid-temperature default mismatch (currently unreachable) — `native_injector.py:70` vs `impinging.py:112-113`, `discharge.py:109`**
Builder maps missing/None temperature to 0.0 K; Python uses 90/300 K getattr defaults and skips the Cd temperature correction entirely when `T_inlet is None`. With `use_temperature_correction=True` and an unset temperature, C would apply factor `(1 − a_T)`. Unreachable today because Pydantic's `FluidConfig.temperature` defaults to 293.15 with `gt=0`.

## Self-check / fallback mechanism assessment

- **Chamber path (strong):** per-call, non-latching residual guard (`chamber_solver.py:232-279`) — every native Pc is validated against the Python residual; genuine library exceptions latch native off. This is well designed. Caveats: the tolerance is a ±0.1% band, not exactness (F6), and the "Python residual" used for validation itself calls the native injector (F2), so it validates chamber-level parity only.
- **Injector path (weak):** one-time, single-point mdot comparison at 0.1% rtol (`closure.py:62-77`); no per-call guard; config mutation during optimization is unchecked (F2).
- **Stability path (none):** native results used directly with no comparison and no golden test (F3).
- **CEA path:** correct-by-construction (dumps the live cache's own float64 tables), but the currently-loaded-table bookkeeping is broken (F1).
- **Autobuild:** thread-safe within a process, racy across processes (F4); build failure correctly degrades to Python.

So the claim "enabling it cannot change results" is accurate to ~0.1% for the chamber solve on the canonical config class, but is **not** mechanically guaranteed for injector-only calls, stability margins, or multi-cache sessions.

## Golden vs live-parity strategy — REVISIT (deferred 2026-07-21)

Open question, deliberately not resolved yet. `tests/test_native_ab_parity.py` was
extended to compare **all 33** `EdEvaluateResult` fields live (plus a coverage guard
that fails if a new struct field is added without a parity story), which makes the
component goldens largely redundant *as consistency checks*. The initial plan was to
delete them all in favour of live A/B. That plan is on hold, because the 386× gas
viscosity bug showed the two mechanisms answer different questions:

| | catches C↔Python divergence | catches *shared* drift | goes stale |
|---|---|---|---|
| Live A/B parity | yes | **no** | never |
| Frozen oracle golden | yes | yes, from its capture point | only if regenerated |
| Physical sanity bounds | no | yes | never |

Python and C carried the *identical* wrong viscosity constant, so they agreed
perfectly — no parity test of any kind could have caught it, and live A/B passes to
this day. A golden captured before the bug and never regenerated would have caught
it, precisely because it does not track the code.

So the split to decide, per golden:
- `nozzle_golden.json` — **keep as an oracle**. Isentropic area-Mach exit state is
  settled physics; the 2026-06 capture is a legitimate independent reference.
  Regenerating it would replace the oracle with "whatever the code does now".
- `residual_samples.json` — **retire in favour of A/B**. It covers cooling, which is
  under active change; its anchor value is already spent (regenerated for the
  viscosity fix) and it will need regenerating on each further thermal change.
  Blocked on ctypes bindings for `ed_combustion_efficiency_advanced` /
  `ed_cooling_evaluate`, whose eta sub-components and `heat_removed` are not on
  `EdEvaluateResult`.
- `injector_impinging.json`, `component_samples.json` — case by case.
- `cea_tables.bin` — **not a snapshot at all**; shared *input* data both sides read.
  Only `cea_samples.json` alongside it is an expected-output snapshot.

Real lesson: the suite had **no physical sanity checks**, the only thing in the table
above that catches a shared error without depending on history. That gap is now
partly filled by `tests/test_gas_side_heat_transfer.py`, and is the piece worth
investing in over either of the other two.

## Golden-test coverage gaps

- **Single config, single propellant:** every golden file derives from `configs/canonical/impinging.yaml` (LOX/CH4, one 3D CEA grid). No LOX/RP-1 or other propellant tables, no other grid shapes, no 2D cache (correctly refused at binding level, but untested).
- **Injector:** all 24 samples have `constraints_satisfied = 0` — the Cd-reduction loop is well exercised but the *early-exit* (constraints satisfied) path, `We_min` boundary, and `x_star` constraint toggling are never hit; Lefebvre branch never exercised (F10); pintle/coaxial are stubs.
- **Residual physics:** 18 samples, one config → only `model: exponential`, only ablative+coupling+physics-blowing with surface_T (1200 K) &gt; pyrolysis (950 K). Untested branches in `ed_cooling.c`: below-pyrolysis, legacy constant-blowing, turbulence multiplier at its clamp, `energy_per_mass ≤ 0`, cooling-coupling off, regen-diameter fallback (F5). Untested in `ed_combustion_physics.c`: constant/linear eta models, `tau_Tc_floor` active, MR&lt;1.5 / MR&gt;3.0 Ea branches (samples cluster near MR≈2.4-4.2 so the MR&gt;3 branch may partially hit).
- **Chamber:** `test_chamber_golden.c` exits 77 (SKIP) — end-to-end chamber parity lives only in an out-of-CI ctypes harness; `golden_impinging.json` (6 runner-level vectors) has no C consumer.
- **Stability:** zero golden/CTest coverage for `ed_chug_margin_fast` / `ed_fast_acoustic` (F3).
- **Good coverage:** `component_samples.json` exercises all three `phi_type`s, pressure/temperature corrections on/off, and geometry-Cd on/off; `cea_samples.json` (79 pts) includes clamp-edge points. The CEA NaN-corner fallback is exercised only if the shipped table happens to contain NaN cells (unverified).

## Dead / unused code noticed

- **Stubs:** `ed_combustion_eff.c`, `ed_injector_pintle.c`, `ed_injector_coaxial.c`, `ed_nozzle.c`, `ed_stability.c` (`ed_stability_analyze`), `ed_evaluate.c` (always `ED_ERR_NOT_IMPLEMENTED`; `ed_evaluate_batch` and the `EdNative.evaluate()` binding are consequently dead), `state_from_yaml.c` (usage shim).
- **`EdWorkspace` is entirely vestigial** — `ed_chamber_solve` ignores `ws` (`ed_chamber.c:100`); `residual_hist`, `seg_x/q`, `mode_freq/margin`, warm-start fields are never written; `ed_workspace_init` unused.
- `ed_state_patch` (`ed_state.h:232-239`) unused by any caller.
- **`ed_state_builder.py` duplicates `native_injector.build_state`** (only used for the golden `state_impinging.json` via `__main__`; `build_state_bin` raises NotImplementedError) — two independent config→state mappings that can drift (e.g., ed_state_builder omits fluids/spray/comb entirely).
- Impinging Lefebvre branch + `smd_we_corr_max` + `smd_C/m/p` fields: dead in production (forced Ingebo).
- Never-populated `EdEngineState` fields: `fluid_*.specific_heat/thermal_conductivity/bulk_modulus/boiling_point/molecular_weight/Pc_ref`, `comb.efficiency/K/mixture_efficiency_floor/turbulence_efficiency_floor/Pc_gate/A0_hydrocarbon/Ea_hydrocarbon/n_pre_hydrocarbon`, pintle/coax placeholder fields, `geom.Cf/design_pressure/exit_diameter`, `P_ambient`.
- `ED_ERR_OUT_OF_RANGE` (`ed_types.h:25`) never returned; `ed_sizeof_stability_result`/`ed_sizeof_chamber_diagnostics` exported but never asserted by the shim (see F11); `ed_cea_trilinear` exposed for tests only (documented as such).</result>
<usage><subagent_tokens>306761</subagent_tokens><tool_uses>72</tool_uses><duration_ms>339019</duration_ms></usage>
</task-notification>


## Appendix D — Thermochemistry + Config System (engine/pipeline/, configs/)

All verifications complete. Final report follows.

---

# FINDINGS (severity-sorted)

## Severity 4

**F1 — Combustion/nozzle efficiencies never degrade exhaust velocity: Isp/thrust reported near-ideal, and lower η_c* *increases* computed thrust.**
`engine/core/nozzle.py:548-556, 573-575, 611, 675` (consumption chain of the pipeline thermochemistry; verified no downstream correction in `engine/core/runner.py:360-403`).
`calculate_thrust` computes `F = mdot·v_exit + (P_exit−Pa)·A_exit` where `v_exit` comes from isentropic expansion of the **ideal CEA Tc** (nozzle.py:335, 373). `eta_cstar` only enters the chamber mass balance (`chamber_solver.py:200-210`: `mdot = Pc·At/(η·c*_ideal)`), and `cg.nozzle_efficiency` only multiplies `Cf` (nozzle.py:265) which is used solely in the dead fallback `F_cf` (the thrust-equation check at nozzle.py:603-608 compares `F_total` against `F_mom+F_pres`, identically equal, so it never trips). `combustion_eff.calculate_actual_chamber_temp` exists but has zero callers on the active path (only `scripts/validate_chamber.py`). Net: `Isp = F/(mdot·g0) ≈ v_exit_ideal/g0` independent of η_c* and η_nozzle; and at fixed Pc, `F ∝ 1/η_c*` (backwards). **Impact:** with typical η_c*≈0.90 and nozzle_efficiency=0.95, delivered Isp is overestimated ~10-15%; forward-mode thrust exceeds what `chamber_geometry_solver.py:217` sized for (it applies `nozzle_efficiency×Cf_ideal` when solving A_throat) by ~5% systematically.

**F2 — Arrhenius exponent off by 1000× (J/mol vs J/kmol): finite-rate chemistry has no temperature dependence.**
`engine/pipeline/reaction_chemistry.py:21, 278` — `R_gas = 8314.462618  # J/(kmol·K)` but `Ea` values (80,000 / 140,000 / 40,000, config-documented as J/mol) are divided by it directly: `exp(-Ea/(R_gas·Tc))` = `exp(-80000/(8314·3500)) ≈ exp(-0.00275) ≈ 1.0` instead of `exp(-2.75) ≈ 0.064`. Same in the dissociation estimate at `reaction_chemistry.py:687-689` (`E_diss=800000 J/mol` / 8314), making `dissociation_factor ≈ 1` at all temperatures. **Impact:** reaction time τ at nozzle-exit conditions (T≈1500 K, P≈0.1 MPa) is ~1.3 µs instead of ~0.8 ms — Da overestimated ~600×, so the shifting-equilibrium model always concludes "chemistry infinitely fast", and `gamma_frozen` becomes a temperature-independent constant offset (~+0.06-0.10). Active path: `chamber_solver.py:649-667` (`use_finite_rate_chemistry: true` in both canonical configs) and `nozzle.py:398-460` (`use_shifting_equilibrium: true`).

**F3 — Shifting-equilibrium blend is inverted: fast chemistry (Da→∞) yields ~frozen gamma, slow chemistry yields equilibrium gamma.**
`engine/pipeline/reaction_chemistry.py:882` — `equilibrium_factor = (1−r)·(1−Φ) + r` with default `r=0.1` (nozzle.py never passes it; config has no `nozzle.reaction_rate_factor`). Φ=1 (equilibrium per the comment at lines 872-874) maps to 0.1; Φ=0 (frozen) maps to 1.0. Then line 885 `gamma_exit = gamma_frozen + (gamma_chamber−gamma_frozen)·factor` — so when Da≫1 (always, per F2) `gamma_exit ≈ gamma_frozen ≈ gamma_chamber + ~0.08` (per F2's constant shift). **Impact:** every forward run and time-step inflates exit gamma by ~0.07 (e.g. 1.14→1.21): at eps≈4.6 that shifts M_exit ~2.86→2.74, P_exit/Pc ~0.020→0.028, v_exit ~1-3%, i.e. a persistent ~2-3% thrust/Isp bias plus wrong P_exit for the flow-separation/altitude logic.

**F4 — Canonical pintle config: `design_MR: 2.55` for LOX/ethanol — stale kerolox value, outside its own CEA grid.**
`configs/canonical/pintle.yaml:36` (`design_MR: 2.55`) vs `optimal_of_ratio: 1.4` (line 132) and ethalox preset `MR_range: [1.0, 2.5]` (`configs/propellants/ethalox.yaml:39`). MR 2.55 for LOX/ethanol is far oxidizer-rich of optimum (~1.4-1.8) and is *above the cache MR grid max*, so any geometry re-solve at design_MR silently evaluates CEA at MR=2.5 (`cea_cache.py:849` clamp). The chamber geometry stamped into this canonical file was solved for a mixture ratio the config itself declares wrong. **Impact:** re-running `solve_chamber_geometry_with_cea` from this canonical seeds geometry with c*/Tc at MR 2.5 instead of 1.4 — c* error ~5-8%, Tc error several hundred K; and design_MR vs optimal_of_ratio disagree by 82%.

## Severity 3

**F5 — Silent clamping at CEA grid edges over ranges the optimizer actually explores.**
`engine/pipeline/cea_cache.py:848-852` — `eval()` clamps Pc/MR/eps with no warning (debug prints commented out, lines 854-870). Quantified against active configs:
- eps: cache `eps_range: [4.0, 15.0]` (all three presets) vs Layer-1 search box `layer1_expansion_ratio_min: 3.0` (`configs/canonical/impinging.yaml:439`, `configs/default.yaml:478`) — all candidates with eps∈[3,4) are evaluated as eps=4 (Cf/gamma error ~2-4%, flat objective in that band).
- Pc: cache `[1.0, 9.0] MPa` vs solver bracket `Pc_bounds: [0.1, 8.0] MPa` (`config_schemas.py:696`, canonical impinging.yaml:281-283) — brentq residual evaluations below 1 MPa use 1 MPa thermochemistry; distorts the low bracket for low-thrust candidates.
- MR: solver MR = mdot_O/mdot_F is unconstrained during CMA sampling; methalox grid floor 2.4 / ethalox ceiling 2.5 clip realistic candidates (and the pintle design point itself, F4).

**F6 — Cache metadata check is deliberately lenient: range/n_points mismatches accepted, 2D `expansion_ratio` never checked.**
`engine/pipeline/cea_cache.py:299-343, 394-404` — `_meta_matches` only enforces ox/fuel names and 2D/3D dimensionality; a cache built over a different Pc/MR/eps range is accepted (info-level log only) and `eval()` then silently clamps to the *cached* range, not the configured one. For 2D caches, `expansion_ratio` is absent from the match, so a cache built at eps=4 would serve a config at eps=8 with no rebuild (latent — all active presets are 3D). Propellant-switch invalidation itself is sound (names checked; per-propellant `cache_file` names in presets; `config_switch.apply_propellant` overlays `cache_file`). **Impact:** wrong-by-construction thermochemistry whenever a stale-ranged cache file exists at the configured path; user's configured ranges silently narrowed.

**F7 — Gasification (vaporization-limited combustion) model ignores the configured fuel: hardcoded RP-1-ish liquid properties used for methane/ethanol.**
`engine/pipeline/combustion_physics.py:187-194` (defaults `rho_l=800`, `mu=7e-5`) and `combustion_physics.py:1196-1200` (call site passes neither `rho_l`, `cp_l` nor `T_inj`), plus `engine/core/chamber_solver.py:1357-1362` (`_get_fuel_props` returns only boiling_point/latent_heat/molecular_weight/Pc_ref — **not** the schema's `density`, `specific_heat`, `temperature`). So for methalox: τ_gasify uses ρ_l=800 instead of 422.6 (1.9× overestimate of the gasification timescale), cp_l=2000 vs 3348, T_inj=293 K vs 112 K. **Impact:** η_Lstar (vaporization efficiency) biased low by up to ~3-5 percentage points for LCH4 designs (e.g. Da_L 3→5.7 ⇒ η 0.95→0.997); the YAML fluid fields `specific_heat`, `temperature`, `density` are effectively ignored by the c*-efficiency model — the exact "design parameters ignored" bug class.

**F8 — `extra = "allow"` with comment "Reject unknown fields": YAML typos validate silently.**
`engine/pipeline/config_schemas.py:1473-1474`. Any misspelled key (`Lstar_` vs `Lstar`, `nozzle_efficency`, wrong nesting level) is accepted and ignored — pydantic will not flag it. Given this repo's history of exactly this bug class ("fixed design parameters being ignored sometimes", commit 801f4edf), this is the enabling hole. **Impact:** unbounded — silently reverts any parameter to its schema default.

**F9 — Efficiency-model config switches defined but never read (Python physics path).**
- `use_advanced_model` (`config_schemas.py:508`) — `combustion_eff.eta_cstar` (line 109-162) *always* calls the advanced model; only the native marshaller reads it (`engine/native/python/native_injector.py:261`). Setting `use_advanced_model: false` in YAML does nothing in the Python path.
- `Pc_gate` (`config_schemas.py:512`, "below this pressure the simple model is used") — read nowhere in Python (`ed_native.py:63` only marshals it to C).
- `use_spray_correction`, `spray_penalty_factor` (`config_schemas.py:462-463`) — zero readers anywhere.
- `FluidConfig.vapor_pressure` (`config_schemas.py:16`) — required (`ge=0`) in every propellant YAML, read by no code (spalding uses CoolProp instead).
**Impact:** four documented knobs are dead; user changes have no effect, and Python-vs-native behavior can diverge on `use_advanced_model`/`Pc_gate`.

**F10 — Canonical impinging config internally inconsistent on thrust/MR design point.**
`configs/canonical/impinging.yaml:262-264` (`design_pressure: 2.41 MPa, design_thrust: 7000 N, design_MR: 2.55`) vs `design_requirements` (`target_thrust: 8000` line 368, `optimal_of_ratio: 2.8` line 370). The stamped chamber geometry (A_throat 1770 mm², Cf 1.66) was solved for 7000 N @ MR 2.55; forward mode against the stated 8000 N / MR 2.8 requirement starts 12.5% low on thrust and 9% off on MR with no staleness warning (`design_valid_for` only tracks injector/propellant identity, not design targets — `config_switch.py:204-228`). Also `design_MR 2.55` is barely above the methalox MR grid floor 2.4, and LOX/CH4 optimum is ~3.0-3.4, so the seeded geometry is off-optimum. Geometry arithmetic itself checks out (A_exit/A_throat = 4.6089 = eps; L* = V/At ✓).

**F11 — Feed loss: `A_hydraulic` is a required schema field but can never take effect; `d_inlet` always wins.**
`engine/pipeline/feed_loss.py:58-74` — `d_inlet` is checked first and `FeedSystemConfig.d_inlet` is required with `gt=0` (`config_schemas.py:110`), so the `A_hydraulic` branch is unreachable from any valid config; yet `A_hydraulic` is *also* required, and the module docstring (feed_loss.py:4-5) tells users to set `A_hydraulic = 2π(d/2)²` "with d_inlet omitted" — which the schema forbids. **Impact:** none in the shipped canonicals (both fields consistent: fuel 7.13e-5 = π(0.009525/2)²; ox 1.425e-4 = dual-line equivalent of d_inlet=√2·d — verified), but any config expressing twin lines via `A_hydraulic` alone per the documented recipe fails validation or, if `d_inlet` is left at single-line value, computes 4× the dynamic-pressure loss. Dead parameter + contradictory contract. Physics of `Δp = K_eff·(ρ/2)·v²` itself is correct.

## Severity 2

**F12 — `solve_spalding_coupled` crashes unconditionally: `clipping_count` never initialized.**
`engine/pipeline/spalding.py:730, 763` — incremented/read but never assigned (lines 613-614 define `T_s_clipped_count`/`X_F_s_clipped_count` instead). Line 763 executes on every call → `UnboundLocalError` on every invocation. Currently unreachable in normal use only because its sole caller sits behind `SPALDING_DIAGNOSTIC_ENABLED = False` (`combustion_physics.py:332`) inside a try/except. Also: `calculate_vapor_pressure` (spalding.py:57) hard-rejects any fuel not in {RP-1, Ethanol} — the active methalox propellant would raise "Invalid fuel: Methane/CH4" if this path were ever enabled; and the stall diagnostic at line 630 compares a temperature against a counter (`abs(T_s - T_s_clipped_count)`).

**F13 — Missing `warnings` import breaks the gasification-failure fallback.**
`engine/pipeline/reaction_chemistry.py:429` — `warnings.warn(...)` inside `except` with no module-level `import warnings` (the only import is function-local at line 861 in a *different* function) → `NameError` replaces the intended 1 ms fallback. Caught upstream at `chamber_solver.py:669-683`, which then assumes `progress_throat=1.0` — so a gasification-model failure silently becomes "perfect equilibrium" with only a generic warning. Failure-path only.

**F14 — `eval()` accepts `Pa` but ignores it; the Cf table is baked at rocketcea's default ambient (14.7 psia).**
`engine/pipeline/cea_cache.py:195, 510, 817-886` — `get_PambCf(Pc=…, MR=…, eps=…)` leaves `Pamb` at its default, and `eval(MR, Pc, Pa, eps)` never uses `Pa`. Runner passes altitude-varying `Pa` (`runner.py:353`). Mitigated because the primary thrust path is momentum+pressure with explicit Pa (nozzle.py:549), and `Cf_ideal` is consumed only for diagnostics/validation thresholds and by `chamber_geometry_solver.py:213-217` (sea-level sizing, where sea-level Cf is arguably intended). **Impact:** `Cf_ideal`/`Cf_theoretical` outputs are wrong at altitude (a few % at 3 km); misleading API.

**F15 — Trilinear NaN fallback returns the lower corner, not nearest, and can propagate NaN.**
`engine/pipeline/cea_cache.py:793-796` — if any of the 8 corners is NaN (failed CEA points are stored as NaN, lines 533-545), the interpolant returns `table[i_pc−1, i_mr−1, i_eps−1]`, which may itself be NaN or the *farthest* corner. The 2D path has proper weighted-valid-corner handling (lines 697-729); the 3D path (the one actually used — all presets 3D) does not. **Impact:** near failed grid points the solver residual goes NaN or jumps discontinuously; brentq aborts for those candidates.

**F16 — Frozen-gamma "high-pressure limit" probe is a no-op / wrong call.**
`engine/pipeline/reaction_chemistry.py:656-669, 1012-1023` — `cea_cache.last_MR` is never set anywhere (verified: no writer), so the ValueError path always fires and the CEA-based frozen gamma silently falls to the hand-rolled estimate (which has the F2 unit bug); where called with args, `cea_cache.eval(MR, P_frozen, T_exit, None)` passes a *temperature* as the `Pa` argument (harmless only because of F14), and `P_frozen = 10×P` is silently clamped to the grid max anyway, so "frozen = high-P limit" could never work as designed.

**F17 — Kinetics fuel-type dispatch depends on CEA card names matching hardcoded lists; methane relies on absent config attrs.**
`engine/pipeline/reaction_chemistry.py:213-218` — `CH4` branch reads `A0_methane`/`Ea_methane`/`n_pre_methane` via getattr with fallback to *hydrocarbon (RP-1)* kinetics; those methane fields don't exist in `CombustionEfficiencyConfig`, and thanks to F8 (`extra="allow"`) a user adding `A0_methane` to YAML would silently... actually work via pydantic extra attrs — but is undocumented and unvalidated. Net effect today: methalox uses RP-1 kinetics constants (Ea 80 kJ/mol vs CH4 ~100+); mostly masked by F2. Also `Ea *= 1.2` for MR&lt;1.5 (line 256-257) double-adjusts on top of config-per-fuel Ea.

**F18 — `_load_cache` adopts the cached grid and updates bounds, so the configured ranges are silently replaced.**
`engine/pipeline/cea_cache.py:367-404` — after the lenient meta match, `Pc_min/max`, `MR_min/max`, `eps_grid` are overwritten from the file. Combined with F6: a config widening `MR_range` (e.g. to fix F4) does nothing until the .npz is manually deleted — n_points is equal, meta "matches", old grid wins. Only an info log mentions it.

**F19 — LOX `specific_heat: 2300` in all three presets is ~35% high.**
`configs/propellants/*.yaml` (methalox:26, ethalox:26, kerolox:27) — liquid O₂ cp at 90 K is ≈1700 J/(kg·K). Consumed by cooling/stability models. Other fluid values check out (LCH4 ρ 422.6, Tb 111.65 K, L_vap 510 kJ/kg; ethanol ρ 789, Tb 351.4 K, L_vap 838 kJ/kg; LOX ρ 1140, μ 1.8e-4 — all sane). Kerolox is honestly flagged DRAFT in-file.

**F20 — `use_parallel_cea_build` comment/behavior mismatch and misplaced class docstring.**
`engine/pipeline/cea_cache.py:426` reads `getattr(self.config, 'use_parallel_cea_build', False)  # Default to False` — but the schema field exists with default **True** (`config_schemas.py:424`), so the getattr default never applies; on non-Windows the "not process-safe" parallel path (with a global lock serializing every call, i.e. no speedup) runs by default. `config_schemas.py:426`: the `"""CEA configuration"""` docstring sits after two fields — dead string, not a docstring. Canonical impinging sets it false; canonical pintle leaves it true.

## Severity 1

- `engine/pipeline/cea_cache.py:80` — module-level `print = safe_print` shadowing rerouted through `logging.getLogger("evaluate")`; also mutates `sys.stdout` at import (lines 83-90). Import-order-sensitive side effects.
- `engine/pipeline/cea_cache.py:134-140` — Isp parsed from "Isp, M/SEC" (m/s) but docstring says seconds; value is never stored in the cache, so harmless.
- `engine/pipeline/spalding.py:735-747` — per-iteration solver progress emitted via `warnings.warn` (would spam the warnings registry if the function worked).
- `configs/canonical/*.yaml` — deprecated fields (`use_turbulence_coupling: true`, `mixture_efficiency_floor`, etc.) still carried; schema marks them `[DEPRECATED] no longer used` — harmless clutter but implies effect.
- `engine/pipeline/constants.py` — large blocks of self-declared "DEPRECATED - DO NOT USE" fallback constants still importable; `DEFAULT_*` values still used as `.get()` defaults in `chamber_solver.py:161-164` and `combustion_eff.py:112-135`, contradicting the file's own header.

# Grid ranges vs. explored ranges (quantified, for item 1 of the brief)

| Axis | Cache grid (34 pts) | Explored by active code | Silent-clamp exposure |
|---|---|---|---|
| Pc | 1.0–9.0 MPa (all presets) | brentq bracket 0.1–8.0 MPa; L1 tank box ≤600 psi ⇒ Pc ~1.5–3.8 MPa | Bracket evaluations &lt;1 MPa clamped (spacing 0.24 MPa) |
| MR (methalox) | 2.4–4.2 | target 2.8; unconstrained mdot ratio during CMA | Candidates &lt;2.4 clamped; design_MR 2.55 near floor |
| MR (ethalox) | 1.0–2.5 | target 1.4; canonical design_MR **2.55 — outside grid** | Design point itself clamped (F4) |
| eps | 4.0–15.0 | L1 box **3.0**–14.0 | eps∈[3,4) all evaluated as 4.0 (F5) |

# Dead / unused from active entry points (backend/main.py, engine/optimizer/main_optimizer.py, engine/core/runner.py, ui/)

Dead (no importer outside archive/scripts, or only behind a disabled flag):
- `engine/pipeline/spalding.py` — entire module; sole importer is the `SPALDING_DIAGNOSTIC_ENABLED = False` block in combustion_physics.py:332-348, and its main solver crashes anyway (F12).
- `engine/pipeline/iterative_sizing.py` — zero importers.
- `engine/pipeline/recession_animation.py` — zero importers.
- `engine/pipeline/validation.py` — zero importers.
- `engine/pipeline/visualization.py` — empty (0 lines); referenced only by `scripts/pressure_sweep.py`.
- `engine/pipeline/combustion_eff.py::calculate_actual_chamber_temp` and `::calculate_frozen_flow_correction` — only `scripts/validate_chamber.py`.
- `engine/pipeline/combustion_physics.py::calculate_equilibrium_shift` — no callers found.
- `engine/pipeline/spalding.py::calculate_spalding_number / calculate_spalding_pressure_based / calculate_vapor_pressure_antoine / calculate_film_diffusivity` — no callers.

Live (for the record): cea_cache, combustion_physics, combustion_eff (eta_cstar path), reaction_chemistry (via chamber_solver + nozzle), feed_loss (all three injectors), config_schemas/io/config_switch, constants, physics_constants, numerical_robustness, assumptions (stability path), burn_time_sync (schema validator + backend), time_varying_solver (+ its deps localized_ablation, nozzle_dynamics, thermal_analysis, physics_based_replacements), chamber_geometry_fixed / flight_altitude_optimizer / tank_capacity / time_series (backend routers), chamber_optimizer / comprehensive_* / coupled_optimizer / chamber_geometry_visualizer / system_diagnostics (legacy `ui/` + optimizer views only).

Caveat: F14's "Pamb defaults to 14.7 psia" rests on rocketcea's documented `get_PambCf(Pamb=14.7, ...)` signature — rocketcea is not installed in this environment (both `python` and `py -3.13` lack it), so I verified the call site omits `Pamb` but could not execute the library to confirm the default.</result>
<usage><subagent_tokens>257388</subagent_tokens><tool_uses>35</tool_uses><duration_ms>199566</duration_ms></usage>
</task-notification>


## Appendix E — Thermal + Optimizer Layers 3-4

All verification complete. Final report follows.

---

# FINDINGS — severity-sorted

## Severity 4

**F1. `engine/pipeline/time_varying_solver.py:360` — convective coefficient is always the hardcoded fallback 50,000 W/m²K due to a dict-key mismatch.**
`h_hot_chamber = heat_flux_chamber_dict.get("h_g", 50000.0)`, but `estimate_hot_wall_heat_flux()` (`engine/pipeline/thermal/regen_cooling.py:615-625`) returns the coefficient under key `"h_hot"`, never `"h_g"`. The computed physical h (≈500–2,000 W/m²K for this engine class) is silently replaced by 50,000 — 25–100× too large — in the primary Layer-3 sizing path. Downstream consumers: `h_hot_throat = h_hot_chamber × (q_throat/q_chamber)` (line 391, ≈400,000 W/m²K), the graphite recession energy balance (`heat_transfer_coefficient` at line 478), and both multi-layer thermal-profile BCs (lines 916, 961). Impact: the graphite surface-temperature solve is driven into the `surface_temperature_limit` clip (2,500 K, `graphite_cooling.py:585`) at every step, so throat surface temperature is a constant artifact, kinetic oxidation is always evaluated at max clip temperature, and recession is forced to the diffusion limit regardless of actual conditions. Quantified: q_in at the throat evaluates to ~250+ MW/m² (physical: 5–15 MW/m²).

**F2. `engine/pipeline/thermal_analysis.py:100-117` — `calculate_steady_state_temperature_profile()` never solves the thermal network; heat flux is set by the initial guess and layer resistances are ignored.**
The "iteration" is the map `T_new = T_old − q_rad/h`, which exits on the first pass when `q_rad_hot≈0`: `T_surface_hot` stays at the initial guess `0.8·T_hot_gas` (line 100) and `q_total = 0.2·h·T_g + q_rad` regardless of wall conduction. Correct behavior: solve `q = (T_g − T_amb)/R_total` through the resistance network it already builds (lines 85-95) — `R_cond` is computed and then never used for q. Consequences: `T_surface_cold = T_amb + q_total/h_ambient` with `h_ambient=10` gives back-face temperatures of 10⁴–10⁶ K (with F1's h=50,000: T_cold ≈ 3.2 million K). Every `T_ablative_surface`, `T_stainless_chamber`, `T_graphite_surface`, `T_stainless_throat` value in the time-series results is garbage. Mitigating factor: I verified no backend router or frontend component currently consumes these fields, and the intended feedback into the graphite model is dead (F5) — so present-day damage is confined to the results dict — but any future consumer (e.g. a steel-overtemp check) silently gets nonsense. Severity 4 as physics, ~2 as current impact.

## Severity 3

**F3. `engine/pipeline/thermal/regen_cooling.py:606-611` + `engine/pipeline/constants.py:116` — gas radiation modeled as a gray body with ε=0.8 at full Tc⁴ dominates and badly overestimates chamber heat flux.**
`heat_flux_rad = 0.8 × 1.0 × σ × (Tc⁴ − Tw⁴)`. For non-luminous LOX/CH4 or LOX/ethanol products in an ~8 cm chamber, effective gas emissivity is ~0.05–0.15 (H₂O/CO₂ band radiation); 0.8 is a soot-laden solid-motor value. At Tc=3,200 K, Tw=1,200 K this contributes ≈4.7 MW/m² vs a Dittus-Boelter convective part of ≈1–1.5 M W/m² (which is itself *under*-estimated: fixed k=0.1 W/mK, constants.py:108, vs ~0.25–0.4 for 3,200 K combustion gas, and a pipe-flow correlation instead of Bartz). Net chamber flux ≈6 MW/m² vs a realistic 2–3.5 MW/m². This is the `heat_flux_chamber` that drives ablative recession in the Layer-3 coupled solver (`time_varying_solver.py:353-359, 399-406`). Quantified impact: chamber recession, and therefore the Layer-3 optimized ablative thickness (sized to 1.25×max recession), is overestimated by roughly 1.5–2.5× — conservative direction, but wrong margins and excess liner mass. Same defaults are used in `chamber_solver.py:1139` (regen disabled in all shipped configs → config=None → ε=0.8).

**F4. `engine/pipeline/time_varying_solver.py:380-391` + `engine/pipeline/physics_based_replacements.py:237` — the "Bartz" chamber→throat ratio is applied to the *total* chamber flux including the radiative component.**
`heat_flux_throat = heat_flux_chamber × ratio` where ratio ≈ (V_t/V_c)^0.8·(P_t/Pc)^0.2·(D_c/D_t)^0.1 ≈ 6–9 (the convective ratio itself is acceptable — within ~15% of Bartz's (A_c/A_t)^0.9). But `heat_flux_chamber` is ~75% radiation (F3), and gas radiation does not scale with mass flux — at the throat it *drops* (T_static falls, small optical path). With F3's 6 MW/m² chamber flux, throat flux ≈ 40–50 MW/m² vs realistic 8–15 MW/m². Feeds `h_hot_throat` (F1 chain), the throat thermal-profile BC, and the reported `heat_flux_throat` array. Quantified: throat heat load overestimated ~3–5×.

**F5. `engine/pipeline/time_varying_solver.py:455-460` — graphite backside-temperature coupling is dead code: `'T_stainless_throat' not in locals()` is always True.**
`T_stainless_throat` is assigned at line 935/974, *after* this check runs (each call executes 455 before 935; locals from the previous timestep don't persist). So strict-mode graphite conduction always uses `T_backside = 300.0` K, and `q_cond = k_s(T_s − 300)/thickness` (`graphite_cooling.py:445`) treats the steel case as an infinite 300 K sink for the whole burn — for a 10 mm insert at T_s=2,500 K that's a constant 22 MW/m² sink, several × the real transient soak-out. Effect: pulls surface temperature down / understates recession in the un-clipped regime, and makes computed recession *increase* with insert thickness (thicker → less conduction → hotter surface), quietly violating Layer 3's "more thickness = less recession" monotonicity assumption (`layer3_thermal_protection.py:474-485`). Currently masked by F1 (T_s pinned at clip).

**F6. `engine/optimizer/main_optimizer.py:1027` — `thermal_protection_valid` hardcoded `True` regardless of burn-through check.**
`final_performance["thermal_protection_valid"] = True  # Optimization completed = valid` even when `ablative_ok`/`graphite_ok` (lines 1015, 1021) are False. A design whose liner fully burns through is reported as thermally valid by this entry point. Also inconsistent margins: main_optimizer's inline Layer 3 accepts recession ≤ 95% of thickness (lines 941-947, 1015-1021) while the module `run_layer3_thermal_protection` (which main_optimizer imports at line 44 but never calls) enforces recession ≤ 80% (margin_factor 1.25). Note: main_optimizer.py is the legacy CLI orchestrator; the backend router uses the (stricter) module version.

**F7. Layer 3 sizes the ablative liner on recession only — no insulation/soak-through constraint anywhere in the active path.**
`engine/optimizer/layers/layer3_thermal_protection.py:400-415, 531-543`: the only requirement is thickness ≥ 1.25 × max recession, leaving ~0.25×recession (≈0.5–1.5 mm) of virgin material at end of burn with no check that the steel case stays below `max_temperature` (the mechanism that was supposed to check this is F2/F5-dead). A liner can pass Layer 3 while the case overheats before burnout. Impact: unquantifiable without a working conduction model, but for 1 mm residual phenolic at multi-MW/m² flux the steady ΔT margin is small; this is the classic dominant sizing criterion for ablative liners and it is absent.

**F8. `engine/pipeline/time_varying_solver.py:395-405, 463` — ablative recession model called with fixed `surface_temperature=1200.0`, fixed `turbulence_intensity=0.1`, and no `gas_mass_flow_rate`, so the config-selected physics-based blowing model is silently bypassed.**
Because `gas_mass_flow_rate` is omitted, `compute_ablative_response` (`ablative_cooling.py:401-408`) falls back to the legacy constant blockage `1 − blowing_efficiency = 0.2` (i.e., 80% of convective flux removed) even though `use_physics_based_blowing: true` is the config default and the chamber_solver path (chamber_solver.py:1146-1154) *does* pass it. The two paths therefore compute different recession for the same state; the sizing-critical TVS path uses the crude constant. Additionally the 80/20 conv/rad split assumed at `ablative_cooling.py:441-443` is inverted vs. the actual F3-dominated composition (~25/75), so blowing/turbulence multipliers are applied to the wrong share. Combined effect on recession: tens of percent, direction depends on config.

## Severity 2

**F9. `engine/pipeline/time_varying_solver.py:509, 600-606` — nozzle exit area grows from ablation unconditionally, ignoring `nozzle_ablative` config flag.**
`recession_exit_new = recession_exit + recession_rate_ablative*dt  # Simplified` and `update_nozzle_exit_from_ablation()` are applied whenever ablative cooling is enabled, whereas the config field `AblativeCoolingConfig.nozzle_ablative` (default False, config_schemas.py:267) exists precisely to gate this, and the legacy runner path honors it (`runner.py:1115`). With a graphite insert holding A_throat constant, A_exit and ε drift upward all burn (~mm-scale on exit radius → few-% ε growth → small Isp/thrust drift in Layer-3 impulse comparisons). Config field ignored on the active path.

**F10. `engine/pipeline/time_varying_solver.py:621` — ambient pressure hardcoded to 101,325 Pa for thrust in the coupled solver.**
`Pa = 101325.0 # Ambient`, while the same function computes `P_back` from config elevation for chamber intrinsics (lines 292-298) and `runner.evaluate()` uses elevation-derived ambient. For a launch site at ~1,500 m (P≈84.5 kPa), a small engine with A_exit≈3×10⁻³ m² loses (Pa−P_amb)·A_e ≈ 50 N of reported thrust (~1–3% of F) consistently across Layer 2/3 impulse bookkeeping vs. the flight-sim which uses real atmosphere.

**F11. `engine/pipeline/time_varying_solver.py:519-527` + `graphite_cooling.py:728` — with `sizing_only_mode: true`, cumulative throat recession is not tracked at all, so Layer 3 sees zero recession and drives graphite thickness to the minimum bound.**
The runner legacy path deliberately tracks `recession_rate_calculated` for diagnostics in this mode (`runner.py:1034-1041`); the coupled solver does not (`recession_graphite_new = recession_graphite`). The flag's docstring says "use only for design phase" — but Layer 3 *is* the design phase, so a user following the description gets a 3 mm insert regardless of physics, with `thermal_protection_valid=True` (0 ≥ 1.25×0). All shipped configs set it false; severity limited to that trap.

**F12. `engine/optimizer/layers/layer3_thermal_protection.py:585-637` — binary search couples dimensions through a single joint feasibility bool.**
`evaluate_thickness_feasibility()` returns False if *either* component is under-margin (lines 524-543). While bisecting the ablative dimension, infeasibility caused solely by the graphite estimate pushes `lo = mid` upward, sizing the ablative toward its 25 mm upper bound even when chamber recession is small; the ablative is then never re-shrunk after the graphite dimension is fixed. Also line 632 commits `hi*1.02` even when the upper bound itself was never verified feasible (whole-range-infeasible case silently returns the clipped upper bound; caught only by the final margin check). Impact: oversized liner (up to bound) in the case where the initial graphite estimate is infeasible; wasted evals otherwise.

**F13. `engine/optimizer/layers/layer3_thermal_protection.py:224, 934-936` — Layer 3 permanently mutates the shared config: `use_turbulence_coupling = True` is forced on `optimized_config` (the backend passes `app_state.config` directly, `backend/routers/optimizer.py:1033-1035`).**
After a Layer-3 run, all subsequent evaluations in the session use turbulence coupling even if the user's config disabled it, and `track_geometry_evolution` is likewise forced True (line 928). Non-obvious cross-request state change; also makes Layer-3's "baseline" (computed from Layer-2 results without the flag forced) inconsistent with its candidates — the impulse-preservation penalty (line 350-355) can then penalize a physics-setting difference rather than a thickness effect.

**F14. `ui/flight_sim.py:428-441` — post-truncation propellant-consumption safety re-check covers fuel only; LOX omitted.**
`fuel_consumed = _consumed_mass(mdot_fuel, ...)` guards `m_rp10` and shrinks the burn to a 0.98 fit, but no equivalent check exists for `m_lox0`. If numerical error in the 5,000-sample underfill detection under-truncates on the LOX side, the RocketPy LOX tank can go slightly negative (raising the domain ValueError the code elsewhere works hard to avoid). Also, when propellant is loaded exactly equal to ∫mdot dt (which is precisely what `/optimize-altitude` does, `backend/routers/flight.py:826-841`), this check *always* fires and shaves ~2% off the burn (`scale = 0.98·m/consumed`), plus the underfill margin `max(0.05, 0.01·T)` at line 397-398 — so every optimizer candidate flies ~1–3% less impulse than its loaded propellant implies, biasing `optimal_burn_time_s` slightly long / apogee under-predicted per candidate.

**F15. `ui/flight_sim.py:862-863` — drag coefficient hardcoded to a Mach-independent 0.45 for both power-on and power-off; `rail_length=3.35` also hardcoded (line 965).**
For a rocket transiting transonic (these designs typically reach M&gt;1), Cd varies ~0.3→0.6+; a flat 0.45 gives apogee errors easily 10–20%, and Layer 4 / `/optimize-altitude` size propellant mass against the apogee target *through* this model, so absolute propellant sizing inherits that error. No config field is consulted. (Standard-practice would be RocketPy's power-on/off drag curves or at least a config hook.)

**F16. `engine/core/runner.py:769-773` — coupled-solver results post-processing fabricates `cstar_ideal = cstar_actual / 0.85`, so reported `eta_cstar` is a constant 0.85.**
The coupled solver computes a real per-step `eta_cstar` (`time_varying_solver.py:286`, exposed as results["eta_cstar"]), but the compatibility block overwrites `cstar_ideal`/`eta_cstar` with the fixed-0.85 fabrication in the same results dict consumed by the backend time-series endpoints. Reported combustion efficiency is meaningless; no sizing impact.

**F17. `engine/pipeline/thermal/ablative_geometry.py:99` — char-layer conduction term *added* to the ablation heat load (`q_net = heat_flux − q_reradiation − q_blowing + q_char_resistance`).**
A protective char layer resistance should reduce heat reaching virgin material; here `q_char_resistance` (capped at `heat_flux`, line 87) can up to double q_net. Sign/physics error — but `calculate_local_recession_rate` is imported by runner.py:20 and never called anywhere (verified by grep), so currently dormant.

**F18. `engine/pipeline/time_varying_solver.py:917` — radiative BC key mismatch: `heat_flux_chamber_dict.get("heat_flux_radiative", 0.0)` but the producer returns `"heat_flux_rad"`.**
The chamber multi-layer BC always gets q_rad_hot=0. Currently harmless-in-effect because the consumer (F2) is broken anyway, but it's the second silent key-contract failure in this file (with F1) — evidence the heat-flux dict contract is untested.

## Severity 1

**F19. `engine/optimizer/layers/layer3_thermal_protection.py:106-109, 122` — comments say bounds "3–20 mm" and "3–25 mm" but both are `(0.003, 0.025)`.** Cosmetic.

**F20. `engine/optimizer/layers/layer3_thermal_protection.py:760-780 / 854-865` — L-BFGS-B polish is a guaranteed no-op:** the objective quantizes thickness to 0.05 mm (line 231-235) and caches on the quantized key, so L-BFGS-B's ~1e-8 finite-difference perturbations all return the cached identical value → zero gradient → immediate termination. Wasted stage in both the CMA and DE paths; results unaffected.

**F21. `engine/optimizer/layers/layer4_flight_simulation.py:119-194 vs 202-208` — ~75 lines compute `truncated_burn_time` that is then deliberately not used** (sim called with `target_burn_time`); it survives only as a fallback for the diagnostic `actual_burn_time`, and `avg_thrust` (line 238-239) divides a full-curve impulse by the truncated time, inflating the diagnostic. `last_apogee` (line 100/373) is dead. Diagnostics only.

**F22. `engine/pipeline/thermal/graphite_cooling.py:15-81` vs `ablative_geometry.py:116-223` — two divergent implementations of `calculate_throat_heuristic_multiplier`** (V^0.8·P^0.2·1.1 vs V^1.0·P^0.1·Re-based enhancement); TVS imports one, runner the other. Both clamp to [1.2, 2.5] so numeric divergence is bounded.

**F23. `engine/pipeline/constants.py:156` — comment "1 cm²" on `DEFAULT_THROAT_AREA_M2 = 1e-3` (actually 10 cm²).** Fallback-only constant; cosmetic.

**F24. `engine/pipeline/localized_ablation.py:124` — `impingement_distance = sqrt(x² + R²)` is a meaningless straight-line metric, and the 3.5× Gaussian multiplier (line 110) is pure heuristic.** Feeds only the spatial-stability recession profile; low impact.

---

# Dead / unused thermal code (do not deep-review; candidates for removal)

Backend (FastAPI routers → runner/TVS/chamber_solver), the React frontend, and `main_optimizer.py` are the live entry points. The old Streamlit UI (`ui/design_optimization_view.py`, `engine/optimizer/views/tabs.py`) has **no callers** — grep confirms nothing imports/invokes `design_optimization_view()` — which makes its exclusive dependency chain dead:

| File | Status |
|---|---|
| `engine/pipeline/thermal/ablative_sizing.py` | **Dead.** Only imported by `comprehensive_geometry_sizing.py`, which is only imported by the orphaned `ui/design_optimization_view.py`. |
| `engine/pipeline/thermal/graphite_geometry.py` | **Dead.** Only reachable via `comprehensive_geometry_sizing.py` and `ablative_sizing.py:167` (both dead). Note: `engine/core/chamber_profiles.calculate_graphite_geometry` is a *different*, live function. |
| `engine/pipeline/thermal/graphite_variable_thickness.py` | **Dead.** Only caller is `chamber_geometry_visualizer.py:172`, whose callers are the orphaned Streamlit views (`ui/design_optimization_view.py`, `engine/optimizer/views/tabs.py`, `views/helpers.py`). |
| `engine/pipeline/thermal/regen_cooling.py` | **Live** — but split: `estimate_hot_wall_heat_flux` (TVS + chamber_solver ablative path) and `delta_p_regen_channels` (all injector models, scripts/run_full_pipeline) are hot; `compute_regen_heat_transfer` is reachable only when `regen_cooling.enabled: true`, which is false in every shipped config. |
| `engine/pipeline/thermal/film_cooling.py` | **Reachable but dormant**: called from chamber_solver only when `film_cooling.enabled: true`; false in default.yaml, canonical/impinging.yaml, canonical/pintle.yaml. |
| `engine/pipeline/thermal/ablative_cooling.py` | **Live** (TVS recession + chamber_solver response/profile). |
| `engine/pipeline/thermal/ablative_geometry.py` | **Live**, except three dead functions: `calculate_local_recession_rate` (imported by runner.py:20, never called), `calculate_Lstar_time_varying` (no callers — and broken: line 471 unpacks 4 values from a 5-tuple and passes `coverage_fraction` positionally into the `recession_thickness_throat` slot; would raise if ever called), `estimate_performance_degradation` (no callers). |
| `engine/pipeline/thermal/graphite_cooling.py` | **Live** (TVS + runner legacy fallback). |
| `engine/pipeline/localized_ablation.py` | Partially live: `calculate_impingement_zones` used by TVS stability; `calculate_localized_recession` and `get_impingement_enhancement_factor` have **no callers** (dead). |
| `engine/pipeline/spalding.py` | Live via `combustion_physics.py` (chamber solver combustion path) — outside thermal-protection scope, not reviewed. |
| `engine/pipeline/reaction_chemistry.py` | Live via TVS; targeted skim of `calculate_chamber_reaction_progress` found no unit/order errors (τ_res = L*·c*/(R·Tc) derivation checks out). |
| `engine/pipeline/thermal_analysis.py` | `calculate_steady_state_temperature_profile` live (but broken, F2); `calculate_required_ablative_thickness` reachable only via dead ablative_sizing path; `calculate_pyrolysis_response` / `calculate_vaporization_rate` / `analyze_multi_layer_system` — no live callers. |

Also notable in the "stale duplicate" category: `main_optimizer.py` imports `run_layer3_thermal_protection` (line 44) but runs its own inline, weaker Layer-3 implementation instead (lines ~900-1038); and `run_layer4_flight_simulation`'s best `adjusted_lox_mass`/`adjusted_fuel_mass` are reported but never written back into `optimized_config` by main_optimizer.

**Cross-cutting conclusion for the orchestrator:** the Layer-3 sizing chain is self-consistent in structure (fresh runner + deep-copied config per eval, correct cache keying, end-of-burn cumulative recession with a real 1.25 margin applied once), but its *inputs* are dominated by three heat-transfer defects — ε=0.8 gas radiation (F3), the total-flux Bartz scaling (F4), and the h_g key bug (F1) — which together overestimate chamber/throat heat load by roughly 2–5×, while the intended surface-temperature/backside couplings (F2, F5) are dead code. Thicknesses come out conservative rather than dangerous, but the reported margins, temperatures, and heat fluxes should not be trusted, and the missing soak-through constraint (F7) is the one gap that could pass an unsafe design.</result>
<usage><subagent_tokens>270794</subagent_tokens><tool_uses>51</tool_uses><duration_ms>213442</duration_ms></usage>
</task-notification>


## Appendix F — Flight Sim + COPV + Backend

All files read and verified. Findings below, severity-sorted.

# Findings (verified in code)

## Severity 4

**F1. Time-series summary stats ignore the flameout mask — impulse/propellant totals include phantom post-flameout thrust.**
`backend/routers/timeseries.py:438-466`. In blowdown mode, per-point metrics are correctly zeroed after depletion (lines 127-146), but `summary` (`avg_thrust_kN`, `peak/min`, `total_impulse_kNs`, `total_propellant_kg`, `lox_propellant_kg`, `fuel_propellant_kg`) is computed from the **raw** `results["F"]`/`results["mdot_*"]` arrays, which `evaluate_arrays` produced from post-flameout residual-gas venting pressures as if the engine were still burning. Impact: `total_propellant_kg` can exceed the propellant actually loaded, and total impulse is overcounted by the entire post-flameout tail (10-50% for a run where depletion occurs mid-window). `summary["burn_time_s"]` is also the full window, not the flameout time.

**F2. Z(P,T) lookup silently linearly extrapolates far outside the table; the NaN→default guard is dead code.**
`copv/blowdown_solver.py:147-152` and `copv/copv_solve_both.py:15-16` build `RegularGridInterpolator(..., bounds_error=False, fill_value=None)` — `fill_value=None` means **extrapolate**, never NaN, so the `np.where(np.isnan(...), default_Z, ...)` at `blowdown_solver.py:175` / `copv_solve_both.py:30` never fires, and the comment at `copv_solve_both.py:299` ("interp returns nan if out of range") is false. `n2_Z_lookup.csv` covers only T=90-300 K, **P=0.2-8.3 MPa** — but the COPV solver evaluates Z at COPV pressures (`solve_for_P0_given_VH` searches up to 5e7 Pa and beyond, typical COPV 20-45 MPa). Measured extrapolation error at 300 K: Z_extrap=1.026 @20 MPa (real ≈1.06), 1.049 @31 MPa (real ≈1.13), 1.078 @45 MPa (real ≈1.26) → **3.5-14% error in COPV gas mass `m0` and the whole `PH_trace`/min-margin** returned by `/api/timeseries` COPV analysis and Layer 2. (Propellant-tank lookups at ~250-293 K, 2-6 MPa are inside the table and fine.)

## Severity 3

**F3. Exact-required propellant loads make every `/optimize-altitude` evaluation self-truncate by a quasi-random 0-2%.**
The optimizer loads exactly `∫mdot dt` (`backend/routers/flight.py:827-841`). Then `ui/flight_sim.py`: (a) `detect_tank_underfill_time` (line 366-367, 5000-sample trapz vs the request-grid trapz that computed the load) finds depletion at ≈burn_time roughly half the time and subtracts `margin = max(0.05, 0.01*burn_time)` (lines 397-398); (b) the fuel-only safety pass (lines 429-441) triggers on `fuel_consumed &gt;= m_rp10 - 1e-6` — true by construction for exact loads — and shrinks the burn to 98%. Net: each binary-search evaluation flies a slightly and inconsistently shorter burn than the candidate `burn_time_s`, so apogee(T) is noisy at the 0.05 s search resolution and the converged "optimal" burn time is biased long / reported apogee inconsistent with the reported burn time. Also note the safety pass checks fuel only, never LOX (asymmetric).

**F4. Flight endpoints block the FastAPI event loop for the whole run.**
`backend/routers/flight.py:763-793, 796-913` — `async def simulate_flight` / `optimize_flight_altitude` run RocketPy integration, tank discretization, and matplotlib PNG rendering synchronously (no `run_in_executor`, unlike optimizer.py which does use a thread pool). `/optimize-altitude` runs up to ~26 full flight sims serially; the server is unresponsive to all other requests for the duration (tens of seconds to minutes). Compounding: `generate_rocket_diagram` (`flight.py:713`, matplotlib @150 dpi) is executed for **every** optimizer evaluation and discarded — only the final flight's diagram is ever returned.

**F5. Global mutable `app_state` mutated by background optimizer threads while other requests read it.**
`backend/state.py:29` singleton; `backend/routers/optimizer.py:469, 726, 1092` call `app_state.set_config(...)` from SSE generators whose work runs in a `ThreadPoolExecutor`, and the running Layer-1/2 optimizers mutate the **live** `app_state.config`/`app_state.runner` objects (`optimizer.py:399-400, 660`) while `/api/flight`, `/api/timeseries` (which calls `app_state.runner.evaluate` per time point in blowdown mode, `timeseries.py:893`), and `/api/evaluate` concurrently read them. A config switch or layer completion mid-flight-optimization yields mixed-config results with no error. No locking anywhere.

**F6. Single global `_stop_event` shared by Layers 1/2/3.**
`backend/routers/optimizer.py:115, 336-337, 569-570, 934-935` — starting any layer replaces the global event; running two layers concurrently means the first layer's stop button targets the second's event, and the second run's `finally` sets/clears the event out from under the first. `/layer1/stop` while Layer 2 runs is blocked only by the per-layer `running` flag on the *stop* endpoint, not on event ownership.

## Severity 2

**F7. Pressurant mass is ejected from the vehicle instead of transferred to ullage.**
`ui/flight_sim.py:811-824` — the COPV tank has `liquid_mass_flow_rate_out=mdot_pressurant` (linear ramp, m_pressurant/burn_time) but the propellant tanks have `gas_mass_flow_rate_in=0.0` (lines 772-773, 786-787), so `m_pressurant` (≈0.5-2 kg) leaves the rocket entirely by burnout when physically it stays aboard. Apogee overestimated by order 0.5-2% for a ~110 kg vehicle. The linear-depletion pressurant flow is itself a stated simplification.

**F8. COPV Z evaluated at initial temperature, not the polytropic temperature.**
`copv/copv_solve_both.py:296-301` — `estimate_Z_H` always uses `T0_K` (300 K) while `compute_PH_from_mH` (lines 304-334) models `T_H = T0·(P_H/P0)^((n-1)/n)` (down to ~200-230 K late in blowdown). Z(230 K, 15 MPa) vs Z(300 K, 15 MPa) differ several %, compounding F2 in the late-burn margin check — which is exactly where `min_margin_Pa` is decided.

**F9. Invented gas-venting physics after depletion.**
`copv/blowdown_solver.py:443-473, 521-543` — post-flameout tank pressure decay uses injector area ×10 with a floor of 10 cm² (`max(liquid_area*10, 1e-3)`), justified only by a comment about "relief valves". The post-burnout pressure traces shown to the user are therefore arbitrary. (Contained: masked metrics are zeroed; only P/T traces affected.)

**F10. `copv_solve_both.py` config-volume fallback is broken.**
`copv/copv_solve_both.py:143-149` — after the if/elif/else that sets `copv_volume_m3` (possibly from `volume_m3`), line 149 unconditionally re-executes `copv_volume_m3 = config.press_tank.press_volume`, making the `volume_m3` branch dead and raising `AttributeError` (not the intended `KeyError`) if `press_volume` is absent. Unreachable for current callers (all pass `copv_volume_m3` explicitly) but the documented fallback cannot work. Note `PressTankConfig` (config_schemas.py:728-742) doesn't even define `press_volume`.

**F11. COPV volume silently defaults to 4.5 L.**
`backend/routers/timeseries.py:611` uses `getattr(press_tank, 'free_volume_L', None) or 4.5`; the schema default is also 4.5 L (config_schemas.py:742). Any config that specifies COPV size via geometry (`press_h`/`press_radius`) but not `free_volume_L` gets its COPV sizing computed for a 4.5 L bottle with no warning — `press_h`/`press_radius` are never consulted for volume.

**F12. Silent exception swallowing turns engine failures into "zero flow".**
`backend/routers/timeseries.py:892-901` — blowdown `engine_evaluator` catches *all* exceptions and returns `(0.0, 0.0)`, so a CEA/solver failure freezes tank drain and produces a full-tanks/zero-thrust trace with no error surfaced. Similarly `copv_flight_helpers.py:69-88` replaces a failed COPV solve with a fabricated pressure curve (`P0*1.15`, 30% linear decay) and fabricated `initial_mass_kg=0.5`, `min_margin_psi=50` — fake numbers flow into results with only `success: False` distinguishing them.

**F13. Optimizer response reports uncapped propellant masses.**
`backend/routers/flight.py:874-905` — `optimal_lox_kg/optimal_fuel_kg` are the raw `∫mdot dt` requirements; if tank caps bound (`_apply_propellant_mass_caps` / flight_sim caps), the flight that produced `achieved_apogee_m` flew with less propellant than the response reports, with no cap flag at the optimizer level.

**F14. Detailed-vs-simple mass-model merge is inconsistent.**
`backend/routers/flight.py:355-371` collapses request `engine_mass` + tank structure masses into `propulsion_dry_mass` only; `ui/flight_sim.py:482-484` selects the detailed model iff `config.rocket.engine_mass` exists. So if the *base YAML* has `engine_mass`, the request's engine/tank-structure masses are ignored (YAML values win via the detailed path); if it doesn't, CM detail is lost (simple path, generic 0.3 m offset). Also `rocket_length` is accepted in `RocketConfig` (flight.py:104), sent by the frontend, and dropped by `build_flight_config`; nose position instead uses `avionics_payload_length_m` default 4.0 m — mutually inconsistent with the 3.5 m `rocket_length` default.

**F15. Stale Layer-3 results cross config switches.**
`backend/routers/geometry.py:298-307` reads `_layer3_status["results"]` (module global, never invalidated by `/api/config/upload` or `/switch`) — after switching propellant/injector, the geometry endpoint still overlays optimized ablative/graphite thicknesses from the previous config.

## Severity 1

- **F16.** `ui/flight_sim.py:392-398` — `truncation_info["cutoff_time"]` stores the pre-margin cutoff while the actual burn is `cutoff - max(0.05, 0.01·burn)`; `flight.py:_compute_propellant_diagnostics` then integrates required propellant to the wrong (later) time.
- **F17.** `copv/copv_solve_both.py:161-236` — `dt_full` prepends `dt[0]`, so `Vg[0] = Vg0 + mdot[0]·dt0/ρ`: the ullage trace is shifted one step (slightly conservative gas requirement; negligible at 200 points).
- **F18.** `copv/blowdown_solver.py:280-287` — `m_gas_0` reference is captured lazily inside `step()` *after* the venting decrement, so a tank depleted at t=0 gets a skewed polytropic reference (edge case only; during normal burns m_gas is unchanged until depletion).
- **F19.** `backend/routers/flight.py:401-416` — `_apply_propellant_mass_caps` silently returns no caps when the intermediate config fails validation (flight_sim's own caps still apply, but diagnostics lose cap info).
- **F20.** `flight_altitude_optimizer.py:221` — `apogee_error_m` sign convention flips between success (achieved−target) and infeasible (target−achieved) branches.
- **F21.** `backend/routers/flight.py:872-889` — the optimum flight is simulated a second time after the search already evaluated it (one wasted sim + diagram).
- **F22.** `ui/flight_sim.py:862-863, 965` — Cd hardcoded 0.45 (no config knob, no Mach dependence) and `rail_length=3.35` hardcoded; fine subsonic, drag underestimated approaching transonic. `ui/flight_sim.py:665-668` stray debug `print()`s of masses/functions on every sim.
- **F23.** `backend/routers/flight.py:40-54` — `calculate_tank_capacity` (fill 0.95) is unused and disagrees with `tank_capacity.py` (0.90); delete.
- **F24.** `backend/routers/optimizer.py:681-684` — leftover self-talk comment ("Wait, I need to check the design requirements..."); `timeseries.py:246-257, 417-435` — debug logging left in the hot path.
- **F25.** Burn-time sync fragility: `config_schemas.py:1465-1471` validator overwrites `thrust.burn_time` with `design_requirements.target_burn_time` on every `PintleEngineConfig(**...)` — including the truncated burn time flight.py writes at line 653; only rescued because `copv_flight_helpers.py:124-125` re-sets `config_copy.thrust.burn_time` after validation. Currently net-correct, one refactor away from wrong.

# Verified-OK (checked, not flagged)

`tank_capacity.py` math correct (explicit cap → volume×ρ×fill priority). `calculate_compressible_gas_flow` choked/subsonic formulas correct. Polytropic T ∝ ρ^(n-1) relation correct sign/direction; pressurant mass conserved per tank (pure blowdown, no makeup). `compute_PH_from_mH` algebra (P_H^(1/n) relation) correct. Apogee AGL conversion correct (ASL − elevation). `optimize_minimum_fuel_burn_time` bracketing/convergence logic sound given monotone apogee(T) (holds for exact-load design); failure treated as "too short", feasible-set min-fuel selection is a good safety net. Pydantic `extra='ignore'` makes `FlightSimRequest(**optimize_request.model_dump())` safe.

# Dead-code / artifact list

| File | Status |
|---|---|
| `backend/routers/reproduce_masking.py` | **Not wired into the app** — no `APIRouter`, not in main.py's router list (`config, evaluate, timeseries, flight, geometry, optimizer, control`); runs a simulation at import; hardcoded `sys.path.insert(0, '/home/adnan/EngineDesign')`. Debug artifact — remove from `backend/routers/`. |
| `copv/copv_solve.py` | **Dead** — zero importers anywhere (only a README mention); superseded by `copv_solve_both.py`. |
| `copv/test_blowdown_quick.py` | **Dead/broken** — imports `simulate_blowdown`, which no longer exists in `blowdown_solver.py` (only `simulate_coupled_blowdown`); ImportError on run; hardcoded `/home/adnan` path. |
| `copv/test_blowdown_coupled.py` | Manual dev script, not under `tests/`, hardcoded `/home/adnan` path. |
| `copv/reproduce_blowdown.py` | Debug repro script, hardcoded `/home/adnan` path. |
| `copv/copv_solve_both.py` | **Alive** — used by `backend/routers/timeseries.py`, `engine/optimizer/layers/layer2_pressure.py`, `engine/optimizer/copv_flight_helpers.py`. |
| `copv/blowdown_solver.py` | **Alive** — used by timeseries blowdown mode. |
| `backend/routers/flight.py:calculate_tank_capacity` | Dead function (see F23). |</result>
<usage><subagent_tokens>184959</subagent_tokens><tool_uses>30</tool_uses><duration_ms>717337</duration_ms></usage>
</task-notification>


## Appendix G — Combustion Stability + DDP Controller

I now have comprehensive coverage of both subsystems. Compiling the final findings.

## FINDINGS (severity-sorted)

### Severity 5

1. **`engine/control/robust_ddp/ddp_solver.py:544` + `engine_wrapper.py:74-98` — Thrust-tracking gradient is identically zero in the online DDP path.** `cost_derivatives` perturbs pressure states by `eps=1e-6` Pa and re-calls `engine_wrapper.estimate_from_pressures`, but the wrapper's cache key rounds pressures to 3 decimal places (`round(P, 3)`, i.e. millipascal) — a 1e-6 Pa perturbation maps to the same key and returns the cached, unperturbed estimate, so `lx` for `P_u_F`/`P_u_O` contains no thrust/MR tracking term (exactly 0, not noise). Since `lu` only contains the gas-consumption term and thrust enters the value recursion solely via `lx`, the whole backward pass is blind to thrust error. Even cache-off, eps=1e-6 on ~7e6 Pa states (relative 1e-13) is below solver noise. Net effect: online DDP optimizes gas consumption + pressure-box penalties only; closed-loop thrust response is actually delivered by the hard-coded heuristic at `controller.py:253-258` ("if F deficit &gt; 500 N and u&lt;0.3, add 0.2"). Impact: the controller is effectively a bang-bang heuristic, not a trajectory optimizer.

2. **`engine/control/robust_ddp/dynamics.py:164-173` (+447, 652, 703) — Hidden module-global state via function attributes.** `step._T_copv_0`, `step._m_copv_0`, `step._V_F_0`, etc. are initialized on the *first-ever* call in the process and never reset (not by `RobustDDPController.reset()`, not per rollout, not per request in the long-running FastAPI backend). All polytropic temperatures are computed relative to whatever state the first call (which may be a safety-filter tube probe or a different simulation run) happened to see. Consequences: cross-request contamination between simulations with different tanks/pressures, non-reentrancy, and DDP linearization (`linearize`) differentiating around a stale reference. Temperature clamp [200,400] K bounds the error to roughly ±30% on ullage/COPV pressure predictions.

### Severity 4

3. **`engine/pipeline/stability/analysis.py:329-348` — Chug gate margin certifies Nyquist-unstable designs.** `_chug_gate_margin = 1 + 0.3·tanh((GM−0.80)/0.20)` with the Layer-1 requirement `min_stability_margin = 1.2` (`layer1_static_optimization.py:67`): gate margin 1.2 corresponds to gain margin **0.96 &lt; 1**, i.e. an unstable loop meets the 1.2 "margin" requirement; GM≈0.83 already yields 1.05. The tanh saturates at 1.3, so a GM=2 design shows barely more margin than GM=1. `stability_state` still requires the raw `stable` flag for "stable", but "marginal" (allowed by the gate, `allowed_states={'stable','marginal'}`) is reached for GM≥~0.8. Optimizer accepts designs with negative gain margin while reporting margin ≥ 1.2.

4. **`engine/pipeline/stability/analysis.py:704-727` — Failed stability analysis silently passes.** `compute_physical_stability` exceptions are swallowed (`except Exception: phys = None`), and the fallback assigns `acoustic_margin = 1.10` and `chug_margin = chugging["stability_margin"]`, which by construction is ≥ 1.0 (`stability_index` floored at 0.4 → margin = 0.4·1.5+0.4 = 1.0, lines 141-148). `_chug_gate_margin(NaN)` and `_acoustic_gate_margin(NaN)` also return 1.10 ("neutral-pass"). So any crash or NaN in the physical model produces at worst "marginal" with near-passing margins — a broken analysis can never fail a design.

5. **`engine/pipeline/stability/core.py:55-66` (duplicated at `analysis.py:199-203` and native `ed_stability_modes.c:133`) — Longitudinal mode frequencies use the quarter-wave set.** `f_nL = (2n−1)·a/(4L)`. For a combustion chamber with a ~rigid injector face and a choked, compact convergent nozzle (as the docstring itself states: "injector face ~closed... choked throat ~closed"), the standard estimate is the half-wave closed–closed set `f_nL = n·a/(2L)` (Harrje &amp; Reardon / SP-194). The 1L frequency is a factor of 2 low and higher modes have the wrong (odd-harmonic) spacing; this shifts every `sin(ω·τ_sens)` driving evaluation, the damping budget, and the mode-coupling checks. The docstring's "true eigenvalue lies between quarter- and half-wave" is only true for a substantially open nozzle end.

6. **`engine/control/robust_ddp/ddp_solver.py:474-478, 483-485` — Gains scaled ×2 after solving, corrupting the Bellman recursion; line search scales du another ×2 with α up to 10.** `k_k`, `K_k` are multiplied by 2.0 *after* `−Quu⁻¹Qu`, then the Vx/Vxx updates (lines 484-485) use those scaled gains — the value recursion is no longer the minimizing-policy recursion, so downstream Q-functions are wrong every backward step. `forward_line_search` (lines 679-699) additionally starts α at 5-10 and scales `du` by another 2×: effective feedforward steps of 20-40× the Newton step, saved only by the [0,1] clip. Combined with acceptance of up-to-1%-worse costs (`solve_ddp:169`) and random perturbation injection (`:179`, non-deterministic controller), convergence properties of DDP are destroyed.

7. **`engine/control/robust_ddp/ddp_solver.py:349-355` — Constraint penalty gradient vanishes for any violation &gt; 1 unit.** `violation_normalized = violation / max(abs(violation), 1.0)` saturates at exactly 1.0, so a 10 Pa and a 10⁶ Pa over-pressure both cost the same constant 1e4 — zero gradient, no incentive to shrink large violations, and a non-differentiable cliff at violation=0. Since pressure-type violations are in Pa, essentially all real violations are in the saturated regime.

8. **`engine/control/robust_ddp/dynamics.py:480-497` — Non-physical "hardware-matching" oscillation injected into the regulator state.** `P_reg_next = setpoint + 0.06·setpoint·u_total·sin(2π(u_F+u_O))` — a memoryless function of the instantaneous control, not a time-domain oscillation. It creates a large spurious ∂P_reg/∂u (~±6% of 6.9 MPa ≈ ±0.4 MPa swinging with period Δu≈1) that the DDP Jacobians (finite-differenced at `linearize`) see as real actuation authority. Pure cosmetic hack contaminating the plant model.

9. **`engine/control/robust_ddp/controller.py:449-451` — Internal ullage volume never updates on the hardware path.** `_update_state` sets `self.V_u_F = x[IDX_V_U_F]`, but `x` is the state built at the *start* of the step from `self.V_u_F` itself — a no-op. Via the `/api/control/step` endpoint (hardware-in-the-loop), ullage volumes stay at their initial 0.01 m³ forever, so gas-mass initialization (`_build_state:389-390`) and all rollout blowdown predictions are wrong for the whole burn. (The `/simulate` route papers over this by writing `_controller.V_u_F` from outside, `backend/routers/control.py:575-576`.)

10. **`backend/routers/control.py:228,366,635,...` + `config_loader.py:16-62` — Controller config is hardcoded LOX/RP-1 and never derived from the loaded engine config.** All endpoints use `get_default_config()`: `rho_F=800` (RP-1) while the current default engine config is LOX/**methane** (`configs/default.yaml`: fuel density 422.6 kg/m³, `design_MR: 2.55`); MR band hardcoded 1.5-3.0 with `MR_ref` forced to mid-band 2.25 (`reference.py:138-139`); `reg_setpoint` 1000 psi vs config tank pressures ~3.6 MPa. Effects: fuel ullage growth underestimated 1.9× in the dynamics, controller regulates MR toward 2.25 instead of the design 2.55, and constraint boxes don't track the engine. The robust_ddp package predates the propellant-switching rework and silently assumes the old propellant set — confirmed.

### Severity 3

11. **`engine/control/robust_ddp/dynamics.py:550-577` — Propellant mass flow double pressure-scaled and discontinuous at u=0.** `mdot_F/O` already come from the engine solver as functions of tank pressure, then are re-multiplied by `sqrt(P_u/5e6)` (arbitrary hardcoded 5 MPa reference, clamped [0.1,2]) and by a further **1.5× "blowdown factor" only when both valves are closed** — a 50% step discontinuity in the dynamics at `u_total=0` (exactly where clamped DDP solutions sit), non-physical (closing a pressurant valve cannot raise propellant flow), and inconsistent with the thrust the engine wrapper reports (unscaled mdot). Ullage growth and blowdown-rate predictions are off by up to 2-3× and the FD Jacobians are garbage at the switching surface.

12. **`engine/pipeline/stability/analysis.py:446` — Chug feed-line length hardcoded to 0.305 m.** `feed_len = 0.305` regardless of the actual system (the schema has no length field to read, but the value is not routed through the assumptions registry either). Feed inertance `I = L/A` scales linearly with length; a 1 m line gives 3.3× higher inertance, materially shifting the chug crossover frequency and gain margin computed by `chug_margin_fast`.

13. **`engine/pipeline/stability/acoustic.py` + `analysis.py:376-377` — Acoustic instability is structurally unpredictable with default parameters (gate is vacuous).** Driving and nozzle damping both scale as π·f·(γ−1): normalized drive = ov·n·sin(ωτ) ≤ 0.7·0.5 = 0.35 of (γ−1), i.e. drive/(πf) ≤ 0.07 for the best case (1L, sin=1, γ=1.2, n=0.5), while damping/(πf) ≥ (γ−1)·M + injector_frac + twophase_frac = 0.04+0.02+0.03 = 0.09 (+viscous). So `alpha_max &lt; 0` for *every* geometry with defaults (`n=0.5`, `M=0.2` hardcoded at `analysis.py:461`, default overlaps) — `any_unstable` can never be True; the acoustic screen can't flag the phenomenon it exists for. Even the documented n sweep (0.3-0.6) never crosses.

14. **`engine/control/robust_ddp/constraints.py:178,189` — Injector-stiffness constraint uses `eps_i` (=1e-3, documented as "constraint violation tolerance") instead of `injector_dp_frac` (=0.1).** `required_dp = cfg.eps_i * P_ch` demands only 0.1% injector Δp, 100× weaker than intended; meanwhile the safety filter checks `cfg.injector_dp_frac * P_ch` (10%, `safety_filter.py:204-206`). The DDP optimizes against a phantom constraint and the safety filter then vetoes it — chattering between DDP proposals and discrete fallback candidates.

15. **`engine/control/robust_ddp/safety_filter.py:179` — Tube check tests the wrong bound for the COPV minimum constraint.** `if x_hi[0] &lt; cfg.P_copv_min` — the worst case for a *minimum* constraint is the lower bound `x_lo`; using `x_hi` only flags violation when even the best case violates. The "robust" tube check is anti-robust for exactly the constraint it propagates the tube for. MR/injector checks (lines 193-206) similarly evaluate only the `(x_hi_F, x_hi_O)` corner; MR worst case lives at mixed corners.

16. **`engine/control/robust_ddp/actuation.py:300-305` — Dwell-time enforcement is defeated by storing the requested, not applied, control.** `update_state_dwell_timers` writes `cmd.u_F_quantized` (pre-dwell request) into `state.u_prev`; next tick `enforce_dwell` compares the new request against the *stored request*, sees "unchanged", and passes it through. A blocked transition is therefore delayed by exactly one tick (10 ms) instead of `dwell_time` (50 ms) — the valve-protection feature does ~nothing.

17. **`engine/control/robust_ddp/ddp_solver.py:576-584,618-630` — Control-gradient/Hessian FD is one-sided-clipped at bounds.** At u=1 (or 0), `u_pert = clip(u±eps)` equals u, so `lu=0` and `luu=0` exactly where the solution rides the bound; `Quu` then reduces to the regularization term and `k = −Qu/reg` explodes (masked by the [0,1] clip). Also `lxx` second differences of 1e4-scale kinked penalties over eps²=1e-12 are numerically meaningless near constraint boundaries.

18. **`engine/control/robust_ddp/engine_lut_wrapper.py:117-123` — NaN grid corners silently dilute LUT interpolation toward 0.** Corners with non-finite values are skipped without renormalizing the remaining weights, so near a NaN region interpolated F/mdot/P_ch shrink smoothly toward 0 instead of propagating NaN or renormalizing — the controller sees fictitious low thrust rather than "infeasible", corrupting both gradients and the safety filter near the feasibility boundary.

### Severity 2

19. **`engine/pipeline/stability/analysis.py:585-599` — Feed-system geometry lookup uses dead key `"lox"` and nonexistent field `"length"`.** The schema keys are `"oxidizer"`/`"fuel"` (`config_schemas.py:1381`) and `FeedSystemConfig` has no `length` field, so `feed_length=1.0`, `feed_diameter=0.01` defaults are *always* used for the pogo/surge/water-hammer block; config `d_inlet` (0.01347) is ignored (velocity ~1.8× high → water-hammer spike ~1.8× overestimated; conservative but wrong, and the exact bug class the P2c comment at line 607 claims was fixed one lookup above).

20. **`engine/pipeline/stability/chug.py:155-184` — Fast gain margin only detects the −180° crossing; fallback can declare false instability.** Crossings at −180°−360k° are not searched (usually benign since |L| decays ~1/ω², but not guaranteed), and when no crossing exists in-band with `mag.max() ≥ 1`, `gm_best = 1/mag.max() &lt; 1` declares "unstable" even though L never encircles −1. Same logic mirrored in the native `ed_stability_modes.c` (production path: `ED_USE_NATIVE=1` default in `backend/main.py:28`).

21. **`engine/control/robust_ddp/dynamics.py:232-239` — Regulator/valve orifice areas and Cd hardcoded** (2e-5/5e-5 m², 0.7/0.65), duplicating `copv/blowdown_solver.py` choked-flow physics with untraceable constants; config knobs `alpha_F/alpha_O` are silently unused, and `tau_line_F/O` are silently doubled (`:743-744`). Also the choked branch at `:279` uses constant `params.T_gas` while the subsonic branch uses polytropic `T_copv`.

22. **`engine/control/robust_ddp/ddp_solver.py:329-334` vs dynamics — Two divergent COPV consumption models**: cost uses the linear `copv_cF·u` (Pa/s) model, dynamics uses choked mass flow; `qSwitch` config weight is never implemented (`:336-339`).

23. **`engine/control/robust_ddp/robustness.py:120-124` — w_bar dict view only covers 8 of 11 states** (gas masses dropped); harmless while `w_bar_array` is used, but the serialized/logged view is incomplete.

24. **`engine/pipeline/stability/report.py:91` — Feed setpoint viz omits injector Δp** (`P_set = Pc + dP_feed`, should include `dP_inj`; display-only, ~30% Pc low).

25. **`engine/control/robust_ddp/policy_lut.py:29,92-94` — `fill_value=None` enables linear extrapolation**; safe under default `bounds_mode="clip"`, but the alternative documented mode `"nearest"` performs unbounded linear extrapolation, not nearest (then NaN→0.1 fallback).

### Severity 1
26. `dynamics.py:601-606, 674-682, 720-726` — dead "force ullage growth"/"ensure pressure drops" blocks that recompute identical expressions or `pass`. `safety_filter.py:320` `pwm_values` unused. `ddp_solver.py:732-734` comment contradicts behavior (returns original sequence when no improvement). `solve_ddp` raises NameError if `max_iterations=0` (latent).

## DEAD / UNUSED CODE (from active entry points)

- **`engine/control/robust_ddp/copv_calculator.py`** — no importers anywhere (not even the package `__init__`). Fully dead. (Its `calculate_from_regulator_specs` also hardcodes 3/3.5 MPa tank pressures and a fudged 0.01 Cv conversion.)
- **`engine/control/robust_ddp/identify.py`** — imported only by the package `__init__` for re-export; zero callers in backend/scripts/engine. Dead.
- **`engine/control/robust_ddp/logging.py` (`ControllerLogger`)** — imported by `backend/routers/control.py` but the only instantiation is commented out (line 239); controller always gets `logger=None`. Dead in the active path.
- **`engine/control/robust_ddp/policy_lut.py` / `engine_lut_wrapper.py`** — latent, gated behind `use_policy_lut=false` / `engine_lut_path=null` defaults (both off in `configs/robust_ddp_default.yaml` and `get_default_config()`); only builder is offline `scripts/build_policy_lut.py`.
- **`engine_wrapper.py:63-72`** — `_create_cached_evaluator`/`_cached_evaluate` construct an lru_cache that raises if ever called; dead scaffolding. `reference.py:425-444` `_measurement_to_state` returns zeros (placeholder consumed by a function that ignores it).
- **`engine/pipeline/stability/enhanced.py`** — *not* dead but vestigial: reachable only through `TimeVaryingCoupledSolver` (`time_varying_solver.py:731`, active when ablative geometry tracking is enabled, used from `runner.py:762`/`iterative_sizing.py`). For the current default **impinging** injector configs it takes the non-pintle early-return (`enhanced.py:194-204`) and emits constant placeholders (margin 0.5, 30 Hz, growth −10/s); per the F3 note its scalar outputs are overwritten by `comprehensive_stability_analysis`, but the spatial/feed placeholder values are retained in results. The pintle branch itself is a stack of invented coefficients (e.g., `base_damping=-50`, `×0.3`/`×0.5` effect weights, energy-balance with inconsistent units at lines 327-343) — pre-rewrite heuristic code that survived the stability rebuild.
- Legacy heuristics `analysis.calculate_chugging_frequency` (index floor 0.4, margin floor 1.0) and `analyze_feed_system_stability`'s margin remapping (any water-hammer margin ≥ 0.05 → 1.20 "pass", lines 292-307) are live only as fallback/report fields but are the neutral-pass surface described in finding #4.

**Cross-cutting notes:** chamber gas properties (γ, R, Tc) do come from the CEA-backed solver (`runner.py:484-494`) — sound speed source is fine; the chug characteristic equation, sign conventions, injector conductance `mdot/(2ηPc)`, inertance `L/A` (mass-flow convention), chamber gain `c*/A_t`, residence time `L*/(Γ²c*)`, and transverse eigenvalues (J′ roots, `1.841·a/(π·D)` for 1T) are all correct. The native C fast path (`ED_USE_NATIVE=1` by default in the backend) is a faithful port and shares findings #5 and #20.</result>
<usage><subagent_tokens>214406</subagent_tokens><tool_uses>46</tool_uses><duration_ms>748803</duration_ms></usage>
</task-notification>
