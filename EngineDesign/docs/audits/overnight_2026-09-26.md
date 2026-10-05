# Overnight 2026-09-26: Layer 1, ethalox unlike doublet, 6.5 kN

## Update: the CAD design is the locked 6500N at Pc 375 (supersedes everything below)

`configs/ethalox_6500N_doublet_2026-09-26.yaml` is `ethalox_6500N.yaml` re-optimized on tonight's
physics. The locks:
- 5.000 in bore (0.5 in ablative + 0.25 in steel, 6.5 in OD);
- 24 doublets (15° indexing), whole-degree angles;
- L* 1.0 m;
- 1/2 in × 0.035 tube lines;
- Pc target 375 psia (from 430) to lower the tanks and the contraction ratio.

The pitch limit is 23.0 mm (24 doublets in 127 mm are 22.97 mm). Three seeds agree to 0.02 mm on
the throat. All three stopped 0.03–0.09° past the spray-tilt wall allowance. Layer 1 forgives
0.5° there; the audit does not. The fuel jet is therefore set to 41° instead of 40°, which puts
the tilt at 5.71° against 6.07°. 42° breaks a face limit.

| | |
|---|---|
| Thrust / Isp | 6501 N / 234.3 s |
| Pc / O/F | 377.7 psia / 1.515 |
| Tanks | 529 / 529 psi |
| Throat / bore / exit | 47.80 / 127.00 / 105.03 mm (1.882 / 5.000 / 4.135 in), ε 4.83, CR 7.06 |
| Chamber length | 148.3 mm (119.2 cyl + 29.1 conv) |
| LOX / fuel jets | 1.632 / 1.472 mm (0.0642 / 0.0579 in), 40° / 41° |
| Pitch circles LOX / fuel | 69.44 / 90.27 mm, impingement 6.10 mm |
| ΔP/Pc | 0.309 / 0.295; feed loss 35 / 40 psi |
| Momentum R / tilt | 1.025 / 5.71° (allowance 6.07°) |
| Chug GM / cavitation / recession | 2.14 / 2.5–2.7 / 2.2 of 12.7 mm |

Pc sweep on the same locks (one seed each), tanks ≈ 1.3 × Pc + 40:

| Pc psia | 430 | 400 | 370 | 340 | 310 |
|---|---|---|---|---|---|
| Tanks psi | 600 | 561 | 523 | 484 | 446 |
| Isp s | 238.2 | 236.1 | 233.6 | 230.9 | 227.9 |
| CR | 8.22 | 7.59 | 6.95 | 6.31 | 5.68 |
| Chamber length mm | 131 | 140 | 150 | 163 | 178 |

Hand-check: no flags. Audit: all gates pass at face value; the igniter port thread (13.56 mm
needed, 12.70 mm plate) still fails.

The manifold dump loss (K_exit = 1, one velocity head where each line empties into the manifold)
is new tonight. It explains ~180 N of the 200 N your file lost at its saved 584 psi tanks; injector
Cd 0.800 → 0.793 is the rest. With the dump loss off, the same engine needs 583 psi instead of 600,
at the same throat and jets within 0.01 mm. If your loss factors K0 0.643 / 2.019 already include
the manifold entry, set `feed_system.*.K_exit: 0`. No source for them was found.

## Where it stands

- **Layer 1 converges from a blank config.** Four seeds of a blank ethalox doublet at 6.5 kN end on
  the same engine: objective 196.689–196.696, Pc 383.1–383.5 psia, Isp 234.39–234.43 s. All
  gates pass at face value.
- **The physics under it was rebuilt and checked outside the code.** An independent hand-check
  (NASA CEA via rocketcea, Sutton and Huzel relations, none of the engine's own functions)
  agrees on every row within 0.5 %.
- **Blank-template candidate (superseded above):** with L* held at ≥ 1.0 m.
  Two seeds agree to 0.03 mm on the bore and 0.3 µm on the jets.
- **CAD caveat: the throat depends on the plumbing.** This design point uses the blank template's
  3/8 NPT feed (9.65 mm bore), which loses 102 psi on the LOX side. Vehicle lines with lower loss raise Pc
  and shrink the throat. The shipped config's stand lines give 433 psia. Fix the flight feed
  lines, re-run Layer 1 (~25 min), then cut metal. The injector plate drawing also carries four
  items (decisions 4–7).
- **Not settled on paper**, listed at the end: tank MAWP, pressurant, flight plumbing, fuel
  grade, the mixing-efficiency peak, Cd by cold flow, HF stability by test, igniter port.

## Convergence (blank ethalox doublet, 6500 N, O/F 1.5, 3.994 s)

Requirements typed into a blank design: thrust, O/F, burn time, tank caps 600 psi, chamber OD ≤
6.5 in, exit ≤ 8 in, face-to-exit ≤ 0.40 m. Everything else is the template's.

| seed | objective | Pc psia | Isp s | η_c* | L* m | CR | n | angles | LOX / fuel tank psi |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 196.690 | 383.5 | 234.43 | 0.9541 | 0.760 | 6.56 | 30 | 40/40 | 600 / 566 |
| 2 | 196.696 | 383.1 | 234.39 | 0.9541 | 0.760 | 6.55 | 30 | 40/40 | 600 / 565 |
| 3 | 196.689 | 383.3 | 234.40 | 0.9541 | 0.760 | 6.55 | 30 | 40/40 | 600 / 565 |
| 4 | 196.695 | 383.2 | 234.39 | 0.9541 | 0.760 | 6.55 | 30 | 40/40 | 600 / 565 |

How it gets there: the first global stage ends infeasible on every blank seed. It sits in
low-Pc, long engines, and the resultant-spray-tilt wall guard trips on most candidates. The
second stage's re-exploration and the cycle refreshes bring all four into one basin. Seed 3 took
until the third refresh (objective 4901 → 198.2 → 196.689).

The optimum sits on four bounds, and each one is a decision rather than a result:
- **L\* at its 0.76 m floor.** The spray march says ethanol is 99 % vaporized by the throat
  (95 % at 67 mm), so a longer chamber buys no Isp and costs mass. That rests on the Ingebo SMD
  correlation (95 µm fuel) being right. The CAD candidate holds L* ≥ 1.0 m, the lower end of the
  LOX/hydrocarbon handbook range, for margin against it.
- **30 doublets (the cap).** Smaller holes, finer spray. 60 holes of 1.3–1.5 mm is ordinary
  drilling.
- **40° per jet (the floor), 80° included.** Inside the usual 60–90° range.
- **LOX tank at the 600 psi cap.** More Pc is more Isp; the cap is the constraint.

## The design

| | |
|---|---|
| Thrust / Isp (94.1 kPa) | 6500 N / 234.7 s |
| Pc / O/F | 383.2 psia / 1.500 |
| mdot LOX / fuel | 1.694 / 1.130 kg/s |
| Tanks LOX / fuel | 600 / 565 psi |
| η_c* (vap × mix × HL) | 0.9551 (0.9978 × 0.9595 × 0.9976) |
| Throat dia | 47.41 mm |
| Chamber bore / CR | 134.40 mm / 8.03 |
| Exit dia / ε | 104.44 mm / 4.853 |
| L* / chamber length (cyl + conv) | 1.000 m / 134.0 mm (100.9 + 33.1) |
| Doublets | 30 |
| LOX jet dia / angle | 1.462 mm / 40° |
| Fuel jet dia / angle | 1.305 mm / 40° |
| Pitch circle LOX / fuel | 84.65 / 103.22 mm |
| Impingement standoff | 5.54 mm (3.78 d_O) |
| Injector ΔP/Pc LOX / fuel | 0.299 / 0.303 |
| Jet velocity LOX / fuel | 29.5 / 35.7 m/s |
| Cd LOX / fuel (predicted) | 0.793 / 0.792 |
| Rupe M / momentum R | 1.106 / 0.994 |
| Resultant spray tilt | 5.13° outward, allowance 5.75° |
| SMD LOX / fuel | 51 / 95 µm |
| Fuel 95 % vaporized | 67 mm from the face |
| Chug gain margin | 1.79 (5.1 dB) at 60 Hz |
| Cavitation margin LOX / fuel | 2.58 / 2.63 |
| Liner recession over the burn (peak) | 2.26 mm of 8.0 mm |
| Feed loss LOX / fuel | 102 / 66 psi (template 3/8 NPT) |

The L* 0.76 optimum is 0.26 s lower in Isp and 0.37 kg lighter. The contour DXF is in the Chamber
Geometry tab; the hole pattern is `python3 scripts/injector_layout.py <config>`.

Hand-check, `python3 scripts/design_handcheck.py <config>`:

Every compared row agrees within 0.3 %: CEA c*, Tc and γ; ṁ = Pc·At/c*; Cf with ζ_n on vacuum
Cf; F = Cf·Pc·At; CEA exit pressure; ṁ = Cd·A·√(2ρΔP) per stream; Rupe M; stay time. Bounds met:
pe/pa 1.00 (no separation), ΔP/Pc ≥ 0.15, jet velocities 10–60 m/s, 80° included, free jet 3.8 d,
CR 8.0, chamber Mach 0.077.

`python3 scripts/design_audit.py <config>` (every limit the config declares, no slack):

Every performance, geometry, stability and injector-face gate passes. It fails one layout check,
and the drawing adds warnings:
- **Igniter port (fail).** 1/2 NPT needs 13.56 mm of thread (ASME B1.20.1); the plate is 12.70 mm
  there.
- **Liner vs sleeve.** Bore 134.40 + 2 × 8.00 mm liner = 150.40 mm, against a 152.40 mm sleeve
  bore.
- **Hole L/d.** Holes break into a flat floor obliquely, so the short wall is L/d 3.6, under
  SP-8089's 4.
- **Manifold channels.** Their cross-sections are 0.43× (LOX) and 0.53× (fuel) the orifice area
  they feed.

## Sweeps

One seed each unless noted; blank template, same requirements as above.

| case | result |
|---|---|
| Shipped `ethalox_6500N.yaml`, re-optimised | Pc 432.9 psia, Isp 238.2 s, R 1.02. Invalid on one gate: pitch 22.97 > 22.5 mm (24 doublets frozen in a 127 mm bore; 25 would give 22.05 mm) |
| 6.5 kN, tank caps 500 psi | valid: Pc 299.8 psia, Isp 225.5 s (−8.9 s against 600 psi) |
| 6.5 kN, O/F 1.35 | **did not converge**: never left the infeasible region (7 doublets, pitch 41 mm) |
| 4 kN | Pc 432.7 psia, Isp 238.4 s; invalid: stability score 0.56 < 0.58 |
| 8 kN (8 in OD) | valid: Pc 337.9 psia, Isp 229.9 s, L* 0.76, CR 5.7 |
| 10 kN (8 in OD) | **no valid design**: 30 doublets (the cap) give a 25.9 mm pitch against 22.5 mm, and the engine is 402 mm against 400. The doublet cap and pitch limit conflict at this size |

The shipped config beats the blank design by 3.8 s, almost all of it feed loss (Pc 433 vs 383).
"Always converges" holds at the design point (4/4 seeds, 2/2 with L* ≥ 1.0 m) but not
everywhere yet:
- The first global stage lands infeasible on every blank run and relies on re-exploration to
  escape.
- At O/F 1.35 it never escaped.
- At 10 kN the requirements themselves conflict. Raise `layer1_impinging_n_doublets_max` or the
  pitch limit.

## What changed in the code

Physics (each change has a test that fails on the old code):
- **c\* efficiency** is now η_vap × η_mix × η_HL.
  - η_vap: a Priem–Heidmann spray march (Rosin–Rammler classes, heat-up then d²-law, drag).
  - η_mix: Rupe / Elverum–Morey M = ρ_O v_O² d_O / (ρ_F v_F² d_F), best at 1.0 for a 1-on-1 doublet.
  - η_HL: the enthalpy lost to the wall.

  The old kinetics and turbulence haircuts are gone. Both propellants' liquid properties now
  reach the march; it used to get RP-1 fallbacks for the fuel and treat LOX as vaporized at the
  face.
- **Nozzle:** Rayleigh stagnation loss P0 = Pc/κ and the CEA equilibrium exit state. ζ_n = 0.95
  on vacuum Cf stays a declared assumption (`chamber_geometry.nozzle_efficiency`).
- **Thermal:** Bartz on the drawn contour with CEA transport, Leckner/Hottel gas radiation, a
  char-surface energy balance, and graphite oxidation by H2O/CO2. The Huzel viscosity fit was
  being read as Pa·s when it returns lbm/(in·s).
- **Injector:**
  - manifold dump loss (K = 1 at the feed exit);
  - sharp-inlet Cd 0.80 with the Lichtarowicz L/d dependence;
  - the feed/orifice closure solved as a root per stream. The old relaxed loop stopped ~2e-6
    short and ran 150 iterations, with a warning each time, whenever a probed Pc sat above a
    tank (~12,000 lines per run).
- **Stability:** the chug gain margin now counts every Nyquist crossing. The acoustic gate is
  report-only (decision below).
- **Flight:** Mach-dependent drag build-up and ullage gas from the real ullage volume. The shipped
  vehicle reaches 3,449 m AGL (11,315 ft).
- **Time-series tab:** it overwrote the solver's η_c* with a constant 0.85.

Layer 1:
- **One objective.** Delivered Isp as the propellant needed beyond an ideal engine, plus chamber
  mass priced like propellant. A blank design had no performance term before, so every seed
  landed somewhere different.
- **Validation** runs at the design's own tank pressures: no boosts, no placeholders.
- **Sign-off** checks every declared limit at face value: pitch, L/D, length, free jet, face, and
  the R band.
- **Speed.** The numba chamber kernels still carry the old physics (0.9 % low on Pc, 1.8 % on η_c*),
  so they are switched off and Layer 1 runs the Python chamber solve. The two hot loops in it
  (spray march, area–Mach inversion) are now compiled, with identical results to 1e-12. That makes
  an evaluation ~8× cheaper. A blank run took ~25 min with four running at once; porting the kernels
  (~900 lines, parity at 1e-6) would bring it back to ~2 min.

The tool:
- **Parameters workspace** (Configuration tab, default view). Every config field by section, with
  unit, default, what you changed, search, inline edit and Apply. "In code" lists the 89 constants
  still in source: where each lives and whether it moves results.
- **Blank designs.** Switching to Doublet keeps the propellant, switching propellant sets its
  O/F, chamber gas comes from CEA at that O/F, and LOX properties come from CoolProp.
- **Header.** The propellant selector now follows a loaded design (it said Methalox on an ethalox
  design).
- `scripts/design_handcheck.py` (new), and `scripts/design_audit.py` now reads injector ΔP/Pc; it
  was reading tank-to-chamber, which includes the feed line.

## Decisions for you

1. **L\*: 1.0 m or 0.76 m.** The model says 0.76 is enough; 1.0 is the handbook floor and costs
   0.37 kg. The candidate uses 1.0.
2. **Flight feed lines.** They set the design point (above). At 1.7 kg/s, LOX in a 3/4 in line runs
   ~9 m/s against 20 m/s in the template's 3/8 NPT.
3. **Shipped 6500N.** Unfreeze the doublet count (≥ 25) or relax its 22.5 mm pitch limit; it fails
   nothing else.
4. **Igniter port.** A boss ≥ 13.6 mm, or a shorter-thread igniter.
5. **Liner.** 9 mm to fill the 152.4 mm sleeve bore, or keep the 1 mm gap as a bond line.
6. **Plate at the holes.** ≥ 14 mm, or a coned floor, for L/d ≥ 4 on the short wall.
7. **Manifold channels.** Wider; SP-8089 wants them as large as the plate allows. Confirm by cold
   flow.
8. **Acoustic gate.** It stays report-only because its inputs (damping, lag) are assumed. Gating
   on the worst phase would fail most designs on unmeasured numbers.

## Open: needs hardware or test

- **Tank MAWP.** The 2026-09-25 audit found the tanks at yield at 600 psi. The design rides the
  600 psi cap; the 500 psi row above shows the cost of lowering it.
- **Pressurant.** The GN2 load does not cover LOX-side collapse (audit).
- **Plumbing.** The blank template's feed is 3/8 NPT (9.65 mm bore): LOX at 20 m/s, ~100 psi lost before the
  injector, and a Joukowsky surge of 21 MPa on an instantaneous valve closure. The shipped config
  carries the stand's lines. Neither is the vehicle's.
- **Fuel grade.** Neat vs 75 % ethanol changes CEA, density and the whole design point.
- **Mixing efficiency.** `combustion.efficiency.Em_peak` 0.96 and its width are assumed; only
  hot-fire c* settles them. They are the largest single loss (η_mix 0.96).
- **Injector Cd.** 0.79 predicted; cold-flow the plate.
- **High-frequency stability** is not predictable from this model; rate it by test (bomb or pulse,
  ≥ 25 kHz Pc).
- **Igniter port.** 1/2 NPT needs 13.56 mm of thread; the template plate is 12.70 mm there.
- **Nozzle throat material** (audit).

## Tests

- EngineDesign `pytest tests/`: 1393 passed, 4 failed, 81 skipped.
  - Three failures are long-standing: anchor B, `test_forward_eval_dispatches_type_appropriate_physics`
    and `test_default_yaml_resolves_to_frozen_physics`.
  - The fourth is golden anchor A (ethalox pintle), moved by tonight's intended physics changes.
    Re-baseline it once you accept the new numbers.
- Parity (`ED_AB_PARITY=1`): 20 passed, 3 xfail (the raw chamber kernel, by design until ported).
- Frontend: tsc clean, vitest 50/50, build clean, lint clean on the touched files.
- `scripts/physics_benchmark.py`: all checks pass.
- Nothing is committed.

Follow-ups, in order:
1. **Blank search robustness.** Bound the doublet count from the pitch limit
   (n ≥ π·D_ring/pitch_max) and start the first global stage from a feasible point, so O/F 1.35
   converges.
2. **Port the chamber kernels** for speed.
3. **Re-baseline anchor A.**
4. **Legacy time-series path.** The non-coupled path (`runner.py` ~1030) still carries placeholders;
   nothing shipped reaches it.
