"""Per-user data storage, keyed on the caller's identity.

Identity comes from the ``X-Auth-Email`` header Caddy injects in production. The
app never gates on it -- Caddy is the gate; this only decides *whose* folder to
read and write. With no Caddy in front (local dev) there is no header, so the
user falls back to ``local`` and everything lands in a gitignored ``.userdata/``
beside the app. A missing header is never a rejection.

Layout, under ``USERDATA_DIR`` (prod: a mounted volume; dev: ``<subproject>/.userdata``)::

    <user>/<app>/units.json          -- app-specific state (recovery unit prefs)
    <user>/<app>/configs/<slug>.json -- named config blobs {name, savedAt, config}

Designs are shared across users (see ``routers/documents.py``): every design
tool mounts one volume, so "list another user's designs, then copy one" is just
reading sibling ``<user>/`` folders -- which is what this layout was chosen for.
Nothing here gates access; that decision lives in the router.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Request

#: The ``<app>`` path segment for this backend. Distinct per app.
APP = "recovery"

_DEV_USER = "local"

# backend/userdata.py -> backend -> <subproject>. Used only when USERDATA_DIR is
# unset (dev): a gitignored dir next to the app, created on demand.
_DEFAULT_ROOT = Path(__file__).resolve().parents[1] / ".userdata"

# user / app / slug all become path segments, so they must never carry a
# separator or "..". Emails are path-safe apart from case; slugs derive from
# user-supplied names. Conservative allowlist, everything else -> "-".
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


def user_dir(user: str, app: str = APP, *, create: bool = True) -> Path:
    """``<root>/<user>/<app>``, created on demand. Root is not assumed to exist.

    Pass ``create=False`` when merely *inspecting* another user's tree (the
    cross-user browse walks every sibling folder, and must not conjure an empty
    directory for each one it looks at).
    """
    d = _root() / _sanitize(user, fallback=_DEV_USER) / _sanitize(app, fallback=app)
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def slug_user(email: str) -> str:
    """Normalize an email into the directory segment that identifies its owner.

    Exactly the transform :func:`current_user` applies to the header, so an
    ``?owner=`` query param and the injected identity compare without any
    special-casing -- which is what keeps an ownership check from hinging on two
    slightly different normalizations.
    """
    return _sanitize(email, fallback=_DEV_USER)


def all_users(app: str = APP) -> list[str]:
    """Every user slug that has data for ``app``, sorted. Never creates anything.

    All the design tools mount one shared volume, so the root holds the whole
    team; requiring a ``<user>/<app>`` subdirectory narrows it to people who have
    actually used *this* app.
    """
    root = _root()
    if not root.is_dir():
        return []
    seg = _sanitize(app, fallback=app)
    return sorted(
        p.name
        for p in root.iterdir()
        if p.is_dir() and not p.name.startswith(".") and (p / seg).is_dir()
    )


def slugify(name: str) -> str:
    """Filename-safe slug from a user-given name; ``""`` if nothing usable."""
    return _sanitize(name, fallback="")


def _configs_dir(user: str) -> Path:
    d = user_dir(user) / "configs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_configs(user: str) -> list[dict]:
    """Metadata for each saved config, newest first: ``{slug, name, savedAt}``."""
    out: list[dict] = []
    for p in _configs_dir(user).glob("*.json"):
        if p.name.startswith("."):  # skip in-flight temp writes
            continue
        try:
            blob = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"slug": p.stem, "name": blob.get("name", p.stem),
                    "savedAt": blob.get("savedAt")})
    out.sort(key=lambda c: c.get("savedAt") or "", reverse=True)
    return out


def read_config(user: str, slug: str) -> dict | None:
    """The full blob (``{name, savedAt, config}``) for ``slug``, or None."""
    safe = slugify(slug)
    if not safe:
        return None
    p = _configs_dir(user) / f"{safe}.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def write_config(user: str, name: str, config: dict) -> dict:
    """Save/overwrite a named config atomically. Returns ``{slug, name, savedAt}``."""
    slug = slugify(name)
    if not slug:
        raise ValueError("name must contain at least one letter or digit")
    blob = {
        "name": name.strip(),
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "config": config,
    }
    d = _configs_dir(user)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(blob, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, d / f"{slug}.json")
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return {"slug": slug, "name": blob["name"], "savedAt": blob["savedAt"]}


def delete_config(user: str, slug: str) -> bool:
    """Remove a saved config. False if it did not exist."""
    safe = slugify(slug)
    if not safe:
        return False
    try:
        (_configs_dir(user) / f"{safe}.json").unlink()
        return True
    except OSError:
        return False
