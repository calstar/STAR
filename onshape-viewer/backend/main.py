"""Standalone FastAPI backend for the Onshape CM Viewer.

Run with:
    cd onshape-viewer
    uvicorn backend.main:app --reload --port 8002

Serves build artifacts, and -- since the model picker landed -- also brokers
Onshape calls on the caller's behalf, for searching documents and for running a
build.

That last part is a deliberate change of posture and is worth stating plainly.
This server previously had no code path from an HTTP request to an Onshape API
key; it now has one. The keys still never leave the process: the browser
receives search results and build artifacts, never a credential. But anyone who
can reach this port can spend the key pair's rate limit and read any document
the key can read. It binds localhost for development, and it must not be
exposed to a network without authentication in front of it.
"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .onshape.browse import BrowseCache
from .onshape.build import build as run_build
from .onshape.client import MissingCredentials, OnshapeClient, OnshapeError

CACHE_ROOT = Path(__file__).resolve().parent.parent / "cache"

#: Lives beside the model directories. `_model_dirs` only considers directories
#: holding a manifest, so a loose file here is invisible to the model list.
_browse = BrowseCache(CACHE_ROOT / "browse.json")

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
                "partsWithoutMaterial": manifest.get("totals", {}).get(
                    "partsWithoutMaterial"
                ),
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
        raise HTTPException(
            status_code=404, detail=f"{filename} not found for model {model_id}"
        )
    return path


@app.get("/api/models/{model_id}/manifest.json")
async def get_manifest(model_id: str):
    return FileResponse(
        _resolve(model_id, "manifest.json"), media_type="application/json"
    )


@app.get("/api/models/{model_id}/model.glb")
async def get_glb(model_id: str):
    return FileResponse(
        _resolve(model_id, "model.glb"),
        media_type="model/gltf-binary",
        # Artifacts are keyed on an immutable ref, so they can never change
        # under a client that has already fetched them.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# -- Onshape browsing ---------------------------------------------------------
#
# Two calls are enough to pick a model, which is why the picker searches rather
# than enumerating: this account has 600+ documents and /documents caps its page
# size at 20 (limit=21 is a 400), so listing everything would be 30+ requests
# before the user has typed anything, and it would still need one call per
# document to discover which of its tabs are assemblies.
#
# Both endpoints below are cache-first and only reach Onshape when `refresh=1`
# says the user asked for it. See browse.py for why there is no TTL: browsing
# used to be the app's biggest consumer of API quota despite producing nothing.

#: Onshape's own cap. Sending more is rejected outright rather than clamped.
DOCUMENT_PAGE_LIMIT = 20


def _onshape_error(exc: Exception) -> HTTPException:
    if isinstance(exc, MissingCredentials):
        # 503, not 500: the server is fine, it just has not been given keys.
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


@app.get("/api/onshape/documents")
async def search_documents(
    q: str = Query("", description="Name search; empty lists everything cached."),
    limit: int = Query(DOCUMENT_PAGE_LIMIT, ge=1, le=DOCUMENT_PAGE_LIMIT),
    refresh: bool = Query(False, description="Ask Onshape. Costs one API call."),
):
    """Documents these credentials own (Onshape `filter=0`).

    Without `refresh` this issues no API call at all: it replays a previous
    answer to the same query, or falls back to a name match over everything
    cached. With `refresh`, one call goes to Onshape and the result is merged
    into that index and remembered against `q`. See browse.py.

    Onshape's own results are ranked rather than alphabetical, so a short query
    can push an exact match down the list -- which is why the page limit is sent
    at its maximum rather than something smaller and tidier.
    """
    if not refresh:
        return _browse.search_documents(q)

    params: dict[str, Any] = {"filter": 0, "limit": limit}
    if q.strip():
        params["q"] = q.strip()

    # cache_dir=None: the client's disk cache is keyed by request and never
    # expires, which is right for immutable microversion reads and wrong here --
    # it would make an explicit refresh return the same answer forever.
    try:
        with OnshapeClient(cache_dir=None) as client:
            payload = client.get_json("/documents", params)
    except (OnshapeError, MissingCredentials) as exc:
        raise _onshape_error(exc) from exc

    documents = []
    for item in payload.get("items", []) if isinstance(payload, dict) else []:
        workspace = item.get("defaultWorkspace") or {}
        if not workspace.get("id"):
            continue
        documents.append(
            {
                "documentId": item.get("id"),
                "name": item.get("name"),
                "workspaceId": workspace.get("id"),
                "owner": (item.get("owner") or {}).get("name"),
                "modifiedAt": item.get("modifiedAt"),
            }
        )
    return _browse.store_documents(documents, q)


@app.get("/api/onshape/documents/{document_id}/w/{workspace_id}/assemblies")
async def list_assemblies(
    document_id: str,
    workspace_id: str,
    refresh: bool = Query(False, description="Ask Onshape. Costs one API call."),
):
    """The assembly tabs of one document, which is what can actually be built.

    Cached after the first look. Assembly tabs are added and renamed far less
    often than a picker gets opened, so a repeat visit should be free.
    """
    if not refresh:
        cached = _browse.get_assemblies(document_id, workspace_id)
        if cached is not None:
            return cached
        # Never expanded before, so there is nothing to serve and no way to get
        # it except from Onshape. Fall through and spend the one call.

    try:
        with OnshapeClient(cache_dir=None) as client:
            elements = client.get_json(
                f"/documents/d/{document_id}/w/{workspace_id}/elements",
                {"elementType": "ASSEMBLY"},
            )
    except (OnshapeError, MissingCredentials) as exc:
        raise _onshape_error(exc) from exc

    assemblies = [
        {"elementId": element.get("id"), "name": element.get("name")}
        for element in (elements if isinstance(elements, list) else [])
        if element.get("id")
    ]
    return _browse.store_assemblies(document_id, workspace_id, assemblies)


# -- Builds -------------------------------------------------------------------


class BuildRequest(BaseModel):
    """Either a pasted URL, or the three ids the picker already resolved."""

    url: str | None = None
    documentId: str | None = None
    workspaceId: str | None = None
    elementId: str | None = None


#: Build jobs, keyed by id. In-memory on purpose -- a job is meaningless across
#: a restart, since the artifact it produces is discovered from the cache anyway.
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()

#: One at a time. Builds are network- and CPU-heavy and share the disk cache,
#: and two concurrent builds of the same ref would race on the same files.
_build_lock = threading.Lock()


def _job_update(job_id: str, **fields: Any) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(fields)


def _run_job(job_id: str, url: str) -> None:
    def progress(message: str) -> None:
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None:
                job["log"].append(message)
                job["message"] = message

    if not _build_lock.acquire(blocking=False):
        _job_update(job_id, status="error", message="Another build is already running.")
        return
    try:
        _job_update(job_id, status="running", message="Starting…")
        manifest = run_build(url, on_progress=progress)
        _job_update(
            job_id,
            status="done",
            modelId=manifest.get("source", {}).get("modelId"),
            message="Build complete.",
        )
    except (OnshapeError, MissingCredentials) as exc:
        _job_update(job_id, status="error", message=str(exc))
    except Exception as exc:  # noqa: BLE001 - surfaced to the client verbatim
        _job_update(job_id, status="error", message=f"{type(exc).__name__}: {exc}")
    finally:
        _build_lock.release()


@app.post("/api/build")
async def start_build(request: BuildRequest):
    """Kick off a build and return a job id to poll."""
    if request.url and request.url.strip():
        url = request.url.strip()
    elif request.documentId and request.workspaceId and request.elementId:
        base = OnshapeClient().base_url.removesuffix("/api/v12").removesuffix("/api")
        url = (
            f"{base}/documents/{request.documentId}"
            f"/w/{request.workspaceId}/e/{request.elementId}"
        )
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide either a url, or documentId + workspaceId + elementId.",
        )

    job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Queued.",
            "log": [],
            "url": url,
            "modelId": None,
            "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

    threading.Thread(target=_run_job, args=(job_id, url), daemon=True).start()
    return {"jobId": job_id, "status": "queued"}


@app.get("/api/build/{job_id}")
async def build_status(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown build job")
        return dict(job)
