"""FastAPI app for the recovery calculator. PLAN.md §11.1, §11.2.

Runs on **8100**, and the port is load-bearing rather than cosmetic:
`EngineDesign/dev.sh` force-kills whatever holds 8000, so sharing a port would
let one app silently kill the other.

The dependency runs one way. This package imports `physics`;
`physics` must never import FastAPI (§11.2). It is a library with a CLI,
and the web app is one consumer -- the test suite and the CLI are others, and
the §12 assertions run headless in CI with no server.
"""

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Put the subproject root on sys.path so `physics` imports with cwd at
# the subproject root, matching EngineDesign/backend/main.py. Nothing in this
# repo is pip-installed.
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from backend.routers import (  # noqa: E402
    atmosphere, climatology, configs_store, crosscheck, devices, documents,
    settings, simulate, study, users,
)
from backend.serialise import SCHEMA_VERSION, git_sha  # noqa: E402

VERSION = "1.0.0"


@asynccontextmanager
async def lifespan(app):
    # Load the device table once at startup rather than per request. It is
    # 121 rows of committed CSV, so this is cheap -- but it also means a
    # malformed table fails loudly at boot instead of on the first search.
    try:
        from physics.devices import load_catalogue

        app.state.catalogue = load_catalogue()
        print("Loaded %d devices" % len(app.state.catalogue))
    except Exception as exc:  # noqa: BLE001 - startup diagnostics
        app.state.catalogue = {}
        print("WARNING: device catalogue unavailable: %s" % exc)
    yield


app = FastAPI(
    title="STAR Recovery Calculator",
    description="1-D descent, canopy inflation and opening loads. See PLAN.md.",
    version=VERSION,
    lifespan=lifespan,
)

# The Vite dev server proxies /api to this port, so CORS is not strictly needed
# in dev -- but it is needed the moment anyone opens the built frontend from a
# file or a different host, and the failure mode without it is an opaque
# browser error rather than a useful message.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5273",
        "http://127.0.0.1:5273",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(simulate.router)
app.include_router(study.router)
app.include_router(crosscheck.router)
app.include_router(devices.router)
app.include_router(atmosphere.router)
app.include_router(climatology.router)
app.include_router(settings.router)
app.include_router(configs_store.router)
app.include_router(documents.router)
app.include_router(users.router)


@app.get("/api/health")
def health():
    """The frontend polls this to decide whether to fall back to fixtures, so
    it must stay cheap and must not touch the physics."""
    return {"status": "healthy", "version": VERSION, "git_sha": git_sha(),
            "schema_version": SCHEMA_VERSION}


@app.get("/")
def root():
    return {"name": "STAR Recovery Calculator", "version": VERSION,
            "docs": "/docs"}
