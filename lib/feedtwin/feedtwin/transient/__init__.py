"""Phase 07: the transient. Static versus firing.

A steady solve answers "where does this system sit". A transient answers the
questions that actually decide a design: what happens in the 40 ms after the
main valve cracks, how far the regulator droops by the end of a burn, whether
the ox lead is long enough, and how much pressurant the run really costs.

The formulation is a semi-explicit index-1 DAE solved by nesting: vessels carry
the differential state, and the Phase 04 network solve is the algebraic
constraint, satisfied exactly at every step rather than carried as extra
unknowns. See :mod:`feedtwin.transient.system` for why, and for the assumption
that buys -- quasi-steady flow -- together with the per-branch number that says
when it stops being true.

    from feedtwin.transient import (Command, Coupling, Scenario,
                                    TransientSystem, simulate)

    scenario = Scenario(duration=5.0,
                        initial_signals={"MV.command": 0.0},
                        commands=[Command(0.1, "MV.command", 1.0,
                                          travel_time=0.04)])
    system = TransientSystem(network, couplings, scenario)
    result = simulate(system)
    result.conservation          # audited, always
"""

from __future__ import annotations

from feedtwin.transient.integrate import (
    STIFF_METHODS,
    ConservationAudit,
    Integrator,
    SciPyIntegrator,
    TransientResult,
    simulate,
)
from feedtwin.transient.scenario import (
    ActuationShape,
    Command,
    Scenario,
    get_actuation_shape,
    register_actuation_shape,
    registered_actuation_shapes,
)
from feedtwin.transient.state import Slot, StateLayout, StateOwner
from feedtwin.transient.system import (
    Coupling,
    TransientError,
    TransientSample,
    TransientSystem,
)
from feedtwin.transient.vessels import GasVolumeOwner, TankOwner

__all__ = [
    "STIFF_METHODS",
    "ActuationShape",
    "Command",
    "ConservationAudit",
    "Coupling",
    "GasVolumeOwner",
    "Integrator",
    "SciPyIntegrator",
    "Scenario",
    "Slot",
    "StateLayout",
    "StateOwner",
    "TankOwner",
    "TransientError",
    "TransientResult",
    "TransientSample",
    "TransientSystem",
    "get_actuation_shape",
    "register_actuation_shape",
    "registered_actuation_shapes",
    "simulate",
]
