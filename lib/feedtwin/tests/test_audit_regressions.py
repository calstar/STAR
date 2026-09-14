"""Regressions from the Stage A audit.

Four defects found by probing Phases 00-04 after they were each "done". Three
of them had passing tests either side of the seam they broke, which is the
pattern worth noting: every one lived in the *join* between two phases, where
each side was tested alone and the pair was not.

* A static head that reversed sign with the flow (Phase 03 physics, exposed
  only through Phase 04 assembly).
* Substance constants asked of one backend instead of the chain, so putting
  measured data first -- the point of the feature -- broke every component
  evaluation (Phase 01 x Phase 03).
* A catalog that could not hold a curve, making the ``measured`` model
  unreachable from the parts database (Phase 02 x Phase 03).
* A canonical unit resolved by dictionary order rather than declaration.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import numpy as np
import pytest

from feedtwin.comps import FlowConditions, build_component, conditions_from_fluid
from feedtwin.model import Catalog, ComponentInstance, Param, Provenance
from feedtwin.model.component import EvalContext, PortState
from feedtwin.model.units import UnknownUnit, register_unit, si_unit_of, to_si
from feedtwin.props import Fluid, TabulatedProperties, UnknownFluid
from feedtwin.solve import Network, solve_steady

M = Provenance.MANUFACTURER
WATER = FlowConditions(rho=1000.0, mu=1.0e-3, p_upstream=10.0e5)


def _climbing_pipe(rise: float = 10.0) -> object:
    return build_component(
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {
                "length": Param(1.0, "m", M, "test"),
                "bore": Param(10.0, "mm", M, "test"),
                "elevation_change": Param(rise, "m", M, "climbs"),
            },
        )
    )


# ----------------------------------------------------- static head vs. loss


def test_static_head_does_not_reverse_with_the_flow() -> None:
    """The bug: elevation was signed along with friction.

    ``rho g dz`` is set by where the ends of the pipe are. Friction opposes the
    flow and reverses with it; elevation does not. Conflating them put a
    reversing branch out by exactly ``2 rho g dz`` -- while still converging and
    still conserving mass, which is why nothing noticed.
    """
    line = _climbing_pipe()
    head = 1000.0 * 9.80665 * 10.0

    assert line.static_head(WATER) == pytest.approx(head)  # type: ignore[attr-defined]

    friction = line.pressure_drop(1.0, WATER)  # type: ignore[attr-defined]
    assert line.pressure_drop(-1.0, WATER) == pytest.approx(friction), (  # type: ignore[attr-defined]
        "the loss itself is symmetric -- only its sign in the balance changes"
    )

    assert line.total_dp(1.0, WATER) == pytest.approx(friction + head)  # type: ignore[attr-defined]
    assert line.total_dp(-1.0, WATER) == pytest.approx(-friction + head)  # type: ignore[attr-defined]


def test_the_residual_is_zero_at_the_correct_reverse_state() -> None:
    """Stated as the solver sees it, which is where the bug actually bit."""
    line = _climbing_pipe()
    line.conditions_provider = lambda port, signals: WATER  # type: ignore[attr-defined]

    friction = line.pressure_drop(1.0, WATER)  # type: ignore[attr-defined]
    head = line.static_head(WATER)  # type: ignore[attr-defined]

    p_in = 10.0e5
    truth = -friction + head  # p_up - p_dn, flowing backwards up a climb
    ctx = EvalContext(
        ports=(PortState(p=p_in, h=0.0), PortState(p=p_in - truth, h=0.0)),
        flows=(-1.0,),
    )
    assert line.residuals(ctx)[0] == pytest.approx(0.0, abs=1e-6)  # type: ignore[attr-defined]


def test_a_network_with_elevation_and_reverse_flow_is_consistent() -> None:
    """End to end: a branch running backwards up a climb still balances."""
    net = Network()
    net.add_node("low", "LOX", 90.0, pressure=20.0e5)
    net.add_node("high", "LOX", 90.0, pressure=30.0e5)
    net.add_branch("FL-01", _climbing_pipe(5.0), "low", "high")  # type: ignore[arg-type]

    result = solve_steady(net)
    assert result.converged
    assert result.flows["FL-01"] < 0.0, "flow runs high to low"

    branch = net.branches["FL-01"]
    conditions = net.conditions("low", result.pressures["low"])
    assert result.dp("FL-01", net) == pytest.approx(
        branch.component.total_dp(result.flows["FL-01"], conditions), rel=1e-6
    )


def test_components_without_elevation_report_no_static_head() -> None:
    """The default is zero, so nothing else acquired a spurious head."""
    for type_name, params in [
        ("valve", {"Cv": Param(1.0, "Cv", M, ""), "bore": Param(10.0, "mm", M, "")}),
        (
            "orifice",
            {
                "bore": Param(2.0, "mm", M, ""),
                "pipe_bore": Param(8.0, "mm", M, ""),
            },
        ),
        (
            "flex_hose",
            {"bore": Param(9.5, "mm", M, ""), "length": Param(0.5, "m", M, "")},
        ),
    ]:
        component = build_component(ComponentInstance.build("X", type_name, params))
        assert component.static_head(WATER) == 0.0, type_name


# --------------------------------------------- constants along the chain


def _measured_lox() -> Fluid:
    p = np.array([1.0e6, 2.0e6, 3.0e6])
    T = np.array([85.0, 90.0, 95.0])
    rho = np.array([[Fluid("LOX").get("rho", p=pi, T=Ti) for Ti in T] for pi in p])
    table = TabulatedProperties(p, T, {"rho": rho}, source="CF-2026-03")
    return Fluid("LOX", chain=[table, "bicubic", "heos"])


def test_substance_constants_are_sought_along_the_whole_chain() -> None:
    """The bug: only the head of the chain was asked.

    A measured table has no critical point to report, so putting one in front --
    which is the entire point of the feature -- made ``critical_pressure`` raise,
    which made ``conditions_from_fluid`` raise, which broke every component
    evaluation downstream of it.
    """
    lox = _measured_lox()
    assert lox.chain[0] == "measured"
    assert lox.critical_pressure == pytest.approx(5.043e6, rel=1e-2)
    assert lox.critical_temperature == pytest.approx(154.6, rel=1e-2)


def test_a_measured_fluid_still_drives_components() -> None:
    """The downstream consequence, checked where it actually mattered."""
    conditions = conditions_from_fluid(_measured_lox(), p=2.0e6, T=90.0)
    assert conditions.rho > 0.0
    assert conditions.p_crit == pytest.approx(5.043e6, rel=1e-2)


def test_a_chain_that_truly_cannot_report_constants_says_so() -> None:
    """With guidance, not a bare failure."""
    p = np.array([1.0e6, 2.0e6])
    T = np.array([85.0, 90.0])
    table = TabulatedProperties(p, T, {"rho": np.ones((2, 2))}, source="unit-test")
    with pytest.raises(Exception, match="equation-of-state backend"):
        Fluid("LOX", chain=[table]).critical_pressure


# --------------------------------------------------- catalogued curves


CATALOG = textwrap.dedent("""
    ["hose-8an-600"]
    type = "flex_hose"
    manufacturer = "Aeroquip"

    ["hose-8an-600".params.bore]
    value = 9.5
    unit = "mm"
    source = "manufacturer"
    reference = "datasheet"

    ["hose-8an-600".params.length]
    value = 0.6
    unit = "m"
    source = "manufacturer"
    reference = "cut length"

    ["hose-8an-600".curves.dp_mdot]
    x = [0.0, 0.5, 1.0]
    y = [0.0, 1.2, 4.6]
    x_unit = "kg/s"
    y_unit = "bar"
    source = "measured"
    reference = "CF-2026-03, 9 points"
    """)


def test_a_part_can_carry_measured_flow_data(tmp_path: Path) -> None:
    """The bug: the catalog held scalars only.

    So a part with measured flow data could not be catalogued, the ``measured``
    model was reachable from code but not from the parts database, and Phase 12
    had nowhere to write a fitted curve back to.
    """
    path = tmp_path / "parts.toml"
    path.write_text(CATALOG)
    catalog = Catalog.from_file(path)

    hose = catalog.instantiate("FH-01", "hose-8an-600", model="measured")
    assert hose.curves["dp_mdot"].source is Provenance.MEASURED
    assert "CF-2026-03" in hose.curves["dp_mdot"].reference

    component = build_component(hose)
    assert component.pressure_drop(0.5, WATER) == pytest.approx(1.2e5)


def test_catalogued_curves_survive_a_round_trip(tmp_path: Path) -> None:
    from feedtwin.model.catalog import Part

    path = tmp_path / "parts.toml"
    path.write_text(CATALOG)
    catalog = Catalog.from_file(path)

    data = catalog.to_dict()
    rebuilt = Catalog(Part.from_dict(pid, body) for pid, body in data.items())
    assert rebuilt.to_dict() == data
    assert "dp_mdot" in rebuilt.get("hose-8an-600").curves


def test_a_passed_curve_overrides_the_catalogued_one(tmp_path: Path) -> None:
    """A retest of this particular hose beats the part's stored curve."""
    from feedtwin.model.curve import Curve

    path = tmp_path / "parts.toml"
    path.write_text(CATALOG)
    catalog = Catalog.from_file(path)

    retest = Curve(
        x=(0.0, 0.5, 1.0),
        y=(0.0, 2.0, 8.0),
        x_unit="kg/s",
        y_unit="bar",
        source=Provenance.MEASURED,
        reference="CF-2026-11, after service",
    )
    hose = catalog.instantiate(
        "FH-01", "hose-8an-600", curves={"dp_mdot": retest}, model="measured"
    )
    assert build_component(hose).pressure_drop(0.5, WATER) == pytest.approx(2.0e5)


# ------------------------------------------------------------ unit lookup


def test_the_canonical_unit_is_declared_not_inferred() -> None:
    """K and degC differences are the same size, so factor 1.0 cannot decide.

    Before, the answer came from dictionary insertion order -- stable in
    practice, invisible in the source, and not something a reader could check.
    """
    assert si_unit_of("temperature_difference") == "K_diff"
    assert to_si(20.0, "degC_diff") == pytest.approx(20.0)
    assert to_si(20.0, "K_diff") == pytest.approx(20.0)


def test_a_new_dimension_needs_its_canonical_unit_declared() -> None:
    register_unit("widget", "widgetry", 1.0, canonical=True)
    assert si_unit_of("widgetry") == "widget"


def test_a_mistyped_unit_suggests_the_right_one() -> None:
    """Fifty units listed is what you read when you do not know what exists.
    A typo is the commoner case and deserves a pointer."""
    with pytest.raises(UnknownUnit, match="Did you mean"):
        to_si(1.0, "inches")


def test_a_mistyped_fluid_suggests_the_right_one() -> None:
    with pytest.raises(UnknownFluid, match="'nitrogen'"):
        Fluid("nitrogn")


# ------------------------------------------------- dead-ended manifold ports


def _stub_network() -> Network:
    """A COPV feeding a manifold: PT-less plenum with a shut relief and a
    capped fill quick-disconnect hanging off it, and a regulator downstream.

    The shape of most real feed systems, and the one the Phase 04 validator
    used to refuse outright.
    """
    from feedtwin.model import Param as P

    def pipe(cid: str, length: float, bore: float = 7.75) -> object:
        return build_component(
            ComponentInstance.build(
                cid,
                "pipe",
                {"length": P(length, "m", M, ""), "bore": P(bore, "mm", M, "")},
            )
        )

    net = Network()
    net.add_node("copv", "nitrogen", 293.0, pressure=310.0e5)
    net.add_node("MAN-01", "nitrogen", 293.0)
    net.add_node("reg_in", "nitrogen", 293.0, pressure=250.0e5)
    net.add_node("relief", "nitrogen", 293.0)
    net.add_node("qd", "nitrogen", 293.0)

    net.add_branch("p_in", pipe("p_in", 0.30), "copv", "MAN-01")  # type: ignore[arg-type]
    net.add_branch("p_reg", pipe("p_reg", 0.20), "MAN-01", "reg_in")  # type: ignore[arg-type]
    net.add_branch("p_rv", pipe("p_rv", 0.05, 6.0), "MAN-01", "relief")  # type: ignore[arg-type]
    net.add_branch("p_qd", pipe("p_qd", 0.05, 6.0), "MAN-01", "qd")  # type: ignore[arg-type]
    return net


def test_dead_ended_ports_no_longer_refuse_to_solve() -> None:
    """The bug: a transducer port, a capped QD and a shut relief are dead ends,
    and the validator treated every one as a malformed network.

    They are correct hardware. Most ports on a real manifold carry no flow.
    """
    result = solve_steady(_stub_network())
    assert result.converged
    assert result.max_mass_residual < 1e-9


def test_a_stub_sits_at_its_plenum_pressure() -> None:
    """Zero flow means no friction, so a level stub reads the plenum exactly."""
    net = _stub_network()
    result = solve_steady(net)

    plenum = result.pressures["MAN-01"]
    assert result.pressures["qd"] == pytest.approx(plenum)
    assert result.pressures["relief"] == pytest.approx(plenum)
    assert result.flows["p_qd"] == 0.0
    assert result.flows["p_rv"] == 0.0


def test_stubs_are_pruned_rather_than_iterated() -> None:
    """They would otherwise sit on the derivative floor and be reported as
    anomalies on every run of a perfectly ordinary system."""
    net = _stub_network()
    assert {d.branch for d in net.dead_ends()} == {"p_qd", "p_rv"}

    result = solve_steady(net)
    assert set(result.dead_ends) == {"p_qd", "p_rv"}
    assert result.regularised_branches == [], "the floor should never be reached"


def test_stubs_are_peeled_transitively() -> None:
    """A capped run two branches deep is still a stub.

    Removing the outer branch is what makes the inner one a stub in turn, so
    the peel has to iterate rather than scan once.
    """
    from feedtwin.model import Param as P

    def pipe(cid: str) -> object:
        return build_component(
            ComponentInstance.build(
                cid,
                "pipe",
                {"length": P(0.2, "m", M, ""), "bore": P(6.0, "mm", M, "")},
            )
        )

    net = _stub_network()
    net.add_node("qd_cap", "nitrogen", 293.0)
    net.add_branch("p_cap", pipe("p_cap"), "qd", "qd_cap")  # type: ignore[arg-type]

    assert {d.branch for d in net.dead_ends()} == {"p_qd", "p_rv", "p_cap"}
    result = solve_steady(net)
    assert result.converged
    assert result.pressures["qd_cap"] == pytest.approx(result.pressures["MAN-01"])


def test_an_indeterminate_stub_is_flagged() -> None:
    """A check valve behind its cracking pressure has no defined stub pressure.

    Nothing is flowing, so nothing holds that drop; the honest report is the
    live end's pressure as an upper bound, plus a note that it is one.
    """
    from feedtwin.model import Param as P

    net = _stub_network()
    net.add_node("cv_out", "nitrogen", 293.0)
    check = build_component(
        ComponentInstance.build(
            "CV-01",
            "check_valve",
            {
                "Cv": P(1.0, "Cv", M, ""),
                "bore": P(6.0, "mm", M, ""),
                "cracking_pressure": P(5.0, "psi", M, "datasheet"),
            },
        )
    )
    net.add_branch("CV-01", check, "MAN-01", "cv_out")

    result = solve_steady(net)
    assert result.converged
    assert "CV-01" in result.indeterminate_dead_ends
