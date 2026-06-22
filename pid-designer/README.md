# P&ID Designer

An interactive web tool for drawing the propulsion **P&ID** (Piping &
Instrumentation Diagram) — tanks, valves, sensors, and the lines between them —
and versioning it in git straight from the browser. The diagram is stored as a
single JSON file in this repo, so every change is a normal commit you can review
and roll back.

## Overview

The frontend is a node-graph editor (React Flow) with a palette of propulsion
components; the backend is a thin FastAPI service that persists the diagram and
wraps git for history, checkpoints, and pull. There is no database — the diagram
*is* `diagrams/pid_main.json`, tracked in this repository.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ Frontend  (React + Vite)    │  HTTP  │ Backend  (FastAPI, :8001)    │
│  React Flow canvas          │ ─────▶ │  /api/pid/load, autosave,    │
│  component palette:         │        │  checkpoint, history, pull,  │
│  tanks, valves, RTD/MAN,    │        │  version/{hash}              │
│  check valves, QDs, reliefs │        │           │                  │
│  :5174                      │        │           ▼  git commit/push │
└─────────────────────────────┘        │  diagrams/pid_main.json      │
                                        └──────────────────────────────┘
```

## Directory structure

```
pid-designer/
├── dev.sh                 # starts backend + frontend together (dev)
├── backend/               # FastAPI service
│   ├── main.py            #   app + CORS, mounts the pid router
│   └── routers/pid.py     #   diagram persistence + git-backed versioning
├── frontend/              # React 19 + Vite + TypeScript + Tailwind
│   └── src/components/pid/ #   PIDDesigner + node components (Tank, Valve, ...)
└── diagrams/
    └── pid_main.json      # the live diagram (git-tracked = the source of truth)
```

## Quick start

Prerequisites: Python 3.11+ (with `fastapi`, `uvicorn[standard]`, `pydantic`),
Node 20+, and git.

```bash
cd pid-designer
./dev.sh
```

`dev.sh` installs the frontend dependencies on first run, then launches both
services:

- Backend (FastAPI) → http://localhost:8001
- Frontend (Vite)   → http://localhost:5174

Open the frontend URL and start editing. Changes autosave to
`diagrams/pid_main.json`; use the in-app controls to checkpoint (commit + push)
or pull the latest version.

To run a piece on its own:

```bash
# backend only
uvicorn backend.main:app --reload --port 8001
# frontend only
cd frontend && npm run dev
```

## API

The backend exposes a small REST surface under `/api/pid` (plus `/api/health`):

| Method & path | Purpose |
|---|---|
| `GET  /api/pid/load` | load the current diagram JSON |
| `POST /api/pid/autosave` | write the diagram to disk (no commit) |
| `POST /api/pid/checkpoint` | commit (and push) the current diagram |
| `POST /api/pid/pull` | pull the latest committed diagram |
| `GET  /api/pid/history` | list commits that touched the diagram |
| `GET  /api/pid/version/{commit_hash}` | fetch the diagram at a past commit |

Because checkpoints run `git commit`/`push`, the service operates on this repo's
working tree — run it from within a normal clone of STAR, on a branch you're
allowed to push.

## CI

`.github/workflows/pid-designer-ci.yml` runs on changes under `pid-designer/`:
a TypeScript build of the frontend (`npm run build`) and an import check of the
backend.
