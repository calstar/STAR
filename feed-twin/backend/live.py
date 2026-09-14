"""Solving the stand where it stands, and firing it.

Two calls, and the split is the difference between a simulator and a report.

:func:`solve_at` answers "what is this stand doing *right now*, in this state,
with these valves". One steady solve plus the chamber loop, a few hundred
milliseconds. Every click in the app goes through it -- picking a state, opening
a valve by hand -- so the twin responds the way the stand does rather than
making somebody configure a run and press go.

:func:`fire` marches a burn: hold the pre-fire state, transition, sample. Each
sample is its own steady solve, which is an honest quasi-static answer and is
labelled as one -- tanks are held where the regulator puts them, so it says
what the system does with the valves in that position and nothing about the
tanks emptying.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

from backend.assembly import Model
from backend.run import PSI, Sample, _solve_instant, hold_tanks_at_regulator
from backend.statemachine import Binding, StateMachine

#: Ceiling on how many steady solves one fire may ask for. A 60 s burn at 50 Hz
#: would be 3000 network solves; the sample rate is reduced to fit rather than
#: the duration, because a shorter burn than you asked for is a wrong answer and
#: a coarser one is not.
MAX_SAMPLES = 400


@dataclass(frozen=True, slots=True)
class Stand:
    """A model plus the state machine bound to it."""

    model: Model
    machine: StateMachine
    binding: Binding

    def signals_for(
        self, state: str, forced: Mapping[str, float], dome_psi: float
    ) -> tuple[dict[str, float], str]:
        """Solver signals for a state, with hand overrides on top.

        Order matters and is the operator's mental model: the state machine
        commands what it commands, and a valve somebody has taken by hand stays
        where they put it. Reversing that would make a state change silently
        undo an override.
        """
        built = self.model.built
        dome_signal = next(
            (s for s in built.actuators.values() if s.endswith(".dome")), ""
        )

        signals: dict[str, float] = {}
        for node in self.model.diagram.nodes:
            if node.type == "PR" and node.options.get("domeLoaded") == "yes":
                setpoint = node.params.get("setpoint")
                if setpoint is not None and dome_signal:
                    signals[dome_signal] = setpoint.si
        if dome_signal and dome_psi > 0.0:
            signals[dome_signal] = dome_psi * PSI

        commanded = self.binding.positions_for(self.machine, state)
        for drawing_id, signal in built.actuators.items():
            if signal.endswith(".dome"):
                continue
            if drawing_id in forced:
                signals[signal] = float(forced[drawing_id])
            elif drawing_id in commanded:
                signals[signal] = commanded[drawing_id]
            else:
                # Not in the table and not touched: a valve the machine does not
                # command sits shut, which is the safe reading of "nobody said".
                signals[signal] = 0.0
        return signals, dome_signal


def solve_at(
    stand: Stand,
    state: str,
    *,
    forced: Mapping[str, float] | None = None,
    dome_psi: float = 0.0,
    guess: float = 350.0 * PSI,
) -> Sample:
    """One instant. What the stand is doing in this state."""
    signals, dome_signal = stand.signals_for(state, forced or {}, dome_psi)
    hold_tanks_at_regulator(stand.model, dome_signal, signals)
    result, chamber, _ = _solve_instant(stand.model, signals, guess)

    from backend.analysis import mixture_balance

    return Sample(
        t=0.0,
        pressures=dict(result.pressures),
        flows=dict(result.flows),
        signals=signals,
        converged=result.converged,
        chamber=chamber,
        balance=mixture_balance(stand.model, result, signals),
    )


@dataclass(frozen=True, slots=True)
class FireOptions:
    """A burn.

    Args:
        duration: Seconds of fire. Deliberately unbounded here -- a burn is as
            long as the propellant lasts, and a cap in the UI that says
            otherwise is a cap somebody has to work around.
        lead_in: Seconds held in the pre-fire state before the transition, so
            the trace shows what the system looked like before ignition.
        sample_hz: Requested sample rate. Reduced if the run would exceed
            MAX_SAMPLES.
        prefire: The state to hold during the lead-in.
        forced: Hand overrides, held throughout.
    """

    duration: float = 5.0
    lead_in: float = 0.5
    sample_hz: float = 20.0
    prefire: str = "Ready"
    state: str = "Fire"
    dome_psi: float = 0.0
    forced: Mapping[str, float] = field(default_factory=dict)


def fire(stand: Stand, options: FireOptions) -> tuple[list[Sample], float]:
    """March a burn. Returns the samples and the sample rate actually used."""
    span = max(options.lead_in + options.duration, 1e-3)
    # The cap is on *samples*, so derive the step count first and let the rate
    # fall out. Clamping the rate instead needs a floor to stay positive, and
    # that floor then beats the cap: a 600 s burn at a 1 Hz floor is 601 network
    # solves, which is the runaway the cap exists to stop.
    steps = max(min(int(round(span * options.sample_hz)), MAX_SAMPLES - 1), 1)
    rate = steps / span

    samples: list[Sample] = []
    guess = 350.0 * PSI
    for index in range(steps + 1):
        t = span * index / steps
        state = options.prefire if t < options.lead_in else options.state
        signals, dome_signal = stand.signals_for(
            state, options.forced, options.dome_psi
        )
        hold_tanks_at_regulator(stand.model, dome_signal, signals)
        result, chamber, guess = _solve_instant(stand.model, signals, guess)

        from backend.analysis import mixture_balance

        samples.append(
            Sample(
                t=round(t - options.lead_in, 5),
                pressures=dict(result.pressures),
                flows=dict(result.flows),
                signals=signals,
                converged=result.converged,
                chamber=chamber,
                balance=mixture_balance(stand.model, result, signals),
            )
        )
    return samples, rate
