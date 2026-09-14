"""The steady network solve: does it get the right answer, and know when it hasn't?

Phase 04's exit criteria live here. The one that matters most is not accuracy
but *honesty about* accuracy: a Newton solve will happily converge on a system
that does not conserve mass, and that failure looks exactly like success. Mass
residuals are therefore checked on every solve, not sampled.

The physics is not re-validated here -- Phase 03 did that against closed forms
and definitions. What is checked is that the solver reproduces those component
answers when it assembles them into a network, which is a different claim and
the one that can break.
"""

from __future__ import annotations

import math

import pytest

from feedtwin.comps import build_component
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.solve import (
    ConvergenceError,
    Network,
    NetworkError,
    pressure_ladder,
    solve_steady,
)

M = Provenance.MANUFACTURER


def _pipe(cid: str, length: float, bore_mm: float = 7.75, **extra: Param) -> object:
    params: dict[str, Param] = {
        "length": Param(length, "m", M, "drawing"),
        "bore": Param(bore_mm, "mm", M, "3/8 x 0.035 tube"),
    }
    params.update(extra)
    return build_component(ComponentInstance.build(cid, "pipe", params))


def _valve(cid: str, cv: float) -> object:
    return build_component(
        ComponentInstance.build(
            cid,
            "valve",
            {"Cv": Param(cv, "Cv", M, "datasheet"), "bore": Param(0.375, "in", M, "")},
        )
    )


def _series_network() -> Network:
    """Tank to injector through two lines and a valve."""
    net = Network()
    net.add_node("tank", "LOX", 90.0, pressure=30.0e5)
    net.add_node("n1", "LOX", 90.0)
    net.add_node("n2", "LOX", 90.0)
    net.add_node("inj", "LOX", 90.0, pressure=20.0e5)
    net.add_branch("FL-01", _pipe("FL-01", 1.5), "tank", "n1")  # type: ignore[arg-type]
    net.add_branch("SOL-01", _valve("SOL-01", 4.0), "n1", "n2")  # type: ignore[arg-type]
    net.add_branch("FL-02", _pipe("FL-02", 0.8), "n2", "inj")  # type: ignore[arg-type]
    return net


# ------------------------------------------------------------------ the answer


def test_a_series_network_solves_and_conserves_mass() -> None:
    net = _series_network()
    result = solve_steady(net)

    assert result.converged
    assert result.max_mass_residual < 1e-9, "mass must balance at every node"

    # One path, so every branch carries the same flow. Not a tautology: the
    # solver has three independent flow unknowns and only mass balance ties
    # them together.
    flows = list(result.flows.values())
    assert all(f == pytest.approx(flows[0], rel=1e-9) for f in flows)
    assert flows[0] > 0.0


def test_the_pressure_drops_sum_to_what_was_available() -> None:
    """The whole point of a pressure ladder: nothing goes missing.

    Tank minus injector is fixed by the boundary conditions, so the components
    between them must account for exactly that much and no more.
    """
    net = _series_network()
    result = solve_steady(net)

    available = result.pressures["tank"] - result.pressures["inj"]
    accounted = sum(result.dp(bid, net) for bid in net.branches)
    assert accounted == pytest.approx(available, rel=1e-9)


def test_each_branch_drop_matches_its_component(monkeypatch: object) -> None:
    """The network's answer agrees with the component evaluated alone.

    This is the bridge between Phase 03's validation and Phase 04's assembly:
    the solve is only as good as the components, and this checks the solver is
    not quietly transforming them on the way through.
    """
    net = _series_network()
    result = solve_steady(net)

    for branch_id, branch in net.branches.items():
        conditions = net.conditions(branch.upstream, result.pressures[branch.upstream])
        standalone = branch.component.pressure_drop(result.flows[branch_id], conditions)
        assert result.dp(branch_id, net) == pytest.approx(standalone, rel=1e-6)


def test_a_parallel_split_divides_flow_by_resistance() -> None:
    """Two paths between the same nodes: the easier one takes more.

    Mass balance at the split is what makes this non-trivial -- the solver has
    to find the division rather than being told it.
    """
    net = Network()
    net.add_node("up", "LOX", 90.0, pressure=30.0e5)
    net.add_node("dn", "LOX", 90.0, pressure=28.0e5)
    net.add_branch("BIG", _pipe("BIG", 1.0, bore_mm=12.0), "up", "dn")  # type: ignore[arg-type]
    net.add_branch("SMALL", _pipe("SMALL", 1.0, bore_mm=6.0), "up", "dn")  # type: ignore[arg-type]

    result = solve_steady(net)
    assert result.converged
    assert result.flows["BIG"] > result.flows["SMALL"], "the wider line flows more"

    # Both see the same pressure difference -- they share both end nodes.
    assert result.dp("BIG", net) == pytest.approx(result.dp("SMALL", net))


def test_a_demand_is_met_from_the_branches_feeding_it() -> None:
    """How an engine's appetite enters a feed-system solve."""
    net = Network()
    net.add_node("tank", "LOX", 90.0, pressure=30.0e5)
    net.add_node("face", "LOX", 90.0, demand=0.8)
    net.add_branch("FL-01", _pipe("FL-01", 2.0), "tank", "face")  # type: ignore[arg-type]

    result = solve_steady(net)
    assert result.converged
    assert result.flows["FL-01"] == pytest.approx(0.8, rel=1e-9)
    assert result.pressures["face"] < result.pressures["tank"]


def test_flow_reverses_when_the_pressure_gradient_does() -> None:
    """Upstream and downstream are labels, not constraints."""
    net = Network()
    net.add_node("a", "LOX", 90.0, pressure=20.0e5)
    net.add_node("b", "LOX", 90.0, pressure=30.0e5)
    net.add_branch("FL-01", _pipe("FL-01", 1.0), "a", "b")  # type: ignore[arg-type]

    result = solve_steady(net)
    assert result.converged
    assert result.flows["FL-01"] < 0.0, "flow runs b to a, reported as negative"


# ------------------------------------------------------------- exit criteria


def test_it_reproduces_engine_designs_lumped_k_feed_loss() -> None:
    """Phase 04's parity criterion, against the code this replaces.

    EngineDesign's ``feed_loss.delta_p_feed`` is ``K_eff . rho v^2 / 2`` over a
    single lumped coefficient. A zero-length pipe carrying only ``K_minor`` is
    exactly that, so the two must agree to machine precision -- and when the
    steady solver lands in EngineDesign, this is the test that says the
    replacement is faithful.
    """
    K_eff, bore, mdot = 2.0, 0.009525, 1.2
    rho = 1141.0

    area = math.pi * bore * bore / 4.0
    velocity = mdot / (rho * area)
    expected = K_eff * (rho / 2.0) * velocity**2

    line = build_component(
        ComponentInstance.build(
            "FEED",
            "pipe",
            {
                "length": Param(0.0, "m", M, "lumped model has no length"),
                "bore": Param(bore, "m", M, "3/8 NPT bore"),
                "K_minor": Param(K_eff, "-", M, "EngineDesign feed_system.K0"),
            },
        )
    )
    from feedtwin.comps import FlowConditions

    conditions = FlowConditions(rho=rho, mu=2.0e-4, p_upstream=30.0e5)
    assert line.pressure_drop(mdot, conditions) == pytest.approx(expected, rel=1e-12)


def _ladder_network(stages: int) -> Network:
    """A dual-branch ladder: two parallel runs cross-linked at every stage."""
    net = Network()
    net.add_node("src", "LOX", 90.0, pressure=40.0e5)
    net.add_node("sink", "LOX", 90.0, pressure=20.0e5)

    for side in ("a", "b"):
        previous = "src"
        for i in range(stages):
            node = f"{side}{i}"
            net.add_node(node, "LOX", 90.0)
            net.add_branch(
                f"{side}L{i}", _pipe(f"{side}L{i}", 0.4), previous, node  # type: ignore[arg-type]
            )
            previous = node
        net.add_branch(f"{side}L{stages}", _pipe(f"{side}L{stages}", 0.4), previous, "sink")  # type: ignore[arg-type]

    for i in range(0, stages, 2):
        net.add_branch(f"X{i}", _pipe(f"X{i}", 0.2, bore_mm=5.0), f"a{i}", f"b{i}")  # type: ignore[arg-type]
    return net


def test_a_forty_node_dual_branch_network_solves_quickly() -> None:
    """Phase 04's performance criterion.

    Forty-odd nodes, two parallel runs with cross-links, in well under 100 ms.
    The budget matters because Phase 07 marches this solve thousands of times
    and Phase 15's optimizer will call it far more than that.
    """
    net = _ladder_network(stages=19)
    assert len(net.nodes) >= 40, f"only {len(net.nodes)} nodes"

    solve_steady(net)  # warm any table build out of the measurement
    result = solve_steady(_ladder_network(stages=19))

    assert result.converged
    assert result.max_mass_residual < 1e-9
    assert result.elapsed < 0.100, f"took {result.elapsed * 1e3:.1f} ms"


def test_mass_residuals_are_reported_on_every_run() -> None:
    """Not sampled, not optional. A converged solve that does not conserve
    mass has found the wrong answer confidently, and that is the failure that
    looks like success."""
    result = solve_steady(_series_network())
    assert set(result.mass_residuals) == set(_series_network().free_nodes)
    assert result.max_mass_residual >= 0.0


def test_the_report_shows_where_the_pressure_went() -> None:
    net = _series_network()
    text = pressure_ladder(net, solve_steady(net))

    assert "converged" in text
    for branch_id in net.branches:
        assert branch_id in text
    assert "mass conservation" in text
    assert "library defaults" in text, "assumed parameters must be visible"


def test_the_result_records_the_stack_that_produced_it() -> None:
    """Correlations and equations of state are not frozen between releases."""
    stack = solve_steady(_series_network()).stack
    assert stack["feedtwin"]
    assert stack["CoolProp"] and stack["fluids"]


# ------------------------------------------------------------ failure modes


def test_a_network_with_no_fixed_pressure_is_refused() -> None:
    """No reference pressure means every pressure is arbitrary."""
    net = Network()
    net.add_node("a", "LOX", 90.0)
    net.add_node("b", "LOX", 90.0)
    net.add_branch("FL-01", _pipe("FL-01", 1.0), "a", "b")  # type: ignore[arg-type]

    with pytest.raises(NetworkError, match="no reference"):
        solve_steady(net)


def test_a_network_that_is_only_a_stub_still_has_an_answer() -> None:
    """A tank feeding one capped line and nothing else.

    Everything prunes to stubs, so there is nothing to iterate on -- but that is
    not the same as there being no answer. Nothing flows, and the capped line
    sits at the tank's pressure. This used to raise, and that was wrong for the
    case that matters most: a stand with its whole panel shut prunes to exactly
    this shape, and it is where a stand spends most of its life. Refusing to
    describe it made the most ordinary state on the pad an error.
    """
    net = Network()
    net.add_node("tank", "LOX", 90.0, pressure=30.0e5)
    net.add_node("stub", "LOX", 90.0)
    net.add_branch("FL-01", _pipe("FL-01", 1.0), "tank", "stub")  # type: ignore[arg-type]

    result = solve_steady(net)
    assert result.converged
    assert result.flows["FL-01"] == 0.0
    # Zero flow, so the only difference across the line is its static head.
    assert result.pressures["stub"] == pytest.approx(30.0e5, rel=1e-3)


def test_a_network_with_no_branches_at_all_is_still_refused() -> None:
    """The genuinely empty case stays an error -- there is no system here."""
    net = Network()
    net.add_node("tank", "LOX", 90.0, pressure=30.0e5)

    with pytest.raises(NetworkError):
        solve_steady(net)


def test_structural_problems_are_reported_together() -> None:
    net = Network()
    net.add_node("lonely", "LOX", 90.0)
    net.add_node("a", "LOX", 90.0)
    net.add_node("b", "LOX", 90.0)
    net.add_branch("FL-01", _pipe("FL-01", 1.0), "a", "b")  # type: ignore[arg-type]

    with pytest.raises(NetworkError) as excinfo:
        net.validate()
    message = str(excinfo.value)
    assert "lonely" in message and "no reference" in message


def test_a_branch_to_a_missing_node_is_refused_at_construction() -> None:
    net = Network()
    net.add_node("a", "LOX", 90.0, pressure=1e6)
    with pytest.raises(NetworkError, match="unknown node"):
        net.add_branch("FL-01", _pipe("FL-01", 1.0), "a", "nowhere")  # type: ignore[arg-type]


def test_a_failed_solve_can_be_inspected_instead_of_raised() -> None:
    """What a parameter sweep wants: keep going, record the failure."""
    net = _series_network()
    result = solve_steady(net, max_iterations=1, raise_on_failure=False)
    assert not result.converged
    assert result.iterations == 1

    with pytest.raises(ConvergenceError) as excinfo:
        solve_steady(net, max_iterations=1)
    assert excinfo.value.result.iterations == 1


def test_design_violations_survive_into_the_result() -> None:
    """A bend inside its limit does not stop the solve, and is still reported."""
    net = Network()
    net.add_node("tank", "LOX", 90.0, pressure=30.0e5)
    net.add_node("inj", "LOX", 90.0, pressure=25.0e5)
    bend = build_component(
        ComponentInstance.build(
            "BD-01",
            "bend",
            {
                "bore": Param(7.75, "mm", M, ""),
                "bend_radius": Param(10.0, "mm", M, "as built"),
                "min_bend_radius": Param(28.6, "mm", M, "3x OD"),
            },
        )
    )
    net.add_branch("BD-01", bend, "tank", "inj")

    result = solve_steady(net)
    assert result.converged
    assert [v.limit for v in result.violations] == ["min_bend_radius"]
    assert "min_bend_radius" in pressure_ladder(net, result)


def test_a_shut_valve_is_reported_as_regularised_not_hidden() -> None:
    """The derivative floor is a named regularisation, and it says when it acted.

    A quadratic loss has zero slope at zero flow, so a shut branch would make
    the Jacobian singular. The floor keeps the solve possible; reporting it
    keeps it from ever being silently load-bearing.
    """
    net = Network()
    net.add_node("tank", "LOX", 90.0, pressure=30.0e5)
    net.add_node("mid", "LOX", 90.0)
    net.add_node("inj", "LOX", 90.0, pressure=29.9e5)
    net.add_branch("FL-01", _pipe("FL-01", 0.5), "tank", "mid")  # type: ignore[arg-type]
    net.add_branch("FL-02", _pipe("FL-02", 0.5), "mid", "inj")  # type: ignore[arg-type]

    result = solve_steady(net)
    assert result.converged
    # Nothing is shut here, so nothing should be sitting on the floor.
    assert result.regularised_branches == []
