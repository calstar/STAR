"""What a component *is*, declared as data.

A :class:`ComponentSpec` says what a kind of hardware has: which parameters,
which ports, which internal states, and which fidelity models it can be
evaluated at. It is the single description that three very different things
read:

* **validation** -- is this configuration complete, dimensionally sound, and
  within bounds, before a solver touches it;
* **the property inspector** (Phase 10) -- the panel that appears when someone
  clicks a valve is generated from this, so a new component type arrives with a
  working editor and nobody writes a form;
* **documentation** -- the parameter table for a component is generated, so it
  cannot drift from what the code actually accepts.

Writing those three by hand is how "nothing hardcoded" quietly dies: the physics
grows a parameter, the UI does not, and the only way to set it becomes editing
YAML by hand.

Fidelity models
---------------
One component, several depths. A regulator can be an ideal setpoint, a
tabulated droop curve, a dome force balance, or pure measured data -- the same
hardware at four levels of detail, chosen per instance. Parameters that only one
model needs declare that in :attr:`ParamSpec.models`, so an ``ideal`` regulator
is not asked for a poppet mass it will never use.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from feedtwin.model.curve import Curve, CurveSpec
from feedtwin.model.param import Param, Provenance
from feedtwin.model.units import check_dimension, si_unit_of


class SpecError(ValueError):
    """A component's configuration does not match its declaration."""


class _ModelScoped(Protocol):
    """The shape parameters, curves and options share.

    They are separate types on purpose -- each carries different fields -- but
    all three are named and all three may be restricted to particular fidelity
    models, which is the only thing the cross-checks below need.
    """

    @property
    def name(self) -> str: ...

    @property
    def models(self) -> tuple[str, ...]: ...


@dataclass(frozen=True, slots=True)
class ParamSpec:
    """One parameter a component accepts.

    Args:
        name: Identifier used in configs and code.
        dimension: What it measures -- ``"pressure"``, ``"length"``,
            ``"flow_coefficient"``. Enforced: a value in the wrong kind of unit
            is rejected at load with both dimensions named.
        description: What it is, in a sentence. Shown in the inspector, so it is
            user-facing text and not an implementation note.
        required: Whether a configuration must supply it.
        default: Used when it is absent. A spec that is neither required nor
            defaulted describes an optional parameter with no value, which is
            usually a mistake.
        minimum, maximum: Bounds in canonical units. A bore of -3 mm should fail
            at load rather than inside a Reynolds number.
        models: Fidelity models this parameter applies to. Empty means all of
            them, which is the common case.
    """

    name: str
    dimension: str
    description: str
    required: bool = True
    default: Param | None = None
    minimum: float | None = None
    maximum: float | None = None
    models: tuple[str, ...] = ()

    def applies_to(self, model: str) -> bool:
        return not self.models or model in self.models

    @property
    def si_unit(self) -> str:
        return si_unit_of(self.dimension)


@dataclass(frozen=True, slots=True)
class OptionSpec:
    """A categorical choice a component accepts.

    Parameters are numbers; some configuration is not. Which friction
    correlation to use, which Crane fitting a bend is, whether a valve's
    characteristic is linear or equal-percentage -- all real configuration, none
    of it a float.

    Choices are enumerated, so an invalid one fails at load with the valid set
    listed, and a UI can render a dropdown from the declaration. This is what
    makes "the choice of correlation is a parameter like anything else" true
    rather than aspirational.
    """

    name: str
    choices: tuple[str, ...]
    default: str
    description: str
    models: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.choices:
            raise SpecError(f"option {self.name!r} declares no choices")
        if self.default not in self.choices:
            raise SpecError(
                f"option {self.name!r}: default {self.default!r} is not among "
                f"its choices {list(self.choices)}"
            )

    def applies_to(self, model: str) -> bool:
        return not self.models or model in self.models


@dataclass(frozen=True, slots=True)
class PortSpec:
    """A connection point.

    ``kind`` separates a fluid connection from a control signal: a solenoid's
    two fluid ports carry mass, its command port carries a number from a
    timeline, and the network solver must not confuse them.
    """

    name: str
    description: str
    kind: str = "fluid"


@dataclass(frozen=True, slots=True)
class StateSpec:
    """An internal dynamic state the component owns.

    Empty for most components -- a length of pipe has no memory. A regulator's
    poppet position and a tank's gas mass are states, and declaring them here is
    what lets the transient solver in Phase 07 assemble its state vector from
    the network rather than from a hardcoded list.
    """

    name: str
    dimension: str
    description: str
    initial: Param | None = None


@dataclass(frozen=True, slots=True)
class ComponentSpec:
    """The complete declaration of one kind of component."""

    type: str
    description: str
    params: tuple[ParamSpec, ...] = ()
    ports: tuple[PortSpec, ...] = ()
    states: tuple[StateSpec, ...] = ()
    curves: tuple[CurveSpec, ...] = ()
    options: tuple[OptionSpec, ...] = ()
    models: tuple[str, ...] = ("default",)
    _by_name: dict[str, ParamSpec] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        if not self.models:
            raise SpecError(f"{self.type}: needs at least one fidelity model")

        duplicates = _duplicates([p.name for p in self.params])
        if duplicates:
            raise SpecError(f"{self.type}: duplicate parameters {duplicates}")

        scoped: tuple[_ModelScoped, ...] = (*self.params, *self.curves, *self.options)
        for spec in scoped:
            unknown = set(spec.models) - set(self.models)
            if unknown:
                raise SpecError(
                    f"{self.type}.{spec.name}: refers to unknown model(s) "
                    f"{sorted(unknown)}; declared models are {list(self.models)}"
                )
        # Cache the lookup once; a frozen dataclass has to go through
        # object.__setattr__ to do it.
        object.__setattr__(self, "_by_name", {p.name: p for p in self.params})

    def param(self, name: str) -> ParamSpec:
        try:
            return self._by_name[name]
        except KeyError:
            raise SpecError(
                f"{self.type} has no parameter {name!r}; it accepts: "
                f"{', '.join(sorted(self._by_name))}"
            ) from None

    def params_for(self, model: str) -> tuple[ParamSpec, ...]:
        """Parameters that apply to one fidelity model."""
        return tuple(p for p in self.params if p.applies_to(model))

    def validate(self, given: dict[str, Param], model: str = "") -> dict[str, Param]:
        """Check a configuration and return it with defaults filled in.

        Every check that can be made without solving anything is made here, and
        all failures are reported together rather than one per run -- fixing a
        config six errors at a time beats six edit-run cycles.

        Raises:
            SpecError: unknown or missing parameters, wrong dimensions, or
                values outside declared bounds.
        """
        chosen = model or self.models[0]
        if chosen not in self.models:
            raise SpecError(
                f"{self.type}: unknown model {chosen!r}; available: "
                f"{', '.join(self.models)}"
            )

        problems: list[str] = []
        resolved: dict[str, Param] = {}

        for name in sorted(set(given) - set(self._by_name)):
            problems.append(
                f"  {name!r} is not a parameter of {self.type} "
                f"(accepts: {', '.join(sorted(self._by_name))})"
            )

        for spec in self.params:
            if not spec.applies_to(chosen):
                # Supplying it is harmless -- switching models should not force
                # deleting values -- but it is not resolved, so a model can
                # never silently read a parameter another model owns.
                continue

            param = given.get(spec.name)
            if param is None:
                if spec.default is not None:
                    resolved[spec.name] = spec.default
                elif spec.required:
                    problems.append(
                        f"  {spec.name!r} is required by {self.type}"
                        f"{f' (model {chosen})' if spec.models else ''}"
                        f" and was not given -- {spec.description}"
                    )
                continue

            try:
                check_dimension(
                    param.unit, spec.dimension, f"  {self.type}.{spec.name}"
                )
            except ValueError as exc:
                problems.append(str(exc))
                continue

            problem = _bounds_problem(spec, param, self.type)
            if problem:
                problems.append(problem)
                continue

            resolved[spec.name] = param

        if problems:
            raise SpecError(
                f"{self.type} is not configured correctly:\n" + "\n".join(problems)
            )
        return resolved

    def validate_curves(
        self, given: dict[str, Curve], model: str = ""
    ) -> dict[str, Curve]:
        """Check tabulated data the same way scalars are checked.

        Same three failures as :meth:`validate`: unknown name, missing when
        required, wrong dimension on either axis. A Cv-versus-position curve
        whose x axis is a pressure is exactly as wrong as a scalar bore in psi,
        and should fail in the same place.
        """
        chosen = model or self.models[0]
        by_name = {c.name: c for c in self.curves}
        problems: list[str] = []
        resolved: dict[str, Curve] = {}

        for name in sorted(set(given) - set(by_name)):
            accepted = ", ".join(sorted(by_name)) or "(none)"
            problems.append(
                f"  {name!r} is not a curve of {self.type} (accepts: {accepted})"
            )

        for spec in self.curves:
            if not spec.applies_to(chosen):
                continue
            curve = given.get(spec.name)
            if curve is None:
                if spec.required:
                    problems.append(
                        f"  curve {spec.name!r} is required by {self.type} "
                        f"(model {chosen}) -- {spec.description}"
                    )
                continue
            try:
                curve.check_dimensions(
                    spec.x_dimension, spec.y_dimension, f"  {self.type}.{spec.name}"
                )
            except ValueError as exc:
                problems.append(str(exc))
                continue
            resolved[spec.name] = curve

        if problems:
            raise SpecError(
                f"{self.type} curves are not configured correctly:\n"
                + "\n".join(problems)
            )
        return resolved

    def validate_options(
        self, given: dict[str, str], model: str = ""
    ) -> dict[str, str]:
        """Check categorical choices and fill in defaults."""
        chosen = model or self.models[0]
        by_name = {o.name: o for o in self.options}
        problems: list[str] = []
        resolved: dict[str, str] = {}

        for name in sorted(set(given) - set(by_name)):
            accepted = ", ".join(sorted(by_name)) or "(none)"
            problems.append(
                f"  {name!r} is not an option of {self.type} (accepts: {accepted})"
            )

        for spec in self.options:
            if not spec.applies_to(chosen):
                continue
            value = given.get(spec.name, spec.default)
            if value not in spec.choices:
                problems.append(
                    f"  {self.type}.{spec.name} = {value!r} is not valid; "
                    f"choose one of: {', '.join(spec.choices)}"
                )
                continue
            resolved[spec.name] = value

        if problems:
            raise SpecError(
                f"{self.type} options are not configured correctly:\n"
                + "\n".join(problems)
            )
        return resolved

    def defaults(self, model: str = "") -> dict[str, Param]:
        """Every defaulted parameter for a model. What a new instance starts as."""
        chosen = model or self.models[0]
        return {
            spec.name: spec.default
            for spec in self.params_for(chosen)
            if spec.default is not None
        }

    def to_dict(self) -> dict[str, Any]:
        """A plain-data description -- what the Phase 10 inspector consumes."""
        return {
            "type": self.type,
            "description": self.description,
            "models": list(self.models),
            "ports": [
                {"name": p.name, "kind": p.kind, "description": p.description}
                for p in self.ports
            ],
            "states": [
                {"name": s.name, "dimension": s.dimension, "description": s.description}
                for s in self.states
            ],
            "options": [
                {
                    "name": o.name,
                    "choices": list(o.choices),
                    "default": o.default,
                    "description": o.description,
                    "models": list(o.models),
                }
                for o in self.options
            ],
            "curves": [
                {
                    "name": c.name,
                    "x_dimension": c.x_dimension,
                    "y_dimension": c.y_dimension,
                    "description": c.description,
                    "required": c.required,
                    "models": list(c.models),
                }
                for c in self.curves
            ],
            "params": [
                {
                    "name": p.name,
                    "dimension": p.dimension,
                    "si_unit": p.si_unit,
                    "description": p.description,
                    "required": p.required,
                    "models": list(p.models),
                    "minimum": p.minimum,
                    "maximum": p.maximum,
                    "default": p.default.to_dict() if p.default else None,
                }
                for p in self.params
            ],
        }


def _bounds_problem(spec: ParamSpec, param: Param, type_name: str) -> str | None:
    value = param.si
    unit = spec.si_unit
    if spec.minimum is not None and value < spec.minimum:
        return (
            f"  {type_name}.{spec.name} = {value:g} {unit} is below the minimum "
            f"{spec.minimum:g} {unit}"
        )
    if spec.maximum is not None and value > spec.maximum:
        return (
            f"  {type_name}.{spec.name} = {value:g} {unit} is above the maximum "
            f"{spec.maximum:g} {unit}"
        )
    return None


def _duplicates(names: list[str]) -> list[str]:
    seen: set[str] = set()
    dupes: set[str] = set()
    for name in names:
        (dupes if name in seen else seen).add(name)
    return sorted(dupes)


_SPECS: dict[str, ComponentSpec] = {}


def register_component_spec(spec: ComponentSpec) -> ComponentSpec:
    """Register a component type. Re-registering a name replaces it.

    Phase 03 is expected to re-register the shipped declarations as it
    implements their physics and learns which parameters each model really
    needs; replacing by name is how that happens without a migration.
    """
    _SPECS[spec.type] = spec
    return spec


def get_component_spec(type_name: str) -> ComponentSpec:
    _ensure_loaded()
    try:
        return _SPECS[type_name]
    except KeyError:
        raise SpecError(
            f"unknown component type {type_name!r}; registered: "
            f"{', '.join(sorted(_SPECS)) or '(none)'}. Add one with "
            "feedtwin.model.register_component_spec()."
        ) from None


def registered_component_types() -> list[str]:
    _ensure_loaded()
    return sorted(_SPECS)


_SPECS_FILE = Path(__file__).with_name("components.toml")
_LOADED = False


def _ensure_loaded() -> None:
    """Read the shipped component declarations, once.

    An explicit flag rather than "is the registry empty", for the reason
    :mod:`feedtwin.props.species` learned the hard way: a program whose first
    call registers a component would make the registry non-empty, and every
    shipped declaration would then be silently missing for the rest of the run.
    """
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    load_component_specs(_SPECS_FILE)


def load_component_specs(path: Path) -> list[ComponentSpec]:
    """Load component declarations from a TOML file and register them.

    A component's *schema* is data -- what parameters it takes, what they mean,
    what units they are in, what its ports are. Only its *physics* is code. So
    adding a component type is a data edit, and Phase 03 supplies behaviour
    keyed by type name rather than a parallel set of declarations that can drift
    from it.

    Public, so a project can declare its own components without editing this
    package; later definitions replace earlier ones by type name.
    """
    with path.open("rb") as handle:
        raw = tomllib.load(handle)

    loaded: list[ComponentSpec] = []
    for type_name, body in raw.items():
        if not isinstance(body, dict):
            raise SpecError(
                f"{path}: [{type_name}] must be a table, got {type(body).__name__}"
            )
        loaded.append(register_component_spec(_spec_from_toml(type_name, body)))
    return loaded


def _spec_from_toml(type_name: str, body: dict[str, Any]) -> ComponentSpec:
    models = tuple(str(m) for m in body.get("models", ["default"]))

    ports = tuple(
        PortSpec(
            name=name,
            description=str(
                _table(type_name, "ports", name, spec).get("description", "")
            ),
            kind=str(_table(type_name, "ports", name, spec).get("kind", "fluid")),
        )
        for name, spec in dict(body.get("ports", {})).items()
    )

    states = tuple(
        StateSpec(
            name=name,
            dimension=str(_require(type_name, "states", name, spec, "dimension")),
            description=str(spec.get("description", "")),
            initial=_maybe_param(spec.get("initial"), f"{type_name}.states.{name}"),
        )
        for name, spec in dict(body.get("states", {})).items()
    )

    params = tuple(
        ParamSpec(
            name=name,
            dimension=str(_require(type_name, "params", name, spec, "dimension")),
            description=str(spec.get("description", "")),
            required=bool(spec.get("required", True)),
            default=_maybe_param(spec.get("default"), f"{type_name}.params.{name}"),
            minimum=_maybe_float(spec.get("minimum")),
            maximum=_maybe_float(spec.get("maximum")),
            models=tuple(str(m) for m in spec.get("models", [])),
        )
        for name, spec in dict(body.get("params", {})).items()
    )

    curves = tuple(
        CurveSpec(
            name=name,
            x_dimension=str(_require(type_name, "curves", name, spec, "x_dimension")),
            y_dimension=str(_require(type_name, "curves", name, spec, "y_dimension")),
            description=str(spec.get("description", "")),
            required=bool(spec.get("required", False)),
            models=tuple(str(m) for m in spec.get("models", [])),
        )
        for name, spec in dict(body.get("curves", {})).items()
    )

    options = tuple(
        OptionSpec(
            name=name,
            choices=tuple(
                str(c) for c in _require(type_name, "options", name, spec, "choices")
            ),
            default=str(_require(type_name, "options", name, spec, "default")),
            description=str(spec.get("description", "")),
            models=tuple(str(m) for m in spec.get("models", [])),
        )
        for name, spec in dict(body.get("options", {})).items()
    )

    return ComponentSpec(
        type=type_name,
        description=str(body.get("description", "")),
        params=params,
        ports=ports,
        states=states,
        curves=curves,
        options=options,
        models=models,
    )


def _table(type_name: str, block: str, name: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SpecError(f"{type_name}.{block}.{name} must be a table")
    return value


def _require(type_name: str, block: str, name: str, value: Any, key: str) -> Any:
    table = _table(type_name, block, name, value)
    if key not in table:
        raise SpecError(f"{type_name}.{block}.{name} is missing {key!r}")
    return table[key]


def _maybe_param(value: Any, where: str) -> Param | None:
    return None if value is None else Param.from_dict(dict(value), where=where)


def _maybe_float(value: Any) -> float | None:
    return None if value is None else float(value)


def default_param(value: float, unit: str, reference: str) -> Param:
    """A library-supplied default, tagged as such.

    A shorthand worth having: every default in a component declaration should
    carry :attr:`Provenance.DEFAULT` and say where the number came from, and
    making that a one-liner is what stops it being skipped.
    """
    return Param(value=value, unit=unit, source=Provenance.DEFAULT, reference=reference)
