"""Manifolds: a plenum with ports, and the three kinds of port.

The team's COPV manifold is the worked example -- one inlet, a transducer tap,
a relief valve, a fill quick-disconnect and the regulator feed -- because it is
the case that motivated the dead-end peeling in Phase 04 and the port taxonomy
here.
"""

from __future__ import annotations

import math

import pytest

from feedtwin.comps import FlowConditions, build_component
from feedtwin.comps.manifold import (
    DEFAULT_TURN_K,
    Manifold,
    ManifoldBranch,
    ManifoldPort,
    PortKind,
    expand_manifold,
    turn_K_from_geometry,
)
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.model.spec import SpecError
from feedtwin.solve.network import Network

GAS = FlowConditions(rho=39.0, mu=1.78e-5, p_upstream=4500 * 6894.757293168361)


def body(**overrides: object) -> ComponentInstance:
    params = {
        "bore": Param(12.7, "mm", Provenance.MEASURED, "1/2 in. plenum bore"),
        "volume": Param(30.0, "mL", Provenance.ESTIMATED, "from the model"),
    }
    params.update(overrides)  # type: ignore[arg-type]
    return ComponentInstance.build("MF-01", "manifold", params)


def copv_manifold() -> Manifold:
    """One inlet, four takeoffs. The real hardware."""
    ports = [
        ManifoldPort("inlet", bore=0.0127, turn_K=0.0),
        ManifoldPort("reg", bore=0.00775, fitting_K=0.5),
        ManifoldPort("pt", bore=0.0033, kind=PortKind.INSTRUMENT),
        ManifoldPort("relief", bore=0.00775, kind=PortKind.CONDITIONAL),
        ManifoldPort("fill_qd", bore=0.00775, kind=PortKind.CONDITIONAL),
    ]
    built = build_component(body())
    assert isinstance(built, Manifold)
    return Manifold(built.instance, ports)


# ------------------------------------------------------------------ port kinds


def test_only_flow_ports_carry_mass() -> None:
    manifold = copv_manifold()
    assert {p.id for p in manifold.flow_ports} == {"inlet", "reg"}
    assert {p.id for p in manifold.dead_ports} == {"pt", "relief", "fill_qd"}


def test_an_instrument_port_reads_plenum_pressure_exactly() -> None:
    """A transducer tap has no flow, so it has no drop. Ever."""
    manifold = copv_manifold()
    port = next(p for p in manifold.ports if p.id == "pt")
    branch = ManifoldBranch(manifold.instance, port)
    assert branch.pressure_drop(0.0, GAS) == 0.0
    # Even asked for a flow it cannot have, it reports no loss -- the mass
    # balance is what forbids the flow, not a fictitious resistance.
    assert branch.pressure_drop(0.05, GAS) == 0.0


def test_a_conditional_port_is_a_stub_while_shut() -> None:
    """A shut relief and a capped port are topologically identical.

    Physically they are nothing alike, which is why the kind is declared. This
    test pins the declaration, not the behaviour -- the behaviour is the same.
    """
    manifold = copv_manifold()
    relief = next(p for p in manifold.ports if p.id == "relief")
    assert relief.kind is PortKind.CONDITIONAL
    assert not relief.kind.carries_flow
    assert ManifoldBranch(manifold.instance, relief).pressure_drop(0.05, GAS) == 0.0


# --------------------------------------------------------------------- physics


def test_port_loss_is_turn_plus_fitting() -> None:
    manifold = copv_manifold()
    port = next(p for p in manifold.ports if p.id == "reg")
    assert port.total_K == pytest.approx(DEFAULT_TURN_K + 0.5)

    branch = ManifoldBranch(manifold.instance, port)
    mdot = 0.05
    v = mdot / (GAS.rho * math.pi * port.bore**2 / 4.0)
    assert branch.pressure_drop(mdot, GAS) == pytest.approx(
        port.total_K * 0.5 * GAS.rho * v * v, rel=1e-12
    )


def test_a_straight_through_port_does_not_turn() -> None:
    """An in-line outlet is not a side tapping and should not be charged as one."""
    manifold = copv_manifold()
    inlet = next(p for p in manifold.ports if p.id == "inlet")
    assert inlet.turn_K == 0.0
    reg = next(p for p in manifold.ports if p.id == "reg")
    assert reg.turn_K > 0.0


def test_loss_is_symmetric_in_flow_direction() -> None:
    """A manifold port does not care which way the gas goes through it."""
    manifold = copv_manifold()
    branch = ManifoldBranch(
        manifold.instance, next(p for p in manifold.ports if p.id == "reg")
    )
    assert branch.pressure_drop(0.05, GAS) == pytest.approx(
        branch.pressure_drop(-0.05, GAS)
    )
    # total_dp signs it, which is the part that must reverse.
    assert branch.total_dp(0.05, GAS) == pytest.approx(-branch.total_dp(-0.05, GAS))


def test_smaller_ports_cost_more() -> None:
    """Quartic in bore: halving a port is 16x the loss at the same mass flow."""
    instance = body()
    big = ManifoldBranch(instance, ManifoldPort("a", bore=0.0127, turn_K=1.0))
    small = ManifoldBranch(instance, ManifoldPort("b", bore=0.00635, turn_K=1.0))
    assert small.pressure_drop(0.05, GAS) == pytest.approx(
        16.0 * big.pressure_drop(0.05, GAS), rel=1e-9
    )


def test_derived_turn_K_grows_as_the_port_narrows() -> None:
    """Rung 6 of the K ladder: derived from the area ratio when nothing better."""
    wide = turn_K_from_geometry(port_bore=0.0127, plenum_bore=0.0127)
    narrow = turn_K_from_geometry(port_bore=0.0033, plenum_bore=0.0127)
    assert narrow > turn_K_from_geometry(port_bore=0.00775, plenum_bore=0.0127) > wide


# ----------------------------------------------------------------- the assembly


def test_a_manifold_refuses_to_be_one_branch() -> None:
    """The failure that stops port losses from silently vanishing."""
    manifold = copv_manifold()
    with pytest.raises(SpecError, match="not a single branch"):
        manifold.pressure_drop(0.05, GAS)


def test_expansion_produces_one_branch_per_port() -> None:
    manifold = copv_manifold()
    net = Network()
    net.add_node("PLENUM", "nitrogen", 293.15)
    net.add_node("COPV", "nitrogen", 293.15, pressure=4500 * 6894.757293168361)
    nodes = {}
    for port in manifold.ports:
        node_id = f"N_{port.id}"
        net.add_node(node_id, "nitrogen", 293.15)
        nodes[port.id] = node_id

    ids = expand_manifold(net, manifold, "PLENUM", nodes)
    assert len(ids) == len(manifold.ports)
    assert set(ids) <= set(net.branches)
    assert all(b.upstream == "PLENUM" for b in net.branches.values())


def test_expansion_requires_a_node_for_every_port() -> None:
    """Including the instrument ones -- that is how a tap reads plenum pressure."""
    manifold = copv_manifold()
    net = Network()
    net.add_node("PLENUM", "nitrogen", 293.15)
    net.add_node("N_reg", "nitrogen", 293.15)
    with pytest.raises(SpecError, match="no node given for port"):
        expand_manifold(net, manifold, "PLENUM", {"reg": "N_reg"})


def test_expansion_rejects_an_unknown_port() -> None:
    manifold = copv_manifold()
    net = Network()
    net.add_node("PLENUM", "nitrogen", 293.15)
    nodes = {p.id: f"N_{p.id}" for p in manifold.ports}
    nodes["ghost"] = "N_ghost"
    for node in nodes.values():
        net.add_node(node, "nitrogen", 293.15)
    with pytest.raises(SpecError, match="unknown port"):
        expand_manifold(net, manifold, "PLENUM", nodes)


def test_duplicate_ports_are_rejected() -> None:
    with pytest.raises(SpecError, match="duplicate port"):
        Manifold(
            build_component(body()).instance,
            [ManifoldPort("pt", bore=0.003), ManifoldPort("pt", bore=0.003)],
        )


# ------------------------------------------------------------------- the checks


def test_a_port_wider_than_its_plenum_is_flagged() -> None:
    manifold = Manifold(
        build_component(body()).instance,
        [ManifoldPort("a", bore=0.0254), ManifoldPort("b", bore=0.00775)],
    )
    limits = [v.limit for v in manifold.check()]
    assert "port_bore" in limits


def test_a_one_outlet_manifold_is_flagged_as_a_fitting() -> None:
    manifold = Manifold(
        build_component(body()).instance,
        [
            ManifoldPort("inlet", bore=0.0127),
            ManifoldPort("pt", bore=0.003, kind=PortKind.INSTRUMENT),
        ],
    )
    warnings = [v for v in manifold.check() if v.limit == "ports"]
    assert warnings and warnings[0].severity == "warning"


def test_a_healthy_manifold_is_clean() -> None:
    assert copv_manifold().check() == []
