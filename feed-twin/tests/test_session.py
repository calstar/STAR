"""The stand as a thing that exists in time.

These are the properties that make it a simulator rather than a calculator with
a state label on it, and every one of them was false at some point:

* nothing is pressurised or loaded until somebody does it;
* a state commands valves, and the valves decide what happens next tick;
* pressing one tank does not press the other;
* firing consumes propellant, and the tanks droop while it does;
* venting puts it back.

They run the real shipped stand and the real DAQ state tables, because a
simulator that only behaves on a fixture is not evidence of anything.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.assembly import assemble
from backend.library import Library
from backend.run import PSI
from backend.session import AMBIENT, Session, Setup
from backend.statemachine import bind, load_machine

CEA = (
    Path(__file__).resolve().parents[2]
    / "EngineDesign"
    / "output"
    / "cache"
    / "cea_cache_LOX_Ethanol_3D.npz"
)


#: The shipped stand and the ethalox engine, put into the (temporary) test
#: library once. The app seeds these when backend.main imports; these tests do
#: not import it, so they seed for themselves rather than depending on whichever
#: test happened to run first.
_SEEDED: dict[str, str] = {}


def _seed() -> dict[str, str]:
    if _SEEDED:
        return _SEEDED
    import json

    from backend.assembly import diagram_summary

    library = Library()
    drawing = Path(__file__).resolve().parents[1] / "backend" / "diagrams"
    data = (drawing / "ethalox_stand.json").read_bytes()
    artifact, _ = library.add(
        data,
        kind="diagram",
        name="Ethalox Stand",
        source="shipped:ethalox_stand.json",
        suffix=".json",
        summary=diagram_summary(json.loads(data)),
    )
    _SEEDED["diagram"] = artifact.id

    config = (
        Path(__file__).resolve().parents[2]
        / "EngineDesign"
        / "configs"
        / "ethalox_doublet_7000N.yaml"
    )
    if config.exists():
        motor, _ = library.add(
            config.read_bytes(),
            kind="engine",
            name="ethalox doublet 7000N",
            source="shipped",
            suffix=".yaml",
        )
        _SEEDED["engine"] = motor.id
    return _SEEDED


def stand(*, engine: bool = False, **setup: float) -> Session:
    """A stand for testing the *plumbing*: thermally quiet by default.

    The cockpit's own defaults leak heat into the tanks and let a warm wall
    boil what it touches, and a LOX tank the helper loads in five seconds is
    a 293 K wall on 90 K liquid -- it runs to the oxygen critical pressure
    the moment its vent shuts. Physics, and tested as such below; but a test
    about which valve a state opens should not have its tank climbing to 700
    psig in the background. Pass the knobs to get the real thing.
    """
    # No wall-clock budget either: under load the cockpit folds the coupling
    # steps it has no time for into one, which is right for a panel and
    # wrong for a test, whose answer must not depend on what else the machine
    # was doing.
    setup = {"chilldown": 0.0, "ambient_leak": 0.0, "tick_budget": 1e9, **setup}
    seeded = _seed()
    library = Library()
    diagram = library.get(seeded["diagram"])
    motor = library.get(seeded["engine"]) if "engine" in seeded else None
    model = assemble(
        library,
        diagram.id,
        engine_id=motor.id if (engine and motor) else "",
        cea_cache=str(CEA) if CEA.exists() else "",
    )
    machine = load_machine()
    labels = {
        n.id: n.label for n in model.diagram.nodes if n.id in model.built.actuators
    }
    return Session(
        model,
        machine,
        bind(machine, labels),
        setup=Setup(copv_fill_s=5.0, tank_fill_s=5.0, fuel_fill_s=5.0, **setup),  # type: ignore[arg-type]
    )


def hold(session: Session, state: str, seconds: float, dt: float = 0.2) -> None:
    session.state = state
    for _ in range(max(int(seconds / dt), 1)):
        session.step(dt)


def psi(pa: float) -> float:
    return pa / PSI


# --------------------------------------------------------------- cold stand


def test_everything_starts_empty_and_at_atmosphere() -> None:
    """A stand that opens already loaded and pressurised skips the part where
    somebody has to decide to do it, which is the part being rehearsed."""
    session = stand()
    session.step(0.01)
    for tank in session.tanks.values():
        assert psi(tank.pressure) == pytest.approx(14.7, abs=1.0)
        assert tank.state.liquid_mass == 0.0
    for bottle in session.bottles.values():
        assert psi(bottle.pressure) == pytest.approx(14.7, abs=2.0)


def test_a_shut_stand_solves_rather_than_erroring() -> None:
    """Armed shuts the whole panel. That is where a stand spends most of its
    life and it must not be an error."""
    session = stand()
    hold(session, "Armed", 1.0)
    assert session.history[-1].converged


# ------------------------------------------------------------------- filling


def test_the_copv_fills_to_the_target_it_was_given() -> None:
    session = stand(copv_target_psi=3200.0)
    hold(session, "GN2 High Press", 12.0)
    bottle = next(iter(session.bottles.values()))
    assert psi(bottle.pressure) == pytest.approx(3200.0, rel=0.05)


def test_the_copv_target_is_settable() -> None:
    low = stand(copv_target_psi=1500.0)
    hold(low, "GN2 High Press", 12.0)
    high = stand(copv_target_psi=4500.0)
    hold(high, "GN2 High Press", 12.0)
    assert (
        psi(next(iter(high.bottles.values())).pressure)
        > psi(next(iter(low.bottles.values())).pressure) + 2000.0
    )


def test_filling_a_tank_loads_it_and_leaves_the_other_alone() -> None:
    session = stand()
    hold(session, "Ox Fill", 12.0)
    assert session.tanks["OXT"].state.liquid_mass > 10.0
    assert session.tanks["FUT"].state.liquid_mass == 0.0


def test_a_tank_vents_while_it_fills() -> None:
    """Ox Fill opens the LOX vent. Without it the incoming liquid compresses the
    ullage to hundreds of psi, which is why the vent is in the table. With
    the wall boiling the LOX it meets (the helper loads a warm tank in five
    seconds), the vent is passing tens of grams a second and the tank sits a
    few tens of psi up -- still nowhere near a shut tank."""
    session = stand()
    hold(session, "Ox Fill", 12.0)
    assert psi(session.tanks["OXT"].pressure) - 14.7 < 100.0
    assert (
        session._last_flows.get("SV_LOX_VENT", 0.0) > 5.0e-3
    ), "the vent is carrying boil-off"


# ---------------------------------------------------------------- pressing


def _loaded(engine: bool = False) -> Session:
    session = stand(engine=engine)
    hold(session, "Ox Fill", 10.0)
    hold(session, "Fuel Fill", 10.0)
    hold(session, "Press Standby", 1.0)
    hold(session, "GN2 High Press", 12.0)
    hold(session, "Press Standby", 1.0)
    return session


def test_pressing_one_tank_leaves_the_other_at_atmosphere() -> None:
    """The whole point of separate press states. Getting this wrong is what
    made the old build feel like a magic Fire button."""
    session = _loaded()
    hold(session, "Fuel Press", 10.0)
    assert psi(session.tanks["FUT"].pressure) > 300.0
    assert psi(session.tanks["OXT"].pressure) < 60.0
    assert (
        abs(session._last_flows.get("SV_LOX_PRESS", 0.0)) < 1e-4
    ), "nothing pressed the LOX tank"

    hold(session, "Press Standby", 1.0)
    hold(session, "Ox Press", 10.0)
    assert psi(session.tanks["OXT"].pressure) > 300.0


def test_a_pressed_tank_holds_when_the_valve_shuts() -> None:
    session = _loaded()
    hold(session, "Fuel Press", 10.0)
    pressed = psi(session.tanks["FUT"].pressure)
    hold(session, "Press Standby", 4.0)
    assert psi(session.tanks["FUT"].pressure) == pytest.approx(pressed, rel=0.15)


def test_the_dome_setting_decides_where_a_tank_lands() -> None:
    low = _loaded()
    low.setup.dome_psi = 300.0
    hold(low, "Fuel Press", 12.0)

    high = _loaded()
    high.setup.dome_psi = 500.0
    hold(high, "Fuel Press", 12.0)

    assert psi(high.tanks["FUT"].pressure) > psi(low.tanks["FUT"].pressure) + 100.0


def test_venting_puts_a_pressed_tank_back_to_atmosphere() -> None:
    session = _loaded()
    hold(session, "Fuel Press", 10.0)
    assert psi(session.tanks["FUT"].pressure) > 300.0
    hold(session, "Press Standby", 1.0)
    hold(session, "Fuel Vent", 10.0)
    assert psi(session.tanks["FUT"].pressure) < 60.0


# -------------------------------------------------------------------- firing


@pytest.mark.skipif(not CEA.exists(), reason="the ethalox CEA table is absent")
def test_firing_burns_propellant_at_a_sensible_mixture_ratio() -> None:
    session = _loaded(engine=True)
    hold(session, "Fuel Press", 10.0)
    hold(session, "Press Standby", 1.0)
    hold(session, "Ox Press", 10.0)
    hold(session, "Press Standby", 1.0)
    hold(session, "Ready", 1.0)

    ox_before = session.tanks["OXT"].state.liquid_mass
    fuel_before = session.tanks["FUT"].state.liquid_mass
    hold(session, "Fire", 4.0)
    chamber = session.history[-1].chamber
    assert chamber is not None

    # An ethalox stand at ~500 psi tanks lands here. Wide bounds on purpose:
    # this is asserting "a rocket engine", not a specific design point.
    assert 150.0 < psi(chamber.pressure) < 600.0
    assert 1.2 < chamber.mixture_ratio < 3.5
    assert 0.5 < chamber.mdot_total < 6.0
    assert chamber.thrust > 1000.0
    assert 180.0 < chamber.specific_impulse < 320.0

    # And it came out of the tanks, in the ratio the chamber reports.
    ox_used = ox_before - session.tanks["OXT"].state.liquid_mass
    fuel_used = fuel_before - session.tanks["FUT"].state.liquid_mass
    assert ox_used > 0.0 and fuel_used > 0.0
    assert ox_used / fuel_used == pytest.approx(chamber.mixture_ratio, rel=0.25)


@pytest.mark.skipif(not CEA.exists(), reason="the ethalox CEA table is absent")
def test_firing_droops_the_tanks_and_the_bottle() -> None:
    session = _loaded(engine=True)
    hold(session, "Fuel Press", 10.0)
    hold(session, "Press Standby", 1.0)
    hold(session, "Ox Press", 10.0)
    hold(session, "Ready", 1.0)

    bottle = next(iter(session.bottles.values()))
    before = (
        psi(session.tanks["OXT"].pressure),
        psi(bottle.pressure),
    )
    hold(session, "Fire", 4.0)
    after = (psi(session.tanks["OXT"].pressure), psi(bottle.pressure))
    assert after[0] < before[0], "a tank being drawn from must droop"
    assert after[1] < before[1], "the bottle gives that pressure up"


def test_a_tank_cannot_deliver_what_it_does_not_have() -> None:
    """Without this the solver happily draws propellant out of an empty vessel
    and the mains keep flowing after the tank is dry."""
    session = stand()
    hold(session, "Ox Fill", 1.0)
    hold(session, "Press Standby", 1.0)
    hold(session, "GN2 High Press", 12.0)
    hold(session, "Ox Press", 6.0)
    hold(session, "Fire", 20.0)
    assert session.tanks["OXT"].state.liquid_mass >= 0.0
    assert session.tanks["OXT"].empty or session.tanks["OXT"].state.liquid_mass > 0.0


# ------------------------------------------------------------ hand control


def test_a_valve_taken_by_hand_beats_the_state() -> None:
    session = stand()
    hold(session, "Armed", 0.5)
    session.set_valve("SV_LOX_VENT", True)
    session.step(0.1)
    assert session.history[-1].signals["SV-LOX-VENT.command"] == 1.0

    session.release("SV_LOX_VENT")
    session.step(0.1)
    assert session.history[-1].signals["SV-LOX-VENT.command"] == 0.0


def test_an_illegal_transition_is_refused() -> None:
    session = stand()
    with pytest.raises(PermissionError):
        session.command_state("Fire")


def test_an_abort_is_always_allowed() -> None:
    session = stand()
    session.command_state("Emergency Abort")
    assert session.state == "Emergency Abort"


# ------------------------------------------------------------------ timing


def test_a_tick_is_fast_enough_to_feel_live() -> None:
    """A cockpit that stutters is not a cockpit. The median is what an operator
    feels; the one hard instant is allowed to run slow, and only that one.

    The console runs the study's numerics (``LIVE_STEP``, no wall-clock
    budget): a wide-open regulator into a 0.43 L fuel ullage asks for
    hundreds of coupling steps in the tick that crosses lockup, and nothing
    folds them any more -- that tick takes about 1.5 s of wall time for 0.2 s
    of stand time, and the top bar says so. Everything after it, sitting at
    lockup with a 20 g ullage whose regulator-ullage time constant is ~14 ms,
    is fifteen coupling solves per 200 ms panel tick: what the ullage costs,
    not slack. Bounded here so a regression that makes *every* tick slow, or
    the crossing pathological, is caught; the crossing itself is not a bug.
    """
    import time

    session = _loaded()
    assert session.setup.tick_budget == Setup().tick_budget, "the cockpit has no fold"
    session.state = "Fuel Press"
    times = []
    for _ in range(40):
        started = time.perf_counter()
        session.step(0.2)
        times.append(time.perf_counter() - started)
    slow = [t for t in times if t > 0.5]
    times.sort()
    # 0.14 s with a well-mixed liquid; the stratified LOX surface answers the
    # pressurant faster and buys more coupling steps, ~0.21 s. The panel ticks
    # every 200 ms, so a press runs at about real time, not in slow motion.
    assert times[len(times) // 2] < 0.25, f"median tick {times[len(times) // 2]:.3f}s"
    assert (
        len(slow) <= 2
    ), f"{len(slow)} ticks over 0.5 s; only the lockup crossing may be"
    assert times[-1] < 2.5, f"worst tick {times[-1]:.3f}s"


# ------------------------------------------------- pressurant is conserved


def test_a_tank_reports_the_gas_it_refuses() -> None:
    """Whatever a tank will not take, it must say so, in kg/s.

    A tank stops accepting gas once it has caught up with what is feeding it,
    because the network solved that flow at the pressure the tick *started*
    from. The bottle, though, was debited for it by the same solve -- so unless
    the refusal comes back as a number the caller can credit, every refused
    sub-step destroys mass.

    It destroyed a lot. The reference a tank compares itself against is the
    node next door, which in a converged solve sits above it by exactly the
    line loss between them; on a short, fat helium press line that is a psi or
    two, so any sub-step that put gas in crossed it. Fill, cross, refuse, drain
    back, fill -- a relay at exactly half duty, losing 50.0% of the pressurant
    while looking perfectly steady. Helium lost half its bottle to it and the
    study that found it blamed the gas.

    Checked on the vessel rather than through a run: the stands that ship here
    have enough line loss to keep a tank clear of its supply, so a whole-stand
    test passes with the bug in place. That is exactly how it survived.
    """
    session = stand(dome_psi=500.0)
    session.prime(fill_fraction=0.95, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    sim = next(iter(session.tanks.values()))
    supply = sim.pressure * 0.5  # tank is well past whatever is feeding it
    before = sim.state.ullage.mass

    refused = sim.advance(
        0.01,
        mdot_liquid_out=0.0,
        mdot_gas_in=0.05,
        mdot_gas_out=0.0,
        enthalpy_gas_in=3.0e5,
        supply_pressure=supply,
    )
    assert refused == pytest.approx(0.05), "a refusal that is not reported is a leak"
    assert sim.state.ullage.mass == pytest.approx(before), "it took gas it refused"

    # And the other way: with room to take it, nothing is refused and it lands.
    taken = sim.advance(
        0.01,
        mdot_liquid_out=0.0,
        mdot_gas_in=0.05,
        mdot_gas_out=0.0,
        enthalpy_gas_in=3.0e5,
        supply_pressure=sim.pressure * 2.0,
    )
    assert taken == 0.0
    assert sim.state.ullage.mass == pytest.approx(before + 0.05 * 0.01, rel=1e-6)


# --------------------------------------------- the coupling resolves the loop


def test_the_coupling_step_resolves_the_regulator_ullage_time_constant() -> None:
    """The regulator and the ullage it feeds are an RC pair, and an explicit
    scheme that steps past their time constant does what explicit schemes do:
    overshoot, overcorrect, and fill the trace with tick-rate noise.

    That noise cost a study its conclusion. At a 10 ms tick a helium tank
    swung 27 psi tick to tick and read *below* nitrogen; at 2 ms it sat
    twenty psi above it, steady to a psi. The physics was right and the
    integration was wrong, and the two are indistinguishable on a plot.

    So the count of coupling steps must come from the time constant -- capacitance
    ``C = m / p`` of the smallest ullage times the regulator slope
    ``droop / rated_flow`` -- and not only from how far the vessels happened to
    move last tick, which reacts to motion after it has already gone wrong.
    """
    session = stand(dome_psi=500.0)
    session.prime(fill_fraction=0.95, tank_psi=550.0, copv_psi=4500.0, state="Ready")

    tau = session._coupling_timescale()
    assert tau > 0.0, "a stand with a droop regulator has a time constant"

    # The analytic value, from the same quantities the session can see.
    slope = min(
        c.p["flow_droop"] / c.p["rated_flow"]
        for br in session.model.built.network.branches.values()
        for c in [getattr(br, "component", None)]
        if c is not None
        and "Regulator" in type(c).__name__
        and c.p.get("rated_flow", 0) > 0
    )
    capacitance = min(
        sim.state.ullage.mass / sim.pressure for sim in session.tanks.values()
    )
    assert tau == pytest.approx(capacitance * slope, rel=1e-9)

    # And a tick longer than that constant is split so no step exceeds
    # COUPLING_SAFETY of it. Counted by intercepting the inner advance.
    from backend import session as mod

    dt = 20.0 * tau
    calls: list[float] = []
    original = session._advance_once

    def counting(net, signals, inner):  # type: ignore[no-untyped-def]
        calls.append(inner)
        return original(net, signals, inner)

    session._advance_once = counting  # type: ignore[method-assign]
    session.setup.tick_budget = 1e9  # the study setting: never fold
    session.step(dt)
    assert calls, "the tick took no coupling steps"
    # A literal, deliberately. An earlier version compared against the module's
    # own COUPLING_SAFETY and so passed no matter what that constant was set to
    # -- a test that moves its goalposts with the code it guards.
    #
    # One tau is the *measured* bound, not a round number: sweeping the step
    # over a burn, tank pressure is flat to within run-to-run noise up to 2 tau
    # and visibly rough by 4 tau, on both gases. One tau therefore holds a
    # factor of four. Raise this only with a fresh sweep in hand.
    assert max(calls) <= 1.0 * tau * (1.0 + 1e-9), (
        f"a coupling step of {max(calls) * 1e3:.3f} ms exceeded tau = "
        f"{tau * 1e3:.3f} ms; COUPLING_SAFETY is {mod.COUPLING_SAFETY}"
    )
    assert mod.COUPLING_SAFETY <= 1.0
    assert sum(calls) == pytest.approx(min(dt, mod.MAX_STEP), rel=1e-9)


# ---------------------------------------------------- computed ahead, replayed


def test_a_precomputed_run_replays_in_order_without_integrating() -> None:
    """The burn is integrated ahead at study accuracy and handed back a frame
    at a time, so the panel gets a real-time, noise-free run for the price of a
    short wait before it. During replay `step` must not integrate: the frames
    it returns are the buffered ones, in stand-time order, paced by dt.
    """
    session = stand(engine=True, dome_psi=500.0)
    session.prime(fill_fraction=0.95, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    session.step(0.05)
    session.state = "Fire"
    frames = session.precompute(horizon=0.6, dt=0.02)
    assert frames >= 20 and not session.computing and session.replaying
    end_t = session.t  # the stand itself is at the END of the run
    buffered = {
        round(f.t, 6) for f, _ in session._replay
    }  # before replay consumes them
    ts = []
    for _ in range(12):
        ts.append(session.step(0.05).t)
    assert ts == sorted(ts) and ts[0] < ts[-1] < end_t + 1e-9
    assert session.t == end_t, "replay integrated the stand further"
    # Each shown frame is one that was buffered, not a fresh solve.
    assert all(round(t, 6) in buffered for t in ts)
    # The buffer is spent; the stand carries on live from where the run ended.
    assert not session.replaying
    assert session.step(0.05).t > end_t


def test_a_command_during_replay_restores_the_stand_to_the_frame_shown() -> None:
    """An abort mid-replay must act on the stand the operator is looking at,
    not on the one four seconds further into the future that the precompute
    left behind. Every buffered frame therefore carries the stand's state at
    that instant, and a command restores it before it does anything else.
    """
    session = stand(engine=True, dome_psi=500.0)
    session.prime(fill_fraction=0.95, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    session.step(0.05)
    session.state = "Fire"
    session.precompute(horizon=0.6, dt=0.02)
    for _ in range(5):
        shown = session.step(0.05)
    assert session.t > shown.t + 0.1, "the stand should be well ahead of the display"
    ox = next(iter(session.tanks.values()))
    shown_mass = (
        shown.tanks[ox.id]["liquid_kg"] if "liquid_kg" in shown.tanks[ox.id] else None
    )

    session.set_valve(next(iter(session.model.built.actuators)), False)

    assert session.t == pytest.approx(
        shown.t
    ), "stand not restored to the shown instant"
    assert not session._replay and not session.replaying
    assert session.history[-1].t == pytest.approx(shown.t), "history not truncated"
    if shown_mass is not None:
        assert ox.state.liquid_mass == pytest.approx(shown_mass, rel=1e-9)
    # ...and it carries on live from there.
    nxt = session.step(0.05)
    assert nxt.t > shown.t and session.t == pytest.approx(nxt.t)


def test_a_command_while_computing_cancels_the_run_and_acts_on_the_held_frame() -> None:
    """An abort during "running sim" must never be refused, and must act on the
    stand the operator is looking at -- the frame held since the run began, not
    the future the thread has integrated to. So a command cancels the run at
    its next step, restores the stand to that frame, and goes through.
    """
    import threading

    session = stand(engine=True, dome_psi=500.0)
    session.prime(fill_fraction=0.95, tank_psi=550.0, copv_psi=4500.0, state="Ready")
    held = session.step(0.05)
    session.state = "Fire"
    worker = threading.Thread(
        target=session.precompute, args=(30.0,), kwargs={"dt": 0.02}
    )
    worker.start()
    # Let it get a few frames in, and confirm the display is holding.
    for _ in range(50):
        if len(session._replay) >= 3:
            break
        import time as _t

        _t.sleep(0.05)
    assert session.computing and session.step(0.05).t == held.t
    assert session.t > held.t, "the thread should have integrated ahead"

    target = next(
        s for s in session.machine.targets(session.state) if "abort" in s.lower()
    )
    session.command_state(target)  # must not raise
    worker.join(timeout=30)
    assert not session.computing and not session.replaying
    assert session.state == target
    assert session.t == pytest.approx(held.t), "not restored to the held frame"
    assert session.step(0.05).t > held.t, "and it carries on live from there"


# ---------------------------------------------------- the operator's report


def test_a_state_change_takes_command_back_from_the_hand() -> None:
    """The table opens Fuel Main and LOX Press in Idle. An operator shut them
    by hand -- and the hold then outlived every state: Ox Press pressed
    nothing, Fire opened no fuel main. A transition writes every actuator the
    table knows, as the DAQ does."""
    session = stand()
    session.set_valve("SV_LOX_PRESS", False)
    session.set_valve("MVF", False)
    session.step(0.1)
    assert session.history[-1].signals["SV-LOX-PRESS.command"] == 0.0
    session.command_state("Armed")
    session.command_state("Press Standby")
    session.command_state("Ox Press")
    session.step(0.1)
    assert "SV_LOX_PRESS" not in session.forced
    assert session.history[-1].signals["SV-LOX-PRESS.command"] == 1.0
    # Valves the table never commands keep the hand's position.
    session.set_valve("PR_C", True)
    session.command_state("Press Standby")
    assert "PR_C" in session.forced


def test_a_delivered_bottle_starts_full_and_cold() -> None:
    """A supplier's cylinder arrives at the drawing's pressure and ambient.
    The invented 25 s GSE fill put ten kilograms into it adiabatically, ended
    near 380 K, and then sagged ten psi a second -- which read as a leak."""
    delivered = stand(bottle_delivered=True)
    bottle = next(iter(delivered.bottles.values()))
    assert bottle.charged
    assert psi(bottle.pressure) == pytest.approx(4500.0 + 14.7, rel=0.01)
    assert bottle.volume.temperature(bottle.state) == pytest.approx(293.15, abs=1.0)
    hold(delivered, "Press Standby", 10.0)
    assert psi(bottle.pressure) == pytest.approx(4500.0 + 14.7, rel=0.01), "it holds"

    charged = stand()
    empty = next(iter(charged.bottles.values()))
    assert not empty.charged, "charged on the pad is the default"
    assert psi(empty.pressure) == pytest.approx(14.7, abs=1.0)


def test_a_hot_bottle_is_named_not_hunted_as_a_leak() -> None:
    """A fast fill ends hot; the pressure then follows the gas down. The note
    says so, because the operator's first reading of it was a leak."""
    session = stand()  # the helper fills in 5 s, which is a hot fill
    hold(session, "Armed", 0.2)
    hold(session, "Press Standby", 0.2)
    hold(session, "GN2 High Press", 8.0)
    hold(session, "Press Standby", 1.0)
    bottle = next(iter(session.bottles.values()))
    assert (
        bottle.volume.temperature(bottle.state) > bottle.state.wall_temperature + 30.0
    )
    assert any("hotter than its wall" in n for n in session.history[-1].notes)


def test_the_tank_vents_in_about_a_second() -> None:
    """The stand's tank vents blow 550 psig to zero in about a second. A
    1/4 in path could not, whatever the valve's Cv; the drawing now carries a
    3/8 in path, calibrated to that observation."""
    session = stand()
    session.prime(
        fill_fraction=0.85, tank_psi=550.0, copv_psi=4500.0, state="Press Standby"
    )
    session.command_state("Fuel Vent")
    t = 0.0
    while t < 3.0:
        session.step(0.05)
        t += 0.05
        if psi(session.tanks["FUT"].pressure) - 14.7 < 10.0:
            break
    assert t <= 1.3, f"fuel tank still above 10 psig after {t:.2f} s"


# ------------------------------------------------ the cockpit's own physics


def test_a_shut_lox_tank_climbs_and_the_panel_says_why() -> None:
    """With the cockpit defaults -- vapour, wall-to-liquid, ambient leak, wall
    boiling -- a LOX tank loaded fast onto a warm wall boils the moment its
    vent shuts, climbs, and the notes tell the operator to keep venting. The
    same tank vented sits near atmosphere with the vent carrying boil-off."""
    session = stand(chilldown=100.0, ambient_leak=5.0)
    hold(session, "Ox Fill", 6.0)
    vented = psi(session.tanks["OXT"].pressure)
    assert vented - 14.7 < 100.0
    assert (
        session._last_flows.get("SV_LOX_VENT", 0.0) > 5e-3
    ), "the vent carries boil-off"
    hold(session, "Armed", 0.4)  # LOX Vent shut
    shut = psi(session.tanks["OXT"].pressure)
    assert (
        shut > vented + 20.0
    ), f"a shut LOX tank on a warm wall climbs: {vented:.0f} -> {shut:.0f}"
    notes = "\n".join(session.history[-1].notes)
    assert "keep the vent open until it chills" in notes, notes
    assert session.tanks["OXT"].readouts()["wall_temperature_K"] > 150.0
    # Left shut on a 0.75 L ullage under a 293 K wall it runs to the oxygen
    # critical pressure -- the model's ceiling -- within seconds, and the
    # note changes to "vent it".
    hold(session, "Armed", 4.0)
    later = psi(session.tanks["OXT"].pressure)
    assert later > shut + 20.0, (shut, later)
    assert "Vent it" in "\n".join(session.history[-1].notes)
    hold(session, "Ox Vent", 3.0)
    assert (
        psi(session.tanks["OXT"].pressure) < later - 20.0
    ), "venting brings it back down"


def test_a_pressed_lox_tank_does_not_run_away() -> None:
    """Under 38 bar of nitrogen the liquid is a hundred kelvin subcooled: no
    wall boiling, the leak warms the bulk, and a pressed tank holds."""
    session = stand(chilldown=100.0, ambient_leak=5.0)
    session.prime(
        fill_fraction=0.85, tank_psi=550.0, copv_psi=4500.0, state="Press Standby"
    )
    before = psi(session.tanks["OXT"].pressure)
    hold(session, "Press Standby", 10.0)
    after = psi(session.tanks["OXT"].pressure)
    assert abs(after - before) < 25.0, (before, after)


def test_vapour_leaves_only_through_a_vent() -> None:
    """A tank venting to atmosphere sends its vapour share out with the gas;
    a tank trading gas with the press manifold does not, because that gas
    comes back and the network carries no species to bring the vapour with
    it. `_vent_fraction` follows the solved flows to say which is which."""
    session = stand(ullage_vapour=True)
    session.prime(
        fill_fraction=0.85, tank_psi=550.0, copv_psi=4500.0, state="Press Standby"
    )
    session.command_state("Fuel Vent")
    session.step(0.05)
    assert session._vent_fraction("FUT", session._last_flows) == pytest.approx(1.0)
    assert session._vent_fraction("OXT", session._last_flows) == pytest.approx(0.0)
    session.command_state("Press Standby")
    session.command_state("Ox Press")
    for _ in range(5):
        session.step(0.05)
    assert session._vent_fraction("OXT", session._last_flows) == pytest.approx(0.0)


def test_the_lox_tank_wears_its_insulation() -> None:
    """The drawing says an inch of fiberglass on the LOX tank (operator). The
    skin then passes 1/(1/8 + 0.0254/0.04) = 1.3 W/(m^2.K); the fuel tank is
    bare and sees the air film alone."""
    session = stand(chilldown=100.0, ambient_leak=8.0)
    assert session.tanks["OXT"].tank.ambient_conductance == pytest.approx(
        1.32, abs=0.05
    )
    assert session.tanks["FUT"].tank.ambient_conductance == pytest.approx(8.0)
    # The knob is live: turning the air film off removes the leak entirely.
    session.setup = Setup(**{**session.setup.__dict__, "ambient_leak": 0.0})
    session.apply_thermal()
    assert session.tanks["OXT"].tank.ambient_conductance == 0.0


def test_an_insulated_shut_lox_tank_climbs_slower_than_a_bare_one() -> None:
    """Loaded, chilled, at atmosphere, vent just shut. The dry wall above the
    liquid is still warm from the load and warms the ullage, the ullage warms
    the surface, and the tank climbs at tens of psi a minute -- the number
    the operator quotes. Bare, the same tank climbs faster. The difference
    is the whole point of the wrap. (Before the surface layer this read as
    "climbs into the teens then creeps": the whole leak boiled, then fifteen
    kilograms of bulk had to warm.)"""
    from dataclasses import replace

    def shut(bare: bool) -> float:
        session = stand(chilldown=100.0, ambient_leak=8.0)
        session.prime(fill_fraction=0.85, tank_psi=0.0, copv_psi=4500.0, state="Armed")
        ox = session.tanks["OXT"]
        if bare:
            ox.tank.ambient_conductance = 8.0
        ox.state = replace(
            ox.state, wetted_wall_temperature=ox.state.liquid_temperature + 5.0
        )
        # Both climb to saturation-limited pressure first (the wall's own 5 K
        # of superheat); the leak shows in what happens after.
        hold(session, "Armed", 180.0)
        return psi(ox.pressure) - 14.7

    insulated, bare = shut(False), shut(True)
    # Three minutes at tens of psi a minute.
    assert 20.0 < insulated < 150.0, insulated
    assert bare > insulated + 3.0, (bare, insulated)


def test_a_small_ullage_press_lands_on_lockup_not_past_it() -> None:
    """The fuel tank is 8.67 L with a 5 % ullage: twenty grams of gas. One
    coupling step of a wide-open regulator near lockup used to carry it
    35 psi past the setpoint, where the regulator shut and left it. The last
    step is clipped onto the supply; the rest goes back to the bottle."""
    session = stand()
    hold(session, "Ox Fill", 6.0)
    hold(session, "Fuel Fill", 6.0)
    hold(session, "Press Standby", 0.5)
    hold(session, "GN2 High Press", 8.0)
    hold(session, "Press Standby", 0.5)
    session.state = "Fuel Press"
    peak = 0.0
    for _ in range(20):
        session.step(0.2)
        peak = max(peak, psi(session.tanks["FUT"].pressure) - 14.7)
    assert peak < 550.0 * 1.01, f"the fuel tank overshot lockup: {peak:.1f} psig"
    assert psi(session.tanks["FUT"].pressure) - 14.7 > 540.0


# ------------------------------------------------- the console's numerics


def test_a_panel_tick_integrates_on_the_study_grid() -> None:
    """A 0.2 s tick is ten 0.02 s steps -- the study's dt -- so the console
    and the Study tab integrate the same equations on the same grid. It used
    to be one 0.2 s step with a wall-clock budget that folded coupling steps
    under load, and the two tabs disagreed."""
    session = stand()
    before = len(session.history)
    session.step(0.2)
    assert len(session.history) - before == 10
    recent = list(session.history)[-10:]
    dts = [b.t - a.t for a, b in zip(recent, recent[1:])]
    assert all(abs(dt - 0.02) < 1e-6 for dt in dts), dts
    assert Setup().max_iterations == 120, "the study's Newton budget"
    assert Setup().tick_budget >= 1e6, "no wall-clock fold"


def test_a_vessel_over_its_mawp_trips_the_stand() -> None:
    """Dome turned up to 1400: the LOX tank presses past the 1000 psig the
    drawing rates it for, the stand stops on that frame and says so, and it
    stays stopped -- there is no un-bursting a tank, only a reset."""
    session = stand()
    session.setup.dome_psi = 1400.0
    hold(session, "Ox Fill", 6.0)
    hold(session, "Press Standby", 0.5)
    hold(session, "GN2 High Press", 8.0)
    hold(session, "Press Standby", 0.5)
    assert session.tripped is None
    session.state = "Ox Press"
    for _ in range(50):
        session.step(0.2)
        if session.tripped:
            break
    assert (
        session.tripped and "TK-LOX" in session.tripped and "MAWP" in session.tripped
    ), session.tripped
    frozen = session.t
    shown = session.step(0.2)
    assert session.t == frozen and shown.t == pytest.approx(
        frozen, abs=0.02
    ), "frozen on the frame it failed on"
    assert psi(session.tanks["OXT"].pressure) - 14.7 > 990.0
