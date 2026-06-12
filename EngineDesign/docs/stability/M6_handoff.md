# M6 Handoff — Forward-mode rich panel, §V visualizations, dome-reg time model

Context transfer for picking up **Milestone 6** of the stability-model rebuild. M1–M5 (the entire
backend stability engine) are **done, tested, and validated**. M6 is the remaining work: wire the rich
analysis into forward mode, build the 8 visualizations, and add the dome-regulated tank-pressure-vs-time
model. M6 is **mostly frontend** (React/recharts) plus two small backend hooks.

Read first: `docs/stability/combustion_stability_physics.md` (physics, v0.2) and
`docs/stability/stability_model_rebuild_plan.md` (plan; **§V** = viz spec, **§B** = forward-mode + dome-reg).

---

## What already exists (M1–M5, all tested — 67 passing tests)

```
engine/pipeline/stability/
  core.py        # primitives: mode freqs (J'_m transverse fix), n-tau gain, K_v, tau_vap, damping
  chug.py        # chug model: impedance char. eq; fast gain-margin + rich root-find; Regulator
  acoustic.py    # per-mode growth rate: n-tau driving + itemized damping budget; fast + rich
  analysis.py    # comprehensive_stability_analysis() — LIVE optimizer gate (fast tiers); contract-preserving
                 #   build_stability_inputs()  <- shared extraction (config+diagnostics -> params)
                 #   compute_physical_stability() <- fast, per-eval
  report.py      # build_rich_report() -> the FULL payload (plan §A5 schema); <1 s; for report + forward mode
tests/test_stability_{core,chug,acoustic,analysis,report}.py
```

The rich payload (`report.build_rich_report(...)`) is the single data source for **all 8 visualizations**.
Its exact shape is in `report.py` (and plan §A5). Top-level keys: `summary, chug, acoustic, phase,
vaporization, feed_pressure, radar, water_hammer, assumptions, sensitivity`.

---

## M6 Part 1 — Wire the rich report into forward mode (backend, small)

**Goal:** a forward evaluation returns the rich payload so the UI can render the viz.

1. **`engine/core/runner.py`** — `evaluate()` already computes the fast stability at ~line 472
   (`comprehensive_stability_analysis(config, Pc, MR, mdot_total, cstar=cstar_actual, gamma, R, Tc,
   diagnostics)`). All the inputs for the rich report are in scope there (`Pc, MR, mdot_total,
   cstar_actual, gamma, R, Tc, diagnostics`, and `cg = ensure_chamber_geometry(self.config)`).
   Add a **flag-gated** call:
   ```python
   def evaluate(self, ..., rich_stability: bool = False):
       ...
       if rich_stability:
           from engine.pipeline.stability.report import build_rich_report
           results["stability_rich"] = build_rich_report(
               self.config, Pc, MR, mdot_total, cstar_actual, gamma, R, Tc, diagnostics, cg)
   ```
   ⚠️ **CRITICAL:** `build_rich_report` is ~1 s. `evaluate()` is ALSO the optimizer's per-eval path
   (thousands of calls). It MUST stay behind `rich_stability=False` by default — only forward mode and
   the post-optimizer report set it True. Do NOT call it unconditionally.

2. **`backend/routers/evaluate.py`** — the `POST /api/evaluate` endpoint (forward mode) calls
   `app_state.runner.evaluate(P_tank_O, P_tank_F, debug=True)` (~line 21). Change to
   `evaluate(P_tank_O, P_tank_F, debug=True, rich_stability=True)`. The payload then rides through
   `results["stability_rich"]` → frontend reads `response.data.results.stability_rich`.

3. (Optional, post-optimizer report) the Layer-1 results could also carry a rich payload computed once
   on the converged design — same call, in `layer1_static_optimization.py` results assembly.

---

## M6 Part 2 — The 8 visualizations (frontend, the bulk of M6)

**Stack:** React + Vite, **recharts ^2.15** is available (`frontend/package.json`). For the s-plane pole
map and the phase clock, lightweight inline SVG/D3 is cleaner than recharts.

**Where:** new dir `frontend/src/components/stability/`, one component per viz. Render them in a
responsive small-multiples grid. Spec + design grammar in **plan §V** (green=stable/damping,
red=driving/unstable; always plot the design point so margin = visible distance; numbers on hover).

| # | Component | Payload source (`stability_rich.*`) |
|---|---|---|
| 1 | Injector-stiffness stability map (η_inj vs τ/θ_c, boundary + design dot) | `chug.boundary_curve`, `chug.margin`, `assumptions.eta_inj_*` |
| 1b | s-plane pole map (slider) | `chug.pole` (add if needed), `chug.alpha`, `chug.freq_hz` |
| 2 | Per-mode damping-budget bars (driving vs stacked nozzle/visc/inj/2φ) | `acoustic.modes[].{alpha,driving,damping}` |
| 3 | Frequency ladder (Campbell) | `acoustic.modes[].freq_hz`, `chug.freq_hz`, feed modes |
| 4 | Phase clock (ωτ dial, driving half shaded) | `phase[].omega_tau` |
| 5 | d²-law decay + L_vap vs L_ch | `vaporization.{d2_profile,L_vap_m,L_ch_m,smd_um,smd_band_um}` |
| 6 | Dome-reg P_tank(t) band vs blowdown | `feed_pressure.{P_set_psi,ripple_psi,regulated,blowdown_ref}` |
| 7 | Stability radar (one-glance health) | `radar.{axes,values,threshold}` |
| 8 | Water-hammer bar (labeled valve-transient, NOT combustion) | `water_hammer.{spike_psi,available_dp_psi}` |

**Forward mode = the deepest view (plan §B-1):** add the panel to `frontend/src/components/ForwardMode.tsx`
(currently renders only `<ResultsDisplay>` at ~line 172). Forward mode should also get **interactive
sliders** (η_inj, SMD, n, χ) that re-request `/api/evaluate` (or recompute client-side) so the user can
watch the design point move on viz #1/#1b/#4 live. The post-optimizer report (`Layer1Optimization.tsx`)
gets the same components as static snapshots.

---

## M6 Part 3 — Dome-reg tank-pressure-vs-time model (backend)

**Problem (confirmed):** `engine/optimizer/layers/layer2_pressure.py` builds `P_tank(t)` as **decaying
blowdown segments** (`generate_pressure_curve_from_segments`, ~line 40) and feeds them to
`engine/pipeline/time_varying_solver.py` `solve_time_series(times, P_tank_O[], P_tank_F[])`. That's wrong
for a dome-regulated feed. Physics + equation (6.2) in `combustion_stability_physics.md` §6.2.

**Do:** add `feed_pressure_model: {blowdown | dome_regulated}` (config). For `dome_regulated`, generate
`P_tank(t) = P_set + slow up-drift(~10 psi/1000 psi inlet drop) + bounded ripple`, with EOB droop only at
COPV lockup — NOT a monotonic decay. **Verify** Layer-2's blowdown-segment DOFs are disabled/constrained
in this mode so the optimizer doesn't fit a profile that won't exist (plan risk #8). Regulator is the
**Aqua Environment 1092** (verified: ~10 psi/1000-psi supply-pressure effect, Cv=0.8); the dynamic ±-excursion
is ASSUMED (~±14 psi) pending test **T6** — see physics §6.1.

---

## Open design calls (settle with the user; affect what the viz shows)

1. **ΔP band:** design sits at 24–32%; config `injector_dp_ratio_O/F` band is [0.15,0.35]; user's stated
   target is [0.25,0.40]. Move it? (Stiffer = more chug margin.) Config: `configs/default.yaml`.
2. **n_doublets cap:** the DOF is active but rails at the cap (20) because more elements → finer
   atomization → lower SMD. Raise `layer1_impinging_n_doublets_max` to find the true optimum? (More
   doublets also shortens τ → helps stability.)
3. **Combustion-response defaults** (in `analysis.py`): `_N_INTERACTION_DEFAULT=0.5`,
   `_CHI_ACOUSTIC_DEFAULT=0.15` — calibration targets (tests H3/H5). Gate mappings `_CHUG_GATE_*`,
   `_ACOUSTIC_GATE_*` are deliberately lenient pending T5/T6/T7.

---

## Loose ends (low priority)

- **Dead code:** `engine/pipeline/stability/{spatial.py, analysis_time.py}` are unused — delete or
  salvage the energy-balance idea into `acoustic.py`. `{enhanced,coupling,physics}.py` are pintle-only
  (used by `time_varying_solver`); leave or move to a `legacy_pintle/` subdir.
- **Methalox property pass:** LOX `latent_heat`/`boiling_point` are null in `default.yaml`; the code
  falls back to 213000 J/kg / 90.2 K (constants `_LOX_HFG_DEFAULT`, `_LOX_TBOIL_DEFAULT` in analysis.py).
  Consider putting real values in the config.
- **Pin Ingebo TN** in physics doc ref [14].

## How to test M6

- Backend wiring: `app_state.runner.evaluate(..., rich_stability=True)` returns `results["stability_rich"]`
  with all 10 top-level keys (see `tests/test_stability_report.py`).
- Frontend: load a config, open Forward Mode, enter tank pressures, confirm the 8 viz render and the
  sliders move the design point. The full stability suite must stay green:
  `pytest tests/test_stability_*.py -q` (67 tests).
