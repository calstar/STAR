"""The team roster: everyone who has ever signed in.

Auth has always been stateless -- it verifies a cookie and forwards two headers,
and genuinely does not know who exists. That was fine until the design tools
grew sharing, which needs a list of people to share *with*. This is the smallest
thing that produces one: record each successful login, serve the result.

Storage is a plain JSON file for the same reasons ``allowlist.py`` uses a plain
text file -- the list is tiny, the service is one node, and moving to a database
later is a change to ``_read``/``_write`` alone. Unlike the allowlist this
**fails open**: an unreadable roster yields an empty list, and the callers treat
that as "no names available", never as "deny". A roster problem must not be able
to block a login or an edit.

Two properties this file exists to guarantee:

* **A login must never fail because of the roster.** Every write is wrapped so a
  full disk, a read-only mount or a permissions mistake costs a missing name,
  not an inability to sign in.
* **Concurrent logins must not lose records.** The service runs under
  ``gunicorn --workers 2``, so read-modify-write needs a lock; without one, two
  people logging in at the same moment silently drop one of the two.
"""

import fcntl
import json
import os
import tempfile
import threading
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))

#: Roster location. In prod this is on a mounted volume (see
#: deploy/ec2/docker-compose.yml); the default keeps dev self-contained.
USERS_FILE = os.environ.get("AUTH_USERS_FILE", os.path.join(_HERE, ".users.json"))

# Guards the read-modify-write against threads within one worker; flock guards it
# across workers. Both are needed -- flock is per-open-file-description, so two
# threads sharing one process can still interleave without this.
_LOCK = threading.Lock()


def _read(path: str) -> list[dict]:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return [r for r in data if isinstance(r, dict) and r.get("email")] if isinstance(data, list) else []


def _write(path: str, rows: list[dict]) -> None:
    """Atomic replace, so a crash mid-write cannot truncate the roster."""
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".users-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def record_login(email: str, name: str) -> None:
    """Note that `email` signed in. Never raises -- see the module docstring.

    Called from /callback, which is the only place the service learns a display
    name, so a later login refreshes a name that has changed.
    """
    email = (email or "").strip()
    if not email:
        return
    try:
        os.makedirs(os.path.dirname(USERS_FILE) or ".", exist_ok=True)
        lock_path = USERS_FILE + ".lock"
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            with _LOCK:
                fcntl.flock(fd, fcntl.LOCK_EX)
                rows = [r for r in _read(USERS_FILE)
                        if r["email"].lower() != email.lower()]
                rows.append({
                    "email": email,
                    "name": (name or "").strip(),
                    "lastLogin": datetime.now(timezone.utc).isoformat(),
                })
                rows.sort(key=lambda r: r["email"].lower())
                _write(USERS_FILE, rows)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
    except Exception:
        # A roster that cannot be written is a missing name in a share picker.
        # It is never a reason to fail the login that is in flight.
        pass


def list_users() -> list[dict]:
    """Everyone who has signed in: ``[{email, name}]``, sorted by email.

    ``lastLogin`` is deliberately not exposed -- it is useful for pruning the
    file by hand, but the apps only need somebody to pick from a list.
    """
    return [
        {"email": r["email"], "name": (r.get("name") or "")}
        for r in sorted(_read(USERS_FILE), key=lambda r: r["email"].lower())
    ]
