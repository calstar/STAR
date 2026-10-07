# feed-twin changelog

The stand app. Versioned in `backend/version.py`; `/api/version` reports it with
the library version and the commit (and whether the tree was dirty). Physics
changes are logged in `lib/feedtwin/CHANGELOG.md`; this file is the app.

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
