"""A measured component whose flow-bench sweep does not start at zero.

Flow benches rarely measure at zero flow, and a Newton solve starts every
branch at 1 g/s and probes past the top of any sweep. A measurement that
brackets the operating point must solve, the excursions off its ends are
continued (``dp ~ mdot^2``, the law the curve measures) and flagged, and a solve
asked not to raise never raises.
"""

from __future__ import annotations

import pytest

from feedtwin.comps import build_component
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.model.curve import Curve
from feedtwin.solve.network import Network
from feedtwin.solve.steady import solve_steady

PSI = 6894.757293168361
BENCH = Curve(
    x=(0.05, 0.1, 0.2),
    y=(2.0, 8.0, 32.0),
    x_unit="kg/s",
    y_unit="psi",
    source=Provenance.MEASURED,
)


def _measured(tag: str) -> object:
    return build_component(
        ComponentInstance.build(
            tag, "valve", {}, curves={"dp_mdot": BENCH}, model="measured"
        )
    )


def _ethanol(net: Network, *nodes: tuple[str, float | None]) -> None:
    for node_id, psia in nodes:
        net.add_node(
            node_id, "ethanol", 293.0, pressure=None if psia is None else psia * PSI
        )
        net.nodes[node_id].phase = "liquid"


def test_a_sweep_that_brackets_the_answer_solves() -> None:
    """20 psi across a sweep of 2-32 psi over 0.05-0.2 kg/s: inside the curve
    (8 psi at 0.1, 32 at 0.2, so about 0.158 kg/s). The first iterate at
    1 g/s used to raise off the bottom of the curve and fail the solve."""
    net = Network()
    _ethanol(net, ("A", 520.0), ("B", 500.0))
    net.add_branch("M", _measured("M"), "A", "B")  # type: ignore[arg-type]
    result = solve_steady(net)
    assert result.converged
    flow = result.flows["M"]
    assert 0.1 < flow < 0.2
    assert BENCH(flow) / PSI == pytest.approx(20.0, rel=1e-6)
    assert result.diagnostics["M"]["extrapolated"] == 0.0


def test_a_capped_measured_stub_back_fills_without_raising() -> None:
    """A capped stub is back-filled at exactly zero flow, off the curve."""
    net = Network()
    _ethanol(net, ("A", 520.0), ("D", 500.0), ("S", None))
    pipe = build_component(
        ComponentInstance.build(
            "L",
            "pipe",
            {
                "length": Param(1.0, "m", Provenance.MEASURED, ""),
                "bore": Param(9.5, "mm", Provenance.MEASURED, ""),
            },
        )
    )
    net.add_branch("L", pipe, "A", "D")  # type: ignore[arg-type]
    net.add_branch("M", _measured("M"), "A", "S")  # type: ignore[arg-type]
    result = solve_steady(net, raise_on_failure=False)
    assert result.converged
    assert result.flows["M"] == 0.0
    assert result.pressures["S"] == pytest.approx(result.pressures["A"])


def test_off_the_ends_is_continued_quadratically_and_flagged() -> None:
    """Above the sweep the loss keeps its measured ``mdot^2`` shape, and the
    diagnostics say the point was not measured."""
    element = _measured("M")
    net = Network()
    _ethanol(net, ("A", 600.0))
    flow = net.conditions("A", 600.0 * PSI)
    top = BENCH(0.2)
    assert element.pressure_drop(0.4, flow) == pytest.approx(4.0 * top)  # type: ignore[attr-defined]
    assert element.pressure_drop(0.025, flow) == pytest.approx(BENCH(0.05) / 4.0)  # type: ignore[attr-defined]
    assert element.pressure_drop(0.0, flow) == 0.0  # type: ignore[attr-defined]
    assert element.diagnostics(0.4, flow)["extrapolated"] == 1.0  # type: ignore[attr-defined]
    assert element.diagnostics(0.1, flow)["extrapolated"] == 0.0  # type: ignore[attr-defined]
