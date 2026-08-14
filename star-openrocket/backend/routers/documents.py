"""Per-user recovery configs with microversion history + named releases.

Ported from pid-designer/backend/routers/pid.py. A pid *diagram* is a recovery
*config* here; the payload is a config blob (``{"config": <UiConfig>}``) instead
of ``{nodes, edges}``. Three tiers of durability:

* **autosave** -> a fast working copy on the volume (``current.json``). Never
  hits S3. ``/load`` always returns it -- the freshest state.
* **microversions** -> automatic snapshots pushed to storage over time
  (throttled to ``MICRO_INTERVAL`` while editing) plus a best-effort ``/flush``
  when the tab closes. The safety net; S3 object versioning + a lifecycle rule
  prunes old ones in prod, files on the volume in dev.
* **releases** -> explicit, immutable, user-named milestones ("0.1").

Version history lives in :mod:`backend.storage`. This module owns the working
copy and the per-user document index only. Auth is Caddy's job; a missing header
just means the ``local`` user (never a rejection). See backend/userdata.py.

The client-side localStorage autosave (frontend/src/lib/persist.ts) stays as the
instant working cache; this server store is the durable, versioned timeline.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend import storage, userdata

router = APIRouter(prefix="/api/documents", tags=["documents"])

# Seconds between automatic microversion snapshots for one document while it is
# being actively autosaved. The on-close /flush ignores this.
MICRO_INTERVAL = int(os.environ.get("OPENROCKET_MICRO_INTERVAL", "300"))

# (user, doc_id) -> monotonic time of the last microversion. In-process only;
# after a restart the worst case is one extra snapshot, which is harmless.
_last_micro: dict[tuple[str, str], float] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── working copy + document index (on the volume) ────────────────────────────

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


def _require_id(doc_id: str) -> str:
    """Sanitize a path-supplied id into a safe segment, or 404."""
    safe = userdata.slugify(doc_id)
    if not safe:
        raise HTTPException(status_code=404, detail="Unknown document")
    return safe


def _unique_id(user: str, name: str) -> str:
    base = userdata.slugify(name) or "config"
    existing = {d["id"] for d in _load_index(user)}
    if base not in existing:
        return base
    n = 2
    while f"{base}-{n}" in existing:
        n += 1
    return f"{base}-{n}"


def _working_path(user: str, doc_id: str) -> Path:
    return userdata.user_dir(user) / doc_id / "current.json"


def _read_working(user: str, doc_id: str) -> dict | None:
    p = _working_path(user, doc_id)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _write_working(user: str, doc_id: str, data: dict) -> None:
    p = _working_path(user, doc_id)
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


def _touch_index(user: str, doc_id: str) -> None:
    index = _load_index(user)
    for d in index:
        if d["id"] == doc_id:
            d["updatedAt"] = _now_iso()
            _save_index(user, index)
            return


# ── request models ───────────────────────────────────────────────────────────

class ConfigPayload(BaseModel):
    config: dict


class CreatePayload(BaseModel):
    name: str
    config: dict | None = None  # seed the working copy; {} if omitted


class NamePayload(BaseModel):
    name: str


class ReleasePayload(BaseModel):
    label: str
    config: dict | None = None  # snapshot this; else the current working copy


# ── document CRUD ─────────────────────────────────────────────────────────────

@router.get("")
async def list_documents(request: Request):
    """The caller's configs, newest-updated first."""
    user = userdata.current_user(request)
    index = _load_index(user)
    index.sort(key=lambda d: d.get("updatedAt") or "", reverse=True)
    return index


@router.post("")
async def create_document(request: Request, payload: CreatePayload):
    """Create a new config owned by the caller, seeded with an optional config."""
    user = userdata.current_user(request)
    name = payload.name.strip() or "Untitled"
    doc_id = _unique_id(user, name)
    now = _now_iso()
    meta = {"id": doc_id, "name": name, "createdAt": now, "updatedAt": now}
    index = _load_index(user)
    index.append(meta)
    _save_index(user, index)
    _write_working(user, doc_id, {"config": payload.config or {}})
    return meta


@router.patch("/{doc_id}")
async def rename_document(request: Request, doc_id: str, payload: NamePayload):
    """Rename a config. The id (and all storage keys) stay fixed."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    index = _load_index(user)
    for d in index:
        if d["id"] == doc_id:
            d["name"] = name
            d["updatedAt"] = _now_iso()
            _save_index(user, index)
            return d
    raise HTTPException(status_code=404, detail="Unknown document")


@router.delete("/{doc_id}")
async def delete_document(request: Request, doc_id: str):
    """Remove a config: index entry, working copy, and its version history."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    index = [d for d in _load_index(user) if d["id"] != doc_id]
    _save_index(user, index)
    storage.backend.delete_doc(user, doc_id)
    _last_micro.pop((user, doc_id), None)
    return {"ok": True}


# ── working copy: load + autosave ────────────────────────────────────────────

@router.get("/{doc_id}/load")
async def load_document(request: Request, doc_id: str):
    """Load the freshest state: the working copy.

    Falls back to the latest microversion only if the working copy is missing (a
    fresh or lost volume) -- self-healing. Never silently returns an older
    snapshot otherwise; that is what /history is for.
    """
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    data = _read_working(user, doc_id)
    if data is None:
        data = storage.backend.latest_micro(user, doc_id)
        if data is not None:
            _write_working(user, doc_id, data)  # rehydrate the volume
    return data or {"config": {}}


@router.post("/{doc_id}/autosave")
async def autosave_document(request: Request, doc_id: str, payload: ConfigPayload):
    """Write the working copy; snapshot a microversion only once per MICRO_INTERVAL."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    data = {"config": payload.config}
    _write_working(user, doc_id, data)

    micro = False
    key = (user, doc_id)
    now = time.monotonic()
    if now - _last_micro.get(key, 0.0) >= MICRO_INTERVAL:
        try:
            storage.backend.snapshot_micro(user, doc_id, data)
            _last_micro[key] = now
            _touch_index(user, doc_id)
            micro = True
        except Exception:
            # Never let a snapshot failure lose the edit -- the working copy is
            # already saved. Retry on the next autosave.
            pass
    return {"ok": True, "micro": micro}


@router.post("/{doc_id}/flush")
async def flush_document(request: Request, doc_id: str, payload: ConfigPayload):
    """Force an immediate microversion. Target of the on-close sendBeacon."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    data = {"config": payload.config}
    _write_working(user, doc_id, data)
    try:
        storage.backend.snapshot_micro(user, doc_id, data)
        _last_micro[(user, doc_id)] = time.monotonic()
        _touch_index(user, doc_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Snapshot failed: {e}")
    return {"ok": True}


# ── microversion history ─────────────────────────────────────────────────────

@router.get("/{doc_id}/history")
async def get_history(request: Request, doc_id: str):
    """Recent automatic microversions, newest first."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    return storage.backend.list_micro(user, doc_id)


@router.get("/{doc_id}/version/{version_id}")
async def get_version(request: Request, doc_id: str, version_id: str):
    """Fetch one microversion (for preview/restore). Does not touch the working copy."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    data = storage.backend.get_micro(user, doc_id, version_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return data


# ── releases ─────────────────────────────────────────────────────────────────

@router.post("/{doc_id}/release")
async def create_release(request: Request, doc_id: str, payload: ReleasePayload):
    """Publish the current state as an immutable named release (e.g. "0.1")."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    label = userdata.slugify(payload.label)
    if not label:
        raise HTTPException(status_code=400, detail="A version label is required")

    if payload.config is not None:
        data = {"config": payload.config}
        _write_working(user, doc_id, data)
    else:
        data = _read_working(user, doc_id) or {"config": {}}

    try:
        meta = storage.backend.create_release(user, doc_id, label, data)
    except FileExistsError:
        raise HTTPException(status_code=409, detail=f"Release '{label}' already exists")
    _touch_index(user, doc_id)
    return meta


@router.get("/{doc_id}/releases")
async def list_releases(request: Request, doc_id: str):
    """Published releases, newest first."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    return storage.backend.list_releases(user, doc_id)


@router.get("/{doc_id}/release/{label}")
async def get_release(request: Request, doc_id: str, label: str):
    """Fetch one release snapshot (for preview/restore)."""
    user = userdata.current_user(request)
    doc_id = _require_id(doc_id)
    data = storage.backend.get_release(user, doc_id, userdata.slugify(label))
    if data is None:
        raise HTTPException(status_code=404, detail="Release not found")
    return data
