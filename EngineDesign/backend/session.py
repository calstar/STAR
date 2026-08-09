"""Per-user live working state, keyed on the caller's identity.

The saved-config *library* (``/api/configs``, ``backend/userdata.py``) was already
per-user, but the app's *live* working state -- the config currently loaded, its
runner, an in-flight optimization, the controller instance -- used to be process
globals. Two people connected at once therefore shared one design and clobbered
each other: uploads overwrote each other, an optimization refused to start while
another user's ran, results landed in a single slot the wrong user could read,
and one user's "stop" cancelled another's run.

This module gives each user their own ``UserSession`` holding all of that live
state. Identity is ``X-Auth-Email`` (via ``userdata.current_user``); with no Caddy
in front (local dev) there is no header, so everything collapses onto a single
``local`` session and the app behaves exactly as it did as a single-user global.

Endpoints obtain their session with ``session = Depends(get_session)`` and read
and write through it (``session.app_state``, ``session.optimizer``,
``session.controller``) instead of module globals. Because the heavy optimizer
jobs run inside nested closures, capturing ``session`` there propagates the right
user into the thread pool for free -- no ContextVar plumbing.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import Request

from backend import userdata
from backend.state import AppState
from engine.pipeline.io import load_config

# backend/session.py -> backend -> <project root>. The default config lives here.
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_CONFIG_PATH = _PROJECT_ROOT / "configs" / "default.yaml"

# Drop a user's live session after this many seconds idle, so memory does not
# grow without bound as people come and go. The next request rebuilds it from the
# default config -- the same state a fresh visitor gets.
SESSION_TTL_SECONDS = int(os.environ.get("SESSION_TTL_SECONDS", str(2 * 60 * 60)))

# Cap on concurrent *heavy* jobs (optimizer runs, controller sims) across ALL
# users. Per-user state removes cross-user corruption; this keeps N users from
# each kicking off a CPU-bound optimization at once and melting the box. Total,
# not per user. Acquired by the streaming endpoints around the run.
MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "3"))
JOB_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_JOBS)


def _fresh_status() -> dict:
    """A blank optimizer job-status block (one per layer)."""
    return {
        "running": False,
        "progress": 0.0,
        "stage": "",
        "message": "",
        "results": None,
        "error": None,
    }


@dataclass
class OptimizerState:
    """Per-user optimizer job state (was the module globals in optimizer.py).

    ``stop_event`` is created fresh for each run so a user's cancel only touches
    their own optimization; ``stop_event_lock`` guards the swap.
    """

    optimization_status: dict = field(default_factory=_fresh_status)  # layer 1
    layer2_status: dict = field(default_factory=_fresh_status)
    layer3_status: dict = field(default_factory=_fresh_status)
    stop_event: Optional[threading.Event] = None
    stop_event_lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class ControllerState:
    """Per-user controller instance (was the module globals in control.py)."""

    controller: object | None = None
    controller_logger: object | None = None


class UserSession:
    """One user's live working state. Created with the default config loaded, so
    ``app_state.has_config()`` is true on first touch -- the same starting point
    the app used to establish at boot for its single global."""

    def __init__(self, user: str) -> None:
        #: The identity this session belongs to (sanitized email, or "local" in
        #: dev). A path-safe segment -- userdata already sanitized it -- so it is
        #: reusable for per-user scratch paths (e.g. config upload staging).
        self.user = user
        self.app_state = AppState()
        self.optimizer = OptimizerState()
        self.controller = ControllerState()
        self.last_used = time.monotonic()
        self._load_default_config()

    def _load_default_config(self) -> None:
        """Load configs/default.yaml, mirroring the old main.py lifespan. Best
        effort: a missing or bad default leaves the session config-less, exactly
        as the startup path did."""
        if not _DEFAULT_CONFIG_PATH.exists():
            return
        try:
            config_obj = load_config(str(_DEFAULT_CONFIG_PATH))
            self.app_state.set_config(config_obj, str(_DEFAULT_CONFIG_PATH))
        except Exception as exc:  # pragma: no cover - matches old best-effort load
            print(f"Warning: Could not load default config for session: {exc}")

    def touch(self) -> None:
        self.last_used = time.monotonic()


class SessionRegistry:
    """Thread-safe ``user -> UserSession`` map with idle eviction."""

    def __init__(self) -> None:
        self._sessions: dict[str, UserSession] = {}
        self._lock = threading.Lock()

    def get(self, user: str) -> UserSession:
        now = time.monotonic()
        with self._lock:
            self._evict_expired(now)
            session = self._sessions.get(user)
            if session is None:
                session = UserSession(user)
                self._sessions[user] = session
            session.last_used = now
            return session

    def _evict_expired(self, now: float) -> None:
        """Drop sessions idle past the TTL. Called under the lock."""
        if SESSION_TTL_SECONDS <= 0:
            return
        expired = [
            user
            for user, s in self._sessions.items()
            if now - s.last_used > SESSION_TTL_SECONDS
        ]
        for user in expired:
            del self._sessions[user]


registry = SessionRegistry()


async def gated_stream(agen):
    """Hold JOB_SEMAPHORE for the lifetime of an async generator (an SSE stream).

    Wrap the generator handed to ``StreamingResponse`` so a heavy streamed job
    (a controller simulation) counts against the global concurrency cap for as
    long as it runs, and releases the slot when the stream ends or the client
    disconnects. Lets us cap those without reindenting the long loops that
    produce them.
    """
    async with JOB_SEMAPHORE:
        async for item in agen:
            yield item


def get_session(request: Request) -> UserSession:
    """FastAPI dependency: the caller's live session.

    Same identity key as the saved-config library (``X-Auth-Email`` in prod via
    Caddy, ``local`` in dev). Never raises and never denies -- auth is Caddy's
    job; this only decides whose in-memory state to use.
    """
    return registry.get(userdata.current_user(request))
