"""Standalone FastAPI backend for the P&ID Designer.

Run with:
    cd pid-designer
    uvicorn backend.main:app --reload --port 8001
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers import pid, users

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

# Auth is Caddy's job: the reverse proxy verifies the session before any request
# reaches this app (deploy/Caddyfile), and this container never publishes a host
# port, so it is only reachable through Caddy. The app implements no auth itself.

app.include_router(pid.router)
app.include_router(users.router)


@app.get("/api/health")
async def health():
    return {"status": "healthy"}
