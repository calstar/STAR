"""A tank gives what it holds, and books what it was asked for beyond that.

``TankSim.advance`` used to stop the outflow altogether once a tank was down
to a gram, while the network that asked for it went on delivering it: up to a
step of propellant the engine burned and no vessel gave. The session now ends
a coupling step where a tank runs out (``Session._dry_cut``); this is the
vessel's backstop under it. Checked against the arithmetic of the inputs:
what left the tank plus what was booked is what was asked for.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from feedtwin.props import Fluid
from feedtwin.session.core import DRY_MASS, TankSim
from feedtwin.session.gauge import from_psig
from feedtwin.vessels import CylindricalTank, Tank, TankState


def _sim(liquid_kg: float) -> TankSim:
    tank = Tank(
        Fluid("ethanol"),
        Fluid("nitrogen"),
        CylindricalTank(diameter=0.152, barrel_length=0.40),
    )
    state = tank.initial_state(
        pressure=from_psig(400.0),
        liquid_mass=4.0,
        liquid_temperature=293.15,
        gas_temperature=293.15,
    )
    return TankSim(
        id="T",
        label="T",
        tank=tank,
        state=replace(state, liquid_mass=liquid_kg),
        ullage_node="u",
        outlet_node="o",
    )


def _held(state: TankState) -> float:
    return state.liquid_mass + state.ullage.mass + state.vapour_mass


def _drain(sim: TankSim, dt: float, mdot: float) -> float:
    """Advance with only a liquid outflow; return the mass that left [kg]."""
    before = _held(sim.state)
    sim.advance(
        dt,
        mdot_liquid_out=mdot,
        mdot_gas_in=0.0,
        mdot_gas_out=0.0,
        enthalpy_gas_in=sim.tank.gas_enthalpy(sim.state),
    )
    return before - _held(sim.state)


def test_asked_for_more_than_it_holds_it_gives_all_and_books_the_rest() -> None:
    sim = _sim(0.005)
    dt, mdot = 0.02, 1.0
    left = _drain(sim, dt, mdot)
    assert sim.state.liquid_mass == pytest.approx(0.0, abs=1e-12)
    assert left == pytest.approx(0.005, rel=1e-9)
    assert left + sim.fixed_kg == pytest.approx(mdot * dt, rel=1e-9)


def test_the_last_gram_is_delivered_not_dropped() -> None:
    """Below DRY_MASS the tank is empty to the panel, but what it holds still
    flows: zeroing it -- what this did -- refused the step without booking."""
    sim = _sim(0.5 * DRY_MASS)
    dt, mdot = 1e-3, 0.1
    left = _drain(sim, dt, mdot)
    assert sim.empty
    assert left == pytest.approx(mdot * dt, rel=1e-9)
    assert sim.fixed_kg == pytest.approx(0.0, abs=1e-12)


def test_a_tank_with_enough_is_untouched() -> None:
    sim = _sim(2.0)
    dt, mdot = 0.02, 1.0
    left = _drain(sim, dt, mdot)
    assert not sim.empty
    assert left == pytest.approx(mdot * dt, rel=1e-9)
    assert sim.fixed_kg == pytest.approx(0.0, abs=1e-12)
