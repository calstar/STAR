"""Who the current MCP request is acting as.

Set once per HTTP request by the auth middleware (http.py) from the bearer token,
read by every tool. A tool never takes an identity as an argument: the only way to
be someone here is to hold their token.
"""

from __future__ import annotations

import contextvars
from dataclasses import dataclass


@dataclass(frozen=True)
class Identity:
    email: str
    name: str
    #: STARProject's id for the token in use ("dev" on a dev server), for logs.
    token_id: str


_current: contextvars.ContextVar[Identity | None] = contextvars.ContextVar("design_mcp_identity", default=None)


def current() -> Identity:
    who = _current.get()
    if who is None:
        # Reaching a tool without the middleware having run is a wiring bug, not a
        # request to serve anonymously.
        raise RuntimeError("no identity on this request")
    return who


def bind(who: Identity) -> contextvars.Token[Identity | None]:
    return _current.set(who)


def unbind(token: contextvars.Token[Identity | None]) -> None:
    _current.reset(token)
