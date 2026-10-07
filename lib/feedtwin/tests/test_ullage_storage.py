"""An ullage is solved with the network, not held at its start-of-step pressure.

A 0.41 L ullage behind a Cv 4 press solenoid moves a psi on about two grams,
and the solenoid passes a hundred grams a second on that psi. Held fixed for a
coupling step, two such tanks on one manifold flip-flopped: one a few psi high
dumping into the manifold, the other taking 100 g/s and refusing nearly all of
it at its supply clip, while the regulator drooped at a phantom 60 g/s that no
vessel ever kept. LE4's pair sat 25 psi under lockup for as long as the press
valves were held open, and Ox Press topped out near 455 psig in a cockpit walk.

``solve_steady(storage=...)`` makes the ullage an unknown with a backward-Euler
storage term; ``Session._ullage_storage`` reads the term off the vessel.
"""

from __future__ import annotations

import pytest
from test_press_path_coupling import _helium_stand
from test_solve_steady import _valve

from feedtwin.session import core as C
from feedtwin.session.burn import press_valves
from feedtwin.session.gauge import psig
from feedtwin.solve import Network, solve_steady


def _gas_line() -> Network:
    net = Network()
    net.add_node("supply", "helium", 293.0, pressure=40.0e5)
    net.add_node("tank", "helium", 293.0, pressure=38.0e5)
    net.add_branch("SOL", _valve("SOL", 4.0), "supply", "tank")  # type: ignore[arg-type]
    return net


def test_a_stored_node_lands_where_its_inflow_puts_it() -> None:
    net = _gas_line()
    fixed = solve_steady(net)
    admittance, reference = 1.0e-6, 38.0e5  # kg/s per Pa: ~7 g/s a psi
    stored = solve_steady(net, storage={"tank": (admittance, reference)})

    assert stored.converged
    p, flow = stored.pressures["tank"], stored.flows["SOL"]
    assert flow == pytest.approx(admittance * (p - reference), rel=1e-6)
    assert stored.max_mass_residual < 1e-9
    # The vessel rises toward its supply, so less flows than into a wall.
    assert reference < p < 40.0e5
    assert 0.0 < flow < fixed.flows["SOL"]
    # The boundary the network was built with is untouched.
    assert net.nodes["tank"].pressure == 38.0e5


def test_storage_on_a_cut_off_node_changes_nothing() -> None:
    net = _gas_line()
    shut = {"SOL.command": 0.0}
    plain = solve_steady(net, signals=shut)
    stored = solve_steady(net, signals=shut, storage={"tank": (1.0e-6, 30.0e5)})
    assert stored.pressures == plain.pressures
    assert stored.flows == plain.flows


def _hold(seconds: float = 1.5) -> tuple[C.Session, list[float], float, float]:
    """Pad hold with both press valves open: the LOX ullage collapsing, the
    mains shut. Returns the session, the tank spread over the last half, and
    the gas the bottle gave and the ullages kept over the whole hold [kg]."""
    session = _helium_stand()
    for symbol in press_valves(session):
        session.set_valve(symbol, True)

    def bottles() -> float:
        return sum(b.state.mass for b in session.bottles.values())

    def ullages() -> float:
        return sum(
            s.state.ullage.mass + s.state.vapour_mass for s in session.tanks.values()
        )

    gave, kept = bottles(), ullages()
    spread = []
    while session.t < seconds:
        session.step(0.05)
        if session.t > seconds / 2:
            p = [psig(s.pressure) for s in session.tanks.values()]
            spread.append(max(p) - min(p))
    return session, spread, gave - bottles(), ullages() - kept


def test_two_tanks_held_at_lockup_sit_on_it() -> None:
    session, spread, gave, kept = _hold()
    pressures = [psig(s.pressure) for s in session.tanks.values()]
    # 560 psi regulator, 20 psi droop at 20 g/s: a few g/s of collapse
    # costs it a few psi, and nothing else should.
    assert all(555.0 < p < 561.0 for p in pressures), pressures
    assert max(spread) < 0.5
    # What the bottle gives is what the ullages keep, less the little the
    # LOX boils into its own ullage. The flip-flop had the regulator passing
    # sixty times what any vessel kept, and handing the rest back.
    assert 0.0 < gave <= kept
    assert gave == pytest.approx(kept, rel=0.1)


def test_and_without_storage_the_pair_flip_flops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(C.Session, "_ullage_storage", lambda *a: {})
    _, spread, _, _ = _hold()
    assert max(spread) > 20.0
