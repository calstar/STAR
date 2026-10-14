"""The watcher (``feedtwin.session.watch``), and the faults it found first.

A clean LE4 (6) burn and abort raises no flag and keeps its mass; each check
fires when its condition is put into a real stand; flags are episodes, not
ticks. And the two faults the watcher turned up on its first runs:

* The chamber of a drawing with no engine model counted any flow touching it
  as "lit", including flow *out* of it: after a burn it stayed at its drawn
  385 psia, and an Engine Abort's open mains drove 3 kg/s from the dead engine
  back into the tanks -- 16 kg the mass balance could not account for.
* A tank the cart loads through the drawing credited any liquid arriving at
  its outlet, wherever it came from: at Fire on unpressed tanks the chamber's
  push-back filled a full fuel tank 46 g a second, and on a longer pad
  overfilled it ("tank is overfull") and stopped the stand.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from feedtwin.session.burn import jump_to_t0
from feedtwin.session.watch import CLOSE_AFTER_S, Watcher, _Seen
from feedtwin.solve.steady import INITIAL_FLOW

from test_ignore_gse import DRAWING, TABLES, _ids, _session

needs_le4 = pytest.mark.skipif(
    not (DRAWING.exists() and TABLES.is_dir()), reason="LE4 fixture or tables absent"
)


def _burn_and_abort():  # type: ignore[no-untyped-def]
    session = _session(True)
    jump_to_t0(
        session,
        copv_psi=session.setup.copv_target_psi,
        fill_fraction=session.setup.full_fraction,
    )
    for state, seconds in (("Ready", 2.0), ("Fire", 8.0), ("Engine Abort", 8.0)):
        session.state = state
        for _ in range(int(seconds / 0.5)):
            session.step(0.5)
    return session


@needs_le4
def test_a_burn_and_an_abort_raise_nothing_and_keep_their_mass() -> None:
    session = _burn_and_abort()
    record = session.solver_log[-1]
    assert record.mass_error_kg - record.guard_kg == pytest.approx(0.0, abs=1e-5)
    assert [f.to_dict() for f in session.watcher.flags] == []


@needs_le4
def test_a_dead_engine_does_not_push_back_up_the_mains() -> None:
    """After burnout the chamber is the air, not its drawn 385 psia."""
    session = _burn_and_abort()
    net = session.model.built.network
    assert net.nodes[session._chamber_node].pressure == pytest.approx(101325.0)
    assert all(sim.refused_kg == 0.0 for sim in session.tanks.values())


@needs_le4
def test_a_full_fuel_tank_does_not_fill_from_the_chamber() -> None:
    ids = _ids()
    session = _session(False)
    fuel = session.tanks[ids["Eth-Tank"]]
    for state, steps in (("Armed", 1), ("Fuel Fill", 30), ("Armed", 1)):
        session.state = state
        for _ in range(steps):
            session.step(0.5)
    full = fuel.state.liquid_mass
    assert full > 6.0
    session.state = "Fire"  # on tanks nobody pressed
    for _ in range(4):
        session.step(0.25)
    assert fuel.state.liquid_mass <= full + 1e-9, "no liquid from the chamber"


@needs_le4
def test_each_check_fires_on_its_condition() -> None:
    ids = _ids()
    session = _session(True)
    session.state = "Armed"
    session.step(0.5)
    record = session.solver_log[-1]
    fuel = session.tanks[ids["Eth-Tank"]]

    watcher = Watcher()
    watcher.observe(session, record)
    assert not watcher.flags, "a stand at rest is clean"

    fuel.sealed, fuel.floored_kg = True, fuel.floored_kg + 1e-3
    branch = next(
        b
        for b in session.model.built.network.branches
        if b not in session._last_isolated
    )
    session._last_flows = {**session._last_flows, branch: INITIAL_FLOW}
    fuel.refused_kg += 1.0
    watcher.observe(session, replace(record, t=record.t + 0.5))
    checks = {f.check for f in watcher.flags}
    assert {"sealed_gain", "stuck_guess", "liquid_from_nowhere"} <= checks


def test_a_flag_is_an_episode() -> None:
    """Held for its hold before it opens; closed once gone for a second; one
    row however many ticks it lasts."""
    watcher = Watcher()
    held = _Seen("held_open", "Eth-Tank (gas)", "stuck", hold=2.0)
    for t in (0.0, 0.5, 1.0, 1.5):
        watcher._update(t, [held])
    assert not watcher.flags, "not yet held for two seconds"
    for t in (2.0, 2.5, 3.0):
        watcher._update(t, [held])
    assert len(watcher.flags) == 1 and watcher.flags[0].started == 0.0
    watcher._update(3.5, [])
    assert watcher.flags[0].open, "a tick off is not the end of it"
    watcher._update(3.0 + CLOSE_AFTER_S, [])
    assert not watcher.flags[0].open and watcher.flags[0].last == 3.0
    assert len(watcher.flags) == 1
