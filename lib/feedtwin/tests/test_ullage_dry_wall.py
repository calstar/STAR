"""An ullage cools against the wall it touches: the dry wall above the liquid.

A tank's ``wall_conductance`` is the whole tank's hA (a per-litre default, or the
still-gas film over the full inner surface). Applied to the ullage at every
fill, it let a 0.8 L ullage on a 95 % full LOX tank exchange heat with all
fifteen litres of cold wall: a freshly pressed tank sat in Ready fell 548 -> 260
psig in six seconds, where the stand takes something like thirty.
``Tank(wall_by_level=True)`` (``Setup.ullage_wall_by_level``) scales it by the
dry share of the wall. Checked against the geometry, and against the old
behaviour where it is off.
"""

from __future__ import annotations

import pytest

from feedtwin.props import Fluid
from feedtwin.session.burn import burn_setup
from feedtwin.session.core import Setup
from feedtwin.vessels import CylindricalTank, NoCollapse, Tank

PSI = 6894.757293168361


def _tank(by_level: bool) -> Tank:
    return Tank(
        Fluid("oxygen"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.152, barrel_length=0.600),
        collapse=NoCollapse(),
        wall_mass=6.0,
        wall_capacity=500.0,
        wall_conductance=10.0,
        wall_by_level=by_level,
    )


def _state(tank: Tank, fill: float):  # type: ignore[no-untyped-def]
    rho = tank.liquid.get("rho", T=90.0, q=0.0)
    state = tank.initial_state(
        pressure=548 * PSI,
        liquid_mass=fill * tank.geometry.total_volume * rho,
        liquid_temperature=90.0,
        gas_temperature=300.0,
    )
    return state


def test_the_dry_fraction_is_the_wall_above_the_liquid() -> None:
    tank = _tank(True)
    fractions = [tank.dry_wall_fraction(_state(tank, f)) for f in (0.05, 0.4, 0.95)]
    assert fractions == sorted(fractions, reverse=True)
    assert fractions[0] > 0.9 and fractions[-1] < 0.15
    # Against the geometry by hand: wall above the level over the whole wall.
    g = tank.geometry
    state = _state(tank, 0.4)
    total = g.wetted_area(g.height)
    assert tank.dry_wall_fraction(state) == pytest.approx(
        (total - g.wetted_area(tank.level(state))) / total
    )


def test_the_ullage_loses_heat_to_the_dry_wall_only() -> None:
    """With nothing else exchanging, the ullage's energy rate is the wall term: on, it is
    the off value times the dry fraction, exactly."""
    off, on = _tank(False), _tank(True)
    state = _state(off, 0.95)
    rate_off = off.rates(state).ullage.energy
    rate_on = on.rates(state).ullage.energy
    assert rate_off < 0.0, "a 300 K ullage on a 90 K wall cools"
    assert rate_on == pytest.approx(rate_off * on.dry_wall_fraction(state), rel=1e-9)
    assert abs(rate_on) < 0.15 * abs(rate_off)


def test_on_in_the_cockpit_off_in_the_study() -> None:
    assert Setup().ullage_wall_by_level is True
    assert burn_setup().ullage_wall_by_level is False
    assert (
        Tank(
            Fluid("oxygen"),
            Fluid("nitrogen"),
            CylindricalTank(diameter=0.1, barrel_length=0.2),
        ).wall_by_level
        is False
    )
