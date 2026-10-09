"""A burn, from T-0 to a dry tank, as one call.

The feed-twin COPV study was the first thing to fly a whole burn headless: build
a session, put it at T-0 directly, settle it to regulator lockup with the mains
shut, record a lead-in, command Fire and step until a tank runs dry. That
sequence lives here now, unchanged, so the study and EngineDesign's Layer X
burn the same way -- and a number either of them quotes means the same thing.

What this is not
----------------
It is not a rehearsal of the pad. :func:`prime_at_t0` sets the T-0 state
directly rather than flying fills and presses, because pressing the tanks draws
on the bottle a burn is usually asked about: an undersized COPV would then fail
for two reasons at once and the trace could not say which. See
:meth:`~feedtwin.session.core.Session.prime`.

Numerics
--------
:func:`burn_setup` is the study's setting: no latency budget, a generous Newton
allowance, and the cockpit's newer thermal closures (stratified surface layer,
boiling onset, nucleate regime) off, because the expectations in
``docs/PHYSICS-BENCHMARK.md`` 2.x were set without them. Turn them on
deliberately, with a fresh baseline.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Mapping

from feedtwin.session.core import PAD_HOLD_S, Sample, Session, Setup
from feedtwin.session.gauge import PSI, from_psig, psig
from feedtwin.session.model import Model
from feedtwin.session.network_trace import NetworkTrace
from feedtwin.session.hookup import Hookup
from feedtwin.session.hookup import binding as hookup_binding
from feedtwin.session.statemachine import StateMachine

#: Called after every step of a burn with ``(clock, sample, firing)``. The
#: session itself is live at that moment, so a recorder may read it directly.
Recorder = Callable[[float, Sample, bool], None]


def burn_setup(**changes: Any) -> Setup:
    """The study's numerics, with ``changes`` on top.

    A study wants the opposite of a cockpit: never fold a tick to save wall
    clock, and give Newton room. The thermal closures the cockpit grew after the
    benchmark expectations were set stay off, so those numbers keep meaning what
    they meant.
    """
    base: dict[str, Any] = {
        "stratification": False,
        "boiling_onset_K": 0.0,
        "chilldown_nucleate": 0.0,
        # On in the library and the cockpit since 2026-10-03; off here so the
        # benchmark (docs/PHYSICS-BENCHMARK.md 2.x) is the scheme it was stated
        # at. A study case asks for line walls itself.
        "line_walls": False,
        # The ullage against its dry wall only (2026-10-06): on in the library
        # and the cockpit, off here for the same reason as line walls.
        "ullage_wall_by_level": False,
        # The regulator seat as a gas sees it (2026-10-08): the same again.
        "regulator_compressible_seat": False,
        # A burn reads the trace past depletion; the cockpit's automatic Vent
        # at burnout would open the vents on it.
        "auto_vent": False,
        "max_iterations": 120,
        "tick_budget": 1.0e9,
    }
    base.update(changes)
    return Setup(**base)


#: The key :func:`open_session` marks a model's ``meta`` with once a session has run it.
OPENED = "session_opened"


def open_session(
    model: Model,
    machine: StateMachine,
    *,
    setup: Setup | None = None,
    hookup: Hookup | None = None,
) -> Session:
    """A session on ``model``, its valves bound to ``machine`` by label.

    A model is consumed by the session that runs it: the session writes node
    pressures, the pinned chamber node and propagated temperatures into the
    model's network as it steps. A second session on the same model starts from
    the first one's end state, and on an engine-coupled stand that is a chamber
    closure that fails from the first fire step (41 of 51 steps held, measured).
    So this refuses a model it has already opened. Assemble a fresh one per run
    (:func:`~feedtwin.session.model.assemble_model` is cheap).
    """
    if model.meta.get(OPENED):
        raise ValueError(
            "this model has already been run by a session, which leaves its "
            "network at that run's end state; assemble a fresh model per session"
        )
    if isinstance(model.meta, dict):
        model.meta[OPENED] = True
    # The cockpit's own binding (names, the plumbing, the hookup's pins): one
    # rule for both, so a stand binds the same wherever it is run.
    return Session(
        model,
        machine,
        hookup_binding(model, machine, hookup),
        setup=setup,
        hookup=hookup,
    )


@dataclass(frozen=True, slots=True)
class BurnPlan:
    """Where T-0 is and how to get past it.

    Pressures are **gauge**, as a dial or a PT reads them -- see
    :mod:`feedtwin.session.gauge`, and :func:`~feedtwin.session.gauge.psig_from_psia`
    for a caller that knows the absolute pressure it wants.
    """

    tank_psi: float = 550.0
    """Tank pressure at prime [psig] when no regulator feeds the tanks. Where one
    does, the tanks are primed and settled at the lockup it gives off the
    charged bottle (:func:`regulator_lockup`): dome + bias - S x bottle, which
    a fixed number here would miss by the supply effect."""
    copv_psi: float = 4500.0
    """Bottle at T-0 [psig]."""
    fill_fraction: float = 0.95
    """Liquid volume over tank volume at T-0, for every tank not in ``loads``."""
    loads: Mapping[str, float] | None = None
    """Propellant mass at T-0 [kg] per tank id, instead of ``fill_fraction``.
    A vehicle whose load is fixed (by mass, by rule) says so here."""
    bottle_litres: float | None = None
    """Override every bottle's volume [L]; ``None`` keeps the drawing's."""
    hold_s: float = PAD_HOLD_S
    """How long the tanks have been loaded at T-0 [s]."""
    ready_state: str = "Ready"
    fire_state: str = "Fire"

    settle: bool = True
    """Settle to regulator lockup with the mains shut before the lead-in."""
    lockup_psi: float | None = None
    """What the settle waits for [psig]; ``None`` means ``tank_psi``."""
    settle_band_psi: float = 4.0
    """Every tank within this of lockup for ``settle_steps`` consecutive steps.
    Wider than the regulator's own 0.5 % dead band on purpose: a collapsing
    ullage cycles inside that band and a tighter criterion never fires."""
    settle_steps: int = 10
    settle_min_s: float = 2.0
    settle_max_s: float = 10.0
    settle_dt: float = 0.05

    lead_in_s: float = 0.5
    """Mains-shut hold recorded before ignition: the datum the ignition step is
    measured from. Without it a trace opens mid-step and the drop is invisible."""
    dt: float = 0.05
    horizon_s: float = 14.0
    dry_kg: float = 0.06
    """Below this a tank is dry and the burn is over [kg]."""
    tanks: tuple[str, ...] | None = None
    """Tank ids whose depletion ends the burn; ``None`` means every tank."""
    end_on_depletion: bool = False
    """Shorten the last step so the burn ends when the first tank reaches
    ``dry_kg``, rather than on whichever step carries it past. Off, the burn
    ends on a step: the end of burn, and every quantity read there (total
    impulse, the bottle at burnout, the residual), moves by up to a step's
    worth as a design change slides the depletion across a step boundary
    (~330 N.s and ~34 psi of bottle on a 6.8 kN engine at 50 ms). A caller
    comparing designs against each other wants it on."""


def press_valves(session: Session) -> list[str]:
    """Drawing ids of the valves that press the propellant tanks.

    The table's press actuators, minus the fill and GSE lines that share the
    word. In ``Ready`` the table shuts them, so a tank whose ullage is
    collapsing drifts below lockup while it waits -- physical, and what an
    operator tops up before going to Ready. A burn wants the tank *at* lockup at
    T-0, so the settle holds these open and releases them after.
    """
    return [
        symbol
        for actuator, symbol in session.binding.to_symbol.items()
        if "press" in actuator.lower()
        and "fill" not in actuator.lower()
        and "gse" not in actuator.lower()
    ]


def prime_at_t0(session: Session, plan: BurnPlan) -> bool:
    """Put the session at T-0: loaded, at lockup, bottle charged, mains shut.

    Returns whether the settle converged. When it did not, the session's
    assumptions say by how much, because a trace that opens off its datum reads
    as a violent drop-and-recovery at ignition.
    """
    if plan.bottle_litres is not None:
        for bottle in session.bottles.values():
            bottle.volume.volume = plan.bottle_litres / 1e3

    def prime(tank_psi: float) -> None:
        session.prime(
            fill_fraction=plan.fill_fraction,
            tank_psi=tank_psi,
            copv_psi=plan.copv_psi,
            state=plan.ready_state,
            hold_s=plan.hold_s,
            loads=plan.loads,
        )

    # Charge the bottle first: the regulator's lockup reads it. Then put the
    # tanks at that lockup, unless the plan names one. A caller that already
    # solved its dome for ``tank_psi`` (Layer X) lands within a hair of it and
    # keeps its own number.
    prime(plan.tank_psi)
    tank_psi = plan.tank_psi
    if plan.lockup_psi is None:
        lockups = [
            lockup
            for tank_id in session.vehicle_tanks
            if (lockup := regulator_lockup(session, tank_id, place=True)) is not None
        ]
        if lockups and abs(psig(min(lockups)) - plan.tank_psi) > 0.05:
            tank_psi = psig(min(lockups))
            prime(tank_psi)
    if not plan.settle:
        return True

    lockup = tank_psi if plan.lockup_psi is None else plan.lockup_psi
    for symbol in press_valves(session):
        session.set_valve(symbol, True)
    target = from_psig(lockup)
    steady = 0
    elapsed = 0.0
    while elapsed < plan.settle_max_s:
        session.step(plan.settle_dt)
        elapsed += plan.settle_dt
        if session.tripped:
            # A vessel over its rating during the settle: the stand has
            # stopped, and every further step would return the same frame.
            session.release()
            session.assumptions.append(
                f"T-0 not reached: the stand tripped during the settle. "
                f"{session.tripped}"
            )
            return False
        within = all(
            abs(sim.pressure - target) < plan.settle_band_psi * PSI
            for sim in (session.tanks[t] for t in session.vehicle_tanks)
        )
        steady = steady + 1 if within else 0
        if steady >= plan.settle_steps and elapsed >= plan.settle_min_s:
            break
    session.release()
    if steady < plan.settle_steps:
        worst = max(
            abs(psig(session.tanks[t].pressure) - lockup) for t in session.vehicle_tanks
        )
        session.assumptions.append(
            f"T-0 not settled: after {plan.settle_max_s:.0f} s a tank is "
            f"{worst:.1f} psi from lockup; the burn starts off its datum."
        )
        return False
    return True


def regulator_lockup(
    session: Session,
    tank_id: str,
    inlet: float | None = None,
    *,
    loaded_dome: bool = False,
    place: bool = False,
) -> float | None:
    """Where the regulator feeding ``tank_id`` locks up, right now [Pa abs].

    ``inlet`` [Pa abs]: where it would lock up with the bottle at this
    pressure instead -- a charged COPV, or an empty one, to show the range a
    tank sees as the bottle blows down. Default: the bottle as it is.
    ``loaded_dome``: with the dome as its knob sets it, though the dome line
    is shut (:meth:`Session.peek_signals`).

    Moves nothing, unless ``place``: T-0 has always evaluated it through the
    step's :meth:`Session.signals`, which also put each valve where the state
    commands it and took the dome as it stands -- what a stand put at T-0
    starts from. Its two callers there keep that, so burns are unchanged.

    Walks upstream from the tank's ullage to the first regulator in the
    network (dome loaders are lifted out of it, so this is the unit that
    presses the tank), then evaluates its own law at zero flow: the session's
    knob and dome signals, and the bottle behind it at its present pressure,
    which is what the supply-pressure effect reads. ``None`` when no regulator
    feeds the tank -- a stand pressed straight off a bottle has no lockup.
    """
    from feedtwin.comps.regulator import Regulator

    net = session.model.built.network
    sim = session.tanks[tank_id]
    # Undirected: a drawing's edge direction is how it was drawn, not which
    # way gas flows. The walk stops at boundaries -- other vessels, the
    # chamber, this tank's own liquid outlet -- so it searches the press side.
    boundaries = set(net.fixed_nodes) | {sim.outlet_node}
    regulator = None
    seen = {sim.ullage_node}
    frontier = [sim.ullage_node]
    while frontier and regulator is None:
        nxt: list[str] = []
        for node in frontier:
            for branch in net.branches.values():
                if node not in (branch.upstream, branch.downstream):
                    continue
                other = (
                    branch.upstream if branch.downstream == node else branch.downstream
                )
                if other in seen:
                    continue
                if isinstance(branch.component, Regulator):
                    regulator = branch
                    break
                seen.add(other)
                if other not in boundaries:
                    nxt.append(other)
            if regulator is not None:
                break
        frontier = nxt
    if regulator is None:
        return None
    # The vehicle's bottle: a cart's K-bottle bank sits at 6,000 psi behind a
    # shut valve, and the supply effect reads the bottle that feeds the
    # regulator, not the fullest one on the stand.
    ground = session.ground
    bottles = [b.pressure for k, b in session.bottles.items() if k not in ground]
    if not bottles:
        return None
    component = regulator.component
    assert isinstance(component, Regulator)
    supply = max(bottles) if inlet is None else inlet
    signals = (
        session.signals() if place else session.peek_signals(loaded_dome=loaded_dome)
    )
    flow = net.conditions(regulator.upstream, supply, signals)
    return float(component.lockup_pressure(flow))


@dataclass(frozen=True, slots=True)
class T0:
    """Where :func:`jump_to_t0` left the stand."""

    lockup_psi: dict[str, float]
    """Each tank's regulator lockup [psig] at the knobs as set; a tank with no
    regulator upstream is absent."""
    tank_psi: float
    """What the tanks were primed at [psig]."""
    notes: list[str] = field(default_factory=list)
    loads: dict[str, float] = field(default_factory=dict)
    """The propellant each tank was loaded with [kg], by tank id: the fire
    load where the engine states one. Empty when nothing named a load and the
    tanks went to the fill fraction. A burn plan that primes again must carry
    these, or it reloads to the fill fraction."""


def jump_to_t0(
    session: Session,
    *,
    copv_psi: float,
    fill_fraction: float,
    hold_s: float = PAD_HOLD_S,
    ready_state: str = "Ready",
    fallback_psi: float = 550.0,
    loads: Mapping[str, float] | None = None,
) -> T0:
    """The cockpit's shortcut past the pad: loaded, charged, pressed, in Ready.

    The initial condition the study and Layer X burn from
    (:meth:`Session.prime`: tanks loaded to ``fill_fraction``, a LOX wall
    chilled by ``hold_s`` on the pad, the bottle at ``copv_psi``), with the
    tanks at the lockup *this stand's regulators* give at the knobs as they
    are set (:func:`regulator_lockup`), not at a number chosen here. Ready
    shuts the press valves, as the table has it; what the tanks then do while
    the stand waits for Fire is the stand's own physics.

    Nothing about the stand changes: the knobs, the settings and the drawing
    stay as they are. The pad itself (fills, chilldown, presses) is skipped,
    which is the point; fly it from Idle for the transients it carries.
    Tanks fed by regulators that lock up at different pressures are primed at
    the lowest of them and the note says so.

    The tanks hold what a fire is loaded with: ``loads`` [kg] per tank, or the
    engine's fire load (:meth:`Session.fire_loads`) -- never a fraction of the
    tank drawn, which on LE4 (6) is a third more LOX than the vehicle carries.
    ``fill_fraction`` is for a tank neither names.
    """
    notes: list[str] = []
    if loads is None:
        loads = session.fire_loads()
    loads = dict(loads)
    for tank_id, kg in list(loads.items()):
        sim = session.tanks[tank_id]
        full = (
            sim.tank.geometry.total_volume
            * fill_fraction
            * sim.tank.liquid_density(sim.state)
        )
        if kg > full:
            loads[tank_id] = full
            notes.append(
                f"{sim.label}: the {kg:.3f} kg fire load does not fit its "
                f"{sim.tank.geometry.total_volume * 1e3:.2f} L; loaded to "
                f"{fill_fraction:.0%}, {full:.3f} kg."
            )
    if loads:
        notes.append(
            "Loaded for a fire: "
            + ", ".join(
                f"{session.tanks[k].label} {v:.3f} kg" for k, v in sorted(loads.items())
            )
            + "."
        )
    ready = ready_state if ready_state in session.machine.states else session.state
    # Charge the bottle first: the supply-pressure effect reads it.
    session.prime(
        fill_fraction=fill_fraction,
        tank_psi=fallback_psi,
        copv_psi=copv_psi,
        state=ready,
        hold_s=hold_s,
        loads=loads,
    )
    lockups = {
        tank_id: lockup
        for tank_id in session.vehicle_tanks
        if (lockup := regulator_lockup(session, tank_id, place=True)) is not None
    }
    tank_psi = fallback_psi
    if lockups:
        tank_psi = psig(min(lockups.values()))
        if max(lockups.values()) - min(lockups.values()) > PSI:
            notes.append(
                f"The regulators lock up at {psig(min(lockups.values())):.0f}-"
                f"{psig(max(lockups.values())):.0f} psig; every tank was primed at "
                f"{tank_psi:.0f}."
            )
        session.prime(
            fill_fraction=fill_fraction,
            tank_psi=tank_psi,
            copv_psi=copv_psi,
            state=ready,
            hold_s=hold_s,
            loads=loads,
        )
    else:
        notes.append(
            f"No regulator feeds the tanks; primed at {fallback_psi:.0f} psig."
        )
    for tank_id in session.vehicle_tanks:
        if lockups and tank_id not in lockups:
            notes.append(f"{session.tanks[tank_id].label}: no regulator upstream.")
    return T0(
        lockup_psi={k: round(psig(v), 1) for k, v in lockups.items()},
        tank_psi=round(tank_psi, 1),
        notes=notes,
        loads=loads,
    )


@dataclass(frozen=True, slots=True)
class BurnTrip:
    """A vessel trip that ended a burn, on the burn's clock."""

    vessel: str
    """Drawing id of the vessel that went over its rating."""
    label: str
    kind: str
    """``tank`` or ``bottle``."""
    t: float
    """Seconds from the Fire command at which the step that found it ended:
    negative in the lead-in, and exactly ``-lead_in_s`` when it tripped during
    the settle, before the lead-in ran (the stand's clock stops at a trip, so
    how long before is not kept; :attr:`message` and the trace's notes say it
    was the settle). The trace's last sample is that step."""
    pressure: float
    """The vessel's pressure then, absolute [Pa]."""
    limit: float
    """What it trips at, absolute [Pa] (:attr:`feedtwin.session.core.Trip.limit`)."""
    message: str


@dataclass(frozen=True, slots=True)
class BurnEnd:
    """How a burn stopped."""

    depleted_s: float | None
    """Seconds after Fire that a tank ran dry, rounded to 0.01 s; ``None`` if
    none did before the horizon (or the burn was cancelled)."""
    tank: str
    """Which tank ran dry, empty if none did."""
    cancelled: bool
    steps: int
    failed_steps: int
    wall_s: float
    tripped: BurnTrip | None = None
    """Set when a vessel went over its rating: the burn stopped on that step
    rather than integrating the stand's frozen frame to the horizon."""


def burn(
    session: Session,
    plan: BurnPlan,
    record: Recorder,
    *,
    cancelled: Callable[[], bool] = lambda: False,
) -> BurnEnd:
    """Lead-in, then Fire until a tank runs dry, a vessel trips, or the horizon
    passes.

    The clock reads seconds from the Fire command: negative through the
    lead-in, zero at ignition. ``record`` sees every step, the one that trips
    included; nothing after it. A tripped session returns its frozen frame on
    every later step (:meth:`Session.step`), so carrying on to the horizon would
    integrate one instant's thrust for the rest of the burn -- 99,478 N.s
    instead of ~24,000 on the LE4 audit's restated fuel tank (AUDIT.md 5.2).
    """
    started = time.perf_counter()
    # The vehicle's tanks: a cart's transfer tank running low is not a burn
    # ending.
    watched = [
        session.tanks[tank_id]
        for tank_id in (plan.tanks or session.vehicle_tanks)
        if tank_id in session.tanks
    ]
    steps = 0
    failed = 0
    origin = session.t  # the session clock at the start of the lead-in

    def tripped(fire_t: float | None) -> BurnTrip | None:
        trip = session.trip
        if trip is None:
            return None
        if fire_t is None:
            t = trip.t - origin - plan.lead_in_s
        else:
            t = trip.t - fire_t
        return BurnTrip(
            vessel=trip.vessel,
            label=trip.label,
            kind=trip.kind,
            t=t,
            pressure=trip.pressure,
            limit=trip.limit,
            message=session.tripped or "",
        )

    def ended(trip: BurnTrip | None, stopped: bool = False) -> BurnEnd:
        if trip is not None and steps > 0:
            # Said in the trace's notes too (run_burn copies the assumptions),
            # so a reader of the notes alone does not take it for a full burn.
            session.assumptions.append(
                f"Burn stopped at t = {trip.t:+.3f} s, the step a vessel tripped: "
                f"{trip.message}"
            )
        return BurnEnd(
            depleted_s=None,
            tank="",
            cancelled=stopped,
            steps=steps,
            failed_steps=failed,
            wall_s=time.perf_counter() - started,
            tripped=trip,
        )

    if session.tripped:
        # Tripped before the lead-in (the settle): there is no burn to run.
        return ended(tripped(None))

    clock = -plan.lead_in_s
    while clock < -1e-9:
        sample = session.step(plan.dt)
        clock += plan.dt
        steps += 1
        failed += 0 if sample.converged else 1
        record(clock, sample, False)
        if session.tripped:
            return ended(tripped(None))

    session.state = plan.fire_state
    session._state_since = session.t
    fire_t = session.t
    clock = 0.0
    depleted: float | None = None
    dry = ""
    stopped = False
    last: dict[str, float] = {}
    while clock <= plan.horizon_s:
        if cancelled():
            stopped = True
            break
        step = plan.dt
        final = ""
        if plan.end_on_depletion and last:
            # Each tank's drain rate over the last step, held for this one: the
            # step that would carry a tank past dry_kg is cut to land on it.
            for sim in watched:
                rate = (last[sim.id] - sim.state.liquid_mass) / plan.dt
                if rate > 0.0:
                    reach = (sim.state.liquid_mass - plan.dry_kg) / rate
                    if reach < step:
                        step, final = max(reach, 1e-4), sim.id
        before = {sim.id: sim.state.liquid_mass for sim in watched}
        sample = session.step(step)
        clock += step
        steps += 1
        failed += 0 if sample.converged else 1
        record(clock, sample, True)
        if session.tripped:
            return ended(tripped(fire_t))
        if step == plan.dt:
            last = before
        empty = [sim for sim in watched if sim.state.liquid_mass < plan.dry_kg]
        if empty or final:
            depleted = clock if plan.end_on_depletion else round(clock, 2)
            dry = empty[0].id if empty else final
            break

    return BurnEnd(
        depleted_s=depleted,
        tank=dry,
        cancelled=stopped,
        steps=steps,
        failed_steps=failed,
        wall_s=time.perf_counter() - started,
    )


# --------------------------------------------------------------------- a trace


@dataclass(frozen=True, slots=True)
class Probes:
    """The places on a feed system a burn is read at, found from the drawing.

    Every id is a network node except where noted. A probe the drawing does
    not have is simply absent.
    """

    tank_ullage: Mapping[str, str] = field(default_factory=dict)
    tank_outlet: Mapping[str, str] = field(default_factory=dict)
    tank_fluid: Mapping[str, str] = field(default_factory=dict)
    """Tank id to the species it holds."""
    regulator_outlet: Mapping[str, str] = field(default_factory=dict)
    """Regulator symbol id to the node its last branch delivers into."""
    regulator_label: Mapping[str, str] = field(default_factory=dict)
    injector_inlet: Mapping[str, str] = field(default_factory=dict)
    """``oxidiser``/``fuel`` to the injector-face node, when an engine is on."""
    chamber: str = ""
    bottles: tuple[str, ...] = ()
    """Bottle ids (also their network nodes, via :class:`BottleSim`)."""
    instruments: Mapping[str, str] = field(default_factory=dict)
    """Instrument id to the network node it reads. Opt-in: :func:`find_probes`
    leaves it empty, so a burn records what it always did; a caller that wants
    the drawing's own transducers read (to compare with the DAQ) adds them."""
    network: bool = False
    """Record the whole network every step -- every node's pressure and
    temperature, every branch's flow, drop and opening, and the bottle-to-chamber
    path per side -- into :attr:`BurnTrace.network`. Opt-in and recording only:
    off, the trace is exactly what it always was; on, no physics changes. See
    :mod:`feedtwin.session.network_trace` (node values, not vessel states)."""


def find_probes(session: Session) -> Probes:
    """Read the probe points off a built session."""
    built = session.model.built
    net = built.network
    regulator_outlet: dict[str, str] = {}
    regulator_label: dict[str, str] = {}
    for node in session.model.diagram.nodes:
        if node.type != "PR":
            continue
        branches = [b for b in built.branches_of.get(node.id, ()) if b in net.branches]
        if branches:
            regulator_outlet[node.id] = net.branches[branches[-1]].downstream
            regulator_label[node.id] = node.label or node.id
    fluids = {
        node.id: str(node.fluid or "")
        for node in session.model.diagram.nodes
        if node.id in session.tanks
    }
    # The engine's side ports are its injector *branches*; the injector inlet
    # is the node each one draws from -- the face the feed lines deliver to.
    ports = built.engine_ports
    inlets: dict[str, str] = {}
    for side in ("oxidiser", "fuel"):
        port = ports.get(side, "")
        if port in net.branches:
            inlets[side] = net.branches[port].upstream
        elif port in net.nodes:
            inlets[side] = port
    return Probes(
        tank_ullage={k: s.ullage_node for k, s in session.tanks.items()},
        tank_outlet={k: s.outlet_node for k, s in session.tanks.items()},
        tank_fluid=fluids,
        regulator_outlet=regulator_outlet,
        regulator_label=regulator_label,
        injector_inlet=inlets,
        chamber=ports.get("chamber", ""),
        bottles=tuple(session.bottles),
    )


#: Tank quantities recorded per step, beyond pressure.
#:
#: ``surface_temperature_K`` is the liquid surface the ullage sees -- the
#: stratified layer when ``Setup.stratification`` is on, the bulk liquid when it
#: is off (then equal to ``liquid_temperature_K``). It is what sets the vapour
#: pressure, so it is the temperature a saturation margin at the tank is taken
#: against (EngineDesign/docs/layerx/AUDIT.md 5.4, 9.5 section 4).
TANK_FIELDS = (
    "liquid_mass_kg",
    "ullage_temperature_K",
    "liquid_temperature_K",
    "fill_fraction",
    "wall_temperature_K",
    "surface_temperature_K",
)


@dataclass
class BurnTrace:
    """A burn, sampled at every step. Absolute SI throughout.

    Columns rather than rows, because every consumer plots columns. ``t`` is
    seconds from the Fire command; ``firing`` is false through the lead-in.
    """

    probes: Probes
    t: list[float] = field(default_factory=list)
    firing: list[bool] = field(default_factory=list)
    converged: list[bool] = field(default_factory=list)
    pressure: dict[str, list[float]] = field(default_factory=dict)
    """Node id to absolute pressure [Pa], for every probe node."""
    temperature: dict[str, list[float]] = field(default_factory=dict)
    """Node id to temperature [K], for every probe node the solve reports."""
    tank: dict[str, dict[str, list[float]]] = field(default_factory=dict)
    """Tank id to ``pressure_Pa``, ``outlet_pressure_Pa`` and :data:`TANK_FIELDS`."""
    bottle: dict[str, dict[str, list[float]]] = field(default_factory=dict)
    """Bottle id to ``pressure_Pa``, ``mass_kg``, ``wall_temperature_K``."""
    chamber: dict[str, list[float]] = field(default_factory=dict)
    """``pressure_Pa``, ``mdot_oxidiser``, ``mdot_fuel``, ``mixture_ratio``,
    ``thrust_N``, ``isp_s``, ``cstar``, ``extrapolated`` (1.0 when the CEA
    point was clamped). Zeros while not firing."""
    end: BurnEnd | None = None
    t0_settled: bool = True
    notes: list[str] = field(default_factory=list)
    network: NetworkTrace | None = None
    """The whole network per step, when :attr:`Probes.network` asked for it;
    ``None`` otherwise. :func:`network_dict` turns it into the result block."""

    def nodes(self) -> list[str]:
        p = self.probes
        found = [
            *p.tank_ullage.values(),
            *p.tank_outlet.values(),
            *p.regulator_outlet.values(),
            *p.injector_inlet.values(),
            *p.instruments.values(),
        ]
        if p.chamber:
            found.append(p.chamber)
        return list(dict.fromkeys(n for n in found if n))

    def recorder(self, session: Session) -> Recorder:
        """A :data:`Recorder` that appends every step of ``session`` here."""
        nodes = self.nodes()
        for node in nodes:
            self.pressure.setdefault(node, [])
            self.temperature.setdefault(node, [])
        for tank_id in session.tanks:
            columns: dict[str, list[float]] = {
                "pressure_Pa": [],
                "outlet_pressure_Pa": [],
            }
            columns.update({k: [] for k in TANK_FIELDS})
            self.tank.setdefault(tank_id, columns)
        for bottle_id in session.bottles:
            self.bottle.setdefault(
                bottle_id, {"pressure_Pa": [], "mass_kg": [], "wall_temperature_K": []}
            )
        if self.probes.network and self.network is None:
            self.network = NetworkTrace.of(session)
        network = self.network if self.probes.network else None
        for key in (
            "pressure_Pa",
            "mdot_oxidiser",
            "mdot_fuel",
            "mixture_ratio",
            "thrust_N",
            "isp_s",
            "cstar",
            "extrapolated",
        ):
            self.chamber.setdefault(key, [])

        def record(clock: float, sample: Sample, firing: bool) -> None:
            self.t.append(clock)
            self.firing.append(firing)
            self.converged.append(bool(sample.converged))
            for node in nodes:
                self.pressure[node].append(float(sample.pressures.get(node, 0.0)))
                self.temperature[node].append(float(sample.temperatures.get(node, 0.0)))
            if network is not None:
                network.append(sample)
            for tank_id, sim in session.tanks.items():
                column = self.tank[tank_id]
                readout = sim.readouts()
                column["pressure_Pa"].append(sim.pressure)
                column["outlet_pressure_Pa"].append(sim.outlet_pressure)
                for key in TANK_FIELDS:
                    column[key].append(float(readout[key]))
            for bottle_id, bottle in session.bottles.items():
                column = self.bottle[bottle_id]
                column["pressure_Pa"].append(bottle.pressure)
                column["mass_kg"].append(float(bottle.state.mass))
                column["wall_temperature_K"].append(
                    float(bottle.state.wall_temperature)
                )
            result = sample.chamber if firing else None
            ch = self.chamber
            if result is None:
                for column_values in ch.values():
                    column_values.append(0.0)
                return
            ch["pressure_Pa"].append(float(result.pressure))
            ch["mdot_oxidiser"].append(float(result.mdot_oxidiser))
            ch["mdot_fuel"].append(float(result.mdot_fuel))
            ch["mixture_ratio"].append(float(result.mixture_ratio))
            ch["thrust_N"].append(float(result.thrust))
            ch["isp_s"].append(float(result.specific_impulse))
            ch["cstar"].append(float(result.combustion.cstar))
            ch["extrapolated"].append(1.0 if result.combustion.extrapolated else 0.0)

        return record


def run_burn(
    session: Session,
    plan: BurnPlan,
    *,
    cancelled: Callable[[], bool] = lambda: False,
    also: Recorder | None = None,
    network: bool = False,
) -> BurnTrace:
    """Prime, settle, burn, and return the whole trace.

    ``also`` is called alongside the trace's own recorder -- for progress, or a
    caller that wants its own columns. ``network`` records the whole network
    as well (:attr:`Probes.network`); off, the trace is what it always was.
    """
    settled = prime_at_t0(session, plan)
    probes = find_probes(session)
    if network:
        probes = replace(probes, network=True)
    trace = BurnTrace(probes=probes, t0_settled=settled)
    own = trace.recorder(session)

    def record(clock: float, sample: Sample, firing: bool) -> None:
        own(clock, sample, firing)
        if also is not None:
            also(clock, sample, firing)

    trace.end = burn(session, plan, record, cancelled=cancelled)
    trace.notes = list(dict.fromkeys(session.assumptions))
    return trace


def network_dict(trace: BurnTrace) -> dict[str, Any]:
    """The trace's network as the Layer X result's ``network`` block
    (EngineDesign/docs/layerx/DATA-CONTRACT.md section 2).

    Pressures psia (absolute), drops psi, temperatures K, flows kg/s, on the
    trace's own clock. Node values are the step's last network solve -- a vessel
    node is the boundary that solve used, not the post-step vessel state (the
    block's ``basis`` says so). A burn recorded without :attr:`Probes.network`
    gives ``{"available": False, "error": ...}`` rather than raising.
    """
    if trace.network is None:
        return {
            "available": False,
            "error": "the burn was recorded without Probes(network=True)",
        }
    return trace.network.record(trace.t)


#: The name the wave-1 Layer X diagnostics were written against; the same function.
network_record = network_dict


def trip_record(trace: BurnTrace) -> dict[str, Any] | None:
    """The Layer X result's ``tripped`` block, or ``None`` when nothing tripped.

    ``{vessel, label, kind, t, p_psia, mawp_psia, message}``: absolute psia, on
    the trace's clock. ``mawp_psia`` is the pressure the stand trips at, which is
    the drawing's MAWP or its burst pressure over the safety factor.
    """
    trip = trace.end.tripped if trace.end is not None else None
    if trip is None:
        return None
    return {
        "vessel": trip.vessel,
        "label": trip.label,
        "kind": trip.kind,
        "t": trip.t,
        "p_psia": trip.pressure / PSI,
        "mawp_psia": trip.limit / PSI,
        "message": trip.message,
    }


def plan_with(plan: BurnPlan, **changes: Any) -> BurnPlan:
    """``plan`` with ``changes``. A frozen dataclass rebuilt with ``replace``,
    so a field added later is carried rather than dropped."""
    return replace(plan, **changes)
