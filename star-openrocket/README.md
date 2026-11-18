# STAR OpenRocket

Renders an Onshape assembly in the browser and computes its centre of mass,
recomputing live as parts are toggled, re-materialled, or given a mass by hand.

Built for checking a rocket's CM against what the CAD claims, without opening
Onshape and without trusting a number nobody can see the derivation of.

## Overview

The app is two halves joined by a pair of files on disk.

A **build** is a batch job. It walks an Onshape assembly, flattens its
subassemblies into a list of part occurrences, fetches per-part mass and
material, tessellates every part studio it touches, and writes two artifacts
into `cache/<documentId>_<workspaceId>_<elementId>/`:

| File | What it is |
|---|---|
| `model.glb` | Indexed triangle meshes, one node per occurrence, each carrying `extras.key` |
| `manifest.json` | Per-part mass, volume, material, world centroid — keyed by the same `key` |

That shared `key` is the only join between geometry and physics, and it is what
lets the viewer answer "what is the CM of just these parts" without any
geometry traversal or a single network request.

The **viewer** loads those two files and does the rest client-side: orbit,
select, hide, override a material or a mass, and watch the CM marker move.

Everything the build learned from Onshape is written to `cache/<model>/raw/`
before it is parsed, so rebuilding the same microversion costs **zero** API
calls.

### API quota

Onshape bills per request against a finite quota, which shapes several
decisions here and is worth knowing before you use the app:

| Action | API calls |
|---|---|
| Loading a model in the viewer | **0** — served entirely from `cache/` |
| Toggling parts, overriding a mass, recomputing the CM | **0** — all client-side |
| Filtering documents in the picker | **0** — local match over `cache/browse.json` |
| Pressing "search Onshape" in the picker | **1** |
| Expanding a document for the first time | **1** (free on every later visit) |
| Building a model, cold | **7 + 3 × (unique part studios)** |
| Rebuilding the same microversion | **0** |

Measured cold builds: 16 calls for a 3-part assembly, 22 for the 26-part
reference rocket, 39 for a 29-part payload assembly. Every build writes its own
count to `manifest.json` under `build.apiCalls`.

The test suite makes **no** API calls, and cannot: `tests/conftest.py` blocks
`socket.connect` for every test. CI has no credentials at all, and asserts both
facts on every run.

## Architecture

```
  Onshape REST v12
        │  (build only; cached to cache/<model>/raw/)
        ▼
  backend/onshape/
    urls.py ──── parse + resolve to an immutable microversion
    assembly.py ─ flatten subassemblies → occurrence list
    mass.py ───── per-part mass + material (massAsGroup=false)
    tessellate.py facets per part studio
    glb.py ────── weld + index → GLB with per-node extras
    build.py ──── orchestrates the above, writes the manifest
        │
        ▼
  cache/<did>_<wid>_<eid>/{model.glb, manifest.json, raw/}
        │
        │  backend/main.py — FastAPI, serves artifacts + brokers the picker
        ▼
  frontend/  React + three.js — render, select, recompute CM
```

`backend/main.py` also proxies the picker's Onshape lookups and runs builds as
polled background jobs. That means the process holds API credentials and anyone
who can reach port 8002 can spend them, so it binds localhost and **must not be
exposed to a network without authentication in front of it**.

## Directory structure

```
star-openrocket/
├── backend/
│   ├── main.py                  # FastAPI: artifacts, picker, build jobs
│   └── onshape/
│       ├── browse.py            # picker's document/assembly cache
│       ├── build.py             # orchestrator + CLI entrypoint
│       ├── client.py            # auth, rate limit, retry, disk cache
│       ├── urls.py              # URL parse + wvm resolution
│       ├── assembly.py          # assembly walk → occurrences
│       ├── mass.py              # per-part mass + materials
│       ├── tessellate.py        # tessellatedfaces → facets
│       ├── geometry.py          # weld / index helpers
│       └── glb.py               # GLB writer
├── frontend/
│   └── src/
│       ├── App.tsx
│       ├── api/client.ts
│       ├── lib/cm.ts            # weighted-sum centre of mass
│       └── components/viewer/   # Scene, PartList, ModelPicker, ...
├── tests/                       # offline; fixtures are captured live responses
├── cache/                       # gitignored build artifacts
├── setup.sh                     # per-project install (also installs lib/stardesign)
└── dev.sh                       # run both halves
```

## Quick start

```bash
# From the repo root
./setup.sh --star-openrocket      # or: bash star-openrocket/setup.sh
```

Then put an Onshape key pair (https://dev-portal.onshape.com) into the
gitignored `star-openrocket/.env`:

```
ONSHAPE_ACCESS_KEY=...
ONSHAPE_SECRET_KEY=...
```

```bash
cd star-openrocket
./dev.sh                         # backend :8002, frontend :5175
```

Open http://localhost:5175 and pick a model from the header. With an empty
cache, type a name and press **search Onshape** to look it up.

To build from the CLI instead:

```bash
.venv/bin/python -m backend.onshape.build <onshape-assembly-url>
```

Credentials come from `ONSHAPE_ACCESS_KEY` / `ONSHAPE_SECRET_KEY` in the
environment with no defaults — a build with neither set fails immediately
rather than silently producing nothing. They never reach the browser.

## The OpenRocket tab and ORK vs CAD

The tab after **CAD & Stability** is **OpenRocket**: [`openrocket-web`](../openrocket-web/README.md)'s
workbench -- OpenRocket 24.12's design view (component tree, edit dialogs, side view
with CG/CP, Motors & Configuration, `.ork` open/save) on a pure-Python port of its
physics, held to OpenRocket's own output by that project's tests. It keeps
OpenRocket's light look inside this app's dark shell on purpose.

| | |
|---|---|
| API | openrocket-web's router (`orweb.api`), mounted at **`/api/ork`** by `backend/main.py` -- `/api/ork/health`, `/api/ork/analyze`, `/api/ork/ork/import`, ... (openrocket-web's `docs/SCHEMA.md`, with `/api` read as `/api/ork`) |
| package | `orweb`, installed from `../openrocket-web` (`pip install -e "../openrocket-web[api]"`; setup.sh, dev.sh, CI and `Dockerfile.api` do it) |
| UI | `<OpenRocketWorkbench/>`, compiled from source through the `@openrocket-web` Vite alias (`../../openrocket-web/frontend/src`), like `@stardesign-ui` |
| state | its own: the open rocket autosaves per browser (`openrocket-web:document`), it is **not** part of a design, and the checkout does not gate it |

The tab stays mounted once opened, so its document and undo history survive tab
switches; its shortcuts (Ctrl+Z, Ctrl+S, ...) act only while it is the visible tab.
If `/api/ork` does not answer it says so -- there is no in-browser fallback here.

**ORK vs CAD**, the tab after it, puts the two side by side: the CAD tab's last
stability Compute against the OpenRocket tab's design analysed at the same Mach 0.3
and AoA 0 -- length, diameters, mass, CG, CP, CNα, static margin and the fin
planform, with Δ = ORK − CAD and Δ % highlighted past 2 % / 5 % (0.1 / 0.25 cal for
the margin). Empty is compared with empty and with-motor with with-motor only. **Load
CAD into OpenRocket tab** sends the CAD's own `.ork` export (the Export .ork file)
through `/api/ork/ork/import` into the workbench, so a comparison can start from the
CAD and show what was changed. The row logic is `frontend/src/lib/orkCompare.ts`.

**Licence.** The OpenRocket tab is GPLv3 code: `orweb` and the workbench are a
derivative of OpenRocket (see [`openrocket-web/LICENSE`](../openrocket-web/LICENSE)).
Hosting the app for the team, as we do, is not distribution and is fine; anyone who
*distributes* the app (the images, or a build of the frontend) does so under the
GPLv3's terms, which then cover the combined work.

## Designs, sharing and checkouts

A **design** is the whole unified config -- the CAD/stability/ascent slice and
the recovery slice together -- saved server-side under your identity, with an
autosaved working copy, throttled microversions, and immutable named releases.
The design bar at the bottom of the header drives all of it.

None of that machinery is this app's own. The server half is
[`lib/stardesign`](../lib/stardesign/README.md) and the client half is
[`lib/stardesign-ui`](../lib/stardesign-ui/README.md), both shared with
EngineDesign, pid-designer and the recovery calculator; what lives here is only
the payload shape (`{"config": <OrkConfig>}`), the route prefix, and where the
live design state sits in React.

| Method & path | Purpose |
|---|---|
| `GET  /api/documents` | list your designs, plus those shared with you |
| `POST /api/documents` | create one `{name, config}` |
| `PATCH /api/documents/{id}` | rename `{name}` (id and storage keys stay fixed) |
| `GET  /api/documents/browse` | everyone else's designs, grouped by owner (the view-only tree) |
| `POST /api/documents/copy` | `{owner, id}` -> your own copy, fresh history, no share list |
| `PUT  /api/documents/{id}/share` | replace the editor list `{sharedWith: [email]}` (whole list, not a delta) |
| `DELETE /api/documents/{id}/share/me` | remove yourself from a design shared with you |
| `GET  /api/users` | who a design can be shared with (see backend/directory.py) |
| `POST /api/documents/{id}/checkout` | take the write token (423 if someone else holds it) |
| `DELETE /api/documents/{id}/checkout` | give it back |
| `GET  /api/documents/{id}/checkout` | who holds it right now |
| `POST /api/documents/{id}/checkout/release` | give it back from the on-close beacon (a beacon cannot send DELETE) |
| `GET  /api/documents/{id}/load` | working copy (freshest); falls back to the latest microversion |
| `POST /api/documents/{id}/autosave` | write the working copy; snapshot once per `OPENROCKET_MICRO_INTERVAL` |
| `POST /api/documents/{id}/flush` | force an immediate microversion (the on-close beacon) |
| `GET  /api/documents/{id}/history` | list microversions |
| `GET  /api/documents/{id}/version/{versionId}` | fetch one microversion |
| `POST /api/documents/{id}/release` | publish an immutable release `{label}` (409 if it exists) |
| `GET  /api/documents/{id}/releases` | list releases |
| `GET  /api/documents/{id}/release/{label}` | fetch one release |

A design is editable only by whoever holds its **checkout**. Opening one never
takes it -- viewing must not block a colleague -- so every tab below the header
is read only until you press Take in the design bar. The checkout returns on its
own after 15 minutes without a save, and on tab close -- but not merely because
you switched tabs or shut the lid. See
[`lib/stardesign`](../lib/stardesign/README.md#checkouts).

The Units tab is deliberately outside that gate: unit preferences are a per-user
display setting stored per user on the server, not part of any design.

There is deliberately **no delete**. Designs are shared and editable by more than
one person, so a delete button is one misclick away from destroying someone
else's work with only a server-admin restore behind it. Cleanup is an admin
operation on the `userdata` volume.

Version history goes to S3 when `OPENROCKET_S3_BUCKET` is set, and to files on
the `USERDATA_DIR` volume otherwise (dev, and prod with no bucket).

## Tests

```bash
cd star-openrocket
.venv/bin/python -m pytest tests/ --timeout=120 --timeout-method=thread -q
```

Fully offline. The fixtures under `tests/fixtures/` are real Onshape responses
captured once and trimmed; regenerate them with `python tests/make_fixtures.py`
after a build. `conftest.py` blocks outbound sockets, so a test that tries to
reach the network fails at the call site instead of spending quota.

## CI

[`.github/workflows/star-openrocket-ci.yml`](../.github/workflows/star-openrocket-ci.yml)
runs on changes under `star-openrocket/` (and `lib/stardesign*`, and `openrocket-web/`, which the OpenRocket tab is built from):

| Job | What it checks |
|---|---|
| Python tests | The pytest gate, offline |
| Offline guarantee | That credentials are absent and required, and the socket block still bites |
| Backend smoke | `backend.main` imports with no credentials |
| Frontend | `tsc -b && vite build`, then `vitest` (design audits, the ORK vs CAD rows) |

No Onshape credentials are configured for this workflow, deliberately.
