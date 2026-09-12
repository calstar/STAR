"""Propellant feed system physics.

Real-gas properties, the parameter model and the liquid-side component library
are in. The network solver is next::

    from feedtwin.props import Fluid
    from feedtwin.model import Param, Provenance, ComponentInstance

    Fluid("LOX").get("rho", p=3.0e6, T=90.0)      # 1148 kg/m3

    from feedtwin.comps import build_component, conditions_from_fluid

    line = build_component(ComponentInstance.build("FL-01", "pipe", {
        "length": Param(18.0, "in", Provenance.MEASURED, "tape, 2026-09-08"),
        "bore":   Param(0.305, "in", Provenance.MANUFACTURER, "3/8 x 0.035 tube"),
    }))
    line.pressure_drop(0.5, conditions_from_fluid(Fluid("LOX"), 3.0e6, 90.0))

:mod:`feedtwin.props` is imported explicitly rather than re-exported here, so
``import feedtwin`` stays cheap for callers that only want version metadata --
the API container asks for that on every health check.

What goes where, as the phases land::

    feedtwin.props      Phase 01  real-gas properties, tabulated   [DONE]
    feedtwin.model      Phase 02  Param, ComponentSpec, the catalog [DONE]
    feedtwin.comps      Phase 03  pipes, fittings, valves, orifices [DONE]
    feedtwin.solve      Phase 04  steady network                    [DONE]
    feedtwin.vessels    Phase 05  gas side and tank thermodynamics  [DONE]
    feedtwin.transient  Phase 07  stiff integration                 [DONE]
    feedtwin.engine     Phase 08  a Layer-1 engine on the end       [DONE]
    feedtwin.pid        Phase 11  the drawing is the document       [DONE]
    feedtwin.vessels.vapour       Phase 14  ullage vapour, chilldown [DONE, opt-in]
    feedtwin.fit        Phase 12  parameter identification from test data
                                  -- NOT BUILT. The reader belongs in the DAQ;
                                  what crosses is a fitted K, and the shapes for
                                  it already exist. See
                                  docs/integration/daq-k-fitting.md.
                        Phase 15  constraint API (MEOP, NPSH, injector margins)
                                  -- not started.

Before changing any of it, and after: **run
``python3 scripts/physics_benchmark.py``**, and read ``docs/PHYSICS-BENCHMARK.md``.
Every expected value there was checked against hand calculation, ``fluids``, CoolProp
or a handbook rather than against this package, which is the only kind of check worth
having on a simulator.

Nothing here imports a web framework, and nothing here should. The package has
two callers with incompatible needs -- the feed-twin API, and EngineDesign's
optimizer calling it in-process thousands of times per run -- and only a plain
library serves both. See docs/adr/0001-feed-system-physics-is-a-library.md.
"""

from __future__ import annotations

from feedtwin._environment import stack_versions

__version__ = "0.1.0"

__all__ = ["__version__", "stack_versions"]
