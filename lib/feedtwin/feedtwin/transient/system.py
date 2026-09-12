"""The coupled system: vessels integrate, the network is solved inside them.

This is a semi-explicit index-1 DAE, and it is solved in the shape that reuses
Phase 04 rather than rewriting it:

.. code-block:: text

    differential :  dx/dt = f(x, y, t)     vessel masses, energies, inventories
    algebraic    :  0     = g(x, y, t)     the steady network solve

At each right-hand-side evaluation the vessel states set the boundary pressures,
the network is solved to convergence for its flows, and those flows come back as
the vessels' inflows and outflows. The algebraic constraint is satisfied
*exactly* at every step rather than being carried as extra unknowns with their
own error control.

Why nested rather than monolithic
---------------------------------
A monolithic formulation carries node pressures as algebraic unknowns inside the
integrator's state and asks it to satisfy the constraint to a tolerance. That is
the textbook approach and it is better when the algebraic system is hard to solve
on its own. Here it is not -- Phase 04 already solves it robustly, with row
scaling and damped Newton -- and nesting buys three things worth having: the
constraint is never *approximately* satisfied, the integrator's state stays small
and its Jacobian dense-but-tiny, and a failure to converge is reported as a
network failure at a known time rather than as a mysterious step rejection.

What is assumed, and how you check it
-------------------------------------
Nesting assumes the network reaches its steady flow much faster than the vessels
change -- **quasi-steady**. For liquid lines that is a claim about fluid
inertance, and it is a strong one: 2 m of 3/8 in. LOX line flowing 1.5 kg/s has
an inertial time constant near **9 ms** against a burn of seconds. But it is
still an assumption, so :attr:`TransientResult.inertial_timescales` reports the
per-branch number on every run. If one approaches the timescale of the transient
being modelled, the answer is not to shrink the step; it is that this
formulation no longer applies to that branch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Mapping, Sequence

import numpy as np

from feedtwin.comps import HydraulicComponent
from feedtwin.engine.component import EngineCoupling
from feedtwin.solve.network import Network
from feedtwin.solve.steady import ConvergenceError, SteadyResult, solve_steady
from feedtwin.transient.scenario import Scenario
from feedtwin.transient.state import StateLayout, StateOwner
from feedtwin.transient.vessels import GasVolumeOwner, TankOwner


class TransientError(RuntimeError):
    """The transient failed, with the time and state it failed at.

    Carries both because a DAE failure without them is nearly undebuggable:
    the useful question is always "what was the system doing when it gave up",
    and the answer is a labelled state vector at a known time.
    """

    def __init__(self, t: float, state: Mapping[str, float], detail: str) -> None:
        lines = "\n".join(f"    {k} = {v:.6g}" for k, v in state.items())
        super().__init__(f"transient failed at t = {t:.6g} s: {detail}\n{lines}")
        self.t = t
        self.state = dict(state)


@dataclass(frozen=True, slots=True)
class Coupling:
    """How one vessel is wired to the network.

    Args:
        owner: The vessel.
        node: Network node whose pressure the vessel sets.
        outflow_branches: Branches that draw *from* this vessel. Sign
            convention: positive branch flow leaves the vessel when the vessel's
            node is that branch's upstream end, which the system checks rather
            than trusting.
        liquid: Whether flow through those branches is the tank's liquid (as
            opposed to its ullage gas). Meaningless for a plain gas volume.
    """

    owner: StateOwner
    node: str
    outflow_branches: tuple[str, ...] = ()
    liquid: bool = False


@dataclass(frozen=True, slots=True)
class TransientSample:
    """One instant of a run: everything worth plotting."""

    t: float
    pressures: dict[str, float]
    flows: dict[str, float]
    vessels: dict[str, dict[str, float]]
    signals: dict[str, float]
    mass_residual: float
    newton_iterations: int
    engine: dict[str, float] = field(default_factory=dict)
    """Chamber pressure, both flow rates, O/F, chamber temperature, thrust and
    Isp -- empty when the system has no engine on the end of it."""


class TransientSystem:
    """A network plus the vessels that drive it, ready to integrate.

    Args:
        network: The plumbing. Nodes driven by vessels must exist and are
            converted to fixed-pressure boundaries automatically.
        couplings: Which vessel drives which node, and which branches draw
            from it.
        scenario: The command timeline.
        network_tolerance: Convergence tolerance for the inner network solve,
            on the row-scaled residual. Looser than a standalone solve's
            ``1e-6`` on purpose. A transient spends real time with a valve
            almost shut, and a nearly-shut branch sits on the derivative floor
            where a finite-difference Jacobian simply cannot drive its residual
            lower -- the solve then grinds for a hundred iterations and fails at
            something like ``1.2e-6``. Against a 4.5 MPa system this default is
            about 45 Pa, which is far inside anything physically meaningful and
            inside what the Jacobian can actually deliver. Tighten it for a
            standalone steady answer, where nothing is half-shut.
    """

    def __init__(
        self,
        network: Network,
        couplings: Sequence[Coupling],
        scenario: Scenario,
        engine: "EngineCoupling | None" = None,
        network_tolerance: float = 1.0e-5,
    ) -> None:
        self.network = network
        self.couplings = list(couplings)
        self.scenario = scenario
        self.engine = engine
        self.network_tolerance = network_tolerance
        # One owner, possibly several attachments: a tank is coupled to the
        # network twice -- once at its ullage, where pressurant arrives, and
        # once at its outlet, where propellant leaves -- and it is still one
        # set of differential states. Deduplicated by identity, in declaration
        # order, so the state vector is stable across rebuilds.
        self.state_owners: list[StateOwner] = []
        for coupling in self.couplings:
            if not any(coupling.owner is o for o in self.state_owners):
                self.state_owners.append(coupling.owner)
        self.layout = StateLayout(self.state_owners)

        for coupling in self.couplings:
            if coupling.node not in network.nodes:
                raise ValueError(
                    f"vessel {coupling.owner.id!r} drives node "
                    f"{coupling.node!r}, which is not in the network; nodes "
                    f"are: {', '.join(sorted(network.nodes))}"
                )
            for branch_id in coupling.outflow_branches:
                if branch_id not in network.branches:
                    raise ValueError(
                        f"vessel {coupling.owner.id!r} lists unknown outflow "
                        f"branch {branch_id!r}"
                    )
                branch = network.branches[branch_id]
                if coupling.node not in (branch.upstream, branch.downstream):
                    raise ValueError(
                        f"branch {branch_id!r} is listed as an outflow of "
                        f"{coupling.owner.id!r} but does not touch its node "
                        f"{coupling.node!r} -- it runs "
                        f"{branch.upstream!r} to {branch.downstream!r}"
                    )

        # Cache of the last successful solve, so a failed Newton can report
        # the last good operating point rather than nothing.
        self._last_solve: SteadyResult | None = None

    # ------------------------------------------------------------ the coupling

    def _vessel_pressure(self, coupling: Coupling) -> float:
        owner = coupling.owner
        if coupling.liquid and isinstance(owner, TankOwner):
            return owner.outlet_pressure()
        if isinstance(owner, (TankOwner, GasVolumeOwner)):
            return owner.pressure()
        raise TypeError(f"{owner!r} does not expose a pressure")

    def _signed_outflow(self, coupling: Coupling, flows: Mapping[str, float]) -> float:
        """Mass leaving this vessel through its branches [kg/s].

        Signed by topology rather than by convention: a branch whose upstream
        end is the vessel's node carries positive flow *away*; one whose
        downstream end is the vessel's node carries positive flow *toward* it.
        Getting this wrong is the classic way to build a system that fills a
        bottle by draining it, and it converges perfectly while doing so.
        """
        total = 0.0
        for branch_id in coupling.outflow_branches:
            branch = self.network.branches[branch_id]
            sign = 1.0 if branch.upstream == coupling.node else -1.0
            total += sign * flows.get(branch_id, 0.0)
        return total

    def apply_state(self, t: float, vector: np.ndarray) -> SteadyResult:
        """Push a state into the vessels, solve the network, wire flows back."""
        self.layout.unpack(vector)

        for coupling in self.couplings:
            node = self.network.nodes[coupling.node]
            node.pressure = self._vessel_pressure(coupling)

        signals = self.scenario.signals_at(t)
        try:
            result = (
                self._solve_with_engine(t, vector, signals)
                if self.engine is not None
                else self._solve_network(signals)
            )
        except ConvergenceError as exc:
            raise TransientError(
                t,
                self.layout.unpack_named(vector),
                f"the network solve did not converge ({exc})",
            ) from exc

        for coupling in self.couplings:
            outflow = self._signed_outflow(coupling, result.flows)
            owner = coupling.owner
            if isinstance(owner, TankOwner):
                if coupling.liquid:
                    owner.mdot_liquid_out = outflow
                else:
                    owner.mdot_gas_in = -outflow
                    if outflow < 0.0:
                        source = self._inflow_enthalpy(coupling, result)
                        if source is not None:
                            owner.enthalpy_gas_in = source
            elif isinstance(owner, GasVolumeOwner):
                owner.mdot_out = outflow

        self._last_solve = result
        return result

    #: How far the inner solve may back off before giving up, and how many
    #: times. An implicit integrator does not only ask about states the system
    #: passes through -- it probes, perturbing each state variable to build its
    #: Jacobian, and some of those probes are numerically nastier than anything
    #: the run actually visits. Failing the whole run because one probe was
    #: hard throws away a trajectory that was solving perfectly either side of
    #: it. Backing off is safe because it is only the *inner* algebraic solve
    #: being relaxed: mass conservation is audited independently, end to end,
    #: and reported whatever happens here.
    RETRY_FACTORS = (1.0,)

    def _solve_network(self, signals: Mapping[str, float]) -> SteadyResult:
        """Solve the network, backing the tolerance off rather than giving up."""
        last: ConvergenceError | None = None
        for factor in self.RETRY_FACTORS:
            try:
                return solve_steady(
                    self.network,
                    signals=signals,
                    tol=self.network_tolerance * factor,
                )
            except ConvergenceError as exc:
                last = exc
        assert last is not None
        raise last

    def _solve_with_engine(
        self, t: float, vector: np.ndarray, signals: Mapping[str, float]
    ) -> SteadyResult:
        """Iterate the network and the chamber to a common pressure.

        Chamber pressure sets the injector's pressure difference, which sets the
        flows, which set chamber pressure. Neither side can be evaluated without
        the other, so the loop is closed here by under-relaxed iteration around
        the whole feed system -- the same coupled injector-to-chamber solve
        EngineDesign does across two pressures, done across a network.

        Non-convergence is reported rather than raised. A chamber loop that will
        not settle is a design finding -- an injector too soft for its feed
        system -- and the last iterate is more useful to look at than an
        exception.
        """
        engine = self.engine
        assert engine is not None
        node = self.network.nodes[engine.node]
        guess = node.pressure if node.pressure is not None else 1.0e5

        # Solved by secant on ``f(p) = g(p) - p``, where ``g`` is "run the
        # network at this chamber pressure and see what chamber pressure the
        # resulting flows imply". Plain under-relaxation converges linearly and
        # wants twenty-odd network solves per RHS evaluation; an implicit
        # integrator calls the RHS ten thousand times over a burn, so linear is
        # the difference between a run taking seconds and taking minutes. The
        # map is smooth and nearly affine in pressure, which is exactly the
        # case secant is for.
        result = solve_steady(self.network, signals=signals, tol=self.network_tolerance)
        engine.converged = False
        previous: tuple[float, float] | None = None

        for iteration in range(1, engine.max_iterations + 1):
            node.pressure = guess
            result = self._solve_network(signals)
            mdot_ox = self._into_chamber(engine.oxidiser_branch, engine.node, result)
            mdot_fuel = self._into_chamber(engine.fuel_branch, engine.node, result)
            implied = engine.evaluate(mdot_ox, mdot_fuel)

            residual = implied - guess
            engine.iterations = iteration
            if abs(residual) <= engine.tolerance * max(guess, 1.0):
                engine.converged = True
                break

            step: float | None = None
            if previous is not None:
                p_prev, f_prev = previous
                slope = (
                    (residual - f_prev) / (guess - p_prev) if guess != p_prev else 0.0
                )
                # A slope at or above +1 means the iteration is expansive there;
                # fall back rather than take a step pointing the wrong way.
                if slope < 0.5:
                    step = -residual / (slope - 1.0)
            previous = (guess, residual)

            if step is None or not math.isfinite(step):
                step = engine.relaxation * residual
            guess = max(guess + step, engine.chamber.ambient_pressure)

        node.pressure = guess
        return result

    def _into_chamber(self, branch_id: str, node: str, result: SteadyResult) -> float:
        """Mass flow arriving at the chamber node through one branch [kg/s]."""
        branch = self.network.branches[branch_id]
        sign = 1.0 if branch.downstream == node else -1.0
        return max(sign * result.flows.get(branch_id, 0.0), 0.0)

    def _inflow_enthalpy(
        self, coupling: Coupling, result: SteadyResult
    ) -> float | None:
        """Specific enthalpy of gas arriving at a tank [J/kg].

        Taken from the *upstream* node's own conditions, not from the tank's.
        Warm pressurant into a cold ullage is a heat source, and using the
        ullage's own enthalpy here would silently delete that term -- which is
        the mechanism behind half of what a pressurisation system does.
        """
        for branch_id in coupling.outflow_branches:
            branch = self.network.branches[branch_id]
            other = (
                branch.downstream
                if branch.upstream == coupling.node
                else branch.upstream
            )
            node = self.network.nodes.get(other)
            if node is None:
                continue
            fluid = self.network.fluid(node.fluid)
            pressure = result.pressures.get(other)
            if pressure is None or pressure <= 0.0:
                continue
            return fluid.get("h", p=pressure, T=node.temperature)
        return None

    # ------------------------------------------------------------------ the RHS

    def rhs(self, t: float, vector: np.ndarray) -> np.ndarray:
        """``dx/dt`` for the integrator. Solves the network on the way through."""
        self.apply_state(t, vector)
        return self.layout.derivatives(t)

    def initial_state(self) -> np.ndarray:
        return self.layout.pack()

    def sample(self, t: float, vector: np.ndarray) -> TransientSample:
        """Everything worth recording at one instant."""
        result = self.apply_state(t, vector)
        return TransientSample(
            t=t,
            pressures=dict(result.pressures),
            flows=dict(result.flows),
            vessels={
                c.owner.id: c.owner.outputs()  # type: ignore[attr-defined]
                for c in self.couplings
            },
            signals=self.scenario.signals_at(t),
            mass_residual=result.max_mass_residual,
            newton_iterations=result.iterations,
            engine=self.engine.outputs() if self.engine is not None else {},
        )

    # -------------------------------------------------------------- diagnostics

    def inertial_timescales_from(self, sample: TransientSample) -> dict[str, float]:
        """:meth:`inertial_timescales` for one recorded instant."""
        return self._timescales(sample.pressures, sample.flows)

    def inertial_timescales(self, result: SteadyResult) -> dict[str, float]:
        """Per-branch ``I / (d dp/d mdot)`` [s]: how long flow takes to establish.

        The quasi-steady assumption's own error bar. A branch whose timescale
        approaches the transient being modelled is one this formulation cannot
        represent, and the honest response is to say so rather than to reduce
        the step size, which changes nothing.

        Branches with no length -- an orifice, a fitting -- have no meaningful
        inertance and are omitted rather than reported as zero.
        """
        return self._timescales(result.pressures, result.flows)

    def _timescales(
        self, pressures: Mapping[str, float], flows: Mapping[str, float]
    ) -> dict[str, float]:
        out: dict[str, float] = {}
        for branch_id, branch in self.network.branches.items():
            component: HydraulicComponent = branch.component
            length = component.p.get("length", 0.0)
            bore = component.p.get("bore", 0.0)
            if length <= 0.0 or bore <= 0.0:
                continue
            area = math.pi * bore * bore / 4.0
            inertance = length / area

            mdot = flows.get(branch_id, 0.0)
            dp = abs(pressures[branch.upstream] - pressures[branch.downstream])
            if abs(mdot) < 1e-12 or dp <= 0.0:
                continue
            # Quadratic loss: d(dp)/d(mdot) ~ 2 dp / mdot.
            slope = 2.0 * dp / abs(mdot)
            out[branch_id] = inertance / slope
        return out
