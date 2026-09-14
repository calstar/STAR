"""The COPV study, as a job the app runs.

The physics it produces is covered by the library and session tests. This is
about the job: that it validates before it starts, that only one runs at a
time, that progress and cancel behave, and that whatever comes back is shaped
the way the view expects.

Deliberately *not* run end to end here. A single burn case costs about a minute
of wall clock, and a test suite that takes fifteen minutes is a test suite
nobody runs. The one case that does execute is the smallest possible.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app, library
from dataclasses import replace

from backend.study import (
    DIAGRAMS,
    find_diagram,
    StudyRequest,
    StudyRunner,
    SweepPoint,
    Trace,
    _floor,
)

client = TestClient(app)

#: The study drawings, put into whatever library the tests are pointed at.
#:
#: The app seeds its shipped stand on import; these two are study fixtures and
#: are not part of that. Seeded here so the job tests exercise the real
#: validation path rather than a 404 that happens to look like a pass.
DIAGRAM_DIR = Path(__file__).resolve().parents[1] / "backend" / "diagrams"


#: The engine the study burns. Shipped with EngineDesign, not with this app.
ENGINE_CONFIG = (
    Path(__file__).resolve().parents[2]
    / "EngineDesign"
    / "configs"
    / "ethalox_doublet_7000N.yaml"
)


@pytest.fixture(scope="module", autouse=True)
def _fixtures() -> None:
    """Put the study drawings and an engine in whatever library is active.

    The app seeds its shipped stand on import; the study drawings and the motor
    are not part of that. Without them the job tests would get a 404 that looks
    a lot like a pass.
    """
    for gas, name in DIAGRAMS.items():
        if find_diagram(library, gas) is not None:
            continue
        source = DIAGRAM_DIR / f"{name}.json"
        if not source.is_file():
            pytest.skip(f"{source.name} is not in the repo")
        response = client.post(
            "/api/library/diagrams",
            files={"file": (source.name, source.read_bytes(), "application/json")},
        )
        assert response.status_code < 300, response.text

    if not library.list("engine"):
        if not ENGINE_CONFIG.is_file():
            pytest.skip("no engine config to seed the study with")
        library.add(
            ENGINE_CONFIG.read_bytes(),
            kind="engine",
            name="ethalox doublet 7000N",
            source="shipped",
            suffix=".yaml",
        )


def status() -> dict:
    response = client.get("/api/study")
    assert response.status_code == 200, response.text
    return response.json()


def idle() -> None:
    """Leave the shared runner free for the next test."""
    client.post("/api/study/cancel")
    for _ in range(600):
        if not status()["running"]:
            return
        time.sleep(0.1)
    raise AssertionError("a study is still running")


@pytest.fixture(autouse=True)
def _quiet() -> object:
    idle()
    yield
    idle()


# ------------------------------------------------------------------ the shape


def test_status_is_available_before_anything_has_run() -> None:
    body = status()
    assert body["running"] is False
    assert body["traces"] == [] and body["sweep"] == []
    assert 0.0 <= body["progress"] <= 1.0


def test_an_unknown_gas_is_refused_with_the_known_ones() -> None:
    response = client.post("/api/study", json={"gases": ["argon"]})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "argon" in detail
    for gas in DIAGRAMS:
        assert gas in detail


def test_no_gas_at_all_is_refused() -> None:
    assert client.post("/api/study", json={"gases": []}).status_code == 422


# ------------------------------------------------------------- the case count


@pytest.mark.parametrize(
    "request_, expected",
    [
        (StudyRequest(gases=("gn2",)), 1),
        (StudyRequest(gases=("gn2", "he")), 2),
        (StudyRequest(gases=("gn2",), bigger=True), 2),
        (StudyRequest(gases=("gn2", "he"), bigger=True, collapse=True), 6),
        (StudyRequest(gases=("gn2",), sweep=True), 6),
        (StudyRequest(gases=("gn2", "he"), sweep=True), 12),
    ],
)
def test_the_case_count_is_what_the_view_promises(
    request_: StudyRequest, expected: int
) -> None:
    """The view multiplies these out to tell an operator how long to wait. If
    the two disagree, the progress bar lies about a job that takes minutes."""
    assert request_.cases() == expected


def test_two_requests_that_differ_have_different_keys() -> None:
    assert StudyRequest(gases=("gn2",)).key() != StudyRequest(gases=("he",)).key()
    assert StudyRequest(sweep=True).key() != StudyRequest(sweep=False).key()
    assert (
        StudyRequest(gases=("gn2", "he")).key()
        == StudyRequest(gases=("he", "gn2")).key()
    ), "gas order is not a different study"


# ------------------------------------------------------------------ the floor


def _trace(**over: object) -> Trace:
    base = dict(
        key="k",
        gas="gn2",
        label="l",
        litres=4.7,
        collapse=False,
        t=[-0.5, 0.1, 0.4, 1.0],
        ox_psi=[550.0, 400.0, 520.0, 540.0],
        fuel_psi=[550.0, 405.0, 525.0, 545.0],
        copv_psi=[4500.0] * 4,
        chamber_psi=[0.0] * 4,
        thrust_n=[0.0] * 4,
        converged=[True, True, True, True],
        depleted_s=None,
        failed_ticks=0,
    )
    base.update(over)
    return Trace(**base)  # type: ignore[arg-type]


def test_the_floor_ignores_the_ignition_transient() -> None:
    """The sweep asks whether the bottle can *hold* the tanks. The 50 ms dip as
    droop and line loss appear is a different question, answered by the traces
    -- and it is deep enough to swamp the number if it is counted."""
    assert _floor(_trace()) == 520.0, "the t=0.1 dip should not set the floor"


def test_the_floor_ignores_ticks_that_did_not_converge() -> None:
    """A failed solve is not a measurement, and one spurious dip poisons a
    minimum. This is why every sample carries its own convergence flag."""
    spoiled = _trace(
        t=[-0.5, 0.4, 0.6, 1.0],
        ox_psi=[550.0, 520.0, 12.0, 540.0],
        fuel_psi=[550.0, 525.0, 14.0, 545.0],
        converged=[True, True, False, True],
    )
    assert _floor(spoiled) == 520.0


def test_a_trace_with_nothing_usable_reports_zero_rather_than_raising() -> None:
    assert _floor(_trace(converged=[False] * 4)) == 0.0


# -------------------------------------------------------------- the runner


def test_only_one_study_runs_at_a_time() -> None:
    """Each case pins a core for a minute. Two would make both slower and the
    progress meaningless."""
    runner = StudyRunner()
    runner.running = True
    assert runner.start(None, "", "", StudyRequest()) is False  # type: ignore[arg-type]


def test_a_second_request_over_http_is_refused_while_one_is_in_flight() -> None:
    first = client.post("/api/study", json={"gases": ["gn2"]})
    assert first.status_code == 200, first.text
    try:
        second = client.post("/api/study", json={"gases": ["he"]})
        assert second.status_code == 409
        assert "already running" in second.json()["detail"]
    finally:
        idle()


def test_cancelling_stops_the_run_and_keeps_what_finished() -> None:
    started = client.post("/api/study", json={"gases": ["gn2", "he"]})
    assert started.status_code == 200, started.text
    assert status()["running"] is True

    client.post("/api/study/cancel")
    for _ in range(900):
        if not status()["running"]:
            break
        time.sleep(0.1)
    body = status()
    assert body["running"] is False
    assert body["stage"] in {"cancelled", "done"}
    assert body["error"] == ""
    # Whatever it managed is still shaped correctly and still plottable.
    for trace in body["traces"]:
        assert len(trace["t"]) == len(trace["ox_psi"]) == len(trace["converged"])
        assert trace["litres"] > 0


def test_a_finished_result_carries_what_it_was_run_with() -> None:
    """The view labels the plots from this. A result that does not say which
    gases produced it is a result somebody will mislabel."""
    body = status()
    assert set(body) >= {"gases", "bigger", "collapse", "swept", "bottle_litres"}


def test_the_thermal_options_are_part_of_the_cache_key() -> None:
    """Two runs that differ only in physics must not share a cached result.

    `key()` is what decides whether a request is "the same run". Leaving the
    thermal switches out of it would serve a no-vapour trace to someone who
    asked for vapour, which is the worst possible failure for a study whose
    whole output is a comparison.
    """
    from backend.study import StudyRequest

    base = StudyRequest(gases=("gn2", "he"))
    assert base.key() != replace(base, vapour=True).key()
    assert base.key() != replace(base, chilldown=50.0).key()
    assert replace(base, chilldown=50.0).key() != replace(base, chilldown=200.0).key()


def test_the_thermal_options_default_off() -> None:
    from backend.study import StudyRequest

    request = StudyRequest()
    assert request.vapour is False
    assert request.chilldown == 0.0


def test_the_thermal_options_do_not_add_cases() -> None:
    """Unlike `collapse`, which adds its own extra case so you can see the
    difference, vapour and chilldown apply to every case in the run -- so a
    trace stays comparable across gases and the case count is unchanged."""
    from backend.study import StudyRequest

    base = StudyRequest(gases=("gn2", "he"))
    assert replace(base, vapour=True, chilldown=50.0).cases() == base.cases()
    assert replace(base, collapse=True).cases() == 2 * base.cases()
