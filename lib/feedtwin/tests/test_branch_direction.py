"""A symmetric component does not care which way it was drawn.

pid-designer reads a symbol's in/out from its left/right ports, so a vent or
press solenoid placed mirrored is a branch drawn against its flow. The solve
used to price every branch at its drawn upstream node -- the low-pressure end
when the flow runs backwards -- and never let reverse flow choke: a Cv 4 valve
on 3000 psia nitrogen to atmosphere passed 3.81 kg/s drawn with the flow and
0.47 drawn against it, both converged.

One-way laws keep their drawn direction: a check valve, a regulator, a relief.
"""

from __future__ import annotations

import pytest

from feedtwin.comps import build_component
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.solve.network import Network
from feedtwin.solve.steady import solve_steady

PSI = 6894.757293168361
M = Provenance.MANUFACTURER


def _valve() -> object:
    return build_component(
        ComponentInstance.build(
            "V",
            "valve",
            {"Cv": Param(4.0, "Cv", M, ""), "bore": Param(9.5, "mm", M, "")},
        )
    )


def _pipe() -> object:
    return build_component(
        ComponentInstance.build(
            "L",
            "pipe",
            {"length": Param(1.0, "m", M, ""), "bore": Param(6.0, "mm", M, "")},
        )
    )


def _flow(tank_psia: float, drawn_with_the_flow: bool, part: object) -> float:
    """A gas tank to atmosphere through one component, drawn either way.
    Returned as the flow out of the tank."""
    net = Network()
    net.add_node("tank", "nitrogen", 293.0, pressure=tank_psia * PSI)
    net.add_node("atm", "nitrogen", 293.0, pressure=14.7 * PSI)
    for node in net.nodes.values():
        node.phase = "gas"
    if drawn_with_the_flow:
        net.add_branch("X", part, "tank", "atm")  # type: ignore[arg-type]
    else:
        net.add_branch("X", part, "atm", "tank")  # type: ignore[arg-type]
    result = solve_steady(net)
    assert result.converged
    return result.flows["X"] if drawn_with_the_flow else -result.flows["X"]


@pytest.mark.parametrize("tank_psia", [30.0, 100.0, 500.0, 3000.0])
def test_a_valve_drawn_either_way_passes_the_same_flow(tank_psia: float) -> None:
    forward = _flow(tank_psia, True, _valve())
    backward = _flow(tank_psia, False, _valve())
    assert forward > 0.0
    assert backward == pytest.approx(forward, rel=1e-6)


def test_reverse_flow_chokes_like_forward_flow() -> None:
    """3000 psia to atmosphere is far past the critical ratio either way."""
    net = Network()
    net.add_node("tank", "nitrogen", 293.0, pressure=3000.0 * PSI)
    net.add_node("atm", "nitrogen", 293.0, pressure=14.7 * PSI)
    for node in net.nodes.values():
        node.phase = "gas"
    valve = _valve()
    net.add_branch("X", valve, "atm", "tank")  # type: ignore[arg-type]
    result = solve_steady(net)
    assert result.converged
    ceiling = valve.flow_ceiling(net.conditions("tank", 3000.0 * PSI))  # type: ignore[attr-defined]
    assert result.flows["X"] == pytest.approx(-ceiling, rel=1e-6)
    assert result.choked_branches == ["X"]


def test_a_gas_pipe_drawn_either_way_passes_the_same_flow() -> None:
    forward = _flow(100.0, True, _pipe())
    backward = _flow(100.0, False, _pipe())
    assert backward == pytest.approx(forward, rel=1e-6)


def test_a_check_valve_keeps_its_drawn_direction() -> None:
    """Drawn against the gradient it holds: a one-way law is not mirrored."""
    check = build_component(
        ComponentInstance.build(
            "CV",
            "check_valve",
            {
                "Cv": Param(4.0, "Cv", M, ""),
                "bore": Param(9.5, "mm", M, ""),
                "cracking_pressure": Param(3.0, "psi", M, ""),
            },
        )
    )
    assert not check.symmetric
    assert _valve().symmetric  # type: ignore[attr-defined]
