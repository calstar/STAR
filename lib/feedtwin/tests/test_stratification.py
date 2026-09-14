"""Where a shut LOX tank's leak heat goes: boiling regimes, the onset
superheat, and the stratified surface layer.

A lumped liquid gets a shut cryogen tank's climb wrong both ways. Boil the
whole leak into the ullage and it is ~100 psi/min; warm all fifteen
kilograms and it is ~0.3 psi/min. The stand shows tens of psi a minute,
because the leak warms the *surface*. Each closure here is opt-in and, off,
leaves the tank exactly as it was.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from feedtwin.props import Fluid
from feedtwin.vessels.geometry import CylindricalTank
from feedtwin.vessels.tank import Tank
from feedtwin.vessels.vapour import SaturatedVapour

PSI = 6894.757


@pytest.fixture(scope="module")
def parts():
    return (
        Fluid("oxygen"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.1524, barrel_length=0.531),
    )


def build(parts, **kwargs) -> Tank:
    lox, gn2, geometry = parts
    return Tank(
        lox,
        gn2,
        geometry,
        wall_mass=6.9,
        wall_capacity=900.0,
        wall_conductance=12.0,
        vapour=SaturatedVapour(),
        wetted_conductance=100.0,
        # An inch of fiberglass under an 8 W/m2K air film: 1.3 W/m2K.
        ambient_conductance=1.3,
        wall_boiling=True,
        **kwargs,
    )


def shut(tank: Tank, parts, *, wall_above: float, pressure: float = 101325.0):
    """Loaded to 95 %, with the vent just shut, wetted wall ``wall_above``
    kelvin over the liquid. At more than twice saturation the ullage is
    seeded with the propellant's own vapour at the liquid's saturation
    pressure, as a tank that has sat a while holds."""
    lox, _, geometry = parts
    state = tank.initial_state(
        pressure=pressure,
        liquid_mass=0.95 * geometry.total_volume * lox.get("rho", T=90.0, q=0.0),
        liquid_temperature=90.0,
        gas_temperature=95.0,
        contact_time=300.0,
        split_wall=True,
    )
    return replace(state, wetted_wall_temperature=90.0 + wall_above)


# ------------------------------------------------------------ the off switch


def test_the_new_closures_off_are_exactly_the_old_tank(parts) -> None:
    old = build(parts)
    new = build(
        parts,
        nucleate_conductance=0.0,
        leidenfrost_superheat=float("inf"),
        boiling_onset=0.0,
        surface_layer=0.0,
        surface_mixing=0.0,
    )
    for above in (2.0, 60.0):
        a = old.rates(shut(old, parts, wall_above=above))
        b = new.rates(shut(new, parts, wall_above=above))
        assert a == b


# --------------------------------------------------------------- the regimes


def test_nucleate_boiling_takes_over_under_the_leidenfrost_point(parts) -> None:
    """A wall 100 K above saturation is insulated by its own vapour film; one
    5 K above is wetted and nucleate boiling pulls thirty times the heat."""
    film = build(parts)
    both = build(parts, nucleate_conductance=3000.0, leidenfrost_superheat=40.0)
    hot_f = film.rates(shut(film, parts, wall_above=100.0)).heat_to_wetted_wall
    hot_b = both.rates(shut(both, parts, wall_above=100.0)).heat_to_wetted_wall
    assert hot_b == pytest.approx(hot_f)
    warm_f = film.rates(shut(film, parts, wall_above=5.0)).heat_to_wetted_wall
    warm_b = both.rates(shut(both, parts, wall_above=5.0)).heat_to_wetted_wall
    assert warm_b == pytest.approx(30.0 * warm_f, rel=1e-6)


def test_a_superheat_under_the_onset_warms_instead_of_boiling(parts) -> None:
    """Two kelvin of superheat: with no onset the wall boils it all into the
    ullage; with a 5 K onset the same heat reaches the liquid as sensible."""
    boils = build(parts)
    waits = build(parts, boiling_onset=5.0)
    r_boil = boils.rates(shut(boils, parts, wall_above=2.0))
    r_wait = waits.rates(shut(waits, parts, wall_above=2.0))
    # The wall's share: everything the ullage gains beyond what the surface
    # itself evaporates. (Over a pressurant-only ullage the saturated surface
    # evaporates in both cases; that is the surface, not the wall.)
    assert r_boil.vapour_mass - r_boil.evaporation > 0.0
    assert r_wait.vapour_mass - r_wait.evaporation == pytest.approx(0.0, abs=1e-12)
    assert r_wait.heat_to_wetted_wall == pytest.approx(r_boil.heat_to_wetted_wall)
    # What the wall did not boil reached the surface instead.
    assert r_wait.latent_power > r_boil.latent_power
    # ...and well over the onset it boils exactly as before.
    hot = waits.rates(shut(waits, parts, wall_above=60.0))
    assert hot.vapour_mass == pytest.approx(
        boils.rates(shut(boils, parts, wall_above=60.0)).vapour_mass
    )


# ---------------------------------------------------------- the surface layer


def test_the_surface_layer_warms_and_the_bulk_barely_does(parts) -> None:
    lox, _, geometry = parts
    tank = build(parts, boiling_onset=5.0, surface_layer=0.01, surface_mixing=5.0)
    # Vapour already at saturation over the surface, so the arriving heat is
    # sensible and has to warm something.
    state = shut(tank, parts, wall_above=1.0, pressure=2.5e5)
    assert state.vapour_mass > 0.0
    assert state.surface_temperature == pytest.approx(90.0)
    rates = tank.rates(state)
    m_s = tank.surface_mass(state)
    assert 0.1 < m_s < 0.4, m_s  # a centimetre of LOX over a 6 in bore
    # The slab takes the heat; the bulk sees only the trickle through the layer.
    assert rates.surface_temperature > 0.0
    assert rates.surface_temperature > 20.0 * rates.liquid_temperature
    stepped = tank.step(state, rates, 1.0)
    assert stepped.surface_temperature == pytest.approx(
        90.0 + rates.surface_temperature, rel=1e-9
    )
    # No layer on the state: the same tank is well mixed.
    mixed = replace(state, surface_temperature=None)
    plain = tank.rates(mixed)
    assert plain.surface_temperature == 0.0
    assert plain.liquid_temperature > rates.liquid_temperature


def test_the_surface_cannot_outrun_the_wall_that_warms_it(parts) -> None:
    """A wall two kelvin warm holds thirty kilojoules; poured into a
    two-hundred-gram layer that would be a surface hotter than the metal.
    Liquid warmed at a wall arrives no hotter than the wall, so once the
    layer reaches it the rest thickens the layer -- here, warms the bulk."""
    tank = build(
        parts,
        boiling_onset=5.0,
        surface_layer=0.01,
        surface_mixing=0.0,
        nucleate_conductance=3000.0,
        leidenfrost_superheat=40.0,
    )
    state = shut(tank, parts, wall_above=2.0, pressure=2.5e5)
    state = replace(state, surface_temperature=state.liquid_temperature + 2.0)
    rates = tank.rates(state)
    # Nothing from the wall reaches a layer already at the wall's temperature;
    # what the wall gives goes to the bulk.
    assert rates.heat_to_wetted_wall > 0.0
    assert rates.liquid_temperature > 0.0
    below = replace(state, surface_temperature=state.liquid_temperature + 0.5)
    r_below = tank.rates(below)
    assert r_below.surface_temperature > rates.surface_temperature
    assert r_below.liquid_temperature < rates.liquid_temperature


def test_a_shut_lox_tank_with_warm_hardware_climbs_at_tens_of_psi_a_minute(
    parts,
) -> None:
    """The stand's number is ~20 psi/min (operator). Where it comes from: the
    dry wall above the liquid is still warm after a load (the liquid never
    touched it), it warms the ullage, the ullage warms the surface, and the
    surface sets the pressure. The three closures together land in that
    decade and keep climbing while the hardware has heat to give; the old
    closure jumps and stalls."""

    def climb(tank: Tank, dt: float = 0.05) -> tuple[float, float]:
        """psi/min over the first and the second half-minute."""
        state = shut(tank, parts, wall_above=0.5)
        # The wall above the liquid: 200 K after a two-minute load.
        state = replace(state, ullage=replace(state.ullage, wall_temperature=200.0))
        marks = [tank.pressure(state)]
        for half in range(2):
            for _ in range(int(30.0 / dt)):
                state = tank.step(state, tank.rates(state), dt)
            marks.append(tank.pressure(state))
        return (marks[1] - marks[0]) / PSI * 2.0, (marks[2] - marks[1]) / PSI * 2.0

    stratified = build(
        parts,
        nucleate_conductance=3000.0,
        leidenfrost_superheat=40.0,
        boiling_onset=5.0,
        surface_layer=0.01,
        surface_mixing=5.0,
    )
    first, second = climb(stratified)
    # Tens of psi a minute over the first minute, front-loaded -- the dry
    # wall gives its heat fastest while it is hottest -- and still climbing
    # in the second half-minute rather than stalled.
    assert (
        10.0 < (first + second) / 2.0 < 80.0
    ), f"{first:.1f} then {second:.1f} psi/min"
    assert second > 2.0, f"{first:.1f} then {second:.1f} psi/min"
    # The old closure -- boil the leak at the wall -- jumps and then stalls:
    # the rising pressure lifts saturation over the wall, boiling stops, and
    # the leak warms fifteen kilograms at a fraction of a psi a minute.
    boiling = build(parts, nucleate_conductance=3000.0, leidenfrost_superheat=40.0)
    b_first, b_second = climb(boiling)
    assert b_second < 0.2 * b_first, f"{b_first:.1f} then {b_second:.1f} psi/min"


def test_the_surface_boils_at_saturation_instead_of_running_to_the_critical_point(
    parts,
) -> None:
    """A dry wall at room temperature over a small ullage pours kilowatts into
    the gas, and the gas into the surface. The layer stops at saturation for
    the tank's pressure and the heat becomes vapour; it never reaches the
    critical temperature, where every property call fails and the tank
    used to freeze at zero."""
    tank = build(parts, boiling_onset=2.0, surface_layer=0.01, surface_mixing=5.0)
    state = shut(tank, parts, wall_above=0.5, pressure=2.5e5)
    state = replace(state, ullage=replace(state.ullage, wall_temperature=293.0))
    T_crit = float(parts[0].critical_temperature)
    for _ in range(int(60.0 / 0.02)):
        rates = tank.rates(state)
        state = tank.step(state, rates, 0.02)
        assert state.surface_temperature is not None
        assert state.surface_temperature < T_crit - 1.0
        assert tank.pressure(state) > 1.0e5
    assert state.vapour_mass > 0.0
    # And the tank stops at the propellant's critical pressure: past the end
    # of the saturation line there is nothing to boil, so the heat warms the
    # bulk and the pressure holds.
    p_crit = float(parts[0].critical_pressure)
    for _ in range(int(120.0 / 0.02)):
        state = tank.step(state, tank.rates(state), 0.02)
        assert tank.pressure(state) < 1.01 * p_crit
    assert state.liquid_temperature > 90.05
