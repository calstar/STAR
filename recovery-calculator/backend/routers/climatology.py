"""GET /api/climatology. Serves the site-climatology bundle.

This is climatology, not simulation output -- it does not change when the user
edits a vehicle -- so the frontend also compiles a copy in and works with no
backend at all. This route serves the identical shape, so the components do not
change either way.

The generator is `site-climatology/export_json.py`, which belongs to the
atmosphere work. This router only reads what it wrote; it never regenerates,
and it never reaches the network.
"""

import json
import os

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api", tags=["climatology"])

# backend/routers/climatology.py -> backend/routers -> backend ->
# recovery-calculator. Three dirnames land on the project root itself, so the
# paths below must NOT repeat "recovery-calculator" -- doing so pointed every
# candidate at recovery-calculator/recovery-calculator/... and made this route
# a guaranteed 404.
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Where export_json.py writes, then the frontend's committed copy as a
# fallback. Preferring the generated file means a re-export is visible without
# rebuilding the frontend; falling back means a fresh checkout still works.
_CANDIDATES = (
    os.path.join(_ROOT, "site-climatology", "data", "climatology.json"),
    os.path.join(_ROOT, "site-climatology", "climatology.json"),
    os.path.join(_ROOT, "frontend", "src", "fixtures", "climatology.json"),
)


def _locate():
    for path in _CANDIDATES:
        if os.path.isfile(path):
            return path
    return None


@router.get("/climatology")
def get_climatology():
    path = _locate()
    if path is None:
        raise HTTPException(
            status_code=404,
            detail="no climatology bundle found; run "
                   "site-climatology/export_json.py",
        )
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500,
                            detail="climatology bundle unreadable: %s" % exc) from exc
