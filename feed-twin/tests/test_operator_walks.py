"""The stand driven the way people drive it, in every order they actually use.

One nominal sequence proves nothing about a state machine; operators back out
of states, vent and re-press, take a valve by hand, abort from the middle of a
press, and go round again. Each scenario here is a thing somebody does on the
pad, and each assertion is the physical consequence a person would look for on
the panel: a tank coming up to the dome, a vent emptying it in a second, a
bottle that keeps its gas when only the regulated manifold is vented, mains
that open on Fire and only on Fire (and on the aborts, because the table says
so). Every step is also checked against the table -- every commanded valve is
where the state says it is, unless a hand holds it -- and against sanity: no
NaN, nothing below vacuum, no inventory below zero.

Session-level rather than HTTP, so a walk of a few hundred steps runs in
seconds and the random walk can be long.
"""

from __future__ import annotations

import math
import random

import pytest

from backend.run import PSI, psig
from backend.session import Session
from tests.test_session import stand

DOME = 500.0
LOCKUP = DOME + 50.0  # the 1092-50's spring bias


# ------------------------------------------------------------------ driving


def go(session: Session, state: str) -> None:
    assert session.machine.can_go(session.state, state), (
        f"{session.state} -> {state} is not in the table; from here: "
        f"{sorted(session.machine.targets(session.state))}"
    )
    session.command_state(state)
    assert session.state == state


def run(session: Session, seconds: float, dt: float = 0.1) -> None:
    for _ in range(max(int(round(seconds / dt)), 1)):
        session.step(dt)
        check(session)


def tank(session: Session, key: str):
    return session.tanks[key]


def p_tank(session: Session, key: str) -> float:
    return psig(session.tanks[key].pressure)


def bottle(session: Session):
    return next(iter(session.bottles.values()))


def p_bottle(session: Session) -> float:
    return psig(bottle(session).pressure)


def chamber_psi(session: Session) -> float:
    chamber = session.history[-1].chamber
    return psig(chamber.pressure) if chamber is not None else 0.0


def flows(session: Session) -> dict[str, float]:
    return {k: v for k, v in session._last_flows.items() if abs(v) > 1e-9}


# ---------------------------------------------------------------- invariants


def check(session: Session) -> None:
    """What must be true after every single step, whatever the operator did."""
    sample = session.history[-1]
    for node, pa in sample.pressures.items():
        assert not math.isnan(pa), f"{node} is NaN"
        assert pa > 0.0, f"{node} below vacuum: {pa}"
    for key, sim in session.tanks.items():
        assert sim.state.liquid_mass >= 0.0, key
        assert sim.state.ullage.mass > 0.0, key
        assert 0.0 <= sim.tank.fill_fraction(sim.state) <= 1.0, key
    for key, b in session.bottles.items():
        assert b.state.mass > 0.0, key
    # Every commanded valve sits where the table says, unless a hand holds it.
    labels = {n.id: n.label for n in session.model.diagram.nodes}
    expected = session.binding.positions_for(session.machine, session.state)
    for symbol, want in expected.items():
        if symbol in session.forced:
            want = session.forced[symbol]
        got = sample.signals.get(f"{labels[symbol]}.command")
        assert (
            got == want
        ), f"{session.state}: {symbol} commanded {got}, table says {want}"


# ---------------------------------------------------------------- scenarios


def loaded(session: Session) -> None:
    """Idle -> both tanks loaded -> Press Standby, the way the panel does it."""
    go(session, "Armed")
    go(session, "Ox Fill")
    run(session, 6.0)
    assert tank(session, "OXT").state.liquid_mass > 10.0, "LOX should have loaded"
    assert tank(session, "FUT").state.liquid_mass == 0.0, "only the LOX tank fills"
    go(session, "Armed")
    go(session, "Fuel Fill")
    run(session, 6.0)
    assert (
        tank(session, "FUT").state.liquid_mass > 5.0
    ), "ethanol should have loaded (6.5 kg at 95%)"
    go(session, "Armed")
    go(session, "Press Standby")


def charged(session: Session) -> None:
    go(session, "GN2 High Press")
    run(session, 8.0)
    assert p_bottle(session) > 4300.0, f"bottle should be charged: {p_bottle(session)}"
    go(session, "Press Standby")


def pressed(session: Session) -> None:
    go(session, "Ox Press")
    run(session, 3.0)
    assert p_tank(session, "OXT") > LOCKUP - 10.0, p_tank(session, "OXT")
    go(session, "Press Standby")
    go(session, "Fuel Press")
    run(session, 3.0)
    assert p_tank(session, "FUT") > LOCKUP - 10.0, p_tank(session, "FUT")
    go(session, "Press Standby")


class TestTheNominalSequence:
    def test_cold_to_fire_lights_the_engine_and_burns_the_tanks(self) -> None:
        session = stand(engine=True)
        loaded(session)
        charged(session)
        pressed(session)
        go(session, "GN2 High Press")
        run(session, 2.0)
        go(session, "Calibrate")
        go(session, "Ready")
        run(session, 1.0)
        assert chamber_psi(session) < 5.0, "cold chamber before Fire"
        lox_before = tank(session, "OXT").state.liquid_mass
        go(session, "Fire")
        run(session, 2.0)
        f = flows(session)
        assert f.get("MVO", 0.0) > 0.5 and f.get("MVF", 0.0) > 0.3, f"mains: {f}"
        assert (
            chamber_psi(session) > 200.0
        ), f"the engine should light: {chamber_psi(session)}"
        assert (
            tank(session, "OXT").state.liquid_mass < lox_before - 1.0
        ), "LOX is burning"
        # And the regulator is holding the tanks up while it burns.
        assert p_tank(session, "OXT") > 350.0 and p_tank(session, "FUT") > 350.0

    def test_the_press_holds_at_lockup_while_the_solenoid_is_open(self) -> None:
        session = stand()
        loaded(session)
        charged(session)
        go(session, "Ox Press")
        run(session, 6.0)
        # Charge heating is over; the regulator keeps it at lockup.
        assert abs(p_tank(session, "OXT") - LOCKUP) < 8.0, p_tank(session, "OXT")

    def test_a_shut_press_solenoid_stops_the_regulator(self) -> None:
        """Press Standby shuts both press solenoids: nothing through PR_D."""
        session = stand()
        loaded(session)
        charged(session)
        pressed(session)
        run(session, 1.0)
        assert abs(flows(session).get("PR_D", 0.0)) < 1e-4, flows(session)


class TestVenting:
    def test_each_tank_vents_in_about_a_second_and_the_other_holds(self) -> None:
        session = stand()
        loaded(session)
        charged(session)
        pressed(session)
        fuel_before = p_tank(session, "FUT")
        go(session, "Ox Vent")
        run(session, 1.5)
        assert p_tank(session, "OXT") < 15.0, p_tank(session, "OXT")
        assert (
            p_tank(session, "FUT") > fuel_before - 40.0
        ), "the fuel tank is not venting"
        go(session, "Press Standby")
        go(session, "Fuel Vent")
        run(session, 1.5)
        assert p_tank(session, "FUT") < 15.0, p_tank(session, "FUT")

    def test_a_vented_tank_can_be_pressed_again(self) -> None:
        session = stand()
        loaded(session)
        charged(session)
        pressed(session)
        go(session, "Ox Vent")
        run(session, 1.5)
        go(session, "Press Standby")
        go(session, "Ox Press")
        run(session, 3.0)
        assert p_tank(session, "OXT") > LOCKUP - 10.0, "re-press after a vent"

    def test_vent_state_empties_both_tanks_and_spends_the_bottle(self) -> None:
        """The table's Vent opens both press solenoids *and* both tank vents,
        so the regulator feeds straight into the vents: the tanks empty and
        the bottle drains while it sits there. Faithful, and worth knowing."""
        session = stand()
        loaded(session)
        charged(session)
        pressed(session)
        go(session, "GN2 High Press")
        go(session, "Calibrate")
        go(session, "Ready")
        b0 = p_bottle(session)
        go(session, "Vent")
        run(session, 4.0)
        # A Cv 0.8 regulator against a 3/8 in vent: the tanks float at
        # ~100 psig with the bottle blowing through them, not at zero.
        assert p_tank(session, "OXT") < 200.0 and p_tank(session, "FUT") < 200.0
        assert (
            p_bottle(session) < b0 - 20.0
        ), "the regulator is blowing the bottle out the vents"
        assert flows(session).get("PR_D", 0.0) > 0.01

    def test_gn2_high_vent_bleeds_the_regulated_manifold_not_the_bottle(self) -> None:
        """GN2 Vent hangs off the press manifold on this drawing (and on the
        operator's own), downstream of the live regulator: opening it makes
        the regulator flow, and the bottle bleeds through the regulator at the
        regulator's pace rather than dumping. GN2 High Vent used to drain the
        bottle outright through a valve the table never opens there."""
        session = stand()
        loaded(session)
        charged(session)
        b0 = p_bottle(session)
        go(session, "GN2 High Vent")
        run(session, 1.0)
        assert flows(session).get("SV_GN2_VENT", 0.0) > 0.01, flows(session)
        assert (
            flows(session).get("PR_D", 0.0) > 0.01
        ), "the regulator is feeding the vent"
        # Through a Cv 0.8 regulator into a 1/4 in vent: a few hundred grams
        # a second, not the kilogram a second a direct dump would be. On a
        # 4.7 L COPV holding a kilogram and a half that is still most of the
        # bottle in five seconds -- so one second, and a floor of half.
        assert 0.5 * b0 < p_bottle(session) < b0, (b0, p_bottle(session))

    def test_gse_abort_vents_the_bottle_through_the_gse(self) -> None:
        session = stand()
        loaded(session)
        charged(session)
        b0 = p_bottle(session)
        go(session, "GSE Abort")
        run(session, 3.0)
        assert (
            p_bottle(session) < 0.8 * b0
        ), f"GSE High Press Vent dumps the bottle: {p_bottle(session)}"


class TestAborts:
    def test_engine_abort_from_fire_does_what_the_table_says(self) -> None:
        """The table opens both mains, both press and every vent in Engine
        Abort. The twin does that and the tanks empty through the engine and
        the vents; the only ways out are the other aborts."""
        session = stand(engine=True)
        loaded(session)
        charged(session)
        pressed(session)
        go(session, "GN2 High Press")
        go(session, "Calibrate")
        go(session, "Ready")
        go(session, "Fire")
        run(session, 1.0)
        go(session, "Engine Abort")
        assert sorted(session.machine.targets("Engine Abort")) == [
            "Emergency Abort",
            "GSE Abort",
        ]
        run(session, 3.0)
        assert p_tank(session, "OXT") < 300.0 and p_tank(session, "FUT") < 300.0

    def test_emergency_abort_then_idle_is_a_shut_cold_stand(self) -> None:
        session = stand()
        loaded(session)
        charged(session)
        pressed(session)
        go(session, "Emergency Abort")
        run(session, 3.0)
        go(session, "Idle")
        run(session, 2.0)
        assert session.machine.open_actuators("Idle") == frozenset()
        moving = {k: v for k, v in flows(session).items() if abs(v) > 1e-3}
        assert not moving, f"Idle has nothing open, nothing should move: {moving}"

    def test_aborts_are_reachable_mid_press_and_mid_fill(self) -> None:
        session = stand()
        go(session, "Armed")
        go(session, "Ox Fill")
        run(session, 1.0)
        go(session, "Emergency Abort")
        run(session, 1.0)
        go(session, "GSE Abort")
        go(session, "Armed")
        go(session, "Press Standby")
        go(session, "GN2 High Press")
        run(session, 2.0)
        go(session, "Engine Abort")
        run(session, 1.0)


class TestHandControl:
    def test_a_vent_held_open_by_hand_defeats_the_press_until_released(self) -> None:
        session = stand()
        loaded(session)
        charged(session)
        session.set_valve("SV_LOX_VENT", True)
        go(session, "Ox Press")
        # A transition takes the table's valves back -- so hold it *after*.
        session.set_valve("SV_LOX_VENT", True)
        run(session, 3.0)
        assert (
            p_tank(session, "OXT") < LOCKUP - 100.0
        ), "a 3/8 in vent beats a Cv 0.8 regulator"
        session.release("SV_LOX_VENT")
        run(session, 3.0)
        assert p_tank(session, "OXT") > LOCKUP - 10.0, "released, the tank comes up"

    def test_a_main_held_shut_is_taken_back_by_fire(self) -> None:
        """The report: Fire opened no mains. A hold no longer outlives the
        transition, so Fire commands the mains whatever the hand did in
        Ready."""
        session = stand(engine=True)
        loaded(session)
        charged(session)
        pressed(session)
        go(session, "GN2 High Press")
        go(session, "Calibrate")
        go(session, "Ready")
        session.set_valve("MVO", False)
        session.set_valve("MVF", False)
        run(session, 0.5)
        go(session, "Fire")
        run(session, 2.0)
        assert "MVO" not in session.forced and "MVF" not in session.forced
        assert flows(session).get("MVO", 0.0) > 0.5, flows(session)
        assert chamber_psi(session) > 200.0

    def test_an_uncommanded_valve_keeps_the_hands_position(self) -> None:
        session = stand()
        assert "PR_C" in session.binding.uncommanded
        session.set_valve("PR_C", False)
        go(session, "Armed")
        go(session, "Press Standby")
        assert session.forced.get("PR_C") == 0.0


class TestIgnitionPathsTheTableAllows:
    def test_fire_straight_from_ox_press_lights_because_the_table_lets_it(self) -> None:
        """One of the seven bypasses. The twin allows it, warns, and it burns
        -- the stand would do the same, which is the point of the warning."""
        session = stand(engine=True)
        loaded(session)
        charged(session)
        go(session, "Ox Press")
        run(session, 3.0)
        go(session, "Press Standby")
        go(session, "Fuel Press")
        run(session, 3.0)
        assert "Fuel Press -> Fire is permitted" in "\n".join(session.machine.warnings)
        go(session, "Fire")
        run(session, 2.0)
        assert chamber_psi(session) > 200.0

    def test_fire_with_unpressed_tanks_is_a_weak_start(self) -> None:
        session = stand(engine=True)
        loaded(session)
        charged(session)
        go(session, "GN2 High Press")
        go(session, "Calibrate")
        go(session, "Ready")
        unpressed = max(p_tank(session, "OXT"), p_tank(session, "FUT"))
        assert unpressed < 150.0, unpressed
        go(session, "Fire")
        run(session, 0.1)
        # Fire opens the press solenoids too, so the tanks come up *during*
        # the start rather than before it. On 0.4-0.75 L ullages that takes
        # well under a second, so the starved start is the first tick or two.
        starved = chamber_psi(session)
        run(session, 1.9)
        settled = chamber_psi(session)
        assert settled > 300.0, settled
        assert starved < 0.8 * settled, (starved, settled)


class TestGoingRoundAgain:
    def test_press_standby_round_trips_do_not_leak_anything(self) -> None:
        """Ox Press -> Press Standby -> Fuel Press -> Press Standby, twice.
        A shut tank keeps every gram it was given: what moves its pressure
        is heat (charge heating decaying, collapse onto a cryogen), never
        gas leaving. So the leak test is on mass, not on pressure."""
        session = stand()
        loaded(session)
        charged(session)
        for _ in range(2):
            pressed(session)
            held = {key: tank(session, key).state.ullage.mass for key in ("OXT", "FUT")}
            run(session, 5.0)
            for key in ("OXT", "FUT"):
                now = tank(session, key).state.ullage.mass
                assert now == pytest.approx(held[key], rel=1e-3), (key, held[key], now)
                assert p_tank(session, key) > 300.0, (key, p_tank(session, key))
            assert abs(flows(session).get("PR_D", 0.0)) < 1e-4

    def test_vent_then_reload_then_press_again(self) -> None:
        session = stand()
        loaded(session)
        charged(session)
        pressed(session)
        go(session, "GN2 High Press")
        go(session, "Calibrate")
        go(session, "Ready")
        go(session, "Vent")
        run(session, 3.0)
        # Vent blew the regulator through the tank vents for three seconds,
        # which on a 4.7 L COPV is most of the bottle: charge it again before
        # asking it to press anything, as the pad would.
        go(session, "Armed")
        go(session, "Ox Fill")
        run(session, 2.0)
        go(session, "Armed")
        go(session, "Press Standby")
        go(session, "GN2 High Press")
        run(session, 8.0)
        go(session, "Press Standby")
        go(session, "Ox Press")
        run(session, 3.0)
        assert p_tank(session, "OXT") > LOCKUP - 10.0


def test_a_long_random_walk_over_the_table_stays_physical() -> None:
    """Two hundred legal moves, holding each state for a moment, with the
    invariants checked after every step. Not a physics test; the test that
    nothing an operator can click leaves the twin in a state it cannot
    integrate."""
    session = stand(engine=True)
    rng = random.Random(2026)
    converged = total = 0
    for _ in range(200):
        targets = sorted(session.machine.targets(session.state))
        # Aborts are always there; weight the rest so the walk goes places.
        others = [t for t in targets if "abort" not in t.lower()]
        target = (
            rng.choice(others) if others and rng.random() < 0.9 else rng.choice(targets)
        )
        go(session, target)
        for _ in range(rng.choice((1, 3, 6))):
            session.step(0.2)
            check(session)
            total += 1
            converged += session.history[-1].converged
    assert converged / total > 0.95, f"only {converged}/{total} steps converged"
