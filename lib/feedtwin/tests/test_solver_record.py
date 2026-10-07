"""The solver tab's record (feedtwin.session.diagnostics): residuals per tick, and a
mass balance that a leak cannot hide from.

Checked against conservation itself: through a press and a burn, everything the
vessels gained or lost is either what crossed the boundary (engine, vents, the
built-in loads) or what the vessels' own guards booked -- to rounding. And the
check can fail: a bottle that quietly loses gas shows up as unexplained mass.
"""

from __future__ import annotations

import pytest
from test_press_path_coupling import _helium_stand
from test_session_burn import TABLES, _model, needs_engine, needs_stand

from feedtwin.session.burn import press_valves
from feedtwin.session.core import BottleSim


def _press_and_burn():  # type: ignore[no-untyped-def]
    session = _helium_stand()
    for valve in press_valves(session):
        session.set_valve(valve, True)
    for _ in range(25):
        session.step(0.02)
    for symbol, signal in session.model.built.actuators.items():
        if not signal.endswith(".dome"):
            session.set_valve(symbol, True)
    for _ in range(50):
        session.step(0.02)
    return session


def test_every_tick_is_recorded_and_converged() -> None:
    session = _press_and_burn()
    log = list(session.solver_log)
    assert len(log) == 75
    assert all(r.converged for r in log)
    assert all(r.couplings >= 1 and r.iterations >= r.couplings for r in log)
    assert max(r.residual for r in log) < 1e-3


def test_the_mass_that_moved_is_the_mass_that_crossed_or_was_guarded() -> None:
    session = _press_and_burn()
    last = session.solver_log[-1]
    assert last.crossed_out_kg > 1.0, "the mains drained the tanks"
    # Everything not explained by the boundary is the guards' own booking.
    assert last.mass_error_kg == pytest.approx(last.guard_kg, abs=1e-9)
    assert abs(last.mass_error_kg) < 1e-4 * last.throughput_kg


def test_a_leak_shows_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """The check can fail: a bottle that loses a milligram a step it books
    nowhere is mass the balance cannot explain."""
    real = BottleSim.advance

    def leaky(self, dt, **kw):  # type: ignore[no-untyped-def]
        real(self, dt, **kw)
        self.state = type(self.state)(
            mass=self.state.mass - 1e-6,
            energy=self.state.energy,
            wall_temperature=self.state.wall_temperature,
        )

    monkeypatch.setattr(BottleSim, "advance", leaky)
    session = _press_and_burn()
    last = session.solver_log[-1]
    assert abs(last.mass_error_kg - last.guard_kg) > 1e-4


@needs_stand
@needs_engine
def test_the_chamber_closure_is_recorded_below_its_tolerance() -> None:
    from feedtwin.session import load_machine
    from feedtwin.session.burn import BurnPlan, burn_setup, open_session, run_burn

    session = open_session(
        _model(engine=True), load_machine(tables=TABLES), setup=burn_setup()
    )
    run_burn(
        session,
        BurnPlan(
            tank_psi=550.0,
            loads={"OXT": 6.0, "FUT": 4.0},
            settle=False,
            lead_in_s=0.1,
            horizon_s=0.3,
        ),
    )
    firing = [r for r in session.solver_log if r.chamber_residual_psi > 0.0]
    assert firing, "the chamber closure was recorded"
    tolerance = session.setup.chamber_tolerance_psi
    assert max(r.chamber_residual_psi for r in firing[1:]) <= tolerance * 1.0001
