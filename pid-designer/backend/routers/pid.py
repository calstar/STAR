"""Per-user P&ID diagrams with sharing, microversion history and releases.

A thin binding of :mod:`stardesign.documents` -- the router shared by all three
design tools -- to this app's payload shape and route prefix. Everything of
substance, including ``_resolve_doc`` (the one place cross-user access is
granted), lives there.

Three things are particular to this app. It runs curated: admins -- the fixed
list in :mod:`stardesign.admins` -- choose the STAR diagrams everyone sees, one
of which may be the main one a new tab opens on. Everyone else sees their own
diagrams and those shared with them; admins see everything. A diagram is edited
by its creator, whoever it is shared with, and admins; anyone who can see it may
ask to edit, and its creator or an admin approves. The payload
is a graph (``{"nodes": [...], "edges": [...]}``) rather than a config blob; and
the router
is mounted at ``/api/pid`` with the design routes nested under ``/diagrams``, so
``/api/pid/users`` can sit alongside them.
"""

from __future__ import annotations

import os

from pydantic import BaseModel

from stardesign import admins
from stardesign.documents import (  # noqa: F401  (re-exported for callers)
    CopyPayload,
    DesignStore,
    FeaturedPayload,
    NamePayload,
    SharePayload,
    make_router,
)

from backend import storage, userdata


class DiagramPayload(BaseModel):
    nodes: list = []
    edges: list = []


class CreatePayload(BaseModel):
    name: str


class ReleasePayload(BaseModel):
    label: str
    nodes: list | None = None  # snapshot this; else the current working copy
    edges: list | None = None


def _release_body(p: ReleasePayload) -> dict | None:
    """A release either carries a graph or says "snapshot what is saved"."""
    if p.nodes is None and p.edges is None:
        return None
    return {"nodes": p.nodes or [], "edges": p.edges or []}


store = DesignStore(
    ud=userdata.store,
    backend=storage.backend,
    body_model=DiagramPayload,
    create_model=CreatePayload,
    release_model=ReleasePayload,
    to_data=lambda p: {"nodes": getattr(p, "nodes", None) or [],
                       "edges": getattr(p, "edges", None) or []},
    release_body=_release_body,
    noun="diagram",
    default_slug="diagram",
    # Seconds between automatic microversion snapshots for one diagram while it
    # is being actively autosaved. The on-close /flush ignores this.
    micro_interval=int(os.environ.get("PID_MICRO_INTERVAL", "300")),
    empty_payload=lambda: {"nodes": [], "edges": []},
    featured=True,
    # The main diagram is edited like any other STAR one: its creator, whoever
    # was approved, and admins.
    main_admin_only=False,
    curated=True,
    is_admin=lambda request: admins.is_admin(request, userdata.store),
)

router = make_router(store, prefix="/api/pid", sub="/diagrams")
