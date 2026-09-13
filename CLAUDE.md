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
| `daq-server` | the real stand's DAQ | — |
| `lib/feedtwin` | the physics library both EngineDesign and feed-twin import | — |
| `lib/stardesign` | the shared document store (checkout, versions, sharing) | — |

Ports are overridable — `ENGINE_DESIGN_API_PORT`, `PID_DESIGNER_API_PORT`,
`FEED_TWIN_API_PORT`. feed-twin finds its siblings through `ENGINE_DESIGN_URL` and
`PID_DESIGNER_URL`; if a source reports 404 check *what is actually answering on that
port* before concluding the endpoint is missing.

## Testing

```bash
cd lib/feedtwin   && python3 -m pytest -q && python3 -m mypy feedtwin && python3 -m black --check feedtwin tests
cd feed-twin      && python3 -m pytest -q
cd pid-designer   && PYTHONPATH=../lib/stardesign python3 -m pytest tests/ -q
cd EngineDesign   && PYTHONPATH=../lib/stardesign python3 -m pytest tests/ -q   # 4 known failures
```

`lib/stardesign` is not installed; the two document-store apps need it on
`PYTHONPATH`.

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
  `insulation_thickness`/`insulation_conductivity`, wall boiling); the library's are
  off. A shut LOX tank climbs at tens of psi a minute because its *surface* warms, not
  because the leak boils; a warm one runs away; the pad guide waits for chilldown. The
  shipped LOX tank wears an inch of fiberglass (operator). See `docs/PHYSICS-BENCHMARK.md`
  3.8 and 3.11.
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
- **Adiabatic is an assumption, not a fact.** Line walls (`feedtwin.comps.wall`) model
  the heat a tube and its fittings give the gas during a flow, which is worth ~50 psi
  of tank pressure late in a nitrogen burn. What is *not* modelled, on purpose, is
  soak: no heat transfer without flow, and no clock on how long a stand has sat. A
  wall starts at the temperature of the fluid its line holds at rest, which is where a
  soak model would land anyway.

## Docs worth knowing about

- `docs/PHYSICS-BENCHMARK.md` — the regression regimen. Start here.
- `docs/overnight/` — a full pipeline run as a user, the defects it found, and the
  Phase 14 thermal work.
- `docs/thermal/line-walls.md` — why the icicles on the fittings are evidence for the
  line's own thermal mass and against the room, with the arithmetic.
- `docs/integration/` — the cross-app agreements: line-loss method ladder, the
  pid-designer handoff, and `daq-k-fitting.md` for the K-fit reader that is meant to
  live inside the DAQ.
- `feed-twin/backend/statemachines/NEEDS-REPAIR.md` — 10 malformed rows in the shipped
  transition table, why they are not recoverable, and why the machine fails closed.
