"""Per-user storage roots, keyed on the caller's identity.

Identity comes from the ``X-Auth-Email`` header Caddy injects in production. The
app never gates on it -- Caddy is the gate; this only decides *whose* folder to
read and write. With no Caddy in front (local dev) there is no header, so the
user falls back to ``local`` and everything lands in a gitignored ``.userdata/``
beside the app. A missing header is never a rejection.

Layout, under ``USERDATA_DIR`` (prod: a mounted volume; dev: ``<subproject>/.userdata``)::

    <user>/pid/index.json               -- the user's diagram list [{id, name, ...}]
    <user>/pid/<diagram-id>/current.json -- working copy (autosave target)
    <user>/pid/<diagram-id>/versions/    -- local microversions (dev backend only)
    <user>/pid/<diagram-id>/releases/    -- local releases (dev backend only)

so a future "browse another user's diagrams read-only, then copy" is just listing
sibling ``<user>/`` folders. This mirrors EngineDesign/recovery ``userdata.py``.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import Request

#: The ``<app>`` path segment for this backend. Distinct per app.
APP = "pid"

_DEV_USER = "local"

# backend/userdata.py -> backend -> <subproject>. Used only when USERDATA_DIR is
# unset (dev): a gitignored dir next to the app, created on demand.
_DEFAULT_ROOT = Path(__file__).resolve().parents[1] / ".userdata"

# user / app / id / label all become path segments, so they must never carry a
# separator or "..". Emails are path-safe apart from case; ids/labels derive from
# user-supplied names. Conservative allowlist, everything else -> "-". The dot is
# allowed so release labels like "0.1" survive intact.
_UNSAFE = re.compile(r"[^a-z0-9._@-]+")


def _root() -> Path:
    env = os.environ.get("USERDATA_DIR")
    return Path(env) if env else _DEFAULT_ROOT


def _sanitize(part: str, *, fallback: str) -> str:
    cleaned = _UNSAFE.sub("-", (part or "").strip().lower()).strip("-.")
    # Anything that reduces to nothing or a dot-path is unusable as a segment.
    return fallback if cleaned in ("", ".", "..") else cleaned


def current_user(request: Request) -> str:
    """Whose data to use: ``X-Auth-Email`` in prod (from Caddy), else ``local``.

    Never raises and never denies -- a missing header is dev, not a rejection.
    """
    return _sanitize(request.headers.get("X-Auth-Email", ""), fallback=_DEV_USER)


def user_dir(user: str, app: str = APP) -> Path:
    """``<root>/<user>/<app>``, created on demand. Root is not assumed to exist."""
    d = _root() / _sanitize(user, fallback=_DEV_USER) / _sanitize(app, fallback=app)
    d.mkdir(parents=True, exist_ok=True)
    return d


def slugify(name: str) -> str:
    """Path-safe slug from a user-given name; ``""`` if nothing usable."""
    return _sanitize(name, fallback="")
