"""Phase 11b: a line's loss as the drawing itemises it.

The bug these guard against is not a wrong correlation. It is a *silently
discarded* one: ``data.segments`` was written by the drawing editor and never
read, so a line somebody had itemised down to the elbow arrived at the solver as
an unstated line and got a default. The drawing was greying out the line-level
Length and Bore and saying "superseded by the segments below", and the
superseded field was the only one being read.

So these tests are mostly about *which* number won.
"""

from __future__ import annotations

import math

import pytest

from feedtwin.comps import build_component
from feedtwin.comps.base import FlowConditions
from feedtwin.comps.correlations import darcy_friction_factor
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.model.segments import LineLoss, LineSegment
from feedtwin.pid import DiagramError, read_diagram
from feedtwin.pid.segments import read_segments

RHO, MU = 789.0, 1.2e-3
"""Ethanol at room temperature, near enough. The numbers below are hand-worked
against these, so they are constants of the test and not of the fluid."""

FLOW = FlowConditions(rho=RHO, mu=MU, p_upstream=4.0e6, temperature=293.15)


def measured(value: float, unit: str) -> dict[str, object]:
    return {"value": value, "unit": unit, "source": "measured"}


def pipe(segments, **params) -> object:
    return build_component(
        ComponentInstance.build(
            "L1", "pipe", params, model="segmented", segments=segments
        )
    )


# --------------------------------------------------------------- the reader


def test_a_segment_list_is_read_at_all() -> None:
    """The whole point. `PidEdge.segments` used not to exist."""
    loss = read_segments(
        [{"id": "s1", "bore": measured(10.2, "mm"), "length": measured(1.6, "m")}],
        "edge L1",
    )
    assert len(loss) == 1
    assert loss.segments[0].bore_si == pytest.approx(0.0102)
    assert loss.segments[0].method == "itemised", "a silent segment is itemised"


def test_a_line_with_no_segments_is_empty_not_defaulted() -> None:
    """Every drawing that shipped before this has no segments and must not move."""
    for raw in (None, [], {}, "segments", 7):
        assert read_segments(raw, "edge L1") == LineLoss()


def test_a_value_with_no_provenance_is_refused() -> None:
    """Same contract as every other parameter: no source, no number.

    A silent default here would turn a format mismatch -- a document written by
    something that is not this drawing tool -- into a figure nobody checked.
    """
    with pytest.raises(DiagramError, match="source"):
        read_segments([{"id": "s1", "bore": {"value": 10.2, "unit": "mm"}}], "edge L1")


def test_the_ladder_reports_the_best_and_the_worst() -> None:
    loss = read_segments(
        [
            {
                "id": "a",
                "method": "curve",
                "bore": measured(10.0, "mm"),
                "curve": {
                    "mdot": [0.0, 1.0],
                    "mdotUnit": "kg/s",
                    "dp": [0.0, 10.0],
                    "dpUnit": "psi",
                },
            },
            {
                "id": "b",
                "method": "lumped_K",
                "bore": measured(10.0, "mm"),
                "K": measured(2.0, "-"),
            },
        ],
        "edge L1",
    )
    assert loss.method == "curve", "the line is as well known as its best segment"
    assert loss.weakest_method == "lumped_K", "and only as trustworthy as its worst"


def test_a_curve_keeps_its_units() -> None:
    """psi on the wire, Pa in the solver. Reading it as Pa would be 6895x wrong."""
    loss = read_segments(
        [
            {
                "id": "s",
                "method": "curve",
                "curve": {
                    "mdot": [0.0, 0.5, 1.0],
                    "mdotUnit": "kg/s",
                    "dp": [0.0, 10.0, 40.0],
                    "dpUnit": "psi",
                },
            }
        ],
        "edge L1",
    )
    curve = loss.segments[0].curve
    assert curve is not None
    assert curve(0.75) == pytest.approx(25.0 * 6894.757293168361)


def test_a_malformed_curve_is_reported_not_swallowed() -> None:
    """A run somebody flowed and recorded badly is a thing to go and fix."""
    loss = read_segments(
        [
            {
                "id": "s",
                "method": "curve",
                "curve": {"mdot": [1.0, 1.0], "dp": [0.0, 1.0]},
            }
        ],
        "edge L1",
    )
    assert loss.segments[0].curve is None
    assert any("cannot be read" in w for w in loss.warnings)


def test_an_unknown_fitting_is_carried_and_reported() -> None:
    """The drawing is allowed to be ahead of the solver. A dropped elbow is not."""
    loss = read_segments(
        [
            {
                "id": "s",
                "bore": measured(10.0, "mm"),
                "length": measured(1.0, "m"),
                "fittings": [{"kind": "venturi", "count": 1}],
            }
        ],
        "edge L1",
    )
    assert [f.kind for f in loss.segments[0].fittings] == ["venturi"]
    assert any("venturi" in w and "price" in w for w in loss.warnings)


# ------------------------------------------------------------- the physics


def test_one_segment_is_the_darcy_pipe_exactly() -> None:
    """The new path must not move an answer the old path already got right.

    Bit-identical, not approximately: a segmented run of one segment is the same
    equation with the same friction factor at the same Reynolds number.
    """
    plain = build_component(
        ComponentInstance.build(
            "L1",
            "pipe",
            {
                "length": Param(1.6, "m", Provenance.MEASURED),
                "bore": Param(10.2, "mm", Provenance.MEASURED),
            },
            model="darcy",
        )
    )
    loss = read_segments(
        [{"id": "s", "bore": measured(10.2, "mm"), "length": measured(1.6, "m")}],
        "edge L1",
    )
    assert pipe(loss.segments).pressure_drop(1.0, FLOW) == plain.pressure_drop(
        1.0, FLOW
    )


def test_friction_matches_darcy_weisbach_worked_by_hand() -> None:
    """Against the equation, not against the other code path."""
    bore, length, mdot = 0.0102, 1.6, 1.0
    area = math.pi * bore * bore / 4.0
    v = mdot / (RHO * area)
    Re = RHO * v * bore / MU
    fd = darcy_friction_factor(Re, 1.5e-6 / bore, "Clamond")
    hand = fd * length / bore * 0.5 * RHO * v * v

    loss = read_segments(
        [{"id": "s", "bore": measured(10.2, "mm"), "length": measured(1.6, "m")}],
        "edge L1",
    )
    assert pipe(loss.segments).pressure_drop(mdot, FLOW) == pytest.approx(hand)


def test_a_fitting_body_is_not_also_tube() -> None:
    """A fitting's K already contains its own friction.

    Counting the elbow's own arc as tube *and* pricing the elbow pays for it
    twice. Three long-radius elbows in a 1.6 m run are about 72 mm, which is
    the several percent of dp this asserts is actually removed.
    """
    rows = [{"kind": "elbow_90", "count": 3, "lengthMm": 30, "engagementMm": 6}]
    base = {
        "id": "s",
        "bore": measured(10.2, "mm"),
        "length": measured(1.6, "m"),
        "fittings": rows,
    }
    as_tube = read_segments([{**base, "lengthBasis": "tube"}], "edge L1")
    end_to_end = read_segments([{**base, "lengthBasis": "overall"}], "edge L1")

    assert as_tube.segments[0].tube_length() == pytest.approx(1.6)
    assert end_to_end.segments[0].tube_length() == pytest.approx(1.6 - 3 * 0.024)

    over = pipe(end_to_end.segments).pressure_drop(1.0, FLOW)
    tube = pipe(as_tube.segments).pressure_drop(1.0, FLOW)
    assert over < tube, "the end-to-end run has less tube in it, so less friction"
    assert (tube - over) / over == pytest.approx(0.0369, abs=0.002)


def test_an_unmeasurable_body_length_refuses_to_guess() -> None:
    """A partial subtraction is a wrong number that looks careful."""
    loss = read_segments(
        [
            {
                "id": "s",
                "bore": measured(10.0, "mm"),
                "length": measured(1.0, "m"),
                "lengthBasis": "overall",
                "fittings": [
                    {"kind": "elbow_90", "count": 1, "lengthMm": 30},
                    {"kind": "tee_run", "count": 1},
                ],
            }
        ],
        "edge L1",
    )
    assert loss.segments[0].tube_length() == pytest.approx(1.0)
    assert any("counted twice" in w for w in loss.warnings)


def test_a_bore_change_is_a_reducer_nobody_drew() -> None:
    """Two adjacent segments of different bore *are* the transition.

    Making somebody add a row for it is a step they can forget, and then the run
    is quietly cheap.
    """
    straight = read_segments(
        [
            {"id": "a", "bore": measured(10.2, "mm"), "length": measured(0.8, "m")},
            {"id": "b", "bore": measured(10.2, "mm"), "length": measured(0.8, "m")},
        ],
        "edge L1",
    )
    stepped = read_segments(
        [
            {"id": "a", "bore": measured(10.2, "mm"), "length": measured(0.8, "m")},
            {"id": "b", "bore": measured(7.75, "mm"), "length": measured(0.8, "m")},
        ],
        "edge L1",
    )
    assert pipe(stepped.segments).pressure_drop(1.0, FLOW) > pipe(
        straight.segments
    ).pressure_drop(1.0, FLOW)


def test_the_bore_is_inside_the_sum_not_averaged() -> None:
    """Why this class exists.

    Velocity head goes as D^-4 and L/D adds a fifth power, so the loss of a run
    that steps bore is nowhere near the loss of the same run at its mean bore.
    Lumping under-predicts by tens of percent, always in the unsafe direction.
    """
    stepped = read_segments(
        [
            {"id": "a", "bore": measured(10.2, "mm"), "length": measured(0.8, "m")},
            {"id": "b", "bore": measured(7.75, "mm"), "length": measured(0.8, "m")},
        ],
        "edge L1",
    )
    lumped = read_segments(
        [
            {
                "id": "a",
                "bore": measured((10.2 + 7.75) / 2, "mm"),
                "length": measured(1.6, "m"),
            }
        ],
        "edge L1",
    )
    real = pipe(stepped.segments).pressure_drop(1.0, FLOW)
    mean = pipe(lumped.segments).pressure_drop(1.0, FLOW)
    assert mean < real
    assert (real - mean) / real > 0.25


def test_velocity_is_reported_at_the_tightest_bore() -> None:
    """Where a velocity limit bites and where cavitation starts."""
    loss = read_segments(
        [
            {"id": "a", "bore": measured(10.2, "mm"), "length": measured(0.8, "m")},
            {"id": "b", "bore": measured(7.75, "mm"), "length": measured(0.8, "m")},
        ],
        "edge L1",
    )
    diagnostics = pipe(loss.segments).diagnostics(1.0, FLOW)
    assert diagnostics["bore_min"] == pytest.approx(0.00775)
    assert diagnostics["velocity"] == pytest.approx(
        1.0 / (RHO * math.pi * 0.00775**2 / 4.0)
    )
    assert diagnostics["segments"] == 2.0


def test_a_measured_segment_beats_the_correlation() -> None:
    """Top of the ladder. The curve's number is used, not a friction factor."""
    loss = read_segments(
        [
            {
                "id": "s",
                "method": "curve",
                "bore": measured(10.0, "mm"),
                "length": measured(50.0, "m"),
                "curve": {
                    "mdot": [0.0, 2.0],
                    "mdotUnit": "kg/s",
                    "dp": [0.0, 1.0],
                    "dpUnit": "psi",
                },
            }
        ],
        "edge L1",
    )
    dp = pipe(loss.segments).pressure_drop(1.0, FLOW)
    assert dp == pytest.approx(
        0.5 * 6894.757293168361
    ), "fifty metres of correlation must not leak past a measured curve"


def test_a_curve_is_continued_quadratically_not_clamped() -> None:
    """A clamped curve takes the flow dependence out of the branch equation.

    That is a singular Jacobian, not a conservative answer -- so past the last
    measured point the turbulent law the curve is a measurement *of* carries it.
    """
    loss = read_segments(
        [
            {
                "id": "s",
                "method": "curve",
                "curve": {
                    "mdot": [0.0, 1.0],
                    "mdotUnit": "kg/s",
                    "dp": [0.0, 100.0],
                    "dpUnit": "Pa",
                },
            }
        ],
        "edge L1",
    )
    line = pipe(loss.segments)
    assert line.pressure_drop(1.0, FLOW) == pytest.approx(100.0)
    assert line.pressure_drop(2.0, FLOW) == pytest.approx(400.0)
    assert line.pressure_drop(1.5, FLOW) > line.pressure_drop(1.0, FLOW)


def test_a_segmented_line_needs_a_segment_list() -> None:
    from feedtwin.model import SpecError

    with pytest.raises(SpecError, match="segment list"):
        pipe(())


# --------------------------------------------------------- through the drawing


def _drawing(segments: list[dict[str, object]]) -> dict[str, object]:
    """Two bottles and a line, which is the smallest thing that has an edge."""
    return {
        "name": "segment smoke",
        "nodes": [
            {
                "id": "n1",
                "type": "KBOTTLE",
                "data": {
                    "label": "K-01",
                    "fluidType": "nitrogen",
                    "params": {
                        "pressure": measured(2000.0, "psi"),
                        "volume": measured(50.0, "L"),
                    },
                },
            },
            {"id": "n2", "type": "VENT", "data": {"label": "V-01"}},
        ],
        "edges": [
            {
                "id": "L1",
                "source": "n1",
                "target": "n2",
                "data": {
                    "lineType": "pipe",
                    "params": {
                        "length": measured(9.9, "m"),
                        "bore": measured(25.0, "mm"),
                    },
                    "segments": segments,
                },
            }
        ],
    }


def test_the_line_level_length_is_superseded_not_added() -> None:
    """The drawing greys those fields out. Summing both is the double-count."""
    doc = _drawing(
        [{"id": "s", "bore": measured(6.0, "mm"), "length": measured(0.4, "m")}]
    )
    built = read_diagram(doc)
    edge = next(e for e in built.edges if e.id == "L1")
    assert len(edge.segments) == 1
    assert edge.params["length"].si == pytest.approx(9.9), "still on the drawing"

    from feedtwin.pid import build_network

    network = build_network(built)
    line = network.network.branches["L1"].component
    assert line.instance.model == "segmented"
    assert "length" not in line.p, "9.9 m of leftover must not reach the solver"
    assert line.diagnostics(0.01, FLOW)["length_tube"] == pytest.approx(0.4)


def test_a_drawing_without_segments_still_builds_a_darcy_pipe() -> None:
    from feedtwin.pid import build_network

    network = build_network(read_diagram(_drawing([])))
    line = network.network.branches["L1"].component
    assert line.instance.model == "darcy"
    assert line.p["length"] == pytest.approx(9.9)


def test_a_superseded_line_level_length_is_said_out_loud() -> None:
    """The spec would drop it anyway -- but silently, and 9.9 m is a lot to lose.

    If the segments turn out to be wrong, the stale line-level value is the
    first place anybody would look, so the run report has to mention it.
    """
    from feedtwin.pid import build_network

    doc = _drawing(
        [{"id": "s", "bore": measured(6.0, "mm"), "length": measured(0.4, "m")}]
    )
    network = build_network(read_diagram(doc))
    assert any(
        "superseded" in w and "9.9 m" in w for w in network.warnings
    ), network.warnings


def test_nothing_is_said_when_there_was_nothing_to_supersede() -> None:
    from feedtwin.pid import build_network

    doc = _drawing(
        [{"id": "s", "bore": measured(6.0, "mm"), "length": measured(0.4, "m")}]
    )
    doc["edges"][0]["data"]["params"] = {}
    network = build_network(read_diagram(doc))
    assert not any("superseded" in w for w in network.warnings)


def test_a_sketched_bend_is_priced_at_its_own_radius_and_angle() -> None:
    """A bend from the centerline sketch carries r/D and the angle it turns.
    The reader keeps both, and the run prices the bend on them rather than
    on the correlation's defaults -- a tight bend and a sweep are not the
    same fitting."""
    from feedtwin.pid.segments import read_segments

    def run(bend: dict) -> float:
        loss = read_segments(
            [
                {
                    "id": "s1",
                    "bore": {"value": 10.0, "unit": "mm", "source": "measured"},
                    "length": {"value": 1.0, "unit": "m", "source": "measured"},
                    "fittings": [{"kind": "bend", "count": 1, **bend}],
                }
            ],
            "L1",
        )
        fitting = loss.segments[0].fittings[0]
        return fitting.bend_diameters, fitting.angle  # type: ignore[return-value]

    assert run({"bendDiameters": 1.5, "angleDeg": 90.0}) == (1.5, 90.0)
    assert run({}) == (0.0, 0.0)
