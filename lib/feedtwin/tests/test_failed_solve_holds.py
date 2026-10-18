"""A failed network solve holds the stand; it does not move it.

``solve_steady(raise_on_failure=False)`` hands back wherever Newton stopped.
That iterate closes no node balance, so a vessel integrated on it gains or loses
propellant no path carried, and a gauge reading it shows a pressure nothing
holds. Through a failed solve the session keeps the last converged flows and
pressures; right after the circuit changes, when no converged answer for the
new circuit exists yet, it moves nothing.

Driven by failing the solve on purpose: its real answer, reported as not
converged, with the flows or the free nodes' pressures scaled -- once a solve
has not converged, one iterate is as good as another. Both tests go red on the
session that integrated the iterate (``flows = self._last_flows or
dict(result.flows)``, and ``result.pressures`` into the step and the frame).
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest
from test_press_path_coupling import _helium_stand

from feedtwin.session import Session, core


def _break(
    monkeypatch: pytest.MonkeyPatch,
    session: Session,
    *,
    flows: float = 1.0,
    pressures: float = 1.0,
) -> None:
    """Every solve from here fails, its flows and free pressures scaled."""
    nodes = session.model.built.network.nodes
    real = core.solve_steady

    def failed(*args: Any, **kwargs: Any) -> Any:
        result = real(*args, **kwargs)
        return replace(
            result,
            converged=False,
            flows={b: f * flows for b, f in result.flows.items()},
            pressures={
                n: p if nodes[n].is_fixed else p * pressures
                for n, p in result.pressures.items()
            },
        )

    monkeypatch.setattr(core, "solve_steady", failed)


def test_mains_opening_onto_a_failed_solve_move_no_propellant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ready -> Fire is a new circuit: the last flows are dropped, and a solve
    that then fails has nothing converged to hold. The tanks stay put."""
    session = _helium_stand()
    for _ in range(5):
        session.step(0.02)
    liquid = {k: sim.state.liquid_mass for k, sim in session.tanks.items()}
    gas = {k: b.state.mass for k, b in session.bottles.items()}

    _break(monkeypatch, session, flows=50.0)
    session.set_valve("FM", True)
    session.set_valve("OM", True)
    sample = session.step(0.02)

    assert not sample.converged
    assert "FM" not in session._last_isolated, "the mains opened: a new circuit"
    for k, sim in session.tanks.items():
        # The iterate drained ~1 kg here: a burn's flow, fifty times over.
        assert sim.state.liquid_mass == pytest.approx(liquid[k], abs=1e-4), k
    for k, bottle in session.bottles.items():
        assert bottle.state.mass == pytest.approx(gas[k], abs=1e-9), k
    assert session.solver_log[-1].mass_error_kg == pytest.approx(0.0, abs=1e-9)

    # A hold, not a stall: once the solve converges the tanks drain.
    monkeypatch.undo()
    for _ in range(5):
        session.step(0.02)
    assert session.history[-1].converged
    for k, sim in session.tanks.items():
        assert sim.state.liquid_mass < liquid[k] - 1e-3, k


def test_a_failed_tick_acts_on_and_shows_the_last_converged_pressures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a good solve behind it a failed tick holds that solve's flows, and
    its pressures with them -- into the tank's supply clip, the frame, and the
    value a trapped leg will later be held at."""
    session = _helium_stand()
    session.set_valve("FP", True)
    session.set_valve("OP", True)
    for _ in range(10):
        session.step(0.02)
    assert session.history[-1].converged
    manifold = session.history[-1].pressures["MF"]

    acted: list[float] = []
    real_move = session._move_vessels

    def spy(flows, pressures, *rest):  # type: ignore[no-untyped-def]
        acted.append(pressures["MF"])
        return real_move(flows, pressures, *rest)

    monkeypatch.setattr(session, "_move_vessels", spy)
    _break(monkeypatch, session, pressures=3.0)
    sample = session.step(0.02)

    assert not sample.converged
    assert acted and all(p == pytest.approx(manifold, rel=1e-12) for p in acted)
    assert sample.pressures["MF"] == pytest.approx(manifold, rel=1e-12)
    assert session._trapped["MF"] == pytest.approx(manifold, rel=1e-12)
