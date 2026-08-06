"""Standalone FastAPI backend for the Onshape CM Viewer.

Run with:
    cd onshape-viewer
    uvicorn backend.main:app --reload --port 8002

This server only *serves* build artifacts; it never talks to Onshape. The build
runs offline via `python -m backend.onshape.build`, which is what keeps
credentials out of anything the browser can reach -- there is no code path from
an HTTP request here to an Onshape API key.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

CACHE_ROOT = Path(__file__).resolve().parent.parent / "cache"

app = FastAPI(title="Onshape CM Viewer API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5175",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _model_dirs() -> list[Path]:
    if not CACHE_ROOT.exists():
        return []
    return sorted(d for d in CACHE_ROOT.iterdir() if (d / "manifest.json").exists())


@app.get("/api/health")
async def health():
    return {"status": "healthy"}


@app.get("/api/models")
async def list_models():
    """Every built model in the cache, newest build first."""
    models = []
    for directory in _model_dirs():
        try:
            manifest = json.loads((directory / "manifest.json").read_text())
        except (OSError, json.JSONDecodeError):
            continue
        source = manifest.get("source", {})
        models.append(
            {
                "id": directory.name,
                "documentName": source.get("documentName"),
                "assemblyName": source.get("assemblyName"),
                "builtAt": source.get("builtAt"),
                "partCount": manifest.get("totals", {}).get("partCount"),
                "partsWithoutMaterial": manifest.get("totals", {}).get("partsWithoutMaterial"),
            }
        )
    models.sort(key=lambda m: m.get("builtAt") or "", reverse=True)
    return models


def _resolve(model_id: str, filename: str) -> Path:
    # Reject traversal before touching the filesystem: model_id comes straight
    # from the URL and is used as a path segment.
    if "/" in model_id or "\\" in model_id or model_id.startswith("."):
        raise HTTPException(status_code=400, detail="invalid model id")
    path = CACHE_ROOT / model_id / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{filename} not found for model {model_id}")
    return path


@app.get("/api/models/{model_id}/manifest.json")
async def get_manifest(model_id: str):
    return FileResponse(_resolve(model_id, "manifest.json"), media_type="application/json")


@app.get("/api/models/{model_id}/model.glb")
async def get_glb(model_id: str):
    return FileResponse(
        _resolve(model_id, "model.glb"),
        media_type="model/gltf-binary",
        # Artifacts are keyed on an immutable ref, so they can never change
        # under a client that has already fetched them.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
