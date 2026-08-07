"""Per-user named config library. `/api/configs` CRUD.

The stored payload is an engine design: `{"input": <PintleEngineConfig>,
"output": <last results>}`. The store itself is payload-agnostic -- the frontend
decides what goes in; load hands the blob back and the UI rehydrates it.

Identity is X-Auth-Email (from Caddy) with a `local` dev fallback -- there is no
gating here, only whose folder to use. See backend/userdata.py.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend import userdata

router = APIRouter(prefix="/api/configs", tags=["configs"])


class SaveRequest(BaseModel):
    name: str
    config: dict  # {"input": ..., "output": ...}; not validated here


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
