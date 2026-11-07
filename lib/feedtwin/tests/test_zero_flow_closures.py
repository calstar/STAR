"""A one-way device between zero flow and its opening pressure is shut.

A check valve's cracking pressure and a regulator's lockup rise both step the
branch relation at zero flow. With the far side inside that step there was no
root -- forward needed at least the step, reverse at most nothing -- and every
solve failed, which is exactly where a tank pressed through a check valve, or
held by a regulator at lockup, comes to rest. Inside the step the device is
shut: zero flow, the pressures either side free.
"""

from __future__ import annotations

import pytest

from feedtwin.comps import build_component
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.solve.network import Network
from feedtwin.solve.steady import solve_steady

PSI = 6894.757293168361
M = Provenance.MEASURED


def _pipe(tag: str, length: float = 1.0) -> object:
    return build_component(
        ComponentInstance.build(
            tag,
            "pipe",
            {
                "length": Param(length, "m", M, ""),
                "bore": Param(9.5, "mm", M, ""),
                "roughness": Param(1.5e-6, "m", M, ""),
            },
        )
    )


def _checked(drop_psi: float) -> object:
    """A -> pipe -> check valve (3 psi crack) -> pipe -> B, ``drop_psi`` apart."""
    net = Network()
    net.add_node("A", "nitrogen", 293.0, pressure=500.0 * PSI)
    net.add_node("M", "nitrogen", 293.0)
    net.add_node("N", "nitrogen", 293.0)
    net.add_node("B", "nitrogen", 293.0, pressure=(500.0 - drop_psi) * PSI)
    for node in net.nodes.values():
        node.phase = "gas"
    check = build_component(
        ComponentInstance.build(
            "CV",
            "check_valve",
            {
                "Cv": Param(1.0, "Cv", M, ""),
                "bore": Param(9.5, "mm", M, ""),
                "cracking_pressure": Param(3.0, "psi", M, ""),
                "leak_reverse": Param(1e-4, "Cv", M, ""),
            },
        )
    )
    net.add_branch("P1", _pipe("P1"), "A", "M")  # type: ignore[arg-type]
    net.add_branch("CV", check, "M", "N")  # type: ignore[arg-type]
    net.add_branch("P2", _pipe("P2"), "N", "B")  # type: ignore[arg-type]
    return solve_steady(net, raise_on_failure=False, tol=1e-4)


@pytest.mark.parametrize("drop_psi", [1.0, 1.5, 2.0, 2.9])
def test_a_check_valve_below_its_cracking_pressure_is_shut(drop_psi: float) -> None:
    result = _checked(drop_psi)
    assert result.converged  # type: ignore[attr-defined]
    assert result.flows["CV"] == pytest.approx(0.0, abs=1e-12)  # type: ignore[attr-defined]


@pytest.mark.parametrize("drop_psi", [3.1, 5.0, 20.0])
def test_a_check_valve_past_its_cracking_pressure_flows(drop_psi: float) -> None:
    result = _checked(drop_psi)
    assert result.converged  # type: ignore[attr-defined]
    assert result.flows["CV"] > 0.0  # type: ignore[attr-defined]


def _regulated(tank_psia: float, rise_psi: float) -> object:
    """3000 psia bottle -> regulator (500 psia, 20 psi droop at 0.05 kg/s,
    ``rise_psi`` of lockup rise) -> pipe -> a tank held at ``tank_psia``."""
    reg = build_component(
        ComponentInstance.build(
            "REG",
            "regulator",
            {
                "setpoint": Param(500.0, "psia", M, ""),
                "Cv": Param(0.8, "Cv", M, ""),
                "bore": Param(7.75, "mm", M, ""),
                "flow_droop": Param(20.0, "psi", M, ""),
                "rated_flow": Param(0.05, "kg/s", M, ""),
                "lockup_rise": Param(rise_psi, "psi", M, ""),
            },
            model="droop",
        )
    )
    net = Network()
    net.add_node("COPV", "nitrogen", 293.0, pressure=3000.0 * PSI)
    net.add_node("R", "nitrogen", 293.0)
    net.add_node("T", "nitrogen", 293.0, pressure=tank_psia * PSI)
    for node in net.nodes.values():
        node.phase = "gas"
    net.add_branch("REG", reg, "COPV", "R")  # type: ignore[arg-type]
    net.add_branch("L", _pipe("L", 0.5), "R", "T")  # type: ignore[arg-type]
    return solve_steady(net, raise_on_failure=False, tol=1e-4, max_iterations=120)


@pytest.mark.parametrize(
    "tank_psia", [495.0, 499.0, 500.5, 501.5, 502.4, 504.0, 504.9, 506.0, 508.0]
)
def test_a_regulator_inside_its_lockup_rise_solves(tank_psia: float) -> None:
    """5 psi of rise on a 500 psia setpoint: a tank anywhere from below the
    setpoint to past lockup has an answer. 500.5-502.4 psia had none. The flow
    falls to nothing as the tank comes up to lockup (505 psia)."""
    result = _regulated(tank_psia, 5.0)
    assert result.converged, tank_psia  # type: ignore[attr-defined]
    flow = result.flows["L"]  # type: ignore[attr-defined]
    if tank_psia >= 504.5:
        assert flow == pytest.approx(0.0, abs=2e-4), "at or past lockup it is shut"
    else:
        assert flow > 0.0


def _regulator(rise_psi: float) -> object:
    return build_component(
        ComponentInstance.build(
            "REG",
            "regulator",
            {
                "setpoint": Param(500.0, "psia", M, ""),
                "Cv": Param(0.8, "Cv", M, ""),
                "bore": Param(7.75, "mm", M, ""),
                "flow_droop": Param(20.0, "psi", M, ""),
                "rated_flow": Param(0.05, "kg/s", M, ""),
                "lockup_rise": Param(rise_psi, "psi", M, ""),
            },
            model="droop",
        )
    )


def test_the_rise_is_continuous_across_zero_flow() -> None:
    """Lockup (set + rise) at zero flow, the droop line once the rise is paid
    back, and no step between: the rise is lost at the droop's own rate."""
    from feedtwin.comps.base import FlowConditions

    reg = _regulator(5.0)
    flow = FlowConditions(rho=39.0, mu=1.8e-5, p_upstream=3000.0 * PSI)
    outlet = lambda m: (3000.0 * PSI - reg.pressure_drop(m, flow)) / PSI  # type: ignore[attr-defined]  # noqa: E731
    assert outlet(0.0) == pytest.approx(505.0)
    assert outlet(1e-9) == pytest.approx(505.0, abs=1e-5)
    # 5 psi of rise against 20 psi per 0.05 kg/s: paid back by 0.0125 kg/s.
    assert outlet(0.0125) == pytest.approx(500.0 - 5.0)
    assert outlet(0.05) == pytest.approx(500.0 - 20.0)


@pytest.mark.parametrize("mdot", [0.0, 1e-6, 0.01, 0.05, 0.2])
def test_with_no_rise_a_regulator_is_what_it_was(mdot: float) -> None:
    """The closure changes nothing for a regulator that declares no rise (the
    study drawings, LE4): outlet = set - droop m / rated, shut above it."""
    from feedtwin.comps.base import FlowConditions

    reg = _regulator(0.0)
    flow = FlowConditions(rho=39.0, mu=1.8e-5, p_upstream=3000.0 * PSI)
    dp = reg.pressure_drop(mdot, flow)  # type: ignore[attr-defined]
    assert dp == (3000.0 * PSI) - (500.0 * PSI - 20.0 * PSI * mdot / 0.05)
    shut = reg.is_choked(3000.0 * PSI - 502.6 * PSI, flow)  # type: ignore[attr-defined]
    regulating = reg.is_choked(  # type: ignore[attr-defined]
        3000.0 * PSI - 502.4 * PSI, flow
    )
    assert shut and not regulating
