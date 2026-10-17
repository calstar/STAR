"""FastAPI application for Pintle Engine Design.

Run with:
    cd /home/adnan/EngineDesign
    uvicorn backend.main:app --reload --port 8000
"""

import os
import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Ensure project root is in path for imports
project_root = Path(__file__).resolve().parents[1]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Warm the physics accelerator (engine/accel) for backend-launched work, including
# the Layer-1 optimizer. This MUST run before the engine/optimizer modules import
# and before the Layer-1 ProcessPool spawns. Opt out with ED_ACCEL=off.
#
# Correction to what this comment used to claim: there is NO runtime self-check
# against Python (see engine/accel/__init__.py).
# Equivalence is enforced ahead of time by tests/test_numba_ab_parity.py, which
# diffs the accelerated and Python paths live on the same inputs.
try:
    from engine import accel as _accel
    if _accel.enabled():
        _accel.warmup()
        print("[accel] numba kernels warmed (ED_ACCEL=numba)")
    else:
        print("[accel] disabled; using the Python path")
except Exception as _ed_err:  # pragma: no cover - accelerator is best-effort
    print(f"[accel] unavailable, using Python path: {_ed_err}")

# Import control router first (required for controller)
from backend.routers import control

# Import other routers optionally (may fail if dependencies missing)
_optional_routers = {}
for router_name in ['config', 'configs_store', 'documents', 'users', 'evaluate', 'timeseries', 'flight', 'geometry', 'optimizer', 'layerx']:
    try:
        router_module = __import__(f'backend.routers.{router_name}', fromlist=[router_name])
        _optional_routers[router_name] = router_module
    except (ImportError, TypeError) as e:
        print(f"Warning: Router '{router_name}' unavailable (non-critical): {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan.

    Live state is per-user now (backend/session.py), so there is no global config
    to load at boot: each user's session loads configs/default.yaml on creation,
    the first time that user hits the API. Nothing to do here.
    """
    yield  # App runs here


app = FastAPI(
    title="Hotbench Engine API",
    description="Liquid engine design and analysis: Forward Mode, Time-Series, the optimizer layers and Layer X",
    version="1.0.0",
    lifespan=lifespan,
)


def _sentence(text: str) -> str:
    t = " ".join(str(text).split())
    if not t:
        return "Something went wrong."
    t = t[0].upper() + t[1:]
    return t if t[-1] in ".!?" else t + "."


def _one_problem(err: dict) -> str:
    loc = [str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path")]
    field = " ".join(loc).replace("_", " ")
    msg = str(err.get("msg") or "is not valid").removeprefix("Value error, ")
    return f"{field}: {msg}" if field else msg


def validation_sentence(errors: list) -> str:
    """FastAPI's request-validation list ([{loc, msg, type}, ...]) as the one plain sentence every
    error response carries (``{"detail": "<sentence>"}``). Every problem, each named by its field,
    joined with '; ' -- as feed-twin's backend/errors.validation_sentence does. A sentence that
    names only the first leaves the person fixing one field per round trip."""
    said = "; ".join(p for p in (_one_problem(e) for e in errors) if p)
    if not said:
        return "Some of the values were not accepted."
    return _sentence(said)


@app.exception_handler(RequestValidationError)
async def _validation_as_sentence(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = list(exc.errors())
    # ``errors`` keeps each problem's field path next to the sentence, so a page that has its own
    # names for its fields (Layer X's rail: "Dome (psia)") can still say them in its own words.
    return JSONResponse(
        status_code=422,
        content={
            "detail": validation_sentence(errors),
            "errors": [{"loc": [str(p) for p in e.get("loc", ())], "msg": str(e.get("msg", ""))} for e in errors],
        },
    )


@app.exception_handler(Exception)
async def _unhandled_as_sentence(request: Request, exc: Exception) -> JSONResponse:
    # A JSON sentence instead of Starlette's bare "Internal Server Error"; the traceback still goes
    # to the server log.
    first = (str(exc).strip().splitlines() or [""])[0][:200]
    what = f"{type(exc).__name__}: {first}" if first else type(exc).__name__
    return JSONResponse(status_code=500, content={"detail": f"The engine design server hit an error ({what})."})

if 'layerx' in _optional_routers:
    # Refuses an oversized drawing upload before Starlette reads (and spools) its body.
    app.add_middleware(_optional_routers['layerx'].UploadSizeGuard)

# CORS middleware for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev server
        "http://localhost:3000",  # Alternative React port
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        "https://engine-design.starberkeley.org",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth is Caddy's job: the reverse proxy verifies the session before any request
# reaches this app (deploy/Caddyfile), and this container never publishes a host
# port, so it is only reachable through Caddy. The app therefore does no auth --
# it only reads X-Auth-Email for per-user data (backend/userdata.py), which falls
# back to a local user in dev where there is no Caddy.

# Include routers (control is required, others optional)
app.include_router(control.router)

# Include optional routers if they loaded successfully
for router_name, router_module in _optional_routers.items():
    try:
        app.include_router(router_module.router)
        print(f"✅ Loaded router: {router_name}")
    except Exception as e:
        print(f"Warning: Failed to include router '{router_name}': {e}")


@app.get("/")
async def root():
    """Root endpoint - API info."""
    return {
        "name": "Pintle Engine Design API",
        "version": "1.0.0",
        "docs": "/docs",
    }


@app.get("/api/health")
async def health():
    """Health check endpoint.

    A liveness probe with no user context, so it no longer reports config_loaded
    (that is a per-user fact now -- see GET /api/config).
    """
    return {"status": "healthy"}

