"""Standalone FastAPI backend for the P&ID Designer.

Run with:
    cd pid-designer
    uvicorn backend.main:app --reload --port 8001
"""

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.routers import pid

app = FastAPI(title="P&ID Designer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "https://pid-designer.starberkeley.org",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Auth middleware ────────────────────────────────────────────────────────
# Skipped entirely when AUTH_ENABLED != "true" (local dev default).
_AUTH_ENABLED = os.environ.get("AUTH_ENABLED", "false").lower() == "true"

if _AUTH_ENABLED:
    _auth_dir = Path(__file__).resolve().parents[2] / "auth"
    import sys as _sys
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
        if request.url.path == "/api/health":
            return await call_next(request)
        token = request.cookies.get("session")
        if not verify_session(token or ""):
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        return await call_next(request)

app.include_router(pid.router)


@app.get("/api/health")
async def health():
    return {"status": "healthy"}
