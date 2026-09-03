"""Config endpoints must not run set_config on the event loop.

set_config builds/loads the CEA cache (PintleEngineRunner). For a propellant
whose cache is not yet committed that is a multi-minute *synchronous* build, and
running it on the asyncio event loop freezes every other request -- health
included -- which is the "stuck on Connecting…" hang the frontend showed.

The fix is to offload set_config via run_in_threadpool in the async config
endpoints. This test pins that invariant behaviorally without any HTTP/async test
harness (none is in the CI subset): it records the thread set_config runs on and
asserts it is NOT the event-loop thread. Revert the offload and set_config runs
inline on the loop thread -> this fails.

Mirrors test_session_isolation.py: real sessions via get_session, endpoint
coroutines driven directly with asyncio.run.
"""

from __future__ import annotations

import asyncio
import threading

from starlette.requests import Request

from backend.session import get_session
from backend.routers import config as config_router
from backend import state as state_mod


def _request(email: str | None) -> Request:
    headers = [(b"x-auth-email", email.encode())] if email else []
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/",
            "query_string": b"",
            "headers": headers,
        }
    )


def _thread_used_by_set_config(run_endpoint):
    """Drive `run_endpoint(session)` on a fresh event loop, capturing the thread
    id set_config executed on and the event-loop thread id. Returns (loop_tid,
    set_config_tid)."""
    captured: dict[str, int] = {}
    real_set_config = state_mod.AppState.set_config

    def spy(self, *args, **kwargs):
        captured["set_config_tid"] = threading.get_ident()
        return real_set_config(self, *args, **kwargs)

    async def main():
        captured["loop_tid"] = threading.get_ident()
        session = get_session(_request("offload-test@berkeley.edu"))
        assert session.app_state.has_config(), "default config should be loaded"
        state_mod.AppState.set_config = spy
        try:
            await run_endpoint(session)
        finally:
            state_mod.AppState.set_config = real_set_config

    asyncio.run(main())
    return captured.get("loop_tid"), captured.get("set_config_tid")


def test_switch_offloads_set_config_off_the_event_loop():
    async def run(session):
        # Switch to the same propellant the default already uses: exercises the
        # real switch_config reconcile + set_config path without depending on
        # which caches are committed. The offload is what we are asserting, not
        # the physics.
        await config_router.switch_config_endpoint(
            {"propellant_preset": "methalox"}, session=session
        )

    loop_tid, set_config_tid = _thread_used_by_set_config(run)
    assert set_config_tid is not None, "switch_config_endpoint did not call set_config"
    assert set_config_tid != loop_tid, (
        "set_config ran on the event-loop thread -- a cold CEA build here would "
        "block every other request. Offload it with run_in_threadpool."
    )


def test_load_offloads_set_config_off_the_event_loop():
    async def run(session):
        current = config_router.config_to_dict(session.app_state.config)
        await config_router.load_config_json(current, session=session)

    loop_tid, set_config_tid = _thread_used_by_set_config(run)
    assert set_config_tid is not None, "load_config_json did not call set_config"
    assert set_config_tid != loop_tid, (
        "set_config ran on the event-loop thread in /config/load -- offload it "
        "with run_in_threadpool."
    )
