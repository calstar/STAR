# feed-twin changelog

The stand app. Versioned in `backend/version.py`; `/api/version` reports it with
the library version and the commit (and whether the tree was dirty). Physics
changes are logged in `lib/feedtwin/CHANGELOG.md`; this file is the app.

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
