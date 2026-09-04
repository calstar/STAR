"""One shared, editable line of context per run: "hotfire 3, ox lead 200 ms".

A run is identified by a timestamp, which says when it happened and nothing about what
it was. This is the one piece of viewer state that is *written* rather than derived, and
it is deliberately unowned — anybody can set or change any run's line, and everybody sees
the same text. There is no login on this tool, so there is nobody to attribute it to.

Stored beside the run dirs (`<ELODIN_DIR>/run_descriptions.json`), for the same reason
the config snapshot is: that is where the runs themselves live, it is backed up with
them, and it survives the parquet cache being wiped — which docker-compose explicitly
calls safe to do. It must never live under WEBVIEWER_CACHE_DIR for that reason.

Last write wins. Two people editing one line in the same second is not a problem worth a
revision protocol here; the write itself is atomic, so a torn file is not possible.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone

from . import config

# Long enough for "hotfire 3 — ox lead 200 ms, aborted on chamber PT", short enough that
# it stays one line in the run list rather than becoming a notes field.
MAX_LEN = 120

_SCHEMA = 1
# Single-process (the Dockerfile's uvicorn has no --workers), so a process-wide lock is
# enough to serialise read-modify-write. Multiple workers would need file locking.
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalise(text: str) -> str:
    """Force the input to the one line it claims to be: newlines and runs of whitespace
    collapse to single spaces, then truncate. A pasted paragraph becomes a sentence
    rather than being rejected."""
    return " ".join(text.split())[:MAX_LEN]


def _read() -> dict[str, dict]:
    """The whole store. Unreadable or malformed → empty: a description is a convenience,
    and losing one must never stop the viewer listing runs."""
    try:
        with config.DESCRIPTIONS_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    runs = data.get("runs")
    return runs if isinstance(runs, dict) else {}


def _write(runs: dict[str, dict]) -> None:
    """Replace the store atomically, so a crash or a concurrent reader never sees a
    half-written file. Same directory as the target — os.replace is only atomic within
    one filesystem."""
    path = config.DESCRIPTIONS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".descriptions-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"version": _SCHEMA, "runs": runs}, fh, indent=1, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def all_texts() -> dict[str, str]:
    """run_id → description, for decorating a run listing. One file read."""
    return {
        rid: e["text"]
        for rid, e in _read().items()
        if isinstance(e, dict) and isinstance(e.get("text"), str) and e["text"]
    }


def get(run_id: str) -> str:
    return all_texts().get(run_id, "")


def set_text(run_id: str, text: str) -> dict:
    """Set (or, with empty text, clear) one run's description. Returns the stored entry.

    Also drops entries for runs that no longer exist — a discarded session takes its DB
    dir and its config snapshot with it (session-manager.ts) but knows nothing about this
    file, so orphans would otherwise pile up forever.
    """
    text = normalise(text)
    with _lock:
        runs = _read()
        if text:
            runs[run_id] = {"text": text, "updated_at": _now()}
        else:
            runs.pop(run_id, None)
        runs = {
            rid: e for rid, e in runs.items() if (config.ELODIN_DIR / rid).is_dir()
        }
        _write(runs)
    return runs.get(run_id, {"text": "", "updated_at": None})
