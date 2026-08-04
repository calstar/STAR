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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Ensure project root is in path for imports
project_root = Path(__file__).resolve().parents[1]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Enable the native physics kernel (engine/native) for backend-launched work,
# including the Layer-1 optimizer. This MUST run before the engine/optimizer
# modules import and before the Layer-1 ProcessPool spawns, so worker processes
# inherit the flag. Opt out with ED_USE_NATIVE=0. The native path self-checks
# against Python on first use and falls back automatically on any mismatch, so
# enabling it cannot change results — only speed (chamber solve ~400x; an
# optimizer candidate ~60x).
os.environ.setdefault("ED_USE_NATIVE", "1")
if os.environ.get("ED_USE_NATIVE") == "1":
    try:
        from engine.native.python import autobuild as _ed_autobuild
        _ed_lib = _ed_autobuild.ensure_lib()  # build once here so pool workers don't race
        print(f"[native] kernel enabled (ED_USE_NATIVE=1): {_ed_lib}")
    except Exception as _ed_err:  # pragma: no cover - native is best-effort
        print(f"[native] kernel unavailable, using Python path: {_ed_err}")

# Import control router first (required for controller)
from backend.routers import control

# Import other routers optionally (may fail if dependencies missing)
_optional_routers = {}
for router_name in ['config', 'evaluate', 'timeseries', 'flight', 'geometry', 'optimizer']:
    try:
        router_module = __import__(f'backend.routers.{router_name}', fromlist=[router_name])
        _optional_routers[router_name] = router_module
    except (ImportError, TypeError) as e:
        print(f"Warning: Router '{router_name}' unavailable (non-critical): {e}")

from backend.state import app_state
from engine.pipeline.io import load_config


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - load default config on startup."""
    # Try to load default config on startup
    default_config_path = project_root / "configs" / "default.yaml"
    if default_config_path.exists():
        try:
            config_obj = load_config(str(default_config_path))
            app_state.set_config(config_obj, str(default_config_path))
            print(f"Loaded default config from {default_config_path}")
        except Exception as e:
            print(f"Warning: Could not load default config: {e}")
    
    yield  # App runs here
    
    # Cleanup (if needed)
    pass


app = FastAPI(
    title="Pintle Engine Design API",
    description="FastAPI backend for LOX/RP-1 pintle injector rocket engine simulation",
    version="1.0.0",
    lifespan=lifespan,
)

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

# ── Auth middleware ────────────────────────────────────────────────────────
# Skipped entirely when AUTH_ENABLED != "true" (local dev default).
_AUTH_ENABLED = os.environ.get("AUTH_ENABLED", "false").lower() == "true"

if _AUTH_ENABLED:
    # Import shared helper — auth/ must be on PYTHONPATH or peer directory.
    import sys as _sys
    _auth_dir = Path(__file__).resolve().parents[2] / "auth"
    if str(_auth_dir) not in _sys.path:
        _sys.path.insert(0, str(_auth_dir))
    from shared_auth import verify_session  # type: ignore[import]

    # Fail now, loudly. With an empty secret verify_session() rejects every
    # token, so the app would come up healthy and 401 every request -- which
    # reads as "login is broken", not "the secret is missing".
    if not os.environ.get("JWT_SECRET"):
        raise RuntimeError(
            "AUTH_ENABLED=true but JWT_SECRET is empty. Set it in the root .env "
            "(it must match the value in auth/.env), or unset AUTH_ENABLED for "
            "local development."
        )

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        # Always allow health checks through so Caddy probes don't break.
        if request.url.path in ("/api/health", "/"):
            return await call_next(request)
        token = request.cookies.get("session")
        if not verify_session(token or ""):
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        return await call_next(request)

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
        "config_loaded": app_state.has_config(),
    }


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "config_loaded": app_state.has_config(),
    }

