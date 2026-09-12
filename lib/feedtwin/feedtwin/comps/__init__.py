"""The component library: pipes, fittings, orifices, valves, check valves.

Configuration in, pressure drop out::

    from feedtwin.comps import build_component, conditions_from_fluid
    from feedtwin.model import ComponentInstance, Param, Provenance
    from feedtwin.props import Fluid

    line = build_component(ComponentInstance.build("FL-01", "pipe", {
        "length": Param(2.0, "m", Provenance.MEASURED, "drawing"),
        "bore":   Param(7.75, "mm", Provenance.MANUFACTURER, "3/8 x 0.035 tube"),
    }))

    lox = conditions_from_fluid(Fluid("LOX"), p=3.0e6, T=90.0)
    line.pressure_drop(mdot=1.5, flow=lox)      # Pa

Everything numeric comes from ``fluids``, which is validated against the books
it implements -- Crane TP-410 for fitting losses, IEC 60534 for valve sizing,
ISO 5167 for metering orifices. What this package adds is adapters, unit and
provenance bookkeeping, and the registries that make correlation choice a
config edit. It contributes no correlations of its own, on purpose: a wrong
number here should be traceable to an adapter, never to a re-derivation.

Two seams keep it extensible without editing this package:

* ``register_fitting(name, fn)`` -- a fitting correlation, selected by
  ``fitting.options.kind``.
* ``register_builder(type, model, fn)`` -- the physics behind a (component
  type, fidelity model) pair, which is how a new component type declared in
  ``components.toml`` acquires behaviour.

And every type carries a ``measured`` model that reads a flow-against-drop
curve and supersedes the correlation entirely.
"""

from __future__ import annotations

from feedtwin.comps.base import (
    Builder,
    FlowConditions,
    HydraulicComponent,
    InfeasibleOperatingPoint,
    Violation,
    build_component,
    register_builder,
    registered_builders,
)
from feedtwin.comps.correlations import (
    DEFAULT_FRICTION_METHOD,
    FRICTION_METHODS,
    LAMINAR_LIMIT,
    FittingContext,
    FittingK,
    darcy_friction_factor,
    fitting_K,
    get_fitting,
    register_fitting,
    registered_fittings,
    reynolds,
    velocity,
)
from feedtwin.comps.manifold import (
    DEFAULT_TURN_K,
    Manifold,
    ManifoldBranch,
    ManifoldPort,
    PortKind,
    expand_manifold,
    turn_K_from_geometry,
)
from feedtwin.comps.regulator import (
    CurveRegulator,
    IdealRegulator,
    Regulator,
)
from feedtwin.comps.gas import (
    GasOrifice,
    choked_mass_flow,
    critical_pressure_ratio,
    subsonic_mass_flow,
)
from feedtwin.comps.elements import (
    CHARACTERISTICS,
    GRAVITY,
    Bend,
    CheckValve,
    Fitting,
    FlexHose,
    MeasuredElement,
    OrificeCd,
    OrificeISO5167,
    Pipe,
    Valve,
    conditions_from_fluid,
)

__all__ = [
    "CHARACTERISTICS",
    "DEFAULT_FRICTION_METHOD",
    "DEFAULT_TURN_K",
    "FRICTION_METHODS",
    "GRAVITY",
    "LAMINAR_LIMIT",
    "Builder",
    "Bend",
    "CheckValve",
    "Fitting",
    "FlexHose",
    "FittingContext",
    "FittingK",
    "FlowConditions",
    "GasOrifice",
    "HydraulicComponent",
    "InfeasibleOperatingPoint",
    "CurveRegulator",
    "IdealRegulator",
    "Manifold",
    "ManifoldBranch",
    "ManifoldPort",
    "MeasuredElement",
    "PortKind",
    "Regulator",
    "OrificeCd",
    "OrificeISO5167",
    "Pipe",
    "Valve",
    "Violation",
    "build_component",
    "choked_mass_flow",
    "critical_pressure_ratio",
    "expand_manifold",
    "subsonic_mass_flow",
    "conditions_from_fluid",
    "darcy_friction_factor",
    "fitting_K",
    "get_fitting",
    "register_builder",
    "register_fitting",
    "registered_builders",
    "registered_fittings",
    "reynolds",
    "turn_K_from_geometry",
    "velocity",
]
