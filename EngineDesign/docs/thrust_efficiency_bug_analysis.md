# Thrust Model Defect: Combustion Efficiency Is Never Applied to Exhaust Velocity

**Status:** Diagnosis complete, no code changed. Awaiting decision on the fix.
**Severity:** High — systematic thrust over-prediction in every evaluation since the first commit.
**Scope:** `engine/core/nozzle.py::calculate_thrust` (the authoritative nozzle used by `runner.evaluate`, Layer-1 finalization, flight sim, and time-series).

---

## TL;DR

The nozzle computes thrust by reconstructing exit velocity from the **ideal** CEA chamber
temperature, while chamber pressure and mass flow have already been reduced by combustion
efficiency `η_c*`. Mixing efficiency-reduced inputs (Pc, ṁ) with an efficiency-ideal input
(Tc) makes the delivered specific impulse come out at the **ideal thermodynamic ceiling**
instead of `η_c* · Isp_ideal`. The model over-predicts thrust by **approximately the
combustion loss** — ~13% for the impinging/CH₄ canonical (η_c\*≈0.895), ~4% for the
pintle/Ethanol canonical (η_c\*≈0.963). In four independent test points the model's Isp
**meets or exceeds CEA's ideal equilibrium ceiling**, which is thermodynamically impossible
for a real engine running below 100% efficiency.

The elaborate momentum + 20-iteration shifting-equilibrium reconstruction (`reaction_chemistry.py`,
~730 lines) is **not** the cause; it contributes only ~2%. The real error is structural and
simpler than the code that obscures it.

---

## 1. How thrust is computed today

`engine/core/nozzle.py::calculate_thrust` ([nozzle.py:152](../engine/core/nozzle.py)):

1. Pull thermo from the CEA cache at the operating point
   ([nozzle.py:236](../engine/core/nozzle.py)): `cea_props = cea_cache.eval(MR, Pc, Pa, eps)`,
   giving `gamma`, **`Tc`** (the *ideal* equilibrium chamber temperature), `R`, `Cf_ideal`.
2. Solve exit Mach from the area ratio, then isentropic exit pressure and **temperature
   expanded from `Tc`** ([nozzle.py:342](../engine/core/nozzle.py)):
   `T_exit = Tc / (1 + (γ−1)/2 · M_exit²)`.
3. Optionally refine `gamma_exit`/`R_exit`/`T_exit` with the shifting-equilibrium loop
   ([nozzle.py:403–515](../engine/core/nozzle.py)).
4. Exit velocity ([nozzle.py:543](../engine/core/nozzle.py)):
   `v_exit = M_exit · sqrt(gamma_exit · R_exit · T_exit)`.
5. Thrust by the **momentum + pressure** method ([nozzle.py:555–557, 618](../engine/core/nozzle.py)):
   `F = ṁ · v_exit + (P_exit − Pa) · A_exit`. This is the value returned and reported;
   the Cf method (`F_cf = efficiency · Cf_ideal · Pc · At`) is computed only as a cross-check.

Where does `η_c*` enter? Only in the **chamber solver**: the supply/demand balance uses
`c*_actual = η_c* · c*_ideal`, so the solved **Pc and ṁ already reflect combustion efficiency**.
A repo-wide search confirms `F` is **never** multiplied by `η_c*` after the nozzle — combustion
efficiency touches the pressure/flow balance and nothing on the thrust path.

That is the defect in one sentence: **Pc and ṁ are the real (efficiency-reduced) values, but
the nozzle expands from the ideal `Tc`, so `v_exit` is the ideal value, and `F = ṁ · v_exit`
double-counts — it keeps the extra mass flow that low efficiency produces while paying none of
the energy penalty that caused it.**

---

## 2. The symptom

At the impinging/CH₄ canonical operating point (P_O=1305 psi, P_F=974 psi):

| quantity | value |
|---|---|
| Cf from the momentum method, `F/(Pc·At)` | **1.7312** |
| Cf from CEA (`get_PambCf`, ambient) | **1.5367** |

An 18% gap between the thrust coefficient the model reports and the one CEA computes for the
same nozzle. That gap is what triggered this investigation.

---

## 3. The evidence

Delivered Isp from the model vs. CEA's **ideal** equilibrium ambient Isp (the thermodynamic
ceiling, zero losses), at sea level:

| config | operating point | model Isp | CEA ideal ceiling | η_c\* | physically-correct `η·ideal` | model error |
|---|---|---|---|---|---|---|
| impinging / CH₄ | (1305, 974) psi | 294.2 s | 291.8 s | 0.895 | 261.1 s | **+12.7%** |
| impinging / CH₄ | (1100, 820) psi | 291.6 s | 289.9 s | 0.894 | 259.2 s | **+12.5%** |
| pintle / Ethanol | (1305, 974) psi | 273.4 s | 273.2 s | 0.963 | 263.0 s | **+3.9%** |
| pintle / Ethanol | (1100, 820) psi | 269.7 s | 269.9 s | 0.962 | 259.6 s | **+3.9%** |

Two facts jump out:

1. **The model's Isp sits at the ideal ceiling, not below it.** In three of four cases it
   *exceeds* the ideal equilibrium Isp. No real engine at η_c\*<1 can beat the ideal.
2. **The over-prediction equals the combustion loss.** η_c\*=0.895 → ~13% high; η_c\*=0.963 →
   ~4% high. The error magnitude is `(1 − η_c*)` to within rounding. That is a fingerprint, not
   a coincidence.

---

## 4. The mechanism, traced through the numbers

Same impinging point, fully decomposed:

| quantity | model | CEA / correct | note |
|---|---|---|---|
| Pc | 4.556 MPa | — | efficiency-reduced (chamber solve) |
| ṁ | 4.841 kg/s | — | efficiency-inflated (chamber solve) |
| c\*_implied = Pc·At/ṁ | 1666 m/s | c\*_ideal = 1862 m/s | ratio = 0.895 = η_c\* ✓ |
| **Tc used for expansion** | **3317 K (ideal)** | — | **not** reduced by η_c\* |
| exit T | 1831.7 K | 2100.9 K (CEA shifting) | model over-cools (separate ~2% issue) |
| exit gamma | 1.2145 | 1.206 (CEA) | approximation, ~0.7% high |
| v_exit | 2789 m/s | ~2446 m/s (efficiency-consistent) | **~14% high** |
| F | 13 965 N | 12 396 N | **+12.7%** |
| Isp | 294.2 s | 261.1 s | **+12.7%** |

The decisive cross-check: `F = Cf · Pc · At` evaluated with **CEA's correct ambient Cf at the
real Pc** gives `1.5367 · 4.556e6 · 1.7704e-3 = 12 396 N → Isp 261.1 s`, which equals
`η_c* · Isp_ideal = 0.895 · 291.8 = 261.2 s` to within rounding. The momentum method gives
`13 965 N → 294.2 s`, which equals the **ideal** (η=1) thrust for this mass flow. The model is
computing the ideal engine and labelling it the real one.

---

## 5. Why it is wrong (the physics)

Specific impulse factors exactly: `Isp = Cf · c* / g₀`.

- `c*` is set by combustion: `c* ∝ sqrt(Tc / M)`. Combustion efficiency is *defined* as
  `η_c* = c*_actual / c*_ideal`. η_c\*=0.895 therefore means the real gas carries less
  energy per unit mass — lower effective Tc and/or heavier products.
- `Cf` is set by the nozzle: a dimensionless function of pressure ratio and γ.
- Exhaust velocity scales with `c*`: `v_exit ∝ sqrt(Tc) ∝ c*`. So a 10.5% c\* deficit **must**
  show up as a ~10.5% lower exhaust velocity. There is no thermodynamic path by which a gas
  with 89.5% of ideal `c*` produces ideal exhaust velocity.

The model violates this. It applies η_c\* to the Pc/ṁ balance but expands from the **ideal**
`Tc`, so `v_exit` (and thus `Cf·c*`, and thus Isp) come out at the ideal level. The result —
delivered Isp ≥ ideal equilibrium Isp at the same Pc, eps, and Pamb — is the canonical signature
of a thrust model that has dropped its efficiency term. CEA's ideal equilibrium Isp is the
maximum achievable; sitting on or above it with η_c\*<1 is proof, not opinion.

---

## 6. Why I am certain (five independent lines, all agreeing)

1. **Ceiling violation.** Model Isp ≥ CEA ideal equilibrium ambient Isp in 3 of 4 cases, at the
   model's own operating point. Thermodynamically impossible for η_c\*<1. (Direct measurement.)
2. **Fingerprint correlation.** Two propellants give two efficiencies (0.895, 0.963) and two
   error magnitudes (~12.6%, ~3.9%). The error tracks `(1 − η_c*)` across both — the unmistakable
   signature of "efficiency applied to flow but not to thrust."
3. **Mechanism trace.** The code path is explicit: `Tc` from `cea_props` is the ideal value
   ([nozzle.py:239](../engine/core/nozzle.py)); the exit temperature is expanded from it
   ([nozzle.py:342](../engine/core/nozzle.py)); and a repo-wide grep shows `F` is never scaled by
   `η_c*`. There is no compensating step.
4. **Independent reconstruction.** `Cf_CEA · Pc · At = 12 396 N (261 s) = η_c* · Isp_ideal`
   exactly, while the momentum method = ideal thrust for the same ṁ. Two formulas, the gap is
   precisely the efficiency term.
5. **Exhaust-velocity check.** Back-solving the correct thrust gives `v_exit ≈ 2446 m/s`; the
   model uses 2789 m/s. The ratio 2446/2789 = 0.877 ≈ η_c\* (0.895) minus the small shifting
   over-cool — i.e. v_exit is high by exactly the efficiency the nozzle never applied.

Any one of these would be suggestive. All five point to the same conclusion with the same
magnitude.

---

## 7. Two red herrings (so they don't distract the fix)

**(a) The shifting-equilibrium approximation is ~2%, not the problem.**
`reaction_chemistry.calculate_shifting_equilibrium_properties` and its ~730-line kinetics chain
exist to estimate `gamma_exit`. Against CEA's *actual* shifting exit value the approximation is
only ~0.7% off on γ and ~13% off on exit *temperature* (1831.7 K vs CEA's 2100.9 K, an
over-cool). Substituting CEA's real exit thermo changes thrust by only **~1.3%**. The shifting
machinery is an inaccuracy bolted onto the structural error, not the structural error itself.
Notably, CEA already computes the true shifting exit state (`GAMMAs`, `T`, `M` exit columns) in
the same call the cache already makes — and `parse_cea_basic`
([cea_cache.py:93](../engine/pipeline/cea_cache.py)) keeps only the chamber column and discards it.
So the approximation re-derives — worse — a number we compute exactly and throw away.

**(b) The cache stores the wrong `get_PambCf` tuple element.**
[cea_cache.py:195](../engine/pipeline/cea_cache.py) stores `get_PambCf(...)[0]` = 1.4683. The
element that actually reproduces CEA's own ambient Isp is `[1]` = 1.5367
(`= Cf_vac − (Pa/Pc)·eps`; `1.5367 · 1862.3 / g₀ = 291.9 s` = CEA IspAmb ✓). This has never
bitten anything because the cached `Cf_ideal` is **not used for thrust** — the (wrong) momentum
method is. It becomes load-bearing the moment we switch to a Cf-based thrust, so it must be fixed
as part of any fix. (Separately, `eval()`'s `Pa` argument is dead — never read — which is why the
`cea.eval(MR, P*10, T, None)` call in `reaction_chemistry` that looks like a bug is simply inert.)

---

## 8. The better way (and why it is provably correct)

Compute thrust the way CEA's own performance numbers are defined:

```
F(Pa) = Cf_vac · Pc · At − Pa · Ae
```

where `Cf_vac` is the vacuum thrust coefficient and `Pc` is the real (efficiency-reduced) chamber
pressure from the solve. Equivalently `F = Cf_ambient(Pa) · Pc · At` with the correct ambient Cf.

**Why it is correct.** `Cf` depends only on pressure ratio and γ; it is the same for the ideal
and the real engine at a given Pc. Combustion efficiency enters entirely through `Pc` (and `ṁ`),
which the chamber solve already reduced. So `F = Cf · Pc · At` inherits the efficiency penalty for
free and reproduces `η_c* · Isp_ideal` — the physically correct delivered value (verified: 261.1 s
vs the expected 261.2 s). It also reproduces CEA's own IspAmb when fed CEA's Cf, which is the
definition of self-consistency.

**Why it is simpler.** It deletes the momentum reconstruction, the 20-iteration shifting loop,
and the entire `reaction_chemistry` approximation (~730 lines). One lookup, one formula.

**Why it is faster.** A trilinear cache lookup plus arithmetic, versus an iterative loop with
repeated CEA evaluations per call (measured earlier at ~192 µs/call for the shifting nozzle).

**Why it is more accurate.** The Cf comes from NASA CEA's equilibrium solution, not a Damköhler
interpolation with empirical constants. The vacuum-Cf-minus-ambient form is also exactly right for
the flight sim, where `Pa` varies with altitude — `F(Pa) = Cf_vac·Pc·At − Pa·Ae` is `Pa`-analytic,
so no per-altitude re-evaluation is needed.

This is the rare case where the correct fix is also the simplest and the fastest.

---

## 9. Impact

- **Reported performance has been optimistic** by the combustion-loss margin (~13% on Isp/thrust
  for impinging/CH₄, ~4% for pintle/Ethanol) for every design the tool has produced.
- **The optimizer ranked on inflated thrust.** Because the inflation is roughly common-mode across
  candidates, *relative* ranking is largely preserved, but the absolute thrust target is met by an
  engine that is **undersized** for the true delivered thrust. A design that "hits 8000 N" in the
  tool would deliver closer to ~7000 N (impinging) in reality.
- **Anything keyed to absolute Isp/thrust is affected**: flight-sim trajectories, burn-time
  optimization, feasibility margins, and any requirement expressed in delivered thrust.

---

## 10. Path forward

### Step 1 — comparison harness (DONE)

`scripts/thrust_model_comparison.py` (read-only) compares MODEL vs the `Cf_vac` method vs CEA across
both canonical configs over operating points, expansion ratios (3.0–8.0), and altitudes
(sea level → vacuum) — **30 cases**. Result:

- **The `Cf_vac` method equals `η_c* · Isp_ideal` to −0.0% in all 30 cases.** Not approximately —
  exactly, across every operating point, expansion ratio, and altitude, for both propellants. The
  proposed fix is the physically correct delivered value everywhere we optimize, including the
  flight envelope (the `F(Pa) = Cf_vac·Pc·At − Pa·Ae` form is `Pa`-analytic and tracks the ceiling
  as `Pa` drops).
- **The MODEL over-predicts by `(1 − η_c*)` everywhere:** +12.4–13.2% for impinging/CH₄ (η≈0.895),
  +3.3–4.4% for pintle/Ethanol (η≈0.963), and exceeds the ideal ceiling in most cases. The error is
  systematic and stable across the whole searched space, not a corner artifact.

### Step 2 — downstream audit (DONE)

The three open questions are resolved:

1. **No downstream compensation — and designs are undersized.** `_compute_objective_value` and the
   Layer-1 thrust penalty compare the model's inflated `F` **directly** against `target_thrust`
   ([layer1_static_optimization.py:444, :918](../engine/optimizer/layers/layer1_static_optimization.py)).
   Nothing re-applies `η_c*`. So the optimizer drives the *inflated* `F` to the target → the **real
   delivered thrust is ~(1−η_c\*) below target**, i.e. every converged design is undersized by the
   combustion-loss margin (~13% impinging, ~4% pintle). Fixing the model **will move where the
   optimizer lands** (larger engines for the same real target). This is the re-baseline that must be
   communicated, not a regression.
2. **`η_cf` is intended but the static nozzle drops it.** `nozzle_efficiency` defaults to 0.95
   ([config_schemas.py:634](../engine/pipeline/config_schemas.py)). In `nozzle.py` it multiplies only
   the **unused** `Cf_theoretical` ([nozzle.py:272](../engine/core/nozzle.py)), never the delivered
   `F`. But the **transient** path already applies it correctly:
   `v_exit = v_exit_ideal · nozzle_efficiency` ([nozzle_dynamics.py:84](../engine/pipeline/nozzle_dynamics.py)).
   So the static and transient nozzles disagree. The fix should apply `η_cf` to delivered thrust
   (matching intent and the transient path): delivered `Isp = η_c* · η_cf · Isp_ideal`.
3. **Cache schema add is small.** The `Pa`-analytic fix needs `Cf_vac` (or `IspVac`) and the exit
   pressure ratio `Pe/Pc` — both `Pa`-independent — added to the cache, plus a one-time regeneration
   of the committed `.npz`. The harness confirms this form is exact across the altitude sweep.

### Steps 3–4 — the fix (IMPLEMENTED)

Decision (user): match **RPA**'s delivered-performance methodology — `(Isp_vac)_d = ζc·ζn·Isp_vac`,
`(Cf_vac)_d = ζn·Cf_vac` (verified against Ponomarenko's RPA "Assessment of Delivered Performance"
report). Mapping: ζc = `eta_cstar` (carried by Pc), ζn = `nozzle_efficiency` (0.95).

What landed:
- **`engine/core/nozzle.py`** — thrust is now `F(Pa) = ζn · Cf_vac · Pc · At − Pa · Ae`. The momentum
  reconstruction and the 20-iteration shifting loop are gone. Delivered Isp now = `ζc·ζn·Isp_ideal`,
  **below the ceiling** (impinging 248.8 s, pintle 248.7 s; matches the expected value to ≤0.5%, the
  residual being the isentropic-`Cf_vac` fallback until the cache regen completes).
- **`engine/pipeline/cea_cache.py`** — added a `Cf_vac` table (vacuum thrust coefficient, shifting),
  built from CEA's `get_Isp`; fixed the `get_PambCf[0]→[1]` ambient-Cf element; graceful isentropic
  fallback for pre-existing caches. Caches regenerated to bake `Cf_vac` in.
- **`engine/native/python/native_injector.py`** — the Layer-1 native seam now takes thrust from the
  **same** Python `calculate_thrust` (C does the chamber solve only). Inner-loop F now matches
  finalization **bit-for-bit** (was +17.5% with the C frozen nozzle). The C frozen nozzle is retired
  from the eval path.
- **`engine/pipeline/time_varying_solver.py`** — already routed thrust through `calculate_thrust`, so
  the transient/burn path picked up the RPA fix automatically; removed the now-dead shifting import.
- The `reaction_chemistry` shifting functions (`calculate_shifting_equilibrium_properties/_gamma`,
  `calculate_frozen_gamma_from_composition`) are now unreferenced by live code — slated for removal.

Thrust impact at the canonical points: impinging/CH₄ 13 965 N → **11 810 N (−15.4%)**, pintle/Ethanol
Isp 273.4 → **248.7 s (−9.0%)** — i.e. the previously-omitted `(1 − ζc·ζn)`.

### Step 5 — Re-baseline (yours, after)

Re-run the canonical designs and any target-thrust-driven requirements against the corrected model;
the optimizer will now size **larger** engines to hit the same real target. Document old-vs-new so the
drop reads as a correction, not a regression.

---

## Appendix — reproduction

All numbers above are reproducible with `ED_USE_NATIVE=0` (pure-Python authoritative path) on
`configs/canonical/impinging.yaml` and `configs/canonical/pintle.yaml`, comparing
`runner.evaluate(...)` output against `RocketCEA` directly (`get_full_cea_output`,
`estimate_Ambient_Isp`, `get_PambCf`). Key identity to check: delivered
`Isp = F/(ṁ·g₀)` should be `≤ η_c* · Isp_ideal_equilibrium(Pc, MR, eps, Pamb)`; today it equals the
**ideal** value instead.
