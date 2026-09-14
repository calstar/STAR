# P&ID Designer

An interactive web tool for drawing the propulsion **P&ID** (Piping &
Instrumentation Diagram) — tanks, valves, sensors, and the lines between them.
Each user has their own private set of named diagrams, with automatic version
history and explicit, named releases.

The drawing is also the input to [`feed-twin`](../feed-twin/README.md): a
component carries the numbers that describe the hardware, in the shape
[`lib/feedtwin`](../lib/feedtwin/README.md) reads them, so a feed-system solve
starts from what somebody drew rather than from a second copy typed into a
spreadsheet.

## Overview

The frontend is a node-graph editor (React Flow) with a palette of propulsion
components; the backend is a thin FastAPI service. Storage has three tiers:

- **Autosave** → a fast per-user *working copy* on a volume (`current.json`),
  written ~1s after every edit. This is what loads when you open a diagram.
- **Microversions** → automatic point-in-time snapshots, pushed to S3 while you
  edit (throttled to `PID_MICRO_INTERVAL`, default 5 min) plus a best-effort one
  when the tab closes. They ride on **S3 object versioning**; a lifecycle rule
  prunes old ones. The "don't lose data" safety net.
- **Releases** → explicit, immutable, user-named milestones ("0.1"), kept
  indefinitely.

Identity comes from the `X-Auth-Email` header Caddy injects; with no Caddy (local
dev) everything belongs to the `local` user. There is no database.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ Frontend  (React + Vite)    │  HTTP  │ Backend  (FastAPI, :8001)    │
│  React Flow canvas          │ ─────▶ │  /api/pid/diagrams/{id}/...  │
│  diagram picker (per user)  │        │   load · autosave · flush    │
│  component palette          │        │   history · version · release│
│  :5174                      │        │        │           │         │
└─────────────────────────────┘        │  working copy      version   │
                                        │  (volume)          history   │
                                        │                  (S3 / disk) │
                                        └──────────────────────────────┘
```

## What a drawing carries

Beyond the geometry, a component holds the things a reader — human or solver —
needs. Double-click any symbol, or any line, to set them.

**Parameters are records, not floats.** Every number is stored as
`{value, unit, source, reference}`, which is `feedtwin.model.Param` verbatim.
`source` is one of *measured*, *manufacturer*, *estimated* or *default*, and it
is asked for rather than defaulted: a run report that can say which of its
inputs were measured and which were guessed is the difference between a number
you can defend in a design review and one you cannot. What each component has
is declared in [`spec.ts`](frontend/src/components/pid/spec.ts) — adding a
setting is a row in that table.

**There is no psig.** Gauge is a reference, not a unit, and a psig value stored
as psi is one atmosphere low everywhere downstream. The units offered are
exactly the ones `feedtwin.model.units` registers, and every pressure field
says so beside it.

**Prefer a part number to typed numbers.** The catalogue already holds a part's
datasheet and whatever the bench measured. Name the part and leave the fields
blank; fill one only to override that part for one installation.

**Fluid is declared once and inherited.** Say ethanol is in this tank and LOX in
that one; every line, valve and fitting downstream inherits it, and the colour
follows. Two different fluids arriving at one component is reported rather than
blended — on a drawing that is a line run to the wrong port. A tank is a source
rather than a junction, and its top ports are its ullage side, so pressurising a
LOX tank with nitrogen is not mistaken for a fault.

**Ports have an identity, not just a count.** A manifold is one symbol here and
a plenum plus one branch per port in a solve, so each port on a manifold or a
tank takes a name and a kind: *flow* (carries fluid), *instrument* (a real
tapping that carries none, drawn hollow), or *plug* — which is **not drawn at
all**, because a P&ID does not draw plugs. Only ports that differ from the
default are stored.

Port ids keep the bare prefix at index zero (`t`, not `t1`), so raising a port
count never renames the port existing lines are attached to. A line attached to
a port that has been removed or plugged is an error in the checks panel: React
Flow cannot place it, so it would otherwise be saved and never drawn.

**Instruments clip to what they measure.** Drop an RTD on a tank or a line and
it attaches, with a leader and no pipe. A probe carries no flow, so wiring one
into the flow path makes it a dead end in a solve and a detour on the drawing.

**Pages** keep the rocket side and the GSE side in one diagram. The graph stays
whole — only the view is filtered — so fluid still propagates across the
umbilical and the checks panel still sees both halves of every disconnect pair.

**The checks panel** (the badge, top right) reports what is wrong: a flight-half
quick disconnect with nothing to mate to, two fluids meeting where they should
not, a tank with no pressure or temperature, probes wired into the flow path,
and every value nobody has established. Severities are chosen so an unfinished
drawing is quiet — a check that fires on correct work is one people learn to
dismiss.

**Vents are read off the drawing.** A valve connected on one side only is a vent
to atmosphere, drawn with the open-to-atmosphere mark. Valves only, and only
with exactly one connection: a spare port elsewhere is a plug, and a valve with
no connections is simply undrawn. Supplies are symbols (K-bottle, dewar), so a
fill valve has something on both sides and is never mistaken for a vent.

## Directory structure

```
pid-designer/
├── dev.sh                 # starts backend + frontend together (dev)
├── backend/               # FastAPI service
│   ├── main.py            #   app + CORS, mounts the pid router
│   ├── userdata.py        #   per-user roots, keyed on X-Auth-Email
│   ├── storage.py         #   version history: S3Backend | LocalBackend (dev)
│   └── routers/pid.py     #   diagram CRUD + working copy + versioning endpoints
└── frontend/              # React 19 + Vite + TypeScript + Tailwind
    └── src/components/pid/
        ├── PIDDesigner.tsx #   the canvas, and everything wired into it
        ├── spec.ts         #   what each component and line has — data
        ├── params.ts       #   the parameter record, and the units
        ├── fluids.ts       #   species, and inheritance from the tanks
        ├── checks.ts       #   what is wrong with this feed system
        ├── pages.ts        #   rocket side / GSE side, one diagram
        ├── attach.ts       #   instruments clip rather than connect
        ├── ports.ts        #   what a component's ports are, and what for
        ├── vents.ts        #   a valve open on one side vents to atmosphere
        └── nodes/          #   one file per symbol
```

Working copies live under `USERDATA_DIR` (prod: a mounted volume, `/data`; dev: a
gitignored `.userdata/` beside the app). Version history lives in S3 in prod, or
on disk under the same tree in dev (no AWS needed).

## Quick start

Prerequisites: Python 3.11+ (`fastapi`, `uvicorn[standard]`, `pydantic`), Node 20+.
`boto3` is only needed if you point dev at a real S3 bucket.

```bash
cd pid-designer
./dev.sh                 # start (detached — survives closing the terminal)
./dev.sh --attach        # ...and watch it; Ctrl-B then D to detach again
./dev.sh --status        # up? which ports are listening?
./dev.sh --logs backend  # follow one process
./dev.sh --stop
```

- Backend (FastAPI) → http://localhost:8001
- Frontend (Vite)   → http://localhost:5174

Open the frontend, pick or create a diagram, and edit. Changes autosave to the
working copy; the History panel shows microversions and releases, and **Release**
publishes a named version. In dev (no `PID_S3_BUCKET`) history is kept on disk, so
everything works with no AWS.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `USERDATA_DIR` | `<subproject>/.userdata` | Root for per-user working copies |
| `PID_S3_BUCKET` | *(unset)* | S3 bucket for version history; unset → local-disk history |
| `PID_S3_PREFIX` | `pid` | Key prefix inside the bucket |
| `PID_MICRO_INTERVAL` | `300` | Min seconds between automatic microversions |
| `AWS_*` | — | Standard boto3 credentials (access keys — the apps box isn't EC2) |

Deploy + AWS setup (bucket, versioning, lifecycle, IAM keys) is in
[`deploy/apps/README.md`](../deploy/apps/README.md) and
[`deploy/apps/app-s3-policy.json`](../deploy/apps/app-s3-policy.json).

## API

All routes are under `/api/pid` (plus `/api/health`). Identity is the
`X-Auth-Email` header (or `local` in dev). A diagram lives in its creator's
folder, but that is only *where it lives*, not a privilege level: everyone on its
`sharedWith` list is an equal editor, and any diagram can be viewed and copied by
anyone. A diagram someone else owns is addressed with `?owner=<email>`, which the
server reads as a claim to be an editor and refuses (403) if you are not one.

| Method & path | Purpose |
|---|---|
| `GET  /diagrams/browse` | everyone else's diagrams, grouped by owner (the view-only tree) |
| `POST /diagrams/copy` | `{owner, id}` -> your own copy, with fresh history and no share list |
| `PUT  /diagrams/{id}/share` | replace the editor list `{sharedWith: [email]}` (whole list, not a delta) |
| `DELETE /diagrams/{id}/share/me` | remove yourself from a diagram shared with you |
| `GET  /users` | who a diagram can be shared with (see backend/directory.py) |
| `POST /diagrams/{id}/checkout` | take the write token (423 if someone else has it) |
| `DELETE /diagrams/{id}/checkout` | give it back |
| `GET  /diagrams/{id}/checkout` | who holds it right now |


| Method & path | Purpose |
|---|---|
| `GET  /diagrams` | list the caller's diagrams |
| `POST /diagrams` | create a diagram `{name}` |
| `PATCH /diagrams/{id}` | rename `{name}` (id/keys stay fixed) |
| `GET  /diagrams/{id}/load` | working copy (freshest); falls back to latest microversion if the volume is empty |
| `POST /diagrams/{id}/autosave` | write working copy; snapshot to S3 once per `PID_MICRO_INTERVAL` |
| `POST /diagrams/{id}/flush` | force an immediate microversion (on-close beacon) |
| `GET  /diagrams/{id}/history` | list microversions |
| `GET  /diagrams/{id}/version/{versionId}` | fetch one microversion |
| `POST /diagrams/{id}/release` | publish an immutable release `{label}` (409 if it exists) |
| `GET  /diagrams/{id}/releases` | list releases |
| `GET  /diagrams/{id}/release/{label}` | fetch one release |

A diagram is editable only by whoever holds its **checkout**. Opening one never
takes it -- viewing must not block a colleague -- so the canvas is read only
until you press Take in the diagram bar. The checkout returns on its own after a
15 minutes without a save, and on tab close -- but not merely because you
switched tabs or shut the lid. See
[`lib/stardesign`](../lib/stardesign/README.md#checkouts).

There is deliberately **no delete**. Diagrams are shared and editable by more
than one person, so a delete button is one misclick away from destroying a group
project with only a server-admin restore behind it. Cleanup is an admin
operation on the `userdata` volume.

## CI

`.github/workflows/pid-designer-ci.yml` runs on changes under `pid-designer/`:
a TypeScript build of the frontend (`npm run build`) and an import check of the
backend.
