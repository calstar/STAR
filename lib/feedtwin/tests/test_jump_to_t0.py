"""The cockpit's Jump to T-0: loaded, charged and at the regulators' lockup.

Checked against the drawing, not the code: the regulator drawn at 560 psi
(gauge, as a drawing reads) locks the tanks up at 560 plus its seat's rise,
and that is where T-0 puts them -- in Ready, loaded, with the bottle charged.
"""

from __future__ import annotations

import pytest
from test_press_path_coupling import _helium_stand

from feedtwin.session.burn import jump_to_t0, regulator_lockup
from feedtwin.session.gauge import from_psig, psig


def test_the_lockup_is_the_drawn_regulator_at_zero_flow() -> None:
    session = _helium_stand()
    regulator = next(
        b.component
        for b in session.model.built.network.branches.values()
        if type(b.component).__name__.endswith("Regulator")
    )
    rise = float(regulator.p.get("lockup_rise", 0.0))
    for tank_id in session.tanks:
        lockup = regulator_lockup(session, tank_id)
        assert lockup is not None
        assert lockup == pytest.approx(from_psig(560.0) + rise, abs=200.0)


def test_t0_is_loaded_charged_and_at_lockup_in_ready() -> None:
    session = _helium_stand()
    t0 = jump_to_t0(session, copv_psi=4500.0, fill_fraction=0.9)
    assert session.state == "Ready"
    assert set(t0.lockup_psi) == set(session.tanks)
    for sim in session.tanks.values():
        assert psig(sim.pressure) == pytest.approx(t0.tank_psi, abs=0.5)
        assert sim.state.liquid_mass > 0.5
    assert t0.tank_psi == pytest.approx(
        psig(regulator_lockup(session, next(iter(session.tanks))) or 0.0), abs=0.5
    )
    bottle = next(iter(session.bottles.values()))
    assert psig(bottle.pressure) == pytest.approx(4500.0, abs=5.0)


def test_reading_the_lockup_moves_nothing() -> None:
    """The console reads each tank's lockup on every tick. Evaluated through
    the step's signals, that snapped every valve to its command: a main
    halfway through its travel was fully open after the readout, so the
    console's valves opened in one tick whatever their travel time."""
    session = _helium_stand()
    jump_to_t0(session, copv_psi=4500.0, fill_fraction=0.9)
    session.command_state("Fire")
    travel = min(session._travel_time(v) for v in session.model.built.actuators)
    session.step(travel / 4)
    moving = {v: x for v, x in session._positions.items() if 0.0 < x < 1.0}
    assert moving, "a valve should be mid-travel a quarter of the way in"
    tank_id = next(iter(session.tanks))
    for loaded in (False, True):
        regulator_lockup(session, tank_id, loaded_dome=loaded)
        assert {v: session._positions[v] for v in moving} == moving
