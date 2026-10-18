"""The page-load solves must not run on the event loop.

Forward Mode evaluates every design it opens (POST /api/evaluate) and the
Time-Series tab runs it (POST /api/timeseries/generate, or /from-segments) --
about 10 s of CPU on a laptop and ~23 s on a CI runner. As ``async def``
endpoints calling the runner inline, that ran on the asyncio event loop and
froze every other request for as long: /api/health (a page opened meanwhile sat
on "Connecting"), the design bar's autosave, the documents API. The Playwright
suite failed on it on 2026-10-17 (design-persistence "panel state ... survives a
reload", and "Connected" timing out on connect-no-loop).

Same shape as test_config_endpoints_offload.py: the endpoint coroutines are
driven directly with asyncio.run, the solve is replaced by a spy that records the
thread it ran on, and the assertion is that it is NOT the event-loop thread.
Inline the call again and these fail. The spy raises once it has recorded, so
nothing here runs the physics.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend import session as session_mod
from backend.session import get_session
from backend.routers import evaluate as evaluate_router
from backend.routers import timeseries as timeseries_router


class _Recorded(Exception):
    """Raised by a spy once it has recorded its thread: the solve itself is not under test."""


def _request(email: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/",
            "query_string": b"",
            "headers": [(b"x-auth-email", email.encode())],
        }
    )


def _drive(run_endpoint) -> tuple[int, int | None]:
    """Run `run_endpoint(session)` on a fresh loop; return (loop thread, spy thread)."""
    captured: dict[str, int] = {}

    def spy(*_args, **_kwargs):
        captured["tid"] = threading.get_ident()
        raise _Recorded()

    async def main():
        captured["loop"] = threading.get_ident()
        session = get_session(_request("compute-offload-test@berkeley.edu"))
        assert session.app_state.has_config(), "default config should be loaded"
        # The endpoints wrap any failure of the solve in a 500; that is the spy's raise.
        with pytest.raises(HTTPException):
            await run_endpoint(session, spy)

    asyncio.run(main())
    return captured["loop"], captured.get("tid")


def test_evaluate_runs_off_the_event_loop(monkeypatch):
    async def run(session, spy):
        monkeypatch.setattr(session.app_state.runner, "evaluate", spy)
        await evaluate_router.evaluate(
            evaluate_router.EvaluateRequest(lox_pressure_psi=750, fuel_pressure_psi=600),
            session=session,
        )

    loop_tid, tid = _drive(run)
    assert tid is not None, "/api/evaluate did not call runner.evaluate"
    assert tid != loop_tid, (
        "runner.evaluate ran on the event-loop thread -- every request waits for it. "
        "Run it through session.run_compute."
    )


def test_timeseries_generate_runs_off_the_event_loop(monkeypatch):
    async def run(session, spy):
        monkeypatch.setattr(timeseries_router, "compute_timeseries_results", spy)
        profile = {"profile_type": "linear", "start_pressure_psi": 750, "end_pressure_psi": 525}
        await timeseries_router.generate_timeseries(
            timeseries_router.GenerateProfileRequest(
                duration_s=5.0, n_steps=11, lox_profile=profile, fuel_profile=profile,
            ),
            session=session,
        )

    loop_tid, tid = _drive(run)
    assert tid is not None, "/api/timeseries/generate did not call compute_timeseries_results"
    assert tid != loop_tid, (
        "the Time-Series run went on the event-loop thread -- /api/health and every other "
        "request wait the whole run (~23 s on CI). Run it through session.run_compute."
    )


def test_timeseries_from_segments_runs_off_the_event_loop(monkeypatch):
    async def run(session, spy):
        monkeypatch.setattr(timeseries_router, "compute_timeseries_results", spy)
        seg = {"length_ratio": 1.0, "type": "linear", "start_pressure_psi": 750, "end_pressure_psi": 525}
        await timeseries_router.generate_from_segments(
            timeseries_router.SegmentsRequest(
                duration_s=5.0, n_points=11, lox_segments=[seg], fuel_segments=[seg],
            ),
            session=session,
        )

    loop_tid, tid = _drive(run)
    assert tid is not None, "/api/timeseries/from-segments did not call compute_timeseries_results"
    assert tid != loop_tid, "the segments run went on the event-loop thread"


def test_a_sessions_solves_still_run_one_at_a_time():
    """Off the loop, two solves of one session must not share its runner at once."""
    active = 0
    peak = 0
    guard = threading.Lock()

    def solve():
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        time.sleep(0.05)
        with guard:
            active -= 1

    async def main():
        session = get_session(_request("compute-offload-test@berkeley.edu"))
        await asyncio.gather(*(session_mod.run_compute(session, solve) for _ in range(3)))

    asyncio.run(main())
    assert peak == 1, f"{peak} solves of one session ran at once"


# --- One design per solve -----------------------------------------------------------------------
#
# On the event loop nothing could run while a solve did, so the config a solve read at the end was
# the one it started with. In the thread pool a PUT /api/config (set_config, itself in the thread
# pool) can land mid-solve. A solve takes one (config, runner) pair, AppState.snapshot(), and uses
# only that; set_config swaps the pair together.


def _other_config():
    from engine.pipeline.io import load_config

    return load_config(str(session_mod._DEFAULT_CONFIG_PATH))


def test_a_config_written_during_evaluate_is_not_in_its_report(monkeypatch):
    """Forward Mode's report describes the design the numbers came from."""
    import engine.pipeline.config_switch as config_switch
    import engine.pipeline.forward_report as forward_report_mod
    import engine.pipeline.handcheck as handcheck_mod

    described: list = []
    monkeypatch.setattr(config_switch, "design_staleness", lambda cfg: described.append(cfg))
    monkeypatch.setattr(
        handcheck_mod, "handcheck",
        lambda cfg, *_a, **_k: described.append(cfg) or {"rows": [], "flags": []},
    )
    monkeypatch.setattr(
        forward_report_mod, "forward_report", lambda cfg, *_a, **_k: described.append(cfg) or {},
    )

    async def main():
        session = get_session(_request("compute-snapshot-evaluate@berkeley.edu"))
        solved_on = session.app_state.config
        other = _other_config()

        def solve(*_args, **_kwargs):
            session.app_state.set_config(other)  # the edit lands while the chamber solves
            return {"P_ambient": 101325.0, "elevation": 0.0}

        monkeypatch.setattr(session.app_state.runner, "evaluate", solve)
        await evaluate_router.evaluate(
            evaluate_router.EvaluateRequest(lox_pressure_psi=750, fuel_pressure_psi=600),
            session=session,
        )
        assert session.app_state.config is other, "the mid-solve write did not land; nothing tested"
        return solved_on, other

    solved_on, other = asyncio.run(main())
    assert len(described) == 3, described
    assert all(cfg is solved_on for cfg in described), (
        "the report was built from a config written while the solve ran -- one design's numbers "
        "against another's. Take session.app_state.snapshot() once, before the solve."
    )


def test_a_config_written_during_a_blowdown_run_does_not_switch_its_runner(monkeypatch):
    """The blowdown loop calls the engine every step; a mid-run edit must not split the burn."""
    import copv.blowdown_solver as blowdown

    engines: list[str] = []

    def engine(name):
        def evaluate(**_kwargs):
            engines.append(name)
            return {"mdot_O": 1.0, "mdot_F": 0.8}

        return evaluate

    monkeypatch.setattr(
        blowdown, "resolve_blowdown_tank_state", lambda *_a, **_k: (0.02, 10.0, None, 0.02, 8.0, None),
    )

    async def main():
        session = get_session(_request("compute-snapshot-blowdown@berkeley.edu"))
        monkeypatch.setattr(session.app_state.runner, "evaluate", engine("started on"))
        other = _other_config()

        def simulate(*, evaluate_engine_fn, **_kwargs):
            evaluate_engine_fn(5e6, 4e6)
            session.app_state.set_config(other)  # the edit lands mid-burn
            monkeypatch.setattr(session.app_state.runner, "evaluate", engine("written mid-run"))
            evaluate_engine_fn(5e6, 4e6)
            raise _Recorded()

        monkeypatch.setattr(blowdown, "simulate_coupled_blowdown", simulate)
        with pytest.raises(HTTPException):
            await timeseries_router.generate_from_segments(
                timeseries_router.SegmentsRequest(
                    duration_s=5.0, n_points=11, blowdown_mode=True,
                    lox_initial_pressure_psi=600, fuel_initial_pressure_psi=550,
                ),
                session=session,
            )

    asyncio.run(main())
    assert engines == ["started on", "started on"], (
        f"engine calls went to {engines}: the blowdown run switched runners when the config was "
        "written mid-run. Take the runner once, from session.app_state.snapshot()."
    )


def test_set_config_swaps_config_and_runner_together(monkeypatch):
    """While the new runner builds (seconds, for a CEA cache), a solve that starts takes the old pair."""
    from backend import state as state_mod

    app = state_mod.AppState()
    old_config, old_runner, new_config = object(), object(), object()
    app.config, app.runner = old_config, old_runner
    taken: list = []

    class BuildingRunner:
        def __init__(self, config):
            # What a solve starting now, on another thread, would take. Not blocked by the build.
            t = threading.Thread(target=lambda: taken.append(app.snapshot()))
            t.start()
            t.join(timeout=5)
            assert not t.is_alive(), "snapshot() waited for the runner to build"

    monkeypatch.setattr(state_mod, "PintleEngineRunner", BuildingRunner)
    app.set_config(new_config)

    assert taken == [(old_config, old_runner)], (
        "a solve starting while the runner built took the new config beside the old runner"
    )
    assert app.config is new_config and isinstance(app.runner, BuildingRunner)
