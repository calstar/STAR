# What I changed, and what I did not

Companion to `01-first-impressions.md`. Everything here is verified: each fix has a
regression test that was checked to fail when the fix is reverted, and every suite was
run afterwards.

## Fixed

### 1. `POST /flush {}` destroyed a document — CRITICAL
`lib/stardesign/stardesign/documents.py`. The body is now an *override*: if it
resolves to the app's `empty_payload()`, flush falls back to the working copy on disk.
A flush that genuinely carries the final edit still wins, and deliberate emptying still
works through `autosave`. Shared router, so this protected **both** pid-designer and
EngineDesign. 3 tests in `pid-designer/tests/test_diagrams.py`.

### 2. The state machine failed open — HIGH
`feed-twin/backend/statemachine.py`. `can_go` now **fails closed**: a state whose row
could not be read refuses every non-abort transition. Aborts stay reachable by rule, so
nothing can strand the stand. Verified live — `Armed → Fire` went from ACCEPTED to
`refused: From here: Engine Abort, GSE Abort, Emergency Abort`. 3 tests.

**I did not repair the table.** I tried: the diagonal is 1 in all 10 well-formed rows,
so I solved for insertions satisfying diagonal = 1, GSE Abort = 1 and Emergency
Abort = 1. That leaves **17 to 37 candidate insertions per row** — not determined. A
guessed interlock in front of an operator is worse than a blocked one, so the 10 rows
are documented in `backend/statemachines/NEEDS-REPAIR.md` for repair from the DAQ
config, which is the only real source of truth. The affected states are dead ends until
then; that is deliberate and visible.

### 3. Gas valves could not choke — HIGH
`lib/feedtwin/feedtwin/comps/elements.py`. `Valve` gained `flow_ceiling()` and
`is_choked()` on the IEC 60534-2-1 gas model, with `xT` declared as a real parameter
(default 0.7, cited). The solver machinery for ceilings already existed and was
correct; nothing had ever reached it.

The coefficient is **calibrated from `fluids`, not transcribed** — my first attempt
paired the published `N6 = 27.3` with Cv and kPa and over-predicted by 10.5×, then a
Kv/Cv factor applied in the wrong direction left a clean 33.657% (= 1/0.865²) error.
It now agrees with `fluids.control_valve.size_control_valve_g` to **0.00000%** across
helium and nitrogen, 200–4500 psi, Cv 1.6–60 and two temperatures. Liquids still
return `None`. 11 tests.

**Honest scope:** on the stand I built this changes nothing, because the 3/8" line
resistance limits the flow below the valve's ceiling — which is physically right. It
matters when the valve is the restriction (a large vent valve on a short line, a relief
valve), and its real value is that the model can no longer run away.

### 4. The two apps disagreed about what a vent is — HIGH
This was the most interesting finding, and my first version of it was **wrong**. I
reported "pid-designer has no VENT symbol" from a case-sensitive grep. It does support
vents — by inference, deliberately, with tests. `components/pid/vents.ts`: *"A valve
open on one side is a vent to atmosphere. Not a symbol you place."*

The real defect is narrower and worse: that inference feeds the vent arrow and the
checks panel, **not the export**. So the drawing pid-designer *tells you to make* for a
vent arrived in feed-twin as a valve with a dead end behind it, and the network
**failed to validate at all**. Meanwhile feed-twin's own comment
(`pid/network.py:116`) describes the same problem and solves it with an explicit
symbol. Two correct answers, neither aware of the other.

`lib/feedtwin/feedtwin/pid/network.py` now reads the same rule: a valve
(`MAN`/`ROT`/`SOL`/`RV`) with exactly one port plumbed gets its free side pinned at
ambient, and says so in the run warnings. Narrow for pid-designer's stated reason — a
spare manifold port is a plug, and plugs are not drawn. 4 tests, including that a
plumbed valve and a spare manifold port are **not** vents.

### 5. Thrust imported without the intent fallback — MEDIUM-HIGH
`lib/feedtwin/feedtwin/engine/importer.py`. Thrust now resolves like O/F and Pc:
`design_requirements.target_thrust` wins over `chamber_geometry.design_thrust`, with a
provenance line that names the value it overrode. The shipped ethalox config now
imports as **7200 N**, not 7000. One existing test asserted `== 7000.0` — it encoded
the gap, and is updated with the reason. 3 tests.

### 6. `ENGINE_DESIGN_API_PORT` was a broken escape hatch — HIGH (blocked the whole run)
`EngineDesign/frontend/vite.config.ts` reads the env var; `__API_PORT__` is injected so
`App.tsx` and `ConfigurationSelector.tsx` name the port actually in use. Without this
the UI proxied to :8000 regardless — where, on this machine, an unrelated app was
answering and its 404s were being reported as EngineDesign's.

### 7. Artifact picker (from earlier in the session)
Import dates and a hover card, so seven identically-named "Ethalox Stand" entries are
tellable apart. Two of them have 14.7 psi tanks.

## Deliberately not fixed, and why

- **The 10 transition rows** — not recoverable; see above.
- **The Cd divergence between the apps (2× fuel flow)** — this is a *decision*, not a
  bug to patch: either feed-twin adopts EngineDesign's `use_geometry_cd = True`
  default, or EngineDesign stops rewriting on load. Both change numbers people have
  looked at. It needs your call, not mine at 3am.
- **`extra="ignore"` on the nested config models + 19 orphan keys** — the fix is
  `extra="forbid"` plus declaring the orphans, and it will make currently-loading
  configs fail. Correct, but it is a migration, not a patch.
- **No liquid evaporation in a cryogenic tank vent** — a real modelling gap, not a
  defect. Worth scoping properly.
- **`U_SLIP_CAP` and the other silent clamps** — should route through the existing
  `assume()` registry. Mechanical, but it touches the physics path and wants your eyes.

## Test state

| Suite | Result |
|---|---|
| feedtwin library | **553 passed** (was 535) |
| feed-twin API | **123 passed** (was 118) |
| pid-designer | **96 passed** (was 96) |
| EngineDesign | 568 passed, 4 failed, 81 skipped |

The 4 EngineDesign failures are **pre-existing** — confirmed by stashing my changes
(frontend-only in that repo) and re-running: they persist. They are
`test_assumptions_registry`, `test_flight_propellant_iteration`, `test_injector_parity`,
`test_propellant_presets`.

mypy and black clean on `lib/feedtwin` and `feed-twin/backend`. Nothing committed.

## Services left running

| App | API | UI |
|---|---|---|
| pid-designer | :8001 | :5174 |
| feed-twin | :8003 | :5177 |
| EngineDesign | **:8010** | **:5173** |

EngineDesign is on 8010 because **:8000 is your Conduit Tank app**
(`webapp.server --config configs/le4_floating_conduit.yaml`) — I left it alone. Thanks
to fix 6 that now works properly: `ENGINE_DESIGN_API_PORT=8010 ./dev.sh`. feed-twin was
started with `ENGINE_DESIGN_URL=http://127.0.0.1:8010` so the live engine pull works.

## What I built, for you to open

- EngineDesign design **"Ethalox 7200N Doublet"** — Layer 1 converged, 7200.0 N,
  O/F 1.67, Pc 423.5 psi, ṁ 3.109 kg/s.
- pid-designer diagram **"Ethalox Stand 7200N (Helium)"** — 24 symbols, 19 lines,
  helium pressurant, 3/8" NPT vent legs, the corrected 1/2" downstream geometry.
- Both pulled into feed-twin's library and building cleanly.
