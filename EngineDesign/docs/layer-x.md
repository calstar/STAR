# Layer X: the burn, solved whole

Layer X is EngineDesign's feed-system-aware layer. It replaces drawn pressure curves with
the feed system itself: the pressurant bottle, the regulators, the ullage, the lines and
the injector, integrated through the burn and closed against the chamber. It is both
a time-series analyser and an optimiser over the feed hardware, and it flies the burn it
computes (Phase 6).

It has its own tab and does not modify Layers 1–3. Layer 1 still sizes the engine at one
operating point. Layers 2 and 3 stay as they are until Layer X has been validated
against stand data. After that they can be retired.

## Why a separate layer

The tank pressure curve in EngineDesign has always been an *input*. The user draws
it in Time-Series, or Layer 2 searches over segment shapes. Under `dome_regulated` it is
a flat line. Nothing in EngineDesign computes it from hardware.

`lib/feedtwin` does compute it. It models the dome regulator with supply-pressure
effect, droop and lockup, a real-gas COPV with Joule–Thomson, ullage collapse, LOX
vapour and wall boiling, and line walls. Its chamber node is root-solved every coupling
step.

ADR-0001 put that physics in a library because EngineDesign would call it in-process.
Layer X is that caller.

## Ownership

| quantity | owner | why |
|---|---|---|
| Plumbing topology, line geometry, tank/COPV volumes, regulator model | the drawing (pid-designer) | ADR-0002: the drawing is the hardware record |
| Propellant load | the engine config (`lox_tank.mass`, `fuel_tank.mass`) | fixed by competition rule, not by a fill level |
| Injector and chamber physics (η_c\*, Cd, manifold, recession) | EngineDesign | it has the spray/mixing/manifold/ablative physics; the twin does not |
| Feed physics from bottle to injector inlet | feedtwin | it has the vessels, regulators, real gas and thermal models |
| Tank pressure | **an output** | set by the dome setting; it sags with supply-pressure effect and droop |

The interface is the **injector inlet node**, in **absolute pascals**. feed-twin's gauge
zero is 101 325 Pa, while the launch site sits at about 94 kPa. Layer X never passes a
gauge number across the boundary unless it has first converted it exactly with
`feedtwin.session.gauge`.

## Using Layer X

The rebuilt GUI is Layer X from 2026-10-03 (`?lx=1` opens the old one for one more release).
[`layerx/WALKTHROUGH.md`](layerx/WALKTHROUGH.md) takes a first run end to end; this is the short
version. Words in *italics* are what the screen says.

**Set up (the rail, left).** Design the engine first (Layers 1–3, Forward mode): Layer X burns the
design that is open, and a banner says when the design has changed since the burn. *Set up a burn*
then has three steps:

1. *Pick the drawing.* The default is `copv_study_he`, the helium hot-fire stand. *From
   pid-designer* or *Upload* brings in another; *Measured values* restates a drawn number you have
   measured (with its source and ±), for your burns only.
2. *Set tank pressure and bottle fill* (*Before firing*): the lockup (the dome dial that gives it is
   solved and shown under the field) and the bottle's fill. *Flight* and *Liftoff mass* fly it.
3. *Run* (`R`). The rail foot lists whatever blocks the run. Nitrogen over LOX is one: a red
   *Nitrogen over LOX* block gives the criterion (nitrogen condenses into LOX above ~52 psia at
   90 K, unmodelled) and offers *Use helium* or *Run anyway…*.

*Advanced* holds the model switches (chug feed basis, chug on the eroded engine, thrust from the
eroded nozzle, flight coupling, the start and gas-ingestion settings). Every one is off until turned
on, so a run is the default model unless the rail shows otherwise; a dot on the collapsed rail marks
a changed setting. The stage tracker reads Settle → Pass n → Checks: about 75 s on the pad and
2–3 minutes flown (LE4, helium).

**Read it (eight pages, one question each).**

| page | question | what it holds |
|---|---|---|
| Overview | Will it work? | the verdict line, five headline figures, the margin bars, the schematic and engine section |
| Feed | Where does the pressure go? | the pressure ladder from bottle to chamber, regulator, press solenoids, saturation, cavitation, water hammer, gas ingestion |
| Engine | What does the chamber see? | Pc, O/F, injector stiffness, chug margin on both feed bases, start and shutdown |
| Hardware | What does the burn do to the engine? | throat growth and contour, wall heat maps, insert back face and soak-back, separation, the Isp breakdown |
| Flight | How does it fly? | apogee, acceleration, static margin, max-Q, rail exit (Flight on) |
| Stand | What should the stand read, and did it? | *Print test card*; *Measured against predicted* from a DAQ export |
| Uncertainty | What don't we know, and does it matter? | the sweep of the unmeasured inputs |
| Record | Can I trust this run? | settings, every model and its source, conservation checks, the engine fit, events |

**The timeline**, docked under every page, is the burn's clock. One cursor moves every number,
chart, the schematic and the engine section. Drag it, or press Space to play; `[` and `]` step
between events (Fire, ignition, lowest chug margin, burnout, a vessel trip); `1`–`8` change page;
`?` lists the rest. The URL keeps the run, page, cursor and comparison.

**Margin bars** (Overview, *Limits*, worst first). One bar per graded limit, sorted by how close it
comes to its red line: the value against the limit, when it was worst (*at T+…*), and a track with
the red line, the amber band and the value. Click a bar and the cursor jumps to that moment and the
schematic rings the part; hover it for why the threshold is where it is. Limits from checks the team
has not reviewed yet (water hammer, saturation, cavitation, separation, regulator wide open, gas
ingestion, conservation) grade amber at most and say so. The graded chug margin is the whole-burn
minimum on the config basis, as before; the settled and drawing-basis figures sit beside it until
AUDIT D7 is decided.

**Tools** (top bar: *Burn | Injector | Optimize*).

- *Optimize*, **Set point** (*Find the set point*): a *Target mean thrust* and the *Bottle left at
  burnout*, with or without *Nozzle erosion in every burn*. It answers with the *Dome dial*, *Tank
  lockup* and *Bottle fill* in 4–6 burns (about 6 minutes on LE4), as a change list (component, P&ID
  node, before → after, effect on the figures, CAD impact) verified by one burn. *Put the settings on
  the rail*, then run the burn to see it whole.
- *Optimize*, **Hardware** (*Choose the hardware*): which parts may change (trim orifices, press
  solenoids, injector holes, from the catalogue) and one objective to rank them by; the winner's set
  point is solved again. A change pid-designer must draw comes out as a drawing to import there.
  Writing anything into the design is a separate step that asks for confirmation and a checkout, and
  is refused if the design has moved.
- *Injector* resizes the holes to the drawing's feed (the reconciler) and answers in the same change
  list.
- Old *Optimise* and *Trade study* runs stay listed, read-only, as legacy. Trade study is gone.

**Keep and hand on.** The run picker lists past burns (☆ pins one); *vs* ghosts another burn on
every chart (`C`). *Export* gives every signal (CSV or Parquet), the FEA bundle (Pc, thrust and heat
flux over x and t), the test card, and *Send to Forward & Flight*: Forward mode's burn view and the
Flight tab then read exactly the curve Layer X flew.

The vehicle flies at the design's airframe unless *Liftoff mass* is set (rail, under *Flight*):
the vehicle as weighed on the launch rail. The airframe takes up whatever the engine, tanks, propellant
and gas do not. The gas includes what the drawing's tanks hold at Fire (CoolProp at the twin's
pressure and gas temperature), which is ~0.5 kg on the stand drawing and was missing before.

Only one engine is used: EngineDesign's own, tabulated over the two line-exit pressures (the
"engine card"). The twin's native engine and the T-0 calibrated fit were steps on the way to it
(Phase 2, *Modes*); they stay in the API for the tests and are not in the UI.

## Phases

> **The numbers in these sections are as of the date in each heading**, from the code of that day.
> The physics has moved since (the throat history, the flight's mass, the feed fit, the time step),
> so read them for what each phase showed, and take today's numbers from a run.

### Phase 1: the twin runs inside EngineDesign (done 2026-09-30)

- **Library.** The fixed-step marching session moves out of the feed-twin app and into
  `lib/feedtwin` as `feedtwin.session`. This includes the session itself, model
  assembly, the DAQ state-machine reader, and the gauge helpers. The study's
  "T-0 → depletion" sequence becomes `feedtwin.session.burn` (`BurnPlan`,
  `prime_at_t0`, `burn`, `run_burn` → `BurnTrace`). The app re-exports everything it
  used to define, so every app import still works.
  - Acceptance: study traces are bit-identical before and after the move (GN2 as-built,
    GN2 with collapse, helium). The feed-twin suite and the library suite pass, and so
    do mypy strict and the physics benchmark.
- **Opt-in addition.** `Session.prime(loads=…)` primes by propellant mass. It defaults to
  the old fill-fraction behaviour exactly, and refuses a load that does not fit.
- **EngineDesign `engine/layerx/`:**
  - `sources`: drawings from the feed-twin set, pid-designer documents and uploads,
    content-hashed.
  - `link`: turns the live config into a twin engine, chamber-calibrated to EngineDesign
    at T-0.
  - `preflight`: checks the drawing against the config before anything runs.
  - `analysis`: runs the burn and reduces the trace to summary, events and provenance.
- **Backend.** `/api/layerx`: sources, preflight, runs (a background job with
  progress and cancel), result.
- **Frontend.** A **Layer X** tab with setup, preflight, run, and an analysis view
  (pressure ladder, flows and O/F, thrust/Isp, inventory, COPV, the T-0 cross-check
  against Forward mode, and provenance).

What Phase 1 deliberately does not do:
- The twin still runs its own injector legs, built from the config geometry with
  Reynolds-dependent Cd. Its chamber is calibrated to EngineDesign at one point,
  T-0: η_c\* and η_n are chosen so that the twin, given EngineDesign's flows, gives
  EngineDesign's Pc and thrust.
- Away from T-0, the efficiencies are held constant. The view shows the disagreement
  at T-0 between the twin's injector flows and EngineDesign's, so the gap is not
  hidden.

### Phase 2: engine card (done 2026-09-30)

The twin runs EngineDesign's engine at every coupling step of the burn.

**The boundary is the line exit.**
- The twin's lines end at the injector face node. They use the lumped K-factor
  convention, with no acceleration term and no exit loss.
- Everything downstream is the card's:
  - the Borda dump of the line's velocity head into the manifold (~24 psi LOX, ~15 psi
    fuel on the 6.8 kN engine);
  - the ring manifold and plate passages;
  - the spray, mixing and heat-loss η_c\*;
  - the stagnation loss and the nozzle.
- EngineDesign is sampled with its `feed_system` line losses zeroed and its exit dump kept
  (`engine/layerx/card.py: line_exit_config`). Its "tank" pressure is then exactly the line
  exit, and nothing is counted on both sides.

**What is tabulated** (`feedtwin.engine.card`, opt-in):
- **Injector, per side:** flow capacity ṁ/√Δp over (ṁ, inlet pressure). Δp = (ṁ/φ)² is
  exact at any flow.
- **Chamber:** c\*_eff = Pc·A_t/ṁ and v_vac = (F + Pₐ·Aₑ)/ṁ over (O/F, ṁ).
  EngineDesign's thrust is exactly linear in ambient pressure for a full-flowing nozzle
  (checked), so one card serves any ambient, including a climbing vehicle in phase 6.
- **Representation:** uniform grids, Catmull-Rom with linear ghost nodes, clamped outside.
  Each table carries the convex hull of its samples, and a step outside the hull is
  counted and reported.

**How it is built:**
- 21 × 13 line-pressure levels × fuel/LOX ratios around T-0, 273 solves on the numba
  chamber kernel.
- Thin-plate RBF fit, then resampled onto 41 × 41 (chamber) and 41 × 21 (injector)
  grids.
- About 1 s to sample and 3 s in all. Cached per config fingerprint, so a changed design
  gets a new card.

**Measured** (6.8 kN engine at 578 psia):

| Check | Pc | Thrust | Flow | Injector Δp |
|---|---|---|---|---|
| Held-out solves in the burn envelope (40) | 0.017 % | 0.021 % | 0.030 % | 1e-4 % |
| Card alone vs EngineDesign along a real burn | ≤ 0.007 % | | | |
| The twin's burn vs EngineDesign at its own inlet pressures | 0.073 % | 0.082 % | 0.07 % | |

The last row's extra comes from the twin's network solve. It stops at `LIVE_TOL = 1e-4`,
and below about that it does not converge (41 of 51 steps held at 3e-5). The chamber
closure is tightened to 0.02 psi through a new opt-in `Setup.chamber_tolerance_psi`; the
default is 0.5 psi, so the study traces stay bit-identical.

**Phase-2 tolerance: 0.2 %.** A card over it is flagged in preflight. A card built for
another engine fails its check (tested with a 3 % larger throat).

**Limit:** above O/F ≈ 1.9, EngineDesign's mixing efficiency falls in irregular steps:
- striated elements;
- stream tubes running past the c\* table.

No smooth table follows those to better than ~0.2 %. The whole-scan error is reported
(`box_*`, 0.22 % in Pc). A regulated burn stays near O/F 1.5.

**Findings:**
- **Phase 1 dropped the dump.** Its T-0 fit calibrated the twin's injector to
  EngineDesign's still-manifold drop, so the ~24 psi LOX dump sat on neither side. That
  read 3–4 % high on flow and thrust. Fixed: the T-0 fit now calibrates line exit to
  chamber.
- **Phase 1's feed-line comparison was wrong.** Its cross-check compared the twin's line
  exit against EngineDesign's still manifold. At the same station the drawing's lines and
  EngineDesign's `feed_system` K agree within 0.25 %.
- **Injector stiffness definition.** It is reported manifold to chamber, the dump excluded,
  as EngineDesign and the chug model define it.

**Modes:**
- `card` (default);
- `calibrated` (the phase-1 T-0 fit, now line-exit based);
- `native` (the twin's own engine).

The UI runs `card` only (2026-10-01): the other two were steps on the way to it and answered no
question a user has. They stay in the API for the tests. The Details section shows the card's fit and the engine checked
against EngineDesign at instants through the burn.

Phases 3 → 5 → 6 → 4 were built in that order. The optimiser came last on purpose: it is only
worth what it optimises over. It needed the eroding chamber (3), the inputs it cannot trust
(5) and the flight (6) before its answers meant anything.

### Phase 3: replay and agreement (done 2026-09-30)

The twin's burn is closed against EngineDesign's time-varying solve with the chamber eroding.
See `engine/layerx/replay.py`.

- **Replay.** At 28 instants through the twin's burn, EngineDesign's `evaluate_arrays_with_time`
  runs on the line-exit config at the line-exit pressures the twin delivered, with graphite
  throat and ablative liner recession on.
- **Feedback.** The replay's throat-area history goes back into the twin's chamber
  (`CardChamber.throat_area`, one step of lag) and the burn is run again. This repeats until the
  history moves less than 2e-4 between passes. It settles in two passes.
- **What is reported.** Thrust, Pc, flow and Isp are the replay's, interpolated onto the twin's
  firing steps (`result["delivered"]`). Burn time and propellant used are the twin's last pass.
  The run is handed to Forward mode and the Flight tab in the Time-Series shape ("Use in
  Forward & Flight").
- **Engine check along the burn.** The card's Pc and flow agree with the replay within 0.13 %.
  The card's *thrust* drifts to 0.7 % high by burnout. That is expected and is not an error
  in the headline. The card evaluates thrust at the as-built nozzle, while the replay's throat
  has grown 5.6 % in area, which lowers the expansion ratio. The delivered thrust is the
  replay's, so the headline includes that loss.

**Measured** (6.8 kN, 578 psia, GN2 stand drawing; tanks burnt dry, LOX first):
- 3.59 s, 24.09 kN·s delivered, 6713 N mean, 381 psia, Isp 223.7 s, O/F 1.516;
- throat +5.6 % in area (0.67 mm recession);
- about 20 s per run.

Before the 2026-10-01 review the same burn read 3.60 s and 24.17 kN·s. That figure ran one step
past depletion, counting that step's thrust on propellant the tank had already clamped to zero.
The figure in between, 23.87 kN·s, stopped at a 60 g threshold (see *Review, 2026-10-01*).

**Network tolerance.** Layer X now runs the network solve at 1e-6 with
`regulator_lockup_supply` on (`prepare.NETWORK_TOLERANCE`). A session working on the
convergence floor found and fixed two causes:
- a carded injector leg signed its reverse-flow drop twice;
- a regulator at lockup stepped by its supply effect at zero flow.

With both fixed, the solve converges at every step. Measured on this burn: +6.7 N·s (0.03 %)
and +5 s of wall time. The twin's own defaults are unchanged.

### Phase 4: the Layer X optimiser (done 2026-10-01)

`engine/layerx/optimize.py`, `POST /api/layerx/optimize`, the **Optimise hardware** view.

- **Variables.** Hardware a person sets or buys, each bound stated with its reason:
  - tank lockup: the dome is solved per candidate; bounded by `max_*_tank_pressure_psi` and the tank MAWPs;
  - COPV fill: bounded by the bottle's rated fill, since MAWP is a proof margin and not a fill;
  - COPV volume: off by default; the bottle's structure scales with its volume in the flight.
  
  The pressurant gas is the drawing's, so to compare GN2 against helium, run each drawing.
- **Objective.**
  - *Total impulse*: the burn's, the tanks burnt dry. It is the same number as a burn's headline.
  - *Apogee*: each candidate flown, with its acceleration fed back (phase 6).
- **Constraints**, over the whole burn:
  - the bottle at burnout above lockup by a stated headroom (100 psi by default);
  - each injector's lowest ΔP/Pc above the config's band floor;
  - optionally, an O/F band;
  - the apogee ceiling, when the config declares one;
  - everything preflight fails on.
- **Search.** A parallel compass search on [0, 1]-scaled variables, ranked feasible first, then
  least violation, then objective (Deb's rules, so there is no penalty weight to tune).
  Candidates burn on one engine card centred on the lockup range, without the replay, four
  at a time.
- **Verification.** The winner and the starting point are burned again with their own cards and
  the replay (and the flight for apogee). Those numbers are the answer.

**Finding: the step-summed impulse cannot be optimised.** The burn stops on a 50 ms step, so the
step in which a tank goes dry counts whole. As a design change slides the depletion across a
step, the total impulse jumps by up to a step's worth (~330 N·s at 6.7 kN). Neighbouring
lockups read ±150 N·s apart, against real differences of ~50 N·s. The first search chased
that noise to a "winner" that verified 1.1 % *worse* than its start. The fix is in the burn
itself: it ends on depletion, not on a step (`BurnPlan.end_on_depletion`), and burns the tanks
dry. See *Review, 2026-10-01*.
- An interim fix, *impulse to depletion* (`analysis._impulse_to_depletion`), extrapolated from
  the last full step instead.
- It is kept in the summary as a cross-check: it agrees with the simulated impulse within
  3 N·s.

**Measured** (6.8 kN, GN2 stand, lockup 491–600 psia, COPV 2700–4500 psig):
- Total impulse rises monotonically with lockup, about 16 N·s per 3 psi (higher Pc,
  higher Isp). The search ends on the 600 psia cap, about +0.45 % over 578 psia. The COPV fill
  barely matters on the pad.
- Apogee (each candidate flown, acceleration fed back), 21 burns in 6 minutes:
  - *the trade is real*: apogee rises as the COPV fill drops, because less gas is carried;
  - the 100 psi bottle-headroom constraint stops it;
  - lockup again goes to its 600 psia cap.
  
  Verified with the replay: **600 psia / 3150 psig flies 3120 m against 3071 m at
  578 psia / 4500 psig (+49 m, +160 ft)**, with the bottle 116 psi above lockup at burnout.
  *Re-run 2026-10-02 with today's code: 3158 m against 3125 m (+33 m), and the bottle ends
  97.6 psi above lockup (96.7 on the pad): this fill now fails its own 100 psi margin. Search
  again before filling to it.* The
  headroom margin is a stated assumption (`VERDICT.copvHeadroomPsi`, shared with the COPV
  verdict). The regulator model comes from one back-fit, so measure the dome regulator's
  supply effect before filling the bottle short.

A variable that finishes on its bound reports that the answer is the bound's reason, not an
optimum. The optimiser earns its keep where the trade is real, as with the COPV fill here: a
ceiling, an O/F band, a COPV volume with its mass, or a drawing whose regulator drops out.

**A second noise source, in the flight.** The first apogee search still ranked 578 psia above
586 psia, by tens of metres. The cause was the Flight tab's own sampling, described under
Phase 6. With that fixed, apogee follows impulse at ~0.2 m per N·s, and the search above is
smooth.

**Not done:** a robust mode that re-scores the optimum across the phase-5 scatter. Run the
uncertainty sweep at the chosen settings instead.

### Phase 5: measured inputs (done 2026-09-30)

- **Overrides** (`engine/layerx/measurements.py`). A drawing parameter is restated with a value,
  a provenance (measured, manufacturer or estimated), a source and an uncertainty. It is
  written into the drawing's JSON before the twin reads it, so the twin's own assembly report
  counts it. Overrides are stored per person and per drawing (by content hash), never in the
  drawing. The *Drawing parameters* panel lists every parameter with its basis (◇ assumed,
  ● measured).
- **Engine-side measurements** (cold-flow Cd, E_m, nozzle efficiency) stay in the config's
  `measurements` block. The engine card is built from the config with them applied.
- **Uncertainty sweep** (`engine/layerx/uncertainty.py`). Each unmeasured input is taken low and
  high, one at a time, on a spawn process pool seeded with the nominal card, and the band is
  their RSS. Factors:
  - regulator SPE and droop, ×0.5–1.5;
  - ullage collapse;
  - Cd ±3 %;
  - E_m 0.70/0.85;
  - nozzle efficiency ±0.02.
  
  A measured input uses its stated ±. The sweep runs on the pad, at one g.
- **Measured** (6.8 kN, GN2, after the review): mixing E_m 1820 N·s, nozzle efficiency 569, fuel
  Cd 220, LOX Cd 174, regulator supply effect 98, ullage collapse 2. Impulse ±1930 N·s (8.0 %),
  in ~1 minute.
  The measurement worth making first is a patternation E_m.
- **Not swept:** the regulator droop. The drawing marks it measured, with no ±, so it is held
  exact and the sweep says so.
- **Before the review**, the feed rows (droop 281, SPE 76) were mostly the 50 ms end-of-burn
  step. The sweep read the step-summed impulse, which jumps by ~330 N·s as the depletion
  crosses a step.
- **Not done:** fitting SPE and droop from an uploaded DAQ trace.

### Phase 6: flight (done 2026-10-01)

`engine/layerx/flight.py`, the **Fly it** toggle, the **Flight** section of a result.

- **Body acceleration in the library** (opt-in, default standard gravity, so it is
  bit-identical; study parity checked). `Setup.body_acceleration` multiplies every liquid
  column: tank heads (`Tank.outlet_pressure(state, gravity)`), line and manifold elevation
  (`FlowConditions.gravity`, `Network.gravity`). Hand checks: `tests/test_body_acceleration.py`.
  feed-twin's Configuration tab shows the row.
- **The coupling.**
  1. The burn on the pad settles its throat history; that is the ordinary result.
  2. It is flown in EngineDesign's flight simulation (RocketPy, `ui.flight_sim.setup_flight`):
     - the site's ambient is the thrust reference;
     - the pressurant mass is the twin's T-0 bottle;
     - the COPV structure scales with the drawing's bottle volume.
  3. The proper acceleration along the axis is read at every firing step and applied to the next
     burn step by step. It is computed as the specific force: net thrust at the vehicle's
     altitude plus the axial aerodynamic force, over mass. That is what an accelerometer reads.
  4. Steps 2 and 3 repeat until the acceleration moves less than 0.5 % and the throat history
     has settled. That takes two or three flown passes.
- **The lines are the drawing's, heights included.** The feed twin computes every loss from the
  drawing's lengths, bores and fittings, and a line's column under acceleration is its drawn (or
  restated) `elevation_change`. Layer X writes no geometry into the drawing. *Superseded
  2026-10-01:* this phase first estimated each drop from the config's tank positions, a template
  layout that put the fuel tank 2.52 m above the injector; the vehicle's real lines are 4.5 ft
  (fuel) and 1 ft (LOX).
- **The tanks are the drawing's.** These volumes are measured (LOX 15.10 L, fuel 8.67 L). The
  config's 6.44 / 6.20 L are sized to the load. Preflight already warns about the
  disagreement. The flight keeps the config's tanks for mass and inertia.

**Finding: the Flight tab flew a coarse copy of an untruncated curve.** RocketPy re-samples a
callable thrust source at 50 points over the burn (72 ms apart on 3.6 s). `setup_flight` sampled
the curve itself, at 500 per second, only when it truncated it. On the 6.8 kN vehicle, apogee
held still across 200 N·s of impulse and then dropped 116 m. `ui/flight_sim.py` now samples
every callable curve at 500 per second; the regression test is
`test_the_flight_follows_the_end_of_the_curve`. This moves Flight-tab apogees slightly.

**Finding: do not differentiate the trajectory at the cutoff.** Read from RocketPy's interpolated
inertial acceleration, the step at the thrust cutoff showed 14.8 g. Through the feedback, that
spike went into the burn's last step. The specific force has no such artifact. It agrees with
the derivative to 0.01 % through the burn.

**Finding (withdrawn 2026-10-01, it rested on the template layout's 2.52 m):** flight makes the
6.8 kN burn fuel-rich. The fuel tank sits above the LOX tank, so
the fuel line is 2.52 m tall and the LOX line 0.28 m. At 8.4 g at liftoff and 9.2 g at peak,
compared with the same burn on the pad (both with the replay):

| | pad, 1 g | in flight |
|---|---|---|
| fuel injector inlet, mean | 520.2 psia | 538.0 psia (+17.8) |
| LOX injector inlet, mean | 522.7 psia | 528.2 psia (+5.5) |
| O/F | 1.507 | 1.443 |
| burn time | 3.59 s | 3.47 s, fuel dry first |
| LOX left in the tank | none | 0.26 kg |
| total impulse | 24.15 kN·s | 23.61 kN·s (−2.2 %) |

Flown, it reaches **3071 m (10,076 ft)**, at 8.37 g at liftoff and 9.25 g at peak. The pad column
carries the vehicle's line heights, so it sits a little above a burn run without *Fly it*. The
loop settles in four passes, two on the pad for the throat and then two flown, in ~45 s.

An injector balanced for O/F 1.5 on the stand strands about 4 % of the LOX in flight. The
fuel-line height is an estimate from the config's vehicle layout. Measure it before acting
on this, and enter it as a restated `elevation_change` on the fuel line into the injector.

**Not modelled:** lateral acceleration and slosh; the change of ambient on the tank vents; a
flight-vehicle drawing (the stand's lines and fittings are flown).

### The feed at the injector (2026-10-01)

`engine/layerx/feedfit.py`, the *Feed at the injector* section of a burn. The design sizes the
injector (Layer 1, forward mode) at the tank pressure less `feed_system` K velocity heads per
side, plus the exit dump. The drawing disagrees in two places.

Measured on the 6.8 kN stand burn, settled steps:

| | LOX | Fuel |
|---|---|---|
| lockup | 578.1 psia | 578.1 psia |
| tank while firing (regulator droop, press line, SPE) | 564.5 (−13.6, worst −25) | 567.0 (−11.1, worst −25) |
| line loss, drawing / design | 17.7 / 15.8 psi (K 0.719 / 0.643) | 33.4 / 31.4 psi (K 2.149 / 2.019) |
| manifold, drawing / what the injector was sized for | 522.2 / 537.7 psia | 518.1 / 531.2 psia |
| **the injector sees** | **−15.5 psi** | **−13.1 psi** |

That is ~11 % of the injector's drop, and not the same on the two sides. The design at lockup
predicted 393.3 psia and O/F 1.523. Built and fed by this drawing, the engine runs 385.8 psia at
the as-built throat, O/F 1.513, and ~2 % less thrust.

**The fix: express both parts in the form Layer 1 already reads.**
- *Line K.* The drawing's lines, least squares over the burn. It is a velocity-head law, the
  lines' own form.
- *Supply K.* The burn-mean deficit below lockup, in the same velocity heads at the burn's mean
  flow. It is exact at that flow; 5 % off it moves it ~0.7 psi, so fit again after a resize.

`K0 = K_line + K_supply`, on the lumped path (the line-loss ladder's "measured K", here fitted
from the drawing), with a `derived_from` record of the drawing, the run and the flow. With the
fitted K0, EngineDesign's own forward solve at lockup lands on the twin's burn: flows within
1.5 %, O/F within 0.5 % (`tests/test_layerx_feedfit.py`). The numba kernel reads it and agrees
with the Python solve exactly. Layer X's own burns do not use the design's K0, so writing it in
does not move them (tested).

Why not one K from lockup? The supply deficit is not a velocity-head law; it dips at ignition
and recovers with the supply-pressure effect. A single K fitted from lockup scatters 28 % over
the burn. Split, the line term fits to its own form, and the supply term is stated as what it
is: a design-point mean.

### The injector reconciler (2026-10-01)

`engine/layerx/reconcile.py`, `POST /api/layerx/reconcile`, the *Reconcile injector* tab. The
question the feed fit leaves open is what the injector should be, given the drawing's feed. Layer 1
answers it by re-optimising everything; the reconciler holds what is built and moves only what the
plate's holes set.

- **Unknowns:** the two hole diameters; optionally the jet angles (whole degrees, included angle
  held). Each passage keeps its drilled length, so its L/d and Cd move with the diameter.
- **Targets:** thrust and O/F, by default the design point (Forward mode at the lockup through the
  design's own `feed_system`). Restoring both restores the flows, so Pc and Isp follow.
- **Not targeted:** the momentum-flux ratio R = (Cd_O/Cd_F) sqrt(dp_O/dp_F). At fixed flows
  through a fixed feed the two drops are set, and hole size cannot move them apart. It is reported
  against `impinging_momentum_R_min/max`.
- **Inner solve:** Newton on (ln d_O, ln d_F) in Forward mode through the fitted K0; three
  iterations.
- **Outer loop:** burn on the drawing, fit the feed, resize, burn again. The fit depends on the flow
  (the regulator droops more at higher flow), so it converges in two to three passes.

6.8 kN engine (`configs/ethalox_6800N.yaml`) on the GN2 stand drawing, on the pad, 578 psia:

| | Design | Current injector | Reconciled |
|---|---|---|---|
| Thrust, Forward mode | 6804 N | 6655 N | 6804 N |
| O/F | 1.523 | 1.513 | 1.523 |
| Pc | 393.2 psia | 385.7 psia | 393.2 psia |
| LOX / fuel ΔP/Pc | 36.5 / 35.0 % | 35.7 / 34.6 % | 32.3 / 31.5 % |
| Momentum ratio R | 1.030 | 1.024 | 1.022 |
| Spray tilt | +0.19° | −0.13° | −0.01° |
| Burn mean thrust (Layer X) | — | 6713 N | 6866 N |
| Holes LOX / fuel | 1.6318 / 1.4715 mm | same | 1.6819 / 1.5104 mm |

- Convergence: the manifold gap was −15.5 / −13.1 psi on pass 1, −0.6 / −0.5 on pass 2 and
  −0.01 / −0.01 on pass 3. 71 s in total.
- Total impulse is unchanged (24.09 kN·s), because the load is fixed: the reconciled burn is
  shorter and harder (3.51 s against 3.59 s).
- Both holes open, so the plate can be re-drilled: fuel to a #53 (+0.1 % area), LOX to a #51 or
  1.70 mm (+2.4 / +2.2 % area).
- The angles are unchanged: the tilt moved less than a whole degree could correct.
- Tests: `tests/test_layerx_reconcile.py`, including the orifice law (A_new/A_old =
  (Cd_old/Cd_new) sqrt(dp_old/dp_new) at restored flows) and the whole loop on the stand.

## Audit, 2026-10-01 (second pass)

Four parallel reviews (coupling code, missing physics, backend, UI). Each finding was reproduced
before it was fixed.

**Physics and coupling, fixed:**
- **Flight guessed line heights from the config and then rewrote the drawing.** The fuel line's
  drop (2.52 m, from a template vehicle layout) was put on a 5 cm valve outlet. The first attempt
  to fix it lengthened that line to carry the drop, which overrode the drawing's own geometry,
  the feed twin's to own. Both are gone. Flight applies the acceleration to the drawing as drawn;
  heights come only from the drawing or a restatement (`line_paths`, read-only), and the preflight
  warns when a side has none or a line falls further than it is drawn long. On the GN2 stand drawing
  (no heights drawn) the flown 6.8 kN burn is O/F 1.518, 24.09 kN·s, apogee 3151 m (10,336 ft):
  only the tanks' own liquid feels the acceleration until the vehicle's line heights are drawn.
  The vehicle's lines are 4.5 ft (fuel) and 1 ft (LOX) tank to injector (team, 2026-10-01); those
  lengths are now the design's `feed_system.length` (line inertance in the chug model: GM 1.479 →
  1.509, 36 → 32 Hz).
- **The chug margin over a burn used placeholder inputs.** The time-varying solve and the runner's
  array path dropped the closure's injector drops and SMDs, so the stability analysis fell back to
  0.30·Pc / 0.10·Pc and 80/60 µm. That gave GM 1.290 against forward mode's 1.479 at the same
  point. Fixed; `tests/test_time_varying_stability_inputs.py`.
- **The erosion replay started its walls one step late.** It now starts at Fire. Throat growth is
  4.05 % against 3.92 % before.
- **The first flight step burned at 1 g**, not the liftoff acceleration.
- **The feed fit used the LOX tank's T-0 pressure for both sides.** Each side now uses its own.
- **A failed replay read as "throat history still moved 0.000 %".** It is now named as a failure.

**Reconciler, fixed:**
- It is judged on the burn's own thrust early in the burn, not on a fitted manifold gap. From pass
  2 on, that gap compared consecutive fits and was ~0 whatever the holes did.
- Its result records the design it sized from, and the write is refused if the design has moved.

**Backend, fixed:**
- Jobs:
  - a cancel while queued, or one raised as InterruptedError, ends as cancelled;
  - a cancel arriving after the work finishes is honoured;
  - persist errors are caught.
- Run files:
  - pruning is per kind, so quick burns no longer delete a sweep or a search;
  - writes are atomic;
  - ids are UTC and validated.
- `.eng`: rejects non-finite samples and invalid dimensions; the filename carries the run id.
- Drawings:
  - malformed or empty uploads are refused;
  - an upload's measurements are keyed by its content, so two files with one name stop sharing them;
  - oversized uploads are refused before the body is read.
- Optimiser bounds and reconcile targets are validated finite and inside the setting limits.

**UI, fixed:**
- A past job picked from its study tab's list opens there, once.
- A stale sweep no longer shows under another burn.
- Feed-fit and reconcile writes are refused when the design has changed since the run.
- The stale banner diffs what would actually run, measured values included.
- Tiny parameter values show in significant figures instead of "0.0000".
- Signed line losses and growths no longer print as "−-".
- "flown" is shown only when the flight flew.
- Orphaned restatements are kept on save.
- Optimiser constraints show in % and ft.
- The run tracker shows passes.

**Physics not modelled, ranked by impact (for decisions, not fixed here):**
1. **Unusable propellant at pull-through.** Lubin–Springer h_c = 0.574(Q²/g)^0.2 ≈ 28 mm on the
   stand leaves 3–10 % of the load, depending on the tank head shape: −2 to −6 % impulse. Layer X
   burns the tanks dry (1 g). Needs each tank's head shape and outlet diameter, or a weighed residual
   after a cold-flow run to depletion.
2. **LOX tank wall cooling the pressurant.** Not surface condensation (grams): +7 to +60 % LOX-side
   gas use, depending on the upper-wall temperature at T-0. No thrust effect at a full bottle; it
   matters for a short fill. The preflight warning and an optimiser note now say this.
3. **Propellant temperature does not reach the engine card** (tabulated at the config's densities):
   O/F ±1–2 % over 90–100 K LOX.
4. **Start transient and shutdown tail:** −0.5 to −1.3 % impulse. Valve travel 50 ms, manifold fill
   ~20–25 ms.
5. **The regulator runs at twice its measured flow** (0.198 vs 0.0965 kg/s): the droop is
   extrapolated (±2 % thrust), and the sweep holds it exact because it is marked measured.

## Review, 2026-10-01

Three independent reviews (backend, library and router, frontend) and a walkthrough of the
whole pipeline as a user found these, all fixed:

**Numbers that were wrong**
- **The burn ended on a step, not on depletion.** Every end-of-burn quantity jumped by up to a
  step's worth as a design change slid the depletion across a step boundary: impulse ±330 N·s,
  the bottle at burnout ±34 psi. That is what the sweep ranked, what the headroom constraint
  read, and what the headline showed. The step also counted its full thrust on propellant the
  tank had clamped to zero.
  - Fix: `BurnPlan.end_on_depletion` (opt-in; the study keeps whole steps, bit-identical) cuts
    the last step to land on `dry_kg`. Layer X integrates each step at its own length.
  - Test: `test_ending_on_depletion_is_continuous_in_the_load`, checked to fail without it.
- **The hand-off dropped the first step.** Samples close their step, and every reader puts t = 0
  at the first sample. That cost 1.4 % of impulse in Forward, the Flight tab and Layer X's own
  flight. The payload now has a sample at Fire and ends at the depletion instant, which is
  exactly the curve Layer X flies.
- **The verified optimiser objective was the card's**, which carries the as-built nozzle. It is
  now the replay's.
- **There were two impulses.**
  - The burn stopped when the first tank was down to 60 g. That number came from the COPV study
    with no basis, so the headline was impulse to 60 g.
  - The optimiser used an extrapolation to empty, which reads ~220 N·s more.
  - Run to 1 g instead, the twin burns cleanly to the end: no failed steps, full thrust on the
    last step. Its impulse agrees with the extrapolation within 3 N·s.
  - So Layer X now burns the tanks dry and there is one total impulse.
  - What the vehicle cannot use (sump, outlet line, vortex pull-through) is a stated setting,
    *Unusable residual* (`LayerXSettings.dry_kg`). It defaults to 1 g, the solver's resolution,
    until someone measures it.
- **Provenance.**
  - The sweep varied a parameter the drawing itself marks measured.
  - Preflight fell back to an invented 500 psia lockup and a 4500 psig bottle; it now fails and
    says what is missing.
  - The uncertainty sweep assumed a nozzle efficiency of 0.95.
  - Pressures were read in the drawing's raw unit.
  - MAWP was held against the DAQ gauge zero instead of the site's atmosphere.

**Things that broke for a user**
- **Two requests at once could start two jobs.** The check is now atomic.
- **Finished jobs stayed in memory for ever, and cancelled ones were never saved.** Worker
  processes outlived a cancel; they are now terminated.
- **Blocking file work ran on the event loop.** Uploads and pid-designer responses are now
  size-capped, and ids are URL-quoted.
- **Results were not tied to the settings that produced them.**
  - A banner now says what changed since the burn on screen, with *Load this burn's settings*.
  - A sweep belongs to its burn and starts from that burn's settings.
  - *Use in Forward & Flight* refuses a burn made on another version of the design.
- **Polling lost runs after a backend restart**, and could overwrite the run being looked at. It
  now polls by id and reports a lost job.
- **The optimiser's inputs could not be typed into.** They now commit when you leave the
  field; validation errors read as sentences rather than "HTTP 422".
- **The optimiser's headroom (100 psi) and the COPV verdict (150 psi) disagreed.** Every
  verdict threshold is now a named constant whose hint states it.
- **Measurements disappeared whenever a drawing was edited.** They are now keyed by the
  drawing's lineage, and preflight warns when they come from an earlier revision.

**Open, for a decision**
- **The card's injector is tabulated at EngineDesign's propellant densities**, so a colder or
  warmer propellant in the twin does not change its drop. Preflight reports the gap (0.2 % LOX
  on this stand, so 0.1 % of flow).
- **Settings are per browser** (view state), not per design, so a teammate opening the same
  design sees their own rail.
- **The unusable residual is unmeasured.** It defaults to burning the tanks dry. A real
  vehicle traps some propellant in its sump and lines; weigh what is left after a stand
  firing and enter it.

## Review, 2026-10-02 (overnight)

Three independent reviews (physics against outside references, the engineer's workflow, code
correctness), then fixes. Checked and agreeing, on `ethalox_6800N.yaml` through `copv_study_gn2`:
mass closure (0.3 g LOX), pressurant closure (0.27 %), COPV end state against isentropic, the
first-step tank dip against isentropic ullage expansion, c* and chamber gamma against RocketCEA,
thrust by hand from Cf (0.02 % at three points), injector Cd against Lichtarowicz, line losses
against `fluids` (17.6 vs 17.8 psi LOX, 32.8 vs 33.4 fuel), liftoff acceleration against F/m, and
apogee against an independent 1-D integration (3152 vs 3150.6 m).

Fixed:

- **Flight mass.** The flight booked the config's tanks' ullage gas (58 g) where the drawing's
  tanks hold ~0.57 kg at Fire; the run now passes the twin's figure (apogee was ~27 m high).
- **Flight burn time.** The config's validator synced `thrust.burn_time` back to the design's
  3.99 s; the flight's is now set after construction.
- **Loops that reported "settled" on missing data.** A throat history with one NaN step dropped
  the whole history and read as zero change; it is now bridged, and a history that vanishes
  reads as unsettled. A flight that fails after an earlier one succeeded leaves the run
  unconverged (its burn carries the earlier flight's acceleration).
- **Time step.** A step that does not divide the 0.5 s lead-in straddled Fire and counted the
  first firing step short (−3 % impulse at 0.2 s); preflight now refuses it.
- **Flight failures** of any kind fail the flight, not the run; a finless rocket flies.
- **What-if burns** cannot be sent to Forward & Flight or have their K0 written into the design;
  *Use this burn's settings* no longer carries a what-if onto the rail. The Injector tab's check
  burns at the condition the holes were solved for, not the rail's current one.
- **.eng diameter** is capped at the airframe's (the 165 mm chamber does not fit a 157 mm mount),
  and the file says that the propellant's CG belongs to the tanks.

Added: the trade study (`engine/layerx/trade.py`, `POST /api/layerx/trade`), run comparison,
CSV export, every drill pair on the Injector tab as thrust against O/F (no standard pair lands
in ±2 % thrust and ±1 % O/F at the in-flight condition, so the pick is a trade), the optimiser's
tries against each variable, the uncertainty sweep's thrust envelope, apogee in the headline and
in Recent, field names in refused requests.

Open, not code:

- **Feed-line heights.** The stand drawing gives no line heights, so the flight carries only the
  tank heads (+0.3 % thrust pad to flight). The vehicle's 1.37 m fuel line at ~9 g would add
  ~14 psi at the fuel inlet: O/F about −3 %, depletion flips to fuel-first, impulse about −1.5 %.
  A vehicle drawing with heights fixes it; it is data, not code.
- **The flight flies the stand's feed system** (15.1 / 8.67 L tanks, the stand's lines) until a
  vehicle drawing exists.
- **Nozzle efficiency 0.95** has no provenance; an 80 % bell at ε 4.8 is typically 0.975–0.985
  (thrust and Isp +2.5–3.5 %, apogee +4–5 %).
- **Drag stack.** `rocket.rocket_length` is 6.43 m but the stack flown is 7.76 m (tank positions
  plus `avionics_payload_length_m`); the extra length is worth ~0.1 in Cd and −3 % apogee.
- **Pull-through residual.** Lubin–Springer puts ~0.18 kg of LOX below the vortex at 9 g;
  *Unusable propellant* defaults to burning dry (−1.5 to −2.7 % impulse if real).
- **Start transient** (ignition delay, manifold fill) is not modelled: −0.7 to −1.5 % impulse
  and a lower rail-exit speed.
- **Exit gamma** in the replay is the chamber's (1.136 vs CEA's 1.185 at the exit); the plume's
  jet diameter moves 0.2 %, its cell length 1.4 %. The chamber temperature shown is after the
  liner's heat loss (3201 K vs CEA's adiabatic 3224 K).

## Known limits that no phase removes by code alone

- **GN2 condensing on LOX above 492.5 psia.** This is not modelled. Every GN2 trace on
  the LOX side is optimistic (see `feed-twin/docs/copv-study.md`).
- **Regulator SPE and droop.** These come from one GN2 back-fit and the vendor sheet.
- **Ullage collapse.** The model is a stated lower bound.
- **Mixing efficiency.** The Rupe E_m spread alone is 6242–6601 N on the 6.5 kN engine.

The architecture can get the coupling right. Accuracy is set by the least-known input,
and only stand data tightens that.
