"""Who is an admin: a fixed list, checked against the caller's identity.

Admins may choose the team's main design and are the only ones who may change
it (see :mod:`stardesign.documents`). The list is in code on purpose: changing
who can rewrite the main design should be a reviewed commit, not a button.

Identity is the ``X-Auth-Email`` Caddy sets after verifying the session, and
Caddy strips any copy the client sent (see deploy/caddy/Caddyfile), so the
comparison below is against an email the caller cannot choose.

``STAR_ADMINS`` (comma-separated emails) adds to the list without a commit. It
exists for dev, where there is no Caddy and every request is the ``local`` user
(``STAR_ADMINS=local``).
"""

from __future__ import annotations

import os

from fastapi import Request

from stardesign.userdata import UserData, slug_user

#: Compared as path slugs, the same normalisation ``current_user`` applies.
ADMIN_EMAILS = (
    "aahilsyed72@berkeley.edu",
    "carlosbautista@berkeley.edu",
    "aidanrickert@berkeley.edu",
)


def admin_slugs() -> set[str]:
    extra = os.environ.get("STAR_ADMINS", "")
    return {slug_user(e) for e in (*ADMIN_EMAILS, *extra.split(",")) if e.strip()}


def is_admin(request: Request, ud: UserData) -> bool:
    """Whether the caller is a STAR admin."""
    return ud.current_user(request) in admin_slugs()
