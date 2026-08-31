"""Per-user P&ID diagram persistence with S3-backed version history.

Each user (``X-Auth-Email``, or ``local`` in dev) owns a private set of named
diagrams. Three tiers of durability:

* **autosave** -> a fast working copy on the volume (``current.json``). Never
  hits S3. This is what ``/load`` returns -- always the freshest state.
* **microversions** -> automatic point-in-time snapshots pushed to S3 over time
  (throttled to ``PID_MICRO_INTERVAL`` while editing) plus a best-effort ``/flush``
  when the tab closes. They ride on S3 object versioning; a lifecycle rule prunes
  old ones. The safety net.
* **releases** -> explicit, immutable, user-named milestones ("0.1").

Version history lives in :mod:`backend.storage` (S3 in prod, filesystem in dev).
This module owns the working copy and the per-user diagram index only. Auth is
Caddy's job; a missing header just means the ``local`` user (never a rejection).

There is deliberately no delete endpoint: a diagram is editable by more than
one person, so a delete button is one misclick away from destroying a group
project with only a server-admin restore behind it. Cleanup is an admin
operation on the volume.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend import storage, userdata

router = APIRouter(prefix="/api/pid", tags=["pid"])

# How long (seconds) between automatic microversion snapshots for one diagram
# while it is being actively autosaved. The on-close /flush ignores this.
MICRO_INTERVAL = int(os.environ.get("PID_MICRO_INTERVAL", "300"))

# (user, diagram_id) -> monotonic time of the last microversion. In-process only;
# after a restart the worst case is one extra snapshot, which is harmless.
_last_micro: dict[tuple[str, str], float] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── working copy + diagram index (on the volume) ─────────────────────────────

def _index_path(user: str) -> Path:
    return userdata.user_dir(user) / "index.json"


def _load_index(user: str) -> list[dict]:
    p = _index_path(user)
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_index(user: str, index: list[dict]) -> None:
    p = _index_path(user)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(index, fh, indent=2)
        os.replace(tmp, p)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _require_id(diagram_id: str) -> str:
    """Sanitize a path-supplied id into a safe segment, or 404."""
    safe = userdata.slugify(diagram_id)
    if not safe:
        raise HTTPException(status_code=404, detail="Unknown diagram")
    return safe


def _unique_id(user: str, name: str) -> str:
    base = userdata.slugify(name) or "diagram"
    existing = {d["id"] for d in _load_index(user)}
    if base not in existing:
        return base
    n = 2
    while f"{base}-{n}" in existing:
        n += 1
    return f"{base}-{n}"


def _working_path(user: str, diagram_id: str) -> Path:
    return userdata.user_dir(user) / diagram_id / "current.json"


def _read_working(user: str, diagram_id: str) -> dict | None:
    p = _working_path(user, diagram_id)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _write_working(user: str, diagram_id: str, data: dict) -> None:
    p = _working_path(user, diagram_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, p)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _touch_index(user: str, diagram_id: str) -> None:
    index = _load_index(user)
    for d in index:
        if d["id"] == diagram_id:
            d["updatedAt"] = _now_iso()
            _save_index(user, index)
            return


# ── request models ───────────────────────────────────────────────────────────

class DiagramPayload(BaseModel):
    nodes: list[Any]
    edges: list[Any]


class NamePayload(BaseModel):
    name: str


class ReleasePayload(BaseModel):
    label: str
    nodes: list[Any] | None = None
    edges: list[Any] | None = None


# ── diagram CRUD ─────────────────────────────────────────────────────────────

@router.get("/diagrams")
async def list_diagrams(request: Request):
    """The caller's diagrams, newest-updated first."""
    user = userdata.current_user(request)
    index = _load_index(user)
    index.sort(key=lambda d: d.get("updatedAt") or "", reverse=True)
    return index


@router.post("/diagrams")
async def create_diagram(request: Request, payload: NamePayload):
    """Create a new empty diagram owned by the caller."""
    user = userdata.current_user(request)
    name = payload.name.strip() or "Untitled"
    diagram_id = _unique_id(user, name)
    now = _now_iso()
    meta = {"id": diagram_id, "name": name, "createdAt": now, "updatedAt": now}
    index = _load_index(user)
    index.append(meta)
    _save_index(user, index)
    _write_working(user, diagram_id, {"nodes": [], "edges": []})
    return meta


@router.patch("/diagrams/{diagram_id}")
async def rename_diagram(request: Request, diagram_id: str, payload: NamePayload):
    """Rename a diagram. The id (and all storage keys) stay fixed."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    index = _load_index(user)
    for d in index:
        if d["id"] == diagram_id:
            d["name"] = name
            d["updatedAt"] = _now_iso()
            _save_index(user, index)
            return d
    raise HTTPException(status_code=404, detail="Unknown diagram")


# ── working copy: load + autosave ────────────────────────────────────────────

@router.get("/diagrams/{diagram_id}/load")
async def load_diagram(request: Request, diagram_id: str):
    """Load the freshest state: the working copy.

    Falls back to the latest S3 microversion only if the working copy is missing
    (a fresh or lost volume) -- self-healing after volume loss. Never silently
    returns an older snapshot otherwise; that is what /history is for.
    """
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    data = _read_working(user, diagram_id)
    if data is None:
        data = storage.backend.latest_micro(user, diagram_id)
        if data is not None:
            _write_working(user, diagram_id, data)  # rehydrate the volume
    return data or {"nodes": [], "edges": []}


@router.post("/diagrams/{diagram_id}/autosave")
async def autosave_diagram(request: Request, diagram_id: str, payload: DiagramPayload):
    """Write the working copy; snapshot to S3 only once per MICRO_INTERVAL."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    data = {"nodes": payload.nodes, "edges": payload.edges}
    _write_working(user, diagram_id, data)

    micro = False
    key = (user, diagram_id)
    now = time.monotonic()
    if now - _last_micro.get(key, 0.0) >= MICRO_INTERVAL:
        try:
            storage.backend.snapshot_micro(user, diagram_id, data)
            _last_micro[key] = now
            _touch_index(user, diagram_id)
            micro = True
        except Exception:
            # Never let a snapshot failure lose the edit -- the working copy is
            # already saved. Retry on the next autosave.
            pass
    return {"ok": True, "micro": micro}


@router.post("/diagrams/{diagram_id}/flush")
async def flush_diagram(request: Request, diagram_id: str, payload: DiagramPayload):
    """Force an immediate microversion. Target of the on-close sendBeacon."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    data = {"nodes": payload.nodes, "edges": payload.edges}
    _write_working(user, diagram_id, data)
    try:
        storage.backend.snapshot_micro(user, diagram_id, data)
        _last_micro[(user, diagram_id)] = time.monotonic()
        _touch_index(user, diagram_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Snapshot failed: {e}")
    return {"ok": True}


# ── microversion history ─────────────────────────────────────────────────────

@router.get("/diagrams/{diagram_id}/history")
async def get_history(request: Request, diagram_id: str):
    """Recent automatic microversions, newest first."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    return storage.backend.list_micro(user, diagram_id)


@router.get("/diagrams/{diagram_id}/version/{version_id}")
async def get_version(request: Request, diagram_id: str, version_id: str):
    """Fetch one microversion (for preview/restore). Does not touch the working copy."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    data = storage.backend.get_micro(user, diagram_id, version_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return data


# ── releases ─────────────────────────────────────────────────────────────────

@router.post("/diagrams/{diagram_id}/release")
async def create_release(request: Request, diagram_id: str, payload: ReleasePayload):
    """Publish the current state as an immutable named release (e.g. "0.1")."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    label = userdata.slugify(payload.label)
    if not label:
        raise HTTPException(status_code=400, detail="A version label is required")

    if payload.nodes is not None and payload.edges is not None:
        data = {"nodes": payload.nodes, "edges": payload.edges}
        _write_working(user, diagram_id, data)
    else:
        data = _read_working(user, diagram_id) or {"nodes": [], "edges": []}

    try:
        meta = storage.backend.create_release(user, diagram_id, label, data)
    except FileExistsError:
        raise HTTPException(status_code=409, detail=f"Release '{label}' already exists")
    _touch_index(user, diagram_id)
    return meta


@router.get("/diagrams/{diagram_id}/releases")
async def list_releases(request: Request, diagram_id: str):
    """Published releases, newest first."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    return storage.backend.list_releases(user, diagram_id)


@router.get("/diagrams/{diagram_id}/release/{label}")
async def get_release(request: Request, diagram_id: str, label: str):
    """Fetch one release snapshot (for preview/restore)."""
    user = userdata.current_user(request)
    diagram_id = _require_id(diagram_id)
    data = storage.backend.get_release(user, diagram_id, userdata.slugify(label))
    if data is None:
        raise HTTPException(status_code=404, detail="Release not found")
    return data
