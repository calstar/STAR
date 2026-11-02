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


def test_a_bottle_under_the_lockup_primes_the_tanks_at_the_bottle() -> None:
    """A regulator delivers no more than its inlet. A bottle charged under the
    lockup leaves the regulator wide open and the tanks where the bottle is: by
    hand, 200 psig of helium presses the tanks to at most 200 psig. T-0 primed
    them at the 560 psig the regulator's law gives, from gas the bottle never
    had (LE4 (3), COPV 400 psig: tanks at 579 psig)."""
    session = _helium_stand()
    t0 = jump_to_t0(session, copv_psi=200.0, fill_fraction=0.9)
    bottle = next(iter(session.bottles.values()))
    assert psig(bottle.pressure) == pytest.approx(200.0, abs=1.0)
    for sim in session.tanks.values():
        assert psig(sim.pressure) <= psig(bottle.pressure) + 0.5
        assert psig(sim.pressure) == pytest.approx(200.0, abs=1.0)
    assert t0.tank_psi == pytest.approx(200.0, abs=1.0)
    # The regulator's own lockup is still reported, and the note says why the
    # tanks are not at it.
    assert all(v > 500.0 for v in t0.lockup_psi.values())
    assert any("wide open" in n for n in t0.notes)


def test_subcooled_lox_over_its_critical_pressure_is_not_critical() -> None:
    """Dome 735 on LE4: both tanks lock up at ~745 psia, over oxygen's 731 psia
    critical pressure, and Ready said "LOX-Tank is at its propellant's critical
    pressure and the model can go no higher. The drawing has no relief valve" --
    with the tank above it, and a relief drawn. 90 K LOX under nitrogen is an
    ordinary compressed liquid; what nears the critical point is the propellant
    itself, a liquid warmed toward oxygen's 154.6 K."""
    from dataclasses import replace

    from test_ignore_gse import _session as _le4

    session = _le4(True)
    session.setup = replace(session.setup, dome_psi=735.0)
    jump_to_t0(session, copv_psi=3750.0, fill_fraction=0.95)
    lox = next(
        sim for sim in session.tanks.values() if sim.state.liquid_temperature < 120.0
    )
    p_crit = float(lox.tank.liquid.critical_pressure)
    assert lox.pressure > p_crit, "the total pressure is over oxygen's critical"
    notes = session.step(0.02).notes
    assert not [n for n in notes if "critical" in n], notes
    # A liquid that has warmed to within a hair of its critical point is (a
    # kilogram of it: the load at 154 K would not fit the tank).
    lox.state = replace(lox.state, liquid_temperature=154.0, liquid_mass=1.0)
    (near,) = [n for n in session._notes() if "critical" in n]
    assert near.startswith("LOX-Tank") and "Vent it." in near
    assert "can go no higher" not in near
    if session._reliefs:
        assert "no relief valve" not in near


def test_a_lockup_under_atmosphere_primes_the_tanks_at_atmosphere() -> None:
    """A dome turned to zero gives dome + bias - S x bottle under atmosphere on a
    charged COPV: the regulator is shut, and no regulator pulls a vacuum. T-0
    primed the tanks at 9.6 psia on LE4 (3)."""
    from dataclasses import replace

    from test_ignore_gse import _session as _le4

    session = _le4(True)
    session.setup = replace(session.setup, dome_psi=0.0)
    t0 = jump_to_t0(session, copv_psi=3750.0, fill_fraction=0.95)
    assert all(v < 0.0 for v in t0.lockup_psi.values()), "under atmosphere"
    for tank_id in session.vehicle_tanks:
        assert psig(session.tanks[tank_id].pressure) == pytest.approx(0.0, abs=0.05)
    assert t0.tank_psi == pytest.approx(0.0, abs=0.05)
    assert any("shut" in n for n in t0.notes)
