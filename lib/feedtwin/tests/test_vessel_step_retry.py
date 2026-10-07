"""A vessel step that halves itself still integrates the whole step.

``TankSim._one_step`` halves a piece the equation of state refuses and tries
again. It used to return on the first piece that landed, so a step that
retried once integrated half its ``dt`` and dropped the rest of the liquid
outflow and gas exchange on the floor -- during vents and near-empty ullages,
exactly where mass matters. Checked against the arithmetic of the inputs: the
ullage's mass rate is the net gas flow, and the liquid's is the outflow.
"""

from __future__ import annotations

from typing import Any

import pytest

from feedtwin.props import Fluid
from feedtwin.session.core import TankSim
from feedtwin.session.gauge import from_psig
from feedtwin.vessels import CylindricalTank, Tank, TankState


def _sim() -> TankSim:
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
        state=state,
        ullage_node="u",
        outlet_node="o",
    )


def _refuse(sim: TankSim, times: int, monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Make the tank refuse the first ``times`` candidates a step proposes.

    Only candidates: the rates evaluation prices the state the sim is at,
    which the equation of state has already accepted.
    """
    real = sim.tank.pressure
    refused = [0]

    def pressure(state: TankState) -> Any:
        if state is not sim.state and refused[0] < times:
            refused[0] += 1
            raise ValueError("refused for the test")
        return real(state)

    monkeypatch.setattr(sim.tank, "pressure", pressure)
    return refused


@pytest.mark.parametrize("times", [0, 1, 3])
def test_a_retried_step_moves_all_of_its_mass(
    times: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    sim = _sim()
    refused = _refuse(sim, times, monkeypatch)
    before = sim.state
    dt, liquid_out, net_gas = 0.05, 2.0, 0.01

    sim._one_step(dt, liquid_out, net_gas, sim.tank.gas_enthalpy(before))

    assert refused[0] == times
    assert before.liquid_mass - sim.state.liquid_mass == pytest.approx(
        liquid_out * dt, rel=1e-12
    )
    assert sim.state.ullage.mass - before.ullage.mass == pytest.approx(
        net_gas * dt, rel=1e-9
    )


def test_no_retry_is_one_explicit_step() -> None:
    """The common case is unchanged bit for bit: one Euler step of ``dt``."""
    sim = _sim()
    before = sim.state
    dt, liquid_out, net_gas = 0.05, 2.0, 0.01
    h = sim.tank.gas_enthalpy(before)
    rates = sim.tank.rates(
        before, mdot_liquid_out=liquid_out, mdot_gas_in=net_gas, enthalpy_gas_in=h
    )
    expected = sim.tank.step(before, rates, dt)

    sim._one_step(dt, liquid_out, net_gas, h)

    assert sim.state.liquid_mass == expected.liquid_mass
    assert sim.state.ullage == expected.ullage
