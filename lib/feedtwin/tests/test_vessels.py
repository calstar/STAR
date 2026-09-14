"""Vessels and the gas side: does a COPV's pressure mean anything?

Phase 05's exit criteria. The one that matters is the first: an adiabatic
blowdown has a closed-form answer, and a model that cannot reproduce it has no
business predicting how long a bottle holds regulator inlet pressure.

Checked at *low* pressure, deliberately. Nitrogen is nearly ideal there, so the
ideal-gas closed form is the right reference; at COPV pressure the model should
depart from it, and by how much is the whole reason for using a real equation of
state. Both directions are asserted.
"""

from __future__ import annotations

import math

import pytest

from feedtwin.comps import (
    InfeasibleOperatingPoint,
    build_component,
    choked_mass_flow,
    conditions_from_fluid,
    critical_pressure_ratio,
)
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid
from feedtwin.vessels import GasVolume, VesselState

M = Provenance.MANUFACTURER


def _reached(history: list[tuple[float, VesselState]], m0: float, fraction: float):
    """The sample nearest a mass fraction, asserting it was actually reached.

    Without the assertion a blowdown that ran out of time returns its last
    sample and the test quietly checks the wrong point -- which is exactly what
    happened while writing these.
    """
    _t, state = min(history, key=lambda ts: abs(ts[1].mass - m0 * fraction))
    assert abs(state.mass / m0 - fraction) < 0.01, (
        f"blowdown never reached m/m0={fraction}; got {state.mass / m0:.3f}. "
        "Lengthen the run."
    )
    return state


# ------------------------------------------------------------- the closed form


def test_adiabatic_blowdown_matches_the_closed_form() -> None:
    """``T/T0 = (m/m0)^(g-1)`` and ``p/p0 = (m/m0)^g``, exactly, for an ideal gas.

    Phase 05's headline criterion. A vessel with no wall is adiabatic, and at
    two bar nitrogen is ideal to within 0.04%, so the model has nowhere to hide.
    """
    nitrogen = Fluid("nitrogen")
    vessel = GasVolume(nitrogen, volume=0.05)
    start = vessel.initial_state(pressure=2.0e5, temperature=300.0)
    gamma = nitrogen.get("gamma", p=2.0e5, T=300.0)

    assert vessel.compressibility(start) == pytest.approx(
        1.0, abs=1e-3
    ), "the reference only holds where the gas is nearly ideal"

    history = vessel.blowdown(start, mdot=1.0e-4, duration=900.0, steps=30000)
    for fraction in (0.9, 0.7, 0.5):
        state = _reached(history, start.mass, fraction)
        ratio = state.mass / start.mass
        assert vessel.temperature(state) == pytest.approx(
            300.0 * ratio ** (gamma - 1.0), rel=3e-3
        )
        assert vessel.pressure(state) == pytest.approx(2.0e5 * ratio**gamma, rel=3e-3)


def test_a_real_gas_departs_from_the_ideal_result_at_copv_pressure() -> None:
    """And it must, or the real equation of state is doing nothing.

    A test that only checked the ideal limit would pass on an ideal-gas model,
    which is the model this phase exists to replace.
    """
    nitrogen = Fluid("nitrogen")
    vessel = GasVolume(nitrogen, volume=0.009)
    start = vessel.initial_state(pressure=310.0e5, temperature=293.15)
    gamma = nitrogen.get("gamma", p=310.0e5, T=293.15)

    history = vessel.blowdown(start, mdot=3.0e-3, duration=600.0, steps=20000)
    state = _reached(history, start.mass, 0.7)
    ratio = state.mass / start.mass

    ideal = 310.0e5 * ratio**gamma
    assert (
        vessel.pressure(state) < 0.95 * ideal
    ), "a 310 bar bottle is not an ideal gas and the model should say so"


def test_an_ideal_gas_would_overstate_what_a_bottle_holds() -> None:
    """The number that justifies the whole property layer.

    A 9 L bottle at 4500 psi holds about 2.79 kg of nitrogen. Ideal gas says
    3.21 kg -- 15% more pressurant than is actually in there, which propagates
    straight into how long the tanks stay up.
    """
    nitrogen = Fluid("nitrogen")
    vessel = GasVolume(nitrogen, volume=0.009)
    state = vessel.initial_state(pressure=310.0e5, temperature=293.15)

    ideal_mass = 310.0e5 * 0.009 / (296.8 * 293.15)
    assert state.mass == pytest.approx(2.788, rel=1e-2)
    assert ideal_mass / state.mass == pytest.approx(1.15, rel=0.02)


# ------------------------------------------------------------------- the wall


def test_the_wall_sets_the_polytropic_exponent_rather_than_assuming_it() -> None:
    """EngineDesign's blowdown solver takes ``n`` as an input. Here it is output.

    The vessel wall is a heat reservoir several times the gas's own capacity,
    and how tightly it is coupled decides how much the bottle cools. Assuming an
    exponent assumes the answer; giving the wall its real mass and conductance
    produces one.
    """
    nitrogen = Fluid("nitrogen")
    results = {}
    for label, wall in [
        ("adiabatic", {}),
        ("loose", dict(wall_mass=6.0, wall_capacity=900.0, wall_conductance=5.0)),
        ("tight", dict(wall_mass=6.0, wall_capacity=900.0, wall_conductance=40.0)),
    ]:
        vessel = GasVolume(nitrogen, volume=0.009, **wall)  # type: ignore[arg-type]
        start = vessel.initial_state(pressure=310.0e5, temperature=293.15)
        history = vessel.blowdown(start, mdot=3.0e-3, duration=600.0, steps=20000)
        state = _reached(history, start.mass, 0.5)
        exponent = 1.0 + math.log(vessel.temperature(state) / 293.15) / math.log(0.5)
        results[label] = (vessel.pressure(state), exponent)

    # A better-coupled wall keeps the gas warmer, so the bottle holds more.
    assert results["adiabatic"][0] < results["loose"][0] < results["tight"][0]
    # ...and the implied exponent falls toward isothermal as coupling rises.
    assert results["adiabatic"][1] > results["loose"][1] > results["tight"][1]
    # The spread is large enough that assuming it is a real modelling decision.
    assert results["tight"][0] / results["adiabatic"][0] > 1.3


def test_heat_from_the_wall_is_reported_not_buried() -> None:
    """It decides how fast a bottle droops, so it belongs in the result."""
    vessel = GasVolume(
        Fluid("nitrogen"),
        volume=0.009,
        wall_mass=6.0,
        wall_capacity=900.0,
        wall_conductance=20.0,
    )
    state = vessel.initial_state(pressure=310.0e5, temperature=293.15)
    cold = VesselState(state.mass * 0.6, state.energy * 0.55, wall_temperature=293.15)

    rates = vessel.rates(cold, mdot_out=1.0e-3)
    assert rates.heat_from_wall > 0.0, "a warm wall heats cooled gas"
    assert rates.wall_temperature < 0.0, "and cools doing it"


def test_an_isolated_vessel_holds_its_state() -> None:
    """No flow, no heat: nothing should drift."""
    vessel = GasVolume(Fluid("helium"), volume=0.02)
    state = vessel.initial_state(pressure=200.0e5, temperature=290.0)
    rates = vessel.rates(state)

    assert rates.mass == 0.0
    assert rates.energy == 0.0
    assert vessel.pressure(vessel.step(state, rates, 10.0)) == pytest.approx(
        vessel.pressure(state)
    )


def test_initial_state_round_trips_through_pressure_and_temperature() -> None:
    """Nobody fills a bottle to an internal energy."""
    for name, pressure, temperature in [
        ("nitrogen", 310.0e5, 293.15),
        ("helium", 200.0e5, 290.0),
        ("nitrogen", 2.0e5, 300.0),
    ]:
        vessel = GasVolume(Fluid(name), volume=0.01)
        state = vessel.initial_state(pressure, temperature)
        assert vessel.pressure(state) == pytest.approx(pressure, rel=1e-6)
        assert vessel.temperature(state) == pytest.approx(temperature, rel=1e-6)


# --------------------------------------------------------------- the gas side


def _orifice(bore_mm: float = 1.0) -> object:
    return build_component(
        ComponentInstance.build(
            "GO-01",
            "gas_orifice",
            {"bore": Param(bore_mm, "mm", M, "throat"), "Cd": Param(0.85, "-", M, "")},
        )
    )


def test_the_critical_pressure_ratio_is_the_textbook_value() -> None:
    """0.528 for a diatomic gas. A constant worth pinning, not deriving twice."""
    assert critical_pressure_ratio(1.4) == pytest.approx(0.5283, rel=1e-3)
    assert critical_pressure_ratio(1.667) == pytest.approx(0.4867, rel=1e-3)


def test_choked_flow_is_a_ceiling_not_an_asymptote() -> None:
    """Past it, no downstream pressure exists that passes the flow.

    Reported as infeasible rather than iterated on, so a solver can back off
    rather than wander.
    """
    orifice = _orifice()
    nitrogen = conditions_from_fluid(Fluid("nitrogen"), 310.0e5, 293.15)
    ceiling = orifice.choked_flow(nitrogen)  # type: ignore[attr-defined]

    assert orifice.pressure_drop(0.99 * ceiling, nitrogen) > 0.0  # type: ignore[attr-defined]
    with pytest.raises(InfeasibleOperatingPoint):
        orifice.pressure_drop(1.05 * ceiling, nitrogen)  # type: ignore[attr-defined]


def test_choked_flow_scales_with_area_and_upstream_pressure() -> None:
    """The two things a relief orifice is sized on."""
    args = dict(temperature=293.15, gamma=1.4, r_specific=296.8)
    base = choked_mass_flow(1.0e-6, 0.85, 100.0e5, **args)  # type: ignore[arg-type]

    assert choked_mass_flow(2.0e-6, 0.85, 100.0e5, **args) == pytest.approx(  # type: ignore[arg-type]
        2.0 * base
    )
    assert choked_mass_flow(1.0e-6, 0.85, 200.0e5, **args) == pytest.approx(  # type: ignore[arg-type]
        2.0 * base
    )


def test_helium_chokes_at_a_third_the_mass_flow_of_nitrogen() -> None:
    """Same hole, same pressure, very different pressurant budget.

    Helium's low molecular weight means far less mass through the same orifice,
    which is the trade against its not condensing into a cold ullage.
    """
    orifice = _orifice()
    nitrogen = conditions_from_fluid(Fluid("nitrogen"), 310.0e5, 293.15)
    helium = conditions_from_fluid(Fluid("helium"), 310.0e5, 293.15)

    ratio = orifice.choked_flow(nitrogen) / orifice.choked_flow(helium)  # type: ignore[attr-defined]
    assert 2.0 < ratio < 3.5, f"nitrogen/helium choked flow ratio was {ratio:.2f}"


def test_gas_pressure_drop_rises_with_flow_and_inverts_correctly() -> None:
    """The relation is solved by bracketing, so check it actually inverts."""
    from feedtwin.comps.gas import subsonic_mass_flow

    orifice = _orifice()
    nitrogen = conditions_from_fluid(Fluid("nitrogen"), 310.0e5, 293.15)
    ceiling = orifice.choked_flow(nitrogen)  # type: ignore[attr-defined]

    previous = 0.0
    for fraction in (0.2, 0.5, 0.9):
        mdot = ceiling * fraction
        dp = orifice.pressure_drop(mdot, nitrogen)  # type: ignore[attr-defined]
        assert dp > previous
        previous = dp

        recovered = subsonic_mass_flow(
            math.pi * 0.001**2 / 4.0,
            0.85,
            310.0e5,
            1.0 - dp / 310.0e5,
            293.15,
            nitrogen.gamma,
            nitrogen.r_specific,
        )
        assert recovered == pytest.approx(mdot, rel=1e-6)


def test_gas_conditions_carry_what_a_gas_needs() -> None:
    """Liquid components ignore these; gas components cannot work without them."""
    conditions = conditions_from_fluid(Fluid("nitrogen"), 310.0e5, 293.15)
    assert conditions.gamma > 1.0
    assert conditions.r_specific == pytest.approx(296.8, rel=1e-3)
    assert conditions.temperature == pytest.approx(293.15)


def test_a_liquid_in_a_gas_volume_is_refused() -> None:
    """(rho, u) is a fine state pair for a gas and a poor one for a liquid.

    Liquid density is roughly 180x less sensitive to pressure, so recovering
    pressure from density amplifies any error in it by the same factor: through
    interpolated tables a liquid comes back 0.1-0.7% out where a gas is within
    1e-4%. That is small enough to go unnoticed and large enough to matter, so
    it is refused rather than tolerated.
    """
    vessel = GasVolume(Fluid("oxygen"), volume=0.01)
    with pytest.raises(ValueError, match="is a liquid"):
        vessel.initial_state(pressure=30.0e5, temperature=90.0)


def test_gases_round_trip_through_tables_without_loss() -> None:
    """The other half of that claim, so the guard is not merely superstition."""
    for name, pressure, temperature in [
        ("nitrogen", 310.0e5, 293.15),
        ("helium", 200.0e5, 290.0),
    ]:
        fluid = Fluid(name)
        rho = fluid.get("rho", p=pressure, T=temperature)
        u = fluid.get("u", p=pressure, T=temperature)
        assert fluid.get("p", rho=rho, u=u) == pytest.approx(pressure, rel=1e-5)


def test_stirring_scales_only_the_wall_exchange() -> None:
    """A charge jet stirs the vessel; `stirring` multiplies the still-gas
    conductance and nothing else. At 1 it is exactly the old behaviour."""
    from feedtwin.props import Fluid
    from feedtwin.vessels.volume import GasVolume

    vessel = GasVolume(
        Fluid("nitrogen"),
        0.044,
        wall_mass=60.0,
        wall_capacity=500.0,
        wall_conductance=89.0,
    )
    state = vessel.initial_state(pressure=200e5, temperature=350.0)
    state = state.__class__(
        mass=state.mass, energy=state.energy, wall_temperature=300.0
    )
    still = vessel.rates(state)
    same = vessel.rates(state, stirring=1.0)
    stirred = vessel.rates(state, stirring=5.0)
    assert same == still
    assert stirred.heat_from_wall == pytest.approx(5.0 * still.heat_from_wall)
    assert stirred.mass == still.mass
    assert stirred.energy - still.energy == pytest.approx(4.0 * still.heat_from_wall)
