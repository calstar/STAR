"""Do the components reproduce results that exist outside this codebase?

Phase 03's exit criterion. Every check here is against something independent --
a closed-form solution, or the definition of a unit, or a coefficient whose
value is fixed by a standard. None of them checks this package against itself.

The strongest ones are the *definitional* checks. A valve with Cv = 1 passing
one US gallon per minute of water must drop exactly one psi, because that is
what Cv means. A fitting with K = 1 must drop exactly one dynamic head, because
that is what K means. Those cannot drift without something being genuinely
wrong, and they exercise the whole path -- unit conversion, parameter
resolution, correlation adapter -- rather than one function.

Where a correlation has no closed form, the check is that ``fluids`` and this
package agree, which tests the adapter and not the physics. That distinction is
kept explicit in each docstring, because a test that looks like validation and
is really a tautology is worse than no test.
"""

from __future__ import annotations

import math

import pytest

from feedtwin.comps import (
    FlowConditions,
    build_component,
    conditions_from_fluid,
)
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid

M = Provenance.MANUFACTURER
PSI = 6894.757293168361
GPM = 3.785411784e-3 / 60.0

#: Water near 60 F, the reference condition Cv is defined at.
WATER = FlowConditions(rho=999.0, mu=1.138e-3, p_upstream=5.0 * PSI)


def _pipe(**overrides: Param) -> ComponentInstance:
    params: dict[str, Param] = {
        "length": Param(1.0, "m", M, "test"),
        "bore": Param(10.0, "mm", M, "test"),
    }
    params.update(overrides)
    return ComponentInstance.build("FL-01", "pipe", params)


# ---------------------------------------------------------------- closed form


def test_laminar_pipe_matches_hagen_poiseuille() -> None:
    """The one pipe case with an exact analytic solution.

    ``dp = 128 mu L Q / (pi D^4)``, equivalently f = 64/Re. Exact, no
    correlation involved, so any disagreement is an error in the friction
    factor, the Reynolds number, the dynamic head, or the unit conversion --
    which between them is most of the pipe model.
    """
    L, D = 1.0, 0.01
    mu, rho = 1.0e-3, 1000.0
    mdot = 0.005  # gives Re ~ 640, comfortably laminar

    line = build_component(
        _pipe(length=Param(L, "m", M, ""), bore=Param(D, "m", M, ""))
    )
    flow = FlowConditions(rho=rho, mu=mu, p_upstream=1.0e6)

    Q = mdot / rho
    expected = 128.0 * mu * L * Q / (math.pi * D**4)

    assert line.diagnostics(mdot, flow)["Re"] < 2040.0, "must be laminar"
    assert line.pressure_drop(mdot, flow) == pytest.approx(expected, rel=1e-9)


def test_elevation_is_exactly_rho_g_h() -> None:
    """Static head, with no flow, is not a correlation -- it is arithmetic.

    Reported through ``static_head`` rather than ``pressure_drop`` because it
    does not reverse with the flow; see test_audit_regressions for the bug that
    distinction fixed. Ten metres of LOX is about 1.6 bar, so omitting it in a
    tall vehicle is a real error, not a refinement.
    """
    climb = 10.0
    line = build_component(_pipe(elevation_change=Param(climb, "m", M, "drawing")))
    flow = FlowConditions(rho=1141.0, mu=2.0e-4, p_upstream=1.0e6)
    expected = 1141.0 * 9.80665 * climb

    assert line.static_head(flow) == pytest.approx(expected)
    # No flow, so the whole pressure change is the head.
    assert line.total_dp(0.0, flow) == pytest.approx(expected)
    assert line.pressure_drop(0.0, flow) == pytest.approx(0.0)


def test_a_fitting_drops_exactly_K_dynamic_heads() -> None:
    """K is defined as ``dp / (rho v^2 / 2)``. A sharp exit has K = 1 exactly.

    So the drop through it must equal one dynamic head to machine precision --
    a definitional check on the fitting adapter, the velocity calculation and
    the dynamic head together.
    """
    elbow = build_component(
        ComponentInstance.build(
            "FIT-01",
            "fitting",
            {"bore": Param(10.0, "mm", M, "test")},
            options={"kind": "exit"},
        )
    )
    mdot = 0.5
    v = mdot / (WATER.rho * math.pi * 0.01**2 / 4.0)
    expected = 1.0 * WATER.rho * v * v / 2.0

    assert elbow.pressure_drop(mdot, WATER) == pytest.approx(expected, rel=1e-12)
    assert elbow.diagnostics(mdot, WATER)["K"] == pytest.approx(1.0)


def test_a_valve_reproduces_the_definition_of_cv() -> None:
    """Cv = 1 passing 1 US gpm of water drops 1 psi. That is what Cv *means*.

    The keystone check of the valve model: it goes through the flow-coefficient
    unit, the Cv-to-K conversion and the dynamic head, and its expected value
    comes from the definition of the unit rather than from any library.

    ``dp = SG (Q/Cv)^2``, so at SG = 0.999 the answer is 0.999 psi, not 1.000.
    """
    valve = build_component(
        ComponentInstance.build(
            "SOL-01",
            "valve",
            {
                "Cv": Param(1.0, "Cv", M, "definition"),
                "bore": Param(10.0, "mm", M, "arbitrary"),
            },
        )
    )
    mdot = 1.0 * GPM * WATER.rho  # one gallon per minute, as mass flow
    dp = valve.pressure_drop(mdot, WATER)

    specific_gravity = WATER.rho / 1000.0
    assert dp / PSI == pytest.approx(specific_gravity, rel=1e-3)


@pytest.mark.parametrize("bore_mm", [5.0, 10.0, 25.0, 50.0])
def test_valve_pressure_drop_does_not_depend_on_bore(bore_mm: float) -> None:
    """Cv already accounts for the valve's geometry.

    K does depend on bore, and Cv-to-K converts between them -- so if the two
    were inconsistent, the drop would move with a diameter that Cv has already
    priced in. A silent factor-of-several error, and this is what catches it.
    """
    valve = build_component(
        ComponentInstance.build(
            "SOL-01",
            "valve",
            {
                "Cv": Param(2.5, "Cv", M, "test"),
                "bore": Param(bore_mm, "mm", M, "varied"),
            },
        )
    )
    mdot = 0.5
    Q_gpm = (mdot / WATER.rho) / GPM
    expected = (WATER.rho / 1000.0) * (Q_gpm / 2.5) ** 2  # psi, from the definition
    assert valve.pressure_drop(mdot, WATER) / PSI == pytest.approx(expected, rel=1e-3)


def test_orifice_cd_inverts_the_bernoulli_relation() -> None:
    """``m = Cd A sqrt(2 rho dp)``, solved for dp and checked forward."""
    d, Cd = 2.0e-3, 0.61
    orifice = build_component(
        ComponentInstance.build(
            "OR-01",
            "orifice",
            {
                "bore": Param(d, "m", M, "throat"),
                "pipe_bore": Param(8.0, "mm", M, "line"),
                "Cd": Param(Cd, "-", M, "sharp edged"),
            },
            model="cd",
        )
    )
    mdot = 0.4
    dp = orifice.pressure_drop(mdot, WATER)

    area = math.pi * d * d / 4.0
    recovered = Cd * area * math.sqrt(2.0 * WATER.rho * dp)
    assert recovered == pytest.approx(mdot, rel=1e-12)


def test_iso5167_orifice_round_trips_through_the_standard() -> None:
    """Agreement with ``fluids``, which implements ISO 5167 -- an adapter check.

    This asserts that the arguments are passed correctly and the sign of the
    result is right, not that Reader-Harris/Gallagher is correct. Stated plainly
    because the difference matters: a passing test here is evidence about this
    package, not about the standard.
    """
    from fluids.flow_meter import differential_pressure_meter_solver

    D, d, mdot = 0.05, 0.025, 3.0
    # A realistic upstream pressure. At the 5 psi of the WATER fixture this flow
    # simply cannot pass, which is a physical fact and is asserted separately.
    upstream = FlowConditions(rho=WATER.rho, mu=WATER.mu, p_upstream=10.0e5)
    orifice = build_component(
        ComponentInstance.build(
            "OR-01",
            "orifice",
            {
                "bore": Param(d, "m", M, "throat"),
                "pipe_bore": Param(D, "m", M, "line"),
            },
            model="iso5167",
        )
    )
    dp = orifice.pressure_drop(mdot, upstream)
    assert dp > 0.0

    recovered = differential_pressure_meter_solver(
        D=D,
        D2=d,
        rho=upstream.rho,
        mu=upstream.mu,
        P1=upstream.p_upstream,
        P2=upstream.p_upstream - dp,
        meter_type="ISO 5167 orifice",
        taps="D",
        epsilon_specified=1.0,  # incompressible, as the component assumes
    )
    assert float(recovered) == pytest.approx(mdot, rel=1e-6)


# ------------------------------------------------------------------- behaviour


def test_the_friction_correlation_is_a_configuration_choice() -> None:
    """Different correlations, same order of magnitude, different answers.

    Which explicit approximation to Colebrook a project uses is a modelling
    decision. This asserts both halves of that: the option genuinely changes the
    result, and the alternatives agree to within a couple of percent, so the
    choice is a refinement rather than a coin flip.
    """
    results = {}
    for method in ("Clamond", "Churchill_1977", "Haaland", "Serghides_1"):
        line = build_component(
            ComponentInstance.build(
                "FL-01",
                "pipe",
                {
                    "length": Param(2.0, "m", M, "test"),
                    "bore": Param(10.0, "mm", M, "test"),
                    "roughness": (
                        Param(45.0, "um" if False else "mm", M, "rough")
                        if False
                        else Param(0.045, "mm", M, "commercial steel")
                    ),
                },
                options={"friction": method},
            )
        )
        results[method] = line.pressure_drop(2.0, WATER)

    values = list(results.values())
    assert len(set(values)) > 1, "the option changed nothing"
    assert max(values) / min(values) < 1.02, results


def test_an_unknown_friction_method_is_rejected_at_load() -> None:
    from feedtwin.model import SpecError

    with pytest.raises(SpecError, match="not valid"):
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {
                "length": Param(1.0, "m", M, ""),
                "bore": Param(10.0, "mm", M, ""),
            },
            options={"friction": "vibes"},
        )


@pytest.mark.parametrize(
    "characteristic,at_half",
    [("linear", 0.5), ("equal_percentage", 0.1636), ("quick_opening", 0.9025)],
)
def test_valve_characteristics_follow_iec_shapes(
    characteristic: str, at_half: float
) -> None:
    """Half travel gives very different capacity depending on the trim."""
    valve = build_component(
        ComponentInstance.build(
            "SOL-01",
            "valve",
            {"Cv": Param(10.0, "Cv", M, ""), "bore": Param(10.0, "mm", M, "")},
            options={"characteristic": characteristic},
        )
    )
    assert valve.effective_cv(0.5) == pytest.approx(10.0 * at_half, rel=1e-3)  # type: ignore[attr-defined]
    assert valve.effective_cv(1.0) == pytest.approx(10.0)  # type: ignore[attr-defined]


def test_a_shut_valve_keeps_a_seat_leak_rather_than_zero_capacity() -> None:
    """Exactly zero capacity is a singular network, not a closed valve."""
    valve = build_component(
        ComponentInstance.build(
            "SOL-01",
            "valve",
            {"Cv": Param(1.2, "Cv", M, ""), "bore": Param(10.0, "mm", M, "")},
        )
    )
    assert valve.effective_cv(0.0) == pytest.approx(1e-6)  # type: ignore[attr-defined]
    assert valve.effective_cv(0.0) > 0.0  # type: ignore[attr-defined]


def test_a_check_valve_is_asymmetric() -> None:
    """Forward it is a valve with a cracking pressure; backward it is shut.

    The first component whose behaviour is not a smooth function of flow, and
    the reason the solver interface has to be residual-based rather than
    ``dp(mdot)``. Worth re-checking when Phase 04 settles that interface.
    """
    check = build_component(
        ComponentInstance.build(
            "CV-01",
            "check_valve",
            {"Cv": Param(2.0, "Cv", M, ""), "bore": Param(10.0, "mm", M, "")},
        )
    )
    forward = check.pressure_drop(0.5, WATER)
    reverse = check.pressure_drop(-0.5, WATER)

    assert reverse > 1e4 * forward, "reverse flow must be effectively blocked"
    assert check.diagnostics(0.5, WATER)["open"] == 1.0
    assert check.diagnostics(-0.5, WATER)["open"] == 0.0


def test_cracking_pressure_must_be_overcome() -> None:
    """At vanishing flow the drop tends to the cracking pressure, not to zero."""
    check = build_component(
        ComponentInstance.build(
            "CV-01",
            "check_valve",
            {
                "Cv": Param(2.0, "Cv", M, ""),
                "bore": Param(10.0, "mm", M, ""),
                "cracking_pressure": Param(5.0, "psi", M, "datasheet"),
            },
        )
    )
    assert check.pressure_drop(1e-9, WATER) == pytest.approx(5.0 * PSI, rel=1e-6)


# ------------------------------------------------------------ real propellants


def test_lox_through_a_feed_line_is_physically_sensible() -> None:
    """An end-to-end sanity check on real propellant, not a pinned number.

    Phase 12 is what validates against measured hardware. This asserts only
    that the pieces connect and the result sits in a defensible range -- which
    is the honest claim available before there is any test data.
    """
    lox = conditions_from_fluid(Fluid("LOX"), p=3.0e6, T=90.0)
    assert lox.rho == pytest.approx(1148.0, rel=1e-2)
    assert 0.5e5 < lox.p_sat < 1.5e5, "LOX at 90 K boils near one atmosphere"
    assert lox.p_crit == pytest.approx(5.043e6, rel=1e-2)

    line = build_component(
        ComponentInstance.build(
            "FL-01",
            "pipe",
            {
                "length": Param(2.0, "m", M, "drawing"),
                "bore": Param(7.75, "mm", M, "3/8 x 0.035 tube"),
            },
        )
    )
    diagnostics = line.diagnostics(0.5, lox)
    assert 5.0 < diagnostics["velocity"] < 15.0, "sane feed-line velocity"
    assert diagnostics["Re"] > 1e5, "turbulent, as a feed line should be"
    assert 0.5e5 < line.pressure_drop(0.5, lox) < 5.0e5


def test_choking_is_reported_when_the_fluid_state_supports_it() -> None:
    """IEC 60534 choked flow needs a saturation and a critical pressure.

    Where they are unknown the limit is reported as absent rather than
    fabricated -- a valve on an unspecified fluid should not claim to know
    where it chokes.
    """
    valve = build_component(
        ComponentInstance.build(
            "SOL-01",
            "valve",
            {"Cv": Param(1.2, "Cv", M, ""), "bore": Param(10.0, "mm", M, "")},
        )
    )
    lox = conditions_from_fluid(Fluid("LOX"), p=3.0e6, T=90.0)
    assert valve.choked_dp(lox) is not None  # type: ignore[attr-defined]
    assert "cavitation_index" in valve.diagnostics(0.5, lox)

    unknown = FlowConditions(rho=1000.0, mu=1e-3, p_upstream=1e6)
    assert valve.choked_dp(unknown) is None  # type: ignore[attr-defined]


def test_an_impossible_operating_point_says_what_is_wrong() -> None:
    """A flow that cannot pass should say so, not fail inside a root find.

    ``fluids`` reports this as a bracketing failure several frames down, which
    tells a solver author nothing. Phase 04 will want to catch this and back off
    a step, and it can only do that if the failure is identifiable.
    """
    from feedtwin.comps import InfeasibleOperatingPoint

    orifice = build_component(
        ComponentInstance.build(
            "OR-01",
            "orifice",
            {
                "bore": Param(0.025, "m", M, "throat"),
                "pipe_bore": Param(0.05, "m", M, "line"),
            },
            model="iso5167",
        )
    )
    starved = FlowConditions(rho=999.0, mu=1.138e-3, p_upstream=0.34e5)
    with pytest.raises(InfeasibleOperatingPoint, match="cannot pass"):
        orifice.pressure_drop(3.0, starved)
