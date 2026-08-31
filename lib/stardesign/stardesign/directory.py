"""Who a design can be shared with: the team roster.

Sharing needs a list of people, and the design tools have never had one -- they
only ever knew the single email in the request header. The roster here is the
**union** of two sources, and it needs both:

* **The auth service** (``AUTH_USERS_URL`` -> ``auth/main.py``'s ``/users``),
  which records everyone who has signed in. It is the only source of real
  display names; nothing on this side of the wire knows them.
* **The shared userdata volume** -- everyone who already has designs. Auth only
  learns about a person when they log in and sessions last 30 days, so for the
  first month after this ships the auth roster is missing most of the team. In
  dev there is no auth service at all. The volume scan covers both cases, which
  is what keeps ``./dev.sh`` working with nothing in front of it.

Auth being unset, down, or slow degrades this to the volume scan. It must never
break listing or editing designs.

**On making this app an authenticated-request forwarder.** The outbound call
carries exactly one header -- the caller's own session cookie, which Caddy has
already handed us -- and its URL comes from ``AUTH_USERS_URL`` in the
environment, never from the request. A caller can therefore influence *whether*
we ask auth, never *whom* we ask, which is what keeps this from being an SSRF
hole. Keep it that way: no request-supplied URLs, no header pass-through.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request

from fastapi import Request

from stardesign.userdata import UserData, slug_user

#: How long one auth-roster fetch is reused. Short enough that a new teammate
#: appears promptly, long enough that listing designs is not a network call.
TTL_SECONDS = float(os.environ.get("AUTH_USERS_TTL", "60"))

#: Deliberately short: a slow auth service must not stall a design list.
TIMEOUT_SECONDS = 3.0

_lock = threading.Lock()
_cache: tuple[float, list[dict]] = (0.0, [])


def _fetch_auth(cookie: str) -> list[dict]:
    """The auth service's roster, or ``[]`` if unset, unreachable, or garbage."""
    base = os.environ.get("AUTH_USERS_URL", "").strip().rstrip("/")
    if not base:
        return []
    req = urllib.request.Request(f"{base}/users", method="GET")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return []
    if not isinstance(data, list):
        return []
    return [
        {"email": str(row["email"]), "name": str(row.get("name") or "")}
        for row in data
        if isinstance(row, dict) and row.get("email")
    ]


def _auth_roster(request: Request) -> list[dict]:
    """:func:`_fetch_auth` behind a process-wide TTL cache.

    Cached across callers, not per-cookie: every session that reaches this app
    has already been verified by Caddy and would get the same answer. A failed
    fetch caches ``[]`` for the same TTL, so an auth outage costs one attempt a
    minute rather than one per request.
    """
    now = time.monotonic()
    with _lock:
        stamp, cached = _cache
        if now - stamp < TTL_SECONDS:
            return cached
    fetched = _fetch_auth(request.headers.get("cookie", ""))
    with _lock:
        globals()["_cache"] = (time.monotonic(), fetched)
    return fetched


def roster(request: Request, ud: UserData) -> list[dict]:
    """Everyone a design can be shared with: ``[{email, name}]``, sorted.

    Keyed on the path slug, so the same person arriving from both sources
    collapses to one row -- and auth's spelling of the address wins, since the
    volume only ever holds the slug.
    """
    people: dict[str, dict] = {
        user: {"email": user, "name": ""} for user in ud.all_users()
    }
    for row in _auth_roster(request):
        slug = slug_user(row["email"])
        entry = people.setdefault(slug, {"email": row["email"], "name": ""})
        entry["email"] = row["email"]
        entry["name"] = row["name"] or entry["name"]
    return sorted(people.values(), key=lambda u: (u["name"].lower() or u["email"], u["email"]))


def display_names(request: Request, ud: UserData) -> dict[str, str]:
    """``slug -> display name`` for labelling design owners; ``""`` when unknown."""
    return {slug_user(u["email"]): u["name"] for u in roster(request, ud)}
