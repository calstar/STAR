"""Phase 14: propellant vapour in the ullage, and chilldown.

Both are opt-in. The first thing every test here establishes is that turning
them off leaves the tank exactly as it was, because a physics option that
perturbs the default is not an option, it is a regression.
"""

from __future__ import annotations

import pytest
from dataclasses import replace

from feedtwin.props import Fluid
from feedtwin.vessels.geometry import CylindricalTank
from feedtwin.vessels.tank import Tank, TankState
from feedtwin.vessels.volume import VesselState
from feedtwin.vessels.vapour import (
    NoVapour,
    SaturatedVapour,
    latent_heat,
    registered_vapour_models,
    vapour_model,
)

PSI = 6894.757293168361


@pytest.fixture(scope="module")
def parts():
    return (
        Fluid("oxygen"),
        Fluid("helium"),
        CylindricalTank(diameter=0.1524, barrel_length=0.531),
    )


def build(parts, **kwargs) -> Tank:
    lox, helium, geometry = parts
    return Tank(
        lox,
        helium,
        geometry,
        wall_mass=8.0,
        wall_capacity=900.0,
        wall_conductance=12.0,
        **kwargs,
    )


def loaded(parts, *, vapour_mass: float = 0.0, wall: float = 293.15) -> TankState:
    lox, helium, geometry = parts
    liquid_volume = 0.95 * geometry.total_volume
    ullage_volume = geometry.total_volume - liquid_volume
    rho = helium.get("rho", p=550 * PSI, T=200.0)
    return TankState(
        ullage=VesselState(
            mass=rho * ullage_volume,
            energy=rho * ullage_volume * helium.get("u", p=550 * PSI, T=200.0),
            wall_temperature=wall,
        ),
        liquid_mass=liquid_volume * lox.get("rho", T=90.0, q=0.0),
        liquid_temperature=90.0,
        contact_time=1.0,
        vapour_mass=vapour_mass,
    )


# ------------------------------------------------------------------- the off switch


def test_the_default_tank_is_unchanged(parts) -> None:
    plain, explicit = build(parts), build(parts, vapour=NoVapour())
    state = loaded(parts)
    assert plain.pressure(state) == explicit.pressure(state)
    assert plain.rates(state).evaporation == 0.0
    assert plain.rates(state).latent_power == 0.0
    assert plain.rates(state).heat_to_wetted_wall == 0.0


def test_with_no_vapour_all_interfacial_heat_warms_the_liquid(parts) -> None:
    """The old behaviour, stated as a property rather than left implied."""
    rates = build(parts).rates(loaded(parts))
    assert rates.heat_to_liquid > 0.0
    assert rates.liquid_temperature > 0.0
    assert rates.latent_power == 0.0


def test_chilldown_is_off_until_given_a_conductance(parts) -> None:
    assert build(parts).rates(loaded(parts)).heat_to_wetted_wall == 0.0
    warm = build(parts, wetted_conductance=50.0)
    assert warm.rates(loaded(parts, wall=293.15)).heat_to_wetted_wall > 0.0


# ------------------------------------------------------------------- the physics


def test_a_saturated_surface_boils_instead_of_warming(parts) -> None:
    """One statement: a liquid at saturation cannot warm, so heat boils it."""
    state = loaded(parts)
    boiling = build(parts, vapour=SaturatedVapour()).rates(state)
    assert boiling.evaporation > 0.0
    assert boiling.liquid_temperature == pytest.approx(0.0, abs=1e-9)


def test_the_boil_off_rate_is_the_heat_over_the_latent_heat(parts) -> None:
    """`mdot = q / h_fg`, checked against the latent heat directly."""
    state = loaded(parts)
    rates = build(parts, vapour=SaturatedVapour()).rates(state)
    h_fg = latent_heat(Fluid("oxygen"), 90.0)
    assert rates.evaporation == pytest.approx(rates.latent_power / h_fg, rel=1e-12)


def test_latent_heat_matches_the_handbook(parts) -> None:
    """LOX at its normal boiling point is about 213 kJ/kg."""
    assert latent_heat(Fluid("oxygen"), 90.0) / 1000.0 == pytest.approx(213.0, abs=2.0)
    assert latent_heat(Fluid("nitrogen"), 77.0) / 1000.0 == pytest.approx(
        199.0, abs=2.0
    )


def test_boil_off_is_lost_from_the_liquid(parts) -> None:
    """A tank that has been boiling has less in it than the load sheet says."""
    rates = build(parts, vapour=SaturatedVapour()).rates(loaded(parts))
    assert rates.liquid_mass == pytest.approx(-rates.evaporation)
    assert rates.vapour_mass == pytest.approx(rates.evaporation)


def test_vapour_adds_partial_pressure(parts) -> None:
    """Dalton: the ullage is pressurant plus vapour, not one or the other."""
    tank = build(parts, vapour=SaturatedVapour())
    dry = tank.pressure(loaded(parts))
    wet = tank.pressure(loaded(parts, vapour_mass=1.0e-3))
    assert wet > dry
    assert wet - dry == pytest.approx(14.16 * PSI, rel=0.05)


def test_chilldown_boils_the_propellant(parts) -> None:
    """The two features are one phase because they are one mechanism: a warm
    wall under the liquid is what boils a cryogen off during a load."""
    state = loaded(parts, wall=293.15)
    still = build(parts, vapour=SaturatedVapour()).rates(state)
    chilling = build(parts, vapour=SaturatedVapour(), wetted_conductance=50.0).rates(
        state
    )
    assert chilling.heat_to_wetted_wall > 0.0
    assert chilling.evaporation > still.evaporation
    assert chilling.ullage.wall_temperature < still.ullage.wall_temperature


# ------------------------------------------------- the two traps this fell into


def test_a_trace_of_vapour_does_not_invert_the_tank_pressure(parts) -> None:
    """A microgram of oxygen in half a litre is 0.002 kg/m^3, and CoolProp's
    Helmholtz formulation returns **-6057 psi** there. One such sample used to
    take the whole tank pressure negative and every solve after it with it.

    Below ~1 kg/m^3 the gas is ideal to well under a tenth of a percent, so the
    ideal answer is the better number, not a fallback.
    """
    tank = build(parts, vapour=SaturatedVapour())
    previous = 0.0
    for grams in (1e-6, 1e-4, 1e-3, 1e-2, 1e-1, 1.0, 5.0):
        partial = tank.vapour_pressure(loaded(parts, vapour_mass=grams / 1000.0))
        assert partial > 0.0, f"{grams} g gave a negative partial pressure"
        assert partial >= previous, "partial pressure must rise with vapour mass"
        previous = partial


def test_vapour_carries_no_foreign_enthalpy_into_the_ullage(parts) -> None:
    """`ullage.energy` is the *pressurant's* internal energy in the pressurant's
    reference state. Saturated LOX sits at -133.7 kJ/kg while helium at ullage
    conditions is +628.6 kJ/kg -- adding one into the other is a category error,
    and with two grams of helium in the ullage it inverts the state in one step.

    So boil-off contributes mass and partial pressure, never an energy term.
    """
    state = loaded(parts)
    dry = build(parts, vapour=NoVapour()).rates(state)
    wet = build(parts, vapour=SaturatedVapour()).rates(state)
    assert wet.evaporation > 0.0, "this test is vacuous if nothing boiled"
    assert wet.ullage.energy == pytest.approx(dry.ullage.energy, rel=1e-12)


def test_the_step_carries_vapour_forward(parts) -> None:
    """A `TankState` rebuilt field by field silently drops anything added to the
    dataclass later, which is how this reset to zero every step."""
    tank = build(parts, vapour=SaturatedVapour())
    state = loaded(parts)
    stepped = tank.step(state, tank.rates(state), 0.01)
    assert stepped.vapour_mass > 0.0


def test_vapour_mass_cannot_go_negative(parts) -> None:
    tank = build(parts, vapour=SaturatedVapour())
    state = loaded(parts, vapour_mass=1e-9)
    rates = tank.rates(state)
    assert tank.step(state, rates, 1000.0).vapour_mass >= 0.0


# ------------------------------------------------------------------- the registry


def test_models_are_named_and_registered() -> None:
    assert registered_vapour_models() == ["none", "saturated"]
    assert vapour_model("none").name == "none"
    assert vapour_model("saturated").name == "saturated"
    with pytest.raises(KeyError, match="no vapour model"):
        vapour_model("wishful")


# ------------------------------------------------------ the primed initial state


def primed(parts, **kwargs) -> tuple[Tank, TankState]:
    """A tank as the cockpit primes it: loaded, at 550 psig, held a while."""
    lox, _, geometry = parts
    tank = build(parts, **kwargs)
    state = tank.initial_state(
        pressure=(550.0 + 14.7) * PSI,
        liquid_mass=0.95 * geometry.total_volume * lox.get("rho", T=90.0, q=0.0),
        liquid_temperature=90.0,
        gas_temperature=293.15,
        contact_time=300.0,
    )
    return tank, state


def test_a_dry_prime_is_unchanged(parts) -> None:
    """No vapour model, or an interface a moment old: no vapour, as before."""
    _, dry = primed(parts)
    _, explicit = primed(parts, vapour=NoVapour())
    assert dry.vapour_mass == 0.0 and explicit == dry
    tank = build(parts, vapour=SaturatedVapour())
    fresh = tank.initial_state(
        pressure=(550.0 + 14.7) * PSI,
        liquid_mass=dry.liquid_mass,
        liquid_temperature=90.0,
        gas_temperature=293.15,
        contact_time=0.0,
    )
    assert fresh.vapour_mass == 0.0
    assert fresh.ullage == dry.ullage


def test_a_held_interface_starts_at_its_saturation_pressure(parts) -> None:
    """Loaded LOX has been boiling into its ullage the whole hold. The tank
    starts with that vapour in it, and the *total* is still what was asked."""
    lox, _, _ = parts
    tank, state = primed(parts, vapour=SaturatedVapour())
    p_sat = lox.get("p", T=90.0, q=0.0)
    assert state.vapour_mass > 0.0
    assert tank.vapour_pressure(state) == pytest.approx(p_sat, rel=0.02)
    assert tank.pressure(state) == pytest.approx((550.0 + 14.7) * PSI, rel=1e-3)
    # And the pressurant made up the remainder, not the whole.
    _, dry = primed(parts)
    assert state.ullage.mass < dry.ullage.mass


def test_a_dry_prime_boils_onto_lockup_and_a_held_one_does_not(parts) -> None:
    """The symptom. Primed dry, saturated LOX boils its vapour *after* the
    regulator has locked up at the total, and the tank ends above it. Primed
    with the interface in equilibrium, the vapour is already there and only
    the collapse cooling moves the pressure -- downward, as it should."""
    lox, _, _ = parts
    tank, wet = primed(parts, vapour=SaturatedVapour())
    dry = replace(wet, vapour_mass=0.0)
    p_sat = lox.get("p", T=90.0, q=0.0)
    p_wet0, p_dry0 = tank.pressure(wet), tank.pressure(dry)
    for _ in range(40):
        wet = tank.step(wet, tank.rates(wet), 0.05)
        dry = tank.step(dry, tank.rates(dry), 0.05)
    assert tank.vapour_pressure(wet) == pytest.approx(p_sat, rel=0.1)
    assert tank.vapour_pressure(dry) > 0.5 * p_sat, "the dry prime is boiling"
    # The dry tank gained the vapour's partial pressure that the wet one
    # started with; the wet one only saw the collapse.
    assert (tank.pressure(dry) - p_dry0) - (tank.pressure(wet) - p_wet0) > 5.0 * PSI
    assert tank.pressure(wet) < p_wet0


# ------------------------------------------------------------- the heat leak


def test_no_ambient_is_exactly_the_old_tank(parts) -> None:
    plain = build(parts, vapour=SaturatedVapour(), wetted_conductance=100.0)
    explicit = build(
        parts,
        vapour=SaturatedVapour(),
        wetted_conductance=100.0,
        ambient_conductance=0.0,
    )
    _, state = primed(parts, vapour=SaturatedVapour(), wetted_conductance=100.0)
    assert plain.rates(state) == explicit.rates(state)


def leaky(parts, **kwargs):
    """A LOX tank someone loaded a while ago: chilled wetted wall, the room
    leaking in through the skin, the wall allowed to boil what reaches it."""
    tank = build(
        parts,
        vapour=SaturatedVapour(),
        wetted_conductance=100.0,
        ambient_conductance=5.0,
        wall_boiling=True,
        **kwargs,
    )
    return tank


def vented(tank, parts) -> TankState:
    """Loaded, at atmosphere with the vent just shut, wall a hair above the
    liquid: the state a tank is in the moment somebody closes its vent."""
    lox, gas, geometry = parts
    state = tank.initial_state(
        pressure=101325.0,
        liquid_mass=0.85 * geometry.total_volume * lox.get("rho", T=90.0, q=0.0),
        liquid_temperature=90.0,
        gas_temperature=100.0,
        contact_time=300.0,
        split_wall=True,
    )
    return replace(state, wetted_wall_temperature=95.0)


def test_a_lox_tank_at_atmosphere_with_the_vent_shut_climbs(parts) -> None:
    """Wall a few kelvin above saturation at one atmosphere: it boils at the
    wall and the shut tank climbs -- a few psi a second on a small ullage,
    slowing as the rising pressure lifts the saturation temperature toward
    the wall's. Without the leak the wall cools to the liquid and it stops."""
    tank = leaky(parts)
    still = build(
        parts, vapour=SaturatedVapour(), wetted_conductance=100.0, wall_boiling=True
    )
    warm = cold = vented(tank, parts)
    p0 = tank.pressure(warm)
    for _ in range(300):
        warm = tank.step(warm, tank.rates(warm), 0.1)
        cold = still.step(cold, still.rates(cold), 0.1)
    rise = (tank.pressure(warm) - p0) / PSI
    assert rise > 5.0, f"a shut LOX tank should climb: {rise:.1f} psi in 30 s"
    # Both climb at first -- the wall had 5 K of heat in it either way. Two
    # minutes on, the wall with no room behind it has cooled to the liquid
    # and stopped; the leaking one is still boiling.
    for _ in range(900):
        warm = tank.step(warm, tank.rates(warm), 0.1)
        cold = still.step(cold, still.rates(cold), 0.1)
    # It is self-limiting: the wall boils only while it is above saturation
    # at the tank's own pressure, so the climb slows as the pressure lifts
    # the saturation temperature toward the wall's -- the reason a shut LOX
    # tank settles in the tens of psig rather than running away. The leaking
    # wall is the warmer one, so it settles higher.
    assert (warm.wetted_wall_temperature or 0.0) > (
        cold.wetted_wall_temperature or 0.0
    ) + 2.0
    assert tank.pressure(warm) > still.pressure(cold) + 1.0 * PSI, (
        tank.pressure(warm) / PSI,
        still.pressure(cold) / PSI,
    )
    assert 5.0 < (tank.pressure(warm) - 101325.0) / PSI < 100.0


def test_a_pressed_lox_tank_does_not_boil_at_the_wall(parts) -> None:
    """At 38 bar of helium the liquid is a hundred kelvin subcooled: a wall a
    few kelvin warm grows no bubbles, the leak warms the bulk, and the tank
    holds. That is why a pressed LOX tank does not run away."""
    tank = leaky(parts)
    _, pressed = primed(
        parts,
        vapour=SaturatedVapour(),
        wetted_conductance=100.0,
        ambient_conductance=5.0,
        wall_boiling=True,
    )
    pressed = replace(pressed, wetted_wall_temperature=95.0)
    rates = tank.rates(pressed)
    assert rates.vapour_mass < 1e-5, rates.vapour_mass
    assert rates.liquid_temperature > 0.0, "the leak warms the bulk instead"


def test_wall_boiling_off_is_the_old_tank(parts) -> None:
    on = build(
        parts,
        vapour=SaturatedVapour(),
        wetted_conductance=100.0,
        ambient_conductance=5.0,
    )
    explicit = build(
        parts,
        vapour=SaturatedVapour(),
        wetted_conductance=100.0,
        ambient_conductance=5.0,
        wall_boiling=False,
    )
    state = vented(on, parts)
    assert on.rates(state) == explicit.rates(state)


def test_a_vent_takes_the_vapour_with_the_pressurant(parts) -> None:
    """A well-mixed ullage leaves through the vent as it is: the caller splits
    the outflow by mass fraction and hands the vapour share here."""
    tank = build(parts, vapour=SaturatedVapour())
    _, state = primed(parts, vapour=SaturatedVapour())
    kept = tank.rates(state)
    vented_ = tank.rates(state, mdot_vapour_out=1.0e-4)
    assert vented_.vapour_mass == pytest.approx(kept.vapour_mass - 1.0e-4)
    assert vented_.ullage.mass == kept.ullage.mass


def test_ethanol_vapour_is_priced_as_a_gas() -> None:
    """R/M, not the equation of state at a state where ethanol is a liquid: a
    fuel tank primed at 293 K holds a fraction of a gram of vapour, not a
    hundred and twenty."""
    from feedtwin.vessels.geometry import CylindricalTank

    eth, gn2 = Fluid("ethanol"), Fluid("nitrogen")
    geometry = CylindricalTank(diameter=0.1524, barrel_length=0.531)
    tank = Tank(eth, gn2, geometry, vapour=SaturatedVapour())
    assert tank._vapour_r_specific() == pytest.approx(8.314462618 / 0.04607, rel=0.01)
    state = tank.initial_state(
        pressure=(550.0 + 14.7) * PSI,
        liquid_mass=0.85 * geometry.total_volume * eth.get("rho", T=293.15, q=0.0),
        liquid_temperature=293.15,
        gas_temperature=293.15,
        contact_time=300.0,
    )
    assert 0.0 < state.vapour_mass < 1.0e-3, state.vapour_mass
    # The EOS at 0.1 kg/m^3 is rough (it reads 20% low here); the point is the
    # order of magnitude -- a fraction of a psi, not 14.
    assert tank.vapour_pressure(state) == pytest.approx(
        eth.get("p", T=293.15, q=0.0), rel=0.3
    )
