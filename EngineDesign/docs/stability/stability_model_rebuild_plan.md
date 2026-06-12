# Stability Model Rebuild — Implementation Plan

**Companion to** `combustion_stability_physics.md` (cited below as **[Phys §x]**).
Status: draft **v0.2**. Sequencing per user: **papers first**, then code. This plan is the bridge from
the physics to the codebase and is kept in lockstep with the physics doc — every modeling choice here
points at the paper section that justifies it.

> **v0.2 review-pass changes:** A2 now uses $\theta_c=L^*/\Gamma^2c^*$ and the **conversion lag**
> $\tau_{conv}$ (A3 uses the **sensitive lag** $\tau_{sens}$); A7 splits the regulator into **impedance
> (poles)** vs **forcing (excursion)**; added the **rich-payload schema** to A5 (forward mode + report +
> viz all render from it); demoted "±14 psi" to an assumption everywhere; fixed viz #1/#6 regulator text.

Design constraints fixed by the user:
- **Layer-1 inner loop must stay fast** (thousands of evals; target ≤ ~1 ms added per eval).
- **Final-report ("rich") check ≤ 5 s** total.
- **Pressure-fed, dome-regulated — but the regulator is NOT perfect.** Aqua Environment **1092
  high-flow** dome reg, **50 psi spring bias**. *Verified* published spec [Phys ref 16]: supply-pressure
  effect **~10 psi outlet rise / 1000 psi inlet drop**, $C_v=0.8$ — a **slow setpoint drift**, not a
  ripple. The **dynamic** excursion $\Delta P_{reg,\max}$ (the "±14 psi") is **NOT published — assumed,
  to be measured by test T6** [Phys §6.1, §9.1]. Boundary condition is finite-stiffness (eq. 6.1), not
  $P_{feed}'=0$. **No POGO** (no turbopump).
- **Tank pressure vs time must be dome-reg, not blowdown.** Current `layer2_pressure.py` builds a
  *decaying blowdown* $P_{tank}(t)$; for this engine it should be **$P_{set}$ + a slow supply-pressure
  up-drift (~10 psi/1000 psi inlet) + a bounded dynamic ripple** (eq. 6.2; ripple amplitude assumed,
  measured by T6), with a real drop only at COPV lockup near end-of-burn **[Phys §6.2]**.
- **Feed line length ≈ 12 in (0.305 m)** downstream of tanks; diameter from config; **manifold volume
  is out of scope of the solver** (exposed as an input knob, with a warning when it would dominate).
- **Keep the optimizer impact identical**: there is already a minimum-stability-margin gate before the
  run; preserve its behavior and *verify* it still works after changes.
- **Forward mode must show the rich stability analysis in even more depth** than the post-optimizer
  report, with the visualizations of §V.

---

## 0. Current state (audited 2026-06-08)

What actually runs in Layer 1: `comprehensive_stability_analysis` in
`engine/pipeline/stability/analysis.py`, called from `engine/core/runner.py:472`. Findings:

| Piece | Verdict |
|---|---|
| `calculate_acoustic_modes` longitudinal $f=(2n-1)a/4L$ | ✅ correct form |
| acoustic **transverse** uses $J_m$ roots (2.405…) | ❌ should be hard-wall $J_m'$ roots (1.841…) **[Phys §4.1]** |
| `analyze_feed_system_stability` $c=\sqrt{K/\rho}$, POGO/surge, Joukowsky | ✅ formulas correct |
| feed→ "stability_margin" mapping | ❌ hardcoded to ~1.20 for margin∈[0.05,0.5] (`*0.0` term) — rigged pass |
| `calculate_chugging_frequency` = f(L\*/c\*, Helmholtz) | ❌ wrong mechanism: uses chamber residence/Helmholtz, **no feed inertance, no injector ΔP, no lag** **[Phys §3]** |
| `stability_index`, score, thresholds | ❌ heuristic with `FIXED: lenient` floors; no growth rate, no Rayleigh, no $n$–$\tau$ |
| `spatial.py` (growth-rate/energy balance) | ⚠️ closest to right idea but hardcoded constants, **dead code** (no caller) |
| `analysis_time.py` (time-resolved) | ⚠️ **dead code** (no caller) |
| `enhanced.py`, `coupling.py`, `physics.py` | `calculate_pintle_*` only — **N/A for impinging doublets** |

Consequence: with current defaults (`min_stability_score 0.58`, `require_stable_state false`,
`min_stability_margin 1.05`) the gate passes almost everything by construction — which is why
relaxing those numbers "fixed convergence." We are replacing physics, not tuning a heuristic.

---

## 1. Architecture: two tiers, one physics core

```
engine/pipeline/stability/
  core.py        # NEW: shared physics primitives (mode freqs, n-τ, K_v, τ_vap, damping terms)
  chug.py        # NEW: lumped feed↔chamber↔combustion chug model (fast closed-form + rich root-find)
  acoustic.py    # NEW: n-τ + Rayleigh per-mode growth rate (fast estimate + rich admittance budget)
  analysis.py    # REWORK: comprehensive_stability_analysis() orchestrates; same return contract
  report.py      # NEW: rich ≤5 s final-report assembly (sweeps, damping budget, recommendations)
  legacy_pintle/ # MOVE enhanced/coupling/physics here unchanged (still used by time_varying_solver)
  # DELETE or revive: spatial.py, analysis_time.py (decision in §A6)
```

- **Fast tier** (called every eval from `runner.py`): closed-form chug margin **[Phys §3.2 fast form]**
  + per-mode acoustic growth-rate estimate **[Phys §4.2]** with cached/analytic damping. No root-find,
  no sweeps. Budget ≤ ~1 ms.
- **Rich tier** (final report only): root-finds the chug characteristic equation (3.3), solves the
  acoustic growth rate (4.1) with the full damping budget and a nozzle-admittance correction, sweeps
  $n,\chi$ for sensitivity bands, and emits recommendations. Budget ≤ 5 s.

Both tiers consume the **same** `core.py` primitives so the fast model is a documented reduction of
the rich one (not an independent heuristic).

---

## 2. Inputs already available in the codebase (symbol map)

| Physics symbol | Source in code |
|---|---|
| $P_c, T_c, \gamma, R_g, c^*$ | `runner.py` evaluate() locals passed to stability (`Pc, Tc, gamma, R, cstar`) |
| $V_c, A_t, L^*, L_{ch}, D_{ch}$ | `ensure_chamber_geometry(config)` (`cg.volume, cg.A_throat`, chamber length/dia) |
| $\dot m_O,\dot m_F,\mathrm{MR}$ | `diagnostics["mdot_O"/"mdot_F"]`, `MR` |
| $\Delta P_{inj,O/F}$, $\eta_{inj}$ | `diagnostics["delta_p_injector_O"/"_F"]` (see `injector_dp_penalty.py`) |
| $C_d, A_{or}, u_j$ | `impinging.solve()` diagnostics (`Cd_O/F`, areas, jet velocities) |
| $D_{32}$ (SMD) | spray model `diagnostics["D32_O"/"D32_F"]` (Ingebo) **[Phys §5.2]** |
| $\rho_\ell$, $h_{fg}$, $T_{boil}$, $c_{p,g}$, $k_g$ | `config.fluids[...]`, combustion props; **gap:** $k_g,c_{p,g}$ of product gas need a source (CEA or correlation) |
| feed line $\ell,A_{line}$ | `config.feed_system[...]` (`d_inlet` present; length default **0.305 m** per user) |
| $K$ (liquid bulk modulus) | currently hardcoded `1.5e9`; move to `config.fluids` per propellant |
| $P_{set},\Delta P_{reg,\max},$ spring bias | **NEW** `config.feed_system.regulator` (setpoint, `max_excursion_psi: 14` **[ASSUMED → T6]**, `spring_bias_psi: 50`, corner_hz, dome_volume_L?) **[Phys §6.1]** |

**Gaps to close (small):** gas-phase $k_g, c_{p,g}$ for $K_v$ (5.1) — pull from CEA output if available,
else a documented correlation; per-propellant bulk modulus and feed length into config.

---

## 3. Sidequest — verify the injector elements are solved *effectively*

(Requested explicitly; also a prerequisite because $\tau$ and chug both consume $\eta_{inj}$, $D_{32}$,
$\dot m$, $\mathrm R$.)

**Confirmed real (read 2026-06-08):**
- `n_doublets` is a genuine **integer DOF** (`layer1_integer_dims=[4]`), bounded by chamber-inner-Ø and
  capped by `layer1_impinging_n_doublets_max` (20). Jet diameters $d_{jet,O/F}$ are continuous DOFs with
  physics-derived upper bounds (`impinging_d_jet_upper_bound_m`).
- `impinging.solve()` runs a real **feed→orifice→Bernoulli→Cd(Re)** fixed-point closure producing
  $\dot m$, $\Delta P_{inj}$, and $\mathrm R$ from bulk velocities. Not arbitrary.

**Verification tasks (instrument, don't assume):**
1. **Does `n_doublets` actually move?** Log seed vs converged $n$ across a sweep; CMA-ES handles integer
   dims by snap-rounding (`_snap_integer_dims`), which can stall. If $n$ stays pinned at its seed, the
   "optimization" of element count is illusory and wasting a DOF. **Action:** measure; if stalled,
   consider an explicit 1-D scan over $n$ at the end (cheap) or a restart that perturbs $n$.
2. **ΔP band mismatch.** User intent is $\eta_{inj}\in[0.25,0.40]$; `default.yaml` ships
   `injector_dp_ratio_O/F ∈ [0.15,0.35]`. This matters for **chug margin** (stiffer = more stable,
   **[Phys §3.1]**). **Action:** confirm intended band; if 25–40%, update config bands (not a weight) and
   re-confirm R/SMD still converge (the Cd=0.6 fix gives headroom).
3. **Is the $\mathrm R\!\approx\!1$ target actually reached and is $\Delta P$ in band at the optimum?**
   Re-run the F-series (post Cd-fix) and tabulate $n$, $d_{jet}$, $\mathrm R$, $\eta_{inj,O/F}$, $D_{32}$.
4. **Wasted compute check:** confirm the spray/SMD and momentum terms are not recomputed redundantly per
   eval; expose $D_{32}$ to the stability core without a second spray solve.

Deliverable: a short `injector_element_verification.md` with the measured numbers (folded into this
plan's appendix once run).

---

## 4. Workstreams (each ties to a physics section)

### A1 — `core.py` primitives **[Phys §2, §4.1, §5]**
- Mode frequencies: longitudinal quarter-wave (keep) + **transverse with $J_m'$ roots (fix)**.
- $n$–$\tau$ response (2.1) as a function returning complex gain.
- $K_v$ (5.1), $\tau_{vap}=D_{32}^2/K_v$ (5.3), $\tau=\chi\tau_{vap}$ (5.4). Spalding $B$ helper.
- Damping primitives: nozzle admittance (Bell–Zinn form), viscous/boundary, injector admittance, 2-φ.
- **Unit tests** against textbook closed forms (e.g., 1T of a known chamber; $\tau_{vap}$ of a known droplet).

### A2 — `chug.py` **[Phys §3]**
- Chamber capacitance $\theta_c=L^*/(\Gamma^2 c^*)$ (3.1; **note: $1/\Gamma^2$, not $1/\gamma$**), O(1)
  prefactor pinned by matching the 1-D limit.
- Series feed impedance $Z_{feed}=Z_{reg}+\mathcal I s+\mathcal R+1/G_{inj}$ (mass-flow convention,
  $\mathcal I=\ell/A$), from `feed_system` (length 0.305 m default). Injector conductance
  $G_{inj}=\dot m/(2\eta_{inj}P_c)$ (3.2).
- **Use the conversion/transport lag $\tau_{conv}\approx\tau_{vap}$ here** (the $e^{-s\tau_{conv}}$ in 3.3) —
  *not* the sensitive lag $\tau_{sens}$ (that's acoustic, A3) **[Phys §5 two-lags box]**.
- **Fast:** closed-form chug margin $\zeta_{chug}$ proxy (stiffness + lag/capacitance phase), calibrated
  to the *sign* of $\alpha$ from (3.3).
- **Rich:** root-find (3.3) for $\alpha,\omega$; report frequency, growth rate, dominant driver.
- Manifold-compliance input knob with "would-dominate" warning **[Phys §6]**.

### A3 — `acoustic.py` **[Phys §4]**
- Per-mode growth rate (4.1): combustion driving via $n\sin(\omega\tau_{sens})$ (**sensitive** lag
  $\tau_{sens}=\chi\tau_{vap}$, *not* the chug $\tau_{conv}$) + itemized damping budget.
- **Fast:** 1L + 1T growth-rate estimate with analytic damping; flag if any $\alpha>0$.
- **Rich:** all modes through ~2T/2L, nozzle-admittance longitudinal correction, $n,\chi$ sensitivity band.
- Replace the 10%-frequency-coincidence "mode coupling" proxy with actual driven-mode detection.

### A4 — `analysis.py` rework (contract-preserving) **[plan §5]**
- Keep the **return dictionary keys** consumed downstream: `stability_state`, `stability_score`,
  `chugging.stability_margin`, `acoustic.stability_margin`, `feed_system.stability_margin`, `Lstar`,
  `issues`, `recommendations`, `mode_coupling`, `is_stable`. (Layer-1 reads these at lines 1556–1560,
  3519–3523.)
- New margins are **monotone functions of growth rate**: e.g. `chugging.stability_margin = 1 + ζ_chug`,
  `acoustic.stability_margin = 1 − α/α_ref` clipped — so the existing `min_stability_margin` gate keeps
  the same *direction and units* (≥1 = stable) but is now physical, not rigged.
- Remove the hardcoded-pass feed mapping; report water-hammer **separately** as a valve-transient note,
  not in the combustion margin **[Phys §6]**.

### A5 — `report.py` rich tier (≤5 s) **[Phys §4.2, §5.3]**
- Damping budget table, $n$–$\chi$ sensitivity sweep, per-mode growth rates, Campbell-style frequency
  map (chug, 1L/2L, 1T/2T vs feed modes), prioritized recommendations (baffles/cavities/Δη_inj).
- **Rich payload schema (define once; both forward mode and the report render from it).** Draft so the
  §V components and the `evaluate.py` endpoint agree from day one:
  ```jsonc
  stability_rich = {
    "summary": { "state": "stable|marginal|unstable", "min_margin": float,
                 "gate_margin_threshold": float, "limiting_mode": "chug|1T|..." },
    "chug": { "alpha": 1/s, "freq_hz": float, "zeta": float, "margin": float,
              "alpha_no_reg": float,            // Z_reg=0 comparison (A7)
              "boundary_curve": [[eta_inj, tau_over_thetac], ...],  // viz #1
              "pole": [re, im], "driver": "feed_inertance|lag|stiffness" },
    "acoustic": { "modes": [ { "name":"1T", "freq_hz":float, "alpha":1/s,
                  "driving":float, "damping": {"noz":..,"visc":..,"inj":..,"twophase":..} } ] },  // viz #2,#3
    "phase": [ { "mode":"1T", "omega_tau": float } ],          // viz #4 phase clock
    "vaporization": { "d2_profile": [[x_m, d2_norm], ...], "L_vap_m": float,
                      "L_ch_m": float, "tau_conv_s": float, "tau_sens_s": float,
                      "smd_um": float, "smd_band_um": [lo,hi] },             // viz #5
    "feed_pressure": { "P_set_psi": float, "ripple_psi": float,
                       "blowdown_ref": [[t,P], ...], "regulated": [[t,P], ...] },  // viz #6
    "radar": { "axes": ["chug","1L","1T","feed_sep","vap_complete"], "values":[...], "threshold":[...] }, // viz #7
    "water_hammer": { "spike_psi": float, "available_dp_psi": float },        // viz #8
    "assumptions": { "n": float, "chi": float, "dP_reg_max_psi": float, "n_doublets": int, ... },
    "sensitivity": { "n": [lo,hi], "chi": [lo,hi], "dP_reg_max": [lo,hi] }
  }
  ```
  The **fast tier** returns just `summary` + the per-margin scalars (no curves/sweeps) — same keys,
  subset — so `analysis.py` (A4) maps trivially to the existing gate fields.

### A6 — Dead code decision
- `spatial.py`: salvage the energy-balance *idea* into `acoustic.py`'s growth-rate path; otherwise delete.
- `analysis_time.py`: keep only if the time-varying solver will call it; else delete. Decide once A2/A3 land.

### A7 — Finite dome-regulator boundary (`chug.py`) **[Phys §6.1, §3.2 two-roles]**
The regulator enters the math in **two distinct places — implement both, separately:**
- **Impedance $Z_{reg}(s)$ → inside $Z_{feed}$ in (3.3)** ⇒ it shifts the poles / $\alpha$ (homogeneous
  stability). At chug frequencies model $Z_{reg}$ as the passive **dome-gas compliance** (from dome
  volume + corner freq). Perfect source = $Z_{reg}{=}0$ limit. **This is what changes the chug boundary.**
- **Forcing bound $\Delta P_{reg,\max}$ → the disturbance amplitude** (limit-cycle / triggering), *not*
  a pole-shifter. Report chug margin **with $Z_{reg}=0$ vs finite $Z_{reg}$** so the regulator's effect
  on the boundary is visible, and separately report the forced excursion.
- $\Delta P_{reg,\max}$ default ≈ ±14 psi is an **assumption (placeholder, retire via T6)**, *not* a spec.
- Config additions: `feed_system.regulator = { setpoint_psi, spring_bias_psi: 50,
  max_excursion_psi: 14  # ASSUMED, measure T6, corner_hz, dome_volume_L? }`.

### B — Forward mode + dome-reg tank-pressure-vs-time **[Phys §6.2; constraints]**
Two distinct fixes, both user-flagged:
1. **Forward-mode depth.** `ForwardMode.tsx` currently shows performance only (`ResultsDisplay`). Add a
   **full rich-stability panel** (the §A5 report content + the §V visualizations) so a single forward
   evaluation exposes every stability metric, not just performance. Forward mode is the *deepest* view:
   interactive (sliders for $\eta_{inj}, D_{32}, n, \chi$) so the user can probe sensitivities live.
   Backend: extend `backend/routers/evaluate.py` to call the rich analysis (≤5 s) and return its payload.
2. **Dome-reg time model.** `layer2_pressure.py` / `time_varying_solver.py` assume a **blowdown decay**
   $P_{tank}(t)$. Add a `feed_pressure_model: {blowdown | dome_regulated}` switch. For `dome_regulated`,
   $P_{tank}(t)=P_{set}+\delta P_{drift}+\delta P_{dyn}$ (eq. 6.2: slow ~10 psi/1000-psi up-drift +
   bounded ripple, ripple assumed/T6), and an optional EOB droop when COPV < lockup. This changes what forward/flight modes feed the injector solve and what the
   stability time-history looks like. **Verify** Layer-2's pressure-curve DOFs are bypassed/constrained
   in dome-reg mode (don't optimize a blowdown profile that won't exist).
   **[UNCERTAINTY]** $\delta P(t)$ spectrum is unknown; model as bounded ripple + (optionally) the chug
   mode's own predicted oscillation fed back, flagged as illustrative.

---

## V. Visualization design (forward mode + final report)

**Design philosophy.** Each metric gets *one* purpose-built visual that answers a single question and
**shows the design point against its boundary/target so the margin is a visible distance, not a number.**
Shared grammar: green = stable / damping, red = driving / unstable, amber = marginal; the current design
is always a bright dot/needle; every pixel encodes data (no decorative chrome); raw numbers live on
hover/labels. Forward mode gets the **interactive** versions (sliders for $\eta_{inj},D_{32},n,\chi$ move
the design point live); the final report gets static high-DPI snapshots of the same components.

| # | Metric **[Phys §]** | Visualization | Why this form (the question it answers) |
|---|---|---|---|
| 1 | **Chug margin** [§3] | **Injector-stiffness stability map** — x: $\eta_{inj}=\Delta P_{inj}/P_c$, y: $\tau/\theta_c$. Shade the unstable region from the sign of $\alpha$ in (3.3); draw the boundary curve; plot O- and F-stream design dots with a margin arrow to the boundary. A faint band shows how the regulator **impedance $Z_{reg}$** (not the excursion bound) shifts the boundary. | "How stiff must the injector be to be chug-stable, and how much margin do I have?" The single most *actionable* design viz — you read the required ΔP straight off the x-axis. |
| 1b | **Chug (depth view)** [§3.2] | **Root-locus / s-plane pole map** — dominant chug pole(s); left-half green, right-half red; slider on $\eta_{inj}$ migrates the pole live. | "Is the loop actually decaying, and how fast?" Forward-mode depth companion to the map. |
| 2 | **Acoustic per-mode growth** [§4] | **Damping-budget bars** — one horizontal bar per mode (1L,2L,1T,2T): combustion *driving* growing right (red), summed *damping* growing left as **stacked segments** (nozzle / viscous / injector / 2-φ, distinct hues); net arrow = sign of $\alpha$. | "Which mode is hot, and *which damping mechanism* am I relying on?" Shows the why, not just the verdict. |
| 3 | **Mode frequencies / coincidence** [§4.1, §6] | **Frequency ladder (Campbell-style)** — vertical Hz axis with chug, 1L/2L/3L, 1T/2T, feed POGO/surge, the **regulator band**, and the $n$–$\tau$ driving-phase band; coincidences flagged with a connector. | "Do any modes line up where combustion can drive them?" Replaces the current 10%-coincidence proxy with something legible. |
| 4 | **Rayleigh / $n$–$\tau$ phase** [§1, §2] | **Phase clock (polar dial)** — circle with the driving half ($|\angle q'\!-\!p'|<90°$) shaded red, damping half green; a needle per mode at $\omega\tau$. | "Is the heat release in the dangerous phase?" Encodes the core instability condition as a glance-readable dial. |
| 5 | **Time lag / vaporization** [§5] | **$d^2$-law decay + vaporization-length overlay** — $d^2(x)/d_0^2$ vs axial position; vertical lines at chamber length $L_{ch}$ and vaporization length $L_{vap}$; shaded if $L_{vap}>L_{ch}$ (droplets exit unburned). Inset: the $\tau\propto D_{32}^2$ curve with the operating point and an SMD-uncertainty band. | "Do my droplets vaporize inside the chamber, and how does SMD move $\tau$?" Directly ties the spray/Cd work to stability. |
| 6 | **Dome-reg tank pressure(t)** [§6.2] | **Setpoint band plot** — $P_{set}$ line + slow supply-pressure up-drift, with the (assumed, T6) ripple envelope shaded; the old blowdown curve dashed for contrast; EOB lockup droop marked if COPV < lockup. | "What does the regulated feed actually look like vs the blowdown the code assumed?" Makes the modeling fix self-evident. |
| 7 | **Overall health (header)** [§4.4] | **Stability radar** — axes: chug margin, 1L, 1T, feed separation, vaporization completeness; filled polygon vs the `min_stability_margin` threshold ring. | "One-glance: is this design healthy, and which axis is weakest?" Compact forward-mode/report header. |
| 8 | **Water-hammer (separate)** [§6] | small **spike-vs-available-ΔP** bar, clearly labeled *valve transient — not combustion stability*. | Keeps the (correct) Joukowsky check visible without conflating it into the combustion margin. |

Implementation notes: build as small reusable React/recharts (or lightweight SVG/D3 for the s-plane and
phase clock) components under `frontend/src/components/stability/`; the rich backend payload (§A5) carries
exactly the arrays each component needs (boundary curves, pole locations, per-mode driving/damping
breakdown, $d^2$ profile, ripple envelope) so the same payload renders in both forward mode and the
post-optimizer report. Keep them in a responsive grid of small multiples; expand-on-click for the
interactive depth views in forward mode.

---

## 5. Gate behavior — preserve and verify

The pre-run gate already exists: `min_stability_margin` (default 1.05), `min_stability_score` (0.58),
`require_stable_state` (false), read in `layer1_static_optimization.py` (1372, 1556–1580, 3519–3543) and
folded into `infeasibility_score`. Plan:
1. **Keep the same gate plumbing and keys.** Only the *values behind* the margins become physical.
2. **Re-baseline thresholds** after A4 so a known-good design (post Cd-fix F-series) still passes and a
   deliberately-soft design (low $\eta_{inj}$, large $D_{32}$) is correctly failed. Document the new
   threshold rationale (growth-rate-based) — this is the only place thresholds change, and it is a
   **gate-calibration**, not a silent relaxation.
3. **Regression test:** assert the F-series VALID designs remain VALID and that lowering $\eta_{inj}$
   below ~0.1 trips the chug gate (sign check against the physics).

---

## 6. Validation strategy

- **Unit:** each primitive vs closed-form (A1 tests).
- **Sign/limit tests:** stiffer injector ⇒ higher chug margin; longer $\tau$ (bigger $D_{32}$) ⇒ lower
  margins; 1T most susceptible. These are monotonicity checks the current code cannot pass.
- **Cross-check the fast vs rich tiers** agree in sign on a design sweep (fast is a reduction of rich).
- **Literature anchor:** reproduce a published chug boundary trend (Wenzel & Szuch [6]) and a
  vaporization-length trend (Priem & Heidmann [7]) qualitatively.
- **Test-driven calibration (the real path to trust):** each assumed coefficient is retired by a
  specific ground/hot-fire test per **[Phys §9]** — T1 (Cd), T2 (feed R), T4 (Ingebo $C$/SMD),
  T5 (bulk modulus/inertance), **T6 (regulator $\Delta P_{reg,\max}$, $Z_{reg}$)**, H1/H3 ($\alpha$, $n,\tau$).
  As tests complete, swap assumed defaults for measured values; the model improves monotonically.
- **[UNCERTAINTY]** absolute validation needs hot-fire data we don't have yet; deliverable is calibrated
  guidance with sensitivity bands (per physics doc §8), tightened test-by-test (§9).

---

## 7. Risks & uncertainties (mirror of physics doc)

1. **$n$, $\tau$, $\chi$** a-priori values — largest risk **[Phys §5.3, §2]**. Mitigate: physics-based
   $\tau\propto D_{32}^2$, $n=O(1)$ calibrated, sensitivity bands in rich tier.
2. **Acoustic damping coefficients** (2-φ, injector admittance) — report as an explicit budget with
   ranges, not false precision **[Phys §4.2]**.
3. **LOX near-critical** vaporization at higher $P_c$ **[Phys §5.3]**.
4. **Methalox literature gap** — treat any single methalox $n,\tau$ as indicative **[Phys §7]**.
5. **Fast-tier fidelity vs speed** — the closed-form chug proxy must track the root-find sign; verified
   in A2.
6. **Integer-DOF stall** for `n_doublets` (sidequest item 1) — could mean element count isn't truly
   optimized today.
7. **Regulator dynamics unknown** — only the *static* supply-pressure effect (~10 psi/1000 psi) is
   published; the **dynamic** $\Delta P_{reg,\max}$ (the "±14 psi") and $Z_{reg}(\omega)$ are assumed.
   Modeled as $Z_{reg}$-in-series (poles) + a forcing bound, both reported with sensitivity; **T6 retires
   them** **[Phys §6.1]**.
8. **Dome-reg time model vs Layer-2** — switching $P_{tank}(t)$ from blowdown to regulated changes what
   Layer-2 optimizes; must ensure Layer-2 pressure-curve DOFs are coherently constrained, not fighting
   a profile that won't exist (plan §B).

---

## 8. Sequencing (milestones)

- **M0 (this turn):** physics doc + plan + sidequest confirmation. ✅
- **M1:** `core.py` primitives + unit tests; pin Ingebo TN and gas-property source.
- **M2:** `chug.py` fast + rich; sidequest measurements (n_doublets, ΔP band) reported.
- **M3:** `acoustic.py` fast + rich; transverse-root fix; remove coincidence proxy.
- **M4:** `analysis.py` rework (contract-preserving) + gate re-baseline + regression tests.
- **M5:** `report.py` rich tier ≤5 s; dead-code decision; methalox property pass.
- **M6:** **Forward-mode rich panel + interactive sensitivities**, **dome-reg tank-pressure(t) model**
  (A7+B), and the **§V visualizations** (shared payload, both forward mode and final report).

Each milestone is independently testable and leaves the optimizer runnable.

---

## 9. Open questions for the user (do not need all to start M1)

1. **ΔP band:** confirm injector stiffness target — keep config 15–35%, or move to your stated 25–40%?
   (Affects chug margin directly.)
2. **Interaction index default:** OK to default $n\approx0.5$ with a documented 0.3–0.6 sweep until we
   have methalox-specific data?
3. **Gas properties for $K_v$:** may I pull $k_g,c_{p,g}$ from the CEA output already in the pipeline,
   or do you prefer a fixed correlation for speed?
4. **Manifold volume:** provide a nominal value to seed the compliance warning, or leave it as "unknown,
   warn if it could dominate"?
5. **Regulator details:** do you have the dome **volume** and a **setpoint** (P_set) for the 1092, and
   any sense of its response **corner frequency**? If not, I'll default corner ≈ a few Hz and treat the
   dome as a passive gas-spring at chug frequencies, with the ±14 psi as the excursion bound.
6. **Dome-reg time model scope:** should `dome_regulated` $P_{tank}(t)$ become the **default** for this
   engine (Layer-2 blowdown DOFs disabled), or a selectable mode alongside blowdown?
