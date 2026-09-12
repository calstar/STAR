"""Solving a feed system: steady now, transient in Phase 07.

    from feedtwin.solve import Network, solve_steady

    net = Network()
    net.add_node("tank", "LOX", temperature=90.0, pressure=30e5)
    net.add_node("inj",  "LOX", temperature=90.0, pressure=20e5)
    net.add_branch("FL-01", line, "tank", "inj")

    result = solve_steady(net)
    result.flows["FL-01"]        # kg/s
    result.pressures["inj"]      # Pa
    result.max_mass_residual     # how well mass actually balanced

Unknowns are one pressure per free node and one flow per branch; equations are
one mass balance per free node and one pressure relation per branch. Everything
else -- the sparsity, the damping, the derivative floor at zero flow -- is in
:mod:`feedtwin.solve.steady`, along with why each is needed.

Steady, isothermal, single-phase. Node temperatures are given rather than
solved. Phase 05 adds the gas side, Phase 07 the transient.
"""

from __future__ import annotations

from feedtwin.solve.network import Branch, Network, NetworkError, Node
from feedtwin.solve.report import pressure_ladder
from feedtwin.solve.steady import (
    MIN_BRANCH_SLOPE,
    ConvergenceError,
    SteadyResult,
    solve_steady,
)

__all__ = [
    "MIN_BRANCH_SLOPE",
    "Branch",
    "ConvergenceError",
    "Network",
    "NetworkError",
    "Node",
    "SteadyResult",
    "pressure_ladder",
    "solve_steady",
]
