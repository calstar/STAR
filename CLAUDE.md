# STAR monorepo — notes for agents

## Before you change physics, and after

**Run `python3 scripts/physics_benchmark.py`.** It checks the closed-form results in
`docs/PHYSICS-BENCHMARK.md` against hand calculation, `fluids`, CoolProp and the
handbook — not against this codebase — and exits non-zero when one moves.

Read `docs/PHYSICS-BENCHMARK.md` itself before a substantial change. It carries the
He/GN2 study expectations (too slow for the script), the venting and state-machine
checks, and a list of traps that have each cost a day.

The rule it opens with is the one that matters: **you cannot verify the sim with the
sim.** A run that converges, plots smoothly and violates no assertion is not evidence.

## The apps

| app | what it is | dev ports |
|---|---|---|
| `EngineDesign` | liquid engine design + optimizer (Layers 1–4) | API 8000, UI 5173 |
| `pid-designer` | the P&ID drawing tool | API 8001, UI 5174 |
| `feed-twin` | the feed-system digital twin / cockpit | API 8003, UI 5177 |
| `parts-hub` | CAD parts library + the "STAR Parts" insert panel in Onshape (Node/TS) | 8080 (`npm run mock`) |
| `daq-server` | the real stand's DAQ | — |
| `lib/feedtwin` | the physics library both EngineDesign and feed-twin import | — |
| `lib/stardesign` | the shared document store (checkout, versions, sharing) | — |

Ports are overridable — `ENGINE_DESIGN_API_PORT`, `PID_DESIGNER_API_PORT`,
`FEED_TWIN_API_PORT`. feed-twin finds its siblings through `ENGINE_DESIGN_URL` and
`PID_DESIGNER_URL`; if a source reports 404 check *what is actually answering on that
port* before concluding the endpoint is missing.

## Testing

```bash
scripts/check.sh          # every feed-system gate CI runs, fast tier (~3 min; -n auto with pytest-xdist)
scripts/check.sh full     # plus tests marked slow and the Layer X parity test
cd lib/feedtwin   && python3 -m pytest -q && python3 -m mypy feedtwin && python3 -m black --check feedtwin tests
cd feed-twin      && python3 -m pytest -q -m "not slow"     # drop -m for all 200+
cd pid-designer   && PYTHONPATH=../lib/stardesign python3 -m pytest tests/ -q
cd EngineDesign   && PYTHONPATH=../lib/stardesign python3 -m pytest tests/ -q   # 4 known failures
```

feed-twin installs `lib/stardesign` (`pip install -e ../lib/stardesign`; dev.sh
and setup.sh do it); pid-designer and EngineDesign still take it on
`PYTHONPATH`. Slow tests are listed in each `tests/conftest.py`; a test that
runs a whole burn goes there.

**A test that cannot fail is not a test.** Break the thing a new test guards and
confirm it goes red before you trust it. Several tests here have passed against the
very bugs they were written for.

## Conventions that are load-bearing

- **Every number describing hardware carries a provenance.** `Param(value, unit,
  source, reference)`. There is no default source — "nobody remembers where this came
  from" is the state the model layer exists to prevent. When a result looks wrong,
  read the provenance of the inputs before doubting the solver.
- **Correlations are adapted, not invented.** `feedtwin.comps.correlations` wraps
  `fluids`; if a number disagrees with the book, the fault is in an adapter. Constants
  that cannot be adapted are calibrated from the library at import and say so.
- **Named models over tuned coefficients.** Collapse, vapour and geometry are
  registries of named models, so a run report can print which assumption produced the
  answer.
- **Rebuild dataclasses with `replace`.** Constructing field-by-field silently drops
  anything added later; this has bitten `TankState` and `Setup` already.
- **New physics is opt-in and defaults to the previous behaviour**, exactly. Assert
  that it does -- and assert the second half too: turned *on* against a drawing that
  declares nothing for it, it must also change nothing. Gate on the model having
  something to do, not just on the flag. See `docs/PHYSICS-BENCHMARK.md` 2.5.
- **Price arriving gas by where it came from.** An ullage's inflow enthalpy is the
  walk's arrival at that node (`Session.arriving_enthalpy`), never "the bottle's" by
  assumption: two primed tanks trade grams through a shared press manifold every step,
  and pricing the other tank's 293 K gas at bottle enthalpy pumped a helium ullage 15
  psi above lockup with zero regulator flow. When a vessel warms with no net inflow,
  print each feeding branch and the enthalpy it is priced at.
- **Close stiff couplings by solving them, not relaxing them.** The chamber node is a
  boundary whose value depends on the flows it receives; a relaxed step per tick is a
  fixed-point iteration with multiplier `1 - w + w*g'`, `g' = -p_c/(2 dp_inj)`, and it
  diverged into a 718 psia / 0 flip-flop on a soft injector. `Session._close_chamber`
  brackets the root and solves it. When a coupled quantity oscillates frame to frame,
  compute the map's slope before tuning the factor.
- **The cockpit's thermal defaults are on** (vapour, wall-to-liquid 100 film / 3000
  nucleate below a 40 K Leidenfrost superheat, a 2 K boiling-onset superheat, a 1 cm
  stratified surface layer, an 8 W/(m²·K) air film in series with the drawing's
  `insulation_thickness`/`insulation_conductivity`, wall boiling). The library's
  `Setup` carries those same on-values; only the vessel-level `Tank` constructor
  defaults them off (collapse aside, which defaults to `ConductionCollapse`), and the
  benchmark study and Layer X turn them off themselves -- `burn_setup` drops stratification,
  boiling onset and nucleate boiling, and each caller passes collapse, vapour and
  chilldown off unless a case asks for one (the benchmark's collapse case;
  `backend/benchmark_study.py`, `engine/layerx/prepare.py`). The Study tab
  (`backend/study.py`) is not the benchmark: it burns the open stand at the
  cockpit's own settings, case by case. A shut LOX tank
  climbs at tens of psi a minute because its *surface* warms, not because the leak
  boils; a warm one runs away; the pad guide waits for chilldown. The shipped LOX tank
  wears an inch of fiberglass (operator). See `docs/PHYSICS-BENCHMARK.md` 3.8 and 3.11.
- **Every assumed number is a `Setup` field with a row in `backend/tunables.py`.** Do
  not add a module constant that describes physics or the stand; add a field, a
  `Tunable` with what it accounts for, and the Configuration tab shows it. The
  benchmark expectations are stated at the defaults.
- **The console runs the study's numerics.** `LIVE_STEP = 0.02 s`, 120 Newton
  iterations, no wall-clock budget: a panel tick is split into study-grid steps, and a
  stand too stiff for real time runs in slow motion (the top bar says the ratio). Do not
  reintroduce a budget that folds coupling steps -- it made the console integrate a
  different scheme from the one `docs/PHYSICS-BENCHMARK.md` checks. Vessels trip the
  stand above the MAWP their drawing declares (`Session._check_limits`). See 3.10.
  When it falls behind, time `Session.step` against the tick before blaming physics: the
  panel's pacing (period from tick *start*) once cost more than the solve. The cart is
  cheap on purpose (`Setup.ground_rests`, "Simplified GSE"): a cart vessel nothing flows
  through is not integrated, and while the engine burns the cart cut off from the vehicle
  leaves the solve -- the burn is bit-identical. See 3.10b.
- **One engine: EngineDesign's, as a card.** An engine in feed-twin's library carries
  EngineDesign's engine card (`POST /api/layerx/engine-card`, stored as the artifact's
  `card` attachment), and a card goes on an engine only through `EngineCard.install`, as
  Layer X does. Without one the cockpit fires feedtwin's simplified engine and says so
  (−5 % thrust, +10 % Isp on LE4). A pulled engine is a copy: `/api/library/{id}/freshness`
  says when EngineDesign has moved on. Compare the cockpit and Layer X only at the same T-0;
  `EngineDesign/tests/test_layerx_cockpit_parity.py` holds them together. Burns are totalled
  by `feedtwin.session.report`. See `docs/adr/0003-one-engine-one-burn.md`.
- **A fire is loaded with the engine's fire load**, the config's `lox_tank.mass` /
  `fuel_tank.mass` (fixed by the competition), not a fraction of the drawn tank:
  T-0 (`jump_to_t0`) and pad fills use `Session.fire_loads()`. A burn that runs long
  is first a question of what was loaded.
- **The supply-pressure effect is measured from zero inlet**: outlet = dome + bias
  - S x inlet (gauge), no datum, no setting (the team, 2026-10-07). A full 4,500 psig
  bottle holds a 1092-50 at dome 500 to 473.5 psig, not 550; never assume lockup =
  dome + bias. A drawn `inlet_reference` is ignored and warned. T-0 primes at the
  regulator's lockup off the vehicle's bottle. See `docs/PHYSICS-BENCHMARK.md` 4.11.
- **Pressures: absolute inside, gauge on the drawing, never ambiguous** (ADR 0004).
  A drawing's bare `psi` on an absolute pressure (tank, bottle, setpoint, dome, MAWP)
  reads as psig; `psia` says absolute; a chamber pressure on the ENGINE symbol is
  absolute. Differences (bias, droop, crack, relief set) take bare units only. The rule
  is `feedtwin.model.pressure.drawn_unit`; never add an atmosphere by hand to a drawn
  value -- `.si` is already absolute. Everything a person sets or reads is labelled
  psig (`run.psig`/`from_psig`).
- **Pages join at paired disconnects; controls reach the drawing through its hookup.**
  pid-designer's rocket and GSE pages are one network: a QD pair (`options.pairedWith`)
  is mated (`pid/network.py _mate_disconnects`), and a cart drawn on another page fills
  the vehicle through the network while the session's built-in fills stand aside. Which
  valve each state-machine actuator drives and which knob sets which regulator is the
  drawing's **hookup** (`feedtwin.session.hookup`), kept per drawing lineage. Saved
  from the P&ID tab it is *wired*: a DAQ box of named connectors (`channels`), and a
  table row drives only the valve on the connector of its name; the table itself can
  be the stand's own (`machine`, the State machine tab). With none saved it is
  `suggest()`, which is the old behaviour bit for bit.
  Never hard-code a valve or regulator tag; see `docs/integration/gse-pages-and-hookup.md`.
- **The drawing wires the twin** (ADR 0006). Vehicle vs ground support is
  `feedtwin.pid.roles` (the ENGINE's drawn-line component; a paired QD is the boundary).
  A cart TANK is a supply (pre-loaded, never tanker-loaded, its fed flight tank's load
  stands aside); a cart K-bottle arrives full; built-in charges and loads stand in only
  for what is *not* drawn. Every hand valve rests shut (unless drawn `normalPosition: open`)
  and is never bound to the table; MOVs are actuated. A liquid DEWAR is a supply tank;
  dome-line valves gate the dome (open to the loader: live; open vent: drained; else held). Lines on a regulator's
  `dome` handle are loading, not feed. Every hand-loaded regulator -- every cart regulator, and any
  regulator drawn with no setting -- gets a knob (`DOME`, `CHARGE` = `copv_target_psi`, or its
  own), and every knob starts at the drawing's setting (`hookup.knob_starts`); a fresh
  stand's dome and COPV fill are the drawing's unless the operator turned them. Before adding a hookup workaround (DAQ box, State machine tab, GSE Controls knobs), ask
  what the drawing should say instead. `Setup.ignore_gse` (off by default) cuts the cart
  away at assembly (`roles.vehicle_only`) and leaves only the built-in fills -- but
  **never the vents**: the cart's vent lines stay plugged into the rocket until launch
  (`roles.vent_branches`), so rocket only a tank still vents through the cart's vent
  valve. It is a build-time choice, so changing it opens a new stand.
- **Adiabatic is an assumption, not a fact.** Line walls (`feedtwin.comps.wall`) model
  the heat a tube and its fittings give the gas during a flow, which is worth ~50 psi
  of tank pressure late in a nitrogen burn. **On by default** in the library `Setup`,
  the cockpit and Layer X since 2026-10-03 (the team: fitting heat is on);
  `burn_setup` pins it off so the benchmark study is the scheme it was stated at.
  What is *not* modelled, on purpose, is
  soak: no heat transfer without flow, and no clock on how long a stand has sat. A
  wall starts at the temperature of the fluid its line holds at rest, which is where a
  soak model would land anyway.

- **A burn is a run record.** The cockpit records every burn at burnout
  (`feed-twin/backend/runs.py`): inputs, code version, stand version, outcome,
  solver summary. A new input that changes a burn belongs in `_inputs` or the
  diff and the Explain ladder cannot see it. Layer X should write the same
  record (ADR 0005).

## Docs worth knowing about

- `docs/PHYSICS-BENCHMARK.md` — the regression regimen. Start here.
- `docs/adr/` — 0004 pressure references, 0005 Layer X vs feed-twin (the Stand
  and the Run are what the two share).
- `feed-twin/docs/GETTING-STARTED.md`, `GLOSSARY.md` — for a new engineer.
- `docs/overnight/` — a full pipeline run as a user, the defects it found, and the
  Phase 14 thermal work.
- `docs/thermal/line-walls.md` — why the icicles on the fittings are evidence for the
  line's own thermal mass and against the room, with the arithmetic.
- `docs/integration/` — the cross-app agreements: line-loss method ladder, the
  pid-designer handoff, and `daq-k-fitting.md` for the K-fit reader that is meant to
  live inside the DAQ.
- `feed-twin/backend/statemachines/NEEDS-REPAIR.md` — the transition table's rows one
  cell short (9 in the twin's copy, 10 in the DAQ's), read left-aligned as the DAQ
  reads them; the Fire bypasses that opens, the abort rows that open the mains, and
  why an unreadable row still fails closed.
