"""A configured component, and the shape an evaluable one takes.

Two things here, at different levels of settledness.

:class:`ComponentInstance` is **settled**: one piece of hardware in a network,
with its type, its chosen fidelity model, its validated parameters and what its
ports connect to. It is what a config file deserialises into, what the inspector
edits, and what Phase 03's components are built from. It carries no physics.

:class:`Component` is the protocol those built objects satisfy, and it is
**provisional**. Designing a solver interface before there is a solver is
speculation; it is written down now so Phase 03's components share one shape
rather than three, and it should be expected to move once Phase 04 assembles a
real Jacobian against it. That is said here rather than discovered later.

Why residuals rather than pressure drops
----------------------------------------
The obvious interface is ``dp(mdot) -> float``. It handles a pipe and then
fails, in order, at: a check valve (which has a discrete open/closed state), a
regulator (which has its own poppet dynamics, so its behaviour is an ODE and not
a function), a cavitating venturi (where the relation inverts once choked), and
anything with two flow paths.

Contributing *residuals* to a system -- ``f(port values, flows, states,
derivatives) = 0`` -- covers all of those uniformly, and is the same acausal
formulation Modelica uses for the same reason. The cost is that a component
cannot be evaluated alone, only solved; for a network that was always true.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol, Sequence, runtime_checkable

from feedtwin.model.curve import Curve
from feedtwin.model.param import Param, assumed_params, provenance_summary
from feedtwin.model.segments import LineSegment
from feedtwin.model.spec import ComponentSpec, SpecError, get_component_spec


@dataclass(frozen=True, slots=True)
class PortState:
    """Thermodynamic state at a connection point.

    Pressure and specific enthalpy, because that pair fixes the state on both
    sides of the saturation dome -- pressure and temperature do not, and a feed
    system that never goes two-phase is a feed system that has not been started
    from cold.
    """

    p: float
    """Pressure [Pa]."""

    h: float
    """Specific enthalpy [J/kg]."""


@dataclass(frozen=True, slots=True)
class EvalContext:
    """Everything a component needs to evaluate its residuals once.

    Ports and flows are in the order the component's spec declares them, so a
    component indexes its own ports positionally without looking up names in a
    hot loop.
    """

    ports: tuple[PortState, ...]
    flows: tuple[float, ...]
    """Mass flow through each of the component's flow paths [kg/s], signed
    positive from the first port toward the second."""

    states: tuple[float, ...] = ()
    """Internal dynamic states, in the order the spec declares them."""

    dstates: tuple[float, ...] = ()
    """Time derivatives of ``states``. All zero in a steady solve, which is how
    one component definition serves both steady and transient."""

    signals: Mapping[str, float] = field(default_factory=dict)
    """Control inputs -- a commanded valve position, for instance."""

    t: float = 0.0
    """Time [s]. Zero and meaningless in a steady solve."""


@runtime_checkable
class Component(Protocol):
    """An evaluable component. **Provisional** -- see the module docstring.

    Implementations are built from a :class:`ComponentInstance` and hold their
    parameters as plain floats in canonical units, resolved once at
    construction. Nothing in a residual evaluation should be looking up a unit.
    """

    @property
    def instance(self) -> ComponentInstance:
        """The configuration this was built from."""
        ...

    @property
    def n_residuals(self) -> int:
        """How many equations this contributes to the system."""
        ...

    def residuals(self, ctx: EvalContext) -> Sequence[float]:
        """Residuals, zero when the component's equations are satisfied."""
        ...

    def outputs(self, ctx: EvalContext) -> Mapping[str, float]:
        """Derived quantities worth reporting -- velocity, Reynolds number,
        cavitation index. Never used by the solver; consumed by frames and
        reports."""
        ...


@dataclass(frozen=True, slots=True)
class ComponentInstance:
    """One configured piece of hardware in a network.

    Args:
        id: Unique within a network -- ``"SOL-01"``, ``"PR-01"``. These are the
            tags on the P&ID, deliberately, so a component in a simulation and
            the same component on the drawing have the same name.
        spec: Its declaration.
        model: Which fidelity model to evaluate it at.
        params: Validated parameters, defaults already filled in.
        connections: Port name to network node id.
        part: Catalog part number this was resolved from, if any. Kept for
            traceability: it is how a report can say which physical valve a
            result assumed.
    """

    id: str
    spec: ComponentSpec
    model: str
    params: dict[str, Param]
    curves: dict[str, Curve] = field(default_factory=dict)
    options: dict[str, str] = field(default_factory=dict)
    connections: dict[str, str] = field(default_factory=dict)
    part: str = ""
    segments: tuple[LineSegment, ...] = ()
    """The run itemised, for a line whose drawing broke it into segments.

    Its own field rather than more entries in ``params`` because a segment list
    is a *sequence of heterogeneous records* -- three elbows in a 10 mm bore
    then a reducer then 400 mm of 6 mm -- and flattening that into
    ``length_1``, ``bore_1``, ``fitting_1_kind`` would lose the ordering that
    makes a bore change a reducer. Empty for everything that is not a segmented
    line, which is every component the library shipped with.
    """

    @classmethod
    def build(
        cls,
        id: str,
        type_name: str,
        params: dict[str, Param],
        *,
        curves: dict[str, Curve] | None = None,
        options: dict[str, str] | None = None,
        model: str = "",
        connections: dict[str, str] | None = None,
        part: str = "",
        segments: Sequence[LineSegment] | None = None,
    ) -> ComponentInstance:
        """Validate a configuration and produce an instance from it.

        The only supported way to make one: it runs the spec's validation, so an
        instance that exists is one whose parameters are complete, dimensionally
        sound and within bounds.
        """
        spec = get_component_spec(type_name)
        chosen = model or spec.models[0]
        return cls(
            id=id,
            spec=spec,
            model=chosen,
            params=spec.validate(params, chosen),
            curves=spec.validate_curves(dict(curves or {}), chosen),
            options=spec.validate_options(dict(options or {}), chosen),
            connections=dict(connections or {}),
            part=part,
            segments=tuple(segments or ()),
        )

    @property
    def type(self) -> str:
        return self.spec.type

    def option(self, name: str) -> str:
        """One categorical choice, defaults already resolved."""
        value = self.options.get(name)
        if value is None:
            raise SpecError(
                f"{self.id} ({self.type}) has no option {name!r}. It holds: "
                f"{', '.join(sorted(self.options)) or '(none)'}"
            )
        return value

    def si(self, name: str) -> float:
        """One parameter as a plain float in canonical units."""
        param = self.params.get(name)
        if param is None:
            raise SpecError(
                f"{self.id} ({self.type}) has no value for {name!r}. It holds: "
                f"{', '.join(sorted(self.params)) or '(none)'}"
            )
        return param.si

    def si_params(self) -> dict[str, float]:
        """Every parameter as plain floats -- what a component resolves once."""
        return {name: param.si for name, param in self.params.items()}

    def provenance(self) -> dict[str, int]:
        """How many of this component's parameters came from where."""
        return provenance_summary(self.params)

    def assumptions(self) -> list[str]:
        """Parameters here that nobody has established. Worth reporting."""
        return assumed_params(self.params)

    def unconnected_ports(self) -> list[str]:
        """Fluid ports with nothing attached.

        Not an error on its own -- a network under construction has plenty --
        but a dead end at solve time is a singular system, and naming it here is
        far kinder than a linear-algebra failure later.
        """
        return sorted(
            port.name
            for port in self.spec.ports
            if port.kind == "fluid" and port.name not in self.connections
        )

    # ------------------------------------------------------------ serialisation

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "model": self.model,
            "params": {name: p.to_dict() for name, p in sorted(self.params.items())},
        }
        if self.options:
            data["options"] = dict(sorted(self.options.items()))
        if self.curves:
            data["curves"] = {
                name: c.to_dict() for name, c in sorted(self.curves.items())
            }
        if self.connections:
            data["connections"] = dict(sorted(self.connections.items()))
        if self.part:
            data["part"] = self.part
        return data

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ComponentInstance:
        missing = [k for k in ("id", "type") if k not in data]
        if missing:
            raise SpecError(f"component is missing {', '.join(missing)}: {dict(data)}")

        identifier = str(data["id"])
        raw = data.get("params", {})
        if not isinstance(raw, Mapping):
            raise SpecError(f"{identifier}: 'params' must be a mapping")

        params = {
            name: Param.from_dict(dict(body), where=f"{identifier}.{name}")
            for name, body in raw.items()
        }
        raw_curves = data.get("curves", {})
        if not isinstance(raw_curves, Mapping):
            raise SpecError(f"{identifier}: 'curves' must be a mapping")
        curves = {
            name: Curve.from_dict(dict(body), where=f"{identifier}.{name}")
            for name, body in raw_curves.items()
        }

        return cls.build(
            id=identifier,
            type_name=str(data["type"]),
            params=params,
            curves=curves,
            options={k: str(v) for k, v in dict(data.get("options", {})).items()},
            model=str(data.get("model", "")),
            connections={
                k: str(v) for k, v in dict(data.get("connections", {})).items()
            },
            part=str(data.get("part", "")),
        )

    def __str__(self) -> str:
        return f"{self.id} ({self.type}/{self.model})"
