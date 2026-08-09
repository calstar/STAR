# P&ID Designer

An interactive web tool for drawing the propulsion **P&ID** (Piping &
Instrumentation Diagram) — tanks, valves, sensors, and the lines between them.
Each user has their own private set of named diagrams, with automatic version
history and explicit, named releases.

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
    └── src/components/pid/ #   PIDDesigner, DiagramBar, PIDToolbar, nodes…
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
`X-Auth-Email` header (or `local` in dev); every diagram is scoped to its owner.

| Method & path | Purpose |
|---|---|
| `GET  /diagrams` | list the caller's diagrams |
| `POST /diagrams` | create a diagram `{name}` |
| `PATCH /diagrams/{id}` | rename `{name}` (id/keys stay fixed) |
| `DELETE /diagrams/{id}` | delete diagram + its version history |
| `GET  /diagrams/{id}/load` | working copy (freshest); falls back to latest microversion if the volume is empty |
| `POST /diagrams/{id}/autosave` | write working copy; snapshot to S3 once per `PID_MICRO_INTERVAL` |
| `POST /diagrams/{id}/flush` | force an immediate microversion (on-close beacon) |
| `GET  /diagrams/{id}/history` | list microversions |
| `GET  /diagrams/{id}/version/{versionId}` | fetch one microversion |
| `POST /diagrams/{id}/release` | publish an immutable release `{label}` (409 if it exists) |
| `GET  /diagrams/{id}/releases` | list releases |
| `GET  /diagrams/{id}/release/{label}` | fetch one release |

## CI

`.github/workflows/pid-designer-ci.yml` runs on changes under `pid-designer/`:
a TypeScript build of the frontend (`npm run build`) and an import check of the
backend.
