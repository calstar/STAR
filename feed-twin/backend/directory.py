"""Who a stand can be shared with: the team roster (:mod:`stardesign.directory`)."""

from __future__ import annotations

from typing import cast

from fastapi import Request
from stardesign import directory as _shared

from backend import userdata


def roster(request: Request) -> list[dict[str, str]]:
    """Everyone a stand can be shared with: ``[{email, name}]``, sorted."""
    return cast(list[dict[str, str]], _shared.roster(request, userdata.store))
