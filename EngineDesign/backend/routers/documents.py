"""Per-user engine designs with sharing, microversion history and named releases.

A thin binding of :mod:`stardesign.documents` -- the router shared by all three
design tools -- to this app's payload shape and route prefix. Everything of
substance, including ``_resolve_doc`` (the one place cross-user access is
granted), lives there.

The payload here is ``{"config": <dict>, "ui": <dict>}``; pid-designer's is
``{nodes, edges}``. That, the prefix, and the noun are the whole difference.

``ui`` carries the authored state that is not in ``PintleEngineConfig`` -- the
controller commands, the time-series pressure profiles, Layer 4's vehicle
definition, the layer run settings, the plot definition. It is opaque here, as
the config is: the frontend owns its shape (see frontend/src/lib/designState.ts).
It defaults to ``{}`` so every design stored before it existed still loads.
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
    ui: dict = {}


class CreatePayload(BaseModel):
    name: str
    config: dict | None = None  # seed the working copy; {} if omitted
    ui: dict | None = None


class ReleasePayload(BaseModel):
    label: str
    config: dict | None = None  # snapshot this; else the current working copy
    ui: dict | None = None


store = DesignStore(
    ud=userdata.store,
    backend=storage.backend,
    body_model=ConfigPayload,
    create_model=CreatePayload,
    release_model=ReleasePayload,
    to_data=lambda p: {
        "config": getattr(p, "config", None) or {},
        "ui": getattr(p, "ui", None) or {},
    },
    release_body=lambda p: (
        None if p.config is None else {"config": p.config, "ui": p.ui or {}}
    ),
    noun="design",
    default_slug="design",
    # Seconds between automatic microversion snapshots for one design while it
    # is being actively autosaved. The on-close /flush ignores this.
    micro_interval=int(os.environ.get("ENGINE_MICRO_INTERVAL", "300")),
    empty_payload=lambda: {"config": {}, "ui": {}},
)

router = make_router(store, prefix="/api/engine/documents")

# Deliberately no module-level MICRO_INTERVAL / _last_micro aliases: an int copy
# would look patchable in a test and silently not be, since the router reads
# `store.micro_interval`. Tests patch the store.
