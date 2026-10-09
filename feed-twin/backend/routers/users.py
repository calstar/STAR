"""``GET /api/twin/users`` -- who a stand can be shared with."""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend import directory

router = APIRouter(prefix="/api/twin", tags=["users"])


@router.get("/users")
async def list_users(request: Request) -> list[dict[str, str]]:
    """The share picker's options. Never fails: an unreachable auth service
    degrades to whoever already has stands on the volume."""
    return directory.roster(request)
