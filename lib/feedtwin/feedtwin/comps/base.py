"""What every hydraulic component is, and how one gets built.

Each component exposes its physics **twice**, and the split is deliberate.

``pressure_drop(mdot, flow)`` is the causal form: given a mass flow and the
fluid's state, what is the loss. Most liquid plumbing genuinely is this -- a
pipe's Δp is a function of ṁ -- and it is the form that can be checked against a
worked example in a book without a solver in the way. Every validation test in
this phase calls it.

``residuals(ctx)`` is the acausal form the network solver will consume, and it
is derived from the first for simple components. Components whose behaviour is
*not* a function -- a check valve with a discrete open state, a regulator whose
poppet has its own dynamics -- override it.

The protocol is still provisional (see :mod:`feedtwin.model.component`). Phase
04 assembles a real Jacobian against it and is expected to reshape it. Keeping
the physics in ``pressure_drop`` is what makes that cheap: when the solver
interface moves, this module's ``residuals`` adapters move and no correlation
is touched.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Mapping, Sequence

from feedtwin.model.component import ComponentInstance, EvalContext, PortState
from feedtwin.model.spec import SpecError

R_UNIVERSAL = 8.31446261815324
"""Universal gas constant [J/(mol.K)], CODATA 2018.

Lives here rather than in :mod:`feedtwin.comps.gas`, where it was, because
:mod:`feedtwin.comps.elements` needs it and ``gas`` imports ``elements`` -- so
reaching it from there meant a function-level import, executed on **every**
call to ``conditions_from_fluid``. That is 1.6 million import statements in a
two-second burn, which Python resolves quickly but not freely. ``base`` is
below both of them and imports neither, so from here it is a plain module-level
name for everybody. Re-exported from ``gas`` for anyone who imported it there.
"""


class InfeasibleOperatingPoint(ValueError):
    """The requested flow cannot pass at the given upstream pressure.

    A real physical answer, not a numerical accident: a correlation that has to
    solve for a downstream pressure will fail to bracket when the only solution
    is negative. Left untranslated it surfaces from inside ``fluids`` as a
    bracketing error several frames down, which tells a solver author nothing.
    Phase 04 will want to catch this and back off a step rather than abort.
    """

    def __init__(self, component: str, mdot: float, p_upstream: float) -> None:
        super().__init__(
            f"{component}: {mdot:.6g} kg/s cannot pass with only "
            f"{p_upstream / 1e5:.4g} bar upstream -- the required downstream "
            "pressure is below zero. Either the flow is too high, the "
            "restriction too small, or the upstream pressure too low."
        )
        self.mdot = mdot
        self.p_upstream = p_upstream


@dataclass(frozen=True, slots=True)
class FlowConditions:
    """The fluid state a component needs to evaluate its loss.

    Passed in rather than looked up: a component should not own a
    :class:`~feedtwin.props.Fluid`, because the same length of tube can carry
    LOX on one run and water on the next, and because it keeps the physics
    testable with two floats instead of an equation of state.
    """

    rho: float
    """Density [kg/m^3]."""

    mu: float
    """Dynamic viscosity [Pa.s]."""

    p_upstream: float
    """Static pressure at the inlet [Pa]. Needed wherever choking or cavitation
    depends on absolute level, not just on the drop."""

    p_sat: float = 0.0
    """Saturation pressure at the inlet temperature [Pa]. Zero disables the
    cavitation and choking checks, which is right for a gas and wrong for a
    cryogen -- pass the real value."""

    p_crit: float = 0.0
    """Thermodynamic critical pressure [Pa]. Required by the IEC 60534 choked
    liquid flow correlation."""

    temperature: float = 0.0
    """Static temperature at the inlet [K]. Zero means unknown, which the gas
    components fall back from; the liquid ones never look."""

    gamma: float = 0.0
    """Heat capacity ratio cp/cv. Needed for choking; zero means unknown."""

    r_specific: float = 0.0
    """Specific gas constant R/M [J/(kg.K)]. Needed for choked mass flow."""

    signals: Mapping[str, float] = field(default_factory=dict)
    """Control inputs -- ``{"command": 0.4}`` for a part-open valve."""

    def signal(self, name: str, default: float = 1.0) -> float:
        return float(self.signals.get(name, default))


@dataclass(frozen=True, slots=True)
class Violation:
    """A design limit this component's configuration breaks.

    Reported rather than raised. A bend tighter than the tube's minimum radius
    is buildable -- somebody will build it -- and the model should still solve
    so you can see what it costs, while saying clearly that the hardware is out
    of spec. Raising would force a choice between modelling reality and
    modelling the rules.

    Phase 15's constraint API generalises this: MEOP, NPSH margin, injector
    stiffness and structural limits are the same shape of statement.
    """

    component: str
    limit: str
    detail: str
    severity: str = "error"
    """``error`` for a violated hardware limit, ``warning`` for a margin worth
    knowing about."""

    def __str__(self) -> str:
        return f"[{self.severity}] {self.component} ({self.limit}): {self.detail}"


class HydraulicComponent:
    """Base for a component whose loss is a function of flow.

    Subclasses implement :meth:`pressure_drop` and, optionally,
    :meth:`diagnostics`. Everything else -- the residual adapter, parameter
    resolution, reporting -- comes from here.
    """

    #: Ports, in the order residuals index them.
    inlet_port = "inlet"
    outlet_port = "outlet"

    def __init__(self, instance: ComponentInstance) -> None:
        self.instance = instance
        # Resolved once, in canonical units. Nothing in an inner loop should be
        # converting a unit or looking one up.
        self.p = instance.si_params()
        self.opt = dict(instance.options)

    @property
    def id(self) -> str:
        return self.instance.id

    @property
    def type(self) -> str:
        return self.instance.type

    # ------------------------------------------------------------ the physics

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        """Flow-dependent pressure loss [Pa]. Always non-negative.

        A *loss*: it opposes the flow, so it lowers the downstream pressure
        whichever way the fluid is going. Reverse flow is each component's own
        business -- symmetric for a pipe, very much not for a check valve.

        Anything that does **not** depend on the direction of flow belongs in
        :meth:`static_head`, not here. See that method for why the distinction
        is load-bearing rather than tidy.
        """
        raise NotImplementedError(f"{type(self).__name__} has no pressure_drop")

    def static_head(self, flow: FlowConditions) -> float:
        """Flow-independent pressure change [Pa], signed. Zero for most things.

        Elevation is the case that matters: ``rho g dz`` is set by where the
        ends of a pipe are, and does not care which way the fluid is going. A
        loss reverses sign with the flow; a static head does not.

        Conflating the two is silently wrong exactly when it is hardest to
        notice -- a network where a branch reverses, which is any recirculation
        loop, any vent path, and most transients. Getting it wrong puts the
        answer out by ``2 rho g dz`` on that branch, with everything still
        converging and conserving mass.
        """
        return 0.0

    def total_dp(self, mdot: float, flow: FlowConditions) -> float:
        """The pressure change a solver needs: ``p_upstream - p_downstream``.

        Loss with the sign of the flow, plus static head with its own sign.
        This is what network assembly consumes; :meth:`pressure_drop` is what
        the validation tests check against published results.
        """
        loss = self.pressure_drop(mdot, flow)
        signed = loss if mdot >= 0.0 else -loss
        return signed + self.static_head(flow)

    def signal(self, flow: FlowConditions, name: str, default: float = 1.0) -> float:
        """One control input for *this* component.

        Looks for ``"<this component's id>.<name>"`` first and falls back to a
        bare ``"<name>"``. The qualified form is what a scenario with two main
        valves needs -- reading an unqualified ``"command"`` means every valve
        in the network moves together, which converges perfectly and models a
        system nobody built. The bare fallback is kept so a single-actuator
        test can stay terse.
        """
        qualified = flow.signals.get(f"{self.id}.{name}")
        if qualified is not None:
            return float(qualified)
        return flow.signal(name, default)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        """Derived quantities worth reporting: velocity, Reynolds number, K.

        Never consumed by a solver. This is what a frame and a report show, and
        what makes a result inspectable rather than just a number.
        """
        return {}

    # ------------------------------------------------------ isolation

    def isolates(self, signals: Mapping[str, float] | None = None) -> bool:
        """Whether this component is commanded fully shut.

        Load-bearing for the solver, not a report. A shut valve used to be
        modelled as a very small ``Cv`` on the reasoning that a real seat leaks
        and that an exactly-zero capacity makes the network singular. Both
        halves of that were wrong in the way that matters.

        A branch with a nearly-zero capacity has a nearly-zero derivative, so
        Newton cannot move its row: the solve stalls with the residual parked
        just above tolerance, and the pressures either side of a shut valve come
        back somewhere in between rather than held. On a stand where most valves
        are shut most of the time -- which is every stand, most of the time --
        that is most of the network.

        Reported shut, the branch is *removed* from the unknowns and its ends
        are peeled as ordinary stubs, which is both what the hardware does and
        what the numerics want. Seat leakage is a real effect and belongs in a
        leak-rate model that runs when somebody asks about it, not in the
        conditioning of every solve.
        """
        return False

    # ------------------------------------------------------- choking

    def flow_ceiling(self, flow: FlowConditions) -> float | None:
        """Largest mass flow this component can pass [kg/s], or ``None``.

        ``None`` means "no ceiling", which is true of every liquid component
        here and of any gas element below its critical pressure ratio.

        A ceiling changes what equation the network solver writes for this
        branch, which is why it lives on the base class rather than inside the
        one component that has one. See :meth:`is_choked`.
        """
        return None

    def is_choked(self, dp_available: float, flow: FlowConditions) -> bool:
        """Whether ``dp_available`` puts this component past its choking point.

        Load-bearing for the solver, not just a report. A branch's usual
        equation is ``(p_up - p_dn) - dp(mdot) = 0``, which presumes the drop
        is a function of the flow. Past choking it is not: mass flow stops
        depending on downstream pressure entirely, and the drop can be anything
        at or above the critical value. The relation is no longer invertible
        and Newton, asked to invert it anyway, runs away -- which is exactly
        what a relief valve venting to atmosphere does to a naive solver.

        When this returns true the solver writes ``mdot = flow_ceiling``
        instead, and reports the branch as choked.
        """
        return False

    def check(self) -> list[Violation]:
        """Design limits this component's configuration breaks.

        Configuration only -- nothing here depends on the operating point, so it
        can be run the moment a network is loaded and long before it is solved.
        Bend radius is the case that motivated it: a line bent tighter than its
        tube allows is a fabrication problem, and finding out at the bender is
        expensive.
        """
        return []

    # ------------------------------------------------- the provisional protocol

    @property
    def n_residuals(self) -> int:
        return 1

    def residuals(self, ctx: EvalContext) -> Sequence[float]:
        """``(p_in - p_out) - dp(mdot) = 0``.

        Requires ``conditions`` to have been provided, because the fluid state
        is not in the context yet -- Phase 04 decides how a solver supplies it.
        """
        if len(ctx.ports) < 2 or not ctx.flows:
            raise SpecError(
                f"{self.id}: residuals need two ports and one flow, got "
                f"{len(ctx.ports)} and {len(ctx.flows)}"
            )
        flow = self.conditions(ctx.ports[0], ctx.signals)
        mdot = ctx.flows[0]
        return [(ctx.ports[0].p - ctx.ports[1].p) - self.total_dp(mdot, flow)]

    def outputs(self, ctx: EvalContext) -> Mapping[str, float]:
        flow = self.conditions(ctx.ports[0], ctx.signals)
        return self.diagnostics(ctx.flows[0] if ctx.flows else 0.0, flow)

    #: Turns a port state into fluid conditions. Injected at build time; Phase
    #: 04 supplies the real one from the network's fluid assignment.
    conditions_provider: (
        Callable[[PortState, Mapping[str, float]], FlowConditions] | None
    ) = None

    def conditions(
        self, port: PortState, signals: Mapping[str, float]
    ) -> FlowConditions:
        if self.conditions_provider is None:
            raise SpecError(
                f"{self.id}: no conditions provider. A component evaluated through "
                "residuals() needs one to turn a port state into fluid properties; "
                "call pressure_drop() directly to evaluate it standalone."
            )
        return self.conditions_provider(port, signals)

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.id!r})"


#: Builds a component from its configuration.
Builder = Callable[[ComponentInstance], HydraulicComponent]

_BUILDERS: dict[tuple[str, str], Builder] = {}


def register_builder(type_name: str, model: str, builder: Builder) -> None:
    """Register the physics for one (component type, fidelity model) pair.

    Keyed on both because that pair is exactly what a fidelity model *is*: an
    orifice evaluated with a fixed discharge coefficient and the same orifice
    evaluated through ISO 5167 are different physics behind one declaration.
    """
    _BUILDERS[(type_name, model)] = builder


def build_component(instance: ComponentInstance) -> HydraulicComponent:
    """Build the physics for a configured component.

    Raises:
        SpecError: no implementation is registered for that type and model --
            which is the honest failure when a schema declares a model that
            Phase 03 has not implemented yet.
    """
    key = (instance.type, instance.model)
    builder = _BUILDERS.get(key)
    if builder is None:
        available = sorted(m for t, m in _BUILDERS if t == instance.type)
        raise SpecError(
            f"{instance.id}: no implementation for {instance.type!r} model "
            f"{instance.model!r}. Implemented models for that type: "
            f"{', '.join(available) or '(none)'}"
        )
    return builder(instance)


def registered_builders() -> list[tuple[str, str]]:
    return sorted(_BUILDERS)
