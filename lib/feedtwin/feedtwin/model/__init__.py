"""The parameter and component model: "nothing hardcoded", as a type.

Every number describing hardware is a :class:`Param` -- a value, the unit it was
written in, where it came from, and how well it is known::

    from feedtwin.model import Param, Provenance

    Param(1.2, "Cv", Provenance.MANUFACTURER, "SS-8BK-V51 datasheet rev C")

There is no default for the source. A number with no provenance is a validation
error, because "nobody remembers where this came from" is the state this layer
exists to make impossible -- and it is the state most of a propulsion team's
numbers are in by the second year.

What each piece is for
----------------------
:mod:`~feedtwin.model.units`
    Conversion at the boundary and dimension checking. Author in psi and
    inches; the solver sees SI floats. A pressure written where a length
    belongs fails at load with both dimensions named.

:mod:`~feedtwin.model.param`
    :class:`Param`, :class:`Provenance`, :class:`Uncertainty`, and the report
    helpers that turn a pile of parameters into "nine measured, four datasheet,
    two guesses".

:mod:`~feedtwin.model.spec`
    :class:`ComponentSpec` -- what a kind of component has. Loaded from
    ``components.toml``, so a component's schema is data and only its physics is
    code. Validation, the Phase 10 inspector and the generated parameter tables
    all read this one declaration.

:mod:`~feedtwin.model.segments`
    :class:`LineSegment` and the loss-method ladder -- how a line's resistance
    is known, and which of several statements of it wins.

:mod:`~feedtwin.model.component`
    :class:`ComponentInstance`, one configured piece of hardware, and the
    provisional :class:`Component` protocol that Phase 03 implements against.

:mod:`~feedtwin.model.catalog`
    Part numbers to parameters, with datasheet values and measurements kept
    separately so the difference between them stays visible.

Serialisation is TOML in, plain dicts through, JSON for exact round-trips.
Deliberately not YAML: PyYAML parses ``1e-3`` as the *string* ``"1e-3"``, which
in a config full of orifice diameters is a silent, load-bearing bug.
"""

from __future__ import annotations

from feedtwin.model.catalog import Catalog, CatalogError, Part, measured
from feedtwin.model.component import (
    Component,
    ComponentInstance,
    EvalContext,
    PortState,
)
from feedtwin.model.param import (
    Param,
    Provenance,
    Uncertainty,
    assumed_params,
    provenance_summary,
)
from feedtwin.model.segments import (
    DEFAULT_METHOD,
    LOSS_METHODS,
    Fitting,
    LineLoss,
    LineSegment,
    method_rank,
)
from feedtwin.model.spec import (
    ComponentSpec,
    ParamSpec,
    PortSpec,
    SpecError,
    StateSpec,
    default_param,
    get_component_spec,
    load_component_specs,
    register_component_spec,
    registered_component_types,
)
from feedtwin.model.units import (
    DimensionMismatch,
    Unit,
    UnknownUnit,
    check_dimension,
    dimension_of,
    from_si,
    get_unit,
    register_unit,
    registered_units,
    si_unit_of,
    to_si,
)

__all__ = [
    "Catalog",
    "CatalogError",
    "Component",
    "ComponentInstance",
    "ComponentSpec",
    "DEFAULT_METHOD",
    "DimensionMismatch",
    "EvalContext",
    "Fitting",
    "LOSS_METHODS",
    "LineLoss",
    "LineSegment",
    "Param",
    "ParamSpec",
    "Part",
    "PortSpec",
    "PortState",
    "Provenance",
    "SpecError",
    "StateSpec",
    "Uncertainty",
    "Unit",
    "UnknownUnit",
    "assumed_params",
    "check_dimension",
    "default_param",
    "dimension_of",
    "from_si",
    "get_component_spec",
    "get_unit",
    "load_component_specs",
    "measured",
    "method_rank",
    "provenance_summary",
    "register_component_spec",
    "register_unit",
    "registered_component_types",
    "registered_units",
    "si_unit_of",
    "to_si",
]
