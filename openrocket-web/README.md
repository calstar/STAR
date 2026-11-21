# openrocket-web

OpenRocket's design view, hosted: a browser UI on a Python port of OpenRocket
24.12's physics. It runs on its own, and it is the **OpenRocket** tab of
`star-openrocket` (with the **ORK vs CAD** comparison next to it), which mounts the
same API router at `/api/ork` and compiles the same `<OpenRocketWorkbench/>`.

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

## Known gaps

* Component presets (Parts Library) are not applied; the file's own numbers are used, with a warning.
* OpenRocket's geometry warnings (gaps, overlaps) are not ported yet.
* Back and 3D views, appearance/decal editing, Split fins / Convert to freeform / Export SVG are disabled.
* The bundled motor set is the 29 motors OpenRocket's examples use; the thrustcurve.org mirror comes with the merge.

## Seeing the real OpenRocket

`tools/oracle/Launch.java` starts the 24.12 GUI on a newer JDK (it lifts the
Java-17-only check) and `Drive.java` clicks and screenshots it, e.g. under
`Xvfb :99`. That is how `docs/reference-ui/` was made.

## Layout

```
orweb/            the port (component model, .ork I/O, mass, aerodynamics, figure)
orweb/api.py      the API as a FastAPI router (needs the `api` extra); both hosts mount it
orweb/data/       OpenRocket's motor curves and five example rockets the router serves
backend/          the standalone app: orweb.api at /api, examples from tests/rockets
frontend/         the UI (one <OpenRocketWorkbench/> component, mountable as a tab;
                  icons and font under src/assets, bundled by whichever app builds it)
pyproject.toml    makes `orweb` installable: `pip install -e "openrocket-web[api]"`
tests/            golden comparisons against OpenRocket itself
tools/oracle/     the Java oracle
docs/SCHEMA.md    the document / API contract
```

## Roadmap

1. **Design view** — component tree, edit dialogs, side view with CG/CP,
   stability, `.ork` open/save. **Done:** model, mass and Barrowman match
   OpenRocket to 1e-9 on 30 rockets; saved `.ork` files load back in
   OpenRocket to the same numbers; the UI is matched against screenshots of the
   real program (`docs/reference-ui/` vs `docs/screenshots/`).
2. **Simulation** — RK4 6-DOF stepper, events, recovery, plots; checked
   against the flight data OpenRocket stored in the example files.
3. **Merge** — **done**: the OpenRocket tab of `star-openrocket` (router at
   `/api/ork`, workbench via its `@openrocket-web` Vite alias) and its ORK vs CAD
   comparison. Embedded, the workbench takes `apiBase`, `allowMock={false}` (an
   error, never the mock), `active` (shortcuts only on the visible tab), `onState`
   and `load` -- see `OpenRocketWorkbenchProps`.
