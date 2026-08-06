"""GET/PUT /api/settings. The workstation's GUI preferences.

Which unit each quantity renders in is a property of whoever is sitting at the
machine, not of the design -- so it does NOT live in the config a user saves
and shares. A `config.json` written by someone working in feet has to load
identically for someone working in metres, which means unit choices cannot be
in it. They go here instead, in a gitignored file next to the app.

This is the only route that writes to disk, and the only state the frontend
keeps between sessions; everything else it needs is either computed per request
or compiled in.
"""

import json
import os
import tempfile
from typing import Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(prefix="/api", tags=["settings"])

# backend/routers/settings.py -> backend/routers -> backend ->
# recovery-calculator. Three dirnames land on the project root itself; see the
# same comment in climatology.py for the 404 this once caused.
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_PATH = os.path.join(_ROOT, ".gui-settings.json")

System = Optional[Literal["metric", "imperial"]]


class UnitPrefs(BaseModel):
    """One field per `Kind` in frontend/src/lib/quantities.ts.

    Spelled out rather than accepted as a free-form mapping so a typo'd key is
    a 422 the developer sees, not a preference that silently never applies.

    Every field is optional: a partial file is valid and the frontend fills the
    rest from its own defaults, which makes adding a new kind a non-event for
    anyone who already has a settings file.
    """

    # extra="forbid" matches physics/schema.py. The frontend strips unknown
    # keys when it reads, so a rejection here means the writer is wrong rather
    # than the file being stale -- and that should be loud.
    model_config = ConfigDict(extra="forbid")

    altitude: System = None
    length: System = None
    distance: System = None
    area: System = None
    mass: System = None
    speed: System = None
    accel: System = None
    force: System = None
    stiffness: System = None
    energy: System = None
    pressure: System = None
    temperature: System = None
    tempDelta: System = None  # noqa: N815 -- mirrors the TS key exactly
    density: System = None
    lapse: System = None


class Precision(BaseModel):
    """How precise every number in the GUI looks.

    Two bounds, mirroring `Precision` in frontend/src/lib/quantities.ts. The
    ranges are enforced here as well as there because a value outside them --
    a negative decimal count in particular -- reaches `Number.toFixed` in the
    browser and throws, blanking the page. A 422 is a much better failure.
    """

    model_config = ConfigDict(extra="forbid")

    maxDecimals: Optional[int] = Field(default=None, ge=0, le=10)  # noqa: N815
    minSigFigs: Optional[int] = Field(default=None, ge=1, le=6)    # noqa: N815


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    units: UnitPrefs = UnitPrefs()
    precision: Precision = Precision()


def _read():
    """The stored settings, or empty when nothing has been saved yet.

    A corrupt file returns empty rather than raising: a half-written JSON blob
    must not be able to stop the GUI from opening, and the next save overwrites
    it anyway.
    """
    try:
        with open(_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        data = {}
    # Each section independently: a file with good units and a mangled
    # precision block should still restore the units.
    return {k: (data.get(k) if isinstance(data.get(k), dict) else {})
            for k in ("units", "precision")}


@router.get("/settings")
def get_settings():
    return _read()


@router.put("/settings")
def put_settings(settings: Settings):
    """Write atomically.

    A truncate-then-write can be interrupted -- a refresh mid-request, a
    dev.sh restart -- and leave a half-written file. `_read` tolerates that,
    but only by discarding the user's preferences, so do not produce it: write
    a sibling temp file and rename, which is atomic on POSIX.

    Unset kinds are dropped rather than stored as null, so the file says only
    what the user actually chose.
    """
    body = {
        "units": {k: v for k, v in settings.units.model_dump().items()
                  if v is not None},
        "precision": {k: v for k, v in settings.precision.model_dump().items()
                      if v is not None},
    }
    fd, tmp = tempfile.mkstemp(dir=_ROOT, prefix=".gui-settings-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(body, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp, _PATH)
    except BaseException:
        # Never leave the temp file behind on a failed write.
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return body
