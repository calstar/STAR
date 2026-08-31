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

Sharing
-------
A diagram lives in its creator's folder, but that is only *where it lives* -- it
is not a privilege level. The creator and everyone in the record's ``sharedWith``
list are equally editors; there is no owner-only operation. Any diagram can also
be read and copied by anyone, which is what the view-only tree in the UI browses.

Every diagram-scoped handler resolves through :func:`_resolve_doc`, which is the
one place cross-user access is granted. It matters that it returns a
:class:`DocRef` rather than a directory name: the write helpers below happily
``mkdir`` whatever path they are handed, so a handler that *forgot* ``?owner=``
would not 403 -- it would silently write a real ``current.json`` into the
caller's own folder with no index entry behind it, and the edit would vanish on
reload. ``/flush`` rides a ``sendBeacon`` whose response nobody reads, so that
failure would be completely silent on the most loss-prone path. A ``DocRef``
only exists if an index record was found, so that cannot happen.

Concurrent editing is deliberately last-write-wins for now: *checkouts*
are the next piece of work and will prevent it properly, so a revision-token
guard built here would only be thrown away.

There is deliberately no delete endpoint: a diagram is editable by more than
one person, so a delete button is one misclick away from destroying a group
project with only a server-admin restore behind it. Cleanup is an admin
operation on the volume.
"""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend import directory, storage, userdata

router = APIRouter(prefix="/api/pid", tags=["pid"])

# Seconds between automatic microversion snapshots for one document while it is
# being actively autosaved. The on-close /flush ignores this.
MICRO_INTERVAL = int(os.environ.get("PID_MICRO_INTERVAL", "300"))

# (owner, doc_id) -> monotonic time of the last microversion. In-process only;
# after a restart the worst case is one extra snapshot, which is harmless.
# Keyed on the diagram's *owner*, not the editor: two people editing one shared
# diagram must share a throttle clock, or it snapshots at twice the intended rate.
_last_micro: dict[tuple[str, str], float] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── working copy + document index (on the volume) ────────────────────────────

def _index_path(user: str, *, create: bool = False) -> Path:
    return userdata.user_dir(user, create=create) / "index.json"


def _load_index(user: str) -> list[dict]:
    """One user's diagram records. Never creates their folder -- the cross-user
    scan reads every sibling, and must not conjure a tree for each one."""
    p = _index_path(user)
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_index(user: str, index: list[dict]) -> None:
    p = _index_path(user, create=True)
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


@contextmanager
def _index_lock(user: str) -> Iterator[None]:
    """Serialize read-modify-write of one user's ``index.json``.

    ``_save_index`` is atomic per write, but read-modify-write is not, and the
    index is now edited by co-editors as well as its owner while the API runs
    several workers. Without this, two overlapping updates drop a record. The
    lock file lives beside the index and is never removed.
    """
    lock = userdata.user_dir(user, create=True) / ".index.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _require_id(doc_id: str) -> str:
    """Sanitize a path-supplied id into a safe segment, or 404."""
    safe = userdata.slugify(doc_id)
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
    _mutate_record(user, doc_id, updatedAt=_now_iso(), missing_ok=True)


def _mutate_record(user: str, doc_id: str, *, missing_ok: bool = False, **fields) -> dict:
    """Apply ``fields`` to one index record, under the index lock.

    Read-modify-write of a file two people may be editing, so it re-reads inside
    the lock rather than trusting a record fetched earlier.
    """
    with _index_lock(user):
        index = _load_index(user)
        for record in index:
            if record["id"] == doc_id:
                record.update(fields)
                _save_index(user, index)
                return record
    if missing_ok:
        return {}
    raise HTTPException(status_code=404, detail="Unknown diagram")


# ── sharing: who may edit which diagram ───────────────────────────────────────

@dataclass(frozen=True)
class DocRef:
    """A diagram the caller is allowed to act on.

    ``owner`` is the folder the diagram lives in -- not a privilege level. It only
    differs from ``viewer`` when someone is editing a diagram shared with them.
    """

    owner: str
    doc_id: str
    record: dict
    viewer: str


def _shared_with(record: dict) -> list[str]:
    """The record's editor list. Absent on every diagram created before sharing
    existed, so a missing key is an empty list, never an error."""
    value = record.get("sharedWith")
    return [str(e) for e in value] if isinstance(value, list) else []


def _can_edit(record: dict, owner: str, viewer: str) -> bool:
    """Emails are stored as written, compared as path slugs -- the same
    normalization ``current_user`` applies, so the two always line up."""
    if viewer == owner:
        return True
    return any(userdata.slug_user(e) == viewer for e in _shared_with(record))


def _find_record(owner: str, doc_id: str) -> dict | None:
    return next((r for r in _load_index(owner) if r.get("id") == doc_id), None)


def _resolve_doc(
    request: Request,
    owner: str | None,
    doc_id: str,
    *,
    need: str = "edit",
) -> DocRef:
    """Resolve ``(?owner=, doc_id)`` into a diagram the caller may act on.

    The single place cross-user access is granted. ``need="read"`` is for the
    two endpoints that exist to look at other people's work (browse and copy);
    everything else needs ``"edit"``, which means being the owner or on the
    share list.

    Returning the resolved record -- rather than just a folder name -- is what
    stops a handler that omits ``?owner=`` from silently writing an orphan
    working copy into the caller's own tree. See the module docstring.
    """
    viewer = userdata.current_user(request)
    owner_slug = userdata.slug_user(owner) if owner else viewer
    doc_id = _require_id(doc_id)
    record = _find_record(owner_slug, doc_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Unknown diagram")
    if need == "edit" and not _can_edit(record, owner_slug, viewer):
        raise HTTPException(status_code=403, detail="This diagram is not shared with you")
    return DocRef(owner=owner_slug, doc_id=doc_id, record=record, viewer=viewer)


def _scan_all() -> Iterator[tuple[str, dict]]:
    """``(owner, record)`` for every diagram on the shared volume.

    All the diagram tools mount one volume keyed by email, which is what makes
    cross-user listing a directory walk instead of a database. At team scale
    this is a few dozen small JSON reads.
    """
    for owner in userdata.all_users():
        for record in _load_index(owner):
            if record.get("id"):
                yield owner, record


def _decorate(record: dict, owner: str, viewer: str, names: dict[str, str]) -> dict:
    """An index record as the UI wants it: who owns it, and is that me."""
    return {
        **record,
        "sharedWith": _shared_with(record),
        "owner": owner,
        "ownerName": names.get(owner) or owner,
        "mine": owner == viewer,
    }


# ── request models ───────────────────────────────────────────────────────────

class DiagramPayload(BaseModel):
    nodes: list = []
    edges: list = []


class CreatePayload(BaseModel):
    name: str


class NamePayload(BaseModel):
    name: str


class ReleasePayload(BaseModel):
    label: str
    nodes: list | None = None  # snapshot this; else the current working copy
    edges: list | None = None


class CopyPayload(BaseModel):
    owner: str  # whose diagram to copy (email or slug)
    id: str
    name: str | None = None  # default: "<name> (copy of <owner>)"


class SharePayload(BaseModel):
    sharedWith: list[str]  # the whole list, not a delta


# ── document CRUD ─────────────────────────────────────────────────────────────

@router.get("/diagrams")
async def list_documents(request: Request):
    """Diagrams the caller may edit -- their own plus any shared with them."""
    viewer = userdata.current_user(request)
    names = directory.display_names(request)
    out = [
        _decorate(record, owner, viewer, names)
        for owner, record in _scan_all()
        if _can_edit(record, owner, viewer)
    ]
    out.sort(key=lambda d: d.get("updatedAt") or "", reverse=True)
    return out


@router.get("/diagrams/browse")
async def browse_documents(request: Request):
    """Everyone else's diagrams, grouped by owner -- the view-only tree.

    Diagrams the caller can already edit are left out: they are in the editable
    list, and offering to copy something you can just open is noise. Anything
    listed here can be copied by anyone; that is the point.
    """
    viewer = userdata.current_user(request)
    names = directory.display_names(request)
    groups: dict[str, list[dict]] = {}
    for owner, record in _scan_all():
        if _can_edit(record, owner, viewer):
            continue
        groups.setdefault(owner, []).append({
            "id": record["id"],
            "name": record.get("name", record["id"]),
            "updatedAt": record.get("updatedAt"),
        })
    return [
        {
            "owner": owner,
            "ownerName": names.get(owner) or owner,
            # `designs` on the wire in all three apps, whatever the app calls
            # the thing -- one browse-tree shape, one client shape.
            "designs": sorted(
                entries, key=lambda d: d.get("updatedAt") or "", reverse=True
            ),
        }
        for owner, entries in sorted(groups.items())
    ]


def _create(user: str, name: str, data: dict) -> dict:
    """Add a diagram to ``user``'s index and seed its working copy."""
    now = _now_iso()
    with _index_lock(user):
        doc_id = _unique_id(user, name)
        meta = {
            "id": doc_id,
            "name": name,
            "createdAt": now,
            "updatedAt": now,
            "sharedWith": [],
            # Reserved: with delete gone, nothing shrinks a list, and every
            # diagram is visible to the whole team through the view-only tree.
            # Archiving is the destroy-nothing replacement, and writing the
            # field now saves a second pass over everyone's index later.
            "archived": False,
        }
        index = _load_index(user)
        index.append(meta)
        _save_index(user, index)
    _write_working(user, doc_id, data)
    return meta


@router.post("/diagrams")
async def create_document(request: Request, payload: CreatePayload):
    """Create a new diagram owned by the caller, seeded with an optional config."""
    user = userdata.current_user(request)
    return _create(user, payload.name.strip() or "Untitled", {"nodes": [], "edges": []})


@router.post("/diagrams/copy")
async def copy_document(request: Request, payload: CopyPayload):
    """Copy any diagram -- yours or anyone else's -- into the caller's own list.

    Deliberately not gated on sharing: every diagram is viewable and copyable by
    anyone, which is what the view-only tree offers. What a copy does *not*
    inherit is history, releases, or the share list. It is a new diagram that
    happens to start from someone else's state, so editing it can never affect
    the original.
    """
    viewer = userdata.current_user(request)
    ref = _resolve_doc(request, payload.owner, payload.id, need="read")
    data = _read_working(ref.owner, ref.doc_id)
    if data is None:
        data = storage.backend.latest_micro(ref.owner, ref.doc_id) or {"nodes": [], "edges": []}
    names = directory.display_names(request)
    who = names.get(ref.owner) or ref.owner
    source = ref.record.get("name", ref.doc_id)
    name = (payload.name or "").strip() or f"{source} (copy of {who})"
    return _create(viewer, name, data)


@router.patch("/diagrams/{doc_id}")
async def rename_document(
    request: Request, doc_id: str, payload: NamePayload, owner: str | None = None
):
    """Rename a diagram. The id (and all storage keys) stay fixed."""
    ref = _resolve_doc(request, owner, doc_id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    return _mutate_record(ref.owner, ref.doc_id, name=name, updatedAt=_now_iso())


# ── sharing ──────────────────────────────────────────────────────────────────

@router.put("/diagrams/{doc_id}/share")
async def share_document(
    request: Request, doc_id: str, payload: SharePayload, owner: str | None = None
):
    """Replace the diagram's editor list.

    Takes the whole list rather than an add/remove delta, so two editors
    changing shares at the same time converge on one of their two lists instead
    of interleaving into a third nobody chose.

    Any editor may change it, including removing others. There is no
    owner/editor distinction to appeal to -- the "owner" is just whoever clicked
    New -- and a removed editor can still read and copy the diagram anyway, so
    this is housekeeping, not a security boundary. ``sharedUpdatedBy`` records
    who last touched it.
    """
    ref = _resolve_doc(request, owner, doc_id)
    seen: set[str] = set()
    emails: list[str] = []
    for raw in payload.sharedWith:
        email = str(raw).strip().lower()
        slug = userdata.slug_user(email) if email else ""
        # The owner is never on their own share list; that asymmetry is what
        # makes them the one person who cannot be removed from a diagram.
        if not email or slug == ref.owner or slug in seen:
            continue
        seen.add(slug)
        emails.append(email)
    return _mutate_record(
        ref.owner,
        ref.doc_id,
        sharedWith=emails,
        sharedUpdatedBy=ref.viewer,
        sharedUpdatedAt=_now_iso(),
    )


@router.delete("/diagrams/{doc_id}/share/me")
async def leave_document(request: Request, doc_id: str, owner: str | None = None):
    """Remove yourself from a diagram someone shared with you.

    With delete gone this is the only thing that shrinks your list, and it
    destroys nothing: the diagram stays exactly where it is and you can copy it
    back out of the view-only tree whenever you like. The owner cannot leave --
    the diagram would end up in nobody's editable list.
    """
    ref = _resolve_doc(request, owner, doc_id)
    if ref.owner == ref.viewer:
        raise HTTPException(
            status_code=400,
            detail="You own this diagram, so you cannot leave it.",
        )
    remaining = [
        e for e in _shared_with(ref.record) if userdata.slug_user(e) != ref.viewer
    ]
    _mutate_record(
        ref.owner,
        ref.doc_id,
        sharedWith=remaining,
        sharedUpdatedBy=ref.viewer,
        sharedUpdatedAt=_now_iso(),
    )
    return {"ok": True}


# ── working copy: load + autosave ────────────────────────────────────────────

@router.get("/diagrams/{doc_id}/load")
async def load_document(request: Request, doc_id: str, owner: str | None = None):
    """Load the freshest state: the working copy.

    Falls back to the latest microversion only if the working copy is missing (a
    fresh or lost volume) -- self-healing. Never silently returns an older
    snapshot otherwise; that is what /history is for.
    """
    ref = _resolve_doc(request, owner, doc_id)
    data = _read_working(ref.owner, ref.doc_id)
    if data is None:
        data = storage.backend.latest_micro(ref.owner, ref.doc_id)
        if data is not None:
            _write_working(ref.owner, ref.doc_id, data)  # rehydrate the volume
    return data or {"nodes": [], "edges": []}


@router.post("/diagrams/{doc_id}/autosave")
async def autosave_document(
    request: Request, doc_id: str, payload: DiagramPayload, owner: str | None = None
):
    """Write the working copy; snapshot a microversion only once per MICRO_INTERVAL.

    A diagram shared with several people is last-write-wins here, on purpose --
    checkouts are the next piece of work. A client that is autosaving a diagram
    it has just been unshared from gets a 403, which is its cue to stop.
    """
    ref = _resolve_doc(request, owner, doc_id)
    data = {"nodes": payload.nodes, "edges": payload.edges}
    _write_working(ref.owner, ref.doc_id, data)

    micro = False
    key = (ref.owner, ref.doc_id)
    now = time.monotonic()
    if now - _last_micro.get(key, 0.0) >= MICRO_INTERVAL:
        try:
            storage.backend.snapshot_micro(ref.owner, ref.doc_id, data)
            _last_micro[key] = now
            _touch_index(ref.owner, ref.doc_id)
            micro = True
        except Exception:
            # Never let a snapshot failure lose the edit -- the working copy is
            # already saved. Retry on the next autosave.
            pass
    return {"ok": True, "micro": micro}


@router.post("/diagrams/{doc_id}/flush")
async def flush_document(
    request: Request, doc_id: str, payload: DiagramPayload, owner: str | None = None
):
    """Force an immediate microversion. Target of the on-close sendBeacon."""
    ref = _resolve_doc(request, owner, doc_id)
    data = {"nodes": payload.nodes, "edges": payload.edges}
    _write_working(ref.owner, ref.doc_id, data)
    try:
        storage.backend.snapshot_micro(ref.owner, ref.doc_id, data)
        _last_micro[(ref.owner, ref.doc_id)] = time.monotonic()
        _touch_index(ref.owner, ref.doc_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Snapshot failed: {e}")
    return {"ok": True}


# ── microversion history ─────────────────────────────────────────────────────

@router.get("/diagrams/{doc_id}/history")
async def get_history(request: Request, doc_id: str, owner: str | None = None):
    """Recent automatic microversions, newest first."""
    ref = _resolve_doc(request, owner, doc_id)
    return storage.backend.list_micro(ref.owner, ref.doc_id)


@router.get("/diagrams/{doc_id}/version/{version_id}")
async def get_version(
    request: Request, doc_id: str, version_id: str, owner: str | None = None
):
    """Fetch one microversion (for preview/restore). Does not touch the working copy."""
    ref = _resolve_doc(request, owner, doc_id)
    data = storage.backend.get_micro(ref.owner, ref.doc_id, version_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Version not found")
    return data


# ── releases ─────────────────────────────────────────────────────────────────

@router.post("/diagrams/{doc_id}/release")
async def create_release(
    request: Request, doc_id: str, payload: ReleasePayload, owner: str | None = None
):
    """Publish the current state as an immutable named release (e.g. "0.1")."""
    ref = _resolve_doc(request, owner, doc_id)
    label = userdata.slugify(payload.label)
    if not label:
        raise HTTPException(status_code=400, detail="A version label is required")

    if payload.nodes is not None or payload.edges is not None:
        data = {"nodes": payload.nodes or [], "edges": payload.edges or []}
        _write_working(ref.owner, ref.doc_id, data)
    else:
        data = _read_working(ref.owner, ref.doc_id) or {"nodes": [], "edges": []}

    try:
        meta = storage.backend.create_release(ref.owner, ref.doc_id, label, data)
    except FileExistsError:
        raise HTTPException(status_code=409, detail=f"Release '{label}' already exists")
    _touch_index(ref.owner, ref.doc_id)
    return meta


@router.get("/diagrams/{doc_id}/releases")
async def list_releases(request: Request, doc_id: str, owner: str | None = None):
    """Published releases, newest first."""
    ref = _resolve_doc(request, owner, doc_id)
    return storage.backend.list_releases(ref.owner, ref.doc_id)


@router.get("/diagrams/{doc_id}/release/{label}")
async def get_release(
    request: Request, doc_id: str, label: str, owner: str | None = None
):
    """Fetch one release snapshot (for preview/restore)."""
    ref = _resolve_doc(request, owner, doc_id)
    data = storage.backend.get_release(ref.owner, ref.doc_id, userdata.slugify(label))
    if data is None:
        raise HTTPException(status_code=404, detail="Release not found")
    return data
