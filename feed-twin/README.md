# feed-twin

A simulator for the whole propellant feed system — COPV through regulator,
tanks, lines, valves and injector to the chamber. It predicts pressure and
temperature at every node, takes real hardware parameters down to individual
fittings, and is designed so the same schematic can display simulated physics,
replayed test data, or a live DAQ stream.

## Status

The stand runs: real-gas vessels and lines, regulators, the state machine, the
engine (EngineDesign's card, or the twin's simplified one), live in a cockpit
laid out like the DAQ. Stands are shared, versioned documents; every burn is
recorded with what it ran on, and two runs can be diffed and their difference
attributed to inputs (Runs tab). The solver's residuals and the mass balance
are on their own tab.

**Not validated against test data.** The physics is checked against outside
references (`scripts/physics_benchmark.py`, `docs/PHYSICS-BENCHMARK.md`) and
Layer X, but not yet against the stand's own DAQ traces.

New here: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md), then the
[glossary](docs/GLOSSARY.md).

## Architecture

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Frontend  (React + Vite)     │  HTTP  │ Backend  (FastAPI, :8003)    │
│  :5177                       │ ─────▶ │  /api/health · /api/version  │
└──────────────────────────────┘        └───────────────┬──────────────┘
                                                        │ import
                                        ┌───────────────▼──────────────┐
                                        │ lib/feedtwin                 │
                                        │  the physics core            │
                                        │  CoolProp · fluids · ht      │
                                        └──────────────────────────────┘
```

The physics is a **library, not a service** — see
[ADR-0001](../docs/adr/0001-feed-system-physics-is-a-library.md). This app is a
shell around it, and so is EngineDesign's optimizer when Layer X arrives. That
is the decision the whole project is built on: an optimizer evaluating thousands
of candidates cannot pay an HTTP round trip per candidate.

Everything numeric lives in [`lib/feedtwin`](../lib/feedtwin/). If it is a
pressure, a flow rate or a coefficient, it does not belong in this directory.

## Quick start

Prerequisites: Python 3.11+, Node 20+.

```bash
bash feed-twin/setup.sh
```

Then:

```bash
cd feed-twin && ./dev.sh
```

- Backend (FastAPI) → http://localhost:8003 (docs at `/docs`)
- Frontend (Vite) → http://localhost:5177

`./dev.sh --help` for the flags; same interface as every STAR project.

Check the physics core is wired up:

```bash
curl -s localhost:8003/api/version
```

## Ports

| | dev | container |
|---|---|---|
| API | 8003 | 8003 |
| Frontend | 5177 | 4178 |

## Tests

```bash
cd feed-twin && pytest -q                     # the app
python -m pytest lib/feedtwin/tests -q        # the physics core
```

CI runs five jobs (`.github/workflows/feed-twin-ci.yml`):

| Job | What it proves |
|---|---|
| Physics core | black, `mypy --strict`, pytest — including the `PropsSI` ban and that no web framework is reachable from the library |
| Backend | black, `mypy --strict`, imports and tests in the *app's* environment |
| Coexists with EngineDesign | `lib/feedtwin` installs alongside EngineDesign's dependency set and both import in one process — the other half of Phase 00's exit criterion, checked before Phase 04 relies on it |
| Frontend | `tsc -b && vite build` |
| Docker images | Both build against the current tree |

## Not here yet

Deliberate omissions, each with a phase attached, so their absence reads as a
decision rather than an oversight:

| Missing | Arrives | Why not now |
|---|---|---|
| `lib/stardesign` wiring | Phase 09 | Scenarios become shared documents then; wiring the store in before there is anything to store is dead code. |
| Caddy route, compose service | Phase 09 | Nothing worth deploying yet. |
| `lib/feed-canvas` | Phase 10 | The P&ID page already draws with pid-designer's own canvas (`DrawingView`, through the `@pid` alias in `vite.config.ts`); moving it to a shared library, so the DAQ GUI can import it too, is what is left. |
| `vitest` | Phase 10 | No UI logic to test; `tsc -b` is the real gate until there is. |
| P&ID import | Phase 11 | Needs the component model (Phase 02) to import *into*. |
