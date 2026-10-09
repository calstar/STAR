# Layer X audit (2026-10-02)

## Status after the overnight work (2026-10-03)

The audit below is as written on 2026-10-02. What changed since, and each change's measured effect, is
in [`CHANGELOG.md`](CHANGELOG.md). On the re-run baseline (`baseline-2026-10-03.json`) he_pad, gn2_pad
and gn2_flight are unchanged to the last digit; he_flight now flies (24,235 N·s, apogee 3,249 m AGL).
Everything new that changes a burn is opt-in and off.

**Fixed**

| finding | now |
|---|---|
| #1 MAWP trip ignored (5.2) | `burn()` stops on the trip and Layer X reports it: the AUDIT case reads 21,717 N·s ending at 3.125 s with a `trip` event, unconverged (was 99,478 N·s over 14 s). Every tool counts a tripped burn as failing |
| #6 He drawing cannot fly; GN2 is the default (5.2, D2) | the flight prices the drawing's pressurant: he_flight 24,235 N·s, 3,249 m AGL. The UI opens on `copv_study_he` (D2 option C) |
| #11 GN2 check at 492.5 psia (5.1, D3) | preflight **fails** a hot fire when p_N2 > Psat,N2(T_LOX), 52.3 psia at 90 K, unless `ack_gn2_condensation` (D3 option C) |
| #12 Optimise returns its bounds (D6) | Trade study removed; Optimize is Set point and Hardware (D6 option C). 7,200 N mean on LE4: lockup 597.79 psia, dome 516.05 psig, fill 3,482.7 psig, 5 burns; the tanks then peak at 635 psia (warn against the 600 cap) |
| Silent zero-erosion replay (5.3) | an eroding engine always erodes; a graphite-only engine grows 3.09 %, where it read 0.000 % |
| `soak_back` never called (5.3) | runs after the final replay, sized from 3·L²ρc/k; the insert back face and soak peak are reported per station |
| Saved runs keep only probe nodes; the replay drops its output (5.2) | the whole network is recorded on every run (31 nodes, 31 branches); the replay keeps its arrays; axial heat flux goes to a sidecar |
| Limits graded three times, no worst times (5.3) | one server-side `result.limits`, each with `t_worst` (the legacy optimiser and the old GUI still carry their own thresholds) |
| Static margin, CG, max-Q not surfaced (5.3) | `flight.stability`: liftoff margin 7.28 cal, max-Q 42.9 kPa on the He flight |
| `supply_K` not zeroed (5.3, D7); chug frequency not the gate's (5.1) | zeroed; the gate frequency is reported (21.8 Hz config basis, 23.3 Hz drawing basis) |
| Chug model benchmarked only without inertance (5.3) | benchmark F: the loop with line inertance against a closed form, +0.1 % |
| Pressure thrust after burnout; no rail hold (5.1, 5.4) | gated to the burn; a held vehicle reads exactly 1 g |
| No relief component (#3, 5.2) | feedtwin has a pressure-actuated relief valve, used when a drawing's RV declares `set_pressure`. **No drawing has one yet** |
| `surface_temperature_K` not recorded; stale docs (5.4) | recorded; the CLAUDE.md/BENCHMARK thermal sentence, `Setup.chilldown` and the flight docstrings are corrected |

**Built opt-in; the default waits on you**

| decision | built | measured on LE4 when on |
|---|---|---|
| D7 chug basis | drawing basis, eroded geometry, settled minimum: all computed and shown on every run; the graded figure is still today's | drawing basis: graded 1.398 → **1.468** (+5.0 %). Eroded geometry: burnout 1.512 → 1.572, minimum +0.0004. Settled minimum (from 0.065 s) 1.3977 against today's 1.3981 |
| D4 card | option B (v_vac follows Cf_vac(ε(t))), `card_eroded_nozzle`; option E not built | delivered unchanged; twin mean thrust −0.15 %, peak −0.45 %; engine check 0.50 → 0.05 % |
| D5 flight | option C, `flight_coupling: inline` | 2 passes against 4; impulse −0.006 %, apogee −0.03 m; the graded chug margin −0.6 % (its first step burns at 1 g) |
| D1 thermal | lib/feedtwin: per-tank ullage-wall T-0 and the compressible regulator seat, both off; Layer X does not pass them yet | Layer X stays on option A; stakes as in D1 below |
| #8 start transient | a start, shutdown, water-hammer and gas-ingestion diagnostic; the burn still opens both mains at Fire | LOX primes first (9.6 vs 17.3 ms, ~25 g oxidiser lead); start loss 101 N·s (0.42 %) |

**Still waiting for you**, stakes as measured in section 2 unless noted: D1 thermal defaults (bottle −9 psi
with the cockpit closures; +214 psi with line walls; −225 psi with a cold LOX upper wall); D4-E; D7 (the
default basis, above); D8 which LE4 (throat growth 4.00 vs 5.69 %, chug 1.398 vs 1.367; the GUI's QA run
used the app document); D9 SPE 17 or 10 psi/1000 psi (end thrust 7,315 vs 7,112 N); D10 constant thrust
(a +448 N ramp at a 7.2 kN mean); D11 tank limits (peaks 618/619 psia, 635 at the 7.2 kN set point,
graded warn against the 600 cap); D12 design O/F (1.5 or 1.523; LE4 runs 1.521; Hardware's O/F objective
reads it); D13 COPV top-up; D14 He droop; D15 ethanol; D16 nozzle efficiency; D17 liner and case (the
insert back face is still adiabatic, 2,326 K); D18 face heat flux; D19 vehicle data (rail exit
22.4 m/s = 73.6 ft/s on the He flight, against 85 ft/s); D20 pad hold; D21 stale LOX properties.

**New for the team from tonight.** The new checks' ratings are estimates and grade amber at most until
reviewed. The one that matters: closing the fuel main in the drawn 0.05 s gives a 1,384 psi surge and a
separated column, graded on Joukowsky at 2,906 psia against the fuel tank's *estimated* 1,015 psia
rating. It rests on an assumed straight-line Cv curve, which closes the flow in the last ~7 % of travel.
Line, valve and manifold ratings and the main valve's Cv curve would settle it.

**Still open (not decisions):** #2 the insert's case (needs D17); #3 relief set pressures and Cv on
the drawings; #4 two LE4s (D8); #9 line heights, and the feed fit still writes an unclamped K0
(`feedfit.design_update`); #10 erosion inputs; the l_reg bore; ethanol composition; PTs read total
pressure; lib/feedtwin's `burn()` stamps a trip at the end of the 50 ms step (Layer X corrects it on
its side).

---


Phase 0 is read-only. No physics, source file or drawing was changed. Ten area audits fed this document: engine card, erosion and outer loop, flight, chug, feedtwin numerics, drawings, assumption ledger, baseline, result data, and Optimise/Trade/Injector holes. Sections 1-8 are the edited synthesis. Section 9 has each audit in full. Raw scripts and outputs are in the session scratchpad under `audit/<area>/`, not in the repo.

**Basis of the numbers.** Unless tagged otherwise, every number uses:
- LE4 = `configs/ethalox_6800N.yaml` (config fingerprint `7782d2fd…`: the sha256 of the schema-validated config, `engine/layerx/fingerprint.py`; the file's own sha256 is `576b9b8a…`, unchanged since 2026-10-01 15:23, so `shasum` on the YAML will not show `7782d2fd`);
- the He hot-fire drawing `copv_study_he` (`41c9a39a…`);
- the pad;
- default `LayerXSettings`: card engine, erosion replay on, dt 0.05 s, lockup 578 psia, bottle 4500 psig.

Two tags mark numbers on a different basis:
- **[doc]**: the app document "Ethalox 7200N Doublet" (`ae3edfd7…`). This is what the :8000 server runs, and it differs from the YAML in 8 fields (D8).
- **[7e47d1]**: a saved run on a third design (`0a7bafc0…`, the reconciled injector).

Pressures are psia unless marked psi (a difference) or psig. Verdicts are OK / BUG / RISK. Severity is high / medium / low.

Several numbers here were checked by hand and agree with the code:
- Bartz h at the throat: 9,862 by hand vs 9,874 W/m²K in the code.
- Graphite H2O oxidation rate: 0.439 vs 0.4389 kg/m²s.
- Liner Landau rate: 0.373 vs 0.3728 mm/s.
- Tank head ρ·a·level: within 0.0001 psi.
- Press solenoid Cv drop: within 0.4 %.
- Liquid line losses: 14.69 vs 14.80 psi (LOX) and 31.62 vs 31.66 psi (fuel).
- Dome: 513.554 psig by hand, equal to the code.
- He bottle mass: 0.208977 vs 0.208980 kg.
- Flight refill, N2: 0.5209 kg by hand vs the sim's 0.521 kg.

These checks verify the implementation. They say nothing about whether the model's inputs are right.

---

## 1. Summary

Ranked by consequence for LE4 safety, then for prediction.

| # | Finding | Consequence for LE4 |
|---|---|---|
| 1 | Layer X never reads feedtwin's MAWP trip: nothing in `session/burn.py` or `engine/layerx/` reads `session.tripped`. A mid-burn trip freezes the stand, and Layer X integrates the frozen frame to the horizon. | Restating the fuel tank MAWP to 600 psi gives a reported 99,478 N·s [doc] (4.1x the real ~24,240), a burn of 14.000 s, "Horizon reached" and no trip note. At the user's 750 psi MEOP entered as the MAWP, any lockup above ~719 psia trips this way: feedtwin trips at 750 psig + 14.696 = 764.7 psia (`core.py:640-642`, standard-atmosphere gauge datum, not the site's 13.64 psia), and the burn rises ~46 psi at these lockups. Measured (YAML, replay off): 718 psia finishes with the fuel tank at 763.9 psia; 720 psia trips and reports 119,432 N·s over 14.000 s. |
| 2 | The graphite insert's back face is adiabatic. The config sets `stainless_steel_case: null` (yaml:241), although its header describes a 0.25 in steel case. | Insert back face reaches 2,326 K at burnout and 2,355 K soaked. No case, bondline-to-steel or faceplate temperature exists. `soak_back` is never called. Insert retention and seals cannot be assessed. |
| 3 | No drawing has a relief valve, burst disc or check valve. A drawn `RV` builds as an always-open Cv vent (`pid/network.py:53,506`). The tank MAWP of 1000 psi is "estimated". | Overpressure protection is unmodelled. Regulator fail-open flow is 0.43-0.44 kg/s He (hand calc, IEC 60534 choked, xT 0.7 assumed; 0.430 with CoolProp's real-gas γ 1.63 at 4514.5 psia); a relief would need Cv ≈ 4.0-4.1 at 825 psig. The delivered tank peak of 619.0 psia is above the config's 600 psi cap but is graded only against the estimated 1000. |
| 4 | There are two LE4s. The YAML and the app document differ in 8 fields: feed lengths (1.3716/0.3048 vs 0.9144/0.1016 m) and graphite (GR001CC 1810 kg/m³ vs a generic 2260). The live session also changed during the audit. | Throat growth is 4.00 % on the YAML vs 5.69 % [doc] (+42 % relative). Chug minimum is 1.398 vs 1.367. Peak thrust is 7,315 vs 7,362 N. Until one is chosen, every number must carry a config fingerprint. |
| 5 | Thrust is not constant. The regulator's supply-pressure effect lifts both tanks from 578 to 619 psia. The drawing gives 17 psi/1000 psi; EngineDesign's code cites 10 from the 1092 datasheet. | Thrust runs 6,752 → 7,315 N (+8.3 %), monotonic, mean 7,013 N, against a 7.2 kN goal. It reaches 7.2 kN only after t ≈ 2.87 s (between the 2.85 s and 2.90 s samples). At an SPE of 10 the end thrust would be 7,112 N, with tanks ending at 598 psia. |
| 6 | Layer X defaults to the GN2 drawing with flight on (`LayerX.tsx:446`, `layerx.ts:71`), and all 24 completed saved burns are GN2 (a 25th, `19b769`, was cancelled). The He drawing cannot be flown: the flight sizes the ullage refill with the config's N2 (it needs 0.521 kg; the bottle holds 0.208 kg He). The run still reports `converged`. | GN2 predicts 4.5 % less mean thrust (6,696 vs 7,013 N), a burn 0.14 s longer, and an ignition dip of 25 psi vs 3.6. There is no apogee for the hot-fire pressurant. With the species fixed it is 3,249 m AGL. |
| 7 | The chug margin is computed on a mixed basis. Line resistance is zeroed (only the dump remains). Inertance comes from the config length, not the drawing. A_t and L* are frozen at the design point (`time_varying_solver.py:464-466` passes `self.config`, although the eroded `config_current` exists at `:380`). On He the minimum falls on the first firing sample (t = dt); on GN2 it falls at t = 0.70 s. | Delivered 1.398 vs Forward 1.509 is mostly the basis change: at the same point the two bases give 1.4075 vs 1.5089. Taking inertance and resistance from the drawing lifts the minimum by about +0.10. The verdict rests on the unmeasured mixing-lag band (nominal 2.18 vs gate 1.33 [doc, GN2 flown run `01c181` at 0.70 s]) and crosses 1 at a 0.19 m fuel run. |
| 8 | Outputs in the ignition window depend on dt, and there is no start transient. Both mains open together on Fire as 50 ms linear ramps, with no fuel lead, priming or ignition delay. | Chug minimum is 1.367 / 1.308 / 1.161 / 0.797 at 50 / 10 / 5 / 2 ms [doc], so at 2 ms it reads "unstable". Delivered impulse falls 0.8 % at 2 ms. The twin's integrals have converged (+12 N·s, 0.05 %, 50 vs 1 ms). The user's heavy fuel lead cannot be represented. |
| 9 | No drawing gives any line a height, and the feed fit writes K0 into the design without guards. | In flight only the tank heads couple (+1.1 to +1.6 psi). With the team's 4.5 ft / 1 ft lines taken as vertical (an upper bound), O/F goes 1.518 → 1.485 and the burn ends fuel-first with 0.073 kg LOX stranded, i.e. an oxidiser-rich shutdown. The feed fit proposes LOX K0 = −0.038 on He, which the schema rejects, and fits K0 4-41 % low on flown runs. |
| 10 | Erosion is implemented correctly (hand checks above) but depends on wall-gas inputs nobody has validated: the ideal CEA Tc, the bulk O/F, and an uncalibrated Bartz coefficient. | Throat growth ranges 1.9-7.3 % across plausible inputs (baseline 4.0 %). Impulse moves ±0.7 %. Burn time moves −0.6 % per 4 % of throat growth. A post-fire throat measurement would settle it. |
| 11 | The GN2 condensation check uses N2's critical pressure, 492.5 psia (`prepare.py:39,489`; the figure comes from `feed-twin/docs/copv-study.md:136`). The physical criterion is p_N2 > Psat,N2(90 K) = 52.3 psia (CoolProp 7.2.0). | The check is silent for any GN2 lockup between ~52 and 492.5 psia over LOX, the whole range where N2 condenses on 90 K surfaces as a true phase change (T_sat 98-126 K at 100-490 psia). Latent heat alone falls as pressure rises (165 kJ/kg at 100 psia, 111 at 300, 20 at 490), but the heat a 90 K surface must take per kg of 293 K gas it liquefies is 390-398 kJ/kg at every pressure from 100 to 578 psia (CoolProp), so the hazard below 492.5 psia is no smaller than above it. It does not affect He, but it matters while GN2 is the default drawing. |
| 12 | Optimise returns its bounds on the impulse objective, because impulse rises monotonically with lockup (the apogee objective was not tested; it can stop short only if `max_apogee_m` binds), and it has no thrust target. A set-point secant answers the real question in 3 burns. | The saved optimise run ended at 600 psia / 4500 psig, both bounds, for +0.47 % impulse in 12 burns. The secant reached 7,200.03 N mean at 600.36 psia (dome 535.9 psig) in one step, on the pad **without the erosion replay** (twin thrust, as-built throat; 6,972 N at 578 psia against the default replay's 7,013 N). On the default basis the 7.2 kN set point is therefore ~4 psi lower, ≈596 psia by the same 10.1 N/psi slope (estimate, not burned). The tanks then peak at 642 psia: over the 600 cap, under the 750 MEOP. |

---

## 2. Decisions waiting for the user

The user asked to be consulted before:
- deleting Optimise;
- changing any default that shifts baseline results;
- refactoring the engine card or the solver loop.

D1-D7 are those decisions. D8-D21 are inputs or choices only the team can supply.

### D1. Thermal defaults: Layer X vs cockpit

**Today.** Layer X turns these off: collapse, vapour, chilldown, stratification, boiling onset and nucleate boiling (`prepare.py:76-79`, `burn.py:50-58`). The cockpit's `Setup()` turns them on (`core.py:384-489`). Line walls are off in both.

Two pieces of documentation are wrong or misleading:
- CLAUDE.md ("the library's are off") and BENCHMARK 3.8 ("library defaults unchanged: all off") are ambiguous. They are true of the vessel-level `Tank` constructor (`vessels/tank.py:206-226`: vapour, wetted conductance, wall boiling, onset and surface layer all zero; collapse, though, defaults to `ConductionCollapse`), and false of the library's `Setup`, which carries the cockpit's on-values (`core.py:384-411`). Layer X's off values come from `burn_setup` and `LayerXSettings`.
- `Setup.chilldown`'s docstring says "Zero -- the default", but the default is 100 (`core.py:433-435`).

| option | effect on LE4 He burn [doc, dt 10 ms] |
|---|---|
| A. Keep today's settings | none |
| B. Cockpit closures on (collapse, vapour, chilldown 100, stratification, onset, nucleate); line walls off | impulse −0.2 N·s; burn −0.4 ms; bottle at burnout −9.1 psi (−0.55 %); tank peak +0.1 psi |
| C. B plus line walls | impulse −4.9 N·s; burn +1.9 ms; bottle **+213.6 psi** (+13 %); tank peak −2.1 psi |
| (not modelled) LOX upper wall at 150 K, fresh press | bottle **−225 psi**; He used +10.7 %; tank sags 578 → 565 psia in the lead-in |

**Recommendation: B, with a fresh baseline.** Every burn figure moves ≤0.02 %; the bottle moves −9 psi.
- Keep line walls off as the deterministic default. Every `fitting_mass` is estimated, and the walls' +212 psi credit is roughly cancelled by the cold upper wall, which is not modelled.
- Add a per-tank ullage-wall T-0 temperature (a Setup field with a Tunable row).
- Sweep line walls on/off together with that temperature in the uncertainty tab, so the bottle margin is quoted as a band.
- Correct the CLAUDE.md/BENCHMARK sentence and the docstring.

### D2. Default drawing (GN2 vs He) and the flight default

| option | what the tab runs out of the box |
|---|---|
| A. Today: `copv_study_gn2`, flight on | gn2_flight: 24,088 N·s, 6,713 N mean, 3.589 s, apogee 3,125 m AGL |
| B. `copv_study_he`, flight on, today's code | the he_pad burn; flight refused ("needs 0.521 kg"); still `converged: true` |
| C. `copv_study_he`, after the flight-species fix | 24,235 N·s, 7,033 N, 3.446 s, apogee 3,249 m AGL (what-if run) |
| D. No default: the run header requires a drawing/pressurant | — |

He vs GN2 on the pad:

| | He | GN2 |
|---|---|---|
| mean thrust | 7,013 N | 6,696 N (−4.5 %) |
| Pc | 399.7 psia | 382.9 psia |
| ignition dip | 3.6 psi | 25.0 psi |
| bottle spare at burnout | 1,068 psi | 626 psi |
| regulator use at burnout | 18 % of choked capacity | 77 % |

**Recommendation: C.** The species fix is a small bug fix.
- Label every saved run and every page with its pressurant.
- Align the backend default (`flight=False`, `prepare.py:90`) with the UI's `flight: true`, either way.

### D3. GN2-on-LOX condensation

| option | effect |
|---|---|
| A. Today: warn above 492.5 psia (N2 critical pressure) | silent for 300-490 psia GN2 lockups |
| B. Warn when p_N2 > Psat,N2(T_liquid), priced with feedtwin's `Fluid` (52 psia at 90 K) | always warns for GN2 over LOX |
| C. B, but as a **fail** for hot-fire runs unless a cold-flow / acknowledge flag is set | GN2 hot fire blocked; water flows unaffected |
| D. A bounding condensation plus cold-upper-wall model in the collapse registry | see below |

For option D: condensation at the liquid surface is bounded at ≤0.4 g (300 s hold) and ≤6.8 g (fresh press), against ~0.29 kg of LOX-side GN2. The cold wall dominates; the literature gives 1.5-3x dry consumption. The model needs one GN2-on-LOX trace to calibrate.

No option changes the He baseline. The gn2 cases gain a warn or a fail.

**Recommendation: C**, because the user says N2 is for water flows. Build D only if a GN2-pressed LOX firing is planned.

### D4. Engine card: refactor, or add an A_t dimension

What the card is today: EngineDesign tabulated at the as-built geometry.
- Injector: φ = ṁ/√Δp over (ṁ, p_inlet), 41x21 per side.
- Chamber: c*_eff and v_vac over (O/F, ṁ_total), 41x41.
- A_t and A_e are scalars.

The twin applies the replay's A_t(t) only in Pc = ṁ·c*_eff/A_t, and one step late. The delivered figures come from the replay, which is a fresh EngineDesign solve at the eroded geometry (checked to <1e-5).

| option | measured effect | cost |
|---|---|---|
| A. Keep | twin thrust +0.50 % at burnout (v_vac at ε 4.83, not 4.64); Pc/ṁ ≤0.10/0.12 % off a fresh ED solve; delivered unchanged | 0 |
| B. Small fixes, no refactor: apply the throat at mid-step; scale v_vac by Cf_vac(ε(t))/Cf_vac(ε0) from the 3D CEA table | lag residual halves (0.10 → ~0.05 %); the 0.5 % thrust bias goes; impulse <0.05 % | small |
| C. A_t as a third card axis (nodes 1.00/1.04/1.08) | interpolation error ≤0.006 %; build +~4 s | small-medium; `CARD_SCHEMA` bump |
| D. Replace the card's chamber with a per-step numba `_point` call | 185 µs per call, 0.56 s per 79 s pass; removes the fit error and the A_t/L*/bore/density gaps; allows per-step geometry | medium; the Python fallback costs 11-24 s/pass if film or regen cooling is on |
| E. Density-aware injector: scale capacity by √(ρ_twin/ρ_card) | LOX +0.46 %, fuel +0.24 % flow at equal Δp (1150.5 vs 1140 and 792.8 vs 789 kg/m³) **[verify pass: 1150.5 / 792.8 is CoolProp at 578 psia, not ρ_twin. The twin prices liquid on the saturated line, 1142.10 / 789.34 (ledger #27), so this option as written moves LOX +0.09 %, fuel +0.02 %. The 0.46 % needs compressed-liquid pricing in the twin as well.]** | small; opt-in |

**Recommendation: B and E now**, both opt-in, with a test asserting zero change when the densities match.
- Do D only if inline erosion (D5) is wanted. D makes C unnecessary.
- Effect on the baseline: delivered figures unchanged; twin thrust −0.25 % mean; E moves O/F by about +0.2 % (not run).

### D5. Inline erosion and flight, or the outer loop

**Measured.**
- The erosion loop settles in 2 passes. Its residual goes 4.0e-2 → 5.5e-5, a contraction of ~1.4e-3 per pass.
- A replay costs 0.7-2 s. A twin pass costs 31-36 s (He).
- Flight adds 2 passes: gn2_flight takes 4 passes and 44 s, against 21 s on the pad.
- The existing `flight_1dof` matches RocketPy's specific force to 0.002 % and apogee to −0.12 %, in 5-33 ms.

| option | effect |
|---|---|
| A. Keep both outer loops | — |
| B. Stop after pass 1 when the replay's growth is < 2e-4 | saves ~35 s, but only for engines that do not erode; LE4 unchanged |
| C. Inline 1-DOF ascent at each twin step (opt-in under `settings.flight`); RocketPy once at the end for apogee, stability and rail exit | removes ~2 flown passes (~−50 % wall time on flown runs); burn figures expected to move <0.05 % (not run) |
| D. Inline erosion at each step (needs D4-D and a per-step wall model) | saves one twin pass (~35 s); large effort |

**Recommendation:** keep erosion as an outer loop; add B; do C for flight. The pad baseline is unchanged by construction.

### D6. Optimise and Trade: rebuild or remove

**Measured.**
- The saved optimise run ended at 600 psia / 4500 psig. Both are bounds. It gained +0.47 % impulse in 12 burns and 127 s.
- Impulse rises monotonically with lockup: 23,512 → 24,193 N·s over 491-600 psia.
- O/F moves only −0.087 % over 578-625 psia; one regulator cannot set it.
- A set-point secant gave 6,972 / 7,196 / 7,447 N at 578 / 600 / 625 psia (pad, no erosion replay: the twin's as-built thrust). That is linear at 10.0-10.2 N/psi. One secant step reached 7,200.03 N at 600.358 psia. With the default replay the mean is 41 N higher at 578 psia (7,013 N), so the replay-basis set point is ≈596 psia (estimate, not burned).

| option | consequence |
|---|---|
| A. Keep both | returns the cap; no thrust target; the tank cap is checked only at T-0 |
| B. Remove Trade, keep Optimise | the same |
| C. Remove Trade and the current Optimise. Rebuild as "Set point": the dome dial and fill for a target mean thrust, in 4-5 burns (~3-5 min), verified with the replay. Add a Hardware mode later, and only with cited catalogue data. Injector holes stays and emits the same diff format. | the saved jobs (2 trade, 1 optimize) stay readable as legacy, read-only |

**Recommendation: C.** It does not change the baseline. It needs D11 (whether the tank limit applies at T-0 or at peak) and D12 (the design O/F reference) decided first.

### D7. Chug feed impedance from the drawing

| option | burn-minimum gate |
|---|---|
| A. Today: config length, dump-only R, design-point A_t/L*, ignition sample included | 1.398 He / 1.355 GN2; [doc] 1.367 / 1.330 (the [doc] GN2 figures in this table are from the flown run `01c181`; the [doc] GN2 pad burn gives 1.323, section 8) |
| B. Drawing inertance (Σ L/A, tank outlet → line exit) | [doc] 1.352 / 1.315 (−0.015) |
| C. B plus the twin's tank-outlet → line-exit drop as R | [doc] 1.468 / 1.431 (+0.10); YAML ~1.50 |
| D. C plus the eroded geometry (`config_current`) | minimum +0.004; burnout +0.08 (He [doc] 1.489 → 1.575) |
| E. Grade from the first fully-open step; report the start separately | removes the dt dependence (1.367 → 0.797 at 2 ms) |

Three fixes belong with any option:
- Zero `supply_K` in `line_exit_config`. Otherwise the gate falls 1.330 → 1.248 after a feed-fit write, with no physical cause.
- Report the frequency at the gate, ~22 Hz. The 34.6 Hz reported today is the nominal-lag crossover, not the gating one.
- Show the length provenance: every drawn line length is "estimated".

**Recommendation: D and E.** Ship them opt-in first, with a test proving the old basis is reproduced. Then make them the default with a new baseline (the chug minimum rises about 7 %).

This does not make the margin trustworthy. Two unmeasured inputs dominate it: the mixing-lag band and the fuel line length. Measure the fuel run, and look for 20-40 Hz content in stand Pc.

### D8-D21. Inputs and choices only the team can make

| # | question | measured stake |
|---|---|---|
| D8 | Which is LE4? `configs/ethalox_6800N.yaml` has GR001CC graphite and the team's 4.5 ft / 1 ft lines. The app document has 2260 kg/m³ graphite and 3 ft / 4 in lines. Commit the chosen YAML (it is untracked). | throat growth 4.00 vs 5.69 %; chug minimum 1.398 vs 1.367 |
| D9 | Regulator supply-pressure effect: 17 psi/1000 psi (drawing, TB 1031) or 10 (EngineDesign's 1092 datasheet note, `feed_pressure_model.py:57-66`)? Set `design_requirements.regulator_supply_pressure_effect` to the same value. | end thrust 7,315 vs 7,112 N; tank end 618 vs 598 psia; impulse +61 N·s |
| D10 | Constant thrust: accept the ramp, target the mean (600.36 psia for 7.2 kN without the erosion replay; ≈596 psia estimated with it), or change the regulator or dome strategy? | +448 N within the burn at a 7.2 kN mean |
| D11 | Tank limits: is the config's 600 psi a T-0 or a peak limit? What is the LOX tank rating? Should the fuel's 750 psi MEOP go on the drawing as its own field? | peak 619 psia in the baseline; 642 psia at the 7.2 kN set point |
| D12 | One design O/F reference for grading: 1.5 (`optimal_of_ratio`) or Forward's 1.523? | LE4 runs at 1.521 |
| D13 | Is the COPV topped up after the tanks are pressed? | without top-up the T-0 bottle is ~2,650 psia and ends at 534 psia, below lockup: −1.8 % mean thrust |
| D14 | The He regulator droop is a GN2 back-fit tagged "measured", so the sweep holds it exact. Re-tag it, scale it, or measure it on He? | lift-scaled: −0.49 % mean thrust; ignition dip 6.0 vs 3.6 psi |
| D15 | Fuel concentration: anhydrous, 95 % or 75 %? Nothing models a blend. | 75 %: c* −4.8 % at O/F 1.5, ideal Isp −9.5 s. 95 %: maximum c* −0.7 % |
| D16 | The nozzle efficiency of 0.95 has no source (schema default). | 0.975 would give +2.6 % thrust (~7,200 N mean) |
| D17 | Which liner material? All its properties are schema defaults. What case sits behind the liner and the insert? | barrel recession 1.16 mm, doubling at T_abl 1500 K; insert back face 2,326 K (adiabatic) |
| D18 | Is a heat-flux model for the copper faceplate wanted? Nothing computes face heating. | margin unknown |
| D19 | Vehicle data: which rail (the 3.35 m default gives 71 ft/s, under FAR-OUT's 85 ft/s); the liftoff mass (82.41 kg config-derived vs 86.18 kg in the tests); a contract apogee with provenance; the measured tank-to-injector drops. | a 20 ft rail gives 95.9 ft/s; surface roughness alone moves apogee ±200 m |
| D20 | Simulate and grade a pad hold (LOX self-pressurisation), or relabel "peak over hold and burn" as "lead-in and burn"? | not quantified |
| D21 | Both configs carry stale LOX properties: μ 1.8e-4 vs 2.03e-4 Pa·s, cp 2300 vs 1699 J/(kg·K), bulk modulus 1.5 vs 0.98 GPa. Clear them so CoolProp is used? | Cd effect negligible; false pogo/surge mode-coupling flags |

---

## 3. Coupling map

Timing values:
- *live per step*: every twin coupling step.
- *per replay point*: 28 EngineDesign solves, interpolated.
- *per outer pass*: fixed-point iteration between whole burns.
- *frozen at design point*: evaluated once, at the as-built state.
- *assumed constant*: a number, not a model.
- *not coupled*: nothing crosses.

| # | quantity | from → to | timing | where |
|---|---|---|---|---|
| 1 | Line-exit pressures; flows back | feedtwin network ↔ engine card injector legs | live per step (root-solved to 0.02 psi) | `feedtwin/session/core.py:1852`; `prepare.py:43` |
| 2 | Chamber Pc = ṁ·c*_eff(O/F, ṁ)/A_t | engine card → network chamber node | live per step | `feedtwin/engine/card.py:412-413` |
| 3 | Injector capacity ṁ/√Δp (Lichtarowicz Cd, Nurick cap, ring manifold) | ED at config ρ, μ, Pv → twin injector legs | frozen at design point | `feedtwin/engine/component.py:78-90` |
| 4 | Propellant density and temperature at the injector | twin → engine card | **not coupled** | `feedtwin/engine/card.py:222-230` |
| 5 | c*_eff and v_vac (as-built A_t, L*, ε, bore) | card → twin Pc and thrust | frozen at design point | `feedtwin/engine/card.py:412-421` |
| 6 | Feed loss K0/K1 | zeroed in the card; the drawing's lines carry the loss | replaced | `engine/layerx/card.py:86-99` |
| 7 | Borda dump (K_exit 1, A_hydraulic, config ρ) | ṁ → series dump, manifold, stiffness | frozen at design point (post-processing) | `analysis.py:435-453, 504-511` |
| 8 | Line-exit pressure history (28 points + Fire lead) | twin → TVS replay | per outer pass | `replay.py:60-83` |
| 9 | Throat area A_t(t) | replay → twin `chamber.throat_area` | per outer pass, applied per step one step late | `analysis.py:88-93` |
| 10 | Eroded V, D, ε, L* | replay → twin | **not coupled** (only A_t) | `time_varying_solver.py:372-386` |
| 11 | Gas-side wall loads (Bartz h, T_aw, radiation, mass flux) | replay step k → walls over [t_k, t_k+1] | per replay point (explicit) | `time_varying_solver.py:372, 418-430` |
| 12 | Throat composition (H2O, CO2, OH, O2, O) | CEA equilibrium at instantaneous bulk O/F, Pc → carbon oxidation | per replay point | `time_varying_solver.py:425`; `cea_cache.py:1254-1265` |
| 13 | Wall gas temperature = ideal CEA Tc (no η_c*) | CEA → all wall stations | assumed (conservative) | `time_varying_solver.py:426` |
| 14 | Wall heat loss η_HL (quasi-steady liner at 1986 K) | liner model → η_c* | per replay point, quasi-steady | `chamber_solver.py:1000-1021` |
| 15 | Ambient pressure for thrust | site 94.07 kPa → card and replay | assumed constant (also in flight) | `link.py:154`; `replay.py:78-79` |
| 16 | Pc, ṁ, ΔP_inj, c*, R, Tc, SMD, lags | replay → chug loop | per replay point (28, interpolated) | `time_varying_solver.py:457-468`; `replay.py:124, 191-194` |
| 17 | Chug feed inertance L/A | config `feed_system.length` → chug | assumed constant (drawing unread) | `stability/analysis.py:438-459` |
| 18 | Chug feed resistance 2ΔP_feed/ṁ | closure on the line-exit config (dump only, minus `supply_K` share) → chug | per replay point, wrong basis | `stability/analysis.py:653-656, 902-910` |
| 19 | Chug A_t, L* | `self.config` (design) → chug K_c, θ_c | frozen at design point | `time_varying_solver.py:464-466` |
| 20 | Regulator and ullage impedance | feedtwin → chug | **not coupled** (`Z_hf` 0; measured < 0.005 GM) | `chug.py:38-59` |
| 21 | Mixing-lag band 0-1 | config → chug gate | assumed constant | `stability/analysis.py:779-785, 863-899` |
| 22 | Chug margin | replay → UI verdict only (optimiser uses ΔP/Pc) | per outer pass | `replay.py:216-224`; `optimize.py:19` |
| 23 | Axial specific force (T + (p_ref − p)A_e + R3)/m | RocketPy → `Setup.body_acceleration` | per outer pass, applied per step one step late | `flight.py:214-230, 274, 309`; `analysis.py:94-99`; `core.py:2316, 2324` |
| 24 | Tank head ρ·a·level | TankSim → outlet node | live per step (hand check 0.0001 psi) | `core.py:763-764, 2036-2038`; `tank.py:423-435` |
| 25 | Line heads ρ·a·Δz | network gravity → branches | live per step, but every Δz = 0 on all drawings | `solve/network.py:296-308`; `elements.py:161-162, 847-848` |
| 26 | Delivered thrust and ṁ curve | replay → RocketPy motor and tanks | per outer pass | `analysis.py:190-194`; `replay.py:228-285` |
| 27 | Altitude ambient → thrust | RocketPy only; not in replay or in-flight figures | not coupled (+52.6 N·s left out) | `flight_sim.py:938-957`; `replay.py:78`; `analysis.py:247-260` (the per-step ambient there is display only) **[corrected: cited `replay.py:79`, which is the call's closing parenthesis]** |
| 28 | Pressurant species → flight refill and mass | config `ullage_gas` N2, not the drawing | assumed constant (**BUG**) | `flight_sim.py:319-329, 781, 851-903`; `flight.py:145-184` |
| 29 | CG and static margin | config template layout (6.44/6.20 L tanks) → RocketPy | not coupled to the drawing | `flight_sim.py:564-650` |
| 30 | Acceleration → buoyant convection | constant G = 9.80665 | frozen at design point | `vessels/convection.py:28`; `core.py:670-693` |
| 31 | Altitude → dome reference and vents | trajectory → regulator | not coupled | `feedtwin/session/core.py:1661-1675` (dome = PR_C's zero-flow outlet at `from_psig(Setup.dome_psi)`; nothing reads the trajectory); `feedtwin/session/gauge.py:28,39-42` (gauge zero fixed at 101,325 Pa); vents: `burn.py:56` (`auto_vent` off) and every vent CLOSE in the Fire column of `diablo_actuators.csv` **[corrected: the only citation was `docs/layer-x.md:459`, a doc line that names the vents but not the dome]** |
| 32 | Regulator supply-pressure effect | PR_D inlet pressure → outlet target | live per step (+48.7 psi over the He burn) | `regulator.py:182-195` |
| 33 | Dome (PR_C zero-flow outlet; no SPE on drawing) | bottle → PR_D setpoint | live per step, constant 528.25 psia | `core.py:1661-1675` |
| 34 | Dome dial for the target lockup | settings → `Setup.dome_psi` | frozen at design point (solved once at T-0) | `prepare.py:447` |
| 35 | Valve positions (linear 50 ms slew) | state machine → network | live per step, held per `_integrate` | `core.py:1695-1727, 2314` |
| 36 | LOX upper-wall temperature at T-0 | prime → ullage energy balance | assumed constant (293.15 K) | `core.py:1494`; `tank.py:508` |
| 37 | Bottle inventory at T-0 | drawing → bottle (pre-press gas not charged) | assumed constant | `burn.py:11-15, 180-187` |
| 38 | Vessel MAWP trip | `Session._check_limits` → Layer X loop | **not coupled** (**BUG**) | `burn.py:233-304`; `core.py:2840-2867` |
| 39 | Fitted K0 and `supply_K` | final pass → design write | per run, manual | `feedfit.py:59-80, 126-160` |
| 40 | Optimiser candidates | one card centred on the range midpoint, no replay, T-0 tank cap | frozen at design point | `optimize.py:105-115, 154-168, 309-314` |

**One-way couplings that should be two-way, or are missing a direction**
- Propellant state (ρ, T, Pv) from twin to card (#4). Any modelled LOX warming would be invisible. **[corrected: said "costs 0.46 % LOX flow today".]** The twin itself prices liquid on the saturated line at T (`comps/elements.py:1071-1098`, `solve/network.py:117` `multiphase` off): 1142.10 / 789.34 kg/m³, the same at any pressure. Against the card's 1140 / 789 that is +0.09 % / +0.02 % in flow at equal Δp. The 0.46 % / 0.24 % is the card against compressed liquid at the burn's pressure (CoolProp 1150.5 / 792.8), which the twin does not model either (twin −0.37 % / −0.22 % against it).
- Eroded L*, ε, V and bore from replay to twin (#10). Twin thrust is +0.5 % at burnout.
- Drawing L/A and the twin's per-side line drop into the chug loop (#17, #18). Worth +0.10 GM.
- Eroded geometry into the chug loop (#19). Worth +0.08 GM at burnout.
- Twin trip state to Layer X (#38). Safety.
- Drawing pressurant species to the flight mass budget (#28). Blocks He flight.
- Altitude ambient to the replay's in-flight figures (#27), and to the dome reference (#31: the code is verified to have no altitude input; how far a real bonnet-vented control regulator would move is not verified).
- Acceleration to buoyant convection (#30). h ∝ a^(1/3), about x2 at 8-9 g; not quantified.
- Twin ṁ to the RocketPy mass history. The flight flies the replay's ṁ and cuts thrust 1.2 ms early.
- Regulator and ullage impedance to chug (#20). Bounded below 0.005 GM; report it as a bound and do not couple it.

**Design-point quantities used over the burn**
- Card c*_eff and v_vac at the as-built A_t, L*, ε and bore (#5).
- Injector fluid properties at the config constants (#3). LOX 1140 kg/m³ and stale μ.
- Chug A_t and L* (#19), the config feed length (#17), the mixing band (#21).
- The dome dial, solved at T-0 for the planned fill (#34). Correct for a hand-set dome; the result must say which fill it assumes, because the dome moves 17 psi per 1000 psi of fill.
- The optimiser's tank cap and bottle headroom, compared against T-0 lockup rather than the burn peak or the regulator outlet at burnout (#40).
- Nozzle efficiency 0.95, lumped and without a source.
- Wall gas temperature at the ideal Tc (#13). Conservative.
- Site ambient for replay thrust during flight (#15).
- Buoyant convection at 1 g (#30).
- The dump, priced at the config density and A_hydraulic (#7).

**Verify pass (2026-10-02).** Each row's file:line was opened against the working tree. 38 of the 40 rows show what they claim. Two had citations that did not: #27 (an off-by-one line) and #31 (a doc line, not code). Both are corrected above. The verdicts of #27 and #31 stand. The density bullet under "One-way couplings" was wrong and is corrected. These numbers were not re-derived here: the +52.6 N·s (#27), and the "< 0.005 GM" and "+0.10 GM" chug bounds (#20, #17/#18). On the +52.6 N·s, a bound from the audit's own 437 m burnout altitude, ∫Δp_amb·A_e dt ≈ 47 N·s, is the same size.

---

## 4. Assumption ledger

Each row reads: EngineDesign assumes X at the design point → where Layer X gets the actual value → whether it is replaced → the series key a "Design assumed X → feed delivers Y(t)" row would use. The **Design** column must come from one Forward solve at the burn's lockup, not from config fields. `design_thrust`, `design_pressure`, `design_MR`, `target_*` and `thrust.burn_time` are stale 6.5 kN values.

| # | EngineDesign assumes (value) | Layer X actual (He pad) | replaced | series key |
|---|---|---|---|---|
| 1 | Constant tank pressure 578.0 / 578.0 psia | 578.05 → 574.41 (dip 3.6) → 618.35 LOX; 578.12 → 619.00 fuel | yes | `series.{ox,fuel}.tank_psia`; `summary.*.{t0,min,end,peak}_psia` |
| 2 | Regulator SPE: none in Forward, and none in Layer 2 either **[corrected: said "0.010 in Layer 2"]**. Layer 2 calls `dome_regulated_tank_pair` with no COPV inlet history and no regulator (`layer2_pressure.py:1961-1963`), so it returns the flat setpoint (`feed_pressure_model.py:98-105`; `RegulatorModel` SPE default 0.0 at :33). The 0.010 default is only in `regulator_from_config` (`feed_pressure_model.py:57-66`), which nothing calls. | drawing 17 psi/1000 psi: outlet 576.85 → 623.93 psia | yes (sources disagree, D9) | `series.regulators.PR_D.outlet_psia` |
| 3 | Pressurant: config N2, 4.619 L, 1.312 kg | drawing He, 4.6871 L, 4500 psig: 4514.5 → 1646.3 psia, 0.209 → 0.118 kg | yes (twin); flight still uses N2 | `series.copv_psia`, `copv_mass_kg`, `copv_wall_K` |
| 4 | Feed loss as one K: K0 0.643 / 2.019 (line 16.2 / 31.6 psi) | drawn lines LOX 17.9 → 20.7 psi, fuel 33.2 → 38.2 psi (hand check 17.93 / 33.19 at the first step, 20.66 / 38.17 at the last **[corrected: said 17.9 / 32.7]**: exact Colebrook via `fluids.friction_factor`, the drawing's 0.0015 mm roughness, K_minor 0.5, valve Cv 26.1, the twin's own ρ and μ; within 0.4 % of the twin, so there is no 0.5 psi fuel-side gap) | yes | `outlet_psia − inlet_psia` |
| 5 | Exit dump K_exit 1 at A_hydraulic, config ρ | same: LOX 24.85 → 28.67 psi, fuel 15.46 → 17.94 psi | no (by design) | `series.*.dump_psi` |
| 6 | `supply_K` 0 | feed fit K_supply −0.753 / −1.231; proposed LOX K0 −0.0379 (rejected by schema) | partly, broken | `result.feed_fit.sides.*` |
| 7 | Chug feed inertance from config length 0.3048 / 1.3716 m | drawing 0.14 / 0.9644 m ("estimated") is not used | no | — |
| 8 | Chug feed resistance: full dp_feed 41.3 / 47.3 psi | dump only on the line-exit config: 24.85 → 28.71 / 15.46 → 17.97 psi over the burn's replay points (25.2 / 15.7 is the dump at Forward's flows) **[corrected: gave only the Forward-flow values]** | no (dropped) | `delivered.chug_margin` |
| 9 | Regulator in the chug loop: ideal source (`Z_hf` 0; the 3 Hz corner has no effect) | not coupled | no | — |
| 10 | Chamber pressure 393.2 psia (Forward) | 390.4 → 405.2, mean 399.7 | yes | `delivered.pc_psia` |
| 11 | Thrust 6,803.7 N (Forward); goal 7.2 kN | 6,752 → 7,315 N, mean 7,013 N | yes | `delivered.thrust_N` |
| 12 | Throat area 1794.7 mm² constant | A_t/A_t0 1.0003 → 1.0400; 0.474 mm recession | yes (rates unvalidated) | `delivered.throat_area_ratio`, `recession_throat_mm` |
| 13 | ε 4.8276 | 4.826 → 4.642; p_exit 14.10 → 15.41 psia (ambient 13.64) | yes | `delivered.eps`, `p_exit_psia` |
| 14 | L* 1.3586 m | 1.358 → 1.353 m (twin card stays as-built) | partly | `replay.Lstar_m` |
| 15 | η_c* 0.9105 (E_m and SMD assumed) | 0.9102 → 0.9125 from the same model at each point | partly | `replay.eta_cstar` (not in `delivered`) |
| 16 | Orifice Cd 0.784 / 0.776 (Lichtarowicz) | Cd_eff 0.7817 / 0.7750, constant to 0.03 % | no | derived |
| 17 | O/F 1.5 (`optimal_of_ratio`), Forward 1.5232 | 1.5242 → 1.5194 (falls monotonically over the burn), mean 1.5211; LOX dry first, 58 g fuel left | yes | `delivered.mr` |
| 18 | Momentum ratio R 1.0304; Rupe M 1.1774 | R 1.0311 → 1.0279; M 1.1790 → 1.1716 (both fall with O/F: R = 0.6765·O/F, M ∝ O/F²) **[corrected: the arrows ran min → max and read as rising]** | partly (derived) | none (derive) |
| 19 | Injector ΔP/Pc band 0.20-0.40 | LOX 0.3627 → **0.4030** (above 0.40 for t 3.35-3.46 s); fuel 0.3473 → 0.3879 | yes | `series.*.stiffness` |
| 20 | Flows ṁ_O 1.8633, ṁ_F 1.2233 kg/s | 1.852 → 1.990, 1.215 → 1.310 kg/s | yes | `delivered.mdot_O/F` |
| 21 | Isp 224.77 s | 224.5 → 226.0, mean 225.39 s | yes | `delivered.isp_s` |
| 22 | Burn time 3.994 s (stale field) | 3.456 s | yes | `summary.burn_time_s` |
| 23 | Impulse = load x Isp: 24,281 N·s | 24,240 N·s (−0.17 %) | yes | `delivered.summary.total_impulse_Ns` |
| 24 | Propellant load 6.611 / 4.404 kg (competition rule) | config | no (by design) | — |
| 25 | Tank volume 6.444 / 6.202 L | drawing 15.10 / 8.67 L (preflight warns) | yes (twin); flight CG still uses config | `series.*.fill_fraction` |
| 26 | Ullage gas N2 at 293.15 K | He; LOX ullage 292.5 → 283.2 K | yes (twin) | `series.*.ullage_K` |
| 27 | Propellant ρ in engine: LOX 1140, EtOH 789 kg/m³ | twin 1142.10 / 789.34 at the injector (saturated liquid at 90 / 293.15 K, independent of pressure: `comps/elements.py:1071-1098`, `multiphase` off at `solve/network.py:117`), not passed to the card. Compressed liquid at the burn's 557-598 psia inlet is 1150.2-1150.8 / 792.6-792.8 (CoolProp), which neither the twin nor the card uses. **[corrected: said "twin 1150.5 / 792.8"; that is CoolProp at 578 psia, not the twin]** | no | `series.*.liquid_K` |
| 28 | Anhydrous ethanol | same | no | — |
| 29 | Ambient 94.07 kPa (627 m) | same on the pad; altitude only inside RocketPy | partly | `delivered.ambient_psia` |
| 30 | No hydrostatic head | 1 g tank head 0.48 / 0.34 psi; flight a(t); no line heights | partly | `outlet_psia − tank_psia` |
| 31 | Nozzle efficiency 0.95 (no source) | same | no | — |
| 32 | Steady start | both mains open at Fire, 50 ms linear; no fuel lead or priming | no | — |
| 33 | Unusable residual: none | `dry_kg` 1 g | no (needs a measurement) | — |
| 34 | Maximum tank pressure 600 psi | peak 618.35 / 619.00 psia, graded only against MAWP 1000 (estimated) | not graded | `summary.*.peak_psia` |
| 35 | Thermal state: adiabatic tank and lines | Tanks are **not** adiabatic in Layer X: each ullage exchanges heat with its upper wall, which starts at 293.15 K (`core.py:1494`, `tank.py:508`), through a still-gas film estimated at session build (`Setup.wall_hA_from_gas` true, `core.py:506, 1523-1545`): hA 18.4 W/K LOX, 11.5 W/K fuel in this run's notes. The film is ×20 while a tank sits more than 2 % under its supply (`core.py:899-904`). The LOX wetted wall starts at 90 K (`split_wall`, `tank.py:514`) but is inert with chilldown 0. Lines are adiabatic (line walls off). Collapse, vapour, chilldown, stratification, onset and nucleate are off. LOX ullage 292.5 → 283.2 K. **[corrected: said "thermal closures off; walls at 293.15 K" and "not replaced"]** | partly (ullage-wall exchange only) | `series.*.ullage_K`, `series.*.liquid_K` |
| 36 | Bottle full at T-0 | pre-press gas (79.6 g He) not charged to the bottle | no | `series.copv_psia` |
| 37 | Wall gas temperature for erosion: ideal Tc | same, 3232 K | no | — |
| 38 | Case and back-face boundary: adiabatic (no case declared) | same | no | — |
| 39 | Ablator properties: schema defaults (ρ 1600, k 0.35, H 2.5 MJ/kg, T 1986 K) | same | no | — |
| 40 | Graphite k at room temperature (92.67 W/m·K), constant | same; only cp(T) modelled | no | — |
| 41 | Vehicle: 3.35 m rail, 4.0 m payload section, template tank layout, 60 µm roughness drag | same | no | `flight.*` |
| 42 | Pressurant mass in flight 1.312 kg | twin T-0 bottle (1.454 kg GN2, 0.208 kg He) | yes | `flight.mass_budget` |

**Verify pass (2026-10-02).** The he_pad burn was re-run at default settings. It reproduced the baseline bitwise (24,239.795689323 N·s). Every "Layer X actual" number was read from that run. Forward was re-run at 578/578 psia: Pc 393.22 psia, F 6,803.7 N, Isp 224.77 s, O/F 1.5232, η_c* 0.9105, Cd 0.7843/0.7764, R 1.0304, M 1.1774, dp_feed 41.34/47.31 psi, Tc_ideal 3,231.9 K. Config values were read from `configs/ethalox_6800N.yaml` and drawing values from `copv_study_he.json`. Independent checks:
- He pre-press gas, CoolProp: 12.40 L of ullage at 578 psia and 293 K holds 79.6 g.
- GN2 bottle, CoolProp at 4,513.9 psia and 293.15 K: 1.456 kg.
- Ambient at 626.67 m, isothermal barometric formula: 94.07 kPa.
- Load × Isp: 11.0152 kg × 224.77 s × g0 = 24,281 N·s.
- Cd_eff from the twin's ṁ and Δp_inj at config ρ: constant to 0.003 % (LOX) and 0.03 % (fuel).
- O/F, R and M fall monotonically over the burn.

Rows corrected: #2, #4, #8, #18, #27 and #35 (#17 was corrected concurrently by another edit). The same errors were corrected in §9.7 and noted on D4-E. The schema rejection of a negative K0 is confirmed at `config_schemas.py:339` (`ge=0`).

---

## 5. Inconsistencies and bugs

### 5.1 The requested checks

| check | verdict | evidence | recommendation |
|---|---|---|---|
| **Thermal defaults** (Layer X vs cockpit) | **RISK** | Layer X closures off (`prepare.py:76-79`, `burn.py:50-58`), cockpit on (`core.py:384-489`). Full cockpit moves the burn ≤0.02 % and the bottle −9.1 psi [doc]. Line walls +212 psi; cold upper wall −225 psi. Docs say the library's defaults are off: true of the vessel `Tank` constructor, false of the library's `Setup` (D1). `chilldown` docstring stale (`core.py:433-435` says zero is the default; the field is 100.0). | D1. |
| **GN2 condensation** | **BUG** | `N2_CRITICAL_PSIA = 492.5` (`prepare.py:39`) is N2's critical pressure (CoolProp 492.52 psia). Its origin is `feed-twin/docs/copv-study.md:136-138`, which also quotes N2 at 550 psia as 640-755 kg/m³ at 90-120 K; CoolProp 7.2.0 gives 758 (90 K) to 561 kg/m³ (120 K). The warning text itself (`prepare.py:490-494`) says gas use is set by the cold wall, not by surface condensation, so the gate, not the message, is wrong. N2 condenses on 90 K surfaces above Psat = 52.3 psia; at 300 psia T_sat = 116 K, h_fg 111 kJ/kg. Liquid-surface bound ≤6.8 g; cold wall dominates. N2 at 578 psia: 293 kg/m³ at 130 K vs 50.5 at 270 K. No effect on He. | D3. |
| **In-flight head**: specific force, 1 g on the pad, no double-counted g | **OK** | `axial_acceleration` = (T + Δp·A_e + R3)/m, no gravity term (`flight.py:214-230`); it replaces gravity (`core.py:2316, 2324`). Liftoff 8.2500 g vs T/m 8.2497 g; tank head hand vs sim ≤0.0001 psi. Double-counting would read 4.46 psi instead of 3.975 (the LOX head at liftoff: 3.975 × 9.25/8.25 = 4.457). Pad passes 1.0000 g0 exactly: on the pad the stand's reaction is the only non-gravitational force, so the specific force is +1 g, the `Setup.body_acceleration = GRAVITY` default (`core.py:525`) until the first flown step overrides it (`analysis.py:94-99`). Agrees with kinematic + g to ≤0.03 % over 0.05-3.40 s. | Two minor defects: pressure thrust is added after burnout (coast reads +0.34 g at apogee vs 0; the burn never uses it); the pre-liftoff hold is not handled (latent; T/W = 8 at the first step). Gate the pressure term on `burn_out_time`. |
| **Engine card** with a moving throat; its real input dimensions | **RISK** | Inputs: injector (ṁ, p_inlet), chamber (O/F, ṁ_total); A_t, A_e scalars; no A_t, L*, ε or density axis. A_t(t) enters only through Pc, one step late. Twin vs fresh ED at the eroded geometry: Pc +0.10 %, ṁ −0.12 %, thrust +0.50 % at burnout. Fit 0.02-0.06 % in the envelope; box `closed_mdot` 0.36 %, above the 0.2 % tolerance and not gated. Card density 1140 vs twin 1150.5 kg/m³. Burns without the replay (optimiser and uncertainty) miss −1.8 % Pc / +2.0-2.2 % ṁ at burnout. | D4 (B + E). Flag off-hull steps during start transients. Say on uncertainty and optimiser outputs that they exclude erosion. |
| **Erosion O/F and species** | **OK** (as implemented) / **RISK** (inputs) | Uses the replay's instantaneous MR (1.524 → 1.519), Pc and ṁ/A_t(current). Throat composition is CEA equilibrium at bulk O/F: at burnout H2O 0.4665, CO2 0.1524, OH 0.0266, O2 0.0044, O 0.0023. Oxidisers are H2O, CO2, OH, O2, O. Mixed regime: kinetics carries 58 % of the resistance. Hand check 0.439 vs 0.4389 kg/m²s. Gaps: no near-wall O/F, no fuel lead, ideal Tc, O2/O always diffusion-limited (~15 % of recession from cold-wall OH/O2, conservative). Sensitivity: 1.9-7.3 % throat growth. | Carry a Bartz multiplier and the wall O/F in the uncertainty sweep, with the replay inside it. Consider the outer stream tube's O/F (already computed). Calibrate on a post-fire throat measurement. |
| **Chug margin timing** | **BUG** | Computed at 28 replay points and interpolated. The minimum falls on the first firing sample (He: t = dt), so it depends on dt. A_t and L* frozen (`time_varying_solver.py:464-466`; burnout A_t +5.75 % [doc] not seen). "Ignition included" label (`replay.py:216-217`, `LayerXResult.tsx:164`) is wrong: the first sample is already at 389.5-390.5 psia. Reported frequency (34.6 Hz) is not the gating one (~22 Hz). | D7. Relabel "from the first full-flow step". |
| **Timestep convergence** (10 / 5 / 2 ms) | **OK** (twin integrals) / **BUG** (ignition window) | See the table below. dt is the sampling and coupling interval, not the integration step: 50 ms runs as 2 x 25 ms (`core.py:2182`, `round(0.05/0.02)` = 2 by half-to-even; 10 ms and below run as one step), with RC-limited coupling steps of 3-15 ms. Hand check of the RC rule τ = (m_ull/p)(droop/rated), He at 578 psia, CoolProp: fuel 2.98 ms, LOX 8.94 ms at T-0, matching the 2.95 / 8.9 ms in 9.5. Line constants (LOX 1.2 ms, fuel 4.9 ms; τ = (ΣL/A)·ṁ/(2ΔP_leg) reproduces 1.19 / 4.94 ms from 9.5's inputs) and chamber filling (2.1 ms) are unresolved at any dt, because the network is algebraic. Baseline [YAML]: dt 0.1 / 0.02 s moves delivered impulse +0.078 / −0.056 %; this does **not** extrapolate to dt → 0 (see section 8). The 2 ms delivered loss is the first-replay-point artefact, and it checks by hand: (6,752 − 3,871 N)/2 × 0.128 s replay spacing ≈ 184 N·s, against the 195 N·s measured. | Keep 50 ms. Exclude t < valve travel + a few line τ from graded minima, and take the twin's own thrust for steps before the first replay point. Add a dt-invariance test (50 vs 5 ms, delivered impulse within 0.1 %, chug within 0.01). Do not offer <10 ms until then. |
| **Fixed-point convergence criterion** | **OK** | Residual = max over the new replay instants of \|A_old(t)/A_new(t) − 1\| (`replay.py:146-154`), tolerance 2e-4 (`replay.py:42`), no relaxation, `MAX_PASSES` 4. He 4.02e-2 → 5.54e-5; GN2 4.06e-2 → 4.75e-5 (contraction ~1.4e-3). Flight: `ACCEL_TOLERANCE` 0.5 % (`flight.py:45`); pass 3 0.48 %, pass 4 0.003 %. Pass 3 already meets the acceleration tolerance; pass 4 is forced by the throat, whose schedule moved 3.2-3.5e-4 (> 2e-4) once the flight's acceleration was applied (saved runs `8aec95`, `01c181`, `7e47d1`; `analysis.py:182, 204` needs both). Replay point density converged (28 points within 0.003 pp of 70). | Caveats (low): at least 2 passes always; burn time (moves 21 ms) and Pc/ṁ agreement are recorded but not tested; only the last replay is kept; per-pass growth is relative to the first sample (3.977 %), the headline to as-built (4.005 %). |

**Timestep numbers** [doc, He, pad]:

| dt | 50 ms | 20 ms | 10 ms | 5 ms | 2 ms | 1 ms |
|---|---|---|---|---|---|---|
| twin impulse, erosion off [N·s] | 24,247.1 | 24,239.8 | 24,237.9 | 24,236.9 | 24,236.2 | 24,234.8 |
| burn time, erosion off [s] | 3.4776 | 3.4776 | 3.4779 | 3.4784 | 3.4790 | 3.4794 |
| bottle at burnout, erosion off [psia] | 1645.64 | 1645.63 | 1645.47 | 1645.36 | 1645.08 | 1645.14 |
| fuel ignition dip, erosion off [psi] | 3.71 | 5.17 | 5.50 | 5.96 | 6.11 | 6.05 |
| `stiffness_min_ignition` LOX, erosion off | 0.3626 | 0.3610 | 0.3481 | 0.3111 | 0.2209 | 0.2209 |
| settled min ΔP/Pc LOX (t ≥ 0.2 s), erosion off | 0.36304 | 0.36315 | 0.36304 | 0.36303 | 0.36303 | 0.36301 |
| **delivered impulse, erosion on** [N·s] | 24,233.1 | 24,217.5 | 24,204.4 (−0.12 %) | 24,166.8 (−0.27 %) | 24,038.1 (**−0.80 %**) | — |
| **chug minimum, erosion on** | 1.367 | 1.358 | 1.308 | **1.161** (amber) | **0.797** (red) | — |
| throat growth, erosion on | 5.694 % | 5.693 % | 5.679 % | 5.644 % | 5.575 % | — |

### 5.2 Other issues, high severity

| issue | evidence | recommendation |
|---|---|---|
| MAWP trip ignored by Layer X | No reader of `session.tripped` in `burn.py` or `engine/layerx/`; `step()` returns the frozen frame (`core.py:2165-2172`). With TK-FUEL at 600 psi [doc]: 99,478 N·s, 14.000 s, frozen 7,150 N. With TK-FUEL at 750 psi (YAML, replay off): lockup 718 psia completes (peak 763.9 psia), 720 psia trips at 764.7 psia and reports 119,432 N·s over 14.000 s (`scratchpad/audit/skeptic/mawp750_*.log`). Optimise misreads it as a regulator dropout (`optimize.py:268-271`). | Stop `burn()` on a trip; emit a `fail` event; mark the result unconverged; add a "no vessel trips" constraint to optimise, trade and uncertainty. In preflight, warn when lockup + SPE x bottle drop exceeds MAWP. |
| He drawing cannot be flown | `flight_sim.py:319-329, 781, 886-897` size the refill with config `ullage_gas: Nitrogen` (yaml:455, 464); `flight.py:153-163` swaps the mass only. Result reports `converged: true` with a "Flight failed" event. | Set `ullage_gas` from `prep.derived['pressurant_gas']` in `_flight_config`; fix `flight_sim.py:899` and the "Pressurant (N₂)" labels; add a test that flies the He drawing. |
| Feed fit writes an invalid K0 | `feedfit.py:134` writes K0 unclamped (LOX −0.0379, from the SPE-driven tank rise), while `supply_K` is clamped (`:137`). Schema `ge=0` rejects it. On flown runs heads are fitted as velocity heads: −4 to −10 % now, −33 / −41 % with line heights. | Write K0 = K_line; report the supply term separately; refuse the write when K0 < 0 or when the run was flown (or fit the pad pass). |
| Graphite insert adiabatic, no case | Section 1 #2. T_graphite_back and T_bondline are computed, then dropped by `replay.py`. | D17; export per-station back-face and interface temperatures; label 2,326 K as an adiabatic upper bound. |
| No relief valves; a drawn RV is an always-open vent | `pid/network.py:53` maps RV to a plain Cv valve; `:506` makes only ROT/SOL actuators. `rv_test.py`: open, no set pressure, read as venting to atmosphere, attached to the liquid port. | Do not draw RVs until feedtwin has a pressure-actuated relief component (crack, reseat, choked capacity). |
| Two LE4 configs; live session changed mid-audit | D8. A later GET showed `lox_tank.initial_pressure_psi` 815.08 and 0.305 m lengths, from someone else's edit. | Pin every result and the ledger to `config_sha256`. |
| Tank peak above the config cap, ungraded | Peak 618.35 / 619.00 psia vs `max_*_tank_pressure_psi` 600; UI grades against MAWP 1000 only (`LayerXResult.tsx:171-180`); the optimiser applies 600 at T-0 only (`optimize.py:105-115`). | One grade function: peak against MAWP, MEOP and the design requirement. D11. |
| Saved runs keep only probe nodes; the replay drops most of its output | BurnTrace records 13 probe nodes of 31; branch flows, valve signals, regulator inlet/flow/dome and bottle gas temperature are dropped (1,382 B/step to keep all). `replay.py:91-127` keeps 24 of 69 arrays and none of the per-step diagnostics (momentum ratio, η breakdown, SMD, Cd, 278-station heat flux). | Opt-in full-network recorder (+0.11 MB per run); keep the scalar replay arrays; write axial profiles to a lazy sidecar. Prerequisite for the Feed, Engine and Hardware pages. |
| Regulator inlet line bore carries load on GN2 | l_reg bore 6.35 mm "manufacturer" with no reference; its wall reference says "1/2 in tube". At 4.572 mm (1/4 in OD x 0.035) the GN2 regulator saturates from t ≈ 3.3 s. The twin's gas pipe exceeds its 10 % dp/p validity there (37 %). | User to confirm tube sizes (section 6). |
| No line heights; vehicle flight lines not drawn | Section 1 #9. | Flight-vehicle drawing with measured drops (section 6). |
| No ethanol composition anywhere | `FluidConfig` has no composition; CEA uses "Ethanol" (100 wt %); the twin uses pure CoolProp Ethanol; CoolProp has no credible 75-95 wt % properties. | D15; if aqueous, use `rocketcea.blends.newFuelBlend` plus a cited handbook table. |
| Optimise returns bounds; no thrust target | D6. | D6. |

### 5.3 Other issues, medium severity

| issue | evidence | recommendation |
|---|---|---|
| Silent zero-erosion replay | `replay.py:77` passes `track_ablative_geometry=None`; `runner.py:771-784` needs the liner enabled and `track_geometry_evolution`. Graphite-only engine: 0.000 % growth (shipped 3.72 %), no warning, `converged`. | Pass `True` when graphite or liner is on; fail loudly on the legacy path. |
| `soak_back` never called; 120 s default too short | Only tests call it (`time_varying_solver.py:599-606`). Liner L²/α = 913 s; 120 s gives 325.5 K vs 354.5 K equilibrium. | Size from 3·max(L²/α); call after the final replay; report peaks per station. |
| Ablator properties are schema defaults; liner unnamed | `config_schemas.py:665-691`; `char_layer_*` unused; T_abl 1500 K doubles barrel recession. | D17. |
| Card ignores twin density | 0.46 % LOX / 0.24 % fuel flow. | D4-E. |
| Optimiser and uncertainty burns run without the replay | Late-burn Pc −1.8 %, ṁ +2 %; impulse +0.03 %. | Say so on their outputs; verify the winner with the replay (already done for optimise). |
| He droop is a GN2 back-fit held exact | PR_D 8.3 psi at 0.09646 kg/s "measured, the GN2 duty"; `uncertainty.py:118-121`. | D14. |
| Regulator seat is incompressible: no Y, no choke | `regulator.py:234-243, 308-321`; overstates GN2 capacity 25 % at burnout (0.398 vs 0.319 kg/s), up to 1.5x when choked. He at ≤18 % of capacity. | IEC 60534 form, opt-in, asserting no change on He at nominal. |
| T-0 bottle assumed full after pressing | `burn.py:11-15`; D13. | "Tanks pressed from the bottle" option; show the T-0 bottle basis. |
| LOX upper wall at 293 K at T-0 | D1. | Setup field plus Tunable row. |
| Predicted line PTs are total pressure | PT-OX-DN / PT-FU-DN read node (total) pressure; a wall PT reads ~q lower: 25.0 psi LOX, 15.6 psi fuel. | Subtract ρv²/2 for in-line PTs on the Measured tab, or state the convention; needs the PT mounting. |
| Rail exit below FAR-OUT minimum | 21.69 m/s = 71.2 ft/s on the 3.35 m default rail vs 85 ft/s required; `min_rail_exit_velocity_m_s` None. | D19; set 25.91 m/s and the rail length. |
| Static margin, CG(t), max-Q not surfaced | Max-Q 36.8 kPa at burnout (computed nowhere in the repo); static margin 7.73-8.66 cal on template layout. | Return and show them; `min_static_margin_cal` 1.5. |
| Injector-face heat flux absent | Only the SP-8089 angle warning (`layout.py:131, 1188`). | D18. |
| "Peak over the hold and the burn" covers only the 0.5 s lead-in and the burn | Recorder starts after `prime_at_t0` (`analysis.py:76-84`); the settle is unrecorded. | D20; relabel now. |
| Limits graded three times, worst times not stored | `optimize.grade`, `uncertainty` crossings and the UI `VERDICT` duplicate the thresholds; only chug stores `t_worst`; `card_outside_steps` is a bare count. | One server-side `result.limits[]` with value, limit, grade, `t_worst`, series index. |
| Delivered values are interpolations of 28 points | `replay.py:171-194`; spaced 0.10-0.15 s. | Plot replay points as samples; never imply 50 ms resolution. |
| Reconcile targets T-0 thrust; nearest drills miss O/F | Burn mean +0.9 % over target; #51/#53 gives O/F 1.5501 (+3.3 %). | Burn the picked drills; name the target figure (T-0 or mean). |
| Trim orifice not representable | Override cannot add elements; `OrificeCd`/`OrificeISO5167` price the tap differential (23.7 psi vs 4.0 psi permanent loss at β 0.888). Caveat: those figures use Reader-Harris/Gallagher with flange taps (C 0.791) on a 10.92 mm line at β 0.888, outside ISO 5167-2's range (D ≥ 50 mm, β ≤ 0.75). `fluids` 1.3.0 gives C 0.542 with corner taps and 0.610 with D/2 taps at the same 9.70 mm bore: permanent loss 13.9 / 9.5 psi, not 4.0. The bore for a 4 psi trim is therefore uncertain by more than the drill-step sensitivity; size it from a cold flow. | Inline orifice symbol with a permanent-loss model from `fluids`. |
| Two design O/F references | 1.5 (`optimize.py:316-317`, `trade.py:285`) vs 1.523 (`reconcile.py:338-339`). | D12. |
| `supply_K` subtracted from a dump-only drop (latent) | `line_exit_config` zeroes K0 but not `supply_K`; gate 1.330 → 1.248 after a feed-fit write. | Zero it (D7). |
| Chug model validated only without feed inertance | `scripts/chug_timelag_benchmark.py` uses `feed_length=0`; decider E boundary −15 % (non-conservative). The inertance term lifts LE4 from GM 1.01 to 1.33. | Do not read 1.33 as a 33 % margin; add a benchmark with line inertance (e.g. Szuch & Wenzel TN D-4564); measure stand Pc spectra. |
| Contract apogee has no provenance; vehicle terms dominate apogee | `target_apogee` 3890.7 m (unused by Layer X, matches an old sim result); roughness 60 → 0 µm gives +199 m; feed coupling +6.8 m. | D19; add wind and rail-angle dispersion. |
| Ethalox stand drawing carries library fallbacks tagged "manufacturer" | PR_D rated_flow 0.05 kg/s and droop 20 psi equal `pid/network.py:79-85`; solenoids Cv 1.2. Thrust falls 6,178 → 5,598 N. | Mark superseded; never use for LE4. |

### 5.4 Other issues, low severity

- **Throat lag.** The throat is applied one step late (`analysis.py:88-93`): 0.01-0.06 % Pc. Apply it at mid-step.
- **`gamma_exit` is the chamber γ** (`nozzle.py:181`). It reads 1.1348-1.1355, so the plume's M_e is 0.5 % off.
- **Two throat-growth figures for one run.** 3.977 % (per pass, relative to the first sample, `analysis.py:180`) vs 4.005 % (headline, relative to as-built).
- **Eroded contour is a redraw** (`time_varying_solver.py:429`). At the liner end, Bartz is ~7 % high (conservative). The downstream half of the insert never recedes (`:338-339`).
- **In-flight figures are at site ambient.** They omit +52.6 N·s (0.22 %) of altitude pressure thrust.
- **Flight mass history.** It comes from the replay's ṁ: RocketPy cuts off 1.2 ms early (~9 N·s, ~2 m apogee).
- **Pressure thrust after burnout** in `axial_acceleration`: coast only.
- **Stale docs and docstrings:**
  - `docs/layer-x.md:280` (5.6 % throat growth, now 4.05 % on GN2);
  - `flight.py:3-8, 41-44`, `feedtwin/session/core.py:526-531` and `feed-twin/backend/tunables.py:590-592` (withdrawn 2.5 m line, "~7 g");
  - `Setup.chilldown`;
  - CLAUDE.md's "the library's are off" (true of the `Tank` constructor, false of the library's `Setup`; D1).
- **Unused config fields.** These `graphite_insert` fields are read by nothing: `oxygen_mass_fraction`, `oxidation_enthalpy`, `heat_of_ablation`, …. They look authoritative.
- **`char_depth_peak` is mislabelled.** It is the char depth at the most-receded station (0.22 mm), not the deepest char (0.36 mm).
- **Saturation fields missing from the trace.** `surface_temperature_K` is not in `TANK_FIELDS`. The `ENG.chamber` node temperature (85.6 K) is meaningless. Isolated nodes are held at 101.325 kPa, not the site's 13.64 psia.
- **Card tolerance gate.** It covers the envelope only. The box `closed_mdot` is 0.36 %, and RBF corners such as c* 923 m/s are extrapolated off the hull.
- **Chug grading thresholds.** The UI amber threshold (1.2) is not the requirement's `min_stability_margin` (1.05). Neither the optimiser nor the reconciler constrains chug.
- **Stale LOX properties** give false mode-coupling flags: pogo_O ~ L1, surge_O ~ T1 (D21).
- **Result-schema drift.**
  - TS types are missing about 20 backend fields, e.g. `Series.dt`, `Summary.depletion_s`, most of `Replay`, `FlightResult.stability`.
  - The run listing mixes delivered impulse with twin thrust and Pc.
  - Defaults differ: the UI has `flight: true`, the backend `False`.
- **Playwright reuses the live :8000 backend and the real `.userdata` locally.** Run with `CI=1` or a separate port and `USERDATA_DIR`. Vite binds only `[::1]:5173`.
- **Theme.** There is one dark theme. `--color-text-tertiary` and `--color-bg-hover` are referenced but undefined. The app has 322 hex literals (8 in Layer X).
- **Removal hazards for Trade/Optimise.** A persisted view of `trade` or `optimise` blanks the pane after removal (coerce it to `burn`). The `gating.test.ts` entries must be removed in the same commit.
- **Smaller defects in the tools area.**
  - The reconcile source job is never pinned, although the router says it is.
  - The drill-table test is circular.
  - "Use these settings" drops the searched bottle volume.
- **Copy-paste provenance on the He/GN2 drawings** (section 6).
- **Design liftoff mass is ambiguous**: 82.41 kg vs 86.18 kg (D19).

### 5.5 Traps found during the audit (for implementers)

- **`engine/layerx/__init__.py:17` exports the function `prepare`, which shadows the submodule.** `import engine.layerx.prepare as P; P.NETWORK_TOLERANCE = …` silently does nothing. Patch through `sys.modules["engine.layerx.prepare"]`.
- **The scratchpad `audit/feedtwin/` folder shadows the `feedtwin` package** for any script run from `audit/`. Run scripts from a subfolder.
- **A model is consumed by a session** (`open_session` refuses reuse). Assemble one per run.
- **`Session.step` splits dt using banker's rounding**: 50 ms becomes 2 x 25 ms, and 30 ms becomes 2 x 15 ms.
- **Vessel states and node values differ.** `copv_psia` and `tank_psia` are post-step vessel states, while node values are the solve's boundaries (bottle 1645.6 vs 1651.4 psia at burnout). Do not mix them in one ladder.
- **Mutating `A_throat` in a test** also needs L* (an override), ε and A_exit updated. `tests/test_layerx.py:164-176` changes only A_throat.
- **`test_time_varying_stability_inputs.py` checks only t = 0**, so it cannot catch the frozen-geometry chug bug. A new test must be shown to fail against the current code.
- **He and GN2 drawings are byte-identical except `fluid`.** Any provenance fix must go to both.

---

## 6. Drawing vs stated LE4 hardware

The He and GN2 drawings are identical except for the `fluid` field on 11 nodes. Every number and every provenance tag is the same. The He drawing therefore carries GN2-derived regulator data and GN2 labels (`MAN-GN2`, `PT-GN2-REG`, `SV-GN2-VENT`).

| item | user statement | `copv_study_he` (provenance) | config / other | verdict |
|---|---|---|---|---|
| Pressurant | He hot fire; N2 water flows | KB1 helium, 4.6871 L (measured), 4500 psi (manufacturer), MAWP 6750 (estimated, 1.5x) | config `ullage_gas: Nitrogen`, 4.619 L, 1.312 kg; UI defaults to GN2 | drawing OK; config and UI disagree |
| Dome regulator | Aqua 1092-50 | PR_D dome-loaded | — | OK |
| Regulator Cv | 0.8 | 0.8 (manufacturer, TB 1031, 0.23 in orifice) | ethalox_stand: 0.8, no reference | agrees; TB 1031 not verified |
| Regulator bias | 50 psi | 50 psi (TB 1031) | — | OK |
| Supply effect | — | 17 psi/1000 psi (TB 1031); `inlet_reference` 4500 "psi" read as absolute although service pressure is gauge (0.25 psi effect) | ED code cites 10 from the 1092 datasheet; ethalox_stand has none | sources disagree (D9) |
| Droop | — | 8.3 psi at 0.09646 kg/s, both "measured": a GN2 back-fit applied per kg/s of He | ethalox_stand 20 psi at 0.05 kg/s = library fallbacks tagged "manufacturer" | He droop unverified (D14) |
| Control regulator (dome loader) | hand knob | PR_C setpoint 500 (measured); no supply coefficient | — | loader SPE unmodelled (~2.9 psi of tank rise per 1 psi/1000 psi) |
| Press solenoids | 1.7 Cv each tank | SV_LOX_PRESS / SV_FUEL_PRESS Cv 1.7 "measured", no test cited; bore 6.35 "manufacturer", no reference | ethalox_stand Cv 1.2 | agrees; provenance weak |
| Other solenoids | — | SV_GN2_VENT and SV_LOX_FILL Cv 1.7, same "press solenoid" reference (copy-paste); SV_LOX_FILL's open upstream side reads as a vent to atmosphere | — | unverified |
| Main valves | not stated | MVO/MVF Cv 26.1 (estimated, Crane K), 1/2 in NPT full-port ball valve, travel 0.05 s "measured: fast solenoid" | DAQ Fire opens both together | actuation contradictory; no fuel lead |
| Fuel tank rating | MEOP 750 psi | MAWP 1000 psi "estimated, twice the 500 psig operating pressure"; operating 500 tagged manufacturer while LE4 locks up at 563 psig | config cap 600 psi | **disagrees**; no MEOP field |
| LOX tank rating | — | MAWP 1000 psi estimated | config cap 600 psi | unknown |
| Relief valves | — | none (none on any drawing) | — | missing; feedtwin cannot model one yet |
| Tank volumes | operator: 15.10 / 8.67 L | 15.10 / 8.67 L (measured, operator) | config 6.444 / 6.202 L | drawing OK; config disagrees |
| Tank diameters | — | 160.1 / 154.4 mm "estimated, not measured; sets the static head" | config r 69.85 / 76.2 mm | unmeasured |
| Tank outlet | — | only K 0.5 "sharp exit"; no outlet bore, sump or anti-vortex | — | missing (residual) |
| Feed lines | 1/2 x 0.035 in tube | LOX 0.07 + 0.07 m, fuel 0.9144 + 0.05 m, bore 10.92 mm, lengths estimated, no elbows | YAML (vehicle) 0.3048 / 1.3716 m; doc 0.1016 / 0.9144 m | stand vs vehicle mixed; all estimated |
| Line heights | — | no `elevation_change` on any edge | team: fuel 4.5 ft, LOX 1 ft (vehicle) | missing |
| Regulator inlet line l_reg | — | 0.3 m, bore 6.35 mm "manufacturer", no reference, K 4.0 estimated | — | load-bearing on GN2 |
| Bottle line l_kb | — | 12.7 mm "manufacturer" (a nominal size: 1/2 x 0.035 tube is 10.92 mm ID) | — | nominal used as ID |
| Wall thickness | 316 SS | 0.889 mm on every edge, "1/2 in seamless 316", including the 6.35 / 9.525 mm bores where that is impossible | — | copy-paste |
| Instruments | — | 6 PT, 4 TC, 1 RTD; **no Pc PT, no manifold PT, no PT downstream of a press solenoid or at the regulator inlet** | — | gaps for model validation |

**What the user must fix in pid-designer.** Layer X will not patch drawings. Restating a value as a Layer X override is the interim route, and it keeps provenance.

1. **Tank ratings.** Give the LOX and fuel tank MAWP from a datasheet or test, with provenance. Add the fuel MEOP of 750 psi as its own parameter. This needs a MEOP field in pid-designer and feedtwin.
2. **Relief protection.** Supply relief set pressures and Cv values, but **do not draw RVs yet**: today an RV builds as an always-open vent. Hand sizing against regulator fail-open gives Cv ≈ 4.0 at 825 psig (upper bound). Also say whether the press legs have check valves.
3. **Line heights.** Add `elevation_change` on the stand drawing. Draw a **separate flight-vehicle drawing** with the measured tank-to-injector drops (team: fuel 4.5 ft, LOX 1 ft), rather than mixing vehicle and stand lengths.
4. **Tube sizes.** Give the OD x wall of l_kb, l_reg, l_ctrl/l_dome and the vent lines. The drawn bores are nominal sizes entered as IDs.
5. **Regulator droop on the He drawing.** Re-tag it "estimated (GN2 back-fit)", or measure it on He. Give PR_C's own supply coefficient if known. Fix `inlet_reference` units (gauge).
6. **Solenoids.** Cite the part number for Cv 1.7. Correct the copy-pasted Cv on SV_GN2_VENT and SV_LOX_FILL. Connect or cap SV_LOX_FILL's upstream side.
7. **Main valves.** Give the part, the actuator, and the source for the 0.05 s travel. Add the fuel-lead timing in the DAQ state machine: Fire currently opens both mains together.
8. **Tank geometry.** Measure the tank diameters (they set the static head). Give the outlet bore and sump.
9. **Instruments.** Add Pc and injector-manifold PTs if they exist on the stand, and record each line PT's mounting (wall-static or total).
10. **Housekeeping.**
    - Fix the copy-pasted wall-thickness references.
    - Rename the GN2 labels on the He drawing.
    - Mark `ethalox_stand` superseded: it carries library fallback values tagged "manufacturer" and Cv 1.2 solenoids, and its thrust falls 9 % over the burn where `copv_study_*` rises.

Apply every fix to both `copv_study_he` and `copv_study_gn2`.

---

## 7. Missing physics, ranked

The ranking is by impact on LE4 predictions and safety. Effort is S / M / L.

| # | item | impact | safety | effort | data available | plan |
|---|---|---|---|---|---|---|
| 1 | Start transient: valve schedule with the fuel lead, filling of gas-filled manifolds and lines, ignition delay, line inertance | high: start chug (Leonardi 2017's subject), early fuel-rich erosion, separation below Pc ≈ 155 psia, hard-start risk, rail-exit timing | yes | L | valve travel 0.05 s on the drawing; manifold channel volumes in the config; lead time and valve-body volumes unknown | Start phase as its own model (dynamic liquid branches dṁ/dt = (Δp − loss)/(L/A), or a separate start integrator). Until then exclude t < travel from grading and label the start "not modelled". |
| 2 | Case and backing behind the liner and insert; soak-back wired in | high: insert back face 2,326 K adiabatic; no case or bondline temperature | yes | S | `WallModel` accepts a case layer; `soak_back` exists; case material, thickness and contact are unstated (D17) | User declares the stack. Export per-station back-face and interface histories. Run soak for 3·L²/α. |
| 3 | Pressure-actuated relief valve and burst disc | high: overpressure path absent | yes | M | none on the drawings; fail-open flow computable | Relief component reusing the choke and the CheckValve cracking pattern; opt-in; then check relief capacity against regulator fail-open. |
| 4 | Chug loop driven by the drawing's feed (inertance and twin line drop) and the eroded geometry | high: +0.10 GM minimum, +0.08 at burnout; basis now matches Forward | yes | S | all per step in the series and the network | D7. |
| 5 | Vehicle line heights (a flight drawing) | high in flight: O/F −2.1 %, depletion order flips (upper bound) | yes | S (data-bound) | team lengths only; heights unmeasured | Measure, draw, re-fly. |
| 6 | Pressurant species into the flight mass budget | high: no He flight at all | no | S | `prep.derived['pressurant_gas']` | Bug fix (D2). |
| 7 | Ethanol-water composition (CEA blend, ρ, μ, Pv, droplet properties) | high if aqueous: c* −4.8 % at 75 % | no | L | `rocketcea` blends work; CoolProp cannot supply 75-95 wt %; needs a CRC/handbook table | Only if D15 says aqueous. |
| 8 | Injector-face heat flux and copper faceplate temperature | medium; heavy fuel lead plus an oxidiser-rich shutdown in flight (item 5) | yes | L | no face model; face position and gas state known | Recirculation-zone convection plus radiation from a cited source; do not reuse the Bartz contour value (D18). |
| 9 | Near-wall O/F for erosion; erosion factors in the uncertainty sweep | medium: throat growth 1.9-7.3 % | no | M | Rupe stream tubes already computed | Wall-zone O/F from the outer stream tube; sweep Bartz x and wall O/F with the replay inside. |
| 10 | Nozzle loss breakdown in place of ζ_n 0.95 | medium: ±2.6 % thrust at 0.975 | no | M | bell angles, contour, CEA frozen/shifting Cf | Divergence from the drawn bell, boundary layer and kinetics, each sourced; calibrate on hot-fire thrust. |
| 11 | LOX upper-wall temperature at T-0, and bottle inventory spent pressing | medium: bottle −225 psi (cold wall); below lockup without top-up | no | S | `TankState.ullage.wall_temperature`; RTD-LOX could measure it | Setup fields plus Tunable rows; default off; sweep. |
| 12 | GN2 condensation and densification over LOX | medium while GN2 is the default; nil for He | no | M | CoolProp; collapse/vapour registries; needs one trace | D3-D. |
| 13 | Regulator seat with IEC expansion factor and choke; gas-dependent droop | medium on GN2; small on He | no | S | Cv 0.8; xT unknown (0.7 IEC default); no He droop data | Opt-in; prove no change on He at nominal. |
| 14 | Propellant-state-aware card (density, temperature, Pv) | low-medium: 0.46 % LOX flow | no | S-M | twin node state | D4-E. |
| 15 | Charring-ablator liner with a named material | medium on liner life | no | L | none for LE4 | After D17. |
| 16 | Outlet gas ingestion / vortex pull-through residual | medium: −2 to −6 % impulse (estimate in layer-x.md) | no | M | outlet geometry not drawn; a weighed cold-flow residual would replace it | Measure the residual first; set `dry_kg`. |
| 17 | Inline 1-DOF ascent per twin step | medium (wall time; consistency) | no | M | `flight_1dof`, `vehicle_drag` | D5-C. |
| 18 | Max-Q, CG(t), static margin(t), rail exit graded | medium (vehicle checks) | yes | S | already computed by RocketPy | Return and show; FAR-OUT limits as requirements. |
| 19 | Wind, rail-angle and forecast dispersion for contract apogee | high for scoring, nil for the feed | no | L | site climatology in `star-openrocket` | After D19. |
| 20 | Hardware state carried across burns (cumulative recession) | medium over a campaign | yes | M | per-run end state | Store the end state per firing; start the next burn from it. |
| 21 | Water hammer at valve closure (abort, shutdown) | low in Layer X (ends on depletion); safety on abort | yes | L | lines and wall known; closing characteristic unknown | Hand bounds: 8-52 psi for a 50 ms linear closure, ~2,600 psi Joukowsky if fast. |
| 22 | Buoyant convection scaled with acceleration | low | no | M | Churchill-Chu with fixed G | h ∝ a^(1/3); quantify before building. |
| 23 | Graphite k(T) | low | no | S | datasheet gives room temperature only | Needs a source. |

Feed-line wave acoustics are not needed. The fuel line's λ/4 mode is 296 Hz and the LOX line's 1,600 Hz, against chug at 22-40 Hz, and the lumped-model error is ~1 %. Ullage and manifold compliance move the chug margin by less than 0.005.

---

## 8. Baseline (reference for the > 1 % rule)

Produced by `scripts/layerx_baseline.py` into `docs/layerx/baseline-2026-10-02.json`. That file embeds the config and the input hashes for the drawing, CEA table and DAQ tables. The guarding test is `tests/test_layerx_golden.py` (29 tests, run with `LAYERX_GOLDEN=1`).

**Basis.**
- Config: `configs/ethalox_6800N.yaml`, config fingerprint `7782d2fdd7f9f4dd…` (sha256 of the validated config's JSON, `engine/layerx/fingerprint.py`; the YAML file's own sha256 is `576b9b8affcaaa65…`). Re-checked 2026-10-02: the current YAML still loads to `7782d2fd…`, and a fresh he_pad burn reproduced 24,239.795689 N·s bitwise.
- Code: `08b47c05-dirty`.
- Environment: Python 3.11.7, numpy 2.4.2, CoolProp 7.2.0, macOS arm64.
- Settings: default `LayerXSettings`.

Runs are bitwise reproducible across processes on this machine. CI-stack drift (py 3.12, numpy 2.5.3, CoolProp 8.0.0) was not measured.

| metric | **he_pad** (a) | he_flight (b) | **gn2_pad** (c) | gn2_flight (UI default run) | he_flight, He ullage (what-if) |
|---|---|---|---|---|---|
| total impulse (delivered) [N·s] | **24,239.8** | 24,239.8 (pad; flight refused) | **24,092.2** | 24,088.1 | 24,235.2 |
| burn time [s] | **3.4562** | 3.4562 | **3.5983** | 3.5885 | 3.4461 |
| thrust mean / min / max [N] (min over t ≥ 0.2 s, `replay.py:202-203`; the first sample is 6,752) | **7,013 / 6,769 / 7,315** | same | **6,696 / 6,540 / 6,910** | 6,713 / 6,567 / 6,911 | 7,033 / 6,802 / 7,316 |
| Pc mean (min-max) [psia] | **399.69** (391.1-405.2) | same | **382.89** (378.6-385.6) | 383.66 | 400.49 |
| O/F mean | **1.5211** | same | **1.5157** | 1.5177 | 1.5233 |
| Isp delivered [s] | **225.39** | same | **223.76** | 223.85 | 225.49 |
| bottle at burnout [psia] (over lockup) | **1,646.3** (1,068.2) | same | **1,204.3** (626.1) | 1,206.4 (628.2) | 1,648.2 (1,070.1) |
| pressurant used [kg] | **0.0906** He | same | **0.7111** N2 | 0.7103 | 0.0905 |
| tank peak LOX / fuel [psia] | **618.4 / 619.0** | same | **578.1 / 580.6** | 578.1 / 580.5 | 618.3 / 619.0 |
| tank min while firing [psia] (ignition dip) | **574.4 / 574.4** (3.6 / 3.7 psi) | same | **552.9 / 553.0** (25.0 / 25.3) | 552.7 / 552.9 | 574.4 |
| min ΔP/Pc LOX / fuel, t ≥ 0.2 s | **0.3634 / 0.3487** | same | **0.3542 / 0.3365** | 0.3560 / 0.3368 | 0.3657 / 0.3490 |
| min ΔP/Pc at ignition | 0.3627 / 0.3473 | same | 0.3622 / 0.3366 | 0.3644 / 0.3370 | 0.3650 / 0.3475 |
| chug margin min (at) | **1.398** (0.05 s) | same | **1.355** (0.70 s) | 1.362 (0.70 s) | 1.407 (0.05 s) |
| depleted side; residual of the other | **LOX; 0.0579 kg fuel** | same | **LOX; 0.0423 kg** | LOX; 0.0483 kg | LOX; 0.0641 kg |
| throat area growth (recession) | **4.005 %** (0.474 mm) | same | **4.046 %** (0.479 mm) | 4.061 % (0.480 mm) | 4.02 % (0.476 mm) |
| dome [psig] | 513.55 | 513.55 | 513.55 | 513.55 | 513.55 |
| apogee AGL | — | **flight failed** | — | 3,125 m (10,251 ft); 82.41 kg, 8.35 → 9.04 g, Mach 0.80 | 3,249 m (10,660 ft); 80.67 kg, 8.58 → 9.78 g, Mach 0.83 |
| passes; converged; failed steps | 2; yes; 0 | 2; yes; 0 | 2; yes; 0 | 4; yes; 0 | 4; yes; 0 |

**Cross-checks inside he_pad.**
- Engine check, worst against the replay: Pc 0.11 %, ṁ 0.12-0.13 %, thrust 0.50 % (the card's as-built nozzle).
- Forward at t = 0.25 s: Pc −0.27 %, thrust −0.18 %.
- The replay's flows integrate to 10.966 kg against the twin's 10.956 kg.
- The twin's own impulse is 24,273.7 N·s and its mean thrust 7,023 N.

**Burned on the app document instead [doc]:**

| | he_pad | gn2_pad |
|---|---|---|
| impulse | 24,233 N·s (−0.03 %) | 24,084 N·s (−0.03 %) |
| mean thrust | 7,035 N (+0.31 %) | +0.30 % |
| peak thrust | 7,362 N (+0.65 %) | +0.61 % |
| Pc mean | −0.41 % | −0.41 % |
| burn time | −0.33 % | −0.33 % |
| throat growth | 5.69 % | 5.74 % |
| chug min | 1.367 | 1.323 |

**dt sensitivity (he_pad).**
- dt 0.1 s: impulse +0.078 %.
- dt 0.02 s: impulse −0.056 %, chug min −0.58 %, fuel tank min −1.5 psi.
- **No dt → 0 limit for the delivered figures.** A first-order extrapolation of these three points gives −0.09 % (−22 N·s), but finer steps do not follow it: on [doc] the delivered impulse moves −0.12 / −0.27 / −0.80 % at 10 / 5 / 2 ms and the chug minimum falls to 0.797 (section 5.1), because the first replay point lands deeper inside the 50 ms valve ramp as dt shrinks. The twin's own impulse does converge: +0.05 % between 50 and 1 ms, extrapolating to ~24,235 N·s [doc, erosion off].

**How to apply the > 1 % rule.**
- Do not use impulse alone. With a fixed load it is close to Isp x propellant x g0, so it barely moves: halving the regulator SPE moved impulse −0.30 % but mean thrust −1.73 %, max thrust −3.34 %, burn time +1.45 %, Pc −1.65 % and the bottle +9.5 %.
- Report any change above 1 % in: mean and max thrust, Pc, burn time, bottle at burnout, tank peaks, ΔP/Pc, chug margin, or throat growth.
- The golden test's bands: 0.5 % on impulse, burn time, thrust, Pc, O/F and propellant; 0.3 % on Isp; 1 % on the bottle; 3 psi on tank pressures; 0.003 on ΔP/Pc; 0.5 % on chug; 2 % on throat growth.
- The golden test catches edited expected values and physics mutations. It ignores the network tolerance (1e-6 → 1e-4 changed impulse −0.018 %).

**Re-baseline after any intended change.**
```bash
cd EngineDesign
PYTHONPATH=../lib/stardesign python3 scripts/layerx_baseline.py --all --out docs/layerx/<date>.json
LAYERX_GOLDEN=1 PYTHONPATH=../lib/stardesign python3 -m pytest tests/test_layerx_golden.py -q
```
Pass `--config docs/layerx/baseline-2026-10-02.json` to re-burn the embedded design. If `test_inputs_unchanged` fails, a drawing, the CEA cache or a DAQ table changed: re-baseline and report it; do not widen the bands.

---

## 9. Appendix: area audits

Each subsection is one area auditor's write-up, reproduced as written. Headings are demoted to fit this document. Paths such as `scratchpad/audit/...` are in the session scratchpad, not the repo. Where an auditor's number differs from section 8, check the basis it states (YAML, app document, or a saved run on another design).

### 9.1 Engine card and chamber coupling

Area: Engine card and chamber coupling (engine/layerx/card.py, link.py, replay.py hand-off; feedtwin engine card; EngineDesign injector/chamber/eta_c*).

**Auditor's summary.** The engine card is EngineDesign's line-exit engine at the as-built geometry. It is tabulated as injector capacity mdot/sqrt(dp) over (mdot, p_inlet) on a 41x21 grid per side, plus chamber c*_eff and vacuum exhaust velocity over (O/F, mdot) on a 41x41 grid. It reproduces EngineDesign to 0.02-0.06% inside its envelope. The card has no throat-area axis. The twin applies the replay's At(t) only as Pc = mdot*c*_eff/At(t), one coupling step late, and keeps c*_eff and thrust (v_vac at eps 4.83) at the as-built nozzle. On the LE4 He burn (throat area +4.0% by burnout) I compared the twin against fresh EngineDesign solves at the eroded geometry. Pc/mdot errors are at most 0.10%/0.12%, and thrust is +0.50% at burnout. Burns run without the replay (the optimiser's candidates and the uncertainty swings) see none of the erosion, which is worth -1.8% Pc and +2.0-2.2% flow at burnout at the same line pressures. eta_c* and Cd are fully state-dependent in EngineDesign and the card carries that state (eta 0.888-0.918 across the envelope, Rupe E_m at M ~ (O/F)^2, Lichtarowicz Re law, Nurick cavitation cap). The card's injector ignores the twin's propellant density, so EngineDesign's constants are used in place of the twin's CoolProp state (LOX 1140 vs 1150.5 kg/m3). Thermochemistry is already tabulated. A direct per-step EngineDesign chamber evaluation costs 185 us on the numba kernel (0.6 s per twin pass), so it is feasible. An At axis on the card costs about 2 s per node and adds at most 0.006% interpolation error. Ethanol composition (75/95%) is not supported anywhere: CEA, densities and viscosities all assume pure ethanol. LE4 has no film or barrier holes, and nothing computes injector-face heat flux.

All experiments use LE4 = `EngineDesign/configs/ethalox_6800N.yaml` (config sha256 7782d2fd...) on the hot-fire drawing `copv_study_he`, with default `LayerXSettings` (card mode, replay on, dt 0.05 s, lockup 578 psia). Scripts and outputs are in `scratchpad/audit/card/`. The reference in every comparison is a fresh EngineDesign solve, never the twin.

Baseline burn (`run_burn.py`; 78.4 s wall, 2 passes):
- Burn time 3.456 s; delivered impulse 24,240 N·s; mean thrust 7,013 N (6,769-7,315 N).
- Pc mean 399.7 psia; O/F 1.519-1.524.
- Throat area growth +4.00% (graphite recession 0.474 mm); liner recession 1.158 mm.
- `card_outside_steps` 0, extrapolated steps 0.

---

#### 1. What the card is

**Boundary.** The card starts at the line exit. `line_exit_config` (card.py:86-99) zeroes K0, K1, fittings and roughness and keeps the Borda exit dump (K_exit = 1).

**Sampler.** `EngineSampler` (card.py:102-141) uses the numba kernel `accel.chamber_point` when `accel.can_handle_chamber` passes; otherwise it falls back to the Python `runner.evaluate`. LE4 takes the numba path.

**Inputs and outputs** (`fit_card`, card.py:180-213; feedtwin `engine/card.py`):

| table | output | axes | grid | fit |
|---|---|---|---|---|
| injector, per side | φ = mdot/sqrt(p_inlet − Pc) [kg/(s·Pa^0.5)] | (mdot, p_inlet) | 41×21 (`INJECTOR_GRID`, card.py:77) | thin-plate RBF, degree 1, normalised columns (card.py:147-154), resampled to a uniform grid |
| chamber `cstar` | c*_eff = Pc·A_t/mdot (stagnation loss and η included) | (O/F, mdot_total) | 41×41 (`CHAMBER_GRID`, card.py:76) | RBF in (O/F, ln mdot) |
| chamber `vacuum_velocity` | v_vac = (F + p_a·A_e)/mdot | (O/F, mdot_total) | 41×41 | same |

**Evaluation.** Uniform Catmull-Rom with linear ghost nodes, clamped outside the box (feedtwin card.py:119-142). Each table carries the convex hull of its samples; `covers()` flags a query outside it.

**Throat and exit area.** These are scalars on the card (`throat_area` 1794.71 mm², `exit_area` 8664.2 mm²). `EngineCard.attach` refuses a design whose throat differs by more than 1e-9 relative (feedtwin card.py:298-316).

**Ranges on this card.**
- Ox injector: mdot 0.90-2.64 kg/s, p_inlet 231-751 psia.
- Fuel injector: mdot 0.53-2.14 kg/s, p_inlet 173-977 psia.
- Chamber: O/F 0.875-2.534, mdot 1.62-4.37 kg/s.
- φ is nearly constant: spread 0.06% (ox) and 0.79% (fuel) over the whole table. This is the Reynolds-law Cd.

**Scan.**
- Levels 0.40-1.30 × centre (21 points) by fuel/ox ratio 0.75-1.30 (13 points): 273 samples, 333 solves including holdout, built in 1.2 s on the kernel.
- The centre is 0.5·(p_tank_O + p_tank_F) = 578 psia (link.py:151).
- On the Python path the scan is 11×7: 77 samples, built in 8.0 s (measured with `ED_ACCEL=off`, `python_card.py`).

**Fit error as built (card.fit).**
- Envelope (40 random points, levels 0.70-1.15, ratios 0.90-1.12):
  - chamber_pc 0.049%, chamber_thrust 0.058%
  - dp_O 5e-8, dp_F 1.1e-6
  - closed_pc 0.017%, closed_thrust 0.021%, closed_mdot 0.030%
- Box (20 points over the whole scan): chamber_pc 0.65%, chamber_thrust 0.74%, closed_pc 0.22%, closed_thrust 0.25%, closed_mdot **0.36%**.
- `within_tolerance` (`TOLERANCE` 0.2%) is judged on the envelope only (card.py:335-338, 358). The box closed_mdot of 0.36% exceeds the tolerance and is not gated. The burn stayed inside the envelope: line-exit pressures were 0.937-1.034 × centre.
- Python-path card: envelope worst 0.056%. Against 25 fresh solves: chamber_pc 0.072%, closed 0.028-0.043%.

**Outside the hull** the RBF extrapolation is unphysical at the corners. The c* table reaches 923 m/s at (O/F 2.53, mdot 1.62), outside the hull. Queries there clamp, and the step is only flagged.

**c*_eff is strongly state-dependent in the table:**
- At O/F 1.5: 1458.7 / 1541.7 / 1575.2 m/s at mdot 1.8 / 2.4 / 3.0 kg/s (−7.4% from 3.0 to 1.8 kg/s; η_vap falls with Pc).
- At mdot 3.0 kg/s: 1336 m/s at O/F 2.1, against 1575 m/s at O/F 1.5 (Rupe mixing).

#### 2. A_t handling and the throat schedule

**Not rebuilt per pass.** `card_for` caches one card per (config fingerprint, centre, ambient) (card.py:370-383). It is built at the as-built geometry and never rebuilt for the eroded throat.

**What the twin does per step.**
- `_burn_once` sets `chamber.throat_area = a0` (analysis.py:74).
- After each firing step it sets `chamber.throat_area = interp(clock, schedule)` (analysis.py:93). That is the replay's throat at the end of the step just finished, used for the next step: **a one-step lag**.
- `CardChamber.evaluate` uses that area only in `pressure = total·c*(O/F, total)/self.throat_area` (feedtwin card.py:412-413).
- Thrust is `total·v_vac(O/F, total) − p_a·card.exit_area` (card.py:416-421). It is independent of A_t(t), so it stays at the as-built ε = 4.83 (eroded ε = 4.64).
- `_CardCStar` (card.py:350-370) inverts with the as-built `card.throat_area`. It feeds only `fill_time`.
- The injector capacity is A_t-independent, and correctly so.

**Answer to "A_t(t) or as-built?"**
- Pc and the injector/chamber balance use A_t(t), lagged one step.
- The c*_eff and v_vac lookups use the as-built geometry, including as-built L*, ε and bore.
- Without the replay (`replay=False`: optimiser candidates `optimize.py:158,216,301`; uncertainty `uncertainty.py:325,348`) there is no schedule, and the whole burn runs at the as-built A_t.

**The replay is a quasi-steady EngineDesign solve on the eroded geometry.**
- `TimeVaryingCoupledSolver.solve_time_step` rebuilds A_t, A_e, V, ε, L* and bore from the wall recession and calls `ChamberSolver.solve` on that copy (time_varying_solver.py:319-386).
- Checked: a fresh `EngineSampler` solve at the replay's geometry reproduces the replay to <1e-5 at every point. The chamber solve carries no hidden time state. η_HL comes from the steady ablative model, not from the transient wall temperatures.

**Experiment `compare_eroded.py`.** At 10 of the 28 replay instants, with the twin's own line-exit pressures:
- ED(full) = fresh solve at the replay's geometry.
- ED@A_t = throat only (V and bore kept; L*, ε follow).
- card@A_t = the card closed by brentq with its chamber's `throat_area = A_t(t)`.

| t [s] | A_t/A_t0 | ε | twin vs ED(full): Pc / mdot_O / mdot_F / F | card@A_t vs ED(full): Pc / mdot_F / F | card@A_t0 vs ED@A_t0 (pure fit) | ED(full) vs ED@A_t0 at same p: Pc / mdot_F / F |
|---|---|---|---|---|---|---|
| 0.05 | 1.0003 | 4.826 | +0.008 / −0.008 / −0.008 / −0.017 % | −0.004 / +0.005 / −0.001 % | ≤0.006 % | −0.01 / +0.02 / +0.01 % |
| 1.20 | 1.0056 | 4.801 | +0.021 / −0.024 / −0.026 / +0.056 % | +0.010 / −0.012 / +0.072 % | ≤0.001 % | −0.26 / +0.33 / +0.28 % |
| 2.35 | 1.0168 | 4.748 | +0.063 / −0.070 / −0.077 / +0.171 % | +0.029 / −0.036 / +0.217 % | ≤0.001 % | −0.77 / +0.96 / +0.81 % |
| 3.10 | 1.0315 | 4.680 | **+0.101 / −0.108 / −0.119** / +0.336 % | +0.049 / −0.058 / +0.404 % | ≤0.001 % | −1.44 / +1.77 / +1.48 % |
| 3.46 | 1.0400 | 4.642 | +0.069 / −0.072 / −0.080 / **+0.504 %** | +0.059 / −0.069 / +0.516 % | ≤0.002 % | −1.83 / +2.23 / +1.86 % |

**How the error decomposes:**
- Card fit along the trajectory: ≤0.006%.
- The At-independence of c*_eff: ≤0.06% in Pc and flow.
  - At fixed (O/F, mdot), c*_eff drifts 0.12% for +4% A_t (from `card3d.py`). Injector feedback attenuates this by about 1/(1 + Pc/2Δp) ≈ 0.42.
  - Liner growth (V, bore) adds 0.014%.
- The one-step lag accounts for the rest of the twin's residual (0.01-0.06%). At t = 3.1 s the throat grows 0.12% of area per 0.05 s step; × 0.42 ≈ 0.05% Pc, against 0.052% measured. It disappears on the short last step.
- Twin thrust is +0.50% at burnout (about +37 N), because v_vac is evaluated at ε 4.83 instead of 4.64.

**The pass-1 gap the loop closes:**
- Pass 1 (as-built throat) vs replay: mdot_O 2.01%, mdot_F 2.21%, Pc 1.89%.
- Pass 2: 0.119%, 0.131%, 0.112%. Schedule change 5.5e-5.
- `engine_check` worst against the replay: Pc 0.112%, thrust 0.504%, mdot 0.119/0.131%.

**Without the replay** (pass-1-type burn, `count_calls.py`), compared with the delivered burn:
- Impulse 24,247 vs 24,240 N·s (+0.03%).
- Burn time 3.478 vs 3.456 s (+0.6%).
- Pc mean 402.6 vs 399.7 psia (+0.7%).
- Erosion moves flow and Pc by about 2% late in the burn, but impulse by almost nothing (more flow, shorter burn).

#### 3. η_c* and Cd: state-dependent, and where

**η_c\* = η_vap · η_mix · η_HL** (`combustion_eff.eta_cstar`, combustion_eff.py:98-190; called from `ChamberSolver.residual`, chamber_solver.py:210):
- **η_vap**: spray vaporisation march (combustion_physics.py:467, 651). It depends on Pc, injection velocities, SMD (Ingebo) and L*. L* comes from the config override `cg.Lstar`, held fixed unless the time-varying solver rewrites it (chamber_solver.py:161-165, time_varying_solver.py:386).
- **η_mix**: Rupe E_m at the element's M = ρ_O·v_O²·d_O/(ρ_F·v_F²·d_F) (combustion_physics.py:1026-1041, 1216-1260). M scales as (O/F)² at fixed geometry. It is integrated as stream tubes with ring-manifold striation.
- **η_HL**: heat-loss term sqrt(1 − Q/(mdot·cp·Tc)) from the ablative heat removed (combustion_eff.py:68-95).
- **Stagnation loss κ** (Rayleigh) at the contraction ratio (chamber_solver.py:231): κ = 1.004 for this engine.

**Measured breakdown** (`eta_breakdown.py`, line-exit pressures):

| line exit O/F (psia) | Pc psia | O/F | Rupe M | E_m | η_vap | η_mix | η_HL | η_c* |
|---|---|---|---|---|---|---|---|---|
| 491/491 | 356.7 | 1.452 | 1.070 | 0.799 | 0.9869 | 0.9237 | 0.9965 | 0.9084 |
| 578/578 | 406.1 | 1.451 | 1.069 | 0.799 | 0.9935 | 0.9238 | 0.9966 | 0.9146 |
| 665/665 | 452.8 | 1.451 | 1.068 | 0.799 | 0.9970 | 0.9238 | 0.9966 | 0.9179 |
| 578/520 | 386.4 | 1.738 | 1.532 | 0.746 | 0.9881 | 0.9016 | 0.9966 | 0.8879 |
| 578/636 | 413.8 | 1.248 | 0.790 | 0.783 | 0.9953 | 0.9209 | 0.9969 | 0.9136 |

Along the actual burn η_c* went 0.9101 → 0.9125 and c*_eff 1575.7 → 1580.3 m/s. The card carries all of this through its (O/F, mdot) axes.

**The other engine modes hold η constant:**
- Calibrated mode holds η_c* and η_n constant from the T-0 fit (link.py:190-199).
- Native mode uses the design's constant (link.py:142-144).

**Cd** (`impinging._stream_flow`, impinging.py:53-136):
- Reynolds-dependent through the Lichtarowicz (1965) short-tube law with the declared L/d (5.0 LOX, 5.545 fuel) and a sharp inlet (discharge.py:85-142, 356-368).
- Cavitation-capped by Nurick: Cd ≤ Cc·sqrt(K), with K = (P_in − P_v)/(P_in − Pc), using the config vapour pressure (impinging.py:65-72, 547-553).
- Solved hole by hole through the ring-manifold network (impinging.py:140-206).
- At T-0: Cd_O 0.784 and Cd_F 0.777 (manifold-effective 0.782 / 0.775). They change by less than 0.04% across levels 0.85-1.15. Re_O ≈ 3.4e5 and Re_F ≈ 3.9e4 (hand calculation from u, d, ρ, μ).
- Cavitation margin K/K_crit ≈ 2.3 on both sides (hand calculation: K ≈ 3.7, K_crit = (0.78/0.62)² ≈ 1.6), so not active at the operating point.
- feedtwin's native `DischargeModel` (feedtwin/engine/design.py:100-150) is the legacy thin-plate Cd_inf − a_Re/sqrt(Re): native Cd 0.576 / 0.563 at T-0. Its docstring claims agreement with EngineDesign, and that no longer holds. It is not the default mode.

**The card ignores the twin's propellant density.** `InjectorLeg.pressure_drop` with a card returns `card.pressure_drop(mdot, p_upstream)` without `flow.rho` (feedtwin/engine/component.py:78-90; card.py:222-230).
- The card is at EngineDesign's constants: LOX 1140 kg/m³ (config:37), ethanol 789 kg/m³ (config:22).
- The twin's CoolProp state at the injector inlet is 1150.5 and 792.8 kg/m³ (90.00 K and 293.15 K for the whole burn; the thermal options are off in Layer X).
- At a given Δp the card passes 0.46% less LOX and 0.24% less fuel than the same orifice would with the twin's liquid.
- Any warming or subcooling the twin models never reaches the engine.

#### 4. Feasibility: tabulated thermochemistry with a per-step solve, or an A_t axis

**Thermochemistry is already tabulated.**
- `output/cache/cea_cache_LOX_Ethanol_3D.npz`: Pc × MR × ε at 34³ points (1-9 MPa, O/F 1.0-2.5, ε 4-15); cstar, Cf, Cf_vac, Tc, γ, R, M.
- `cea_aux_LOX_Ethanol.npz`: 65 MR × 16 Pc for μ, cp, Pr and composition (chamber and throat); exit state over 48 ε.
- `cstar_wide_LOX_Ethanol.npz`: 161 MR × 16 Pc.
- What is not tabulated is η (spray march, Rupe mixing, ablative heat loss) and the ring-manifold injector, and that is where the cost is.

**Timings** (`timing.py`, M-series Mac):

| call | cost |
|---|---|
| numba `_point` (one residual: injector at fixed Pc + CEA + η_vap/η_mix/η_HL + κ) | **185 µs** |
| numba `chamber_point` (32-point bracket scan + Brent + final + thrust) | 5.4 ms (≈29 `_point`) |
| deepcopy + `extract_params` + `chamber_inputs` for a new geometry | 1.37 ms (deepcopy ≈1.1 ms; extract 0.26 ms; chamber_inputs 0.03 ms) |
| Python `ChamberSolver.residual` | 3.7 ms (single call); 5-8 ms inside a solve |
| Python `ChamberSolver.solve` | 74-76 ms (16 residuals; ring-manifold march calls `cd_from_re` 6,576 times) |
| Python `runner.evaluate` (sampler fallback) | 70 ms |
| Python `CEACache.eval` | 52 µs |

**Twin pass at dt 0.05** (`count_calls2.py`, cProfile):
- 79 s, 1,649 coupling steps (`_advance_once`), 3,141 network solves.
- 3,012 chamber evaluations with flow, about 1.8 per coupling step. The card's share is 0.12 s.
- The twin's own cost dominates: 21.8 s in 166k `CoolPropBackend.__init__` (feedtwin props/fluid.py:446 → coolprop.py:124), and 32 s in `_propagate_temperatures`.

**Per-pass cost of replacing the card's chamber with EngineDesign:**
- Kernel `_point` per closure iteration: 3,012 × 185 µs = **0.56 s** (+0.7%).
- At 10 ms steps over 4 s (about 400 steps × about 2 closure iterations): about 0.15 s.
- Python residual: 11-24 s per pass. A full `chamber_point` per evaluation: 16 s, and it double-closes the loop, which is the wrong formulation.
- Geometry can change every step if the kernel's Q vector (Q_AT, Q_CR, Q_EPS, L*) is patched directly. A deepcopy per step would cost 1.37 ms × 400 = 0.55 s.

**A_t as a third card axis** (`card3d.py`): 2D cards at A_t/A_t0 = 1.00 / 1.02 / 1.04 / 1.06 (throat only), each 333 solves, built in 1.5-2.0 s after warm-up (5.2 s for the first).

| | c*_eff error | v_vac error |
|---|---|---|
| No axis (today) at A_t/A_t0 = 1.02 | 0.062% | 0.28% |
| No axis at 1.04 | 0.124% | 0.56% |
| No axis at 1.06 | 0.190% | 0.85% |
| Linear axis, nodes 1.00/1.04, evaluated at 1.02 | 0.0007% | 0.0016% |
| Linear axis, nodes 1.02/1.06, evaluated at 1.04 | 0.0020% | 0.0056% |

- Three nodes cover 8% growth for about +4 s of build time, with interpolation error two orders below the existing 2D fit error.
- Liner growth (V, bore) is not on such an axis. It adds ≤0.014% Pc here.

#### 5. Ethanol composition and viscosity

**No composition support anywhere.**
- `FluidConfig` (config_schemas.py:10-42) has name and constant ρ, μ, σ, P_v, cp and so on, and no composition field.
- The ethalox preset (configs/propellants/ethalox.yaml) and LE4 (config:20-34) are pure ethanol.
- CEA runs `CEA_Obj(oxName, fuelName="Ethanol")` (cea_cache.py:248), which is rocketcea's C2H5OH(L) card at 100 wt%.
- The aux and wide c* tables are keyed by the (ox, fuel) name (cea_cache.py:1301; combustion_physics.py:295).
- The droplet heat-up uses CoolProp "Ethanol" by name (combustion_physics.py:379-445).
- The feed twin's species is pure CoolProp Ethanol (feedtwin/props/species.toml:22-25).
- Nothing calls `rocketcea.blends.newFuelBlend`.

**rocketcea does support blends.** Measured with `newFuelBlend(["Ethanol","H2O"], [x, 100−x])`, Pc 400 psia:

| | c* max | O/F at max | c* at O/F 1.5 | Tc at O/F 1.5 | ideal Isp_amb (ε 4.83, 13.64 psia) |
|---|---|---|---|---|---|
| 100% | 1724.9 m/s | 1.54 | 1724.4 m/s | 3219 K | 261.7 s |
| 95% | 1712.5 m/s (−0.7%) | 1.50 | 1712.5 m/s | 3222 K | 260.7 s |
| 75% | 1656.3 m/s (−4.0%) | 1.30 | 1641.3 m/s (−4.8%) | 3140 K | 252.2 s |

**Properties for aqueous ethanol are not available from CoolProp at 75-95 wt%.**
- HEOS `Ethanol[0.75]&Water[0.25]` fails to solve.
- At 0.9 molar HEOS returns μ = 0.986 mPa·s. That is below both pure components (CoolProp: ethanol 1.222, water 1.000 mPa·s at 293 K), so it is not credible.
- `INCOMP::MEA` (aqueous ethanol) stops at 60 wt%.
- A handbook table (for example CRC) would be needed. Not verified here.

**Viscosity dependence on temperature.**
- EngineDesign liquid viscosity is the constant config value. It enters Re for Cd and the spray correlations (impinging.py:397, 401). It is not temperature-dependent.
- Gas viscosity is temperature- and composition-dependent: CEA aux tables (μ_c, μ_t), Huzel (chamber_solver.py:907), Sutherland (chamber_profiles.py:265-269).
- The feed twin's line liquids use CoolProp μ(T, P). In Layer X the liquids stay at their load temperatures, and the card injector would ignore them anyway (§3).

#### 6. Film/barrier cooling and face heat flux

**No film or barrier cooling on LE4.**
- `film_cooling.enabled: false` (config:139-140). The injector is 24 + 24 doublets only (config:50-63). There are no barrier or film orifices, and the schema has none: `FilmCoolingConfig` (config_schemas.py:521-538) is an annular-slot effectiveness model with a mass fraction.
- The c* penalty of a film is explicitly not modelled; it is recorded as an assumption (combustion_eff.py:157-160).
- Enabling film cooling sends the engine off the numba kernel (`can_handle_chamber`, accel/__init__.py:117-130). The card then builds on the Python path: 8 s, envelope error 0.056% (measured).

**Injector-face heat flux is not computed anywhere.**
- The only face-heating content is SP-8089's included-angle > 90° warning (injectors/layout.py:131, 1188).
- The copper faceplate is not represented. The plate material enters only through yield strength and Poisson's ratio for the bending check (config_schemas.py:205-208).
- What exists is Bartz convection plus Leckner radiation along the chamber and nozzle contour from x_face to the throat (thermal/gas_side.py:1-14). The replay reports chamber heat flux 4.26 → 3.10 MW/m² and throat 28.7 → 7.6 MW/m² (first → last point).

#### 7. Disagreements and side observations (reported, not fixed)

- **LE4 LOX properties.** The config carries the values the ethalox preset later corrected (preset comments: "was 1.8e-4", "was 2300, not LOX", "was an order-of-magnitude 1.5e9"):
  - viscosity 1.8e-4 Pa·s against CoolProp 2.03e-4 (config:38)
  - cp 2300 J/(kg·K) against 1699 (config:41)
  - bulk modulus 1.5e9 Pa against 0.94-0.98e9 (config:47)

  Effect on Cd is negligible at Re 3e5. The bulk modulus feeds the chug feed acoustics (stability/analysis.py:700); not quantified here.
- **Pressurant.** The config says `ullage_gas: Nitrogen` (config:455, 464). The user says helium is the hot-fire pressurant.
- **Tank and inlet pressure climb on the He drawing.** Tanks go 574 → 618 psia during the burn and line-exit pressure 557 → 598 psia. Thrust follows, 6,751 → 7,352 N: not constant near 7.2 kN. This is a feed-side effect for the feed auditors; the engine only follows its inlet.
- **Ambient.** The card and replay run at pad ambient (94,070 Pa). The flight gets `reference_pressure_pa` (flight.py:179); its correction was not verified.

### 9.2 Erosion replay, outer loop and hardware geometry

Area: Erosion replay, outer fixed-point loop and hardware geometry (engine/layerx/replay.py, analysis.py pass loop, engine/pipeline/time_varying_solver.py, thermal/{gas_side,graphite_cooling,ablative_cooling,wall_conduction}.py, core/nozzle.py).

**Auditor's summary.** The outer loop works as designed and is strongly contractive. Its residual is the largest relative change in throat area between successive replays, with tolerance 2e-4 and no under-relaxation. On LE4 it settles in 2 passes: the pass-2 residual is 5.5e-5 on the He drawing and 4.8e-5 on GN2, and the throat grows +4.00 % and +4.05 % in area. The replay is converged in its own time step (7 to 70 points give 3.99 to 4.01 %), and two pieces of its physics match hand calculation to <0.2 %: the Bartz throat coefficient and the graphite kinetic/diffusion series rate. Erosion uses the instantaneous replay O/F, Pc and mass flux. Its gas is the CEA equilibrium composition at the bulk O/F, and its gas temperature is the ideal CEA Tc. The answer depends on unvalidated inputs: across plausible ranges of wall gas temperature, Bartz ±30 %, wall O/F ±20 % and kinetic rate ×0.5–2, throat growth spans 1.9–7.3 %. The impulse effect is only -0.7 % to +0.8 % (no erosion: -0.67 %). The safety-relevant gaps are hardware temperatures. LE4's config declares no case (`stainless_steel_case: null`), although its own header describes a 0.25 in steel case. So the 6 mm graphite insert has an adiabatic back face: it reaches 2326 K at burnout and 2355 K after soak. No case, bondline-to-steel or injector-face temperature exists. Much of the hardware state is computed but thrown away: per-station recession, remaining liner thickness, the graphite back-face temperature, the 278-point heat-flux profile, the c* loss breakdown, M_exit and soak-back. Separately, a config with the liner disabled (or `track_geometry_evolution: false`) silently replays with zero erosion.

All experiments ran on `configs/ethalox_6800N.yaml` (LE4, "Ethalox 7200N Doublet"), on the pad, flight off, engine card mode, dt 0.05 s, replay on. Scripts and outputs are in `scratchpad/audit/erosion/` (`run_he_pad.py`, `replay_direct.py`, `sensitivity.py`, `soak.py`, `nozzle_isp.py`, `gate.py`, `diag_keys.py`, plus `result_copv_study_{he,gn2}.json`). No repo file was edited.

#### 1. The outer loop: exactly what converges

**Loop structure** (`engine/layerx/analysis.py:116-240`):
- **Feedback.** It is only active when `prep.link.mode in ("card","calibrated")` (analysis.py:148). The native mode replays once and feeds nothing back.
- **Pass budget.** `rpl.MAX_PASSES (=4, replay.py:44)`, plus `flt.MAX_FLIGHT_PASSES (=4, flight.py:49)` when flying (analysis.py:156).
- **Each pass.**
  - `_burn_once(prep, schedule, …)` runs the twin. `schedule = (t, A_throat)` from the previous replay is applied once per step, with one step of lag: `chamber.throat_area = interp(clock, schedule)` in `record()` (analysis.py:90-93).
  - `rpl.replay()` runs EngineDesign's `TimeVaryingCoupledSolver` at the twin's line-exit pressures. It uses 28 points (`REPLAY_POINTS`, replay.py:40) plus a lead point at Fire (replay.py:70-83).
- **Residual.** `rpl.schedule_change(old, new)` (replay.py:146-154) is the **max over the new replay's instants of |A_old(t)/A_new(t) − 1|**. Here A_old is the schedule that was applied to this pass's twin, linearly interpolated onto the new instants. On pass 1 there is no old schedule, so the "change" is `max|A/A[0] − 1|`, which is the throat growth itself.
- **Tolerance.** `THROAT_TOLERANCE = 2.0e-4` relative (replay.py:42). `throat_done = not feedback or new is None or (schedule is not None and change < 2e-4)` (analysis.py:182).
  - Consequence: pass 1 can never satisfy it while the replay returns a history, even a zero-erosion one. **Every replayed burn costs at least 2 twin passes.**
- **No under-relaxation.** `schedule = new` (analysis.py:209-210). None is needed: the measured contraction is about 5.5e-5 / 4.0e-2 ≈ 1.4e-3 per pass.
- **What is tested.** The residual is the throat-area history only. The following are recorded but **not** tested:
  - Pc and flow agreement (`rpl.agreement`, replay.py:157-168);
  - burn time, which moves 21 ms between passes (below).
- **Final verdict.** `converged` (analysis.py:213-240) requires `schedule_change < 2e-4` with ≥2 passes, or a 1-pass `throat_growth < 2e-4`. A failed replay makes the run unconverged with a warning event (analysis.py:173-177, 230-231).

**What is recorded per pass.** There is no Python `ReplayPass` class. `ReplayPass` is the frontend type (`frontend/src/api/layerx.ts:409-419`) that mirrors the dict built at analysis.py:164-165 and 180-181:
- `{pass, throat_applied, accel_applied, burn_time_s, throat_growth, schedule_change, agreement:{available, worst:{mdot_O, mdot_F, pc}}}`;
- plus flight fields `{total_impulse_Ns, mean_thrust_N, …, accel_change, apogee_agl_m, flight_error}`.

Only the **last** pass's replay is kept (`result["replay"] = rp`, analysis.py:242). Earlier passes' throat histories are discarded. The UI table is LayerXResult.tsx:565-585.

**Reporting inconsistency (low).** Per-pass `throat_growth = new[1][-1]/new[1][0] − 1` (analysis.py:180) is relative to the **first replay sample**, which has already eroded 0.027 %. `delivered.summary.throat_area_growth` is relative to the **as-built** throat (replay.py:108, 214). The same run therefore shows +3.977 % in the pass table and +4.005 % in the headline.

**Measured per-pass residuals:**

| drawing | pass | throat applied | burn time [s] | throat growth (vs first sample) | schedule_change | agreement worst mdot_O / mdot_F / Pc |
|---|---|---|---|---|---|---|
| copv_study_he | 1 | as built | 3.4776 | 4.0245 % | 4.02e-2 | 2.01 % / 2.21 % / 1.89 % |
| copv_study_he | 2 | pass-1 replay | 3.4562 | 3.9774 % | **5.54e-5** (settled) | 0.119 % / 0.131 % / 0.112 % |
| copv_study_gn2 | 1 | as built | 3.6204 | 4.0632 % | 4.06e-2 | 2.08 % / 2.26 % / 1.87 % |
| copv_study_gn2 | 2 | pass-1 replay | 3.5983 | 4.0154 % | **4.75e-5** (settled) | 0.137 % / 0.149 % / 0.123 % |

**Headline numbers:**
- **He:** 24 240 N·s delivered, mean 7013 N, Pc 399.7 psia, Isp 225.4 s, throat +4.005 % (0.474 mm radial), minimum chug GM 1.398 at t = 0.05 s.
- **GN2:** 24 092 N·s, 6696 N, 382.9 psia, Isp 223.8 s, throat +4.046 % (0.479 mm).

**Wall time:**
- He: 86 s total. Prepare took 19 s. Each twin pass took 31–36 s. Replays took 2.0 s and then 0.7 s.
- GN2: 32 s total.

The replay is not the cost; the twin is.

**Stale docs.** docs/layer-x.md:280 still says "throat +5.6 % in area (0.67 mm recession)" for the GN2 run. The run now gives 4.05 % / 0.479 mm, which matches the later note at docs/layer-x.md:563.

**Time-step convergence of the replay.** The explicit scheme freezes the gas loads over each replay interval (time_varying_solver.py:372, 418-430). Using the He run's line pressures:

| replay points | 7 | 14 | 28 (shipped) | 56 | 70 (every step) |
|---|---|---|---|---|---|
| throat growth | 3.988 % | 4.000 % | 4.0045 % | 4.0064 % | 4.0071 % |

28 points is within 0.003 percentage points of every-step. The replay costs ~0.85 s at 28 points and 1.3 s at 70, so the docstring's "~0.1 s per point" overstates it.

#### 2. What drives erosion

Per replay step, `solve_time_step` (time_varying_solver.py:350-550) does four things in order:
1. Advances the walls under the **previous** step's loads.
2. Rebuilds the geometry.
3. Solves Pc on it.
4. Builds the next interval's loads from **this** step's state (time_varying_solver.py:420-430):
   - `tr = aux.transport(MR, Pc, "chamber")`;
   - `comp_c = aux.composition(MR, Pc, "chamber")`, which feeds H2O/CO2 radiation;
   - `comp_t = aux.composition(MR, Pc, "throat")`, which feeds carbon oxidation;
   - `HotGasState(T0 = Tc_ideal, P0 = Pc, mass_flux_throat = mdot/A_throat(current))`.

**O/F, Pc and mass flux: instantaneous.** They are the replay's own MR, Pc and mdot at that instant (lagged one replay interval of about 0.13 s), not design-point values. On LE4, MR moves only from 1.524 to 1.519 and Pc from 390 to 405 psia.

**Composition** is CEA equilibrium (rocketcea `get_SpeciesMoleFractions(frozen=0)`, throat column, cea_cache.py:1208-1214). It is tabulated on MR 0.8–4.0 × Pc 1e5–1.2e7 Pa and read with `AUX_SPECIES = (H2O, CO2, CO, H2, OH, O2, O, H)` (cea_cache.py:1119).
- The oxidisers attacking carbon are **H2O, CO2, OH, O2 and O** (`CARBON_OXIDISERS`, graphite_cooling.py:22-28).
- At burnout (He): x_H2O 0.4665, x_CO2 0.1524, x_OH 0.0266, x_O2 0.0044, x_O 0.0023, MW_t 22.58.
- The O/F is the **bulk** chamber O/F. There is no near-wall or outer-row mixture ratio, and no film. The start-up fuel lead is not in the replay at all: the twin's first firing step is already at 390.5 psia, and there is no start or shutdown ramp.

**Gas temperature for the walls is the ideal CEA Tc** (`Tc_ideal`, time_varying_solver.py:426; 3232 K at t = 0.05 s). It is not reduced for η_c* = 0.910. This is conservative and is one of the two largest sensitivities (table below).

**Kinetics against diffusion limit.** This is handled entirely in `carbon_oxidation` (graphite_cooling.py:31-70):
- Each species reacts at `1/(1/m_kin + 1/m_diff)`.
- `m_diff = g·MW_C·ν·x/MW_mix`, with the film conductance g = h_Bartz/cp, blowing-corrected as `g0·ln(1+B)/B` and iterated to self-consistency.
- `m_kin = A·T^b·exp(−E/RT)·p_i^n`, with p_i in atm (Bradley et al. via Thakre & Yang 2008, from `oxidation_H2O/CO2/OH` in the config).
- O2 and O are **always** diffusion-limited (`m_kin = inf`).
- Reaction enthalpies are hand-checked against JANAF heats of formation:
  - C+H2O +131.3 kJ/mol, giving 10.93 MJ/kg C;
  - C+CO2 +172.5 kJ/mol;
  - C+OH +68.1 kJ/mol;
  - 2C+O2 −221.1 kJ/mol;
  - C+O −359.7 kJ/mol.
  All match the constants.
- The surface temperature comes from the 1-D transient conduction model (`WallModel`, `chemical_mass_flux` mode, wall_conduction.py:168-211). Graphite thermal sublimation is **not** modelled: `throat_ablation_recession_rate = 0.0` (time_varying_solver.py:528) and `recession_rate_thermal: 0.0` (:440). That is fine at the 2412 K peak surface temperature.

**Hand check at burnout** (He; Ts 2412.5 K, Pc 405.2 psia, γ 1.1355):
- P_static = Pc·(2/(γ+1))^(γ/(γ−1)) = 2.794 MPa × 0.5774 = 1.613 MPa, so p_H2O = 0.4665 × 1.613e6/101325 = 7.43 atm.
- m_kin,H2O = 4.8e5 · exp(−288000/(8.3145 × 2412.5)) · 7.43^0.5 = **0.761** kg/m²s.
- g = 9874/2229.6 × 0.9445 = 4.183, so m_diff,H2O = 4.183 × 12.011 × 0.4665/22.58 = **1.038** kg/m²s.
- Series: **0.439** kg/m²s. The code gives 0.4389.

The regime is mixed: kinetics carries 58 % of the resistance. Total carbon flux is 0.531 kg/m²s:

| species | flux [kg/m²s] |
|---|---|
| H2O | 0.439 |
| OH | 0.058 |
| O2 | 0.0195 |
| CO2 | 0.0092 |
| O | 0.0051 |

That is 0.293 mm/s at ρ = 1810 kg/m³. The endothermic surface chemistry absorbs q_chem = 4.93 MW/m² against a blown q_conv of 7.40 MW/m².

Early in the burn (Ts 850–1500 K), OH (E = 0) and the always-diffusion-limited O2/O still give 0.06 mm/s. At a cold wall that is conservative: OH would recombine in a cool boundary layer, and C+O2 is slow at 850 K. This is about 15 % of total throat recession.

**Bartz hand check at the throat** (H&H eq. 4-13; burnout: D_t 48.75 mm, μ 1.044e-4 Pa·s, cp 2229.6, Pr 0.6654, G = 1768 kg/m²s, r_c = 0.941 R_t, σ = 1.065): h = 9862 W/m²K by hand against 9874 in the code.

**Liner (Landau) hand check at the barrel** (t = 0.05 s):
- q_net = 0.9931 × 2.241 + 0.774 = 3.000 MW/m².
- rate = q/(ρ·(H + cp·ΔT)) = 3.0e6/(1600 × 5.029e6) = **0.373 mm/s**. The code's quasi-steady rate is 0.3728 mm/s.
- Steady-ablation char depth: δ = α/v = 1.46e-7/3.8e-4 = 0.38 mm, so the 950 K isotherm sits at 0.38 × ln(1686/650) = **0.36 mm**. The code gives char_depth_chamber 0.360 mm.

**Sensitivity of erosion to its assumptions.** Monkeypatched in-process, 28-point replay at the He run's fixed line pressures (`sensitivity.json`):

| case | throat growth | throat rec. [mm] | Tgs end [K] | barrel rec. [mm] | F_end [N] | impulse [N·s] |
|---|---|---|---|---|---|---|
| baseline | 4.00 % | 0.474 | 2412 | 1.158 | 7315 | 24 263 |
| wall T0 = Tc_ideal·0.91² (all c* loss as temperature) | 1.94 % | 0.231 | 2163 | 0.420 | 7247 | 24 202 |
| wall T0 = 0.95·Tc_ideal | 3.24 % | 0.384 | 2349 | 0.937 | 7290 | 24 238 |
| Bartz h × 0.7 | 2.03 % | 0.242 | 2287 | 0.828 | 7251 | 24 189 |
| Bartz h × 1.3 | 6.16 % | 0.725 | 2480 | 1.481 | 7382 | 24 350 |
| throat composition at 0.8 × bulk O/F | 2.56 % | 0.304 | 2421 | 1.156 | 7268 | 24 177 |
| throat composition at 1.2 × bulk O/F | 7.34 % | 0.861 | 2454 | 1.162 | 7418 | 24 450 |
| kinetic A × 0.5 | 3.28 % | 0.389 | 2471 | 1.158 | 7292 | 24 239 |
| kinetic A × 2 | 4.81 % | 0.568 | 2351 | 1.159 | 7340 | 24 290 |
| no graphite chemistry (`sizing_only_mode`) | 0 | 0 | 2412 | 1.155 | 7183 | 24 102 |
| liner T_ablation 1500 K | 4.01 % | 0.474 | 2413 | 2.078 | 7311 | 24 247 |

At fixed line pressures, erosion **raises** thrust: the larger throat lowers Pc, the injector drop rises and flow rises. The burnout effect is +1.8 % thrust, and +0.67 % on impulse. In the closed loop, burn time shortens by 21 ms (−0.6 %) between pass 1 and pass 2.

#### 3. Hardware geometry over time: available, computed-but-discarded, or absent

`TimeVaryingCoupledSolver` builds wall stations in `_build_walls` (time_varying_solver.py:228-251):
- 4 liner stations, at mid-barrel, cone start, mid-cone and liner end;
- a `throat` station (graphite);
- an `exit` station only if `nozzle_ablative` (false on LE4).

LE4 station positions and burnout state (He, 70-point replay):

| station | x [mm] | recession [mm] | remaining [mm] | T_surface [K] | T_back [K] |
|---|---|---|---|---|---|
| liner0 (barrel) | −139.4 | 1.160 | 11.54 | 1986 | 300.0 |
| liner1 (cone start) | −54.4 | 1.175 | 11.52 | 1986 | 300.0 |
| liner2 | −45.2 | 1.535 | 11.16 | 1986 | 300.0 |
| liner3 (liner end = insert upstream edge) | −35.9 | 2.098 | 10.60 | 1986 | 300.0 |
| throat (graphite, 6 mm) | 0.0 | 0.474 | 5.53 | 2412 | **2326** |

| quantity | status | where / key | LE4 value (He) |
|---|---|---|---|
| Throat area and diameter vs t | **available** | `A_throat`, `D_throat` (time_varying_solver.py:687-697); replay keeps `A_throat_m2`, `throat_area_ratio`, `recession_throat_mm` (replay.py:107-109); D_throat discarded but derivable | D_t 47.81 → 48.75 mm; At ×1.040 |
| Recession along x | **computed at 5 stations, mostly discarded** | per-station `_walls[name]["model"].receded`. `get_results_dict` exports only the barrel (`recession_chamber`), `recession_liner_peak`/`x_liner_peak` and the throat. replay.py keeps barrel and throat only (replay.py:109-110). There is no per-station time history: only the end state lives on the solver, which `runner.evaluate_arrays_with_time` discards (runner.py:789-804). | table above |
| Divergent half of the insert and the nozzle | **absent** | `_geometry` recedes only `c.x ∈ (x_end, 0]` with the throat value (time_varying_solver.py:338-339). The insert spans ±0.75·D_t (= ±35.85 mm), as in chamber_geometry_fixed.py:121-130, but its downstream half never recedes. A_exit is fixed (`nozzle_ablative: false`). | — |
| Liner char depth | **partly** | `char_depth_chamber` (barrel), `char_depth_peak` (= char depth **at the most-receded station**, not the deepest char), both in results; replay keeps only `char_depth_peak_mm` (replay.py:123) | barrel 0.360 mm; "peak" 0.219 mm (labelling misleads) |
| Remaining liner thickness | **computed, discarded** | `WallModel.thickness_first` | 10.60–11.54 mm of 12.7 |
| Chamber ID | **barrel only, discarded** | `D_chamber` (time_varying_solver.py:689); no profile along x | 127.00 → 129.32 mm |
| L*(t) | **available** | `Lstar_m` (replay.py:118) | 1.3582 → 1.3671 (t ≈ 2 s) → 1.3531 m |
| Contraction ratio | **computed, discarded** | `contraction_ratio` (time_varying_solver.py:691) | 7.057 → 7.037 |
| Ae/At | **available** | `eps` (replay.py:111) | 4.826 → 4.642 |
| Case / back-wall temperature | **absent** for LE4 | `stainless_steel_case: null` (ethalox_6800N.yaml:241), so the liner back (`T_bondline`) and graphite back (`T_graphite_back`) are **adiabatic** (wall_conduction.py:3-5). Both are in results; replay.py discards both. | liner back 300.0 K all burn; graphite back **2326 K** at burnout |
| Soak-back after shutdown | **exists, never called** | `TimeVaryingCoupledSolver.soak_back(duration=120)` (time_varying_solver.py:599-606); only tests call it. The solver object is not returned by the runner. | see below |
| Heat flux along x vs t (Bartz) | **computed, discarded** | Per replay step, `diagnostics["cooling"]["ablative"]["segment_x/segment_r/segment_q_conv/segment_q_rad/segment_q_net/segment_h/segment_M"]` holds 278 points over the whole contour, face to exit (ablative_cooling.py:112-125, `with_profile` true on the non-silent replay path, chamber_solver.py:540-547). It is evaluated at the **quasi-steady** wall temperature of 1986 K, not the transient wall. The transient station fluxes kept are `heat_flux_chamber` (barrel) and `heat_flux_throat` (conv + rad only), replay.py:119-120; the conv/rad/chem split (`q_conv_throat`, `q_chem_throat`, …) is discarded. | throat 28.3 → 7.4 MW/m² conv (cold to hot graphite); barrel 3.3 → 2.3 conv + 0.8 rad |
| Injector face heat flux | **absent** | nothing models the copper faceplate's thermal state | — |

**Soak-back** (`soak.py`; adiabatic hot face after shutdown, adiabatic back face):

| station | stored energy above 300 K [J/m²] | adiabatic equilibrium [K] | L²/α [s] | soak 120 s (the default) | soak 600 s | soak 3600 s |
|---|---|---|---|---|---|---|
| liner0 | 1.51e6 | 354.5 | 913 | 325.5 | 354.3 | 354.5 |
| liner3 | 0.94e6 | 337.1 | 771 | 321.3 | 337.1 | 337.1 |
| throat graphite | 3.62e7 | 2355.5 | 0.42 | 2355.5 | 2355.5 | 2355.5 |

The 120 s default captures 25.5 K of the barrel's 54.5 K rise. A 12.7 mm phenolic liner needs ~600 s.

The graphite insert is nearly isothermal (L²/α = 0.42 s at the room-temperature k of 92.67 W/m·K) and has no heat sink. It therefore ends at **2326 K back face / 2355 K soaked**. That figure stands until a backing (liner or steel housing) and its contact are declared. The insert would actually be heating whatever sits behind it.

The config disagrees with itself here. The header comment of ethalox_6800N.yaml (lines 13-14, inherited from 6500N) says "5.000 in bore (0.5 in ablative + 0.25 in steel in a 6.5 in OD)", but `stainless_steel_case: null`.

The insert geometry has no stated provenance: thickness 6 mm (`initial_thickness 0.006`) and half-length 0.75·D_t (`axial_half_length_ratio` default). Graphite conductivity is constant at room temperature; only cp(T) is modelled (`butland_maddison_1973`).

**Contour redraw against local recession (low).** Each step's gas loads use `contour_for(cg_now)` (time_varying_solver.py:429). That **redraws** the 45° contour from (A_t, D_barrel, V) rather than applying the local recession. At burnout the liner3 station's radius moves only 0.18 mm (44.90 → 45.08 mm) although that wall receded 2.10 mm, so Bartz (∝ r^−1.8) there is about 7 % high, which is conservative. The face also moves 0.37 mm in the redraw.

#### 4. Contour for a to-scale cross-section

**Available.** `engine.pipeline.thermal.gas_side.wall_contour(A_throat, chamber_diameter, volume, A_exit)` (gas_side.py:234-282) and `contour_for(cg)` (:285) return `WallContour(x, r, x_face, x_cone_start, x_arc_start, R_t, R_c, volume, beam_length)`. The throat is at x = 0 and the face at x_face < 0. The construction is barrel, then 45° cone, then a 1.5 R_t arc, then a TOP-Bézier Rao bell (`generate_nozzle` → `rao(method="top")`, chamber_geometry.py:164-166). The barrel length closes the declared volume.

For LE4 (278 points):
- face at −224.43 mm, which matches the config comment "face-to-throat 224.4 mm";
- cone starts at −54.45 mm and the arc at −25.35 mm;
- R_t 23.90 mm, R_c 63.50 mm, L_cyl 169.98 mm (config: 169.98);
- exit at x = 85.43 mm, r_e = 52.52 mm;
- θ_n 22.78°, θ_e 13.11°;
- the volume integrates to −0.05 % of the declared value.

The **Geometry tab uses different constructions** (backend/routers/geometry.py):
- `solved_chamber_plot` for the chamber (:197-221);
- `rao(method="garcia")` for the bell (:299-306), with the same N/E points and angles but a different curve;
- `calculate_chamber_geometry_fixed` for the layer bands, which estimates a 15° conical nozzle length (:145).

For a cross-section that matches the erosion stations, use `gas_side.wall_contour` with these layers:
- liner `ablative_cooling.initial_thickness` (12.7 mm) for x ≤ liner_end (−35.85 mm);
- graphite 6 mm over ±35.85 mm;
- no case declared.

Draw the eroded wall as r0(x) + s(x,t), with s linear between station x's as in `_geometry` (time_varying_solver.py:319-348; `coverage_fraction` 0.9 scales only the volume). Do not draw `contour_for(cg_now)`, which is a redraw.

#### 5. Nozzle separation

- `delivered.p_exit_psia` comes from CEA shifting-equilibrium Pe at (MR, P0, eps(t)) (nozzle.py:171-174; replay.py:114).
- `delivered.ambient_psia` is the pad's value, or the trajectory's when flown (analysis.py:246-260).
- `M_exit` is in the TVS results but **dropped** by replay.py.
- The frontend already flags separation at Summerfield pe/pa < 0.4 (`components/layerx/plume.ts:10, 52`).

On the pad (He), Pe/Pa runs 1.034 → 1.129. Schmucker's threshold, Psep/Pa = (1.88·M_e − 1)^−0.64 with M_e 2.666 → 2.641, is **0.411 → 0.414**. Summerfield and Schmucker agree, and the margin is about 2.5×. Pe/Pc ≈ 0.0361, so separation would begin below **Pc ≈ 155 psia**, which happens only in start/shutdown transients. The twin and replay do not model those: the first firing step is already at 390.5 psia, and the burn ends on depletion with no tail-off.

The check is feasible now on (p_exit, ambient), plus M_exit if Schmucker is wanted, which replay.py would have to keep. It only means something if start and shutdown ramps exist.

**`gamma_exit` is mislabelled.** `calculate_thrust` sets `gamma_exit = gamma_val` (the chamber γ) at nozzle.py:181. replay.py:116 and plume.ts take it as the exit γ: it reads 1.1348–1.1355 throughout. The effect on the plume's M_e is small (2.679 isentropic at that γ against CEA's 2.666), but the label is wrong.

#### 6. Delivered Isp breakdown

`calculate_thrust` (nozzle.py:67-277): F = ζ_n·Cf_vac(CEA shifting, P0, eps)·P0·At − Pa·Ae, with P0 = Pc/κ (Rayleigh, nozzle.py:40-54). η_c* enters through the reduced Pc. `reaction_progress` is accepted and **unused** (nozzle.py:104-105), so the per-step `calculate_chamber_reaction_progress` (time_varying_solver.py:409-412) has no effect on thrust.

η_c* = η_vap × η_mix × η_HL (combustion_eff.py:98-184). The breakdown is in `diagnostics["cstar_efficiency"]` per replay step, and replay.py discards it.

Rebuilt waterfall at t = 0.05 s (He):

| term | value |
|---|---|
| Isp_vac,ideal (CEA shifting, P0, ε 4.826) | 290.98 s |
| η_c* | 0.9101 (vaporisation 0.9911, mixing 0.9215 by Rupe E_m 0.792, heat loss 0.9966) |
| ζ_n | 0.95, **one lumped constant** (`chamber_geometry.nozzle_efficiency`, no provenance in the config) |
| κ (Rayleigh) | 1.0041 |
| ambient term Pa·Ae/(mdot·g0) | −27.10 s |
| delivered | 224.50 s rebuilt, against 224.51 s from the solver |

At burnout: 289.77 s × 0.9125 × 0.95 − 25.18 s = 226.00 s.

There is **no** separate divergence, boundary-layer, kinetic or two-phase loss. A conical-equivalent divergence estimate (1+cos θ_e)/2 at θ_e 13.1° is 0.987, which would leave about 3.7 % of ζ_n unattributed. That is an estimate, not a MOC result; not verified.

#### 7. Other defects found

- **Silent zero-erosion path (medium).** `replay()` passes `track_ablative_geometry=None` (replay.py:77). The runner's coupled path then runs only when `ablative_cooling.enabled and track_geometry_evolution` (runner.py:771-784). With the liner disabled but graphite on, or with tracking off, it falls to the legacy constant-geometry loop, with no warning and no strict-mode raise (that raise is inside `if track_ablative_geometry`, runner.py:993-1025). Measured (`gate.py`): throat growth 0.000 % against 3.72 % as shipped. Layer X then reports `throat_ablation: True` and a converged loop, and drops `T_graphite_surface_K` because the key is missing.
- **Dead graphite configuration (low).** The coupled path never reads these LE4 `graphite_insert` fields:
  `oxygen_mass_fraction 0.05`, `oxidation_rate`, `activation_energy`, `oxidation_reference_*`, `oxidation_pressure_exponent`, `oxidation_enthalpy 32.8e6`, `heat_of_ablation 15e6`, `ablation_surface_temperature 3000`, `ablation_transition_width`, `mixture_mw`, `char_layer_*`, `feedback_fraction_*`, `recession_multiplier`, `reference_diffusivity*`, `friction_coefficient_override`, `oxidation_stoichiometry_ratio`.
  `coverage_fraction` and `simplified_*` are read only by the legacy runner path. They look authoritative and are not.
- **Liner model (medium).** The ablative liner is a melting-ablator Landau balance: the surface is clamped at `ablation_surface_temperature` 1986 K (the SiO2 melting point, schema description) and consumes `heat_of_ablation` 2.5 MJ/kg. Every property except thickness (12.7 mm), coverage (0.9) and pyrolysis temperature (950 K) is a **schema default** with no material source; the liner material is not named in the config. There is no pyrolysis-gas energy sink in depth, and `char_layer_*` is unused. `coverage_fraction 0.9` is unexplained.
- **η_HL source.** η_HL uses the quasi-steady liner model at 1986 K (chamber_solver.py:1000-1021), not the transient wall's heat, and excludes the graphite throat's heat. It is 0.9966, so the impact is small.
- **Pressure for oxidation.** Throat P_static and the gas P0 use the injector-end Pc, not Pc/κ: a 0.4 % effect.
- **Tank-pressure rise (context for the feed auditor).** In the He run, tank pressure climbs from 574.4 to 618.4 psia over the burn, above the 578 psia lockup, while GN2 climbs from 570.8 to 577.7. This, not erosion, is why He thrust rises from 6752 to 7315 N (+8.3 %) with Pc only 390 → 405 psia.

### 9.3 Flight coupling

Area: Flight coupling (engine/layerx/flight.py, ui/flight_sim.py, acceleration into lib/feedtwin).

**Auditor's summary.** The acceleration chain is right. RocketPy's specific force (net thrust plus R3, over mass) replaces gravity in feedtwin; nothing adds g to it. A hand calculation, ρ·a·level on the drawing's tank geometry, reproduces the twin's tank-outlet head to 0.0001 psi on a flown run. At liftoff the value is 8.2500 g against T/m of 8.2497 g, and every pad pass is exactly 1.0000 g0. The coupling still adds almost nothing, because no drawing gives any line a height. Flight adds only the tank heads (+1.1 to +1.6 psi at the injector inlets, +0.26 % mean thrust, +6.8 m apogee). With the team's 4.5 ft fuel and 1 ft LOX lines taken as vertical (an upper bound), the fuel inlet gains +10.7 psi and LOX +4.1 psi. O/F falls 2.1 %, from 1.518 to 1.485, and the burn ends fuel-first with 0.073 kg of LOX left over (an oxidiser-rich shutdown). The flight cannot run on the helium hot-fire drawing: setup_flight sizes the COPV refill with the config's nitrogen ullage density and stops with 'COPV holds 0.208 kg; needs 0.521 kg'. A flown run also feeds the acceleration heads into the feed fit's K0, which is wrong by 4–10 % now and by up to 41 % once line heights exist. On the vehicle side, the flight rests on template and default values: an unmeasured 3.35 m rail, a default 4.0 m payload length, and a target_apogee with no source. At the config's 3.35 m (11 ft) rail, rail exit is 71 ft/s, under FAR-OUT's 85 ft/s minimum. An inline 1-DOF ascent matches RocketPy's specific force to 0.002 % and its apogee to 0.12 %, at 5–30 ms per burn, so it could replace the outer flight loop.

#### 0. What was run

Experiment scripts and outputs are in `/private/tmp/claude-501/-Users-carlton-Downloads-STAR-ASF-STAR-EngineDesign/6e249fb6-61aa-428c-b921-67469511876f/scratchpad/audit/flight/`. No repo file was edited.

| id | what | data |
|---|---|---|
| E1 `e1_refly.py` | Re-flew the latest stored flown run (`.userdata/local/engine/layerx/runs/20261002-231658-7e47d1.json`: GN2 drawing, 190 lb liftoff, apogee 2953.30 m) with `flt._flight_config` + `setup_flight`, keeping the RocketPy `Flight`. Compared `flight.axial_acceleration` with RocketPy's kinematic acceleration plus gravity projected on the body axis. Also read max-Q, CG(t), static margin(t) and the coast. | `e1_out.txt` |
| E2 (inline) | Hand-checked the tank-outlet head in the stored flown series against ρ(T_liq)·a·level. Level from the drawing's volume and diameter with 2:1 heads; a = the schedule value at the start of each step. | below |
| E3 `e3_decompose.py` | Seven LE4 burns on `copv_study_gn2` with `configs/ethalox_6800N.yaml` (repo): pad as-built (no replay), pad eroded, flight eroded, and pad/flight with line heights restated in memory. Heights were either the drawn lengths taken as vertical (fuel 0.9144 m, LOX 0.07 m) or the team-stated vehicle lines taken as vertical (fuel 4.5 ft = 1.3716 m, LOX 1 ft = 0.3048 m). Helium drawing: pad cases plus the flight attempt. | `e3_gn2.json`, `e3_he.json` |
| E4 `e4_onedof.py` | `engine/pipeline/flight_1dof.vertical_apogee_agl` and a 1-DOF specific-force integration against RocketPy, on the same curve, drag and mass. | `e4_out.txt` |
| E5 `e5_rail.py` | Rail exit velocity against rail length (10/11/20/60 ft), and an 80° rail. | `e5_out.txt` |
| E6 `e6_analyse.py` | Thrust-deviation decomposition from the E3 series. | `e6_gn2_out.txt` |
| E7 `e7_layout.py` | Sensitivity of apogee, static margin and max-Q to layout and finish values. | `e7_out.txt` |
| E8 `e8_he_fly.py` | The helium burn flown with the config's ullage gas (fails), then with the ullage gas restated to helium in a scratch config copy. | `e8_out.txt` |

**Config note.** The live server config (`GET :8000/api/config`, fingerprint `ae3edfd7…` = `~/Downloads/6800N-Engine.yaml`) is not `configs/ethalox_6800N.yaml` (`7782d2fd…`). They differ only in `feed_system.{oxidizer,fuel}.length` (0.1016/0.9144 m live vs 0.3048/1.3716 m repo) and the `graphite_insert` properties (2260 kg/m³ live vs GR001CC 1810 kg/m³ repo). The `rocket`, `lox_tank`, `fuel_tank`, `press_tank` and `environment` sections are identical, so the flight inputs are the same. The latest stored run's fingerprint `0a7bafc0…` matches neither. That is why its numbers (burn 3.466 s, O/F 1.498) differ from E3's (burn 3.589 s, O/F 1.518).

---

#### 1. Is the head computed from specific force, and is g double-counted?

##### The chain, RocketPy to the liquid column

1. **RocketPy's equations of motion.** In `rocketpy/simulation/flight.py` 1.11.0, the axial equation is `(R3 − b·m_p·(α2 − ω1ω3) + net_thrust)/M`, after which `az -= g` (lines ~1740–1745). On the rail, `udot_rail1` uses `a3 = (R3 + net_thrust)/M − g·(…)`, and `a3` is clamped to 0 while it is negative (rocket held). Here `R3 = −½ρV²·A·Cd(M)` is the axial aerodynamic force, and `net_thrust = thrust + (p_ref − p(z))·A_e`.
2. **`engine/layerx/flight.py:214-230` `axial_acceleration`** returns `(motor.thrust(t) + (p_ref − p(z))·A_e + flight.R3(t)) / rocket.total_mass(t)`. That is the specific force along the body axis, with no gravity term. It reads `motor.thrust` rather than RocketPy's `net_thrust` because `net_thrust` reads 0 at t = 0; E1 confirms 0.0 N there.
3. **`flight.py:274`** samples it at each time-series stamp, `t = clock − clock[0]`. **`flight.py:309`** returns `schedule = {t: clock, accel_m_s2}` on the burn's own clock.
4. **`engine/layerx/analysis.py:94-99`.** In each step's `record`, for firing steps and the last lead-in sample (`clock > −1e-6`), it sets `session.setup = replace(setup, body_acceleration = interp(clock, schedule))`. The value at the end of step k drives step k+1, a one-step (50 ms) lag.
5. **`lib/feedtwin/feedtwin/session/core.py:2316`** sets `net.gravity = setup.body_acceleration`, and **`core.py:2324`** sets `sim.gravity = setup.body_acceleration` on every tank. The flight value replaces gravity; nothing adds to it.
6. **Tank head:** `core.py:763-764` calls `tank.outlet_pressure(state, gravity)`, which is `vessels/tank.py:423-435`: `p_ullage + ρ_liq·gravity·level`. `core.py:2036-2038` writes it to the outlet node every step. The build-time 1 g column head (`pid/network.py:902-946`, the only other hard-coded `9.80665`) is overwritten there.
7. **Line and manifold heads:** `solve/network.py:296-308` builds `conditions_from_fluid(..., gravity=self.gravity)`. Then `comps/elements.py:161-162` (pipe), `elements.py:847-848` (segmented line) and `comps/manifold.py:136-137` compute `ρ·flow.gravity·Δz`.
8. **Default:** `Setup.body_acceleration = GRAVITY = 9.80665` (`core.py:525`, `vessels/volume.py:44`). `prepare.py:632` (`burn_setup(...)`) does not set it, so pad passes and every lead-in run at standard gravity.

##### Numerical verification (E1, E2)

**Liftoff.** T(0) = 6972.30 N and m(0) = 86.183 kg give T/m = 8.2497 g. `axial_acceleration` gives 8.2500 g; the 0.28 N difference is the pressure term from ISA rounding. RocketPy's kinematic `az + g` gives 8.2500 g.

**Through the burn**, `axial_acceleration` and kinematic + g on the body axis:

| t (s) | 0.05 | 0.30 | 3.30 | 3.40 | 3.45 |
|---|---|---|---|---|---|
| specific force | 8.2650 g | 8.1335 g | 9.0560 g | 9.0731 g | 9.0813 g |
| kinematic + g | 8.2628 g | 8.1339 g | 9.0551 g | 9.0737 g | 9.0991 g |

They agree to ≤0.03 % from 0.05 to 3.40 s. The 0.2 % at 3.45 s is interpolation of the trajectory derivative next to the cutoff, the artefact `flight.py:220-223` documents.

**Tank head in the flown series** (E2, run `20261002-231658-7e47d1`):

| tank | t (s) | a | level | ρ (kg/m³) | hand ρ·a·level | sim outlet − ullage |
|---|---|---|---|---|---|---|
| LOX | 0.05 | 8.250 g | 0.2966 m | 1142.0 | 3.975 psi | 3.974 psi |
| LOX | 1.80 | 8.612 g | 0.1541 m | — | 2.155 psi | 2.155 psi |
| Fuel | 0.05 | 8.250 g | 0.3067 m | 789.3 | 2.841 psi | 2.840 psi |

The largest |hand − sim| over every firing step is 0.0001 psi on both sides. If g had been added (9.25 g instead of 8.25 g), the LOX head at 0.05 s would read 4.46 psi, 0.48 psi off. So there is **no double counting**. The match also confirms the start-of-step (one-step-lag) mapping.

**Pad.** Over every firing step of the E3 pad passes, the implied a/g0 = (outlet − ullage)/(ρ·g0·level) is 1.0000 on both sides. That is exactly standard gravity. Local g at FAR (35.35° N, 627 m) is about 9.796 m/s² by Somigliana, 0.11 % less, which is 0.0005 psi on the LOX tank head and negligible.

##### Defects in `axial_acceleration`

- **Pressure thrust after burnout (low).** `flight.py:229` adds `(p_ref − p(z))·A_e` whenever `reference_pressure` is set, including after the motor has stopped. E1, specific force against kinematic + g in coast:

  | t (s) | 3.6 | 10 | 25 (apogee) |
  |---|---|---|---|
  | `axial_acceleration` | −0.782 g | −0.065 g | +0.340 g |
  | kinematic + g | −0.843 g | −0.283 g | 0.000 g |
  | spurious term | +45.6 N | +160.7 N | +250.9 N |

  It corrupts `trajectory.accel_axial_g` (API/JSON only; `layerx/Flight.tsx` does not plot it). It also corrupts the burn schedule's last sample, which sits after RocketPy's cutoff: −0.800 g against a true −D/m = −632.5/75.18 = −0.858 g. The burn never uses that sample.
- **Pre-liftoff hold not handled (latent).** While RocketPy holds the vehicle (`a3 ≤ 0`), the column feels g·sinθ, but `axial_acceleration` returns T/m. LE4's twin has no start transient: the first 50 ms firing step is already 6971 N and the Fire sample copies it (`replay.py:268-279`), so T/W = 8 at t = 0 and this does not fire today. Any curve with a ramp (a measured curve, a modelled fuel lead) would get T/m < 1 g on the pad.

#### 2. How flight time maps to burn time

- `replay.timeseries_payload` (`replay.py:228-285`) stamps each firing step at its end and inserts a Fire sample at `t_first − dt`, carrying the first step's values. `fly()` sets `t = clock − clock[0]`, so **flight t = 0 is the Fire command, which is ignition, which is first motion**. No ignition delay, valve travel or fuel lead is modelled (drawing MVO/MVF `travel_time` 0.05 s; the twin's first step is at full thrust).
- RocketPy rail phase: 0 to 0.3075 s (stored run). `R3` is post-processed through `u_dot_generalized`, so the rail-phase specific force includes drag (−2.8 N at 0.25 s).
- The schedule goes back on the burn's clock (`flight.py:309`) and is applied with a one-step lag (`analysis.py:94-99`). The acceleration changes about 0.3 g/s, so the lag is about 0.015 g (0.17 %) per step: ≤0.005 psi on the tank heads.
- **Two-way by fixed-point iteration** (`analysis.py:184-206`): burn, then fly, then burn with that acceleration, until `schedule_change < ACCEL_TOLERANCE = 0.5 %` (`flight.py:45`) and the throat history settles. The stored run took 4 passes (2 pad, 2 flown); pass 3 changed the acceleration 0.48 % and pass 4 0.003 %.
- **One-way or open:**
  - **Altitude ambient into thrust.** It is applied only inside RocketPy (`flight_sim.py:938-957`). The replay runs at the site ambient (`replay.py:79`, `P_ambient=prep.ambient_pa`), so Layer X's `in_flight` impulse and mean thrust leave out +52.6 N·s (0.22 %) and reach +42 N short by burnout (E3/E6). This does not matter for the feed: a choked nozzle's Pc and flow do not depend on ambient.
  - **Altitude ambient into the dome control regulator's vented reference and the tank vents.** Not modelled (`docs/layer-x.md:459`). Burnout ambient is 89.0 kPa against the site's 94.0 kPa, so a gauge-referenced dome would lose about 0.7 psi absolute by burnout. Not verified: the 1092-50's reference arrangement is unknown.
  - **Acceleration into buoyancy-driven heat transfer.** `vessels/convection.py:28` fixes `G = 9.80665`, and its `still_gas_conductance` is evaluated once at build (`core.py:670-693`). The cockpit's fixed film coefficients do not scale either. In the turbulent regime h ∝ g^(1/3), about ×2.0–2.1 at 8–9 g. Not quantified.
  - **Mass history.** The flight flies the replay's mdot (delivered), capped by the twin's loads, so RocketPy cuts thrust at its own depletion: 3.4651 s against the twin's 3.4663 s in the stored run, about 9 N·s.
  - **Pressurant species.** The flight uses the config's `lox_tank/fuel_tank.ullage_gas` (Nitrogen), not the drawing's pressurant. See §7.1.

#### 3. Static margin, CG over time, max-Q, rail exit

RocketPy already provides everything needed:

- `rocket.center_of_mass(t)`, and `rocket.static_margin(t)` (Barrowman CP at M = 0);
- `flight.stability_margin(t)` (CP at flight Mach), `flight.min/max_stability_margin`, `flight.out_of_rail_stability_margin`;
- `flight.dynamic_pressure(t)`, `flight.max_dynamic_pressure(_time)`, `flight.angle_of_attack(t)`, rail-button loads.

`flight_sim.flight_report` (`ui/flight_sim.py:332-400`) puts static margin at liftoff, rail exit and burnout, plus min/max stability margin, into `result.flight.stability`. **None of it reaches the Layer X UI**: `frontend/src/components/layerx/Flight.tsx` shows apogee, rail exit, accelerations and the ceiling only. **Max-Q is not computed anywhere** (no `dynamic_pressure` in `engine/`, `ui/`, `backend/` or the frontend).

E1 values (stored run, config tank positions LOX 0.8 m, fuel 3.0 m, COPV 3.6 m above the nozzle exit):

| t (s) | CG from tail | static margin | mass |
|---|---|---|---|
| 0 | 2.7528 m | 7.727 cal | 86.18 kg |
| 1 | 2.7860 m | 7.939 cal | — |
| 2 | 2.8258 m | 8.192 cal | — |
| 3 | 2.8739 m | 8.500 cal | — |
| 3.465 (burnout) | 2.8996 m | 8.664 cal | 75.18 kg |

- CP (M = 0) stays at 1.5419 m; body diameter 0.1567 m. CG moves 0.147 m forward over the burn.
- Flight-Mach stability margin: 7.727 to 8.915 cal.
- Max-Q **36.8 kPa (5.34 psi) at burnout, 3.465 s**, Mach 0.768, 258.1 m/s, 436.6 m AGL. A 1-DOF hand check gives q = 36.7 kPa.
- Rail exit 21.69 m/s at 0.3075 s. Static margin at rail exit 7.79 cal; with a vertical rail and no wind, the angle of attack is 0.

These rest on template or default vehicle data:

- `rocket.avionics_payload_length_m = 4.0` is the schema default (`config_schemas.py:1533`), so the stack is 7.757 m against `rocket.rocket_length` 6.433 m.
- `environment.rail_length_m = 3.35` is the schema default, "not a measured rail" (`config_schemas.py:1583`).
- Tank positions are the template layout that `docs/layer-x.md:416-421` already withdrew for line heights.
- The config tanks are 6.44 L and 6.20 L; the drawing's are 15.10 L and 8.67 L.

E7 sensitivities: shortening the stack to 6.433 m raises the static margin to 8.71/9.65 cal and apogee by +68 m. Moving the fuel tank onto a 4.5 ft line lowers the static margin to 7.06/8.27 cal.

#### 4. Apogee target

- `design_requirements.target_apogee` = **3890.7 m** AGL (schema default 3048 m, `config_schemas.py:1637`). It has no provenance and is used by `layer2_pressure.py` and `flight_altitude_optimizer.py`, **not by Layer X**. Its value matches, to 0.7 m, an old 6.5 kN flight-sim result quoted in `ui/flight_sim.py:472`, which suggests it was written back from a simulation, not declared.
- Layer X checks only `max_apogee_m` + `max_apogee_datum` (`flight.py:203-211`). Both are None in LE4's config, so `ceiling` is None.
- Flown apogee: 2953.3 m (9,689 ft, stored run) and 2933.4 m (E3, repo config). Both are about 24 % below `target_apogee`.
- **FAR-OUT** (Rules and Requirements, rev 2024-10-02; the 2026 edition is not verified):
  - Each team declares a **"contract apogee"** in its group: Group A is 3,000–15,000 ft.
  - The score depends on reaching it and on how accurately the simulation predicts the trajectory with the day's forecast. The scorable region is 50–150 % of the contract.
  - Total impulse must be < 40,960 N·s (LE4 is about 24,100: OK).
  - Static stability ≥ 1.5 cal over the whole ascent (LE4 7.1–8.9: OK).
  - Rail exit must exceed **85 ft/s**, and teams should design for > 100 ft/s with T/W > 10 recommended.
  - Launch is refused above 20 mph surface wind or 20° off vertical. FAR's rails are 10 ft 1010, 10 ft and 20 ft 1515, a 20 ft tower and a 60 ft T-slot.
- No config field holds the contract apogee with provenance. Apogee is run vertical, windless and ISA (critique Ph14 open). The `forecast` atmosphere toggle exists (`flight_sim.py:722-731`) but there is no wind or dispersion.
- Contract accuracy is dominated by vehicle-model terms, not feed coupling (E5, E7):

  | change | apogee |
  |---|---|
  | roughness 60 → 20 µm | +118 m |
  | roughness 60 → 0 µm | +199 m (+6.7 %) |
  | stack at `rocket_length` | +68 m |
  | 80° rail | −119 m (−4.0 %) |
  | pad → flight coupling (stored run) | +6.8 m |
  | team line heights (E3) | −2 m |

#### 5. An inline 1-DOF ascent inside each burn pass

`engine/pipeline/flight_1dof.py` already integrates `dv/dt = (F + (p_ref − p(z))A_e − ½ρv|v|Cd(M)A)/m − g` in ISA (`vehicle_drag.isa_troposphere`), with the same `DragCurves` RocketPy flies (`vehicle_drag.resolve_drag_curves`, `built_stack`). On the stored curve, with the same drag and mass (E4):

| | 1-DOF | RocketPy |
|---|---|---|
| apogee | 2949.70 m (−0.120 %) | 2953.24 m |
| burnout state | z 435.2 m, v 257.69 m/s | z 434.0 m, v 257.28 m/s |
| wall time | 5.5 ms (apogee); 33 ms (pure-Python RK4, 10 ms steps) | 0.83 s (setup + fly) |

Through the burn, the specific force agrees to **0.002 % at worst** (mean +0.0008 %). Feeding the twin's own card thrust instead of the replay's delivered thrust shifts the specific force by ≤0.5 %: replay − twin is −10.6 N mean, 33.5 N max (E6), which is ≤0.05 psi of head even with the team line heights. A flown run takes 108 s against 64 s for the pad (E3, GN2), so an inline integration would remove one or two full twin+replay passes.

**Drag data that exists.** LE4 has none measured: `rocket.drag_curve_power_off/on` and `drag_curve_source` are None. RocketPy and the 1-DOF both use the OpenRocket/Barrowman build-up (Niskanen 2013), with surface roughness 60 µm (schema default, "regular paint"). Cd_off is 0.850, 0.856, 0.870 and 0.898 at M 0.1, 0.3, 0.5 and 0.77; Cd_on is 0.795 to 0.809. `star-openrocket/` (repo root) holds the FAR site, climatology/wind and an Onshape CM build, but no ascent drag.

#### 6. Decomposing thrust flatness

**From the data a run already keeps: no.** A run stores only the last pass's `series` and `delivered`. `passes[]` and `flight.pad` hold scalars. The loop does compute every term internally:

- pass 1 twin: as-built throat, 1 g;
- pass 1 replay: eroded throat at pass-1 pressures;
- pass 2: eroded, 1 g (the `ground` figures);
- passes ≥3: flown;
- altitude: `trajectory.altitude_m` with A_e from `motor_header`.

Keeping a thrust/inlet series per pass would make the decomposition free.

**Decomposition** from separate E3 runs (GN2 drawing, repo config, settled window 0.2–3.59 s). Flown thrust plus the altitude term: mean 6735 N, range 6568–6980 N (**6.13 % spread**), end − start +361 N.

| component | at 0.2 s | mid | end | end − start | RMS dev |
|---|---|---|---|---|---|
| feed (pad, as-built: regulator droop and recovery, tank sag) | −66.5 N | +2.2 | +140.6 | +207.1 | 87.2 |
| erosion (pad eroded − pad as-built; throat +4.0 %) | +3.3 | +37.3 | +140.8 | +137.6 | 39.4 |
| acceleration on tank heads (flight − pad, eroded) | +29.1 | +16.8 | +3.1 | −26.0 | 7.4 |
| altitude pressure thrust (p_site − p(z))·A_e | +0.1 | +12.0 | +42.2 | +42.0 | 12.7 |
| line heads in flight, team lengths vertical (not on the drawing) | +66.8 | — | +55.7 | −11 | — |

The rise over the burn comes from the feed and from erosion; acceleration is a minor term in flatness. Vertical line heads would mainly raise the mean, by about +60 N (+0.9 %). Mean thrust is about 6.7 kN with the repo config and 6.97 kN with the live config, against the 7.2 kN goal (not this area).

#### 7. Other coupling defects

##### 7.1 Flight fails on the helium (hot-fire) drawing (E3, E8)

On `copv_study_he`, `fly` returns: "COPV holds 0.208 kg; holding tank pressure over this burn needs 0.521 kg into the ullages. The regulated curve cannot be flown with this COPV."

- `setup_flight` sizes the T-0 ullage and the COPV refill with `ullage_gas_density(section)` (`ui/flight_sim.py:319-329`, `:781`, `:851-903`), which uses the config's `ullage_gas: Nitrogen`.
- `_flight_config` (`flight.py:145-184`) changes the pressurant mass to the twin's He bottle, 0.208 kg. Hand check (CoolProp, 4.6871 L, 4514.7 psia, 293.15 K): 0.209 kg.
- It does not change the species. The N2 refill (46–48 kg/m³) is 0.52 kg; with helium (6.42 kg/m³) it is 0.073 kg.
- With the ullage gas restated to helium in a scratch copy, the He burn flies: 2967.9 m, 7.99 → 9.19 g, rail exit 21.55 m/s.
- The run still reports `converged: true`, with a "Flight failed" warning event.

##### 7.2 No line heights on any drawing

`copv_study_he`, `copv_study_gn2` and `ethalox_stand` state no `elevation_change` on any edge. In flight only the tanks' own liquid feels the acceleration. With the team-stated lines (4.5 ft fuel, 1 ft LOX; `docs/layer-x.md:557`) restated as vertical drops (an upper bound, E3 teamH):

- fuel injector inlet +1.29 psi on the pad and **+10.71 psi** in flight; LOX +0.49 and **+4.07 psi**;
- O/F 1.5176 → **1.4852**;
- burn 3.589 → 3.553 s, and depletion flips from **LOX-first to fuel-first with 0.073 kg LOX stranded**;
- delivered impulse −26 N·s, apogee −2 m.

With the drawn lengths taken as vertical, fuel gains +7.0 psi, LOX +1.15 psi, O/F falls to 1.4891, and the burn is fuel-first with 0.055 kg LOX left. On the pad the margin is about 0.04 kg of fuel residual, which is smaller than the flight's O/F shift.

##### 7.3 The feed fit absorbs the flight heads

`feedfit.fit_feed` (`feedfit.py:59-80`) fits `K_line` by least squares of (tank ullage − line exit) against one velocity head. In a flown run the heads are inside that difference:

| case | LOX K_line | fuel K_line |
|---|---|---|
| pad | 0.718 | 2.150 |
| flight, tank heads only | 0.649 (−10 %) | 2.069 (−4 %) |
| flight, team heights | **0.479 (−33 %)** | **1.269 (−41 %)** |

`design_update` writes this into the design with only a `condition: "in flight"` note. EngineDesign's own feed model has no hydrostatic term (grep for head or hydrostatic in `engine/pipeline` and `engine/core` finds nothing).

##### 7.4 Stale docstrings

These still quote the withdrawn 2.5 m line, 20–26 psi and "~7 g at burnout": `flight.py:3-8` and `:41-44`, `feedtwin/session/core.py:526-531`, `feed-twin/backend/tunables.py:590-592`. Measured: 8.0–8.25 g at liftoff and 8.7–9.2 g at burnout.

#### 8. Disagreements to report (not fixed)

- Drawing LOX tank 15.10 L / Ø160.1 mm "estimated, not measured; sets the static head", and fuel 8.67 L / Ø154.4 mm, against config LOX 6.44 L / r 69.85 mm and fuel 6.20 L / r 76.2 mm. The twin's heads use the drawing (LOX level 0.297 m at Fire); RocketPy's CG uses the config. The config's LOX level would be about 0.378 m, about 27 % more head.
- Config `fuel_tank_pos` 3.0 m implies a fuel tank bottom about 2.4 m above the injector, against the team's 4.5 ft (1.37 m) fuel line.
- `rocket.rocket_length` 6.433 m against the flown stack 7.757 m (`avionics_payload_length_m` default 4.0).
- `environment.rail_length_m` 3.35 m (default, unmeasured) gives 71.2 ft/s at rail exit, under FAR-OUT's 85 ft/s. A 10 ft rail gives 67.9 ft/s, 20 ft gives 95.9 ft/s and 60 ft gives 166.4 ft/s (E5; hand √(2(T0/m0 − g)L) within 1 %).
- `target_apogee` 3890.7 m has no source, against FAR-OUT's team-declared contract apogee.

Sources: [FAR-OUT Rules and Requirements rev 2024-10-02](https://static1.squarespace.com/static/64cc93ec537b6a2fa74f96ba/t/66fd68cb569e9f24d43c5709/1727883469282/FAR-OUT+Rules+and+Requirements+Document+rev+2024-10-02.pdf), [Norco College FAR-OUT 2025 news](https://www.norcocollege.edu/news/far-out-competition-2025.html), [FAR launch contest rules](https://friendsofamateurrocketry.org/launch-contest-rules/).

### 9.4 Chug margin and stability over time

Area: Chug margin and stability over time (Layer X replay → EngineDesign stability/analysis.py + chug.py).

**Auditor's summary.** Layer X's chug margin comes from EngineDesign's stability analysis. It is computed inside the erosion replay at 28 quasi-steady points on the line-exit copy of the config, then interpolated onto the twin's firing steps. Three of its inputs do not follow the burn. (1) The feed inertance comes from the config's `feed_system.length`; the drawing's lines are never read. (2) The feed resistance is only the Borda dump, because `line_exit_config` zeroes K0. (3) L* and A_t are frozen at the design point, because the time-varying solver passes `self.config` rather than the eroded `config_current`. On LE4 (app doc "Ethalox 7200N Doublet", which is not configs/ethalox_6800N.yaml: the feed lengths and graphite properties differ) the burn-minimum gate margin is 1.330 on GN2 and 1.367 on He. Taking inertance and resistance from the drawing moves both up by about +0.10 (to 1.431 and 1.468). Unfreezing the geometry adds +0.08 to +0.09 at burnout but leaves the minimum almost unchanged. The verdict mostly rests on two unmeasured numbers, not on the feed system. One is the mixing-lag band: nominal GM is 2.18, but the gate taken at the band end is 1.33 at about 22 Hz. The other is the estimated fuel-line length: with zero inertance GM is 1.01, and GM reaches 1 at a 0.19 m fuel run. "Ignition included" is mislabelled: the twin's first firing step is already at full Pc (389.5 psia at t = 0.05 s), so start-up chug, the subject of Leonardi 2017, is not assessed at all. The feed-line acoustic modes (ethanol quarter-wave 296 Hz, LOX 1600 Hz) sit 8x to 70x above the chug band, so the lumped no-compliance model is adequate for the lines. Ullage and manifold compliance are negligible (each moves GM by less than 0.005).

Scripts and outputs are in `/private/tmp/claude-501/-Users-carlton-Downloads-STAR-ASF-STAR-EngineDesign/6e249fb6-61aa-428c-b921-67469511876f/scratchpad/audit/chug/`:
- `chug_replay.py`: re-runs a persisted replay with the stability call wrapped, and captures inputs plus variants.
- `chug_hand.py`: independent re-implementation of L(iω), plus the R, ullage and manifold variants.
- `band_freq.py`: root at the gate, and the critical fuel-line length.
- `supplyk.py`, `variants_he.py`, `line_acoustics.py`, `run_he_gn2.py`.
- Outputs: `chug_replay_out.json` (GN2) and `chug_replay_he.json` (He).

#### 0. Which config is LE4?
The persisted Layer X runs carry `config_sha256` `ae3edfd745c3…`. That matches the app document `.userdata/local/engine/ethalox-7200n-doublet/current.json`, not `configs/ethalox_6800N.yaml` (fingerprint `7782d2fdd7f9…`). `cfg_diff.py` shows how they differ:

| field | app doc | ethalox_6800N.yaml |
|---|---|---|
| `feed_system.fuel.length` | 0.9144 m (3 ft) | 1.3716 m (4.5 ft, "team, 2026-10-01", vehicle) |
| `feed_system.oxidizer.length` | 0.1016 m (4 in) | 0.3048 m (1 ft) |
| graphite density | 2260 | 1810 |
| graphite oxidation T | 800 | 700.15 |
| graphite cp model | constant | butland_maddison_1973 |
| graphite k | 100 | 92.67 |
| graphite T limit | 2500 | 3033.15 |

The app doc's feed block has `derived_from: null`, so its lengths have no provenance. `docs/layer-x.md:557` says the design's lengths are 4.5 ft / 1 ft; the app doc disagrees. Reported, not fixed.

#### 1. How chug_margin is computed per delivered step
**Call chain**
- `layerx/replay.py:56-128` calls `runner.evaluate_arrays_with_time(..., use_coupled_solver=True)`.
- That runner is `PintleEngineRunner(line_exit_config(config))` (`card.py:114`). It reaches `TimeVaryingCoupledSolver.solve_time_step` (`runner.py:784-804`).
- Each step calls `comprehensive_stability_analysis(config=self.config, …)` (`time_varying_solver.py:464-467`).
- That runs `compute_physical_stability` (`analysis.py:913`), which runs `build_stability_inputs` (`analysis.py:597-847`), then `chug.chug_margin_fast` (`chug.py:215`) and `chug_band` (`analysis.py:863`).
- The gate is `chug_gate_margin` = the minimum GM over the mixing-lag band (`analysis.py:928`), written as `chugging_stability_margin` (`time_varying_solver.py:468, 700`).

**Sampling**
- `REPLAY_POINTS = 28` (`replay.py:40`), evenly spread over the firing steps, first and last included (`replay.py:47-53`). About 70 firing steps at dt = 0.05 s give one point every 2–3 steps.
- A Fire lead point at t_fire = t[0] − dt is solved and then dropped (`replay.py:70-83`).
- Values are linearly interpolated onto the firing steps (`replay.py:191-194`, `_interp`). The summary minimum over the burn (`replay.py:216-224`) is therefore the minimum over the 28 points.

**Inputs at one point.** Captured at t = 0.70 s of run `20261002-204548-01c181` (GN2, flight on), the burn minimum. The reproduction matches the persisted `chug_margin` exactly (max diff 0.0).

| input | source | value at t = 0.70 s |
|---|---|---|
| Pc | EngineDesign ChamberSolver on the eroded geometry at the twin's line-exit pressures (546.0 / 526.5 psia at t = 0.2) | 380.0 psia |
| ΔP_inj | closure `delta_p_injector_*`, manifold (after dump) to chamber | 135.2 / 129.8 psi; η 0.356 / 0.342 |
| Z_inj = 2ΔP/ṁ | hand check matches | 1.031e6 / 1.506e6 Pa·s/kg |
| feed resistance R = 2·ΔP_feed/ṁ | ΔP_feed = closure `delta_p_feed_*`. In the line-exit copy that is only the Borda dump (`card.py:86-99` zeroes K0, K1, fittings, roughness), minus a supply_K share (`analysis.py:902-910`; 0 in this config) | dump 23.7 / 14.8 psi; R = 1.81e5 / 1.72e5 Pa·s/kg |
| feed inertance I = L/A | `feed_system.<side>.length / A_hydraulic` (`analysis.py:438-459`, `core.py:282-290`), never the drawing | 0.1016 / 9.369e-5 = 1084 m⁻¹ (LOX); 0.9144 / 9.369e-5 = 9760 m⁻¹ (fuel) |
| chamber gain K_c = c*/A_t | `chug.py:114`, A_t from `self.config` (design) | 873,194 Pa·s/kg |
| gas residence time θ_c = L*·c*/(R·T) | `chug.py:105-112`; L* = 1.3586 m (design, frozen); c* 1567.1, R 372.11, Tc 3205.5 | 1.785 ms (hand check exact) |
| lag model | Leonardi 2017 DTL, convection none (config `stability`) | |
| SMD | closure | D32_O 88 µm, D32_F 154 µm |
| τ_atom | | 0.31 / 0.06 ms |
| τ_vap | | 3.63 / 12.06 ms |
| τ_mix | 0.5 × 12.06 (fuel is rate-limiting) | 6.03 ms |
| τ_conv (nominal) | | 9.97 / 18.15 ms |
| mixing-lag band | config `chug_band_mixing_lag_fraction` 0–1, sampled at 5 points (`analysis.py:863-899`) | |
| regulator | `regulator_Z_hf: 0`, so not modelled (`chug.py:49-59`). The tank is an ideal pressure source. | |

**Result at t = 0.70 s**

| mixing fraction | 0 | 0.25 | 0.5 | 0.75 | 1.0 |
|---|---|---|---|---|---|
| GM | 1.879 | 2.285 | 2.182 | 1.582 | **1.330** |

- The gate is the f = 1.0 value. A 101-point sweep gives the same minimum at f = 1.0, so the 5-point sampling is adequate here.
- GM is non-monotone in the fraction: a 101-point sweep peaks at 2.59 near f = 0.4.

**Ignition.** Partly included, but mislabelled.
- `replay.py:216-217` and `LayerXResult.tsx:164` say "ignition included".
- The first replay point is the twin's first firing step, and that step is already at full flow: Pc 389.5 psia, ṁ_O 1.863 kg/s, η_O 0.368 at t = 0.05 s (series idx 10). The twin has no Pc ramp, no valve-travel ramp (MVO/MVF `travel_time` 0.05 s fits inside one step), no priming, no ignition delay and no fuel lead.
- So the "ignition" value is a quasi-steady full-thrust point. Start-up chug, the subject of Leonardi et al. 2017, is not assessed.

**Verification**
- An independent numpy re-implementation of F(s) = 1 + K_c/(θs+1)·Σ e^(−sτ)/Z_k, with a 4000-point grid, agrees with the code's gate within 1.35e-3 relative over all 28 points.
- The formulation is textbook: mass-flow inertance L/A, Bernoulli injector conductance ṁ/(2ΔP), chamber mass balance θ = L*c*/(RT).
- `scripts/chug_timelag_benchmark.py` passes A–E. Its decider (E) shows f −20 % and stability boundary −15 % against the GH2/LOX rig: the model predicts neutral at Δp/pc 0.30, but the rig chugged below 0.35. That is the non-conservative direction.
- The benchmark runs with `feed_length=0.0` (script lines 98-100), so the feed-inertance term, which lifts LE4 from GM 1.01 to 1.33, has no external validation.

#### 2. Feed impedance: config, not drawing
**Memory claim.** The memory note says the verdict was "set by an assumed feed length". For LE4 that is refuted in letter: no `stability.feed.*.length` assume() fires (`assumed.py`; the only stability assumptions are the tube wall E). It is confirmed in substance:
- The length is a config number with no drawing link (app doc `derived_from: null`).
- The margin above 1 is mostly the fuel line's inertance:
  - zero inertance on both lines: gate ≈ 1.01 (GN2, t = 0.70 s);
  - with LOX at 0.14 m, the gate reaches 1 at a fuel run of **0.19 m** (0.142 m with LOX at 0.1016 m);
  - dGM/dL_F ≈ +0.44 /m; dGM/dL_O ≈ −0.67 /m. A longer LOX line destabilises.

**Drawing ΣL/A, by hand.** The He, GN2 and stand drawings have identical propellant lines. Area A = π(10.92 mm)²/4 = 9.3655e-5 m².

| side | segments | ΣL | ΣL/A | source |
|---|---|---|---|---|
| LOX | OXT→MVO 0.07 m + MVO→ENG 0.07 m | 0.14 m | 1495 m⁻¹ | both lengths "estimated" |
| fuel | FUT→MVF 0.9144 m + MVF→ENG 0.05 m | 0.9644 m | 10297 m⁻¹ | both "estimated" |

- Ball-valve bodies (bore 12.7 mm) carry no length on the drawing, so their inertance is unknown.
- The tank liquid columns add about 14–16 m⁻¹, which is negligible.
- For comparison: app doc 1084 / 9760 m⁻¹; yaml 3253 / 14640 m⁻¹.

**Burn-minimum gate under each correction** (`variants_he.py`, min over 28 points, time of min in brackets):

| case | GN2 run 01c181 | He (my run, flight off) |
|---|---|---|
| as run | 1.330 (0.70 s) | 1.367 (0.05 s) |
| drawing inertance | 1.315 | 1.352 |
| + drawing line R (twin's outlet→line-exit drop, 16–39 psi) | 1.443 | 1.480 |
| drawing I + R | 1.431 | 1.468 |
| drawing I + R + eroded geometry | 1.435 | 1.469 |
| burnout: as run → I+R+geom | 1.403 → 1.594 | 1.489 → 1.689 |
| yaml lengths | 1.361 | 1.398 |

**Forward mode vs Layer X.** Forward mode's full config includes K0 (0.643 / 2.019). Those values agree with the feed fit's drawing K_line (0.650 / 2.070), so forward mode carries the line resistance and Layer X does not. Dropping it understates Layer X's GM by about 0.11. That is conservative, but inconsistent.

**Latent bug.** `line_exit_config` zeroes K0 but not `supply_K`, and `_chug_feed_drop` subtracts the supply share from the dump-only drop. If the Layer X feed fit is applied (`feedfit.py:126-160` writes `supply_K` 0.555 / 0.723), the replay gate falls from 1.330 to **1.248** at t = 0.70 s with no physical cause: the dump of 23.7 / 14.8 psi is reduced by 13.2 / 10.7 psi. Zero resistance gives 1.179.

#### 3. L* and throat in the chug calculation: frozen at the design point
- `solve_time_step` builds `config_current` with the eroded V, A_t, L* (`time_varying_solver.py:376-386`).
- It then passes `config=self.config` to the stability call (`:464-466`), and `comprehensive_stability_analysis` reads `ensure_chamber_geometry(config)` (`analysis.py:994-997, 612-614`).
- The chug therefore uses A_t0 = 1.7947e-3 m² and L* = 1.3586 m throughout. The replay's own L* runs 1.3583 → 1.3619 (liner recession) → 1.3315 m; A_t rises +5.75 % by burnout.
- At burnout (GN2), K_c = c*/A_t0 = 874,680 against c*/A_t,now = 827,109 (−5.4 %), and θ_c 1.786 against 1.751 ms. The steady Pc·A_t0/ṁ = 1491 is not c* (1570): the chamber gain is inconsistent with the solved steady state.
- Effect on the gate: +0.004 at the minimum (1.3298 → 1.3336) but **+0.081 at burnout** (1.403 → 1.484; He 1.489 → 1.575). Freezing is conservative.
- The same freeze applies to EngineDesign's own time-series results.

#### 4. Feed-line acoustics vs chug frequency
Sound speeds from CoolProp:
- LOX at 90 K, 555 psia: ρ 1150.2 kg/m³, a 923 m/s, K = ρa² = 0.981 GPa.
- Ethanol at 293.15 K, 540 psia: ρ 792.6 kg/m³, a 1182 m/s, K 1.108 GPa.

Tube wall: the drawing gives wall_thickness 0.889 mm (0.035 in) on every edge. The material appears only in reference text ("seamless 316 tube"); there is no modulus field. With E = 193 GPa (the code's own assumption, `analysis.py:503`), the Korteweg factor is 1.031 (LOX) and 1.035 (ethanol), giving a_wall 896 and 1143 m/s. E ±10 % moves a by ±0.3 %, so tube elasticity is irrelevant here.

| line | L (drawing) | quarter-wave a/4L | half-wave a/2L | λ/4 at 35 Hz |
|---|---|---|---|---|
| LOX | 0.14 m | 1600 Hz | 3200 Hz | 6.4 m |
| ethanol | 0.9644 m | 296 Hz | 592 Hz | 8.2 m |

Chug frequencies at the same point:
- At the gate (mixing fraction 1.0): crossing 22.2 Hz; dominant root s = −12.9 + i·2π·21.5 s⁻¹, ζ 0.095.
- At the nominal lag: phase crossover 34.6 Hz, root 27.9 Hz (α −46 s⁻¹, ζ 0.25).
- At the nominal lag over the burn: 34.6–37.1 Hz (GN2), 36.1–40.3 Hz (He).

Comparison:
- The fuel line's first mode is 8–13× the chug frequency; LOX's is 40–70×.
- The lumped-inertance error for the fuel line at 35 Hz is tan(kL)/kL − 1 ≈ 1.2 % (kL = 0.186).
- With 5 % vapour voids (Wood's equation, GOX at T_sat 147.6 K) the LOX line quarter-wave is still 542 Hz.
- So distributed line acoustics do not matter for chug on this stand.

What the code reports instead:
- The feed-line report uses the config's `bulk_modulus_pa` (LOX 1.5 GPa, which overrides CoolProp; the code's own comment at `analysis.py:482` says 0.98 GPa) and the config lengths. It gives LOX pogo/surge 2697 / 5393 Hz and flags "pogo_O ~ L1" (7.6 %) and "surge_O ~ T1" (0.6 %) as mode coupling. That is reporting only.
- The chug frequency reported (`analysis.py:1027-1029`) is the nominal-lag crossover (34.6 Hz), not the 22 Hz crossing where the gate GM sits.
- Layer X does not surface a chug frequency at all.

#### 5. Other compliances (bounded by experiment)
**Ullage.** Treated as a series capacitive impedance Z_u = γp/(ρ·V_u·s), with the regulator unable to respond. For the GN2 run (load = config, V_u 9.4–15.1 L LOX, 3.2–8.6 L fuel):
- |Z_u| at f_chug is 1.6e3–1.1e4 Pa·s/kg, against |Z_inj| about 1e6;
- gate change −0.004 (He γ = 5/3) and −0.0036 (N2).
- At a 0.95 fill (V_u 0.755 L) |Z_u| is about 3.5e4, roughly 3 % of Z_inj.
- The regulator acts through the ullage gas, so its dynamic effect is bounded by this term. Its static slope (8.3 psi / 0.0965 kg/s on PR_D) is on the drawing; the dynamic corner is not.

**Manifold.** The volume is not in the config or the drawing. The plate's `back_grooves` total 7.08 cm³, and the split between propellants is unstated. A shunt C = V/a² of 0–50 cm³ per side moves the gate by +0.0035 at most.

#### 6. He vs GN2 (app doc, flight off, my runs)
The chug model sees no pressurant at all; the regulator and ullage are not in the loop. The two drawings differ only through the operating point.

| | He | GN2 |
|---|---|---|
| burn-minimum gate | 1.367 at t = 0.05 s | 1.323 at t = 0.70 s |
| line-exit pressure over the burn | rises 557 → 597 psia; GM climbs to 1.489 | droops to 537 psia, then recovers |
| Pc mean | 398 psia | 381 psia |
| mean thrust | 7035 N | 6716 N |

The persisted run `20261002-231658-7e47d1` uses the reconciled injector patch (larger d_jet; stiffness 0.308 / 0.286). Its gate falls to 1.205. Neither the reconciler nor the optimiser constrains chug GM: they use ΔP/Pc ≥ band floor (`optimize.py:19, 253-258`). The UI's amber threshold is 1.2 (`format.ts:99`), not the design's `min_stability_margin` of 1.05.

#### 7. What dominates the verdict (t = 0.70 s, GN2)
| lever | GM change |
|---|---|
| mixing-lag fraction 0.5 → 1.0 (unmeasured) | 2.18 → 1.33 |
| fuel line 0 → 0.96 m | 0.95 → 1.32 |
| drawing line resistance | +0.11 |
| eroded geometry | +0.004 (min), +0.08 (burnout) |
| drawing vs config inertance | −0.015 |
| ullage / manifold compliance | < 0.005 |

τ_vap_F (12 ms) scales with D32_F² (154 µm), so the ethanol SMD is the other big unvalidated lever.

### 9.5 feedtwin numerics, timestep, thermal defaults, saturation, GN2 condensation

Area: feedtwin numerics, timestep, thermal defaults, saturation, GN2 condensation (Layer X on LE4, He hot-fire drawing copv_study_he).

**Auditor's summary.** The feed burn has converged in dt at the 50 ms default when erosion replay is off. From 50 ms to 1 ms, impulse moves +12 N·s (+0.05 %), burn time -1.8 ms, bottle at burnout +0.5 psi, mean O/F +0.01 % and settled ΔP/Pc +0.008 %. dt is not the integration step: Session.step splits it into steps of 25 ms or less, and those again into regulator-ullage RC coupling steps of 3-15 ms. Everything sampled in the ignition window does depend on dt, because the first firing sample lands inside the 50 ms main-valve ramp. With erosion replay on, the chug margin shown in the verdict goes 1.367 (50 ms) → 1.308 (10 ms) → 1.161 (5 ms) → 0.797 (2 ms), so a finer step makes it read as unstable. Delivered impulse falls 0.8 % for the same reason. A second hazard: when a tank crosses its drawn MAWP mid-burn, feedtwin trips and freezes, Layer X never checks for the trip, and the frozen thrust is integrated to the 14 s horizon (measured 99,478 N·s, 14.0 s, no trip warning). Switching the thermal models to the cockpit's values moves He burn figures by ≤0.02 %. The bottle at burnout moves +212 psi with line walls, and an unmodelled cold LOX upper wall could cost about 225 psi, so the two roughly cancel and both rest on estimates. The 492.5 psia GN2 threshold is N2's critical pressure, which is the wrong criterion: N2 condenses on 90 K surfaces at any N2 pressure above 52 psia. Helium is unaffected. The larger practical problem is that Layer X defaults to the GN2 drawing, which predicts 4.5 % less thrust than the He hot-fire.

All runs use the live app document "Ethalox 7200N Doublet" (`EngineDesign/.userdata/local/engine/ethalox-7200n-doublet/current.json`) on the He hot-fire drawing `copv_study_he`, on the pad, with no flight, the engine card, lockup at 578 psia (the config's), and the bottle at 4500 psig as drawn. Unless noted, erosion replay is off.

Scripts and outputs are in `/private/tmp/claude-501/-Users-carlton-Downloads-STAR-ASF-STAR-EngineDesign/6e249fb6-61aa-428c-b921-67469511876f/scratchpad/audit/feedtwin/`: `burn_case.py`, `time_constants.py`, `n2_condensation.py`, `saturation_probe.py`, `cold_wall.py`, `mawp_trip.py`, plus the `*.json` results.

**The config is not the YAML.** `configs/ethalox_6800N.yaml` and the app document disagree:
- **Feed lengths.** `feed_system.fuel.length` is 1.3716 m in the YAML ("vehicle, team 2026-10-01") and 0.9144 m in the document. `oxidizer.length` is 0.3048 vs 0.1016 m.
- **Graphite insert.** The YAML carries GR001CC: 1810 kg/m³, oxidation at 700.15 K, k = 92.67. The document carries the old 2260 / 800 / 100.
- **The drawing's lines are a third answer:** fuel 0.9144 + 0.05 m, LOX 0.07 + 0.07 m.
- **Fuel tank rating.** The drawing's TK-FUEL MAWP is 1000 psi (estimated); the user states an ethanol MEOP of 750 psi.

Each of these is reported here and none was changed.

---

#### 1. Timestep convergence

##### What dt actually does

`LayerXSettings.dt` (`prepare.py:81`, default 0.05; API `routers/layerx.py:110` allows 5–200 ms; UI `LayerX.tsx:806-808` offers 10/20/50/100 ms) is not the integration step. It sets three things:
- the recording interval;
- how often the throat schedule and flight acceleration are refreshed (`analysis.py:88-99`);
- the depletion cut.

`Session.step` splits it into `round(dt/live_step)` steps (`core.py:2182`, `LIVE_STEP = 0.02`, `core.py:226`). Python rounds half to even, so 50 ms becomes 2 × 25 ms.

Each `_integrate` call is split again into coupling steps (`core.py:2341-2384`), whichever of these needs the most:
- the regulator-ullage RC time constant `tau = (m_ull/p)(droop/rated)` (`core.py:1741-1775`, `COUPLING_SAFETY = 1.0`);
- the 4 % pressure rule;
- the 10 % ullage-mass rule.

Each coupling step re-solves the network and root-solves the chamber.

Valve positions are evaluated once per `_integrate` (`core.py:2314`). The settle uses `settle_dt = 0.05` whatever dt is (`burn.py:131`).

The preflight divisibility check (`prepare.py:662-669`) is respected by every dt below. Its message lists only "10, 20, 50 or 100 ms", although any divisor of 0.5 s works.

##### Erosion off (twin only)

| quantity | 100 ms | 50 ms (default) | 20 ms | 10 ms | 5 ms | 2 ms | 1 ms | 50 vs 1 ms |
|---|---|---|---|---|---|---|---|---|
| wall time [s] | 54 | 49 | 57 | 66 | 71 | 100 | 189 | |
| steps / failed | 40/0 | 80/0 | 199/0 | 398/0 | 796/0 | 1990/0 | 3980/0 | |
| total impulse [N·s] | 24259.3 | 24247.1 | 24239.8 | 24237.9 | 24236.9 | 24236.2 | 24234.8 | +12.3 (+0.051 %) |
| impulse to depletion | 24259.4 | 24249.7 | 24242.8 | 24241.3 | 24240.5 | 24239.8 | 24238.5 | +11.3 (+0.046 %) |
| burn time [s] | 3.4777 | 3.4776 | 3.4776 | 3.4779 | 3.4784 | 3.4790 | 3.4794 | −1.8 ms (−0.05 %) |
| bottle at burnout [psia] | 1645.55 | 1645.64 | 1645.63 | 1645.47 | 1645.36 | 1645.08 | 1645.14 | +0.5 psi |
| He used [g] | 90.64 | 90.63 | 90.63 | 90.64 | 90.65 | 90.66 | 90.66 | −0.03 % |
| LOX tank min [psia] | 574.56 | 574.41 | 574.28 | 574.17 | 574.07 | 574.04 | 574.06 | +0.35 |
| fuel tank min [psia] | 574.87 | 574.40 | 572.89 | 572.55 | 572.10 | 571.95 | 572.01 | +2.39 |
| fuel ignition dip [psi] | 3.19 | 3.71 | 5.17 | 5.50 | 5.96 | 6.11 | 6.05 | −39 % |
| mean O/F | 1.52121 | 1.52122 | 1.52121 | 1.52114 | 1.52105 | 1.52097 | 1.52104 | +0.011 % |
| Pc mean [psia] | 402.58 | 402.58 | 402.58 | 402.52 | 402.52 | 402.53 | 402.54 | +0.01 % |
| min ΔP/Pc LOX, t ≥ 0.2 s | 0.36304 | 0.36304 | 0.36315 | 0.36304 | 0.36303 | 0.36303 | 0.36301 | +0.008 % |
| min ΔP/Pc fuel, t ≥ 0.2 s | 0.34833 | 0.34833 | 0.34844 | 0.34833 | 0.34833 | 0.34833 | 0.34831 | +0.007 % |
| `stiffness_min_ignition` LOX | 0.3626 | 0.3626 | 0.3610 | 0.3481 | 0.3111 | 0.2209 | 0.2209 | not converged |
| `stiffness_min_ignition` fuel | 0.3478 | 0.3473 | 0.3452 | 0.3447 | 0.3442 | 0.3010 | 0.1128 | not converged |
| first firing sample thrust [N] | 6753 | 6751 | 6705 | 6541 | 5954 | 3871 | 1084 | sampling of the ramp |

**Burn integrals and settled quantities have converged at the 50 ms default.** Differences between steps are roughly first order, extrapolating to about 24,235 N·s.

**The ignition dip is under-resolved below 20 ms of step.** Fuel shows 3.7 psi at 50 ms against 6.1 psi converged, the same artefact the benchmark notes in §2.1.

**Quantities taken over the ignition window are not converged and cannot be.** With the mains' measured 50 ms travel and a linear Cv characteristic, the 1 ms trace reaches 88 % thrust at 5 ms. Every sample inside the ramp is a quasi-steady part-open state, and how many of them exist is set by dt.

##### Erosion replay on (the delivered numbers Layer X headlines)

| quantity | 50 ms | 20 ms | 10 ms | 5 ms | 2 ms |
|---|---|---|---|---|---|
| twin impulse [N·s] | 24288.3 | 24281.1 | 24279.3 | 24277.7 | 24276.1 |
| **delivered impulse** (replay) | 24233.1 | 24217.5 | 24204.4 | 24166.8 | **24038.1 (−0.80 %)** |
| **chug margin min** (delivered) | 1.367 @ 0.05 s | 1.358 @ 0.02 | 1.308 @ 0.01 | **1.161 @ 0.005 (amber)** | **0.797 @ 0.002 (red: "unstable")** |
| first replay point: thrust / Pc | 6752 N / 390.5 | 6705 / 388.1 | 6542 / 380.2 | 5953 / 351.2 | 3871 / 244.6 |
| throat area growth | 5.694 % | 5.693 % | 5.679 % | 5.644 % | 5.575 % |
| burn time [s] | 3.4447 | 3.4443 | 3.4447 | 3.4455 | 3.4469 |

The mechanism has three parts:
- `replay.replay_indices` (`replay.py:47-54`) always takes the first firing step as replay point 1 of 28. The next point comes about 0.13 s later.
- `delivered` (`replay.py:179-198`) interpolates linearly between them, so a ramp sample under-credits about half of its thrust deficit over that 0.13 s.
- `chug_margin_min` (`replay.py:214-224`) is "the lowest over the whole burn, ignition included", and it is always the first sample.

So the chug verdict (`LayerXResult.tsx:161-163`; amber below 1.2, red below 1, `format.ts:99`) is decided by where the first sample falls inside the valve ramp, not by physics. Within the UI's options (10 ms and up) it stays green but moves 4 %. Through the API at 5 ms it turns amber, and programmatically at 2 ms it reads unstable.

##### Time constants from the drawing, against dt

From `time_constants.py`, at t = 1.0 s of the 2 ms run. Inertance is mass-flow form, I = Σ L/A, equivalent to ρL/A for volume flow. R = 2ΔP_leg/ṁ with ΔP_leg from tank outlet to chamber, and τ = I/R. Injector passages are 24 × 8.16 mm (L/d 5.0 / 5.55).

| path | ṁ [kg/s] | ΔP_leg [psi] | I_line [1/m] | I_inj [1/m] | τ (drawing lines) | τ (vehicle lines from the YAML: LOX 0.30 m, fuel 1.37 m) |
|---|---|---|---|---|---|---|
| LOX leg (l_ox1 + l_ox2 = 0.14 m, 10.92 mm) | 1.879 | 189.8 | 1495 | 163 | **1.19 ms** | 2.45 ms |
| fuel leg (0.964 m) | 1.235 | 190.2 | 10297 | 200 | **4.94 ms** | 6.99 ms |
| chamber filling, L*/(Γ²c*), c* = 1577 m/s | — | — | — | — | **2.1 ms** | — |
| regulator-ullage RC, He (session rule) | — | — | — | — | fuel 2.95 ms at T-0, 8.8 ms at burnout; LOX 8.9 ms at T-0, 14.9 ms at burnout | — |

- **The valve body length is not on the drawing,** so it is not included.
- **Liquid lines and chamber (1–7 ms):** shorter than Layer X's 25 ms internal step and comparable to the 2–5 ms runs. The network is algebraic (`solve_steady` each coupling step, `core.py:1815`), so line and chamber dynamics are absent at every dt. Refining dt cannot resolve them. It resolves only vessels, valves and sampling.
- **Regulator loop:** already resolved, at any dt, by the RC sub-stepping.
- **Valve travel (50 ms):** 10–40 times the line constants, so quasi-steady flow through the opening valve is defensible. What it leaves out is manifold priming and ignition delay (§5).

---

#### 2. Thermal defaults: Layer X against the cockpit

| model | Layer X burn (`prepare.py:76-79` → `burn_setup`, `burn.py:42-61`) | cockpit (`Setup()` defaults, `core.py:384-506`; `tunables.py` `parse_setup(base=Setup())`) |
|---|---|---|
| ullage_collapse | **off** | on (`core.py:384`) |
| ullage_vapour | **off** | on (`core.py:386`) |
| chilldown (wall to liquid, film) | **0** | 100 W/(m²·K) (`core.py:424`) |
| chilldown_nucleate | **0** (burn_setup) | 3000 (`core.py:476`) |
| leidenfrost_K | 40, inert at 0 nucleate | 40 |
| boiling_onset_K | **0** (burn_setup) | 2.0 |
| stratification / surface_layer_m / surface_mixing | **off** (burn_setup) | on, 0.01 m, 5 W/(m²·K) |
| wall_boiling | True, but inert without vapour (`core.py:1599-1601`) | True |
| ambient_leak | 8 W/(m²·K), active: it heats the tank walls | 8 |
| line_walls | **off** | **off** too (`core.py:409`) |
| ullage-to-wall and bottle gas-to-wall exchange (wall_hA_from_gas) | **on** in both (Churchill–Chu: LOX 18.4 W/K, fuel 11.5 W/K) | on |
| auto_vent | off | on |

Two documentation errors sit next to this:
- **Which defaults are "off".** CLAUDE.md and BENCHMARK §3.8 say "library defaults unchanged: all off". The library's `Setup` is the cockpit's and is on. Layer X is off because of `LayerXSettings` and `burn_setup`, and the Tank constructor's defaults are off.
- **The chilldown docstring is stale.** `Setup.chilldown` says "Zero -- the default" (`core.py:433-435`), but the default is 100.

##### He hot-fire, dt = 10 ms, deltas against the Layer X baseline

| case | impulse [N·s] | burn [s] | bottle end [psia] | He used [g] | LOX / fuel tank peak [psia] | LOX liquid at end [K] |
|---|---|---|---|---|---|---|
| Layer X baseline | 24237.9 | 3.4779 | 1645.5 | 90.64 | 618.60 / 619.23 | 90.000 |
| collapse | +1.0 | −0.3 ms | **−8.8** | +0.28 | +0.12 / +0.13 | 90.119 |
| vapour | +0.1 | 0 | −1.3 | +0.05 | −0.01 / 0 | 90.000 |
| chilldown 100 (vapour off) | 0.0 | 0 | 0.0 | 0 | 0 / 0 | 90.000 |
| line walls | −3.7 | +2.2 ms | **+211.6** | −8.49 | −1.94 / −2.10 | 90.000 |
| collapse + vapour + chill 100 (study closures) | +0.2 | −0.4 ms | −9.4 | +0.30 | +0.10 / +0.12 | 90.085 |
| … + line walls | −4.6 | +2.0 ms | +213.3 | −8.63 | −1.97 / −2.10 | 90.091 |
| **full cockpit** (all closures, walls off) | **−0.2** | **−0.4 ms** | **−9.1** | +0.29 | **+0.10 / +0.12** | 90.017 |
| **full cockpit + line walls** | **−4.9** | **+1.9 ms** | **+213.6** | −8.64 | **−1.97 / −2.11** | 90.018 |

- No case failed a step, and every case settled at T-0.
- T-0 LOX pressure moves −0.27 psi with collapse.
- Wall times (136–174 s) were measured with 8 jobs plus other agents on 12 cores, so this is not a cost measurement. Benchmark §2.2 states +9 %.
- These figures agree with benchmark §2.4: He walls +209 psi.

##### What the defaults leave out: the LOX tank's upper wall at T-0

The prime builds every ullage wall at the gas temperature, 293.15 K (`core.py:1494`, `tank.py:508`). `cold_wall.py`, at dt = 20 ms, sets only the LOX ullage wall after the settle:

| LOX upper wall | case | bottle end [psia] | He in burn [g] | He extra in the LOX ullage at T-0 |
|---|---|---|---|---|
| 293 K | baseline | 1645.6 | 90.63 | — |
| 150 K | fresh press: gas 293 K, wall cold | **1420.9 (−225)** | **100.30 (+10.7 %)** | 0. The tank also sags 578 → 565 psia in the 0.5 s lead-in with the press valve shut. |
| 200 / 150 / 120 K | soaked: gas equilibrated to the wall | 1621.8 / 1616.5 / 1616.7 | 91.6 / 91.8 / 91.8 | +27 / +55 / +82 g, never charged to the bottle |

A cold upper wall therefore offsets the +212 psi line-wall credit. The preflight warning about cold walls fires only for GN2 (`prepare.py:489-495`), yet the mechanism applies to helium too.

##### Which defaults are physically right

**Over a 3.5 s burn from a primed (chilled, 300 s held) tank, the burn figures barely move.** Every switch changes impulse, burn time, O/F, Pc and stiffness by ≤0.02 %. This confirms benchmark §2.2: "thermal effects move the pad state, not the burn."

- **Collapse and vapour should be on.** Both are real, and vapour is inert for subcooled LOX at 578 psia (T_sat of O2 is 148.6 K). Turning them on also removes a source of disagreement between Layer X and the cockpit at no accuracy cost.
- **The cockpit's other closures are inert over the burn,** so matching the cockpit is free.
- **Line walls are real metal that the drawing declares.** Physically they should be on; adiabatic is an assumption. But every `fitting_mass` on the drawing is estimated, and benchmark §2.4b says lumped capacitance over-credits fittings by 19–32 %. The only output they move is the bottle reserve (+212 psi He), and an unmodelled cold LOX upper wall moves that output by about −225 psi.

**Recommendation.** Make collapse and vapour default on, with a fresh baseline. Keep line walls off as the conservative deterministic default. The uncertainty sweep should span walls on/off and the LOX upper-wall T-0 temperature (a new Setup field), so the bottle margin is quoted as a band.

##### The bottle at T-0 is assumed full after the tanks are pressed

`prime_at_t0` sets the tanks at lockup and the bottle at its fill pressure, without drawing on the bottle (`burn.py:11-15`, `core.py:1426-1505`).

The pre-press He is 59.8 g (LOX ullage) plus 19.8 g (fuel) = 79.6 g. The bottle holds 209 g at 4514.5 psia and 293 K.

The DAQ table opens `GSE High Press Control` only in `GN2 High Press` (`diablo_actuators.csv`). If the tanks are pressed after the COPV fill and the COPV is not topped up, the T-0 bottle is about 2650 psia (isothermal CoolProp estimate). I ran `copv_pressure_psig = 2636`:
- bottle at burnout: **534 psia, below the 578 lockup**;
- the regulator drops out: tanks end at 530 psia instead of 619;
- mean thrust 6845 N against 6969 (−1.8 %);
- burn 3.529 s against 3.478 s;
- the bottle verdict turns red.

Whether the sequence tops the COPV up after pressing (Press → Press Standby → GN2 High Press → Calibrate → Fire is allowed by `diablo_transitions.csv`) is an operations question the twin cannot answer.

---

#### 3. GN2 condensation

**Where the threshold is.** `N2_CRITICAL_PSIA = 492.5` (`prepare.py:35-39`) is used only at `prepare.py:489-495`. The warning fires when the bottle gas is nitrogen and the lockup is above that value. It never blocks a run.

**What the number is.** 492.5 psia is N2's critical pressure: CoolProp gives Pc = 33.958 bar = 492.52 psia and Tc = 126.19 K. It is not a condensation threshold:

| | value (CoolProp) |
|---|---|
| Psat of N2 at 85 / 90 / 95 / 100 / 110 K | 33.2 / **52.3** / 78.4 / 112.9 / 212.6 psia |
| Tsat of N2 at 100 / 300 / 450 psia | 98.3 / 116.2 / 124.3 K; h_fg 164.7 / 111.1 / 57.8 kJ/kg |
| N2 density at 450 psia (below Pc), 90 / 120 / 130 / 270 K | 755 / 544 / 129 / ~40 kg/m³ |
| N2 density at 578 psia (above Pc), 90 / 120 / 130 / 150 / 270 K | 759 / 565 / 293 / 121 / 50.5 kg/m³ |
| Psat of O2 at 90 K; Tsat of O2 at 578 psia | 14.41 psia; 148.6 K |
| N2 condenses on a wall at 90 / 100 / 110 / 120 / 126 K above | 52 / 113 / 213 / 364 / 488 psia |

- **What the criterion should be.** N2 condenses on any surface below its saturation temperature, which on 90 K LOX means any N2 partial pressure above 52 psia. Liquid N2 and O2 are fully miscible, so at 40 bar and 90 K equilibrium has no limit: the rate is set by heat transfer alone.
- **Above Pc** there is no phase change, but N2 cooled below about 130 K is liquid-dense: 293 kg/m³ at 130 K, against 50.5 at 270 K.
- **The current check is silent where condensation is strongest.** A GN2 lockup of 300–490 psia gets no warning, yet condensation there has real latent heat.

**Bound on condensation at the liquid surface** (`n2_condensation.py`), with a quiescent semi-infinite conduction sink:
- LOX at 578 psia and 90 K: k = 0.154, ρ = 1150.5, cp = 1680, effusivity 546 J/(m²·K·s^0.5);
- interface 201 cm² (drawing diameter 160.1 mm);
- Q = 2·A·ΔT·e·(√t₂ − √t₁)/√π, with condensed mass = Q / (h(gas at 270 K) − h(liquid at T_s));
- T_s from 110 to 141 K.

| case | N2 condensed |
|---|---|
| 300 s hold, then the 3.5 s burn | ≤ 0.1–0.4 g |
| fresh press at T-0, then the 3.5 s burn | ≤ 1.4–6.8 g |
| the 300 s hold itself | ≤ 13–63 g |

The LOX side needs ≈ 0.27–0.32 kg of dry GN2 over the burn (5.75 L at 578 psia, 250–290 K). Surface condensation is therefore ≤ 2.3 % even for a fresh press, consistent with "grams" in the existing warning text. Jet impingement and sloshing raise it, and the literature band of 1.5–3× dry consumption (`feed-twin/docs/copv-study.md:149-153`) is driven mostly by the cold wall, which the twin also does not model.

**Helium is not affected:** Tc(He) = 5.2 K. The cold-wall effect on He density is real, though (§2).

##### Bounding model, or a hard block

- **Bounding model.** A named collapse model in the existing registry (`vessels/collapse.py`, `vessels/vapour.py:register_vapour_model`). It would have three parts:
  - condensing conduction: the flux above, with T_s = min(T_sat,N2(p_N2), ~T_pc), and its mass removed from the ullage;
  - an upper-wall node with a stated T-0 temperature, where N2 condenses on the wall if T_w < T_sat(p) (Nusselt film), else densifies;
  - reported as lower and upper bounds, until one GN2-on-LOX pressure trace calibrates it.
- **Hard block.** Change the gate from `target_psia > 492.5` to `p_N2 > Psat,N2(T_liquid of the oxidiser tank)`, priced with feedtwin's own `Fluid`. That is 52 psia at 90 K, which means always for GN2 on LOX. Make it a `fail` for a hot-fire run unless an explicit cold-flow/acknowledge flag is set.

The user says N2 is for water flows only, where the gate never applies.

##### The larger practical issue: Layer X defaults to the GN2 drawing

`LayerX.tsx:446` picks `copv_study_gn2`, and all 12 saved runs in `.userdata/local/engine/layerx/runs` use drawing 727858dd44db02bc, which is GN2. At dt = 10 ms the two drawings give:

| | GN2 | He | GN2 against He |
|---|---|---|---|
| impulse [N·s] | 24100 | 24238 | −0.6 % |
| mean thrust [N] | 6657 | 6969 | −4.5 % |
| burn [s] | 3.620 | 3.478 | +0.14 s |
| tanks at end [psia] | 553 | 619 | — |
| Pc mean [psia] | 385.9 | 402.5 | — |
| bottle at burnout [psia] | 1196 | 1646 | — |

The GN2 result is also converged in dt: 50 vs 10 ms moves impulse by −1.2 N·s and the bottle by +2 psi.

---

#### 4. Saturation

**What the twin tracks:**
- **Liquid temperature.** Bulk liquid temperature per tank, per step: `TankState.liquid_temperature`, recorded as `liquid_temperature_K` (`burn.py:377-383`), and in Layer X as `series.ox/fuel.liquid_K`. With Layer X defaults nothing heats the liquid, so it stays exactly 90.000 K. With collapse on it reaches 90.119 K at the end.
- **Surface temperature.** The stratified layer is available in `TankSim.readouts` (`core.py:784-789`) but is **not** in `TANK_FIELDS`, so it is not recorded. That matters once stratification is on, because it sets the vapour pressure.
- **Pressure and temperature at every network node, every step.** `Sample.pressures` / `Sample.temperatures` (`core.py:1147-1165`); temperatures come from the enthalpy walk (`core.py:2608-2786`). `BurnTrace` keeps only the probe nodes.

**Which nodes are probed today** (`burn.py:336-373`, `analysis.py:81-82`). On copv_study_he:
- tank ullage OXT, FUT;
- tank outlet OXT.out, FUT.out;
- regulator outlet PR_D.out only (PR-CTRL is a dome loader, not a branch);
- injector inlet = line exit ENG.oxidiser, ENG.fuel;
- chamber ENG.chamber;
- bottle KB1;
- Layer X's instruments: PT_HI→KB1, PT_REG→MF2, PT_OXU→OXT, PT_OXD→MVO.out, PT_FUU→FUT, PT_FUD→MVF.out, TC_REGI→MF1, TC_REGO→MF2, RTD_OXT→OXT, TC_OXD→MVO.out, TC_FUD→MVF.out.

The network has 29 nodes and 27 branches. There is no node inside a line, the valve throat, the manifold (derived by subtracting the dump in `analysis.py:474-479`) or the orifice vena contracta.

**P − P_sat(T) can be computed per node per step today,** from the Sample in Layer X's recorder (`saturation_probe.py`, dt = 5 ms, 11 liquid nodes):
- **Liquid lines in the burn.** LOX ≥ 545 psi of margin settled. ENG.oxidiser is 543.8 psi (558.2 psia, 90.01 K, P_sat 14.43 psia); 465 psi at the first 5 ms sample, valve 10 % open. Ethanol ≥ 540 psi (P_sat 0.86 psia).
- **Cavitation number at the line exit,** K = (p − p_v)/(p − p_c): LOX 3.16–3.26, fuel 3.44–3.57. Nurick's sharp-edged onset is about 1/Cc² ≈ 2.7 (an outside reference, not verified against this plate), so there is about 17 % margin on LOX at burnout. The manifold sits about 25 psi lower, which raises K.
- **Before Fire,** MVO.out and ENG.oxidiser are isolated and held at 101.325 kPa (`core.py:2414-2421`) as liquid LOX at 90 K: a margin of only +0.3 psi. Site ambient is 13.64 psia, below P_sat = 14.41 psia, so that region would flash. Physically it is gas-filled before Fire; the model has no priming.
- **Exclude ENG.chamber.** Its fluid is tagged oxygen and the walk gives it 85.6 K from mass-mixing LOX and ethanol enthalpies with different reference states (trap §4.1). It is meaningless for saturation.

---

#### 5. What feedtwin supports

| feature | status | where |
|---|---|---|
| Valve actuation and opening ramps | **Yes, basic.** A linear slew at each valve's `travel_time` (MVO/MVF: 0.05 s, measured), otherwise `Setup.valve_travel_s` (0.05 s). The Cv characteristic is linear, equal-percentage, quick-opening or tabulated; the mains declare none, so linear. The position is held per `_integrate` call, so at a 50 ms Layer X dt the 50 ms travel is 2 steps. Both mains open on `Fire` together, so the heavy fuel lead is not representable. `transient/scenario.py` has smoothstep and scheduled commands, but the session does not use them. | `core.py:1637-1727`, `core.py:209`, `elements.py:513-548`, `diablo_actuators.csv` (LOX Main and Fuel Main both OPEN in Fire) |
| Manifold priming / fill of gas-filled downstream volumes | **No.** Nodes carry no volume (`Network.add_node(id, fluid, T, pressure, demand)`). Lines downstream of the mains are liquid at T-0 and held at 101.325 kPa while shut. The 1 ms trace is at 88 % thrust 5 ms after Fire. | `solve/network.py:140-152`, `core.py:2414-2421` |
| Water hammer / line inertance | **No.** The network is algebraic each coupling step. `transient/system.py` only reports inertial timescales, in a separate integrator Layer X does not use. By hand (CoolProp; Korteweg, SS 1/2 in × 0.035 tube), a 50 ms closure gives ρLv/t of 8 psi on the LOX line and 37 psi on the fuel line as drawn, 18 / 52 psi at vehicle lengths. Instantaneous Joukowsky: 2607 psi LOX (v = 17.4 m/s, a = 897 m/s), 2187 psi ethanol. | `core.py:1815`, `transient/system.py:30-38, 403-436` |
| Relief valves | **No.** A drawn `RV` becomes a plain Cv valve with no actuator (only ROT/SOL get actuators), so it would be a permanent leak. The `conditional` port is a concept only, and relief events exist only in transient-scenario prose. Above MAWP the session trips the stand instead. | `pid/network.py:53, 506-507`, `comps/manifold.py:34-41`, `core.py:2840-2867, 2925-2930` |
| Regulator failed open | **No fault model.** It can be approximated with `Setup.dome_psi` at or above the bottle (Cv-limited), but Layer X solves the dome from the target and exposes no fault injection. | `comps/regulator.py` (no failure modes), `prepare.py:447` |
| Gas ingestion / vortex at tank outflow | **No.** Liquid ≤ `DRY_MASS` (1 g) isolates the outlet branches. Layer X's `dry_kg` defaults to 1 g. layer-x.md estimates Lubin–Springer pull-through at −2 to −6 % impulse. | `core.py:95-117, 1729-1739`, `prepare.py:67`, `docs/layer-x.md:600-604` |
| Trapped line volume | **Display only.** Isolated stub nodes keep their last pressure (or 101.325 kPa). There is no trapped mass, compressibility, thermal expansion or boil-off, so trapped LOX between two shut valves cannot over-pressure. | `core.py:2410-2421` |

**Related defect: the MAWP trip is ignored mid-burn** (`mawp_trip.py`). I restated TK-FUEL's MAWP as 600 psi. Preflight passes, because it checks only the T-0 lockup at 564 psig (`prepare.py:455-461`). The regulator's supply-pressure effect climbs the tanks 578 → 619 psia during the burn, crossing the rating.
- **What feedtwin does:** trips the stand and freezes, returning the last frame (`core.py:2165-2170`).
- **What Layer X does:** `burn()` (`burn.py:233-304`) and `analysis.py` never read `session.tripped`. The loop runs to the 14 s horizon, integrating the frozen 7150 N.

The result reports burn 14.000 s, impulse **99,478 N·s**, "Horizon reached", and no trip note.
- **The UI:** grades the tank peak red (601 psi against 600).
- **The optimiser:** marks the run infeasible but misdiagnoses it as "a regulator that dropped out, or a horizon too short" (`optimize.py:268-271`).
- **The uncertainty sweep:** would show the 4× impulse.

### 9.6 Drawings vs LE4 hardware, pressure ladder data, regulator, solenoids

Area: Drawings vs LE4 hardware, pressure ladder data, dome regulator (Aqua 1092-50), press solenoids, parts/catalog data.

**Auditor's summary.** The He hot-fire drawing (copv_study_he) matches the hardware the user stated in its main points: dome regulator 1092-50 with Cv 0.8, 50 psi bias and 17 psi/1000 psi supply effect, and 1.7 Cv press solenoids. But it has no relief valves, its tank MAWPs are an estimated 1000 psi (the user says 750 psi ethanol MEOP), the bore of the regulator inlet line is a nominal size with no reference, and its regulator droop is a GN2 back-fit applied per kg/s of helium. These measured LE4 burns use 578 psia lockup, a 4500 psig bottle and the engine card. With them, the 1.7 Cv solenoids cost only 1.3–3.0 psi per tank on helium (−0.31 % mean thrust compared with a lossless valve), so upgrading them is not justified for hot fire. On GN2 they cost 10–19 psi (+1.4 % mean thrust at Cv 3.4). The regulator runs at 5–18 % of its IEC choked capacity on He but 16–77 % on GN2. Its supply-pressure effect raises tank pressure 578 → 619 psia and thrust 6751 → 7194 N (+6.6 %) over a He burn, which works against the stated constant-thrust goal. Every element of the pressure ladder can already be computed from feedtwin state: Sample carries all 29 node pressures and 27 branch flows. Layer X records only the probe nodes, so per-element drops (solenoids, regulator inlet line, main valves, regulator diagnostics) need a recorder change, not new physics. A relief valve drawn into today's model would become an always-open vent, because feedtwin has no relief physics. Parts-hub holds no Cv data, and no Cv catalogue ships in the repo.

#### A. Drawings vs LE4 hardware

##### Method
- Drawings read directly from `feed-twin/backend/diagrams/*.json`.
- Each drawing was also assembled through `feedtwin.session.assemble_model` to see what the solver actually builds (`scratchpad/audit/drawings/topo.py`, output `topo_he.txt`).
- Burns used LE4 = `EngineDesign/configs/ethalox_6800N.yaml` (Ethalox 7200N Doublet). Settings: `prepare(..., LayerXSettings(tank_pressure_psia=578, replay=False))`, card engine, dt 0.05 s, bottle 4500 psig. Preflight solved the dome to 513.6 psig.
- Every node pressure, branch flow and node temperature was recorded at each step, plus `Regulator.diagnostics()` (`scratchpad/audit/drawings/ladder.py`, `analyse.py`, `ladder_table.py`).
- Hand references: CoolProp densities, the Cv definition (1 US gpm of 999 kg/m³ water at 1 psi → 2.4015e-5 kg/s per Cv·√(kg/m³·Pa)), IEC 60534-2-1 gas sizing with expansion factor Y, the Swagelok/ISA scfm gas formula, and `fluids` Darcy friction.

**copv_study_he.json vs copv_study_gn2.json.** The two drawings are identical except for the `fluid` field on 11 nodes (KB1, MF1, MF2, PR_C, PR_D, the 4 press/vent solenoids, …). Every number and every provenance tag is the same. The He drawing therefore carries GN2-derived regulator data, and still uses GN2 labels: `MAN-GN2`, `PT-GN2-REG`, `SV-GN2-VENT`.

**Topology** (all three drawings): KBOTTLE, PR-CTRL (hand loader) → PR-DOME (1092-50), MAN-REG, a press solenoid per tank, a vent solenoid per tank, a GN2 vent, a LOX fill solenoid, 2 mains, ENGINE.
- Component counts: 6 PT, 4 TC, 1 RTD.
- **No RV, no burst disc, no check valve, no filter and no QD in any of the three drawings.**

##### Stated LE4 hardware vs drawing (He hot-fire drawing; GN2 identical; ethalox_stand in brackets)

| Item | User statement | copv_study_he (provenance) | ethalox_stand | Verdict |
|---|---|---|---|---|
| Pressurant | He for hot fire, N2 for water | KB1 helium, 4.6871 L (measured), 4500 psi (manufacturer, "service pressure"), MAWP 6750 (estimated, 1.5×) | nitrogen | OK. **Layer X UI defaults to `copv_study_gn2`** (`frontend/src/components/layerx/LayerX.tsx:446`) |
| Dome reg model | Aqua 1092-50 | PR_D, line 114: domeLoaded yes | same | OK |
| Reg Cv | 0.8 | Cv 0.8 (manufacturer, "TB 1031 … Cv 0.8, 0.23 in orifice"), bore 0.23 in | Cv 0.8 (manufacturer, **no reference**) | Agrees; TB 1031 itself not verified by me |
| Reg bias | 50 psi | dome_bias 50 (manufacturer, TB 1031) | 50 (manufacturer, "Aqua 1092-50") | OK |
| Supply effect | — | 17 psi/1000 psi (manufacturer, TB 1031 quote); inlet_reference 4500 "psi" read as **absolute** (= 31.026 MPa) although the reference says service (gauge). 0.25 psi effect | **absent** | He/GN2 OK; stand drawing has none |
| Droop | — | 8.3 psi at rated_flow 0.09646 kg/s, both "measured": back-fit from a ~25 psi GN2 ignition drop, "the GN2 duty" | 20 psi (estimated) at 0.05 kg/s ("**manufacturer**", no reference). These are exactly the library FALLBACKS (`lib/feedtwin/feedtwin/pid/network.py:79-85`) | He drawing applies a GN2 back-fit per kg/s of He (see C3); stand drawing carries fallback numbers dressed as manufacturer |
| Control reg | hand knob | PR_C setpoint 500 (measured, "gives 550 at the tanks"), Cv 0.06 / droop 5 / rated 0.01 (estimated; unused, dome line carries no flow), **no supply_coefficient** | setpoint 450 | Loader SPE unmodelled (see C4) |
| Press solenoids | 1.7 Cv each tank | SV_LOX_PRESS (l.249) / SV_FUEL_PRESS (l.456) Cv 1.7 "**measured**" ("press solenoid on the stand", no test cited); bore 6.35 "manufacturer" (no reference); travel 0.05 s, xT 0.7, FL 0.9, leak 1e-6 are library **defaults** | Cv **1.2** "manufacturer" with no reference | He/GN2 agree with the user; stand drawing contradicts |
| Other 1.7 Cv | — | SV_GN2_VENT and SV_LOX_FILL also Cv 1.7 with the same "press solenoid" reference (copy-paste) | 1.2 | Unverified |
| Tank vents | — | Cv 3.8, bore 9.525 (estimated, calibrated to a 1 s blowdown) | same | Out of scope here |
| Main valves | not stated | MVO/MVF Cv 26.1 (estimated, Crane K = 3fT = 0.0814 at 12.7 mm), bore 12.7 ("1/2 in NPT full-port ball valve"), travel 0.05 s "measured: fast solenoid, shut to open" (a ball valve described as a solenoid), linear characteristic (default). Modelled as a linear position ramp (`session/core.py:1695-1708`) | travel default 0.05 | Actuation data contradictory; unverified |
| Ethanol tank rating | MEOP 750 psi | FUT MAWP **1000 psi estimated** ("twice the 500 psig operating pressure"); "pressure" 500 psi tagged **manufacturer** ("design operating pressure") while LE4 locks up at 578 psia / 563 psig | same | Disagrees with the user; the drawing has no MEOP field |
| LOX tank rating | not stated | MAWP 1000 estimated | same | Unknown |
| Relief valves | not stated | **none** | none | Missing (see E) |
| Tank volumes | operator: LOX 15.10 L, fuel 8.67 L | 15.1 L / 8.67 L (measured, operator) | same | OK. **Config disagrees: 6.444 L / 6.202 L** (`ethalox_6800N.yaml:454,463`); Layer X warns and follows the drawing |
| Tank diameters | — | 160.1 / 154.4 mm (estimated, "not measured") | 152.4 | Unmeasured |
| Tank outlet geometry | — | none. Only K_minor 0.5 "sharp exit" on l_ox1/l_fu1; no outlet bore, sump or anti-vortex | none | Missing (pull-through residual) |
| Mains lines | 1/2 × 0.035 feed tubes (config) | l_ox1 + l_ox2 = 0.07 + 0.07 m; l_fu1 + l_fu2 = 0.9144 + 0.05 m; bore 10.92 mm; lengths **estimated**; K_minor 0.5 / 0 (no elbows counted) | same | Config chug lengths are the **vehicle's**: fuel 1.3716 m, LOX 0.3048 m (`ethalox_6800N.yaml:94,104`) vs stand 0.964 / 0.14 m |
| Press run | — | "6 in reg-to-tank run" as 3 × 2 in segments of 0.43 in ID, K 1.5 each (measured length) | 0.3 m + 0.6/0.7 m + 0.5 m at 7.75 mm, K 2–3 | Different stands? Unresolved |
| Reg inlet line l_reg | — | 0.3 m, **bore 6.35 mm "manufacturer" with no reference**, K 4.0 (estimated "fitting tally") | same | Load-bearing for GN2 (see D) |
| Bottle line l_kb | — | 0.5 m, bore 12.7 mm "manufacturer" no reference (nominal 1/2 in; a 1/2 × 0.035 tube is 10.92 mm) | same | Nominal used as ID |
| Heights | — | **no `elevation_change` on any edge**. All defaults 0, "assumed horizontal" | same | Missing |
| Wall / material | 316 SS | 0.889 mm on every edge, referenced as "the standard wall of the 1/2 in. seamless 316 tube", including the 6.35 and 9.525 mm bores where that is impossible; roughness 1.5 µm "drawn stainless" | same | Copy-paste; only line_walls (off in Layer X) reads it |
| Instruments | — | PT-COPV@KB1, PT-GN2-REG@MF2, PT-OX-UP@OXT, PT-OX-DN@MVO.out, PT-FU-UP@FUT, PT-FU-DN@MVF.out; TC-REG-IN@MF1, TC-REG-OUT@MF2, RTD-LOX@OXT, TC-OX-DN, TC-FU-DN. **No Pc, no injector-manifold PT, no PT downstream of a press solenoid, no PT at the regulator inlet** | same | |

**"manufacturer"/"measured" values with an empty reference** (He drawing):
- KB1, OXT and FUT temperature
- bores of SV_GN2_VENT, SV_LOX_PRESS, SV_LOX_FILL and SV_FUEL_PRESS (6.35)
- bores of l_kb (12.7), l_ctrl, l_dome, l_reg, l_gn2vent and l_gn2vent2 (6.35), and l_oxfill (12.7)
- l_gn2vent length

ethalox_stand additionally has: PR_D Cv 0.8, PR_D rated_flow 0.05 kg/s ("manufacturer" = library fallback), all four solenoid Cv 1.2, and every 7.75 mm press-line bore.

The 6.35/12.7 mm bores are nominal tube sizes used as inside diameters. A 1/4 in OD × 0.035 tube is 4.57 mm ID and a 3/8 in tube is 7.75 mm.

**Assembly warning** (He drawing): SV-LOX-FILL has an open upstream side and is read as **venting to atmosphere** (`model.report.warnings`). The library-default count is 67, with 125 assumed values.

**ethalox_stand burn (GN2, same settings), for contrast:**
- Thrust 6178 N (t = 0.5 s) → 5598 N at 3.99 s.
- Tank 525 → 467 psia.
- Regulator outlet 545 → 524 psia: droop −33 → −54 psi, no supply effect.
- Cv 1.2 solenoids drop 3.6–14.0 psi.

The thrust trend has the opposite sign from copv_study_gn2 (6712 → 6798 N). The choice of regulator data alone decides whether thrust rises or falls.

#### B. Pressure ladder

##### B1. Path through the He drawing (branch ids = drawing ids; nodes as built)
Shared gas leg:
- `KB1` [PT-COPV] → `l_kb` (0.5 m, 12.7 mm, K4) → `MF1` [TC-REG-IN]. MF1 also supplies the dome loader PR_C, which is a signal and not a flow path; l_ctrl and l_dome are not built.
- → `l_reg` (0.3 m, 6.35 mm, K4) → `PR_D.in` → **`PR_D`** (Regulator) → `PR_D.out` [`series.regulators.PR_D.outlet_psia`]
- → `l_reg_out` (2 in, 10.92 mm, K1.5) → `MF2` [PT-GN2-REG, TC-REG-OUT]. A dead leg `l_gn2vent → SV_GN2_VENT → l_gn2vent2 → VENT_GN2` is shut in Fire.

LOX:
- Press: `MF2 → l_oxpress_in → SV_LOX_PRESS.in → SV_LOX_PRESS (Cv 1.7) → SV_LOX_PRESS.out → l_oxpress → OXT` (ullage) [PT-OX-UP, RTD-LOX]
- Liquid column: `OXT → OXT.out` (static head)
- Feed: `OXT.out → l_ox1 → MVO.in → MVO → MVO.out` [PT-OX-DN, TC-OX-DN] `→ l_ox2 → ENG.oxidiser` (line exit) `→ ENG.oxidiser.injector` (engine-card branch: Borda dump + ring manifold + orifices) `→ ENG.chamber`
- Side branches: `OXT → l_oxvent → SV_LOX_VENT → l_oxvent2 → VENT_LOX`; `SV_LOX_FILL.in` (inferred vent) `→ SV_LOX_FILL → l_oxfill → OXT.out`.

Fuel:
- `MF2 → l_fupress_in → SV_FUEL_PRESS → l_fupress → FUT` [PT-FU-UP] `→ FUT.out → l_fu1 → MVF → MVF.out` [PT-FU-DN] `→ l_fu2 → ENG.fuel → ENG.fuel.injector → ENG.chamber`
- Vent: `FUT → l_fuvent → SV_FUEL_VENT → l_fuvent2 → VENT_FUEL`

There is no `ENG` node; the engine nodes are `ENG.oxidiser`, `ENG.fuel` and `ENG.chamber`.

##### B2. Measured ladder (psi drops; LE4, 578 psia lockup, He)

| element | t = 0.5 s LOX | t = 0.5 s fuel | t = 3.48 s LOX | t = 3.48 s fuel |
|---|---|---|---|---|
| bottle KB1 [psia] | 4126.4 | | 1651.3 | |
| l_kb | 0.23 | | 1.01 | |
| l_reg | 3.75 | | 16.59 | |
| PR_D (reg) | 3539.6 | | 1009.8 | |
| reg outlet [psia] | 582.8 | | 624.0 | |
| l_reg_out | 0.94 | | 1.62 | |
| l_*press_in | 0.26 | 0.21 | 0.44 | 0.37 |
| **SV press (Cv 1.7)** | **1.72** | **1.42** | **2.96** | **2.47** |
| l_*press | 0.26 | 0.22 | 0.45 | 0.37 |
| tank ullage [psia] | 579.65 | 580.04 | 618.51 | 619.14 |
| liquid head (gain) | −0.42 | −0.30 | −0.01 | −0.02 |
| l_ox1 / l_fu1 | 14.80 | 31.66 | 16.24 | 34.65 |
| MVO / MVF (Cv 26.1) | 1.12 | 0.70 | 1.23 | 0.77 |
| l_ox2 / l_fu2 | 2.23 | 1.30 | 2.44 | 1.42 |
| Borda dump (K_exit 1, config ρ, A_hydraulic) | 25.16 | 15.69 | 27.62 | 17.28 |
| injector manifold→Pc | 143.4 (ΔP/Pc 0.365) | 137.7 (0.350) | 157.5 (0.381) | 151.5 (0.366) |
| Pc [psia] | 393.3 | | 413.5 | |
| flows [kg/s] | He 0.0214 (LOX 0.0112 / fuel 0.0102); LOX 1.863, fuel 1.224 | | He 0.0349 (0.0182 / 0.0167); 1.952 / 1.285 | |

GN2 (copv_study_gn2), same settings:

| t | l_reg | SV LOX | SV fuel | l_reg_out | regulator flow |
|---|---|---|---|---|---|
| 0.5 s | 27.2 psi | 9.84 psi | 9.98 psi | 5.8 psi | 0.154 kg/s |
| 3.62 s | 149.0 psi | 19.29 psi | 17.03 psi | 10.5 psi | 0.263 kg/s |

Ignition dip is 25.0 psi on GN2 against 3.6 psi on He.

**Hand checks of the liquid side** (CoolProp + `fluids`):
- l_ox1: 14.69 vs 14.80 psi
- l_fu1: 31.62 vs 31.66 psi
- MVO (incompressible Cv): 1.12 psi, exact

The mains run at 17.3 m/s (LOX) and 16.5 m/s (fuel) in the 0.430 in bore. Dynamic head is 25.0 / 15.6 psi, so line plus dump costs about 42 psi (LOX) and about 49 psi (fuel) between tank and manifold.

##### B3. What Layer X records today
`reduce_trace` (`EngineDesign/engine/layerx/analysis.py:536-562`) records:
- `t, dt, firing, converged`
- `copv_psia` (bottle state), `copv_mass_kg`, `copv_wall_K`
- `regulators{PR_D:{label, outlet_psia@PR_D.out}}`
- `instruments{...}`: the 11 drawing instruments above, read at their nodes (`analysis.py:477-489`, probes added at `analysis.py:81-82`)
- `ox/fuel{tank_psia, outlet_psia, inlet_psia (line exit), dump_psi, manifold_psia, dp_injector_psi, stiffness, mdot, liquid_kg, ullage_K, liquid_K, fill_fraction}`
- `chamber{pc_psia, mr, thrust_N, isp_s, cstar, extrapolated}`

Drops these series already give:
- bottle → reg outlet: l_kb + l_reg + reg, lumped
- reg outlet → MF2: l_reg_out, via PT-GN2-REG
- MF2 → each ullage: press_in + SV + press, lumped
- ullage → outlet (head)
- outlet → MVO.out: l_ox1 + main valve, lumped, via PT-OX-DN
- MVO.out → line exit: l_ox2
- dump, then injector

**Not recorded** (new probes needed):
- pressures at `MF1`, `PR_D.in`, `SV_*_PRESS.in/.out`, `MVO.in`, `MVF.in`
- every gas-side branch flow (only the total, as −d(copv_mass)/dt, which `FeedSchematic.tsx:203-207` already computes); the LOX/fuel split of pressurant is not recorded at all
- regulator diagnostics: target, droop, saturated, shut
- anything inside the injector card (ring channel vs orifice). EngineDesign has it as `Cd_eff_manifold_*` and element flow ratios (`engine/core/injectors/impinging.py:230-253, 867`), but the card tabulates only flow capacity (`engine/layerx/card.py` header).

**Everything above is already in the session.** `Sample.pressures` holds every network node (29) and `Sample.flows` every branch (27) (`lib/feedtwin/feedtwin/session/core.py:2425-2437`). `BurnTrace.recorder` keeps only probe nodes (`lib/feedtwin/feedtwin/session/burn.py:414-486`). My recorder built the full ladder with no physics change.

Caveat: vessel nodes in `Sample.pressures` are the solve's boundary values. The bottle node read 1651.4 psia against the bottle state's 1645.6 at burnout, so do not mix `copv_psia` or `tank_psia` with node values in one ladder.

##### B4. Instrument convention
Twin nodes on liquid lines are **total** pressures, in the lumped-K / Borda convention:
- l_ox1 charges only K_ent 0.5;
- the 1.0 q acceleration is charged at the manifold dump (`analysis.py:504-511`).

A wall-mounted PT on the 1/2 in tube reads static pressure, about q lower. So the predicted PT-OX-DN and PT-FU-DN readings in `series.instruments` should overstate a DAQ reading by about 25 psi (LOX) and about 15.6 psi (fuel) during firing. The exact amount depends on how the PT is mounted. Not verified against a DAQ trace.

#### C. Regulator operating point (`lib/feedtwin/feedtwin/comps/regulator.py`)

##### C1. Model
Outlet target = p_set + S·(p_ref − p_in) − D·|ṁ|/ṁ_rated (`:182-195`), where p_set = dome + bias.
- The dome comes from PR-CTRL's zero-flow outlet at MF1 pressure each tick (`session/core.py:1661-1675`). PR-CTRL has no SPE, so the dome is constant at 528.25 psia.
- Seat floor: incompressible `Cv_to_K(Cv,bore)·ρv²/2` at inlet density (`:234-243`); saturation is tested the same way (`:308-321`).
- No expansion factor and no choke. `flow_ceiling` returns 0 only when shut (`:274-280`), whereas `Valve` uses the IEC 60534 choke (`comps/elements.py:582-627`).

##### C2. Measured operating point (He)
- Regulator outlet 578.25 → 576.85 at ignition, then rising to **623.97 psia** at burnout.
- Over the burn: SPE +48.7 psi (inlet 4487 → 1634 psia), droop −1.6 → −3.0 psi.
- Flow 0.0189 → 0.0349 kg/s.
- Tanks 578.0 → 618.5/619.2 psia; thrust **6751 → 7194 N (+6.6 %)**; Pc 390.5 → 413.5 psia.
- Burn 3.478 s, impulse 24 247 N·s, mean 6972 N.

The ramp is the 1092's datasheet supply effect. It works against the stated "constant thrust near 7.2 kN" goal.

GN2: outlet 573.3 → 614.2 psia, droop up to −22.6 psi at 0.263 kg/s, which is 2.7× the 0.09646 kg/s the droop was fitted at.

##### C3. Capacity, by hand (IEC 60534-2-1, Cv 0.8, xT 0.7 assumed, CoolProp ρ at PR_D.in)

| | % of choked capacity | % at xT 0.5 | Cv needed at end |
|---|---|---|---|
| He | **5.3 % → 17.8 %** (cap 0.406 → 0.196 kg/s) | up to 21 % | 0.14 |
| GN2 | **15.7 % → 76.7 %** (0.982 → 0.343 kg/s) | up to 90.7 % | 0.61 |

The model's incompressible seat law at the GN2 end point would pass 0.398 kg/s across the 441 psi available, against IEC-with-Y 0.319 kg/s. Wide-open capacity is overstated by about 25 % there, and by up to about 1.5× when choked. Neither run reaches saturation at nominal settings.

##### C4. Recorded vs derivable
Layer X records only the outlet pressure. Derivable from what is recorded:
- droop: needs ṁ, which is available as the bottle-mass derivative
- SPE: needs the regulator inlet; the bottle is a proxy, high by l_kb + l_reg = up to 17.6 psi He / 158 psi GN2, which is an SPE error of 0.3 / 2.7 psi
- % capacity: needs inlet ρ; TC-REG-IN gives T at MF1, but the pressure there is not recorded
- wide-open / choked flags: not derivable. `Regulator.diagnostics()` (`:323-344`) already returns `outlet_target, droop_from_setpoint, inlet_differential, saturated, shut` and costs one call per step.

**Droop transfer GN2 → He.** The He drawing's 8.3 psi at 0.09646 kg/s is a GN2 back-fit applied per kg/s of He, and it is tagged "measured", so the uncertainty sweep holds it exact (`engine/layerx/uncertainty.py:118-121`).
- If droop follows poppet lift (flow area), the same lift passes 0.413× the mass flow of He as of N2 (IEC choked, 4515 psia, 293 K). The He-equivalent rated flow would be 0.0399 kg/s.
- What-if run with that value: He mean thrust 6938 N (−0.49 %), ignition dip 6.0 psi (vs 3.6), peak tank 614.2 psia (−4.4), bottle at burnout +31 psi, impulse −21 N·s.

**Loader SPE.** It is unknown and unmodelled. Each 1 psi/1000 psi of PR-CTRL supply effect adds about 2.9 psi to the He burn's tank-pressure rise (bottle 4515 → 1650 psia).

#### D. Press solenoid drop (1.7 Cv), hand calc vs twin

| | twin | incompressible Cv (CoolProp ρ₁) | IEC with Y | Swagelok/ISA ideal-gas |
|---|---|---|---|---|
| He LOX 0.5 s (0.01121 kg/s, 581.6 psia, 298 K, ρ 6.36) | 1.720 | 1.720 | 1.724 | 1.704 |
| He LOX 3.48 s (0.01824, 621.9 psia, 204 K, ρ 9.80) | 2.958 | 2.955 | 2.966 | 2.902 |
| He fuel 3.48 s (0.01668) | 2.472 | 2.470 | 2.478 | 2.423 |
| GN2 LOX 0.5 s (0.0769, 564.6 psia, 256 K, ρ 52.3) | 9.845 | 9.824 | 9.992 | 10.34 |
| GN2 LOX 3.62 s (0.1357, 600.8 psia, 188 K, ρ 83.4) | 19.29 | 19.21 | 19.83 | 22.77 (ideal gas invalid, Z ≈ 0.86) |

- The twin reproduces the Cv law to <0.4 %.
- IEC Y adds 0.3 % (He) and 1.6–2.8 % (GN2).
- He volumetric flow at the valve is 1.6–1.9 L/s per tank.

**What-if burns** (scratch copies of the drawing):

| He | mean thrust | impulse | peak tank | ignition dip | bottle at burnout |
|---|---|---|---|---|---|
| base | 6972 N | 24 247 N·s | | 3.6 psi | |
| Cv 3.4 | 6989 (+0.24 %) | +2.7 | +2.4 psi | 3.0 | −14 psi |
| Cv ∞ | 6994 (+0.31 %) | +3.4 | | | −19 psi |

| GN2 | mean thrust | impulse | ignition dip | min tank | peak tank | burn | bottle at burnout |
|---|---|---|---|---|---|---|---|
| base | 6656 N | 24 099 N·s | 25 psi | | | | |
| Cv 3.4 | 6749 (+1.39 %) | +36 | 20 psi | +5.1 psi | +12.5 psi | −0.044 s | −81 psi |

**Verdict:** upgrading the 1.7 Cv solenoids is not worth it for He hot fire (≤3 psi, 0.3 % thrust). It matters only for GN2 water flows. The LOX/fuel asymmetry in drop is 0.5 psi on He and 2.3 psi on GN2.

**Regulator inlet line l_reg bore** ("manufacturer" 6.35 mm, no reference). If it is 1/4 in OD × 0.035 (4.572 mm):
- He: +0.9 psi peak (via SPE) only.
- **GN2: the regulator saturates from t ≈ 3.3 s.** l_reg drops 454 psi, the regulator inlet is 808 psia, and the outlet is 611 vs a 621 target.

The twin's own pipe model is outside its validity there: dp/p reaches 37 %, beyond the 10 % that `comps/gas.py:6-9` states as the limit. At the base GN2 end point (12 % dp/p) the twin's l_reg drop is 149.0 psi against 159.4 psi mean-density by hand (+7 %). On He the agreement is within 0.3 %.

#### E. Relief valves
- None on any drawing.
- feedtwin has no pressure-actuated relief. `RV` maps to a plain Cv valve (`pid/network.py:53`) that is not an actuator (`:506`). With no command signal it is **open** (`comps/elements.py:550-569`).

Experiment (`rv_test.py`): an RV drawn on FUT was built as an always-open Valve with no set pressure and was read as venting to atmosphere. It even landed on the liquid port `FUT.out`. Flow ceiling: 0.035 kg/s He at 578 psia.

The only protection the model has is the MAWP trip (`Session._check_limits`, `core.py:2840`), checked against the estimated 1000 psi.

**Failure case by hand** (IEC choked, xT 0.7, ignoring l_reg): a regulator that fails open passes 0.436 kg/s He or 1.054 kg/s N2 at 4500 psig. A relief at 750 psig + 10 % would need total Cv ≈ 4.0–4.1 to pass it. That is an upper bound; the l_reg restriction would cut it, and its size is unknown.

#### F. Catalogue data for an optimiser
- **parts-hub**: free-form `custom_fields` only (`parts-hub/src/db.ts:90-119`); no Cv field. The seed is mock data (`src/seed.ts`): ASCO 8210G094 solenoid, Swagelok SS-43GS4 ball, SS-RL3M4 relief "750-1500 psi" — no Cv, unverified. No local data dir exists.
- **feedtwin**: `model/catalog.py` supports parts with manufacturer and measured Cv blocks, but no catalogue file ships. Its docstring example (swagelok-ss-8bk-v51, Cv 1.2) is illustrative only.
- **EngineDesign**: `FEED_LINE_SIZES` covers 1/4–3/4 NPT through-bores and 3/8 and 1/2 tube × 0.035 only (`engine/pipeline/config_schemas.py:279-293`). Injector drills: ASME B94.11M #40–#70 plus 0.05 mm metric (`engine/layerx/reconcile.py:42-50, 220-240`). NPT threads: `engine/core/injectors/hardware_tables.py`.
- **pid-designer**: dash-size and NPT-size arithmetic, and deliberately no catalogue bores (`frontend/src/components/pid/catalog.ts` header).

There is nothing an optimiser could choose a valve Cv from today.

#### G. Other disagreements
- Config `max_lox/fuel_tank_pressure_psi` is 600 (`ethalox_6800N.yaml:540-541`), the user's MEOP is 750, and the drawing MAWP is 1000. The optimiser cap takes the minimum (`engine/layerx/optimize.py:103-112`), so 600 binds today.
- Config `ullage_gas: Nitrogen` while hot fire is He.
- Config `copv_free_volume_L` is 4.619 vs drawing 4.6871 L (1.5 %, under the 5 % warning).

#### H. Not verified
- Aqua TB 1031 values (Cv 0.8, 0.23 in orifice, 17 psi/1000 psi)
- the 1.7 Cv solenoid part number or datasheet
- the main-valve part and travel
- tank ratings
- the actual tube sizes of l_reg / l_kb / the vent lines
- the IEC xT of the 1092
- the DAQ static-vs-total offset

### 9.7 Assumption ledger: what EngineDesign assumes that Layer X replaces

Area: Assumption ledger: what EngineDesign assumes that Layer X replaces (LE4, He hot-fire drawing, pad, erosion on).

**Auditor's summary.** On the LE4 He drawing (pad, erosion replay on), the feed does not hold EngineDesign's flat 578 psia. The tank dips 3.6 psi at ignition, then climbs to 618–619 psia by burnout, almost entirely from the drawing's regulator supply-pressure effect (17 psi per 1000 psi of bottle drop, 4514 to 1646 psia). As a result thrust rises 6752 to 7315 N (+8.3 %, mean 7013 N), not the steady 6804 N Forward reports or the steady ~7.2 kN the team wants. Pc runs 390 to 405 psia. LOX ΔP/Pc leaves the 0.40 design band in the last 0.1 s. Peak tank pressure goes past design_requirements' 600 psi limit, which Layer X does not grade. Layer X does replace tank pressure, the line losses, throat area, ε, L*, O/F, flows, Isp and burn time (3.456 s against the config's stale 3.994 s). It does not replace nozzle efficiency 0.95 (no source anywhere), the Cd and η_c* models, the engine's propellant densities, the feed length or the regulator in the chug model, fuel lead, or the unusable residual. Two results are wrong as built. First, Layer X's chug margin is computed on a copy of the config with the line losses zeroed: at the same operating point it reads 1.407, while Forward reads 1.509, so a "design 1.509 → delivered 1.398" row is mostly a change of model, not something the burn did. Second, the feed fit on this burn proposes K0 = −0.038 for LOX, which the schema rejects. The 17 vs 10 psi/1000 psi regulator figure, and the YAML against the app document (8 fields), need the team to decide which is right.

#### What was run (evidence base)
- **Config.** `EngineDesign/configs/ethalox_6800N.yaml`, fingerprint `7782d2fdd7f9`. This file is untracked in git; last modified Oct 1 15:23.
- **Drawing.** `copv_study_he`, id `41c9a39ac34b7d71`, sha `41c9a39ac34b…`.
- **Settings.** `LayerXSettings(drawing_id, replay=True, flight=False)`; everything else is the UI default (`frontend/src/api/layerx.ts:55-77`):
  - tank pressure from the config (578.0 psia);
  - bottle as drawn (4500 psig He);
  - load from the config;
  - engine card;
  - thermal models off;
  - dt 0.05 s, 300 s hold.
- **Run.** 2 passes, converged, 100 s wall time, 0 failed steps, 0 steps outside the card. Card fit 0.02 % Pc / 0.02 % thrust / 0.03 % flow.
- **Output.** `scratchpad/audit/ledger/burn_yaml_copv_study_he.json`.
- **Design point.** EngineDesign Forward = `PintleEngineRunner.evaluate(578 psia, 578 psia, rich_stability=True)`, the same call `backend/routers/evaluate.py:98` makes. Output in `ledger/forward_yaml.json`.
- **Is the YAML the app document "Ethalox 7200N Doublet"? No.**
  - A GET of `/api/config` on :8000 (21:40) returned exactly `.userdata/local/engine/ethalox-7200n-doublet/current.json`. The only difference was the `supply_K` default, which the server adds.
  - That document differs from the YAML in **8 fields**:
    - `feed_system.fuel.length` 0.9144 vs 1.3716 m;
    - `feed_system.oxidizer.length` 0.1016 vs 0.3048 m;
    - `graphite_insert.material_density` 2260 vs 1810 kg/m³;
    - `thermal_conductivity` 100 vs 92.67;
    - `specific_heat_model` constant vs butland_maddison_1973;
    - `surface_temperature_limit` 2500 vs 3033 K;
    - `oxidation_temperature` 800 vs 700 K;
    - `material_source` none vs GR001CC.
  - A second GET later in the audit showed a different live session config: `lox_tank.initial_pressure_psi` 815.08 and feed lengths 0.305/0.305. That matches doc version `18da8623…`.
  - **Someone else changed the live session during the audit. This audit made only GET requests.** "The backend's loaded doc" is not a stable reference.
  - The same burn on the app document: throat growth +5.69 % (0.671 mm) against +4.00 % (0.474 mm), chug min 1.367 against 1.398, burn 3.445 against 3.456 s, delivered impulse 24,233 against 24,240 N·s, peak thrust 7362 against 7315 N. Output in `ledger/burn_server_copv_study_he.json`.

#### Burn at key instants (He, pad, erosion on)
| t [s] | tank O/F [psia] | bottle [psia] | reg out [psia] | thrust [N] | Pc [psia] | At/At0 | chug GM (replay) | ΔP/Pc LOX |
|---|---|---|---|---|---|---|---|---|
| 0.05 | 574.4 / 574.4 | 4487 | 576.8 | 6752 | 390.4 | 1.0003 | 1.398 | 0.363 |
| 0.50 | 579.7 / 580.1 | 4123 | 582.8 | 6813 | 392.9 | 1.0024 | 1.409 | 0.366 |
| 1.00 | 586.3 / 586.7 | 3712 | 589.7 | 6887 | 395.9 | 1.0047 | 1.424 | 0.370 |
| 2.00 | 599.5 / 600.0 | 2876 | 603.6 | 7043 | 401.3 | 1.0120 | 1.456 | 0.379 |
| 3.00 | 612.6 / 613.2 | 2032 | 617.6 | 7226 | 404.5 | 1.0293 | 1.494 | 0.394 |
| 3.46 | 618.4 / 619.0 | 1646 | 623.9 | 7315 | 405.2 | 1.0400 | 1.512 | 0.403 |

Totals: burn 3.456 s, ended because the LOX tank ran dry, with 58 g of fuel left. Delivered impulse 24,240 N·s; the twin's own is 24,274 N·s. He used 0.0906 of 0.209 kg.

#### The ledger
"Replaced" means the burn takes this quantity from the drawing or the twin rather than from EngineDesign's assumption. "Series key" is what would drive a UI row "Design assumed X → feed delivers Y(t)".

| # | Assumption in EngineDesign design point / Forward | Design value (where) | Layer X source → series key(s) | Replaced? | Layer X delivers (He, pad) |
|---|---|---|---|---|---|
| 1 | Constant tank pressure | 578.0 / 578.0 psia: `lox_tank`/`fuel_tank.initial_pressure_psi`. These are Forward's defaults (`frontend/src/components/ForwardMode.tsx:26-27`; it falls back to 750/600 when unset), and the inputs to `runner.evaluate` (`evaluate.py:98`). | Twin's ullage, locked up by the solved dome (513.6 psig; `prepare.py:447`) → `series.ox.tank_psia`, `series.fuel.tank_psia`; `summary.{ox,fuel}.{t0,min,end,peak}_psia` | yes | LOX 578.05 → 574.41 (ignition dip 3.6 psi) → **618.35 psia**. Fuel 578.12 → 574.40 → **619.00**. Time-mean 596.2 / 596.7. Crosses 600 at t ≈ 2.0 s. |
| 2 | Regulator: flat setpoint. Forward has no regulator at all. Layer 2 `dome_regulated` is flat too **[corrected: said it assumes SPE 0.010 psi/psi]**: `layer2_pressure.py:1961-1963` passes no COPV inlet history and no regulator, so `generate_dome_regulated_pressure_curve` returns the setpoint (`feed_pressure_model.py:98-105`; `RegulatorModel` default SPE 0.0 at :33). The 0.010 "Aqua 1092 datasheet" default is in `regulator_from_config` (`feed_pressure_model.py:57-66`), which nothing calls. | 0 (Forward) / 0 (Layer 2) | Drawing PR_D: `supply_coefficient` 17 psi/1000 psi ("manufacturer"), `flow_droop` 8.3 psi at 0.09646 kg/s ("measured"), Cv 0.8, bias 50 psi → `series.regulators.PR_D.outlet_psia` | yes, but the two sources disagree | Regulator outlet 576.85 → 623.93 psia (+47.1 psi) **[corrected: said +45.9, an arithmetic slip]**. Hand check: 0.017 × (4487 − 1646) = +48.3 psi; the 1.2 psi gap is attributed to droop (not re-derived). The what-if at 10 psi/1000 psi gives a tank end of 598.2 psia and thrust 6760 → 7112 N. |
| 3 | Pressurant | Config: `press_tank.free_volume_L` 4.619, `initial_gas_mass` 1.312 kg; `ullage_gas` Nitrogen at 293.15 K | Drawing KB1: He, 4.6871 L, 4500 psig → `series.copv_psia`, `copv_mass_kg`, `copv_wall_K` | yes (the config's figures are used only as the flight fallback) | 4514.5 → 1646.3 psia; 0.2090 → 0.1184 kg. CoolProp check: 0.2090 kg at fill; real-gas isentrope ends at 1603 psia, and the twin's 1646 is +43 psi from wall heat. |
| 4 | Feed line loss, lumped K | K0 0.643 (O) / 2.019 (F), K1 0, `phi_type` none, no roughness (yaml `feed_system`). Line part at design flow 16.2 / 31.6 psi; with the dump, `dp_feed` 41.34 / 47.31 psi (`feed_loss.py:76-174`). | Drawing's lines; the card is built with K0/K1/fittings/roughness zeroed (`card.py:86-98`) → tank−inlet = `series.ox.tank_psia − series.ox.inlet_psia`; drawn line alone = `outlet_psia − inlet_psia` | yes | Drawn line LOX 17.91 → 20.73 psi, fuel 33.22 → 38.24 psi. Hand check (K_minor + exact Colebrook via `fluids.friction_factor` at the drawing's 0.0015 mm + valve Cv 26.1, the twin's ρ/μ 1142.10/789.34 kg/m³ and 1.956e-4/1.193e-3 Pa·s): 17.93 / 33.19 psi at the first step, 20.66 / 38.17 at the last **[corrected: said 17.9 / 32.7; the fuel figure was 0.5 psi low]**. Tank-to-manifold (the `dp_feed` equivalent) LOX 42.3 → 49.4, fuel 48.3 → 56.2 psi. Feed fit `K_line` 0.715 / 2.131. |
| 5 | Exit dump into the manifold | `K_exit` 1.0 at `A_hydraulic` (`d_exit` null) and the config density (`analysis.py:435-452`) | Kept as EngineDesign's (the card boundary) → `series.{ox,fuel}.dump_psi` | no (by design); the drawn last bore of 10.92 mm matches the design's 10.922 mm | LOX 24.85 → 28.67 psi; fuel 15.46 → 17.94 psi. Hand check 24.85 psi at 1.8517 kg/s. |
| 6 | `supply_K` (the regulator's share of K0) | 0 (absent from the yaml; schema default, `config_schemas.py:340`) | Feed fit (`feedfit.py:79-82,134-137`) → `result.feed_fit.sides.*` | partly / **broken here** | `K_supply` −0.753 (LOX) / −1.231 (fuel), because the tank rises above lockup. The proposed K0 is **−0.0379** for LOX and 0.900 for fuel. The schema rejects K0 < 0 (`config_schemas.py:339`; verified), so "write into the design" cannot succeed. |
| 7 | Feed line length, used as inertance in the chug model | yaml O 0.3048 / F 1.3716 m ("vehicle, team"); app doc 0.1016 / 0.9144 m | Not taken from the drawing. The replay's stability uses the config's length (`time_varying_solver.py:464-466`, with the sampler's config). The drawing's lines are O 0.14 m, F 0.9644 m ("estimated"). | **no** | Chug gate at 578 psia: 1.5089 at the yaml lengths, 1.4643 at the drawing's, 1.4795 at the doc's (full config). On the line-exit config: 1.4075 / 1.3622 / 1.3755. |
| 8 | Feed resistance in the chug loop | Full `dp_feed` 41.3 / 47.3 psi, less the `supply_K` part (`stability/analysis.py:759-766,902-910`) | Replay on `line_exit_config`: K0 zeroed, so resistance is the dump only (24.85 → 28.71 / 15.46 → 17.97 psi over the replay points; 25.2 / 15.7 at Forward's flows) **[corrected: gave only the Forward-flow values]** → `delivered.chug_margin`, `delivered.summary.chug_margin_min` | **no (the resistance is dropped, not replaced)** | 1.398 (t = 0.05) → 1.512 (burnout). At the identical operating point (Pc 393.22, F 6803.7) the line-exit config gives **1.4075 against Forward's 1.5089 (−6.7 %)**. Most of the apparent 1.509 → 1.398 change is this model change. |
| 9 | Regulator in the chug loop | `regulator_enabled` true, corner 3 Hz, `Z_hf` 0 means "not modelled", an ideal pressure source (`chug.py:38-59`) | Not coupled to the twin's regulator or ullage | **no** | The corner at 1, 3 or 10 Hz, and the regulator disabled, all give GM 1.5089: the 3 Hz figure has no effect. |
| 10 | Chamber pressure | Forward 393.2 psia. `target_chamber_pressure_psi` 375; `chamber_geometry.design_pressure` 377.7 psia (stale 6.5 kN value). | Replay → `delivered.pc_psia` (twin: `series.chamber.pc_psia`) | yes | 390.4 → 405.2 psia; settled mean 399.7 |
| 11 | Thrust | Forward 6803.7 N. Config `target_thrust` and `design_thrust` 6500 (stale). User goal: constant ~7.2 kN. | `delivered.thrust_N` | yes | **6752 → 7315 N (+8.3 %)**, mean 7013 N. ≥ 7200 N only from t = 2.90 s; within 7200 ± 2 % on 29 of 70 steps. |
| 12 | Constant throat area (no erosion) | 1794.7 mm² (`chamber_geometry.A_throat`) | ED time-varying replay; schedule fed back (`analysis.py:93`) → `delivered.throat_area_ratio`, `delivered.recession_throat_mm`, `replay.recession_chamber_mm` | yes (rates themselves unmeasured) | At/At0 1.0003 → **1.0400**; throat recession 0.474 mm; liner 1.158 mm. The app doc's graphite gives 1.0569 / 0.671 mm. |
| 13 | Expansion ratio | 4.8276 | `delivered.eps`, `delivered.p_exit_psia`, `delivered.ambient_psia` | yes | ε 4.826 → 4.642; p_exit 14.10 → 15.41 psia against 13.64 psia ambient |
| 14 | L* | 1.3586 m (pinned) | `replay.Lstar_m` | yes | 1.358 → 1.353 m |
| 15 | η_c* | 0.9105 at the design point (E_m, SMD assumed) | ED model at every replay point → `replay.eta_cstar` (28 points; not in `delivered`) | partly (operating point yes, model inputs no) | 0.9102 → 0.9125; c* 1569.4–1573.8 m/s (`delivered.cstar`) against 1570.0 |
| 16 | Orifice Cd | Cd_O 0.784 / Cd_F 0.776 (Lichtarowicz, sharp inlet, L/d 5.0/5.545; assumed per `forward_report.py:31`) | Card's injector capacity, ṁ/√Δp, from ED; no series key. Derive Cd_eff = ṁ/(A_jet√(2ρΔp_inj)) with A_O 50.19, A_F 40.82 mm². | **no** | Cd_eff 0.7817–0.7818 (O) and 0.7749–0.7752 (F): constant to 0.03 % across the burn |
| 17 | O/F | `optimal_of_ratio` 1.5; `design_MR` 1.515 (stale); Forward 1.5232. Load ratio 6.611/4.404 = 1.5013. | `delivered.mr`, `summary.of_mean` | yes | 1.5194–1.5242, mean 1.5211, so the LOX tank runs dry first with 58 g of fuel left (1.3 %) |
| 18 | Momentum ratio R; Rupe M | R 1.0304 (band 0.95–1.05); M 1.1774 (`impinging.py:301-341`) | Derived: R = (ṁ_O/ṁ_F)(A_F/A_O)√(ρ_F/ρ_O) = 0.6765·O/F at ED densities; M = R²·d_O/d_F | partly (derived) | R 1.0279–1.0311; M 1.1717–1.1790 |
| 19 | Injector ΔP/Pc band | Requirement 0.20–0.40 both sides; Forward 36.5 % (O) / 35.0 % (F) | `series.{ox,fuel}.stiffness`, `summary.*.stiffness_min{,_ignition}` | yes | LOX 0.3627 → **0.4030** (above 0.40 for t 3.35–3.46 s, 4 steps); fuel 0.3473 → 0.3879 |
| 20 | Injector ΔP | 143.4 / 137.5 psi | `series.*.dp_injector_psi` | yes | O 141.7 → 163.4; F 135.6 → 157.3 psi |
| 21 | Manifold pressure | P_injector 536.66 / 530.69 psia | `series.*.manifold_psia`; `feed_fit.sides.*.manifold_gap_psi` | yes | O 532.1 → 569.0; F 526.1 → 562.8 psia. Burn mean sits +18.2 / +18.7 psi above the design. |
| 22 | Flows | ṁ_O 1.8633, ṁ_F 1.2233 kg/s | `delivered.mdot_O/F` (twin: `series.*.mdot`) | yes | O 1.852 → 1.990; F 1.215 → 1.310 kg/s |
| 23 | Isp | 224.77 s | `delivered.isp_s` | yes | 224.5 → 226.0, mean 225.39 |
| 24 | Burn time | `thrust.burn_time` and `target_burn_time` 3.994 s (stale); at design flow the LOX-limited time would be 3.548 s | `summary.burn_time_s`, `depletion_s` | yes | 3.456 s |
| 25 | Total impulse | Load × design Isp: 24,281 N·s. F × `thrust.burn_time` = 27,174 N·s if anything uses the stale burn time. | `delivered.summary.total_impulse_Ns` | yes | 24,240 N·s (−0.17 %) |
| 26 | Propellant load | 6.611 / 4.404 kg (set by competition rule) | Config (`prepare.py:505`) | no (by design) | Fills 38 % of the 15.10 L LOX tank and 64 % of the 8.67 L fuel tank |
| 27 | Tank volume | 6.444 / 6.202 L (`tank_volume_m3`) | Drawing: 15.10 / 8.67 L (preflight warns) | yes | `series.*.fill_fraction` 0.378 → 0.0001 / 0.635 → 0.0085 |
| 28 | Ullage gas | Nitrogen at 293.15 K | Drawing He → `series.*.ullage_K` | yes | LOX ullage 292.5 → 283.2 K; fuel 292.8 → 273.8 K |
| 29 | Propellant temperature and density in the engine | LOX 90 K, 1140 kg/m³; ethanol 293 K, 789 kg/m³ (`fluids`) | Twin: `series.*.liquid_K` held at 90.00 / 293.15 K (thermal models off); density on the saturation line, 1142.1 / 789.3. Card tabulated at ED densities (`prepare.py:596-612`). | **no** for the engine | CoolProp: O2 saturated at 90 K is 1142.1, at 578 psia 1150.5 (+0.9 % against 1140, so ~0.46 % in flow). Ethanol is 792.8 at 578 psia. |
| 30 | Ambient pressure | 94.07 kPa: isothermal barometric formula at 626.67 m (`runner.py:30-57`). The ICAO lapse-rate value is 94.02 kPa (−0.05 %). | Same function (`prepare.py:344-345`) → `delivered.ambient_psia` | pad: same; flight: per altitude | 13.644 psia, constant on the pad |
| 31 | Acceleration / hydrostatic head | EngineDesign has no head term at all | `Setup.body_acceleration` 9.80665 (`feedtwin/session/core.py:525`); tank head = `outlet_psia − tank_psia` | partly | Tank head 0.48 (O) / 0.34 (F) psi → 0. The drawing has no line heights. |
| 32 | Nozzle efficiency | 0.95: the schema default "(0.94-0.98)" with no source (`config_schemas.py:1338`); `forward_report.py:45` marks it assumed | Card and replay both apply it (`nozzle.py:198-200`) | **no** | Swept 0.93–0.99 only in the uncertainty tab |
| 33 | Start transient / fuel lead | Steady state | DAQ Fire state opens Fuel Main and LOX Main together (`feed-twin/backend/statemachines/diablo_actuators.csv`, Fire column); valve travel 0.05 s; 0.5 s lead-in | **no** | No fuel lead, ignition delay or manifold fill. The user says LE4 runs a heavy fuel lead. |
| 34 | Unusable residual | none | `dry_kg` 1 g (burns dry) | no (needs a measured value) | — |
| 35 | Maximum tank pressure | `design_requirements.max_lox/fuel_tank_pressure_psi` 600 | Graded only against the drawing's MAWP (1000 psi, "estimated"). The optimiser uses 600 as a lockup cap (`optimize.py:104-107`). | not graded | Peak **618.35 / 619.00 psia** (about 605 psi across the wall). Exceeds 600; inside the user's stated 750 psi MEOP, which is not on the drawing. |

#### Disagreements to report (not fixed)
- **Regulator supply-pressure effect.**
  - The drawing says 17 psi/1000 psi ("manufacturer").
  - EngineDesign's code says the Aqua 1092 datasheet gives 10 and "TB 1031 reads 17" (`feed_pressure_model.py:57-66`).
  - The user names the Aqua Environment 1092-50.
  - What-if at 10: tank end 598.2 psia against 618.4; thrust 6760–7112 N against 6769–7315 N; mean 6913 against 7013 N; LOX ΔP/Pc max 0.394 against 0.403; impulse 24,179 against 24,240 N·s; burn 3.498 against 3.456 s.
- **Tank rating.** The user states ethanol tank MEOP 750 psi. The drawing has MAWP 1000 psi ("estimated") on both tanks; `design_requirements` caps tanks at 600 psi. Delivered peak is 619 psia.
- **Thrust target.** The goal is a constant ~7.2 kN. The document is named "7200N"; the yaml says `target_thrust` 6500 and has stale `design_*` fields; Forward gives 6804 N; Layer X gives 6752 → 7315 N.
- **Feed lengths.** The yaml says 1 ft / 4.5 ft (vehicle). The app doc says 4 in / 3 ft. The He drawing has 0.14 / 0.96 m (stand, "estimated").
- **Pressurant.** The config says N2 ullage gas and a 1.312 kg bottle charge. The He drawing holds 0.209 kg He. The Layer X UI defaults to `copv_study_gn2` (`LayerX.tsx:446`), not the He hot-fire drawing.

#### Experiments
1. **Forward at 578/578 psia on the yaml.** Pc 393.22 psia, F 6803.7 N, Isp 224.77 s, O/F 1.5232, η_c* 0.9105, Cd 0.784/0.776, `dp_feed` 41.34/47.31, Δp_inj 143.44/137.47 psi, R 1.0304, M 1.1774, chug gate 1.509 (nominal 2.108) at 28.3 Hz.
2. **He burn on the yaml.** The table above.
3. **The same burn on the app document.** Throat +5.69 %, chug min 1.367, impulse 24,233 N·s, peak 7362 N.
4. **SPE what-if at 10 psi/1000 psi.** The numbers above.
5. **Chug like-for-like.** The full config at 578/578 gives 1.5089. The line-exit config at the same line-exit pressures (561.82/546.36 psia) gives 1.4075, with the same Pc and F. Plus the feed-length and regulator-corner sweeps in rows 7 and 9.
6. **Hand checks.**
   - Drawn line losses (17.93 / 33.19 psi) against the twin (17.91 / 33.22) **[corrected: said 17.9 / 32.7]**.
   - Dump 24.85 psi.
   - SPE rise (48.3 against 47.1 psi) **[corrected: said 45.9]**.
   - Bottle end against the CoolProp real-gas isentrope (1603 against 1646 psia).
   - He fill mass (0.2090 kg), O2 and ethanol densities.
7. **Negative K0.** Schema validation of K0 = −0.0379 fails with `greater_than_equal`.

Scripts and outputs are in `/private/tmp/claude-501/-Users-carlton-Downloads-STAR-ASF-STAR-EngineDesign/6e249fb6-61aa-428c-b921-67469511876f/scratchpad/audit/ledger/`. Note that the parent `audit/` folder is shared, and another agent's `audit/feedtwin/` directory shadows the `feedtwin` package for any script run from that folder.

### 9.8 LE4 baseline golden runs

Area: LE4 baseline golden runs.

**Auditor's summary.** I built and checked the LE4 Layer X baseline. It covers 3 cases, plus 2 supplementary ones. On the pad with helium and the eroding replay, LE4 gives 24,240 N·s over 3.456 s: 7,013 N mean thrust (6,769–7,315 N), Pc 399.7 psia, O/F 1.521, Isp 225.4 s. The bottle ends at 1,646 psia, 1,068 psi over lockup. LOX runs dry first, with 0.058 kg of fuel left. The lowest chug margin is 1.398, at ignition. With GN2 on the pad: 24,092 N·s over 3.598 s, 6,696 N mean.

The most important finding: the helium hot-fire drawing cannot be flown at default settings. The flight sim prices the ullage refill as nitrogen, from the config's ullage_gas, and then refuses the 0.208 kg helium bottle ("needs 0.521 kg"; hand calculation gives 0.5209 kg). As a result case (b) has no apogee. A what-if with ullage_gas set to Helium flies to 3,249 m AGL.

Second finding: the app document the UI server actually runs differs from configs/ethalox_6800N.yaml in 8 fields (graphite GR001CC properties and feed-line lengths). That moves throat growth by +42 % relative and chug margin by −2.2 %.

Burns are bitwise reproducible across processes. The golden test passes. It goes red on an edited expected value, a halved regulator supply-pressure effect, and a changed drawing. It stays green on a solver-tolerance change.

Impulse alone is a weak witness. Halving the regulator's supply-pressure effect moved impulse only −0.30 %, while thrust moved −1.7 % and bottle pressure +9.5 %.

#### Deliverables
- `EngineDesign/scripts/layerx_baseline.py`: runs Layer X in-process, the same way the router does (`backend/routers/layerx.py:564-583`):
  - a deep copy of the config with its own `PintleEngineRunner`
  - no restated parameters
  - `run_prepared(prep, runner=..., replay=settings.replay, config=...)`
  - Importable: `run_case(name, config=..., dt=...)` and `run_baseline(...)` return plain dicts.
  - Options: `--case` (repeatable), `--all`, `--dt`, `--out`, `--config` (YAML, app-document JSON, or a baseline JSON with its embedded config), `--no-embed`.
- `EngineDesign/docs/layerx/baseline-2026-10-02.json` (71 kB) contains:
  - 3 baseline cases and 2 supplementary cases
  - the full config embedded (`inputs.config`)
  - input hashes: drawing sha256, CEA cache sha256, DAQ state-machine tables sha256
  - versions; the code is `08b47c05-dirty`
  - `layerx_settings_defaults`
  - an `audit_2026_10_02` block with everything below
- `EngineDesign/tests/test_layerx_golden.py`: 29 tests.
  - The suite registers no `slow` marker (`pyproject.toml` `[tool.pytest.ini_options]` has none; `tests/conftest.py` only quarantines), so it is skipped unless `LAYERX_GOLDEN=1`.
  - It burns `he_pad` on the config embedded in the baseline, so design edits do not read as physics changes.
  - `test_inputs_unchanged` checks the drawing, CEA and DAQ hashes; `test_layerx_defaults_unchanged` checks the settings defaults; `test_embedded_config_round_trips` checks the config survives the schema.
  - `LAYERX_GOLDEN_BASELINE` points it at another file.
  - Runtime 80–94 s at load average 35–45.

#### Which config is LE4: they disagree, and this needs a decision
The :8000 server has the app document "Ethalox 7200N Doublet" loaded (`GET /api/config`, fingerprint `ae3edfd745c3cce2`, identical to `.userdata/local/engine/ethalox-7200n-doublet/current.json`). It is **not** `configs/ethalox_6800N.yaml` (fingerprint `7782d2fdd7f9f4dd`; the file is untracked in git, mtime 2026-10-01 15:23). They differ in 8 fields:

| field | YAML | app document (what the UI runs) |
|---|---|---|
| feed_system.fuel.length | 1.3716 m (yaml:94, "4.5 ft … team, 2026-10-01") | 0.9144 m |
| feed_system.oxidizer.length | 0.3048 m (yaml:104) | 0.1016 m |
| graphite_insert.material_density | 1810 (GR001CC datasheet, yaml:186) | 2260 |
| graphite thermal_conductivity | 92.67 | 100 |
| specific_heat_model | butland_maddison_1973 | constant |
| surface_temperature_limit | 3033.15 K | 2500 K |
| oxidation_temperature | 700.15 K | 800 K |
| material_source | Graphtek GR001CC text | null |

None of the 59 app-document versions ever carried the YAML's values; the docs say the team lengths "are now the design's" (`docs/layer-x.md:556-558`). The baseline uses the YAML. Measured effect of burning the app document instead:

| | He pad | GN2 pad |
|---|---|---|
| impulse | −0.03 % (24,233) | −0.03 % (24,084) |
| burn time | −0.33 % | −0.33 % |
| mean thrust | +0.31 % | +0.30 % |
| max thrust | +0.65 % | +0.61 % |
| Pc mean | −0.41 % | −0.41 % |
| throat area growth | 5.69 % vs 4.00 % (+42 % relative) | 5.74 % vs 4.05 % |
| chug margin min | 1.367 vs 1.398 (−2.2 %) | 1.323 vs 1.355 (−2.4 %) |

#### Settings used
Every case uses `LayerXSettings` defaults (`engine/layerx/prepare.py:55-100`), changing only `drawing_id` and `flight`:
- dt 0.05 s, hold 300 s, card engine, replay on
- ullage collapse, vapour, line walls and chilldown all off
- dry_kg 0.001
- config load (LOX 6.6114 kg, fuel 4.4038 kg), lockup 578 psia (yaml:453/462), bottle 4500 psig from the drawing; dome solved to 513.55 psig

The UI's `DEFAULT_SETTINGS` (`frontend/src/api/layerx.ts:55-75`) differ in one place: **`flight: true`** (line 71). The tab also preselects `copv_study_gn2` (`LayerX.tsx:446`). So the tab's out-of-the-box run is GN2 flown (supplementary case `gn2_flight`), not the helium hot-fire.

#### Baseline figures
Engine figures (impulse, thrust, Pc, Isp) are the *delivered* ones, the replay's, as the tab headline shows them (`LayerXResult.tsx:51-75`). Feed figures are the twin's. "Over lockup" means `copv_end − max(tank t0)`, the UI's definition (`LayerXResult.tsx:152-153`).

| | he_pad (a) | he_flight (b) default | gn2_pad (c) | gn2_flight (UI default run) | he_flight_he_ullage (what-if) |
|---|---|---|---|---|---|
| total impulse N·s | **24,239.8** | 24,239.8 (pad burn; flight failed) | 24,092.2 | 24,088.1 | 24,235.2 |
| burn time s | 3.4562 | 3.4562 | 3.5983 | 3.5885 | 3.4461 |
| thrust mean/min/max N | 7,013 / 6,769 / 7,315 | same | 6,696 / 6,540 / 6,910 | 6,713 / 6,567 / 6,911 | 7,033 / 6,802 / 7,316 |
| Pc mean psia (min–max) | 399.69 (391.1–405.2) | same | 382.89 (378.6–385.6) | 383.66 | 400.49 |
| O/F mean | 1.5211 | same | 1.5157 | 1.5177 | 1.5233 |
| Isp delivered s | 225.39 | same | 223.76 | 223.85 | 225.49 |
| bottle at burnout psia (over lockup) | 1,646.3 (1,068.2) | same | 1,204.3 (626.1) | 1,206.4 (628.2) | 1,648.2 (1,070.1) |
| pressurant used kg | 0.0906 He | same | 0.7111 N2 | 0.7103 | 0.0905 |
| tank peak LOX / fuel psia | 618.4 / 619.0 | same | 578.1 / 580.6 | 578.1 / 580.5 | 618.3 / 619.0 |
| tank min while firing LOX / fuel | 574.4 / 574.4 (ignition dip 3.6 / 3.7 psi) | same | 552.9 / 553.0 (dip 25.0 / 25.3) | 552.7 / 552.9 | 574.4 |
| min ΔP/Pc LOX / fuel (after 0.2 s) | 36.34 % / 34.87 % | same | 35.42 % / 33.65 % | 35.60 % / 33.68 % | 36.57 % / 34.90 % |
| min ΔP/Pc at ignition (first 0.2 s) | 36.27 % / 34.73 % | same | 36.22 % / 33.66 % | 36.44 / 33.70 | 36.50 / 34.75 |
| min injector ΔP LOX / fuel psi | 142.1 / 136.4 | same | 134.1 / 128.1 | 135.3 / 128.6 | 143.6 / 137.1 |
| chug margin min (at) | 1.398 (0.05 s, first firing step) | same | 1.355 (0.70 s) | 1.362 (0.70 s) | 1.407 (0.05 s) |
| depleted / residual of other | LOX / 0.0579 kg fuel | same | LOX / 0.0423 kg | LOX / 0.0483 kg | LOX / 0.0641 kg |
| throat area growth (recession) | 4.005 % (0.474 mm) | same | 4.046 % (0.479 mm) | 4.061 % (0.480 mm) | 4.02 % (0.476 mm) |
| apogee | — | **flight failed** | — | 3,125 m AGL (10,251 ft); liftoff 82.41 kg at 8.35 g, max 9.04 g, Mach 0.80 | 3,249 m AGL (10,660 ft); liftoff 80.67 kg at 8.58 g, max 9.78 g, Mach 0.83 |
| passes / converged / failed steps | 2 / yes / 0 | 2 / yes / 0 | 2 / yes / 0 | 4 / yes / 0 | 4 / yes / 0 |
| wall time (load average 35–45 on 12 cores) | 88.8 s | 77.7 s | 20.7 s | 44.3 s | 160.3 s |

Cross-checks in the run:
- Engine-check worst vs the replay (He pad): Pc 0.11 %, mdot 0.12–0.13 %, thrust 0.50 %. The thrust gap is the card's as-built nozzle, as documented.
- Forward cross-check at t = 0.25 s: Pc −0.27 %, thrust −0.18 %.
- The replay's flows integrate to 10.966 kg against the twin's 10.956 kg (0.09 %, inside the 0.13 % agreement).

GN2 against the earlier documented burn (`docs/layer-x.md:278-281`: 3.59 s, 24.09 kN·s, 6713 N, 381 psia, Isp 223.7 s, O/F 1.516, throat +5.6 %):
- impulse, Isp and O/F agree
- throat growth is now 4.05 %, from the YAML's GR001CC graphite

#### Independent checks (not the sim)
- Dome: 578 − 14.696 − 50 + 0.017·(4514.696 − 4500) = 513.554 psig, equal to `derived.dome_psig`.
- He bottle at T-0: 0.208980 kg vs CoolProp ρ(4514.5 psia, 293.15 K)·4.6871 L = 0.208977 kg.
- He bottle at burnout, 1,646.3 psia, lies between the isentropic (1,603.2) and isothermal (2,407.7 psia) blowdowns of the same 0.0906 kg. The implied gas temperature is 199.9 K (near-adiabatic over 3.5 s, as expected).
- Helium gained by both ullages, from CoolProp at the twin's p, T and fill, equals the bottle's loss to 2e-9 relative.
- Tank rise 578.0 → 618.4 psia (+40.3) vs the regulator supply-pressure effect: 17 psi/1000 psi × (4514.5 − 1646.3) = +48.8 psi, less ~2 psi He droop and line losses.
- Fuel residual: 4.4038 − 6.6104/1.52109 = 0.0580 kg vs 0.0579 reported.
- Flight refill at defaults: ρ_N2(578 psia, 293.15 K) = 46.07 kg/m³ gives 46.07/1140·6.611 + 46.07/789·4.346 = 0.5209 kg, which matches the sim's "0.521 kg". The same with helium is 0.0726 kg.

#### Defect: the helium drawing cannot fly at defaults (case b)
- `ui/flight_sim.py:319-329, 781` sizes ullage gas with `config.<tank>.ullage_gas`, which is `Nitrogen` (`configs/ethalox_6800N.yaml:455, 464`).
- `ui/flight_sim.py:886-897` raises "COPV holds 0.208 kg; … needs 0.521 kg".
- Meanwhile `engine/layerx/flight.py:153-163` has replaced the config's bottle mass with the twin's helium (0.208 kg).
- `run_prepared` (`analysis.py:195-199, 224-227`) records a "Flight failed" event, reports the pad burn and sets `converged=True`.

Consequences:
- Every flown run on the helium hot-fire drawing has no apogee, and the UI defaults flight on.
- `ui/flight_sim.py:899` (lockup_kg) and the hard-coded "Pressurant (N₂)" labels (848, 916) have the same gas assumption.
- With the species patched to Helium (what-if case): 3,249 m AGL against 3,125 m for GN2 (+124 m, mostly the ~1.7 kg lighter vehicle: 80.67 vs 82.41 kg).

#### Disagreements with the user's statements (reported, not fixed)
- **Pressurant**: the user says helium for hot fire, but the config is GN2-sized (ullage_gas Nitrogen, `press_tank.initial_gas_mass` 1.312 kg, yaml:455/464/471) and the UI's default drawing is GN2.
- **Ethanol tank MEOP 750 psi** (user) vs the drawing's MAWP of 1000 psi, marked "estimated, twice the 500 psig operating pressure". The He pad fuel tank peaks at 619.0 psia = 605.4 psi across the wall at the 627 m site: 81 % of 750, 61 % of 1000.
- **Constant thrust near 7.2 kN**: the He pad burn is 7,013 N mean and rises monotonically, 6,752 → 7,315 N (+8.3 %). Tank pressure climbs 40 psi because the regulator's supply-pressure effect (17 psi/1000 psi, manufacturer, drawing PR_D) is barely offset by droop on helium. GN2 means 6,696 N.
- **Regulator droop**: `flow_droop` 8.3 psi at `rated_flow` 0.09646 kg/s was measured with GN2 (drawing PR_D), and feedtwin scales it by mass flow (`lib/feedtwin/feedtwin/comps/regulator.py:157, 187-195`). If droop scales with seat area (choked flow, A ∝ √M at the same volumetric demand), helium droop should be ~0.36× GN2's per unit ullage volume flow, not ~0.14×.
  - Estimate: ~5.8 psi vs the modelled ~2.3 psi on this burn, i.e. ~3.5 psi of tank pressure and ~0.4–0.5 % of Pc/thrust.
  - This is a hand estimate under the droop-proportional-to-lift assumption; not verified.
- **Design liftoff mass**: unset, it is the config's airframe + motor + load + gases = 82.41 kg (GN2) or 80.67 kg (He). `tests/test_layerx_robustness.py:73` and project memory use 86.18 kg (190 lb).
- **Tank volumes**: the drawing's tanks are 15.10 L / 8.67 L against the config's 6.44 L / 6.20 L (preflight warns). The burn follows the drawing; the flight's inertia follows the config.

#### Discretization, reproducibility, tolerance evidence
- **Reproducibility**: he_pad burned in three separate processes, and every figure was bitwise identical (numpy 2.4.2, CoolProp 7.2.0, Python 3.11.7, macOS arm64). Drift on the CI stack (py 3.12, numpy 2.5.3, CoolProp 8.0.0) was **not measured**.
- **dt** (he_pad):

| dt | impulse | burn time | chug margin min |
|---|---|---|---|
| 0.1 s | +0.078 % | +0.019 % | — |
| 0.02 s | −0.056 % | — | −0.58 % (first sample moves to 0.02 s) |

  First-order extrapolation puts dt → 0 about 0.09 % (~22 N·s) below the 0.05 s figure. The fuel tank minimum moves −1.5 psi at 0.02 s because the ignition dip is resolved.
  [Review note: this extrapolation does not hold. Finer steps on the app document (9.5) move the delivered impulse −0.12 / −0.27 / −0.80 % at 10 / 5 / 2 ms, because the first replay point falls inside the valve ramp; only the twin's own impulse converges (+0.05 %, 50 vs 1 ms). See section 8.]
- **Golden test can fail**:
  1. Scratch baseline with impulse ×1.006 and chug margin ×0.99: exactly those 2 of 29 failed (−0.596 %, +1.010 %).
  2. Regulator supply-pressure effect halved in-process (pytest plugin, no source edit): 8 of 29 failed:
     - burn time +1.45 %
     - mean thrust −1.73 %, max thrust −3.34 %
     - Pc −1.65 %
     - bottle +9.50 %, gas used −6.96 %
     - tank peaks −24.3 / −24.5 psi

     Impulse moved only −0.30 % and passed.
  3. `NETWORK_TOLERANCE` 1e-6 → 1e-4: all 29 passed (impulse −0.018 %, mean thrust −0.025 %, bottle +0.068 %, stiffness −0.15 % relative).
  4. Shipped drawing relabelled (cosmetic): only `test_inputs_unchanged` failed.
- **Tolerances chosen**:
  - 0.5 % on impulse, burn time, thrust, Pc, O/F and propellant used (half the 1 % reporting rule)
  - 0.3 % on Isp (0.7 s)
  - 1 % on bottle pressure and gas used
  - 3 psi on tank peaks and minima
  - 0.003 on ΔP/Pc (1.2 psi of a ~136 psi drop, ~0.9 % of the value)
  - 0.5 % on chug margin, and one step on its time
  - 0.02 kg on the residual (an O/F move of ~0.5 %)
  - 2 % relative on throat growth and recession
  - exact on depleted side, converged, failed steps and card-outside steps

#### Pitfall found while testing
`engine/layerx/__init__.py:17` imports the *function* `prepare`, which shadows the submodule. `import engine.layerx.prepare as P` therefore binds the function, and `P.NETWORK_TOLERANCE = …` silently does nothing; my first mutation run showed zero change because of this. Patch module constants through `sys.modules["engine.layerx.prepare"]`.

#### Other notes
- **Scratch directory**: the shared scratch directory `.../scratchpad/audit/` contains a `feedtwin/` folder from another agent. Any script run from that directory shadows the real `feedtwin` package as a namespace package (`ImportError: cannot import name '__version__' from 'feedtwin' (unknown location)`). My files are in `audit/baseline/`.
- **Wall time**: helium burns took 85–95 s against 21 s for GN2 under the same load (4×). This was not investigated.

### 9.9 Result data inventory and frontend capability for the GUI rebuild

Area: Result data inventory and frontend capability for the Layer X GUI rebuild.

**Auditor's summary.** A saved Layer X burn (run 20261002-231658-7e47d1) is 0.239 MB. It holds 80 twin steps: 10 lead-in samples from −0.45 to 0 s and 70 firing steps at dt 0.05 s, with the last step cut to 0.0163 s. Alongside them it has 70 "delivered" steps, but those are linear interpolations of only 28 EngineDesign replay points. The feed data is thin: it keeps 4–5 pressures per side and no branch flows, no valve positions, no regulator inlet, flow or dome, and no bottle gas temperature. All of these exist at every step in memory: feedtwin's Sample carries 31 node pressures and temperatures, 29 branch flows and 9 valve/dome signals, about 1.4 kB per step. They are thrown away because BurnTrace records only probe nodes. The replay works the same way. It keeps 24 of the 69 arrays EngineDesign returns and drops the per-step diagnostics: momentum ratio, the η_c* breakdown, SMD, injector ΔP, and ablative heat-flux profiles at 278 axial stations. As a result the Feed, Engine and Hardware pages cannot be built from saved runs without backend changes. Of the 12 graded limits, only the chug margin stores its worst-case time. Six times can be worked out from series, events or rows. The card-outside flags exist only as a count. The "hold and burn" peak covers only the 0.5 s lead-in plus the burn. On the frontend: uPlot 1.6.32 is already installed but unused, Playwright 1.62.1 with Chromium 151 is installed and launches, and npm can reach the registry. The app has one dark theme, no router (view state lives in localStorage), and a hand-drawn schematic, although the drawings do carry x/y positions and source/target edges.

#### A. The saved run record (what the GUI loads today)

**Files**: `EngineDesign/.userdata/local/engine/layerx/runs/<id>.json` (full) plus `_index/<id>.json` (listing entry: envelope + `summary` + `drawing`, ~2 kB) plus an optional meta file (name/note/pin). `GET /api/layerx/runs` reads only the index (`backend/routers/layerx.py:1010-1043`). `GET /runs/{id}` returns the full record (`:1077-1086`). Pruned to `KEEP_RUNS=25` (`:57`).

**Inventory**: 32 records = 24 burns (`kind: run`), 1 uncertainty, 3 reconcile, 2 trade, 1 optimize, 1 cancelled. **Every one of the 24 burns used `copv_study_gn2` with `pressurant: null`** (drawing id 727858dd44db02bc). The helium hot-fire drawing `copv_study_he` has never been burned in the saved history. The UI picks GN2 by name when nothing is stored (`frontend/src/components/layerx/LayerX.tsx:446`).

**Reference run 20261002-231658-7e47d1** (latest, replay + flight, 4 passes, converged):
- File size: 238,739 B = **0.239 MB**. Burn sizes range 0.117 MB (no replay or flight, Oct 1) to 0.242 MB.
- Steps: **80** twin steps (`summary.steps`). Of these, 10 are lead-in at t = −0.45 … 0 s (`firing=false`) and 70 are firing. dt = 0.05 s; the last step is 0.0163 s (`end_on_depletion`). Burn time is 3.4663 s.
- Envelope keys: `id, kind, status, stage, progress, error, started, finished, design ("default"), settings, result`.

**`result` top-level keys and JSON sizes**:

| key | bytes | cadence |
|---|---|---|
| series | 67,938 | per twin step (80) |
| provenance | 52,048 | scalar/config: assumptions 22.2 kB (125 rows), reproduce.design_yaml 20.3 kB, derived 4.0 kB |
| flight | 27,870 | trajectory 240 pts (0 to apogee 25.15 s), schedule 71 pts, scalars |
| timeseries | 24,256 | 71 pts (a Fire sample plus 70 firing). **Duplicates series and delivered** in the Time-Series tab's shape |
| delivered | 24,140 | 70 firing steps, **interpolated from 28 replay points** |
| replay | 14,925 | 28 replay points |
| engine_check | 13,290 | 27 rows (replay points with t ≥ 0.1 s) |
| checks | 4,087 | 17 preflight checks |
| feed_fit | 2,680 | scalar per side |
| passes | 2,384 | per pass (4) |
| summary | 1,747 | scalar (31 keys) |
| cross_check | 1,587 | one instant (t = 0.25 s), 8 rows |
| events | 469 | 5 events |
| motor | 355 | scalar |
| converged | bool | |

##### A.1 `series` (per twin step, n = 80, absolute psia; built in `engine/layerx/analysis.py:536-562`)

| key | unit | range in 7e47d1 | notes |
|---|---|---|---|
| t | s from Fire | −0.45 … 3.466 | |
| dt | s | 0.0163 … 0.05 | each step's own length; **not in TS `Series`** |
| firing, converged | bool | | |
| copv_psia | psia | 1406 … 4510 | the vessel state, not the KB1 node |
| copv_mass_kg | kg | 0.8155 … 1.456 | |
| copv_wall_K | K | 292.3 … 293.1 | **bottle gas temperature is not recorded** |
| regulators.PR_D.{label, outlet_psia} | psia | 569.6 … 613.1 | outlet node only |
| instruments.{id}.{tag, type, unit, values} | psia or K | 11 instruments: 6 PT, 4 TC, 1 RTD | drawing transducers (`analysis.py:477-487`) |
| ox, fuel.tank_psia | psia | 552 … 583 | ullage node |
| .outlet_psia | psia | | tank outlet node, liquid head included |
| .inlet_psia | psia | 14.7 … 560 | line exit (`ENG.oxidiser` / `ENG.fuel`) |
| .dump_psi | psi | 0 … 28.0 | Borda K_exit·ρv²/2, computed in reduce (`:509-511`) |
| .manifold_psia | psia | | inlet minus dump |
| .dp_injector_psi | psi | 0 … 135 | manifold minus Pc (0 when not firing) |
| .stiffness | fraction | 0 … 0.34 | dp/Pc |
| .mdot | kg/s | 0 … 1.97 | |
| .liquid_kg, .fill_fraction | kg, fraction | | |
| .ullage_K, .liquid_K | K | | bulk liquid only |
| chamber.{pc_psia, mr, thrust_N, isp_s, cstar, extrapolated} | psia, –, N, s, m/s, 0/1 | | twin's as-built-throat card engine; zeros through the lead-in |

##### A.2 Other blocks
- **summary** (`analysis.py:606-641`) includes `impulse_to_depletion_Ns`, `depletion_s` and per side `stiffness_min_ignition`, `peak_psia`. **None of these three is typed in TS or shown in the UI.**
- **events** (`analysis.py:644-673`): kinds `t0, fire, min` (LOX/Fuel tank lowest), `end` (tank dry), `warn` (did not settle, horizon, card outside, unconverged, replay or flight failed, burn did not settle). There is **no** event for chug minimum, peak tank pressure, valve fully open, regulator dropout, max-accel or apogee.
- **passes[]** (`analysis.py:164-206`): pass, throat_applied, accel_applied, burn_time_s, throat_growth, schedule_change, agreement.worst{mdot_O, mdot_F, pc}. Flown passes from 2 onward add the PassFigures, accel_change and apogee. **Earlier passes' series are discarded**: `result` is overwritten each pass (`:160-161`).
- **replay** (28 points; `replay.py:91-127`): t, index (series indices 10…79), inlet_O/F_psia, pc_psia, thrust_N, mdot_O/F, mr, isp_s, cstar, eta_cstar, gamma, A_throat_m2, throat_area_ratio, recession_throat_mm, recession_chamber_mm, eps, p_exit_psia, t_exit_K, gamma_exit, tc_K, Lstar_m, heat_flux_throat/chamber_MW_m2, T_graphite_surface_K, T_liner_surface_K, char_depth_peak_mm, chug_margin, and the flags throat_ablation / liner_ablation.
- **delivered** (70; `replay.py:179-225`): thrust_N, pc_psia, mdot_O/F, isp_s, mr, throat_area_ratio, recession_throat_mm, cstar, gamma, eps, p_exit_psia, t_exit_K, gamma_exit, tc_K, chug_margin, plus `ambient_psia` (12.95–13.64 psia in flight, from altitude; `analysis.py:247-260`). Its summary includes `chug_margin_min` = 1.2046 at `chug_margin_min_t` = 0.80 s. **Every column is `np.interp` of the 28 replay points** (`replay.py:171-176, 194`). It holds at most 28 independent samples, spaced 0.10–0.15 s.
- **flight** (`flight.py:286-311`): apogee/velocity/mach/rail/accel scalars with their times, `stability` (static margins in calibres at liftoff, rail exit and burnout; min/max with times), checks, ceiling, mass_budget, notes, trajectory{t, altitude_m, velocity_m_s, mach, accel_axial_g} at 240 points (`TRAJECTORY_POINTS=240`, `flight.py:53`), schedule{t, accel_m_s2} at 71 points on the burn clock, truncation, pad / in_flight PassFigures, vehicle_lines. **There is no dynamic pressure, drag, thrust or mass on the trajectory.**
- **engine_check** (`analysis.py:835-866`, against the replay), **cross_check** (`:726-781`), **feed_fit** (`feedfit.py`), **motor** (`eng.py`), **provenance** (drawing sha, config_sha256, settings, derived, setup with 48 fields, plan, calibration with card fit and provenance, engine_reference, assembly.assumptions (125 rows with source/reference), notes, probes, **reproduce.design_yaml and code** (added by router `layerx.py:578`), wall_s, feedtwin_version, phase).

##### A.3 Units and conventions a GUI must respect
- Everything is psia except `dump_psi` and `dp_injector_psi` (differential). The gauge zero is `provenance.derived.gauge_zero_pa` (101325 Pa) and the site ambient is `derived.ambient_pa` (94,069.7 Pa at 626.67 m).
- `stiffness` is a fraction. Summary stiffness and Pc statistics use only steps with t ≥ 0.2 s (`analysis.py:567`).
- Integrals must use `series.dt`, because the last step is short.
- `delivered` indexes firing steps only. Map with `firingIndexOf` (`LayerXResult.tsx:810-815`); `replay.index` already gives series indices.

#### B. What exists per step in memory but is discarded

**feedtwin Sample** (`lib/feedtwin/feedtwin/session/core.py:1147-1165`, built at `:2425-2441`): `pressures` and `temperatures` for every network node, `flows` for every branch, `signals` (slewed valve positions plus dome), `tanks` readouts, `chamber`, `state`, `notes`.

**BurnTrace** records only probe nodes (`session/burn.py:414-425, 456-490`). `reduce_trace` then drops `trace.temperature` (except TC/RTD instruments) and the tank `wall_temperature_K` (`burn.py:377-383`).

**Experiment** (scratchpad `audit/gui/full_sample.py`): the copv_study_he drawing with configs/ethalox_6800N.yaml, run twin-only (replay off, flight off, line walls and collapse on). It gave 80 steps, 31 nodes, 29 branches and 9 signals, versus 13 probe nodes recorded. Recording everything costs **1,382 B per step (110,613 B for 80 steps)**.
- Node ids map 1:1 onto the drawing: `<symbol>.in/.out` for valves and regulators, the tank id for the ullage, `<tank>.out`, `KB1`, `MF1`/`MF2`, and `ENG.{oxidiser, fuel, chamber}`.
- Branch ids are the drawing's own symbol ids (valves, PR_D) or edge ids (pipes `l_ox1`, …) plus `ENG.<side>.injector`.
- Signals: `PR-DOME.dome` and 8 `*.command` positions (0…1, slewed).
- Chamber result fields available but not recorded: `combustion.gamma`, `combustion.temperature`, `thrust_coefficient`.
- Tank readouts not recorded: `level_m`, `surface_temperature_K`, `wall_temperature_K`, `volume_L`.

**Pressure ladder at burnout (t = 3.45 s, He)**:
- LOX: OXT 616.35 → OXT.out 616.37 → MVO.in 600.20 → MVO.out 598.98 → ENG.oxidiser 596.55 → chamber 412.36 psia.
- Fuel: FUT.out 616.87 → MVF.in 582.40 (34.5 psi in `l_fu1`) → MVF.out 581.63 → ENG.fuel 580.22 psia.
- Gas side: KB1 1874 → MF1 1874 → PR_D.in 1863 → PR_D.out 620.7 → MF2 619.4 → SV_LOX_PRESS.out 616.7 psia.

Today's series cannot tell the GUI whether the 16–35 psi tank-to-line-exit loss sits in the line or the valve.

**Regulator operating point over the burn (He)**:
- Outlet rises 578.1 → 621.0 psia (+42.9 psi) as the inlet falls 4511 → 1843 psia, at a flow of 0.019 → 0.028 kg/s. The dome signal stays constant at 528.2 psia.
- Hand check from the drawing's own `supply_coefficient` (17 psi per 1000 psi): +45.4 psi, less ~2.4 psi droop (8.3 psi at 0.0965 kg/s, scaled to 0.028 kg/s) = +43.0 psi.
- Tanks go 577.8 → 616.8 psia, so LOX flow rises 1.852 → 1.948 kg/s (+5.2 %). The GN2 runs instead dip about 26 psi at ignition and end near lockup.
- This rise is invisible in today's result except through the regulator outlet line.

**Bottle (He)**:
- Gas temperature (KB1 node) 293.1 → 209.2 K. The isentropic estimate is 205.4 K (γ = 5/3), so the wall adds about 4 K.
- CoolProp mass 0.2089 → 0.1267 kg, i.e. 0.0822 kg used, against `copv_used_kg` 0.08237.
- Gas temperature is not in the result.
- The vessel pressure (1849.5 psia) and the KB1 node (1855 psia) differ by about 5 psi at the last step. Use `copv_psia`.
- The `ENG.chamber` node temperature (85.8 K) is a liquid-mixing artefact, not a gas temperature.

**Replay** (`audit/gui/replay_keys.py`, at 7e47d1's line-exit pressures with the 6800N yaml): the coupled solve takes 1.0–1.5 s for 29 points and returns **69 arrays, of which replay.py keeps 24**.
- **Dropped**: D_throat (47.81 → 48.72 mm), D_chamber, contraction_ratio (~7.06), chugging_frequency (31.1–32.5 Hz), stability_state/score, cstar_ideal, q_conv/q_rad/q_chem for chamber and throat, T_bondline(_peak) (300 K throughout), T_graphite_back (319 → 2317 K), recession_liner_peak, x_liner_peak, ablative/graphite recession rates, residence_time (1.8 ms), mach, Re, M_exit, v_exit, reaction progress, R, A_exit, V_chamber.
- **Per-step `diagnostics` (107 keys, about 54 kB each), all dropped**: momentum_ratio_R (1.030 mid-burn), J, TMR (0.42), D32_O/F (87/152 µm), P_injector_O/F, delta_p_injector_O/F, Cd_O/F (0.784/0.776), and `cstar_efficiency`{eta_mixing, eta_vaporization, eta_heat_loss, eta_total, …}.
- Also dropped: `cooling.ablative.segment_{x, r, q_conv, q_rad, q_incident, q_net, h, M}`, each **278 axial stations**.
- The wall model has only 4 liner stations plus the throat (`time_varying_solver.py:226-250`). The 278-station flux comes from the gas-side profile at those wall temperatures.

#### C. Page-by-page gap matrix (O = available in the saved run, D = derivable client-side, B = needs a backend change)

- **Overview**
  - Verdict and margins: O (limits are computed in the frontend; thresholds in `format.ts:92-112`).
  - Worst-case time per limit: see D.
  - "Peak over hold and burn": wrong scope, see E1.
- **Feed**
  - Pressure ladder at cursor: partial. O for tank, outlet, line exit, manifold and Pc; B for valve in/out and every gas-side node.
  - Regulator operating point: B, except the outlet (O). Inlet, flow and dome are in Sample.
  - Valve states: B (Sample.signals).
  - Branch flows: B, except the liquid mdot (O).
  - Saturation margin: D for tank bulk and line exit (CoolProp Psat at `liquid_K`). The line-liquid temperature exists only via TC instruments (TC_OXD 90.00–90.06 K). Surface temperature is B.
  - Injector cavitation number (P_man − Psat)/(P_man − Pc): D.
  - Pressurant budget: partial. O for bottle P and mass; B for bottle gas T, per-step ullage gas mass and pressurant in lines. Ullage gas mass appears only at Fire in `flight.mass_budget.ullage_gas_kg` (0.572 kg).
- **Engine**
  - Pc, thrust, O/F, Isp vs t: O (twin per step, delivered interpolated).
  - ΔP/Pc: O (twin). η_c*: O in replay only (28 points; not in delivered or TS).
  - Momentum ratio, η_c* breakdown, SMD, Cd: B (replay diagnostics).
  - Isp breakdown: B; not assembled anywhere in EngineDesign (`forward_report.py:104` gives only F/(ṁg0)).
  - Chug margin vs t: O (28 points). Nyquist at the worst point: B, and no code exports L(iω) (`stability/chug.py:138 _open_loop_grid` exists; `report.py:472` gives the root locus and boundary only on the single-point evaluate path, `runner.py:574`).
  - Operating trajectory (O/F, Pc): O. Isp contours: B, via `POST /api/layerx/card` (41×41 c* and v_vac over (O/F, ṁ) plus hull; `layerx.py:552-560`, `feedtwin/engine/card.py:246-330`). This is for the as-built throat and is rebuilt from the current design.
- **Hardware**
  - Throat diameter vs t: D from `A_throat_m2`. Liner recession: O (barrel station plus throat only). L* and ε vs t: O (replay).
  - Contour overlay: B. `/api/geometry` returns the **live** design's contour (`geometry.py:41-66`), not the burned one. The burned design is only in `provenance.reproduce.design_yaml`.
  - Heat-flux x–t heatmap: B (segment profiles).
  - Separation: D from `p_exit/ambient` (1.03–1.17 here; Summerfield 0.4 in `handcheck.py:86`), not graded.
  - Soak-back: B. `TimeVaryingCoupledSolver.soak_back` (`time_varying_solver.py:599`) has no caller outside `tests/test_time_varying_thermal.py:150`, and `runner.evaluate_arrays_with_time` does not return the solver.
- **Flight**: trajectory and scalars O. Max-Q, drag and dynamic pressure B. Static-margin scalars O but untyped.
- **Stand**: instruments per step O, plus the DAQ CSV import (`Measured.tsx`, `daqcsv.ts`) and the printable light test card (`testcard.ts`). Valve timing is B (signals). With dt 0.05 = valve_travel_s 0.05, the slew completes inside one step (MV-OX.command reads 0.00 at t = 0, then 1.00 at t = 0.05).
- **Uncertainty**: separate `kind: uncertainty` record (nominal, nominal_thrust as 72 [t, F] pairs, factors[7] with cases, band / band_low / band_high, 14 cases, 35 s).
- **Record**: provenance is complete (drawing sha, config sha, setup, plan, assumptions with sources, reproduce YAML and code hash). Earlier passes' series are not kept.

#### D. Graded limits (`verdictItems`, `LayerXResult.tsx:147-212`) and whether a worst-case time exists

| limit | value source | worst time | 7e47d1 |
|---|---|---|---|
| Chug margin (`:161-164`) | delivered.summary.chug_margin_min | **stored**: `chug_margin_min_t` (`replay.py:221-224`); replay resolution | 1.2046 at 0.80 s |
| LOX ΔP/Pc (`:165-167`) | summary.ox.stiffness_min | not stored; argmin `series.ox.stiffness` over firing steps with t ≥ 0.2 | 0.3082 at 0.75 s |
| Fuel ΔP/Pc (`:168-170`) | summary.fuel.stiffness_min | same | 0.2858 at 0.20 s (ignition minimum 0.2860 at 0.15 s is excluded and never graded) |
| LOX / Fuel tank peak (`:171-180`) | summary.*.peak_psia | not stored; argmax `series.*.tank_psia` | 580.3 / 582.9 psia at 3.466 s (burnout) |
| Bottle at burnout (`:181-184`) | copv_end_psia − lockup | burnout by definition (`series.t[-1]`) | 1405.7 − 578.0 = 827.7 psi |
| Tank pressure sag (`:185-187`) | max(t0 − min) | **events** `kind: min` (`analysis.py:653-657`) | LOX 0.60 s, Fuel 0.40 s |
| Runs dry first and Propellant left over (`:188-196`) | residual | event `end` | 3.466 s |
| Model not settled (`:197-199`) | converged | whole run; the warn event is stamped at t[-1] | – |
| Engine table outside (`:200-202`) | card_outside_steps | **not available**: count only (`analysis.py:456-470`); hull not in the result | 0 |
| Engine fit (`:204-207`) | engine_check.worst | derivable from rows[].rel | pc 0.12 % at 3.35 s |
| Solver (`:208-210`) | failed_steps | derivable from `series.converged` | none |

The Limits table rows are not interactive (`:240-265`). The cursor is a series index in local state (`:849`), set by chart hover (`:395-403`).

#### E. Problems found

1. **"Peak over the hold and the burn" covers only the 0.5 s lead-in plus the burn.**
   - The recorder starts after `prime_at_t0` (`analysis.py:76-84`).
   - `hold_s` is an initial-condition parameter (contact time, wall chilled), not an integration (`core.py:1436-1460`).
   - The 2–10 s settle with the press valves held open is not recorded (`burn.py:170-215`).
   - The hint (`LayerXResult.tsx:179`), the comment (`analysis.py:594`) and critique Ph15 ("fixed") all overstate the scope.
2. **The burned design is not `configs/ethalox_6800N.yaml`.**
   - Fingerprints: run 0a7bafc0…; yaml 7782d2fd…; yaml plus the run's design_patch f7b16c97…. The run's YAML has 32 leaf differences from the file.
   - Graphite density 2260 vs 1810 kg/m³ (GR001CC), k 100 vs 92.67 W/(m·K), cp model constant vs butland_maddison_1973, surface limit 2500 vs 3033 K, oxidation T 800 vs 700 K.
   - feed_system.fuel.length 0.9144 vs 1.3716 m; oxidizer.length 0.1016 vs 0.3048 m.
   - d_jet and L/d from the patch, plus several model selectors.
3. **The drawing's tank MAWP is 1000 psi for both tanks ("estimated", 2 × 500 psig).** You state an ethanol MEOP of 750 psi. The grade compares peak to 1000 psi (amber above 800). Reported, not changed.
4. **TS type drift** (`frontend/src/api/layerx.ts`):
   - Missing fields: `Series.dt`; `Summary.impulse_to_depletion_Ns`, `depletion_s`, `stiffness_min_ignition` (typed optional, unused); `Replay.{mr, cstar, eta_cstar, gamma, eps, p_exit_psia, t_exit_K, gamma_exit, tc_K, Lstar_m, heat_flux_chamber_MW_m2, T_liner_surface_K}`; `Delivered.{cstar, gamma}` and `summary.impulse_to_depletion_Ns`; `FlightResult.{stability, truncation}`; `LayerXResult.motor`; `Provenance.reproduce`; `CardFit.box_chamber_pc/thrust, box_dp_O/F`; `CardProvenance.ambient_pa_sampled, built`.
   - Dead variant: `EngineCheck.against: 'card-geometry'` is never produced.
5. **Listing summary mixes models** (`layerx.py:984-994`). It shows delivered impulse (24,160 N·s) next to the twin's mean, peak and min thrust, Pc and Isp (mean 6,984.6 N against delivered 6,970.1 N).
6. **Settings defaults disagree**: frontend `DEFAULT_SETTINGS.flight = true` (`layerx.ts:71`) but backend `False` (`prepare.py:90`).

#### F. Frontend capability

**Dependencies** (`frontend/package.json`):
- react 19.2.3, recharts ^2.15.0 (2.15.4 installed), **uplot ^1.6.32, installed 1.6.32 but not imported anywhere in `src`**, @fontsource Inter and JetBrains Mono.
- Dev: **@playwright/test ^1.49.1 (1.62.1 installed)**, @axe-core/playwright 4.13.0, vitest 2.1.9, vite 5.4.21, tailwindcss 4.1.18, typescript ~5.9.3.
- Scripts: `test` = vitest, `test:e2e` = playwright.
- `npm view uplot version` → 1.6.32, so the registry is reachable.

**Playwright**:
- `npx playwright --version` → 1.62.1. Browsers in `~/Library/Caches/ms-playwright`: chromium-1234, chromium_headless_shell-1234, ffmpeg-1011. These match `browsers.json` revision 1234 (Chrome for Testing 151.0.7922.34). Firefox and WebKit are not installed.
- Headless launch with `setContent` verified in 2,687 ms (`audit/gui/pw_launch.cjs`).
- `e2e/` has 3 specs (checkout-countdown, connect-no-loop, design-persistence) and none for Layer X.
- **Hazard**: `playwright.config.ts:50,62` sets `reuseExistingServer: !CI`. Locally it therefore reuses the live :8000 backend and its real `.userdata`, so the design-persistence spec would write into your designs; the throwaway `USERDATA_DIR` applies only when it boots its own.
- Vite listens on `[::1]:5173` only. `127.0.0.1:5173` fails and `localhost:5173` returns 200, while the config polls 127.0.0.1.

**Theming**:
- A single dark theme: 13 tokens on `:root` (`index.css:9-31`). There is no light theme, no `prefers-color-scheme` and no `data-theme`.
- Layer X is nearly tokenised: 7 hex literals in FeedSchematic.tsx and 1 in LayerXResult.tsx (REG `#c4b5fd`).
- The whole app has 322 hex literals in 33 non-test files and 546 raw Tailwind palette classes.
- `--color-text-tertiary` (6 uses) and `--color-bg-hover` (4 uses) are referenced but undefined, all outside Layer X.
- The only light rendering is the print test card (`testcard.ts`).

**Routing**:
- There is no router and no URL state; no `pushState`, `hash` or `popstate` in `src`.
- Tabs come from `useViewState('activeTab')` (`App.tsx:42`) and every panel stays mounted, hidden by class.
- `useViewState` (`lib/viewState.ts:30, 61-89`) is `useState` persisted to localStorage key `engine-design.view.v1`, read-modify-write, with try/catch.
- Layer X keys: `layerx.page`, `layerx.openRun`, `layerx.compare`, `layerx.view`, `layerx.settings.v2`, `layerx.advanced`, `layerx.sweepByRun`.
- Runs are polled (`jobs.ts`: 500 ms for a live run, 2 s for the list).

**Charts and schematic**:
- Recharts MiniCharts re-render on every cursor move (critique C7 open).
- FeedSchematic is a hand-drawn SVG with a fixed `viewBox 0 0 1180 330` (`FeedSchematic.tsx:222`) and hard-coded coordinates (`:33-37`), not generated from the drawing (critique V8 open).

#### G. Drawing format and generating a schematic from it

**Shipped drawings** (`feed-twin/backend/diagrams/*.json`) are React Flow `{nodes, edges}`:
- `nodes[]`: `{id, position{x, y}, data{componentType, label, fluid, params{name: {value, unit, source, reference}}, attachedTo?, options{side}?}}`. Counts: 30 symbols (KBOTTLE 1, PR 2, MANIFOLD 2, SOL 8, VENT 3, TANK 2, ENGINE 1, PT 6, TC 4, RTD 1).
- `edges[]`: `{id, source, target, data{lineType, params{length, bore, roughness, K_minor, wall_thickness, fitting_mass}}}`, 20 lines.
- **No `sourceHandle`/`targetHandle`, no waypoints, no `measured` sizes.** Bounding box x 40–950, y 115–700 px.
- He, GN2 and stand drawings share identical topology and positions.
- No edge states `elevation_change`, so `vehicle_lines.drop_m = 0` and `used: none`.
- Instrument positions are not near their attachment points: TC_OXD sits 799 px from MVO, RTD_OXT 590 px from OXT, and TC_REGI overlaps VENT_LOX at 22 px. Place instruments by `attachedTo` plus `options.side`.

**pid-designer documents** add `type`, `measured{width, height}` (60×60 symbols), edges with `sourceHandle`/`targetHandle` (`l`/`r`/`t`/`b`), `type: 'smoothstep'`, and `data.waypoints` for manual corners (`pid-designer/frontend/src/components/pid/drop.ts:873-950`).
- Routes are otherwise computed at render time (`route.ts` routeOrthogonal, `lineRoute.ts`, `routeGrid.ts`, `edgeGeometry.ts`), not stored.
- Layer X stores `nodes` and `edges` unchanged (`engine/layerx/sources.py:75-80`).
- feedtwin parses x/y (`pid/document.py:204-215`) and the handles (`:241-242`) but not waypoints.

**Feasible approach**: lay symbols at `position`, route edges orthogonally between symbol boxes, and colour each edge by its branch id. The network's branch ids are the edge ids, and node ids are `<symbol>.in/.out`, so per-step flows and pressures paint straight onto the drawing. The engine's two sides are a single ENGINE symbol; tell them apart by the line's source tank fluid.

### 9.10 Optimise, Trade study, Injector holes: removal and rebuild plan

Area: Optimise, Trade study, Injector holes: removal and rebuild plan.

**Auditor's summary.** Trade shares only the worker pool (engine/layerx/pool.py) with the uncertainty sweep. It does not share grade(): the sweep grades its own crossings. Trade does depend on optimize.grade/_figures/default_variables/OptimizeRequest, so removing both Trade and Optimise leaves those dead, and pool.py, patch.apply_design_patch, flight.config_dry_kg and measurements.Override stay in use. The current optimiser always answers with its bounds. The saved run 20261002-193854-00e811 ended at 600 psia and 4500 psig, both upper bounds, for +0.47 % impulse. Total impulse at a fixed load rises steadily with lockup. The user's goal (about 7.2 kN of near-constant thrust) is neither an objective nor a constraint. None of the variables is a hardware choice. The optimiser checks the tank-pressure cap at T-0 only, but the regulator's supply-pressure effect raises the tanks about 41 psi during the burn. Measured on the He hot-fire drawing: thrust is linear in lockup (~10.1 N/psi), and one secant step from two bracket burns hit 7200.03 N at 600.36 psia. O/F moved only -0.087 % over 578 to 625 psia, which confirms one regulator cannot set O/F. Thrust still climbs 6976 to 7424 N within the burn because the dome regulator's outlet rises with its supply-pressure effect (+47 psi modelled against +50.5 psi by hand). Recommendation: remove Trade and the current Optimise, keeping saved runs as read-only "legacy". Rebuild Optimize as a Set-point solver first: 3-5 burns, outputs dome dial and fill. Hardware mode (discrete parts emitted as a diff) comes second, and only once cited catalog data exists. Injector holes stays and emits the same diff format.

Evidence base. Read: `engine/layerx/{optimize,trade,pool,uncertainty,reconcile,patch,measurements,prepare}.py`, `backend/routers/layerx.py`, `frontend/src/components/layerx/{Optimise,Trade,Reconcile,ReconcileWrite,LayerX,runs,fields}.tsx/.ts`, `frontend/src/api/layerx.ts`, `frontend/src/lib/gating.test.ts`, `tests/test_layerx_{trade,phase4,reconcile,router}.py`, `docs/layer-x.md`, `docs/layer-x-critique.md`, `docs/layerx/GUI-SPEC.md`, `docs/integration/pid-to-feedtwin-handoff.md`, `lib/stardesign/stardesign/documents.py`, `lib/feedtwin/feedtwin/{session/burn.py,pid/network.py,comps/elements.py,model/components.toml}`, `feed-twin/backend/statemachines/diablo_actuators.csv`, the three shipped drawings, and every saved Layer X job in `EngineDesign/.userdata/local/engine/layerx/runs` (32 jobs). Experiments: scripts and JSON outputs in the scratchpad at `audit/optimise/` (`setpoint.py`, `spread.py`, `spread_dr.py`, `trim.py`). The fast tests in this area pass (16 passed: phase4 grading/impulse/bounds, reconcile Forward-mode and drills, router).

#### 1. What Trade shares, what survives, what dies

##### 1.1 Shared code
| Trade uses | Defined at | Also used by | After Trade is removed |
|---|---|---|---|
| `WorkerPool`, `default_workers` | `pool.py:36-123` | uncertainty `run_sweep` (`uncertainty.py:341,364`), optimiser (`optimize.py:295,330-331`) | **keep** |
| `pool.Cancelled` | `pool.py:16` | router `_execute` (`layerx.py:380`), reconcile (`reconcile.py:351`), optimiser | **keep** |
| `optimize.default_variables` | `optimize.py:100-135` | Trade `axes()` (`trade.py:74-76`), router `/optimize/variables` (`layerx.py:704`) | dead if Optimise also goes |
| `optimize._figures` | `optimize.py:171-199` | Trade `_trade_point` (`trade.py:219,231`), optimiser | dead if Optimise also goes |
| `optimize.grade`, `OptimizeRequest` | `optimize.py:228-280, 74-94` | Trade `run_trade` (`trade.py:261,286-296`), optimiser | dead if Optimise also goes |
| `patch.apply_design_patch` | `patch.py:11-25` | router `_config_and_runner` (`layerx.py:148,183`), `export-config`, `test_layerx_iterate.py:70-74`, the Injector check burn via `Settings.design_patch` | **keep** (fix its docstring: "and the trade study") |
| `flight.config_dry_kg` | `flight.py` | `prepare._vehicle_dry_kg` (`prepare.py:109-112`) | **keep** |
| `measurements.Override` | `measurements.py:44-89` | uncertainty, optimiser, router | **keep** |

**The uncertainty sweep does not use `grade()` or `_trade_point`.** It has its own `_burn_case` (`uncertainty.py:309-333`), `_metrics`, `SPARE_PSI = 100` (`:49`) and its own limit crossings (`:408-433`, stiffness floor falls back to 0.15 when the config has no band). The UI verdict grades the same limits a third time (`LayerXResult.tsx:160-190`, `VERDICT` in `format.ts:86-101`). So there are three gradings of one set of limits (bottle headroom 100 psi, ΔP/Pc floor, MAWP), and the rebuild should have one.

Dead code found in passing: `uncertainty._SEED` (`uncertainty.py:302`) is never read, and the `_init_worker` re-export (`:306`) has no importer.

##### 1.2 Dead once Trade is removed (list for the removal PR)
- **Engine:** `engine/layerx/trade.py` (whole file, 315 lines: `Axis`, `TradeRequest`, `axes`, `LIMITS`, `N_ONE/N_FIRST/N_SECOND`, `MAX_POINTS`, `validate`, `_check_axis`, `_point_inputs`, `_thin`, `_history`, `_trade_point`, `run_trade`). `_thin`/`_history` (per-point thinned thrust/Pc/O/F) and `sag_psi`, `throat_growth`, `liftoff_accel_g` exist only here.
- **Router** `backend/routers/layerx.py`: docstring lines 16-17; `TradeAxisBody`, `TradeBody`, `_trade_axes_view`, `POST /trade/axes`, `POST /trade` (`:734-792`).
- **API client** `frontend/src/api/layerx.ts`: `TradeAxis`, `TradeAxisSpec`, `TradeLimits`, `TradePoint`, `TradeResult` (`:569-613`); `'trade'` in `RunView.kind` and `TradeResult` in `RunView.result` (`:619,628`); `tradeAxes`, `startTrade` (`:884-887`). `TradePoint` borrows `OptEvaluation['figures']`/`['constraints']` (`:589-596`), so the Opt types die together with it.
- **Frontend:** `components/layerx/Trade.tsx` (480 lines). In `LayerX.tsx`: import (`:17`), `PAST_LABEL.trade` (`:310`), `'trade'` in the `mainView` union (`:425`), the `MODES` entry (`:706`), the render block (`:861-866`). Also `runs.ts KIND_WORD.trade` (`:36`). **`lib/gating.test.ts:69` (`'Trade.tsx'` in `NOT_EDITING`) must be removed in the same change**, because the "keeps every exemption pointing at a real file" test (`gating.test.ts:263-268`) fails on a stale entry. `fields.tsx` (`DraftNumber`) is used only by Optimise and Trade, and its gating entry (`:66`) names them both.
- **Persisted view state:** `useViewState` does not validate (`lib/viewState.ts`). A browser with `layerx.view = 'trade'` stored would render an empty main pane, so coerce unknown values to `'burn'` at `LayerX.tsx:425`. The `layerx.trade.form.v1` and `layerx.trade.open` keys become harmless leftovers.
- **Tests:** `tests/test_layerx_trade.py` (whole file); `test_layerx_router.py::test_a_trade_outside_its_window_is_refused_before_a_slot_is_taken` (`:116-138`).
- **Docs:** `docs/layer-x.md` step 11 (`:108-114`), "Past trade studies" (`:118`), the "Added: the trade study" line (`:713-716`). The `docs/layer-x-critique.md` rows C3, C4, C9, C23, C24, C29, V1, V2, V4, V15, V19 and V20 are a historical ledger: annotate them "retired", do not delete. `docs/layerx/GUI-SPEC.md:84` already lists only `[Burn | Injector | Optimize]`, so the new UI spec has already dropped Trade.

##### 1.3 How saved jobs are stored, and how to mark them legacy
Each finished job is written as `<runs>/<id>.json` (`job.view()`: id, kind, status, settings, result) plus `<runs>/_index/<id>.json` (the same without the result, plus a summary). An optional `<runs>/_meta/<id>.json` holds name, note and pin (`layerx.py:306-348, 1040-1056`). `_kind_of` reads the kind from the index, falling back to a regex on the file head (`:288-303`). Pruning is per kind and keeps the newest `KEEP_RUNS=25` unpinned (`:57, 338-348`). On disk today: **2 trade** (`20261002-093657-c71a29`, `20261002-095602-222024`), **1 optimize** (`20261002-193854-00e811`), 3 reconcile, 1 uncertainty and 25 runs/cancelled.

**Legacy without dropping:** add `LEGACY_KINDS = {"trade", "optimize"}` in the router. `list_runs` sets `entry["legacy"] = True` at read time, which needs no file rewrite and is reversible. Pruning is unaffected: pruning only fires when a new job of the same kind is persisted, and no new trade or optimize jobs can be made, so these are never pruned. `GET /runs/{id}` keeps returning the stored JSON, `export_eng` already refuses non-`run` kinds (`:1104`), and `DELETE` still works for the person. Frontend: widen `RunView.kind` to `string`, add `legacy?: boolean`, and list legacy jobs in one read-only "Retired studies" menu (summary plus download JSON) instead of the per-tab `PastRuns`. A one-shot sidecar migration (`"legacy": true` in `_index`, the way `list_runs` already backfills pre-index runs at `:1015-1028`) is possible but not needed.

#### 2. The current optimiser

**Algorithm** (`optimize.py:291-435`): a parallel compass search on [0,1]-scaled variables. The first step is 0.25 of the range, and the search stops below 1/32 or at the burn budget (default 40). Candidates are ranked by Deb's rules (`_rank`, `:283-285`). Each candidate is a whole burn on **one engine card centred on the middle of the lockup range**, with no erosion replay and no flight unless the objective is apogee (`_candidate`, `:154-168`; `:309-314`). The winner and the start point are re-burned with the replay (`_verify`, `:438-467`).

**Variables** (`default_variables`, `:100-135`):
- Lockup psia: from 0.85 × lockup (assumed) up to min(1.15 × lockup, `max_*_tank_pressure_psi`, tank MAWP over ambient).
- Fill psig: from 0.6 × the drawn bottle pressure (assumed) up to the drawn bottle pressure.
- Bottle volume: 0.5× to 2× the drawn volume, off by default.

**Constraints** (`grade`, `:228-280`):
- bottle at burnout − lockup ≥ 100 psi;
- min ΔP/Pc ≥ the band floor;
- optional O/F band, off by default (`of_band_rel=None`, `:84`; UI `ofBand:''`);
- apogee ceiling;
- depletion reached;
- no failed steps;
- preflight.

**Outputs:** best x, the dome, figures, the history and notes, including "finished on a bound: the answer is the bound's reason" (`:394-396`).

**Measured on the saved run `20261002-193854-00e811`** (GN2 drawing, objective impulse): 12 burns in 127 s. The best point is **600 psia / 4500 psig, both upper bounds**. Verified impulse is 24 101 → 24 215 N·s (**+0.47 %**), mean thrust 6740 → 6943 N, O/F 1.5153 → 1.5149. The only notes are the bound note. `tests/test_layerx_phase4.py::test_the_search_climbs_to_the_lockup_cap` asserts this bound-sitting as the expected result.

**Why the output is not actionable:**
1. **The answer is a bound, not an optimum.** Total impulse at a fixed load is monotone in lockup (Isp rises with Pc). The saved trade on lockup 491 → 600 psia ran impulse 23 512 → 24 193 N·s monotonically. A 40-burn search on a monotone 1-D objective returns the cap, so the ceiling's reason (`design_requirements.max_lox_tank_pressure_psi = 600` in `ethalox_6800N.yaml`) is the real answer.
2. **The goal is not in it.** The user wants near-constant thrust near 7.2 kN. There is no thrust target, no thrust-spread figure, and the O/F band is off by default.
3. **The variables are operating set-points, not hardware.** Bottle volume is a continuous litre count with no catalogue and a mass scaled by volume (`flight.py:165-174`, estimate). Valves, tubes, holes and orifices are not offered at all.
4. **"Use these settings" drops the bottle size.** It writes only `tank_pressure_psia` and `copv_pressure_psig` to the rail (`Optimise.tsx:312-317`); a searched `copv_volume_L` is shown and then discarded, with only a text note (`:100-102`).
5. **It is relative to the rail's start, not to the design.** There is no comparison with Forward mode's design point. The two "design O/F" references also disagree: optimise and trade use `optimal_of_ratio` = 1.5 (`optimize.py:316-317`, `trade.py:285`), while reconcile uses Forward mode's 1.523 (`reconcile.py:338-339`; saved reconcile `design.of = 1.5232`).
6. **The dome is shown but not as the operator's number.** The dome depends on fill through the regulator's supply-pressure effect. Measured on He at a fixed 600.36 psia lockup: 535.9 / 522.3 / 510.4 psig at a 4500 / 3700 / 3000 psig fill (ΔDome = 17 psi per 1000 psi, matching `supply_coefficient` on PR_D). The search result shows the dome only for its own fill.
7. **Constraints are incomplete.**
   - Chug is the ΔP/Pc proxy, because candidates run without the replay and so carry no `chug_margin_min` (`replay.py:218-224`).
   - Tank pressure is capped only at T-0 lockup (`optimize.py:105-115`), but the tanks climb ~41 psi during the burn (section 3.3).
   - Tank peak against MAWP/MEOP is graded only in the UI verdict (`LayerXResult.tsx:171-178`), and only against the drawing MAWP (1000 psi, "estimated").
8. **The saved runs are on GN2** (`copv_study_gn2`, the UI default). The hot-fire drawing is helium, and at the same lockup the two differ by 4.7 % in thrust (section 3.4).

#### 3. Physics checks (hand calc / library first, then the sim)

##### 3.1 O/F cannot be set by one regulator: confirmed
On the drawings, both tanks press from one dome regulator `PR_D` through one manifold `MF2` (`l_oxpress_in`, `l_fupress_in`; `copv_study_he.json`). `prepare.py:428-431` warns about this. Per side, p_tank − p_c = ṁ²·R_i/ρ_i, with R_i = 1/(2Cd_i²A_i²) + ΣK/(2A²). With a common p_tank, ṁ_O/ṁ_F = √((ρ_O/ρ_F)(R_F/R_O)), independent of lockup to first order. Only second-order effects move it: Cd(Re, L/d), friction(Re), per-tank sag, hydrostatic head, density.

Data:
- He, `ethalox_6800N.yaml`, pad, no replay: O/F **1.5212 / 1.5206 / 1.5199** at **578 / 600 / 625 psia** (−0.087 % for +8.1 % lockup).
- Saved trade, GN2, flown: 1.519 → 1.517 over 491 → 600 psia.
- Fill 3000–4500 psig: 1.5214 / 1.5206 / 1.5206.
- By contrast, hole size moves O/F **1.207 → 1.909** (saved trade `20261002-095602-222024`).
- The gas moves it slightly too: GN2 1.5153 against He 1.5206 at the same lockup.

So O/F is a hardware property (holes, line resistance, a trim) and can only be reported by a set-point solver.

##### 3.2 Thrust against lockup (He hot-fire drawing, `ethalox_6800N.yaml`, pad, no replay)
| lockup psia | dome psig | mean F N | F at T-0 | peak F | O/F | Pc psia | min ΔP/Pc LOX / fuel | bottle spare psi | wall s |
|---|---|---|---|---|---|---|---|---|---|
| 578 | 513.6 | 6972.4 | 6751 | 7194 | 1.5212 | 402.6 | 0.363 / 0.348 | 1068 | 50.1 |
| 600 | 535.6 | 7196.4 | 6972 | 7420 | 1.5206 | 414.2 | 0.372 / 0.357 | 946 | 48.0 |
| 625 | 560.6 | 7446.7 | 7219 | 7673 | 1.5199 | 427.2 | 0.383 / 0.368 | 809 | 50.8 |
| **600.358** (secant step 1) | 535.9 | **7200.03** | 6976 | 7424 | 1.5206 | 414.4 | 0.372 / 0.358 | 944 | 39.2 |

dF/dL = 10.18 N/psi (578–600) and 10.01 N/psi (600–625): linear. One secant step from (600, 625) landed within 0.0004 % of 7200 N. In every burn LOX ran dry first, with no failed steps and no card-outside steps.

##### 3.3 Why thrust is not constant: the regulator's supply-pressure effect
At 600.358 psia / 4500 psig, the regulator outlet goes 600.41 → 647.82 psia (**+47.4 psi**) while the bottle runs 4514.5 → 1544.4 psia. By hand, 17 psi/1000 psi × 2970 psi = **50.5 psi**; the remaining ~3 psi is flow droop. The tanks go LOX 600.40 → 641.84 and fuel 600.48 → 642.53 psia, and thrust goes 6976 → 7424 N (**+448 N, 6.2 % of the mean**). The dome loader `PR_C` has no supply coefficient on the drawing, so the dome is held constant.

Implications:
- "Constant thrust" is limited by this regulator, not by the set-point.
- The tank peak (642 psia) exceeds the config's 600 psi cap, which the optimiser only applied to T-0.
- The user's 750 psi ethanol MEOP is not exceeded: 642.5 psia is about 629 psi across the wall at the site ambient.

##### 3.4 Fill, margin and gas (all at 600.358 psia)
| case | dome psig | bottle end psia | spare psi | mean F N | thrust at end N | O/F |
|---|---|---|---|---|---|---|
| He 4500 psig | 535.9 | 1544.4 | +944 | 7200.0 | 7424 | 1.5206 |
| He 3700 psig | 522.3 | 877.5 | +277 | 7188.3 | 7395 | 1.5206 |
| He 3000 psig | 510.4 | 587.5 | **−12.8** (regulator drops out; tank → 582.8 psia) | 7136.7 | 6838 | 1.5214 |
| GN2 4500 psig | 535.9 | 1126.4 | +526 | **6861.0 (−4.7 %)** | 6994 | 1.5153 |

- Bottle pressure fell about the same in each He case (2970 / 2837 / 2427 psi). Lowering the fill therefore does not flatten thrust; it spends margin.
- The minimum He fill for 100 psi of spare is **≈3270 psig**, interpolated between the 3000 and 3700 burns and not burned itself.
- On GN2 the LOX tank does not follow the regulator: the outlet rises to 636.5 psia but the tank ends at 597.9 psia. The likely cause is press-path flow limitation, not verified. The set-point for 7.2 kN is therefore drawing-specific; on GN2 it is roughly 635 psia (estimated from the GN2 trade slope of 9.55 N/psi, not verified).

##### 3.5 Trim orifice arithmetic (`fluids` 1.3.0, CoolProp 7.2.0)
Inputs:
- LOX density 1150.5 kg/m³ at 90 K and 578 psia (CoolProp);
- line bore 10.92 mm (drawing `l_ox1`);
- LOX flow 1.856 kg/s, from the saved verify: 6740 N, impulse/propellant 2190 N·s/kg, O/F 1.5153.

Taking O/F from 1.5153 to 1.500 needs **4.0 psi of permanent loss**. ISO 5167-2 permanent loss with Reader-Harris/Gallagher C gives:
- trim bore **9.70 mm** (β = 0.888, C = 0.790, Re = 1.05e6);
- K = 0.165 referred to the line;
- **tap differential 23.7 psi against permanent loss 4.0 psi**;
- each ±0.05 mm drill step moves the trim by ±15 %.

The injector Cd scatter (±3 %) is about ±8 psi equivalent on a ~137 psi LOX injector drop, twice the trim. So a trim orifice cannot meaningfully balance LE4's ~1 % O/F offset until Cd is measured in a cold flow. feedtwin's `OrificeCd` and `OrificeISO5167` (`comps/elements.py:418-492`) price the meter's tap differential, not the permanent loss, so either would overstate a trim plate about 6× here.

##### 3.6 Fuel lead
Not modelled. The DAQ table opens Fuel Main and LOX Main together in `Fire` (`diablo_actuators.csv`), and `burn()` sets `session.state = fire_state` once at t = 0 (`session/burn.py:254-264`). There is no staggered open, no fuel-only chamber fill and no ignition transient. A "fuel lead timing" set-point cannot be solved for today; only the GUI spec mentions a "fuel lead" event (`GUI-SPEC.md:93`).

#### 4. Rebuild design

##### 4a. SET-POINT mode (Optimize → "Set point")
**Unknowns:** dome dial (equivalently lockup; `dome_for_lockup` is an exact affine two-point solve, `prepare.py:252-264`) and bottle fill. Fuel lead is excluded and stated as not modelled.

**Problems:**
- **P1, thrust target** (default): F̄(L) = F* with F̄ = impulse / burn time. Optional alternatives are thrust at a stated time, or the settled-mean. Monotone and linear (3.2), so use Illinois/secant with a bracket:
  1. two bracket burns in parallel on the `WorkerPool`, on one card centred on the bracket (`card_center_psia`);
  2. 1-2 secant burns;
  3. one verify burn with the replay (and the flight if the rail flies);
  4. if the replay offset moves F̄ beyond tolerance, one corrected burn, assuming a constant offset (the optimiser's own premise, `optimize.py:33-35`).

  That is **4-5 burns**. Each burn measured 39-54 s pad/no-replay (114 s under contention); the server's flown+replay runs took 40-66 s. Expect **≈3-5 min**.
- **P2, minimum fill with margin:** spare(fill) = margin. Monotone but not linear (dropout), so bracket it. The lockup root depends on fill (dropout, SPE), so alternate P1 and P2 (block Gauss-Seidel, 2 outer passes): **≈8-10 burns, ~8 min**.
- **P3, max impulse/apogee:** do not search impulse; report the cap and its reason. Apogee in fill at a fixed thrust target is a real 1-D trade (`layer-x.md:339-353`). Offer it only as P2 with an apogee objective.

**Report:**
- the dome dial at the planned fill (and its sensitivity: dome changes 17 psi per 1000 psi of fill error);
- lockup, mean / T-0 / min / max thrust (spread);
- O/F and its offset from a single stated design O/F;
- Pc, min ΔP/Pc, chug margin (replay), bottle spare, **tank peak against MAWP and against a stated MEOP**, burn time, residuals, apogee.

Grade with one shared function, replacing `optimize.grade`, the uncertainty crossings and the UI `VERDICT` duplicates.

##### 4b. HARDWARE mode (discrete)
| choice | in-process today? | how | standard data in repo | must come from |
|---|---|---|---|---|
| valve/solenoid Cv | yes | `Override(node:<SOL>, "Cv")` (`measurements.py:104-129`; the pattern `optimize.py:165-167` uses) | none; parts-hub seed ASCO 8210G094 has no Cv (`parts-hub/src/seed.ts:32`) | vendor datasheets, cited per row |
| tube OD/wall | yes (bore, wall_thickness, length, K_minor of existing edges) | `Override(edge:<id>, "bore")`; also update `feed_system.<side>.d_exit` (the exit-bore check, `prepare.py:365-392`) | pid-designer `TUBE_SIZES` OD×wall, bore by arithmetic, no standard cited (`pid-designer/.../catalog.ts:114-125`) | ASTM A269/A213 (material and tolerances) plus the vendor tubing data for the size and rating list |
| bottle | yes (volume, pressure, MAWP, wall_mass on KB1) | Override set, plus config `press_tank.dry_mass`/`free_volume_L` (flight mass) instead of scaling by volume | only the drawn SCBA 4.6871 L (measured); config says 4.619 L (−1.5 %) | vendor datasheets: volume, service pressure, mass |
| injector holes / angles / L/d | yes | `design_patch` (`patch.py:11-25`, bounds `layerx.py:128`) | number drills #40-#70 (`reconcile.py:42-48`), metric 0.05 mm step (`:50`, assumed) | the ASME B94.11M table (the test `test_drills_are_the_standard_sizes` re-types the same numbers, so it is circular) |
| trim orifice | **no** (Override cannot add an element: `_element` → "missing", `measurements.py:115-118`; no orifice symbol in `BRANCH_KINDS`, `pid/network.py:48-56`) | approximate today as `K_minor += K_trim` on an existing edge, with K from `fluids` permanent loss; properly as a new inline symbol mapped to a permanent-loss orifice model | none for 5-11 mm bores | letter/fractional/metric drill tables, cited |
| independent tank pressures | no (one PR_D feeds both tanks) | a drawing change | — | — |

**Search:** enumerate 2-3 catalogue neighbours per component around the set-point answer. Price engine-side pairs in Forward mode first, the way `reconcile.drill_grid` does in seconds. Burn the best N, each with the set-point re-solved (≈3 burns per candidate). Example budget: 3 candidates × 3 burns ≈ 9 burns ≈ 4 min on 3+ workers.

##### 4c. The DIFF
One record per change:
```
{target: "node:SV_LOX_PRESS" | "edge:l_ox1" | "design:injector.geometry.oxidizer.d_jet" | "op:dome_psig",
 label, component_type, parameter,
 before: {value, unit, source, reference}, after: {value, unit, source, reference},
 catalog: {vendor, part_number, datasheet} | drill: {"#53", d_mm, area_error},
 fabrication: "buy" | "re-drill larger" | "new plate" | "re-cut tube" | "re-set dome",
 cad_impact: "injector plate: 24 LOX holes 1.6318 -> 1.65 mm; passage 8.16 mm kept" }
```
Diff-level fields:
- `effects`: each graded figure before → after with Δ, limit and ok, from the **verifying burn of the picked parts**, not the continuous solve;
- an optional one-at-a-time `attribution` per change;
- `basis`: config_sha256, drawing id/sha/lineage, settings, code.

Domains are kept separate: drawing (hardware), design (engine), operation (dome/fill), model (fitted K0, which is not a part).

**Export to pid-designer** (never overwrite the source drawing; "You own the drawing. We own what it does", `pid-to-feedtwin-handoff.md`):
1. `POST /api/pid/diagrams/copy {owner, id, name}` (`documents.py:655-675`). The creator holds the checkout (`_create`, `:614-640`).
2. `POST /api/pid/diagrams/{new}/autosave` with the graph patched by `apply_overrides`, which already writes pid-designer's `{value, unit, source, reference}` shape (`measurements.py:125`). Requires the lock (`:851-881`).
3. Optionally `POST /{new}/release`.
4. Re-import the copy into Layer X (`pid_import`, `layerx.py:517-541`) and burn it, so the verifying run's drawing sha equals the diff's after-state.

Layer X today only GETs pid-designer (`_pid_get`, `layerx.py:474-487`), so it needs a POST helper that forwards `X-Auth-Email`.

**Engine side:** `updateConfig(partial, expect_sha256)`, refused if the design moved (`backend/routers/config.py:212-228`) and gated on checkout (the `ReconcileWrite.tsx` pattern). Pin the job the diff came from: the router claims the job a reconciled injector was written from is never pruned (`layerx.py:340-341`), but nothing pins it (`WriteReconciled` writes only `derived_from.run`).

#### 5. Recommendation
**Remove Trade and the current Optimise; rebuild Optimize as Set point, with Hardware mode as a second phase.**
- Trade's useful outputs (impulse, O/F and stiffness against one setting) are a subset of what the Set-point solve and the uncertainty tornado give. The new GUI spec has already dropped it.
- The current optimiser's only answer is its cap.
- Set point answers the operator's question ("which dome and fill for 7.2 kN, and what O/F and peak do I get"), with 4-5 verified burns.
- Hardware mode must wait for cited catalogue data, or it will invent Cv values, bottle masses and tube ratings (the feed-twin invented-numbers hazard).
- Keep `DraftNumber` (`fields.tsx`) for the new form.
- Keep the `_impulse_to_depletion` tests in `test_layerx_phase4.py:44-69`: they test `analysis.py`, not the optimiser. Move them before deleting the file.

**Injector holes in the diff format.** Saved reconcile `20261002-004821-687826` (GN2, in flight, 578 psia, target 6800 N / O/F 1.5) becomes:
- `design:injector.geometry.oxidizer.d_jet` 1.6318 → exact 1.6633 mm. Picks: #51 (1.7018 mm, +4.69 % area) or 1.65 mm (−1.59 %). Re-drill larger; L/d 5.000 → 4.905, passage 8.16 mm kept.
- `...fuel.d_jet` 1.4715 → 1.5112 mm. #53 (+0.007 % area).
- `model:feed_system.*.K0` (fitted; 1.1104 for LOX).

Effects must be those of the picked pair:
- **#51/#53 gives O/F 1.5501 (+3.3 %)** and 6902 N, against target 1.5;
- 1.65 mm / 1.50 mm gives 6758 N, O/F 1.4982, R 1.030 (band 0.95-1.05).

The reconcile result already carries most of this (`changes` `reconcile.py:265-284`, `design_update` `:287-300`, `drill_grid` `:250-262`, `config_sha256`). It lacks: a per-change effect, the verifying burn id, CAD impact, and the user's equal-momentum-ratio rule graded as a limit.

The holes are also sized for thrust at the T-0 lockup in Forward mode. Because of the regulator's supply-pressure effect, the burn mean comes out +0.9 % high (6861 against 6800 N in that run). The diff should target the burn figure the user grades on, or state which one it targets.

#### 6. Disagreements with the user's statements (reported, not fixed)
- `ethalox_6800N.yaml` has `design_requirements.target_thrust = 6500` N; the user's goal is 7.2 kN.
- The config caps tanks at 600 psi; the drawing tank MAWP is 1000 psi (estimated); the user states an ethanol MEOP of 750 psi. At the 7.2 kN He set-point the tanks peak at about 642 psia.
- The Layer X UI defaults to `copv_study_gn2`; the hot fire is on helium. The difference is −4.7 % thrust at the same lockup.
- Saved trade, optimise and reconcile jobs were made on three different design versions (config sha `ae3edfd7…`, `9fbffb66…`, while the file is `7782d2fd…`), so their numbers are not directly comparable with the experiments above.
- "Heavy fuel lead": not modelled anywhere (3.6).
