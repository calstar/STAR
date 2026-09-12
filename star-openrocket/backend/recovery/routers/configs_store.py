"""Per-user named config library. `/api/configs` CRUD.

The stored payload is a `UiConfig` (the vehicle + devices + corners + sweeps a
session builds -- see frontend/src/lib/persist.ts). Unit preferences are NOT
here; they belong to whoever is at the machine, not to a saved design, and live
under /api/settings.

Identity is X-Auth-Email (from Caddy) with a `local` dev fallback -- there is no
gating here, only whose folder to use. See backend/userdata.py.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.recovery import userdata

router = APIRouter(prefix="/api/configs", tags=["configs"])


class SaveRequest(BaseModel):
    name: str
    config: dict  # a UiConfig; validated when it is loaded and simulated, not here


@router.get("")
def list_configs(request: Request):
    """Saved configs for the caller, newest first (metadata only)."""
    return {"configs": userdata.list_configs(userdata.current_user(request))}


@router.get("/{slug}")
def get_config(slug: str, request: Request):
    blob = userdata.read_config(userdata.current_user(request), slug)
    if blob is None:
        raise HTTPException(status_code=404, detail="No saved config by that name.")
    return blob


@router.post("")
def save_config(body: SaveRequest, request: Request):
    """Create or overwrite a named config for the caller."""
    try:
        return userdata.write_config(
            userdata.current_user(request), body.name, body.config
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{slug}")
def delete_config(slug: str, request: Request):
    if not userdata.delete_config(userdata.current_user(request), slug):
        raise HTTPException(status_code=404, detail="No saved config by that name.")
    return {"status": "deleted", "slug": slug}
