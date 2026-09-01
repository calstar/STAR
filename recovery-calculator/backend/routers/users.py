"""``GET /api/recovery/users`` -- who a design can be shared with.

A thin route over :mod:`backend.directory`; that module documents where the
roster comes from, why it is a union of two sources, and why the outbound call
to auth is not an SSRF hole.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend import directory

router = APIRouter(prefix="/api/recovery", tags=["users"])


@router.get("/users")
async def list_users(request: Request):
    """The share picker's options. Never fails: an unreachable auth service
    degrades to whoever already has designs on the volume."""
    return directory.roster(request)
