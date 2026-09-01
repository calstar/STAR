"""Who a recovery config can be shared with: the team roster.

A thin binding of :mod:`stardesign.directory` to this app's user tree. That
module documents where the roster comes from, why it is a union of the auth
service's login records and the shared volume, and why the outbound call to auth
is not an SSRF hole.
"""

from fastapi import Request

from stardesign import directory as _shared

from backend import userdata

TTL_SECONDS = _shared.TTL_SECONDS


def roster(request: Request) -> list[dict]:
    """Everyone a config can be shared with: ``[{email, name}]``, sorted."""
    return _shared.roster(request, userdata.store)


def display_names(request: Request) -> dict[str, str]:
    """``slug -> display name`` for labelling config owners; ``""`` when unknown."""
    return _shared.display_names(request, userdata.store)
