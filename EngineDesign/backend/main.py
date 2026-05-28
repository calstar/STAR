"""FastAPI application for Pintle Engine Design.

Run with:
    cd /home/adnan/EngineDesign
    uvicorn backend.main:app --reload --port 8000
"""

import sys
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Ensure project root is in path for imports
project_root = Path(__file__).resolve().parents[1]
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from backend.routers import config, evaluate, timeseries, flight, geometry, optimizer, control, experiment
from backend.state import app_state
from engine.pipeline.io import load_config


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - load default config on startup."""
    # Try to load default config on startup
    default_config_path = project_root / "configs" / "diablo_config.yaml"
    if default_config_path.exists():
        try:
            config_obj = load_config(str(default_config_path))
            app_state.set_config(
                config_obj, str(default_config_path), defer_runner=True
            )
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
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(config.router)
app.include_router(evaluate.router)
app.include_router(timeseries.router)
app.include_router(flight.router)
app.include_router(geometry.router)
app.include_router(optimizer.router)
app.include_router(control.router)
app.include_router(experiment.router)


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
        "runner_ready": app_state.runner is not None,
    }

