"""A scenario: what happens when, and what the model does about it.

A transient is not a simulation of a system, it is a simulation of a *test*.
Somebody opens a valve at T-0, the main ox valve leads the fuel valve by 40 ms,
a relief cracks at 620 psi, the run ends at T+5. All of that is data, and it
belongs in a file next to the network rather than in the code that integrates
it.

Two kinds of thing happen in a run and they are handled differently on purpose.

**Commands** are scheduled: a valve is told to move at a known time, and it
takes a known time to get there. These are smooth -- an actuation curve, not a
step -- because a genuine step makes an integrator take microsecond steps
through a discontinuity that the hardware does not actually have.

**Events** are discovered: a check valve reaches its cracking pressure, a relief
lifts, a tank empties. Nobody knows when in advance; the integrator finds them
by watching a sign change. Modelling these as scheduled would be a lie, and
modelling them as smooth would hide the discontinuity that makes them
interesting.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Mapping, Sequence

#: How a commanded actuator travels between two positions, as a function of
#: fractional progress through its travel time. Registered by name so a
#: measured actuation trace can replace an idealised one.
ActuationShape = Callable[[float], float]


def _linear(progress: float) -> float:
    return progress


def _smoothstep(progress: float) -> float:
    """Cubic ease. Continuous in value and slope, which an integrator likes.

    A real solenoid is not a ramp and is not a step; it accelerates, moves, and
    decelerates onto its seat. Smoothstep is a cheap stand-in with the property
    that matters numerically -- no corner for the step controller to trip on.
    """
    return progress * progress * (3.0 - 2.0 * progress)


def _step(progress: float) -> float:
    """Instant at the halfway point. Available, and rarely the right choice.

    Kept because sometimes you genuinely want to see the idealised answer, and
    because forbidding it would just make people fake it with a 1 ms ramp.
    """
    return 0.0 if progress < 0.5 else 1.0


_SHAPES: dict[str, ActuationShape] = {
    "linear": _linear,
    "smoothstep": _smoothstep,
    "step": _step,
}


def register_actuation_shape(name: str, shape: ActuationShape) -> None:
    """Add an actuation curve. A measured valve trace goes here."""
    _SHAPES[name] = shape


def get_actuation_shape(name: str) -> ActuationShape:
    if name not in _SHAPES:
        raise KeyError(
            f"unknown actuation shape {name!r}; registered: "
            f"{', '.join(sorted(_SHAPES))}"
        )
    return _SHAPES[name]


def registered_actuation_shapes() -> list[str]:
    return sorted(_SHAPES)


@dataclass(frozen=True, slots=True)
class Command:
    """One scheduled actuator motion.

    Args:
        time: When the command is issued [s].
        signal: Which control signal it drives -- matches the name a component
            reads from :attr:`~feedtwin.comps.base.FlowConditions.signals`,
            usually ``"<component id>.command"``.
        target: Where it is going. 1.0 is fully open, 0.0 shut.
        travel_time: How long it takes to get there [s]. Zero is instant, and
            is a modelling choice rather than a default -- a real valve takes
            tens of milliseconds and that lead-lag is often the point.
        shape: Named actuation curve.
    """

    time: float
    signal: str
    target: float
    travel_time: float = 0.0
    shape: str = "smoothstep"

    def position(self, t: float, start_value: float) -> float:
        """Where this actuator is at time ``t``, given where it started."""
        if t <= self.time:
            return start_value
        if self.travel_time <= 0.0 or t >= self.time + self.travel_time:
            return self.target
        progress = (t - self.time) / self.travel_time
        fraction = get_actuation_shape(self.shape)(progress)
        return start_value + (self.target - start_value) * fraction

    @property
    def end_time(self) -> float:
        return self.time + self.travel_time


@dataclass(frozen=True, slots=True)
class Scenario:
    """A test: a command timeline, a duration, and the initial signal state.

    Args:
        duration: Run length [s].
        commands: Scheduled actuator motions, in any order.
        initial_signals: Signal values before any command fires. A main valve
            that starts shut needs to say so; the default of "everything open"
            would silently start every run mid-flow.
        name: What this run is, for a report.
    """

    duration: float
    commands: Sequence[Command] = field(default_factory=tuple)
    initial_signals: Mapping[str, float] = field(default_factory=dict)
    name: str = ""

    def __post_init__(self) -> None:
        if self.duration <= 0.0:
            raise ValueError(f"duration must be positive, got {self.duration}")
        for command in self.commands:
            if command.time < 0.0:
                raise ValueError(
                    f"command on {command.signal!r} is scheduled at "
                    f"{command.time} s, before the run starts"
                )
            if command.travel_time < 0.0:
                raise ValueError(
                    f"command on {command.signal!r} has negative travel time"
                )

    def signals_at(self, t: float) -> dict[str, float]:
        """Every signal's value at time ``t``.

        A later command on a signal **supersedes** an earlier one rather than
        queueing behind it. A valve told to shut while it is still opening
        reverses from wherever it actually is, which is what the hardware does;
        letting the first command run to completion first would have it finish
        opening and then close, and the difference is exactly the case an
        abort sequence is written to handle.
        """
        out = dict(self.initial_signals)
        by_signal: dict[str, list[Command]] = {}
        for command in sorted(self.commands, key=lambda c: c.time):
            by_signal.setdefault(command.signal, []).append(command)

        for signal, commands in by_signal.items():
            value = out.get(signal, 0.0)
            for command, following in zip(commands, [*commands[1:], None]):
                if t <= command.time:
                    break
                # This command only owns the interval up to the next one on the
                # same signal; after that the next command takes over from
                # wherever this one had got to.
                cutoff = t if following is None else min(t, following.time)
                value = command.position(cutoff, value)
            out[signal] = value
        return out

    @property
    def switch_times(self) -> list[float]:
        """Times where a command starts or finishes moving.

        Handed to the integrator as step boundaries. An adaptive stepper that
        strides over a valve opening will miss it entirely and report a
        perfectly converged, completely wrong answer; telling it where the
        commands are is cheaper and more reliable than hoping the error
        controller notices.
        """
        edges = {0.0, self.duration}
        for command in self.commands:
            if 0.0 <= command.time <= self.duration:
                edges.add(command.time)
            if 0.0 <= command.end_time <= self.duration:
                edges.add(command.end_time)
        return sorted(edges)
