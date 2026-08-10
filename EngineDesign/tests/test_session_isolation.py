"""Per-user live-state isolation for the Engine Design backend.

Two users connected at once must not share the live config, the optimizer job
state, or the controller. Identity is the ``X-Auth-Email`` header (Caddy in prod,
absent in dev -> ``local``). These tests drive the real dependency and endpoint
coroutines directly -- no HTTP client needed -- so they exercise exactly what
Caddy's forwarded header feeds into the app.

See backend/session.py for the mechanism.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend import session as session_mod
from backend.session import SessionRegistry, get_session, JOB_SEMAPHORE, MAX_CONCURRENT_JOBS
from backend.routers import config as config_router
from backend.routers import optimizer as optimizer_router
from backend.routers import control as control_router


def _request(email: str | None) -> Request:
    """A minimal ASGI request carrying (or omitting) the auth header."""
    headers = [(b"x-auth-email", email.encode())] if email else []
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": headers,
        }
    )


def _run(coro):
    return asyncio.run(coro)


# ── Identity / registry ──────────────────────────────────────────────────────


def test_distinct_users_get_distinct_sessions():
    a = get_session(_request("alice@berkeley.edu"))
    b = get_session(_request("bob@berkeley.edu"))
    assert a is not b
    assert a.user != b.user


def test_same_user_reuses_one_session():
    a1 = get_session(_request("carol@berkeley.edu"))
    a2 = get_session(_request("carol@berkeley.edu"))
    assert a1 is a2


def test_dev_fallback_is_a_single_local_session():
    """No Caddy in dev -> no header -> everyone is `local`, one shared session,
    with the default config loaded (the old single-user behaviour)."""
    s1 = get_session(_request(None))
    s2 = get_session(_request(None))
    assert s1 is s2
    assert s1.user == "local"
    assert s1.app_state.has_config()


def test_ttl_eviction_recreates_a_fresh_session(monkeypatch):
    reg = SessionRegistry()
    monkeypatch.setattr(session_mod, "SESSION_TTL_SECONDS", 100)
    first = reg.get("dave@berkeley.edu")
    # Backdate its last-used well past the TTL, then access again.
    first.last_used = time.monotonic() - 1000
    second = reg.get("dave@berkeley.edu")
    assert second is not first  # evicted and rebuilt


def test_job_cap_is_three():
    assert MAX_CONCURRENT_JOBS == 3
    assert JOB_SEMAPHORE._value == 3


# ── Live config isolation ────────────────────────────────────────────────────


def test_one_users_config_edit_does_not_touch_another():
    a = get_session(_request("erin@berkeley.edu"))
    b = get_session(_request("frank@berkeley.edu"))

    base_b = _run(config_router.get_config(session=b))["config"]["design_requirements"]["target_thrust"]
    target = base_b + 137.0  # a value clearly different from default

    _run(config_router.update_config(
        {"design_requirements": {"target_thrust": target}}, session=a
    ))

    a_thrust = _run(config_router.get_config(session=a))["config"]["design_requirements"]["target_thrust"]
    b_thrust = _run(config_router.get_config(session=b))["config"]["design_requirements"]["target_thrust"]

    assert a_thrust == pytest.approx(target)
    assert b_thrust == pytest.approx(base_b)  # B untouched by A's edit
    assert a_thrust != pytest.approx(b_thrust)


# ── Optimizer job-state isolation ────────────────────────────────────────────


def test_optimizer_status_and_results_are_per_user():
    a = get_session(_request("gina@berkeley.edu"))
    b = get_session(_request("hank@berkeley.edu"))

    # Simulate A mid-run with results ready; B has done nothing.
    a.optimizer.optimization_status["running"] = True
    a.optimizer.optimization_status["results"] = {"objective": 1.23}

    assert _run(optimizer_router.get_layer1_status(session=a))["running"] is True
    assert _run(optimizer_router.get_layer1_status(session=b))["running"] is False

    # A sees its results; B is a clean 404, never A's data.
    assert _run(optimizer_router.get_layer1_results(session=a))["results"] == {"objective": 1.23}
    with pytest.raises(HTTPException) as exc:
        _run(optimizer_router.get_layer1_results(session=b))
    assert exc.value.status_code == 404


def test_stop_only_affects_the_callers_run():
    a = get_session(_request("iris@berkeley.edu"))
    b = get_session(_request("jack@berkeley.edu"))
    # Both mid-run: each has its own live stop event (as run_layer1 creates).
    a.optimizer.optimization_status["running"] = True
    b.optimizer.optimization_status["running"] = True
    a.optimizer.stop_event = threading.Event()
    b.optimizer.stop_event = threading.Event()

    _run(optimizer_router.stop_layer1(session=a))

    # A's stop event is set; B's is a different event and stays clear.
    assert a.optimizer.stop_event.is_set()
    assert b.optimizer.stop_event is not a.optimizer.stop_event
    assert not b.optimizer.stop_event.is_set()
    assert b.optimizer.optimization_status["running"] is True


# ── Controller isolation ─────────────────────────────────────────────────────


def test_controller_is_per_user():
    a = get_session(_request("kim@berkeley.edu"))
    b = get_session(_request("liam@berkeley.edu"))

    _run(control_router.init_controller(control_router.ControllerInitRequest(), session=a))

    assert _run(control_router.get_controller_status(session=a))["initialized"] is True
    # B never initialized one -- must not inherit A's controller.
    assert _run(control_router.get_controller_status(session=b))["initialized"] is False
    assert b.controller.controller is None
