"""The He/GN2 benchmark study's bookkeeping (``backend.benchmark_study``).

The physics it produces is covered by the library and session tests and
docs/PHYSICS-BENCHMARK.md. This is the request's arithmetic -- the case count
a progress bar is built from, the cache key, the floor -- and that only one
runs at a time. The Study tab's own study is ``tests/test_study.py``.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from backend.benchmark_study import StudyRequest, StudyRunner, Trace, _floor

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


def test_the_thermal_options_are_part_of_the_cache_key() -> None:
    """Two runs that differ only in physics must not share a cached result.

    `key()` is what decides whether a request is "the same run". Leaving the
    thermal switches out of it would serve a no-vapour trace to someone who
    asked for vapour, which is the worst possible failure for a study whose
    whole output is a comparison.
    """
    base = StudyRequest(gases=("gn2", "he"))
    assert base.key() != replace(base, vapour=True).key()
    assert base.key() != replace(base, chilldown=50.0).key()
    assert replace(base, chilldown=50.0).key() != replace(base, chilldown=200.0).key()


def test_the_thermal_options_default_off() -> None:
    request = StudyRequest()
    assert request.vapour is False
    assert request.chilldown == 0.0


def test_the_thermal_options_do_not_add_cases() -> None:
    """Unlike `collapse`, which adds its own extra case so you can see the
    difference, vapour and chilldown apply to every case in the run -- so a
    trace stays comparable across gases and the case count is unchanged."""
    base = StudyRequest(gases=("gn2", "he"))
    assert replace(base, vapour=True, chilldown=50.0).cases() == base.cases()
    assert replace(base, collapse=True).cases() == 2 * base.cases()
