# 0001 — Feed system physics is a library, not a service

**Status:** Accepted · 2026-09-08
**Affects:** `lib/feedtwin`, `feed-twin`, `EngineDesign`, `pid-designer`

## Context

We are building a simulator for the whole propellant feed system — COPV through
regulator, tanks, lines and valves to the injector face — that predicts pressure
and temperature at every node, supports per-fitting parameterization, and can be
calibrated against test data. Three things about the situation shaped this
decision.

**There are two callers, not one.** The obvious caller is a web app: draw the
system, run it, watch the pressures. The second is EngineDesign's optimizer.
"Layer X" — a whole-vehicle optimization that is feed-system and structurally
aware — is an explicit long-term goal, and an optimizer evaluates thousands of
candidates per run. It cannot pay an HTTP round trip per candidate, and it
cannot depend on a service being up.

**The physics already exists in fragments, in the wrong places.** Feed pressure
loss lives in `EngineDesign/engine/pipeline/feed_loss.py` as a single lumped
loss coefficient. A COPV→regulator→tank chain lives in
`engine/control/robust_ddp/dynamics.py` as a controller plant model, with valve
areas hardcoded in the function body and initial conditions stored in Python
function attributes. Tank blowdown lives in `copv/blowdown_solver.py`. A
linearized feed impedance lives in `engine/pipeline/stability/chug.py`. Four
partial models of one system, none of which can be reused by the others.

**The drawing already exists too.** `pid-designer` holds the team's P&ID as a
typed node graph. Its component vocabulary is very nearly the set a network
solver needs. Whatever we build must be able to read it without either tool
depending on the other.

## Decision

**The physics ships as `lib/feedtwin`, a plain Python package with no web
framework in its dependency tree.** It sits beside `lib/stardesign` and is
installed from a path by everything that needs it.

**`feed-twin/` is a thin shell around it** — a FastAPI backend and a React
frontend, mirroring `pid-designer/`, owning HTTP, persistence and rendering and
no physics whatsoever.

Two supporting rules follow, and are enforced by tests rather than convention:

1. **No web framework may become reachable from `feedtwin`.** Checked in a
   subprocess in `lib/feedtwin/tests/test_package.py`; a Pydantic model that
   drags in Starlette is the realistic way this breaks.
2. **No `PropsSI`.** CoolProp's convenience API is ~1300× slower per call than a
   reused `AbstractState` on a tabular backend (184.5 µs vs 0.14 µs, measured).
   Enforced by `test_property_call_discipline.py`. This is a property-layer
   rule, but it is recorded here because it is the reason the property layer is
   Phase 01 rather than an implementation detail of Phase 03.

## Consequences

**Good.**

- EngineDesign's optimizer can `import feedtwin` directly when Layer X arrives,
  with no service dependency and no network cost — the thing this decision
  exists to protect.
- The physics can be tested, benchmarked and profiled with no web stack
  involved, which makes the validation gates in Stages A and B cheap to run.
- `EngineDesign/engine/pipeline/feed_loss.py` becomes a thin call into
  `feedtwin` once the steady solver lands (Phase 04), collapsing two parallel
  implementations into one. A cross-check test guards the transition.
- The P&ID reader can live in `feedtwin.io` and be used by both apps, without
  either app importing the other.

**Costs, accepted.**

- One more path-installed package to keep in step across `setup.sh`, `dev.sh`,
  three Dockerfiles and the CI workflows. This is the same tax `lib/stardesign`
  already pays and the tooling for it exists.
- Two places to look when a number is wrong: the library or the app. Mitigated
  by the boundary being sharp — if it is a number, it is the library.
- The API and the optimizer can drift onto different `feedtwin` versions if one
  is installed non-editable. `GET /api/version` reports the whole stack for
  exactly this reason, and every run will carry the same stamp.

## Alternatives considered

**A tab inside EngineDesign.** Cheapest to start — the physics API and the
engine solve are already there, and the `{config, ui}` design payload could
carry a scenario as another `ui` slice. Rejected because the schematic view
needs to be reusable by the DAQ GUI for live tests, and burying it in
EngineDesign's frontend puts it behind that app's build, auth and release
cadence. It also grows EngineDesign, which is already the largest subproject.

**A Simulate mode inside `pid-designer`.** Appealing because the drawing is
there. Rejected because that backend is ~300 lines of FastAPI with no physics
and no numerical dependencies; it would have to either import the physics —
forking the dependency graph into a second container that then needs CoolProp,
SciPy and a solver — or proxy everything to EngineDesign. The designer's job is
the drawing.

**A service the optimizer calls over HTTP.** Rejected on the numbers. Even at
1 ms per round trip, a 15,000-evaluation Layer-1-scale run spends 15 s purely on
transport, before any physics, and gains a hard runtime dependency on a
container being up. In-process import costs nothing and cannot fail that way.

**Physics inside the app, extracted later.** The usual advice, and usually
right. Rejected here because the second caller is known now, not hypothetical,
and because the extraction would have to happen exactly when the code is largest
and most entangled. The boundary is cheap to draw on day one and expensive on
day four hundred.
