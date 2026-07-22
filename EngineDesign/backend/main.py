"""FastAPI application for Pintle Engine Design.

Run with:
    cd /home/adnan/EngineDesign
    uvicorn backend.main:app --reload --port 8000
"""

import os
import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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
    """Application lifespan - load the canonical impinging config on startup.

    Was ``configs/default.yaml``, which sets no ``propellant_preset`` -- so the loaded config had
    NO fluid identity (``fluids.oxidizer.name`` and ``fluids.fuel.name`` both None). Evaluating it
    yields non-finite solver residuals, and via the runner it produced NEGATIVE thrust
    (F = -334 N, Isp = -7.27 s). The app booted on that config, so a fresh session evaluated a
    physically impossible engine until the user loaded something else.

    The canonical configs are already the documented source of truth -- ``POST /api/config/switch``
    loads ``configs/canonical/<injector_type>.yaml`` wholesale on an injector change (see
    CONFIG_SYSTEM.md). Booting from one removes a third, unmaintained config from the startup path
    instead of keeping it in sync.
    """
    default_config_path = project_root / "configs" / "canonical" / "impinging.yaml"
    if default_config_path.exists():
        try:
            config_obj = load_config(str(default_config_path))
            app_state.set_config(config_obj, str(default_config_path))
            print(f"Loaded startup config from {default_config_path}")
        except Exception as e:
            print(f"Warning: Could not load startup config: {e}")
    
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
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

