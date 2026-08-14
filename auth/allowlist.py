"""Per-app authorization on top of the shared @berkeley.edu gate.

The session cookie proves *identity* (a valid @berkeley.edu account). Most apps
need nothing more. A few need a tighter *authorization* check -- a named
allowlist -- because they do more than read:

    STAR OpenRocket (openrocket.*) brokers Onshape API credentials, so anyone
    who can reach it can spend the key pair's rate limit and read any document
    it can read.

This is checked live in /verify (see main.py), NOT baked into the JWT, so that
adding or removing someone takes effect on their next request rather than
whenever their 30-day token happens to refresh.

Storage is a plain file -- one email per line, `#` comments and blank lines
ignored -- because the list is tiny, changes rarely, and the auth service is a
single node. Moving to a database (D1/DynamoDB/Turso) later is a change to
`_load()` alone; nothing else in the stack cares.

**Fail closed.** If an app's allowlist file is missing or unreadable, nobody is
approved for that app -- the safe direction for a credential-brokering tool.
"""

import os
import threading

_HERE = os.path.dirname(os.path.abspath(__file__))

# app (subdomain label) -> path to its allowlist file. An app absent from this
# map has no allowlist: the shared @berkeley.edu gate is the whole check.
_APP_FILES = {
    # STAR OpenRocket (subdomain openrocket.*) brokers Onshape API credentials,
    # so it keeps its own approved-user allowlist on top of the @berkeley.edu gate.
    "openrocket": os.environ.get(
        "ONSHAPE_ALLOWLIST_FILE",
        os.path.join(_HERE, "allowlists", "onshape_allowlist.txt"),
    ),
}

_LOCK = threading.Lock()
# path -> (mtime_at_read, frozenset_of_emails)
_CACHE: dict[str, tuple[float, frozenset]] = {}


def _load(path: str) -> frozenset:
    """Emails in `path`, lowercased. Cached; re-read when the file's mtime changes.

    Returns an empty set (deny all) if the file is missing or unreadable, so a
    misconfiguration fails closed rather than opening the app to everyone.
    """
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return frozenset()

    with _LOCK:
        cached = _CACHE.get(path)
        if cached is not None and cached[0] == mtime:
            return cached[1]

    emails = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                # An email never contains '#', so this safely strips inline
                # comments as well as whole-line ones.
                entry = line.split("#", 1)[0].strip().lower()
                if entry:
                    emails.add(entry)
    except OSError:
        return frozenset()

    result = frozenset(emails)
    with _LOCK:
        _CACHE[path] = (mtime, result)
    return result


def app_requires_allowlist(app: str) -> bool:
    """True if `app` gates on an allowlist beyond the shared domain check."""
    return app in _APP_FILES


def is_approved(app: str, email: str) -> bool:
    """Whether `email` may access `app`.

    Apps with no allowlist are unrestricted (the shared gate already passed).
    """
    path = _APP_FILES.get(app)
    if path is None:
        return True
    return (email or "").strip().lower() in _load(path)
