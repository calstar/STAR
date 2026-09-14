"""Marching the system in time, and auditing what came out.

The integrator is behind an interface for one reason: the plan committed to
deciding SciPy versus SUNDIALS *on evidence*, at this phase, rather than taking
a dependency up front. SciPy's ``BDF`` and ``Radau`` are implicit, stiff-capable
and already installed. If event handling on check valves and reliefs turns out to
need more than ``solve_ivp`` offers, an IDA backend registers here and nothing
above changes.

The conservation audit is not optional
--------------------------------------
Every run reports mass closure: what left the vessels against what the branches
carried. A stiff integrator will happily produce a smooth, plausible, beautifully
converged trajectory that quietly creates propellant, and no amount of looking at
the pressure trace will reveal it. The check is three lines and it is the
difference between a result and a picture.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol, Sequence, runtime_checkable

import numpy as np
from scipy.integrate import solve_ivp

from feedtwin._environment import stack_versions
from feedtwin.transient.scenario import Scenario
from feedtwin.transient.system import (
    TransientError,
    TransientSample,
    TransientSystem,
)

#: Integration methods that can handle a stiff system. Explicit methods are
#: deliberately absent: a feed system with a fast valve and a slow bottle is
#: stiff by construction, and RK45 on it either crawls or lies.
STIFF_METHODS = ("BDF", "Radau", "LSODA")


@dataclass(frozen=True, slots=True)
class ConservationAudit:
    """Whether the run actually conserved what it should have.

    Reported on every result, never assumed. ``relative`` is the number to
    read: an absolute imbalance means nothing without knowing how much moved.
    """

    mass_in: float
    mass_out: float
    mass_change: float
    """Change in total inventory across all vessels [kg]."""

    @property
    def imbalance(self) -> float:
        """``(in - out) - change`` [kg]. Zero for an exact integration."""
        return (self.mass_in - self.mass_out) - self.mass_change

    @property
    def relative(self) -> float:
        """Imbalance as a fraction of the largest mass that moved."""
        scale = max(abs(self.mass_in), abs(self.mass_out), abs(self.mass_change))
        return abs(self.imbalance) / scale if scale > 0.0 else 0.0

    def __str__(self) -> str:
        return (
            f"mass: in {self.mass_in:.6g} kg, out {self.mass_out:.6g} kg, "
            f"inventory change {self.mass_change:.6g} kg, "
            f"imbalance {self.imbalance:.3e} kg ({self.relative:.2e} relative)"
        )


@dataclass(frozen=True, slots=True)
class TransientResult:
    """A finished run."""

    samples: list[TransientSample]
    converged: bool
    method: str
    steps: int
    rhs_evaluations: int
    elapsed: float
    conservation: ConservationAudit
    inertial_timescales: dict[str, float] = field(default_factory=dict)
    """Per-branch flow-establishment time [s]. The quasi-steady assumption's
    own error bar -- see :mod:`feedtwin.transient.system`."""

    state_labels: list[str] = field(default_factory=list)
    message: str = ""
    stack: dict[str, str | None] = field(default_factory=dict)

    @property
    def times(self) -> list[float]:
        return [s.t for s in self.samples]

    def pressure(self, node: str) -> list[float]:
        """One node's pressure over the run [Pa]. What a plot wants."""
        return [s.pressures[node] for s in self.samples]

    def flow(self, branch: str) -> list[float]:
        return [s.flows[branch] for s in self.samples]

    def vessel(self, vessel_id: str, key: str) -> list[float]:
        return [s.vessels[vessel_id][key] for s in self.samples]

    def engine(self, key: str) -> list[float]:
        """One engine output over the run.

        ``chamber_pressure``, ``mdot_oxidiser``, ``mdot_fuel``,
        ``mixture_ratio``, ``chamber_temperature``, ``cstar``, ``thrust``,
        ``specific_impulse``. The firing trace.
        """
        return [s.engine[key] for s in self.samples if key in s.engine]

    def quasi_steady_margin(self, transient_timescale: float) -> dict[str, float]:
        """Ratio of each branch's inertial time to the transient's own [-].

        Small is good: 1e-3 means flow establishes a thousand times faster than
        anything the model is trying to resolve. Approaching 1 means the
        quasi-steady formulation does not apply to that branch, and no step-size
        change will fix it.
        """
        if transient_timescale <= 0.0:
            raise ValueError("transient timescale must be positive")
        return {
            branch: tau / transient_timescale
            for branch, tau in self.inertial_timescales.items()
        }

    def engine_outside_table(self) -> list[float]:
        """Times at which the engine ran outside its combustion table [s].

        Empty is the answer you want. A non-empty list means chamber
        temperature and c* were clamped to a table edge over that interval, and
        a c* that stopped moving there is a table limit rather than physics --
        which is the kind of thing that reads as a real plateau on a plot.
        """
        return [
            s.t
            for s in self.samples
            if s.engine.get("outside_combustion_table", 0.0) > 0.0
        ]

    def worst_mass_residual(self) -> float:
        """Largest node mass imbalance seen in any algebraic solve [kg/s]."""
        return max((s.mass_residual for s in self.samples), default=0.0)


@runtime_checkable
class Integrator(Protocol):
    """Marches ``dx/dt = f(t, x)`` from one time to another.

    Narrow on purpose. Anything that can do this -- SciPy, SUNDIALS, a fixed
    step for a smoke test -- plugs in without the system above knowing.
    """

    @property
    def name(self) -> str: ...

    def integrate(
        self,
        rhs: Callable[[float, np.ndarray], np.ndarray],
        y0: np.ndarray,
        t_span: tuple[float, float],
        t_eval: Sequence[float],
        *,
        breakpoints: Sequence[float] = (),
        rtol: float = 1e-6,
        atol: float = 1e-9,
    ) -> tuple[np.ndarray, np.ndarray, bool, str, int]:
        """Returns ``(times, states, success, message, rhs_evaluations)``."""
        ...


class SciPyIntegrator:
    """``scipy.integrate.solve_ivp`` with a stiff method and step boundaries.

    Args:
        method: One of :data:`STIFF_METHODS`. ``BDF`` is the default: this
            system is stiff -- a 40 ms valve alongside a 5 s bottle decay -- and
            an explicit method on it either takes microsecond steps or produces
            a smooth wrong answer.
        max_step: Ceiling on step size [s]. Zero lets the controller choose.
    """

    def __init__(self, method: str = "BDF", max_step: float = 0.0) -> None:
        if method not in STIFF_METHODS:
            raise ValueError(
                f"{method!r} is not a stiff-capable method; use one of "
                f"{', '.join(STIFF_METHODS)}. A feed system with a fast valve "
                "and a slow bottle is stiff by construction."
            )
        self.method = method
        self.max_step = max_step

    @property
    def name(self) -> str:
        return f"scipy:{self.method}"

    def integrate(
        self,
        rhs: Callable[[float, np.ndarray], np.ndarray],
        y0: np.ndarray,
        t_span: tuple[float, float],
        t_eval: Sequence[float],
        *,
        breakpoints: Sequence[float] = (),
        rtol: float = 1e-6,
        atol: float = 1e-9,
    ) -> tuple[np.ndarray, np.ndarray, bool, str, int]:
        # Command edges become a step ceiling. An adaptive stepper that strides
        # over a valve opening reports a perfectly converged, completely wrong
        # answer; bounding the step by the shortest gap between edges is
        # cheaper and more reliable than hoping the error controller notices.
        max_step = self.max_step
        edges = sorted(set(breakpoints))
        if len(edges) > 1:
            gaps = [b - a for a, b in zip(edges, edges[1:]) if b > a]
            if gaps:
                suggested = min(gaps) / 4.0
                max_step = suggested if max_step <= 0.0 else min(max_step, suggested)

        solution = solve_ivp(
            rhs,
            t_span,
            y0,
            method=self.method,
            t_eval=list(t_eval),
            rtol=rtol,
            atol=atol,
            max_step=max_step if max_step > 0.0 else np.inf,
        )
        return (
            solution.t,
            solution.y,
            bool(solution.success),
            str(solution.message),
            int(solution.nfev),
        )


def simulate(
    system: TransientSystem,
    *,
    integrator: Integrator | None = None,
    samples: int = 200,
    rtol: float = 1e-6,
    atol: float = 1e-9,
) -> TransientResult:
    """Run a scenario and audit the result.

    Args:
        system: The coupled network and vessels.
        integrator: Defaults to SciPy BDF.
        samples: How many points to record. Output resolution only; it does
            not constrain the steps the integrator actually takes.
        rtol, atol: Integrator tolerances.

    Raises:
        TransientError: the algebraic network solve failed at some time, with
            that time and the labelled state it failed at.
    """
    import time as _time

    engine = integrator or SciPyIntegrator()
    scenario: Scenario = system.scenario
    started = _time.perf_counter()

    y0 = system.initial_state()
    t_eval = [float(t) for t in np.linspace(0.0, scenario.duration, samples)]

    times, states, success, message, evaluations = engine.integrate(
        system.rhs,
        y0,
        (0.0, scenario.duration),
        t_eval,
        breakpoints=scenario.switch_times,
        rtol=rtol,
        atol=atol,
    )

    recorded = [system.sample(float(t), states[:, i]) for i, t in enumerate(times)]
    elapsed = _time.perf_counter() - started

    # Evaluated at each branch's own peak flow, not at whatever the last
    # sample happened to be. The inertial timescale goes as 1/mdot, so reading
    # it while a valve is closing reports a huge number that is technically
    # true and tells you nothing -- the question is whether the assumption
    # holds where the flow actually is.
    timescales = _timescales_at_peak_flow(system, recorded)

    return TransientResult(
        samples=recorded,
        converged=success,
        method=engine.name,
        steps=len(times),
        rhs_evaluations=evaluations,
        elapsed=elapsed,
        conservation=_audit(system, y0, states[:, -1] if states.size else y0, recorded),
        inertial_timescales=timescales,
        state_labels=system.layout.labels,
        message=message,
        stack=stack_versions(),
    )


def _timescales_at_peak_flow(
    system: TransientSystem, samples: Sequence[TransientSample]
) -> dict[str, float]:
    """Per-branch inertial timescale, taken at that branch's busiest moment."""
    peak: dict[str, tuple[float, TransientSample]] = {}
    for sample in samples:
        for branch_id, mdot in sample.flows.items():
            best = peak.get(branch_id)
            if best is None or abs(mdot) > best[0]:
                peak[branch_id] = (abs(mdot), sample)

    out: dict[str, float] = {}
    for branch_id, (_, sample) in peak.items():
        taus = system.inertial_timescales_from(sample)
        if branch_id in taus:
            out[branch_id] = taus[branch_id]
    return out


def _audit(
    system: TransientSystem,
    y0: np.ndarray,
    y_end: np.ndarray,
    samples: Sequence[TransientSample],
) -> ConservationAudit:
    """Total mass that entered and left, against the change in inventory.

    Inventory is read from the state vector directly -- every slot whose name
    ends in ``mass`` -- rather than from the vessels, so the audit checks the
    integrator rather than trusting the same objects that produced the answer.

    Boundary flow is integrated by the trapezoid rule over the *recorded*
    samples, so the residual has two sources and which one dominates depends on
    the run. A smooth blowdown is limited by the **integrator's tolerance** --
    adding samples changes nothing and tightening ``rtol`` moves it by orders of
    magnitude. A run with a fast valve inside a slow burn is limited by this
    **quadrature** instead, and there adding samples is what helps.

    Either way this is a check on gross bookkeeping -- a sign error, a
    double-counted branch, a vessel wired backwards -- and it is reported as a
    number rather than a pass so that the binding source can be identified
    rather than guessed at.
    """
    labels = system.layout.labels
    mass_rows = [i for i, name in enumerate(labels) if name.endswith("mass")]
    change = float(sum(y_end[i] - y0[i] for i in mass_rows))

    boundary_nodes = {c.node for c in system.couplings}
    inflow = 0.0
    outflow = 0.0
    for a, b in zip(samples, samples[1:]):
        dt = b.t - a.t
        for branch_id, branch in system.network.branches.items():
            up_out = branch.upstream not in boundary_nodes
            dn_out = branch.downstream not in boundary_nodes
            if up_out == dn_out:
                continue  # internal, or vessel-to-vessel: not a boundary
            mean = 0.5 * (a.flows.get(branch_id, 0.0) + b.flows.get(branch_id, 0.0))
            leaving = mean if dn_out else -mean
            if leaving >= 0.0:
                outflow += leaving * dt
            else:
                inflow += -leaving * dt
    return ConservationAudit(mass_in=inflow, mass_out=outflow, mass_change=change)
