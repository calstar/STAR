"""Stands: a whole test set-up as one shared, versioned document.

A stand is everything a run depends on that is not the code:

* the drawing and the engine (library artifact ids -- content hashes, so a
  version of the stand names exact bytes);
* the fluid set and the state machine;
* every Configuration-tab setting (``setup``, as ``wire_setup`` keys);
* the hookup (valve pins and knobs);
* the operating point -- where T-0 is: tank pressure, bottle fill, loads,
  how long it has been loaded;
* the console's view -- which transducers, tanks and valves it shows and in
  what order (``{hidden: {pts, tanks, actuators}, order: {pts, tanks}}``,
  drawing ids), so a stand reopened anywhere looks the way it was left.

Kept in :mod:`stardesign.documents`, the store pid-designer and EngineDesign
already use: an owner, a share list, a checkout so two people do not edit one
stand at once, automatic microversions while it is worked on and named,
immutable releases ("TRR rev B"). A run records the stand version it ran on,
so "what did we fire" has one answer a year later.
"""

from __future__ import annotations

import os
from typing import Any

from pydantic import BaseModel, Field
from stardesign.documents import DesignStore, make_router

from backend import storage, userdata

#: The payload's keys, and what an empty stand holds for each.
EMPTY: dict[str, Any] = {
    "diagram": "",
    "engine": "",
    "fluid_set": "hotfire",
    "machine": "diablo",
    "setup": {},
    "hookup": {},
    "operating_point": {},
    "console": {},
    "notes": "",
}


class StandPayload(BaseModel):
    diagram: str = ""
    engine: str = ""
    fluid_set: str = "hotfire"
    machine: str = "diablo"
    setup: dict[str, Any] = Field(default_factory=dict)
    hookup: dict[str, Any] = Field(default_factory=dict)
    operating_point: dict[str, Any] = Field(default_factory=dict)
    console: dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class CreatePayload(StandPayload):
    name: str


class ReleasePayload(BaseModel):
    label: str
    stand: StandPayload | None = None
    """Snapshot this; omitted, the release is the saved working copy."""


def to_data(payload: Any) -> dict[str, Any]:
    """Every key, always: the store's empty-flush guard compares against
    :data:`EMPTY` (stardesign documents.py)."""
    return {key: getattr(payload, key, default) for key, default in EMPTY.items()}


def _release_body(payload: ReleasePayload) -> dict[str, Any] | None:
    return to_data(payload.stand) if payload.stand is not None else None


store = DesignStore(
    ud=userdata.store,
    backend=storage.backend,
    body_model=StandPayload,
    create_model=CreatePayload,
    release_model=ReleasePayload,
    to_data=to_data,
    release_body=_release_body,
    noun="stand",
    default_slug="stand",
    micro_interval=int(os.environ.get("FEEDTWIN_MICRO_INTERVAL", "300")),
    empty_payload=lambda: dict(EMPTY),
)

router = make_router(store, prefix="/api/twin", sub="/stands")
