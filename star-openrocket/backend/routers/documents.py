"""Per-user designs with sharing, microversion history and releases.

A thin binding of :mod:`stardesign.documents` -- the router shared by all the
design tools -- to this app's payload shape and route prefix. Everything of
substance, including ``_resolve_doc`` (the one place cross-user access is
granted), lives there.

A design here is the *whole* unified config: the rocket the viewer builds from
CAD plus the recovery slice the Recovery tab edits, saved and versioned as one
document. The client-side localStorage autosave (frontend/src/lib/persist.ts)
stays as the instant working cache; this server store is the durable, versioned
timeline.
"""

from __future__ import annotations

import os

from pydantic import BaseModel

from stardesign.documents import (  # noqa: F401  (re-exported for callers)
    CopyPayload,
    DesignStore,
    NamePayload,
    SharePayload,
    make_router,
)

from backend import storage, userdata


class ConfigPayload(BaseModel):
    config: dict


class CreatePayload(BaseModel):
    name: str
    config: dict | None = None  # seed the working copy; {} if omitted


class ReleasePayload(BaseModel):
    label: str
    config: dict | None = None  # snapshot this; else the current working copy


store = DesignStore(
    ud=userdata.store,
    backend=storage.backend,
    body_model=ConfigPayload,
    create_model=CreatePayload,
    release_model=ReleasePayload,
    to_data=lambda p: {"config": getattr(p, "config", None) or {}},
    release_body=lambda p: None if p.config is None else {"config": p.config},
    noun="design",
    default_slug="design",
    # Seconds between automatic microversion snapshots for one design while it
    # is being actively autosaved. The on-close /flush ignores this.
    micro_interval=int(os.environ.get("OPENROCKET_MICRO_INTERVAL", "300")),
    empty_payload=lambda: {"config": {}},
)

router = make_router(store, prefix="/api/documents")
