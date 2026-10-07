"""Per-user designs with sharing, microversion history and named releases.

The three design tools -- EngineDesign, pid-designer, recovery-calculator --
share this router. They differ in only four things, all of them
:class:`DesignStore` fields: the ``<app>`` path segment, the route prefix, the
payload shape (``{"config": ...}`` vs ``{"nodes": ..., "edges": ...}``), and the
noun used in user-facing strings.

Three tiers of durability:

* **autosave** -> a fast working copy on the volume (``current.json``). Never
  hits S3. ``/load`` always returns it -- the freshest state.
* **microversions** -> automatic snapshots pushed to storage over time
  (throttled to the store's ``micro_interval`` while editing) plus a best-effort
  ``/flush`` when the tab closes. The safety net; S3 object versioning + a
  lifecycle rule prunes old ones in prod, files on the volume in dev.
* **releases** -> explicit, immutable, user-named milestones ("0.1").

Version history lives in :mod:`stardesign.storage`. This module owns the working
copy and the per-user document index only. Auth is Caddy's job; a missing header
just means the ``local`` user (never a rejection). See :mod:`stardesign.userdata`.

Sharing
-------
A design lives in its creator's folder, but that is only *where it lives* -- it
is not a privilege level. The creator and everyone in the record's ``sharedWith``
list are equally editors; there is no owner-only operation. Any design can also
be read and copied by anyone, which is what the view-only tree in the UI browses.

Every design-scoped handler resolves through ``_resolve_doc``, which is the one
place cross-user access is granted -- and, since this module is shared, the one
place in the whole fleet. It matters that it returns a :class:`DocRef` rather
than a directory name: the write helpers below happily ``mkdir`` whatever path
they are handed, so a handler that *forgot* ``?owner=`` would not 403 -- it would
silently write a real ``current.json`` into the caller's own folder with no index
entry behind it, and the edit would vanish on reload. ``/flush`` rides a
``sendBeacon`` whose response nobody reads, so that failure would be completely
silent on the most loss-prone path. A ``DocRef`` only exists if an index record
was found, so that cannot happen.

Checkouts
---------
Concurrent editing is not resolved, it is prevented. At most one person holds a
design's write token at a time, and only the holder may save. Taking it is
explicit (opening a design never takes it, so viewing never blocks a colleague);
it lapses on its own after ``lock_ttl`` without a save, and on tab close.
Hiding the tab -- switching away, minimising, closing a lid -- does not release
it; only a real close does.

A lapse frees the design for whoever acts first. If that is the holder -- they
came back and saved or touched the canvas, and nobody took it in the meantime --
the hold is simply theirs again (``DesignStore.claim_for_write``); refusing
them was how edits were lost with nobody else anywhere near the design. If
someone else got there first, the holder's saves are refused, and ``/rescue``
keeps what they carried as a new design of the holder's own.

The compare-and-set runs inside ``_index_lock``, the same ``flock`` that already
serialises index writes, so two simultaneous takes cannot both succeed. That
holds across the several workers each API runs.

**A constraint worth knowing:** ``flock`` is per-machine. All three design tools
run on the one apps machine sharing the ``userdata`` volume, so this is sound
today. Running a design tool on a second machine against the same volume would
break the guarantee silently, and needs a different primitive.

Open to all, and the main design
--------------------------------
Two opt-in modes, both off by default so the apps that do not set them behave
exactly as before (pid-designer turns both on):

* ``open_to_all`` -- every design is editable by everyone; checkouts are what
  stop two people saving at once. ``recent_days`` then keeps the editable list
  short: other people's designs not updated within that window move to
  ``/browse``, where they can still be opened. Your own never age out.
* ``featured`` -- an admin may mark one design as the team's main one. Everyone
  can open it, it heads every list and the window never hides it, and **only an
  admin may change it**: everyone else takes a copy. Admins come from
  ``is_admin`` (see :mod:`stardesign.admins`); the default is nobody.

There is deliberately no delete endpoint: a design is editable by more than one
person, so a delete button is one misclick away from destroying a group project
with only a server-admin restore behind it. Cleanup is an admin operation on the
volume.
"""

# Deliberately NO `from __future__ import annotations`. The payload models are
# per-app, so handlers are annotated `payload: store.body_model` -- an expression
# that must evaluate to the class at definition time. Postponed evaluation would
# turn it into the string "store.body_model", which FastAPI cannot resolve to a
# type; it would silently fall back to treating the body as a query parameter and
# every POST would 422.

import fcntl
import json
import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from stardesign import directory
from stardesign.userdata import UserData, slug_user, slugify


@dataclass
class DesignStore:
    """One app's binding of the shared design machinery.

    ``empty_payload`` and ``payload_of`` are what let one router serve both the
    ``{"config": ...}`` apps and pid-designer's ``{"nodes": ..., "edges": ...}``:
    everything else here treats a payload as an opaque JSON dict.
    """

    ud: UserData
    backend: object                       #: stardesign.storage backend

    #: Request bodies. Per-app, because the shape genuinely differs; everything
    #: else in the router treats a payload as an opaque JSON dict.
    body_model: type[BaseModel]           #: autosave + flush
    create_model: type[BaseModel]         #: POST "" (name, and an optional seed)
    release_model: type[BaseModel]        #: POST /{id}/release
    #: A body/create payload -> the dict to store.
    to_data: Callable[[BaseModel], dict]
    #: A release payload -> the dict to snapshot, or None to snapshot the
    #: current working copy instead.
    release_body: Callable[[BaseModel], dict | None]

    noun: str = "design"                  #: user-facing singular, e.g. "diagram"
    default_slug: str = "design"          #: id stem when a name slugifies to nothing
    micro_interval: int = 300             #: seconds between throttled snapshots
    #: How long a checkout survives without a save. Expiry is evaluated lazily,
    #: when someone tries to take the design -- no reaper, and exactly as correct
    #: for the only question that matters ("can two people hold it at once?").
    #:
    #: 15 minutes, not 5: a save is what refreshes this, and reading a result or
    #: thinking about one is not saving. At 5 minutes an ordinary pause cost you
    #: the design. It stays finite because release is holder-only and the
    #: on-close beacon is best-effort, so this is the only thing that frees a
    #: checkout after a crash or a power cut.
    lock_ttl: int = 900
    #: An empty document body, used when creating and as a fallback on /load.
    empty_payload: Callable[[], dict] = lambda: {"config": {}}
    #: Every design editable by everyone, not just its creator and share list.
    open_to_all: bool = False
    #: With ``open_to_all``: other people's designs not updated in this many days
    #: leave the editable list for ``/browse``. None keeps them all listed.
    recent_days: int | None = None
    #: Offer an admin-chosen main design that only admins may change.
    featured: bool = False
    #: Whether the caller is an admin. Nobody, unless the app says otherwise.
    is_admin: Callable[[Request], bool] = lambda request: False
    #: (owner, doc_id) -> monotonic time of the last microversion. In-process
    #: only; after a restart the worst case is one extra snapshot, which is
    #: harmless. Keyed on the design's *owner*, not the editor: two people
    #: editing one shared design must share a throttle clock, or it snapshots at
    #: twice the intended rate.
    last_micro: dict[tuple[str, str], float] = field(default_factory=dict)

    # ── the index and the checkout, callable from outside the router ─────────
    #
    # These were closures inside make_router, which meant the checkout could
    # only be enforced on the document routes. An app whose *own* routes edit
    # the design -- EngineDesign writes the live config through /api/config --
    # had no way to ask "does this caller hold it?", so the client was the only
    # gate. They live here so any router can reuse the one implementation.

    def index_path(self, user: str, *, create: bool = False) -> Path:
        return self.ud.user_dir(user, create=create) / "index.json"

    def load_index(self, user: str) -> list[dict]:
        """One user's design records. Never creates their folder -- the
        cross-user scan reads every sibling, and must not conjure a tree for
        each one."""
        p = self.index_path(user)
        if not p.is_file():
            return []
        try:
            data = json.loads(p.read_text("utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def find_record(self, owner: str, doc_id: str) -> dict | None:
        return next((r for r in self.load_index(owner) if r.get("id") == doc_id), None)

    def featured_path(self) -> Path:
        return self.ud.site_dir() / "featured.json"

    def read_featured(self) -> dict | None:
        """``{owner, id, setBy, setAt}`` for the main design, or None.

        None as well when the mode is off, or the file names a design that no
        longer exists -- a dangling pointer must not make anything read-only.
        """
        if not self.featured:
            return None
        try:
            data = json.loads(self.featured_path().read_text("utf-8"))
        except (OSError, ValueError, RuntimeError):
            return None
        if not isinstance(data, dict) or not data.get("owner") or not data.get("id"):
            return None
        owner, doc_id = str(data["owner"]), str(data["id"])
        if self.find_record(owner, doc_id) is None:
            return None
        return {**data, "owner": owner, "id": doc_id}

    def write_featured(self, data: dict | None) -> None:
        """Set (or, with None, clear) the main design. Atomic, like the index."""
        p = self.featured_path()
        if data is None:
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            return
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

    def lock_holder(self, record: dict) -> str | None:
        """Whoever currently holds the design, or None if it is free.

        A checkout with no save inside ``lock_ttl`` is treated as free. Expiry is
        decided here, on read, rather than by a background sweep -- which means
        there is no window where a record says "held" and the answer to "may I
        take it?" disagrees.
        """
        holder = record.get("lockedBy")
        if not holder:
            return None
        beat = record.get("lockHeartbeat") or record.get("lockedAt")
        if not beat:
            return None
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(beat)).total_seconds()
        except (TypeError, ValueError):
            return None  # unparseable timestamp: treat as free rather than wedge the design
        return str(holder) if age < self.lock_ttl else None

    def require_lock_on(self, record: dict, doc_id: str, viewer: str) -> None:
        """Refuse a content write unless ``viewer`` holds this design's checkout.

        The 423 and its wording are the contract the design bar reads: it drops
        to read-only on 423 rather than retrying into a void.
        """
        holder = self.lock_holder(record)
        if holder != viewer:
            name = record.get("name", doc_id)
            detail = (
                f"{name} is checked out by {holder}" if holder
                else f"Take {name} before saving -- your checkout has lapsed"
            )
            raise HTTPException(status_code=423, detail=detail)

    def save_index(self, user: str, index: list[dict]) -> None:
        """Write one user's index atomically (temp file + rename)."""
        p = self.index_path(user, create=True)
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
    def index_lock(self, user: str) -> Iterator[None]:
        """Serialize read-modify-write of one user's ``index.json``.

        ``save_index`` is atomic per write, but read-modify-write is not, and the
        index is edited by co-editors as well as its owner while the API runs
        several workers. Without this, two overlapping updates drop a record. The
        lock file lives beside the index and is never removed.
        """
        lock = self.ud.user_dir(user, create=True) / ".index.lock"
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def claim_for_write(self, owner: str, doc_id: str, viewer: str) -> None:
        """Let ``viewer`` write the design's content, or 423.

        Passes when ``viewer`` holds the checkout. Also passes -- and takes the
        hold back -- when the hold lapsed *on* ``viewer`` and nobody has taken
        the design since: a lapsed record keeps ``lockedBy``, any take by
        someone else overwrites it, and a release clears it, so ``lockedBy ==
        viewer`` on a free design means nobody else can have written it.

        Refusing that case was how work was lost. Step away past ``lock_ttl``,
        come back and keep editing, and every save came back 423 with nobody
        else anywhere near the design; the edits stayed on screen and nowhere
        else. A lapse still frees the design for anyone who acts first -- this
        only stops the holder from being locked out of a design nobody wanted.

        The check and the reclaim happen under the index lock, so a reclaim and
        someone else's take serialise and exactly one of them wins.
        """
        record = self.find_record(owner, doc_id)
        if record is not None and self.lock_holder(record) == viewer:
            return  # the common case, without taking the index lock
        with self.index_lock(owner):
            index = self.load_index(owner)
            for record in index:
                if record.get("id") != doc_id:
                    continue
                if self.lock_holder(record) is None and record.get("lockedBy") == viewer:
                    record["lockHeartbeat"] = datetime.now(timezone.utc).isoformat()
                    self.save_index(owner, index)
                    return
                self.require_lock_on(record, doc_id, viewer)
                return
        raise HTTPException(status_code=404, detail=f"Unknown {self.noun}")


# ── payloads that are the same in every app ──────────────────────────────────
#
# The autosave/create/release bodies differ per app (see DesignStore); these
# three do not -- a name is a name, and sharing has one shape everywhere.


class NamePayload(BaseModel):
    name: str


class CopyPayload(BaseModel):
    owner: str  # whose design to copy (email or slug)
    id: str
    name: str | None = None  # default: "<name> (copy of <owner>)"


class SharePayload(BaseModel):
    sharedWith: list[str]  # the whole list, not a delta


class FeaturedPayload(BaseModel):
    owner: str  # whose folder the design lives in (email or slug)
    id: str



def make_router(store: DesignStore, prefix: str, sub: str = "") -> APIRouter:
    """The design CRUD + sharing router for one app.

    ``prefix`` is the APIRouter prefix (e.g. ``/api/engine/documents``); ``sub``
    is an extra path segment beneath it, which only pid-designer uses -- its
    router is mounted at ``/api/pid`` and nests these routes under
    ``/diagrams`` so ``/api/pid/users`` can sit alongside them.

    Everything is defined in here as closures over ``store`` rather than as
    module-level functions taking it: the alternative is threading one more
    argument through twenty helpers, which is exactly the kind of repetition
    that lets one of them get forgotten.
    """
    router = APIRouter(prefix=prefix, tags=[store.noun + "s"])

    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()


    # ── working copy + document index (on the volume) ────────────────────────────

    def _index_path(user: str, *, create: bool = False) -> Path:
        return store.index_path(user, create=create)


    def _load_index(user: str) -> list[dict]:
        return store.load_index(user)


    def _save_index(user: str, index: list[dict]) -> None:
        store.save_index(user, index)


    def _index_lock(user: str):
        return store.index_lock(user)


    def _require_id(doc_id: str) -> str:
        """Sanitize a path-supplied id into a safe segment, or 404."""
        safe = slugify(doc_id)
        if not safe:
            raise HTTPException(status_code=404, detail=f"Unknown {store.noun}")
        return safe


    def _unique_id(user: str, name: str) -> str:
        base = slugify(name) or store.default_slug
        existing = {d["id"] for d in _load_index(user)}
        if base not in existing:
            return base
        n = 2
        while f"{base}-{n}" in existing:
            n += 1
        return f"{base}-{n}"


    def _working_path(user: str, doc_id: str) -> Path:
        return store.ud.user_dir(user) / doc_id / "current.json"


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


    def _write_base(user: str, doc_id: str, data: dict) -> None:
        """The copy's common ancestor, beside its working copy. Written once."""
        p = store.ud.user_dir(user) / doc_id / "base.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, indent=2), "utf-8")

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
        raise HTTPException(status_code=404, detail=f"Unknown {store.noun}")


    # ── sharing: who may edit which design ───────────────────────────────────────

    @dataclass(frozen=True)
    class DocRef:
        """A design the caller is allowed to act on.

        ``owner`` is the folder the design lives in -- not a privilege level. It only
        differs from ``viewer`` when someone is editing a design shared with them.
        """

        owner: str
        doc_id: str
        record: dict
        viewer: str


    def _shared_with(record: dict) -> list[str]:
        """The record's editor list. Absent on every design created before sharing
        existed, so a missing key is an empty list, never an error."""
        value = record.get("sharedWith")
        return [str(e) for e in value] if isinstance(value, list) else []


    class Access:
        """Who is asking, and the two facts about the stand-wide state that
        decide what they may touch. Built once per request: ``admin`` may be a
        network call, so it is asked at most once, and only if a decision
        actually turns on it."""

        def __init__(self, request: Request) -> None:
            self.request = request
            self.viewer = store.ud.current_user(request)
            main = store.read_featured()
            self.main = (main["owner"], main["id"]) if main else None
            self._admin: bool | None = None

        @property
        def admin(self) -> bool:
            if self._admin is None:
                self._admin = bool(store.is_admin(self.request))
            return self._admin

        def is_main(self, owner: str, doc_id: str) -> bool:
            return self.main == (owner, doc_id)

    def _can_edit(record: dict, owner: str, access: "Access") -> bool:
        """Emails are stored as written, compared as path slugs -- the same
        normalization ``current_user`` applies, so the two always line up.

        The main design is checked first and overrides everything else: not
        even its creator may change it without being an admin.
        """
        if access.is_main(owner, record.get("id")):
            return access.admin
        if store.open_to_all or access.viewer == owner:
            return True
        return any(slug_user(e) == access.viewer for e in _shared_with(record))

    def _can_view(record: dict, owner: str, access: "Access") -> bool:
        """Open it in the editor, read-only if need be. The main design is
        viewable by everyone; anything else, only by those who can edit it --
        which with ``featured`` off is exactly the old rule."""
        return access.is_main(owner, record.get("id")) or _can_edit(record, owner, access)


    def _find_record(owner: str, doc_id: str) -> dict | None:
        return store.find_record(owner, doc_id)


    def _resolve_doc(
        request: Request,
        owner: str | None,
        doc_id: str,
        *,
        need: str = "edit",
    ) -> DocRef:
        """Resolve ``(?owner=, doc_id)`` into a design the caller may act on.

        The single place cross-user access is granted. ``need="read"`` is for the
        two endpoints that exist to look at other people's work (browse and copy);
        ``"view"`` is for looking at a design in the editor (load, history,
        releases, who holds it) -- the main design is viewable by all; and
        everything else needs ``"edit"``, which means being the owner or on the
        share list (or anyone, with ``open_to_all``), and an admin for the main
        design.

        Returning the resolved record -- rather than just a folder name -- is what
        stops a handler that omits ``?owner=`` from silently writing an orphan
        working copy into the caller's own tree. See the module docstring.
        """
        access = Access(request)
        viewer = access.viewer
        owner_slug = slug_user(owner) if owner else viewer
        doc_id = _require_id(doc_id)
        record = _find_record(owner_slug, doc_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f"Unknown {store.noun}")
        if need == "view" and not _can_view(record, owner_slug, access):
            raise HTTPException(status_code=403, detail="This design is not shared with you")
        if need == "edit" and not _can_edit(record, owner_slug, access):
            detail = (
                f"Only an admin can change the main {store.noun}. Take a copy to work on it."
                if access.is_main(owner_slug, doc_id)
                else "This design is not shared with you"
            )
            raise HTTPException(status_code=403, detail=detail)
        return DocRef(owner=owner_slug, doc_id=doc_id, record=record, viewer=viewer)


    # ── checkouts: who may save, right now ───────────────────────────────────

    def _lock_holder(record: dict) -> str | None:
        return store.lock_holder(record)

    def _lock_state(record: dict, viewer: str, names: dict[str, str]) -> dict:
        """The checkout, as the design bar wants to render it.

        ``lockExpiresAt`` is the moment the hold lapses -- beat + ``lock_ttl`` --
        not the beat itself. It used to carry the raw heartbeat, which is a time
        already in the past, so anything counting down to it read as expired the
        instant it rendered. That is why the bar never showed the user how long
        they had.
        """
        holder = _lock_holder(record)
        expires = None
        if holder:
            beat = record.get("lockHeartbeat") or record.get("lockedAt")
            if beat:
                try:
                    expires = (
                        datetime.fromisoformat(beat) + timedelta(seconds=store.lock_ttl)
                    ).isoformat()
                except (TypeError, ValueError):
                    expires = None
        # A duration as well as an instant. The instant is only meaningful to a
        # client whose clock agrees with ours, and nothing makes that true: a
        # browser on one host talking to a server on another (Windows and WSL,
        # say) can be hours apart, and the countdown then reads as hours left --
        # or, when the browser runs fast, as permanently expired. The duration
        # costs nothing and is immune to it, so it is what the bar counts down.
        remaining = None
        if expires is not None:
            remaining = max(
                0.0,
                (datetime.fromisoformat(expires) - datetime.now(timezone.utc)).total_seconds(),
            )
        return {
            "lockedBy": holder,
            "lockedByName": (names.get(holder) or holder) if holder else None,
            "lockedByMe": holder == viewer,
            "lockExpiresAt": expires,
            "lockExpiresInSeconds": remaining,
            "lockTtlSeconds": store.lock_ttl,
        }

    def _take_lock(owner: str, doc_id: str, viewer: str) -> dict:
        """Claim the design, or 423 if someone else has it.

        The compare-and-set that makes concurrent editing impossible. Re-reads
        the record *inside* the lock rather than trusting one fetched earlier,
        so two racing takes serialise and exactly one sees a free design.
        """
        now = _now_iso()
        with _index_lock(owner):
            index = _load_index(owner)
            for record in index:
                if record["id"] != doc_id:
                    continue
                holder = _lock_holder(record)
                if holder and holder != viewer:
                    raise HTTPException(
                        status_code=423,
                        detail=f"{record.get('name', doc_id)} is checked out by {holder}",
                    )
                record["lockedBy"] = viewer
                record.setdefault("lockedAt", now)
                if holder != viewer:
                    record["lockedAt"] = now
                record["lockHeartbeat"] = now
                _save_index(owner, index)
                return record
        raise HTTPException(status_code=404, detail=f"Unknown {store.noun}")

    def _release_lock(owner: str, doc_id: str, viewer: str) -> None:
        """Give the design back. Only the holder can, and it is idempotent --
        a lock that already lapsed, or was never held, is simply already free."""
        with _index_lock(owner):
            index = _load_index(owner)
            for record in index:
                if record["id"] != doc_id:
                    continue
                if _lock_holder(record) not in (None, viewer):
                    return  # someone else's now; not ours to drop
                record.pop("lockedBy", None)
                record.pop("lockedAt", None)
                record.pop("lockHeartbeat", None)
                _save_index(owner, index)
                return

    def _require_lock(ref: "DocRef") -> None:
        """Refuse a content write unless the caller holds the checkout -- or
        held it, let it lapse, and nobody has taken it since (see
        ``DesignStore.claim_for_write``).

        Applied to the endpoints that mutate the design itself. Renaming,
        sharing and copying are deliberately exempt: they are not concurrent
        editing of content, and blocking them would mean a checkout could stop
        someone tidying up a design they can see.
        """
        store.claim_for_write(ref.owner, ref.doc_id, ref.viewer)

    def _beat_lock(owner: str, doc_id: str, viewer: str) -> None:
        """Refresh the holder's checkout after a successful save.

        This is what makes "inactivity" mean *not editing* rather than *tab
        closed*, and it costs no extra request.
        """
        with _index_lock(owner):
            index = _load_index(owner)
            for record in index:
                if record["id"] == doc_id and record.get("lockedBy") == viewer:
                    record["lockHeartbeat"] = _now_iso()
                    _save_index(owner, index)
                    return

    def _scan_all() -> Iterator[tuple[str, dict]]:
        """``(owner, record)`` for every design on the shared volume.

        All the design tools mount one volume keyed by email, which is what makes
        cross-user listing a directory walk instead of a database. At team scale
        this is a few dozen small JSON reads.
        """
        for owner in store.ud.all_users():
            for record in _load_index(owner):
                if record.get("id"):
                    yield owner, record


    def _decorated_for(request: Request, ref: "DocRef", record: dict) -> dict:
        """One record, shaped exactly like the ones `list` returns.

        Every endpoint that hands a record back has to go through this. Returning
        the bare stored record instead drops `owner`/`ownerName`/`mine`, and the
        design bar reads a missing `mine` as "someone else's" -- which showed up
        as a design of your own captioned "Config 1 - undefined".
        """
        names = directory.display_names(request, store.ud)
        return _decorate(record, ref.owner, Access(request), names)

    def _decorate(record: dict, owner: str, access: "Access", names: dict[str, str]) -> dict:
        """An index record as the UI wants it: who owns it, is that me, and may
        I change it."""
        viewer = access.viewer
        return {
            **record,
            "sharedWith": _shared_with(record),
            "owner": owner,
            "ownerName": names.get(owner) or owner,
            "mine": owner == viewer,
            "editable": _can_edit(record, owner, access),
            "featured": access.is_main(owner, record.get("id")),
            # Folded in here so the design bar knows the checkout state from the
            # list it already fetches, with no extra round trip on open.
            **_lock_state(record, viewer, names),
        }


    # ── document CRUD ─────────────────────────────────────────────────────────────

    def _listed(record: dict, owner: str, access: "Access", cutoff: str | None) -> bool:
        """Whether a design belongs in the caller's list (else in ``/browse``).

        The main design always does. Otherwise it is the ones you can edit, and
        with ``recent_days`` set, other people's drop out once they go quiet --
        which only moves them to browse, where they still open. Your own, and
        ones explicitly shared with you, are never aged out.
        """
        if access.is_main(owner, record.get("id")):
            return True
        if not _can_edit(record, owner, access):
            return False
        if cutoff is None or owner == access.viewer:
            return True
        if any(slug_user(e) == access.viewer for e in _shared_with(record)):
            return True
        return (record.get("updatedAt") or "") >= cutoff

    def _cutoff() -> str | None:
        if not store.open_to_all or store.recent_days is None:
            return None
        return (datetime.now(timezone.utc) - timedelta(days=store.recent_days)).isoformat()

    @router.get(sub)
    async def list_documents(request: Request):
        """Designs the caller may edit -- their own plus any shared with them,
        or with ``open_to_all`` everyone's recent ones -- and the main design."""
        access = Access(request)
        names = directory.display_names(request, store.ud)
        cutoff = _cutoff()
        out = [
            _decorate(record, owner, access, names)
            for owner, record in _scan_all()
            if _listed(record, owner, access, cutoff)
        ]
        out.sort(key=lambda d: d.get("updatedAt") or "", reverse=True)
        # The main design heads the list, whatever its age.
        out.sort(key=lambda d: not d["featured"])
        return out


    @router.get(f"{sub}/browse")
    async def browse_documents(request: Request):
        """Everyone else's designs, grouped by owner -- the view-only tree.

        Exactly what the list leaves out: offering to copy something you can just
        open is noise. Anything listed here can be copied by anyone; that is the
        point. With ``open_to_all`` it is also where older designs live, and
        ``editable`` says they open rather than only copy.
        """
        access = Access(request)
        names = directory.display_names(request, store.ud)
        cutoff = _cutoff()
        groups: dict[str, list[dict]] = {}
        for owner, record in _scan_all():
            if _listed(record, owner, access, cutoff):
                continue
            groups.setdefault(owner, []).append({
                "id": record["id"],
                "name": record.get("name", record["id"]),
                "updatedAt": record.get("updatedAt"),
                "editable": _can_edit(record, owner, access),
            })
        return [
            {
                "owner": owner,
                "ownerName": names.get(owner) or owner,
                "designs": sorted(
                    designs, key=lambda d: d.get("updatedAt") or "", reverse=True
                ),
            }
            for owner, designs in sorted(groups.items())
        ]


    def _create(user: str, name: str, data: dict, extra: dict | None = None) -> dict:
        """Add a design to ``user``'s index and seed its working copy.

        The creator gets the checkout. Nobody else can hold a design that did not
        exist a moment ago, and the alternative is worse than it sounds: you make
        a design, start typing, and every edit is refused until you notice a
        button you had no reason to look at.
        """
        now = _now_iso()
        with _index_lock(user):
            doc_id = _unique_id(user, name)
            meta = {
                "id": doc_id,
                "name": name,
                "createdAt": now,
                "updatedAt": now,
                "sharedWith": [],
                "lockedBy": user,
                "lockedAt": now,
                "lockHeartbeat": now,
                # Reserved: with delete gone, nothing shrinks a list, and every
                # design is visible to the whole team through the view-only tree.
                # Archiving is the destroy-nothing replacement, and writing the
                # field now saves a second pass over everyone's index later.
                "archived": False,
                **(extra or {}),
            }
            index = _load_index(user)
            index.append(meta)
            _save_index(user, index)
        _write_working(user, doc_id, data)
        return meta


    @router.post(sub)
    async def create_document(request: Request, payload: store.create_model):
        """Create a new design owned by the caller, seeded with an optional config."""
        user = store.ud.current_user(request)
        meta = _create(user, payload.name.strip() or "Untitled", store.to_data(payload))
        names = directory.display_names(request, store.ud)
        return _decorate(meta, user, Access(request), names)


    @router.post(f"{sub}/copy")
    async def copy_document(request: Request, payload: CopyPayload):
        """Copy any design -- yours or anyone else's -- into the caller's own list.

        Deliberately not gated on sharing: every design is viewable and copyable by
        anyone, which is what the view-only tree offers. What a copy does *not*
        inherit is history, releases, or the share list. It is a new design that
        happens to start from someone else's state, so editing it can never affect
        the original.
        """
        viewer = store.ud.current_user(request)
        ref = _resolve_doc(request, payload.owner, payload.id, need="read")
        data = _read_working(ref.owner, ref.doc_id)
        if data is None:
            data = store.backend.latest_micro(ref.owner, ref.doc_id) or store.empty_payload()
        names = directory.display_names(request, store.ud)
        who = names.get(ref.owner) or ref.owner
        source = ref.record.get("name", ref.doc_id)
        name = (payload.name or "").strip() or f"{source} (copy of {who})"
        # With ``featured`` on, a copy remembers where it came from and what that
        # looked like at the moment it was taken. That snapshot is the common
        # ancestor a later merge back into the main design needs; without it a
        # merge cannot tell "I deleted this" from "they added it".
        extra = None
        if store.featured:
            extra = {"copiedFrom": {"owner": ref.owner, "id": ref.doc_id, "name": source,
                                    "at": _now_iso()}}
        meta = _create(viewer, name, data, extra)
        if store.featured:
            _write_base(viewer, meta["id"], data)
        return _decorate(meta, viewer, Access(request), names)

    @router.post(f"{sub}/{{doc_id}}/rescue")
    async def rescue_document(
        request: Request, doc_id: str, payload: store.body_model, owner: str | None = None
    ):
        """Keep edits the design refused, as a new design of the caller's own.

        A save comes back 423 when the checkout has gone to someone else. The
        edits that save carried exist nowhere but the caller's screen, and the
        two things they do next -- "Take it back", which reloads the shared
        copy, or closing the tab -- both throw them away. The client posts them
        here first. Nothing is merged into the shared design (that would be the
        overwrite checkouts prevent); the caller gets a design with exactly what
        they had, named after the one it came from, checked out to them.

        Read access is enough: someone unshared mid-edit lost write access too,
        and their work is still theirs.
        """
        viewer = store.ud.current_user(request)
        ref = _resolve_doc(request, owner, doc_id, need="read")
        source = ref.record.get("name", ref.doc_id)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        name = f"{source} (unsaved changes, {stamp})"
        names = directory.display_names(request, store.ud)
        return _decorate(
            _create(viewer, name, store.to_data(payload)), viewer, Access(request), names
        )


    @router.patch(f"{sub}/{{doc_id}}")
    async def rename_document(
        request: Request, doc_id: str, payload: NamePayload, owner: str | None = None
    ):
        """Rename a design. The id (and all storage keys) stay fixed."""
        ref = _resolve_doc(request, owner, doc_id)
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")
        return _decorated_for(
            request, ref, _mutate_record(ref.owner, ref.doc_id, name=name, updatedAt=_now_iso())
        )


    # ── sharing ──────────────────────────────────────────────────────────────────

    @router.put(f"{sub}/{{doc_id}}/share")
    async def share_document(
        request: Request, doc_id: str, payload: SharePayload, owner: str | None = None
    ):
        """Replace the design's editor list.

        Takes the whole list rather than an add/remove delta, so two editors
        changing shares at the same time converge on one of their two lists instead
        of interleaving into a third nobody chose.

        Any editor may change it, including removing others. There is no
        owner/editor distinction to appeal to -- the "owner" is just whoever clicked
        New -- and a removed editor can still read and copy the design anyway, so
        this is housekeeping, not a security boundary. ``sharedUpdatedBy`` records
        who last touched it.
        """
        ref = _resolve_doc(request, owner, doc_id)
        seen: set[str] = set()
        emails: list[str] = []
        for raw in payload.sharedWith:
            email = str(raw).strip().lower()
            slug = slug_user(email) if email else ""
            # The owner is never on their own share list; that asymmetry is what
            # makes them the one person who cannot be removed from a design.
            if not email or slug == ref.owner or slug in seen:
                continue
            seen.add(slug)
            emails.append(email)
        return _decorated_for(
            request,
            ref,
            _mutate_record(
                ref.owner,
                ref.doc_id,
                sharedWith=emails,
                sharedUpdatedBy=ref.viewer,
                sharedUpdatedAt=_now_iso(),
            ),
        )


    @router.delete(f"{sub}/{{doc_id}}/share/me")
    async def leave_document(request: Request, doc_id: str, owner: str | None = None):
        """Remove yourself from a design someone shared with you.

        With delete gone this is the only thing that shrinks your list, and it
        destroys nothing: the design stays exactly where it is and you can copy it
        back out of the view-only tree whenever you like. The owner cannot leave --
        the design would end up in nobody's editable list.
        """
        ref = _resolve_doc(request, owner, doc_id)
        if ref.owner == ref.viewer:
            raise HTTPException(
                status_code=400,
                detail="You own this design, so you cannot leave it.",
            )
        remaining = [
            e for e in _shared_with(ref.record) if slug_user(e) != ref.viewer
        ]
        _mutate_record(
            ref.owner,
            ref.doc_id,
            sharedWith=remaining,
            sharedUpdatedBy=ref.viewer,
            sharedUpdatedAt=_now_iso(),
        )
        return {"ok": True}


    # ── checkouts ────────────────────────────────────────────────────────────

    @router.post(f"{sub}/{{doc_id}}/checkout")
    async def take_checkout(request: Request, doc_id: str, owner: str | None = None):
        """Take the design's write token, or 423 if someone else has it.

        423 rather than 409 on purpose: ``create_release`` already returns 409
        for "that label exists", and the two are surfaced differently in the UI.

        Note this is *not* called on open -- viewing a design must never block a
        colleague. The client calls it when the user presses Take.
        """
        ref = _resolve_doc(request, owner, doc_id)
        record = _take_lock(ref.owner, ref.doc_id, ref.viewer)
        names = directory.display_names(request, store.ud)
        return _lock_state(record, ref.viewer, names)

    @router.delete(f"{sub}/{{doc_id}}/checkout")
    async def release_checkout(request: Request, doc_id: str, owner: str | None = None):
        """Give the token back. Idempotent, and the target of the on-close beacon
        -- which is best-effort, so ``lock_ttl`` remains the real backstop."""
        ref = _resolve_doc(request, owner, doc_id)
        _release_lock(ref.owner, ref.doc_id, ref.viewer)
        return {"ok": True}

    @router.post(f"{sub}/{{doc_id}}/checkout/release")
    async def release_checkout_beacon(
        request: Request, doc_id: str, owner: str | None = None
    ):
        """Release, reachable by ``navigator.sendBeacon`` on tab close.

        A separate route only because a beacon can only ever POST -- it cannot
        issue the DELETE above. Same effect, and equally idempotent. Nothing can
        read a beacon's response, so this is best-effort: the inactivity timeout
        is what actually guarantees an abandoned checkout is freed.
        """
        ref = _resolve_doc(request, owner, doc_id)
        _release_lock(ref.owner, ref.doc_id, ref.viewer)
        return {"ok": True}

    @router.post(f"{sub}/{{doc_id}}/checkout/beat")
    async def beat_checkout(request: Request, doc_id: str, owner: str | None = None):
        """Refresh your own hold without writing anything.

        Until this existed the only thing that refreshed a checkout was a
        successful ``/autosave``, so "inactivity" meant "no change to the saved
        payload" rather than "not working". Reading a result, panning a canvas,
        measuring something or thinking about it all counted as idle, and the
        design was taken out from under you mid-task. The client sends this while
        you are actually interacting; it is deliberately content-free so it can
        never race an autosave or churn a microversion.

        423 if you do not hold it -- the client treats that as "you lost it" and
        stops, rather than beating into a void.
        """
        ref = _resolve_doc(request, owner, doc_id)
        _require_lock(ref)
        _beat_lock(ref.owner, ref.doc_id, ref.viewer)
        record = store.find_record(ref.owner, ref.doc_id) or ref.record
        names = directory.display_names(request, store.ud)
        return _lock_state(record, ref.viewer, names)

    @router.get(f"{sub}/{{doc_id}}/checkout")
    async def get_checkout(request: Request, doc_id: str, owner: str | None = None):
        """Who holds it right now. Polled by the bar while you do not, so that
        Take lights up on its own when the holder finishes."""
        ref = _resolve_doc(request, owner, doc_id, need="view")
        names = directory.display_names(request, store.ud)
        return _lock_state(ref.record, ref.viewer, names)

    # ── working copy: load + autosave ────────────────────────────────────────────

    @router.get(f"{sub}/{{doc_id}}/load")
    async def load_document(request: Request, doc_id: str, owner: str | None = None):
        """Load the freshest state: the working copy.

        Falls back to the latest microversion only if the working copy is missing (a
        fresh or lost volume) -- self-healing. Never silently returns an older
        snapshot otherwise; that is what /history is for.
        """
        ref = _resolve_doc(request, owner, doc_id, need="view")
        data = _read_working(ref.owner, ref.doc_id)
        if data is None:
            data = store.backend.latest_micro(ref.owner, ref.doc_id)
            if data is not None:
                _write_working(ref.owner, ref.doc_id, data)  # rehydrate the volume
        return data or store.empty_payload()


    @router.post(f"{sub}/{{doc_id}}/autosave")
    async def autosave_document(
        request: Request, doc_id: str, payload: store.body_model, owner: str | None = None
    ):
        """Write the working copy; snapshot a microversion only once per store.micro_interval.

        A design shared with several people is last-write-wins here, on purpose --
        checkouts are the next piece of work. A client that is autosaving a design
        it has just been unshared from gets a 403, which is its cue to stop.
        """
        ref = _resolve_doc(request, owner, doc_id)
        _require_lock(ref)
        data = store.to_data(payload)
        _write_working(ref.owner, ref.doc_id, data)
        _beat_lock(ref.owner, ref.doc_id, ref.viewer)

        micro = False
        key = (ref.owner, ref.doc_id)
        now = time.monotonic()
        if now - store.last_micro.get(key, 0.0) >= store.micro_interval:
            try:
                store.backend.snapshot_micro(ref.owner, ref.doc_id, data)
                store.last_micro[key] = now
                _touch_index(ref.owner, ref.doc_id)
                micro = True
            except Exception:
                # Never let a snapshot failure lose the edit -- the working copy is
                # already saved. Retry on the next autosave.
                pass
        return {"ok": True, "micro": micro}


    @router.post(f"{sub}/{{doc_id}}/flush")
    async def flush_document(
        request: Request, doc_id: str, payload: store.body_model, owner: str | None = None
    ):
        """Force an immediate microversion. Target of the on-close sendBeacon.

        The body is an *override*, not the source of truth. It is honoured only
        when it actually carries a document; an empty one falls back to the
        working copy already on disk.

        That asymmetry is the whole point. This endpoint is the target of a
        page-unload `sendBeacon`, which is the single request in the system most
        likely to arrive truncated, retried, or synthesised by something that is
        not the editor -- and the body model defaults every field to empty, so a
        body of `{}` validates perfectly. Before this, `POST /flush {}` replaced
        the working copy with nothing, snapshotted the nothing into history, and
        returned `{"ok": true}`. A diagram could be destroyed by a request that
        looked, from the client side, like a successful save.

        Emptying a design deliberately still works: that is `autosave`, which is
        a foreground request the editor makes on purpose after a Clear.
        """
        ref = _resolve_doc(request, owner, doc_id)
        _require_lock(ref)
        data = store.to_data(payload)
        if data == store.empty_payload():
            data = _read_working(ref.owner, ref.doc_id) or data
        _write_working(ref.owner, ref.doc_id, data)
        try:
            store.backend.snapshot_micro(ref.owner, ref.doc_id, data)
            store.last_micro[(ref.owner, ref.doc_id)] = time.monotonic()
            _touch_index(ref.owner, ref.doc_id)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Snapshot failed: {e}")
        return {"ok": True}


    # ── microversion history ─────────────────────────────────────────────────────

    @router.get(f"{sub}/{{doc_id}}/history")
    async def get_history(request: Request, doc_id: str, owner: str | None = None):
        """Recent automatic microversions, newest first."""
        ref = _resolve_doc(request, owner, doc_id, need="view")
        return store.backend.list_micro(ref.owner, ref.doc_id)


    @router.get(f"{sub}/{{doc_id}}/version/{{version_id}}")
    async def get_version(
        request: Request, doc_id: str, version_id: str, owner: str | None = None
    ):
        """Fetch one microversion (for preview/restore). Does not touch the working copy."""
        ref = _resolve_doc(request, owner, doc_id, need="view")
        data = store.backend.get_micro(ref.owner, ref.doc_id, version_id)
        if data is None:
            raise HTTPException(status_code=404, detail="Version not found")
        return data


    # ── releases ─────────────────────────────────────────────────────────────────

    @router.post(f"{sub}/{{doc_id}}/release")
    async def create_release(
        request: Request, doc_id: str, payload: store.release_model, owner: str | None = None
    ):
        """Publish the current state as an immutable named release (e.g. "0.1")."""
        ref = _resolve_doc(request, owner, doc_id)
        _require_lock(ref)
        label = slugify(payload.label)
        if not label:
            raise HTTPException(status_code=400, detail="A version label is required")

        # A release either carries a body to snapshot, or says "snapshot what is
        # already saved". Which is which is app-specific -- the payload shapes
        # differ -- so the store decides.
        supplied = store.release_body(payload)
        if supplied is not None:
            data = supplied
            _write_working(ref.owner, ref.doc_id, data)
        else:
            data = _read_working(ref.owner, ref.doc_id) or store.empty_payload()

        try:
            meta = store.backend.create_release(ref.owner, ref.doc_id, label, data)
        except FileExistsError:
            raise HTTPException(status_code=409, detail=f"Release '{label}' already exists")
        _touch_index(ref.owner, ref.doc_id)
        return meta


    @router.get(f"{sub}/{{doc_id}}/releases")
    async def list_releases(request: Request, doc_id: str, owner: str | None = None):
        """Published releases, newest first."""
        ref = _resolve_doc(request, owner, doc_id, need="view")
        return store.backend.list_releases(ref.owner, ref.doc_id)


    @router.get(f"{sub}/{{doc_id}}/release/{{label}}")
    async def get_release(
        request: Request, doc_id: str, label: str, owner: str | None = None
    ):
        """Fetch one release snapshot (for preview/restore)."""
        ref = _resolve_doc(request, owner, doc_id, need="view")
        data = store.backend.get_release(ref.owner, ref.doc_id, slugify(label))
        if data is None:
            raise HTTPException(status_code=404, detail="Release not found")
        return data

    # ── the main design ──────────────────────────────────────────────────

    if store.featured:

        @router.get(f"{sub}/featured")
        async def get_featured(request: Request):
            """The main design, and whether the caller may choose it."""
            access = Access(request)
            main = store.read_featured()
            if main is not None:
                names = directory.display_names(request, store.ud)
                main = {**main, "ownerName": names.get(main["owner"]) or main["owner"]}
            return {
                "featured": main,
                "isAdmin": access.admin,
                # So the UI can say "older than N days" without hardcoding N.
                "recentDays": store.recent_days if store.open_to_all else None,
            }

        def _require_admin(request: Request) -> str:
            access = Access(request)
            if not access.admin:
                raise HTTPException(
                    status_code=403, detail=f"Only an admin can choose the main {store.noun}"
                )
            return access.viewer

        @router.put(f"{sub}/featured")
        async def set_featured(request: Request, payload: FeaturedPayload):
            """Make a design the main one. Admins only."""
            viewer = _require_admin(request)
            ref = _resolve_doc(request, payload.owner, payload.id, need="read")
            data = {"owner": ref.owner, "id": ref.doc_id, "setBy": viewer, "setAt": _now_iso()}
            store.write_featured(data)
            return {"featured": data, "isAdmin": True}

        @router.delete(f"{sub}/featured")
        async def clear_featured(request: Request):
            """No main design. Admins only."""
            _require_admin(request)
            store.write_featured(None)
            return {"featured": None, "isAdmin": True}

    return router
