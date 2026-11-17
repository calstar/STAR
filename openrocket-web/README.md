# openrocket-web

OpenRocket's design view, hosted: a browser UI on a Python port of OpenRocket
24.12's physics. It is its own app for now and will become a tab of
`star-openrocket`, where it is the OpenRocket column of the Cross-check.

| | |
|---|---|
| API | FastAPI, `:8004` (`OPENROCKET_WEB_API_PORT`) |
| UI | React + Vite, `:5178` (`OPENROCKET_WEB_UI_PORT`) |
| physics | `orweb/`, pure Python + numpy, ported from OpenRocket release-24.12 |
| licence | **GPLv3** (`LICENSE`) — `orweb/` is a derivative of OpenRocket |

```bash
./dev.sh                         # both halves
cd openrocket-web && python3 -m pytest -q
```

## Why a port, and why the Java stays in the tests

The point of this app is to answer "what would OpenRocket say?" without anyone
installing Java or OpenRocket, and to put that answer next to ours. A port that
does not reproduce OpenRocket is worse than none, because it would be trusted as
OpenRocket. So:

* **No Java at runtime.** `orweb/` is Python.
* **Java in the tests only, as the oracle.** `tools/oracle/Oracle.java` loads an
  `.ork` in OpenRocket 24.12 itself and prints every number the design view
  shows — per-component positions, masses, CGs, inertias; CP, CNa and the drag
  buildup over a Mach × AoA grid; the motors' curves. Its output is committed as
  `tests/golden/*.json` and the tests hold the port to it. You cannot verify the
  port with the port.

```bash
# Regenerate the golden files (needs a JDK 17+ and the 24.12 jar):
curl -LO https://github.com/openrocket/openrocket/releases/download/release-24.12/OpenRocket-24.12.jar
OPENROCKET_JAR=$PWD/OpenRocket-24.12.jar tools/oracle/run.sh
```

The test rockets are OpenRocket's own bundled examples (`tests/rockets/`). Two
of the 17 ("3D printable nose cone and fins", "Deployable payload") use the
component-preset database, which the headless oracle cannot load, and are left
out.

## The pin

Ported from **release-24.12**, the same pin as `star-openrocket/physics/openrocket.py`.
The repo's default branch (`unstable`) has physics no released OpenRocket runs;
porting it would cross-check against a program nobody uses. To move the pin,
move the jar, regenerate the golden files, and fix what goes red.

## Layout

```
orweb/            the port (component model, .ork I/O, mass, aerodynamics, figure)
backend/          FastAPI over orweb
frontend/         the UI (one <OpenRocketWorkbench/> component, mountable as a tab)
tests/            golden comparisons against OpenRocket itself
tools/oracle/     the Java oracle
docs/SCHEMA.md    the document / API contract
```

## Roadmap

1. **Design view** — component tree, edit dialogs, side view with CG/CP,
   stability, `.ork` open/save. *(this milestone)*
2. **Simulation** — RK4 6-DOF stepper, events, recovery, plots; checked
   against the flight data OpenRocket stored in the example files.
3. **Merge** — a tab in `star-openrocket`, and the OpenRocket column of its
   Cross-check panel.
