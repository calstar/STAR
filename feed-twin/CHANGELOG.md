# feed-twin changelog

The stand app. Versioned in `backend/version.py`; `/api/version` reports it with
the library version and the commit (and whether the tree was dirty). Physics
changes are logged in `lib/feedtwin/CHANGELOG.md`; this file is the app.

## Unreleased — 2026-10-10: the DAQ box and the State machine tab

The hookup, rebuilt the way the real DAQ declares a stand: valves and transducers
cabled to named connectors on the DAQ's boards, and a state table that opens names.

### Added
- **P&ID → DAQ box** (hookup method B): the six boards (Solenoids 12V/24V, Low/High
  press PT, RTDs, TCs) as GX12 connectors, five to a row, two rows to start and a
  "+ row". Drag an empty connector onto a symbol on the drawing to cable it (or click
  it, then the symbol), name it, drag a plugged one to move or swap it.
- **P&ID → Symbols** (method A) shows the same wiring per symbol: board and
  connector, the name, and for a valve the states that open it ("Opens in"). It
  replaces "Driven by", which showed a row name ("LOX Press") that read as a state.
  Switching between the two changes nothing; they edit one draft with the State
  machine tab and the knobs on GSE Controls (`lib/useHookup.tsx`), saved from any
  of them.
- **State machine** tab, after the DAQ's State tab: the states (name, place on the
  console grid, abort), what each state opens (a compact matrix: rows are the
  connectors' names), the allowed transitions, the twin's warnings, and the DAQ's
  CSVs to download or upload. States the twin keys on (Idle, Ready, Fire, Vent,
  Engine Abort, the fills) cannot be renamed or removed.
- The console shows what is wired, as the DAQ's dashboard does: a valve or
  transducer is on it only with a connector (gauges, tanks and the engine's channels
  as before). A drawing nobody has wired shows everything, as before.
- The console's state grid follows the table's own layout.
- API: `GET /api/hookup` returns the box (derived from the twin's matching until
  saved, at the DAQ's own connectors: `statemachines/diablo_channels.json`), `wired`,
  `boards`, `symbols`, `machine_shipped`, `machine_warnings`; `PUT` takes `channels`,
  `rows` and `machine` and refuses a cable on the wrong board; `POST /api/hookup/view`
  (a stand's own hookup, bound as it runs); `POST /api/statemachine/check`;
  `GET /api/session/{id}/statemachine`; `StateMachineOut.layout/aborts/table/edited`;
  `SessionOut.wired`; the session command `names` renames live.
- Runs record an edited table as `machine_table`; the Explain ladder swaps it with
  the hookup (a box's connector names are the table's rows), and a replay runs the
  table the run was recorded on.
- The stand says when a connector goes to a symbol the drawing no longer has (its
  row is matched by name instead). `HookupOut.builtin` / `StateMachineOut.builtin`
  name the rows the twin reads by name, so the editor does not call them unwired.
- `statemachines/diablo_states.csv`: the DAQ's panel layout and abort flags.

### Changed
- The **Hookup** tab is gone: which knob turns which regulator is edited at the foot
  of **GSE Controls**, under the dials it sets up (`components/KnobsEditor.tsx`;
  `/hookup` redirects there). The wiring is the P&ID's, the table the State
  machine tab's.
- A state-table row is an **actuator** everywhere, as the DAQ's own
  `state_machine_actuators.csv` has it ("Row" meant four things).
- State machine: three pages, **Opens · Transitions · States**, with the
  instructions in their hovers; its warnings grouped as the console's Notes group
  them (the seven "X → Fire" lines are one); actuators in Wired / Not wired /
  Built-in groups whose counts match the header; a connector shown as `S12·1 → OM-R`
  so the tag is not cut off; the console-grid preview leaves out Fire and the aborts,
  as the console does; **Upload CSVs** passes over the DAQ's delay table picked with
  the two state tables; Esc lets go of a pick; one Tab stop per matrix.
- P&ID side panel: one save bar at its foot for both tabs; a "Saved / Unsaved /
  Suggested" chip that follows the draft; **Unplug** on a Symbols card; one "Opens in"
  row in both tabs, whose **State machine →** opens the tab on that actuator
  (`/statemachine?actuator=`); the name hint only while a name is being changed;
  the DAQ box's not-wired list by page; Esc closes an open connector; grey GX12
  rings (green is open). The header is one line (instructions on hover).
- A suggested hookup can be saved from any tab ("Suggested · not saved"); Discard
  asks before dropping wiring; "Back to suggested" asks everywhere; a stand somebody
  else has is read only on every hookup page, knobs included.
- `POST /api/hookup/view?check=false` shows a hookup without refusing it, and
  `HookupOut.problems` says what a save would refuse; the panels load a stand's own
  hookup this way, and the save bar names a cable to a symbol the drawing lost.

### Fixed
- A stand whose hookup had a cable to a symbol a later drawing dropped could not be
  opened in the hookup panels (the view refused it), so the cable could not be
  unplugged.
- Back to suggested on a stand kept the unsaved edits on screen, and Save wrote them
  back.
- Operating a valve on the drawing cleared the Symbols search and filter and closed
  a card with an override half typed.
- Engine Abort's abort flag could be unticked, which silently refused ENG ABORT
  during Fire (the shipped Fire line does not list it).
- The twin's guess at a just-plugged connector's name outlived Save, and the Symbols
  panel cleared another connector's guess.
- An abort-flagged state not named "abort" got a plain console button.
- A connector selected in the DAQ box stayed ringed after switching to Symbols; a
  card opened from the list did not switch to its symbol's page.
- The hookup re-rendered the state-table matrix on every tick.
- The console says when every valve is hidden, and shows no empty plot with nothing to
  plot; its state-table note points at the State machine tab for an edited table.
- An unsaved hookup -- renamed transducers, wiring, the table -- was lost on any
  page reload (a refresh, a dev rebuild, the stand restarting), so names typed on the
  P&ID seemed never to reach the DAQ box. It is kept in the tab (sessionStorage, per
  drawing and stand) until saved or discarded, and comes back after a reload ("kept
  from before the reload"); a saved hookup that changed meanwhile wins.
- Rocket only kept nothing of the cart, vents included: a tank vented through a
  stand-in on its capped top disconnect. The cart's vent lines now stay
  (`roles.vent_branches`): they are plugged into the rocket until launch, so Fuel
  Vent drives the cart's FV-SOL rocket only as with the whole cart, and the wording
  on GSE Controls, Configuration and the P&ID says so. A vent drawn with its two
  halves unpaired (LE4's QD-OV-B / OV-QD-A) is reported, not guessed.
- A QD was offered as a DAQ box symbol, and the suggested box cabled the LOX vent row
  to the rocket's vent disconnect. No cable goes to a disconnect: it is not on the
  box, and a cable to one is refused. Rocket only, the vent row still reaches the
  capped QD as the cut cart's stand-in (the binding, not a connector).
- Nor is a QD operated: it is off the console's actuators and the drawing's
  clickable valves, has no console switch on the P&ID, and the valve command
  refuses it (409). Every QD was listed as an actuator, cart and rocket.
- `builtin` lists only the rows the stand acts on: not GSE High Press Control/Vent on
  a drawing whose cart charges the COPV (LE4; rocket only they are back), not Fuel
  Fill Press without a cart transfer tank (the shipped stand). A running stand's comes
  from its session.
- A stand whose own DAQ box has connectors a save would refuse (wrong board, a symbol
  the DAQ cannot read or drive) still opens on it, and now says so in its notes.
- The lost-connector note says what each connector now does: a valve's row is matched
  by name, a sensor is not shown until rewired.
- Explain: the group that swaps the drawing, the hookup and an edited table is
  "drawing & hookup" (was "drawing", which a table-only change is not).
- `/api/statemachine/check` gives each missing keyed state its own reason, and warns a
  table in which no state loads the LOX or fuel tank (Ox Fill, Fuel Fill renamed).

## Unreleased — 2026-10-09

The console, used end to end overnight. Pressures here in psia.

### Added
- The nav in three groups: Operate (Console, P&ID, GSE Controls, Plots), Results
  (Engine, Runs, Study, Solver), Set up (Library, Hookup, Configuration, Checks).
- **Solver**: a verdict in words, one residual monitor (each residual over its
  criterion, converged under the dashed line), the iteration log beside it, and
  iterations / mass balance / guard energy below.
- The pad guide is one line over the state grid, with the state to press ringed
  NEXT; during and after a burn it reads the burn (time, mean thrust, Isp, which tank
  ran dry) with Engine and Runs links. It leads out of an abort, and Auto never does.
- Runs: a "Ran on" column (drawing, engine, rocket only, simplified engine); a diff
  names knobs by the hookup's labels.
- GSE Controls: the dome knob shows the lockup a burn sweeps (LE4: 544.7 -> 599.7 psia,
  COPV full -> empty, at the dome the knob sets); the knobs' red arcs are the drawn
  MAWPs (were 4,514.7 and 964.7 psia whatever was drawn).
- Plots: state changes marked; Download CSV of the whole trace at full rate.
- Time warp x1 / x5 / x20 in the top bar; Fire is always x1.
- The stand says when a drawn tank cannot hold the engine's fire load, and where a
  cold vehicle tank's propellant goes when it is not the engine.
- `/api/hookup?ignore_gse`, `ModelView.drawn_knobs`, `TankOut.lockup_range_psi`,
  `mawp_psi`, `fire_load_kg`, `load_kg`; run summaries carry `diagram`, `engine`,
  `rocket_only`; history carries state `events`.

### Changed
- The console's bottom pad strip is gone (it repeated the state machine).
- The P&ID tab's symbol panel is the hookup, symbol by symbol: a console checkbox, a
  console name, and the actuator that drives each valve, saved from one bar (wiring
  restarts the stand); "Driving nothing" lists actuators no valve answers to. Its
  override form says what it still needs (a source, a reference) instead of a grey
  button. The Hookup page keeps the regulator knobs.
- Solver: four checks across the top -- Converged, Mass balance, Chamber, Clamps --
  PASS or FAIL, numbers on hover; "guards" are "clamps" on screen.
- The P&ID reads out transducers, gauges, vessels and the engine (temperature on RTDs
  and thermocouples), not every symbol.
- A transducer the drawing gives no limits for draws no limit lines (the tag guess put
  a 564.7 / 714.7 psia envelope on the dome line).
- Configuration: the dome and COPV charge default to the drawing's settings; a search
  box and a "changed only" filter.
- Study: no Fill column when the engine's fire load names every tank; the header says
  what T-0 loads.
- Engine tab plots fill the page; the state grid's labels fit a 1280 px window.

### Fixed
- Study cases burned 95 % of the drawn tanks (~8.9 kg LOX, 4.6 s) where the console's
  T-0 burns the fire load (6.75 kg, 3.5 s).
- The pad guide said loads had "slipped" after T-0 (it judged by 90 % of the tank).
- Settings were lost on a backend restart and reload; Runs' compare charts were empty
  (NaN from resampling); GSE Controls' readings never found their transducers;
  "N held" counted the crew's fill valve.

## Unreleased — 2026-10-08

### Added
- **Skip chilldown**: a LOX tank chilling during its load says `chilling · skip` on
  the console's tank card; skip puts the wall where the chill leaves it and the pour
  collects from then on (`skip_chill` on `/api/session/{id}/command`: `true` or a tank
  id). The chill takes ~5 min at the calibrated dewar valve, ~10 on the stand.

### Changed
- The compressible regulator seat is on and the dewar valve is Cv 0.019 by default
  (the library's changelog has the numbers).

### Fixed
- Fills on a stand with its cart drawn ran far below real time (0.34x in-process on
  LE4 (6)'s Ox Fill once the tank held its load): the vented boil-off and an unjoined
  regulator each asked for extra solves every step. 1.9x now; Fuel Fill 1.4x -> 3.0x.
  A topped LOX tank on its vent reads 3.1 psig, where it read 7.2 (the library's
  changelog and docs/PHYSICS-BENCHMARK.md 3.10c).
- A burn whose run record fails to save says so in the console's notes until a
  record lands; it was logged on the server and nowhere else.
- A drawing's saved hookup that cannot be read is said in the console's notes; the
  stand fell back to the suggested hookup exactly as if none had been saved. The
  session's own hookup notes reach the console too (they went only into run
  records).
- An engine card that is stored but cannot be read is reported as that
  (`why: card unreadable`), not as "no engine card is stored with it".
- A Study case that crashes logs its traceback on the server; the case still
  carries its type and message.

### Removed
- `POST /api/state` and `POST /api/fire`, the frozen-stand solves, with
  `backend/run.py` and the solve half of `backend/live.py` behind them, and the
  frontend's `goToState` / `fireStand`. Nothing called them: the console runs a
  session (`/api/session/{id}/command`). They held the tanks at dome + bias --
  LE4 (6) Fire read 416 psia / 7,251 N there -- and a held valve outlived a
  state change, both of which the session stopped doing. Their tests that
  checked the stand rather than the endpoint now run on a session from T-0
  (`tests/test_api.py`); the gauge helpers come from `feedtwin.session.gauge`.
- Compute-ahead-and-replay: `POST /api/session/{id}/precompute`, the
  `precompute` / `horizon` keys on `/command`, and `computing`, `progress` and
  `replaying` on the session frame (the top bar's "Running sim" and "Replaying").
  The console has integrated Fire live since 3.9; nothing asked for it.
- Routes nothing called: `POST /api/library/pull`,
  `GET /api/sources/{key}/documents/{doc_id}/releases` (the Library reads releases
  through `/documents?with_releases=true`), `DELETE /api/twin/runs/{id}`, and
  `POST /api/session/{id}/runs` with the frontend's `recordRuns` (a burn records
  at burnout; the run label it alone could set stays in the schema, empty).
- Fields nothing read. The history poll carried the whole model report, the
  stand's ids and a `frames` list that was always empty every 1.5 s; it is now
  the trace, its message and the O/F split. The model view's `controls` (the
  knobs of the fire runner above) and `fluid_sets`.
- `ActuatorOut`, `runs.thin`, `RunStore.delete`, the benchmark study's own
  `StudyRunner` and `StudyRequest.key` (its cache is long gone), `fmtAxisVal`,
  33 re-exports in `backend/session.py` nothing imported, and unused imports.

## 0.2.0 — 2026-10-06

### Added
- Engine page (replaces Mixture): the last burn totalled (impulse, mean thrust,
  burn time, chamber, O/F, Isp, minima at full flow, injector stiffness, tank
  pressures at Fire), thrust / O/F / flow traces, earlier burns, the O/F split.
  Console last-burn strip; "No engine on this stand" when none is linked.
- EngineDesign engine cards: an engine pulled from EngineDesign brings its card
  (`POST /api/layerx/engine-card` there) and the stand fires EngineDesign's
  engine. Library tags each engine `card` / `simplified`.
- Freshness: `/api/library/{id}/freshness`, `/refresh`, `/card`; the Engine page
  says when EngineDesign has moved on and pulls the current design in one click.
- Hookup tab and `/api/hookup`: pin actuators to valves, make knobs and put
  regulators on them; kept per drawing lineage. GSE Controls draws the knobs.
- Multi-page drawings (rocket + GSE pages) joined at paired disconnects.
- `/api/version` (app, library, commit, dirty, and what the model has been
  checked against); the chip on every screen says *Not validated against test
  data* until a stand trace has been compared.
- **Stands** (`/api/twin/stands`): the whole set-up as one shared, versioned
  document in the store pid-designer uses (lib/stardesign): owner, share list,
  checkout, microversions, named releases. The Stand bar opens, creates,
  shares and saves one; a session opened from a stand uses its settings,
  hookup and knob positions, without touching the drawing's own hookup.
- **Runs** (`/api/twin/runs`, Runs tab): every burn recorded at burnout with
  its inputs, code version, stand version, outcome, solver summary and traces.
  Two runs diff by input and outcome; **Explain** replays both from T-0 and
  swaps one input group at a time, reporting each group's share and the
  interaction (and how far each replay landed from its recorded burn).
  A run downloads as JSON.
- **Solver tab** (`/api/session/{id}/solver`): Newton residual, iterations,
  continuity, chamber closure, mass balance and guard energy per tick.
- **Jump to T-0** (top bar, `POST /api/session/{id}/t0`): tanks loaded, bottle
  at the COPV target, every tank at the lockup its regulator gives at the knobs
  as set, in Ready -- skip the pad and fire.
- The PC bar reads the live engine when the drawing has no chamber PT.
- The P&ID tab draws with pid-designer's own canvas (brought over from
  `feedtwin/pid-canvas`, 87d850fe): the drawing as saved, with the stand's
  pressures, valve states and flow on top.
- A stand opened on a drawing other than the one it was saved with uses that
  drawing's own hookup and says so, instead of refusing the session (the
  cockpit used to sit on the old drawing). The Stand bar names the drawing the
  cockpit is on.
- The Study fires the engine selected in the cockpit and says which (it took
  the newest import, silently); with none selected it refuses.
- The Solver tab's headline is unexplained mass (error less the vessels' booked
  corrections); Guards show their own ppm.
- Getting started and glossary (`docs/`).
- The Engine page's O/F split now comes from the cockpit session (it was only
  ever built for `/api/fire`; cockpit samples carried none).

### Changed
- Engine channels (PC, thrust, O/F, flows) are on the history; PC plots with
  the stand pressures.
- The test suite never talks to a running EngineDesign (`ENGINE_DESIGN_URL`
  pinned to a closed port in `tests/conftest.py`).
- The vite proxy honours `FEED_TWIN_API_PORT`.
- Every pressure a person reads is labelled psig, including the Hookup tab's
  "drawn at" (which was a psia number) and the chamber on the console.
- Test tiers: `pytest -m "not slow"` is the fast tier (`scripts/check.sh`).
- Installs `lib/stardesign` (dev.sh, setup.sh, Dockerfile.api, CI) and
  `lib/stardesign-ui` (vite alias, Dockerfile).

## 0.1.0

The cockpit, Study, Library and Configuration tabs as of 2026-10-05.
