"""Running an assembled model along its command timeline.

A **valve sequence**: at each instant the commands are what the timeline says,
the network is solved to steady state, and -- when an engine is attached -- the
chamber pressure is iterated to consistency with the flows the injector passes.

It is deliberately not a burn. The tanks stay where the regulator holds them
rather than draining, so this answers "what does this system do as these valves
move" exactly and says nothing about what happens as the tanks empty. That
limitation is real, it is named in the result, and it is preferred to a coupled
transient that does not converge on an imported network.

The chamber loop is the part worth reading. Chamber pressure sets the injector's
pressure difference, which sets the flows, which set chamber pressure -- neither
side can be evaluated without the other. Solved by secant on ``g(p) - p``,
because plain relaxation converges linearly and this sits inside a loop over a
hundred and twenty time steps.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Mapping

from feedtwin.engine import ChamberResult
from feedtwin.model.units import get_unit
from feedtwin.solve.network import Network
from feedtwin.solve.steady import SteadyResult, solve_steady
from feedtwin.transient import Command, Scenario

from feedtwin.engine.balance import MixtureBalance

from backend.analysis import mixture_balance
from backend.assembly import Model

# Annotated, rather than left to inference, because the annotation is doing
# real work here. feedtwin is installed editable, which mypy cannot follow
# (a PEP 660 .pth finder shim, not a directory it can import), so despite the
# package shipping py.typed the app's `--ignore-missing-imports` run resolves
# `get_unit` to Any. Without this line that Any spread to every pressure the
# module returns, and `psig()` -- the one place absolute and gauge meet --
# was unchecked.
PSI: float = get_unit("psi").factor

#: Standard atmosphere [Pa]. The zero of every gauge on the stand.
ATMOSPHERE = 101325.0


def psig(pascal: float) -> float:
    """Absolute pressure [Pa] as the stand's transducers would read it [psig].

    Every pressure inside the model is absolute -- the equation of state, the
    choking ratios and the regulator all need it that way. Every pressure a
    person reads or types is gauge, because that is what a PT with atmosphere
    cancelled out reports and what the dial on a regulator is marked in. This
    and :func:`from_psig` are the only two places the two meet; a vented vessel
    reads 0.0, not 14.7.
    """
    return (pascal - ATMOSPHERE) / PSI


def from_psig(gauge: float) -> float:
    """A gauge reading or dial setting [psig] as the absolute pressure the model
    integrates [Pa]."""
    return gauge * PSI + ATMOSPHERE


@dataclass(frozen=True, slots=True)
class Sample:
    """One instant of a sequence."""

    t: float
    pressures: Mapping[str, float]
    flows: Mapping[str, float]
    signals: Mapping[str, float]
    converged: bool
    temperatures: Mapping[str, float] = field(default_factory=dict)
    """Node temperature [K]. Defaulted rather than required: this sequence
    runner does not propagate enthalpy the way the live session does, so it has
    none to report, and a thermal channel from it is honestly empty rather than
    wrong."""
    chamber: ChamberResult | None = None
    balance: MixtureBalance | None = None
    """Why the mixture ratio is where it is at this instant. Carried per sample
    rather than computed once at the end, because injector stiffness moves
    through a start transient and the moment it is lowest is the moment worth
    seeing."""


@dataclass(frozen=True, slots=True)
class RunOptions:
    duration: float = 1.0
    steps: int = 120
    open_at: float = 0.20
    ox_lead: float = 0.04
    dome_psi: float = 0.0
    """Dome control setting [psig]. Zero means "leave the drawing's setting alone"."""

    forced: Mapping[str, float] = field(default_factory=dict)
    """Drawing id to a commanded position, overriding the timeline. How a click
    on the schematic reaches the solve."""


def build_scenario(model: Model, options: RunOptions) -> tuple[Scenario, str]:
    """The command timeline, and the dome signal name if there is one."""
    built = model.built
    dome_signal = next((s for s in built.actuators.values() if s.endswith(".dome")), "")

    signals: dict[str, float] = {}
    for node in model.diagram.nodes:
        if node.type == "PR" and node.options.get("domeLoaded") == "yes":
            setpoint = node.params.get("setpoint")
            if setpoint is not None and dome_signal:
                signals[dome_signal] = setpoint.si
    if dome_signal and options.dome_psi > 0.0:
        signals[dome_signal] = from_psig(options.dome_psi)

    commands: list[Command] = []
    for drawing_id, signal in built.actuators.items():
        if signal.endswith(".dome"):
            continue
        forced = options.forced.get(drawing_id)
        if forced is not None:
            # A forced valve holds its position for the whole run: that is what
            # clicking one on the schematic means.
            signals[signal] = forced
            continue
        signals[signal] = 0.0
        delay = 0.0 if "OX" in signal.upper() else options.ox_lead
        commands.append(Command(options.open_at + delay, signal, 1.0, travel_time=0.05))

    return (
        Scenario(
            duration=options.duration,
            name=str(model.meta.get("diagram_name", "run")),
            initial_signals=signals,
            commands=commands,
        ),
        dome_signal,
    )


def hold_tanks_at_regulator(
    model: Model, dome_signal: str, signals: Mapping[str, float]
) -> None:
    """Put the tanks where the regulator puts them.

    Holding them at whatever pressure the drawing happens to record would make
    the dome control regulator inert -- turn the knob and nothing moves -- when
    on the stand that knob is precisely what sets tank pressure.
    """
    if not dome_signal or dome_signal not in signals:
        return
    net = model.built.network
    for node in model.diagram.nodes:
        if node.type != "PR" or node.options.get("domeLoaded") != "yes":
            continue
        bias = node.params.get("dome_bias")
        held = signals[dome_signal] + (bias.si if bias else 0.0)
        for ports in model.built.tanks.values():
            ullage = net.nodes[ports.ullage]
            outlet = net.nodes[ports.outlet]
            head = 0.0
            if ullage.pressure is not None and outlet.pressure is not None:
                head = outlet.pressure - ullage.pressure
            ullage.pressure = held
            outlet.pressure = held + head


#: Secant tolerance on chamber pressure, relative.
CHAMBER_TOLERANCE = 1.0e-4
CHAMBER_ITERATIONS = 30


def _solve_instant(
    model: Model, signals: Mapping[str, float], guess: float
) -> tuple[SteadyResult, ChamberResult | None, float]:
    """Solve the network, closing the chamber loop when there is an engine."""
    net = model.built.network
    ports = model.built.engine_ports
    if model.chamber is None or "chamber" not in ports:
        return (
            solve_steady(net, signals=signals, tol=1e-5, raise_on_failure=False),
            None,
            guess,
        )

    node = net.nodes[ports["chamber"]]
    result = solve_steady(net, signals=signals, tol=1e-5, raise_on_failure=False)
    chamber: ChamberResult | None = None
    previous: tuple[float, float] | None = None

    for _ in range(CHAMBER_ITERATIONS):
        node.pressure = guess
        result = solve_steady(net, signals=signals, tol=1e-5, raise_on_failure=False)
        mdot_ox = _into(net, ports.get("oxidiser", ""), ports["chamber"], result)
        mdot_fuel = _into(net, ports.get("fuel", ""), ports["chamber"], result)
        chamber = model.chamber.evaluate(mdot_ox, mdot_fuel)

        residual = chamber.pressure - guess
        if abs(residual) <= CHAMBER_TOLERANCE * max(guess, 1.0):
            break

        step: float | None = None
        if previous is not None:
            p_prev, f_prev = previous
            if guess != p_prev:
                slope = (residual - f_prev) / (guess - p_prev)
                if slope < 0.5:
                    step = -residual / (slope - 1.0)
        previous = (guess, residual)
        if step is None or not math.isfinite(step):
            step = 0.4 * residual
        guess = max(guess + step, model.chamber.ambient_pressure)

    node.pressure = guess
    return result, chamber, guess


def _into(net: Network, branch_id: str, node: str, result: SteadyResult) -> float:
    """Mass arriving at ``node`` through one branch [kg/s], never negative.

    Clamped because a chamber does not receive backflow: a negative here means
    the loop is mid-iteration at a pressure the injector cannot pass, not that
    propellant is coming back out.
    """
    if not branch_id:
        return 0.0
    branch = net.branches[branch_id]
    sign = 1.0 if branch.downstream == node else -1.0
    return max(sign * float(result.flows.get(branch_id, 0.0)), 0.0)


def run(model: Model, options: RunOptions) -> list[Sample]:
    """March the command timeline, solving at each instant."""
    scenario, dome_signal = build_scenario(model, options)
    hold_tanks_at_regulator(model, dome_signal, scenario.initial_signals)

    guess = 350.0 * PSI
    samples: list[Sample] = []
    for index in range(options.steps + 1):
        t = options.duration * index / options.steps
        signals = scenario.signals_at(t)
        result, chamber, guess = _solve_instant(model, signals, guess)
        samples.append(
            Sample(
                t=t,
                pressures=dict(result.pressures),
                flows=dict(result.flows),
                signals=signals,
                converged=result.converged,
                chamber=chamber,
                balance=mixture_balance(model, result, signals),
            )
        )
    return samples
