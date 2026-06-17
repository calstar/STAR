"""Standalone FastAPI backend for the P&ID Designer.

Run with:
    cd pid-designer
    uvicorn backend.main:app --reload --port 8001
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers import pid

app = FastAPI(title="P&ID Designer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pid.router)


@app.get("/api/health")
async def health():
    return {"status": "healthy"}
