"""What the solver did each tick, and whether mass was kept: the solver tab.

A run that converges, plots smoothly and violates no assertion is not evidence
(docs/PHYSICS-BENCHMARK.md opens with that). This is the other half: the
numbers a CFD code shows beside every answer, so a person can see when one is
not to be trusted.

Per tick, a :class:`SolverRecord`:

* **Newton.** How many coupling steps the tick took, the network iterations
  they cost, the worst scaled residual and whether every solve converged.
* **Continuity.** The worst net mass imbalance at any free node of the network
  [kg/s] -- the solve's own conservation, which a converged solve can still
  violate if its tolerance is loose.
* **Chamber closure.** How far apart the network's flow and the engine's
  chamber pressure were left [psi].
* **Global mass balance.** Everything held in the vessels, against everything
  that crossed the stand's boundary: the engine, vents, a drawn supply, and the
  built-in loads and charges. Cumulative, so a leak of micrograms a step shows
  as a line that drifts. Zero is the only right answer.
* **Integrator guards.** What the vessels' own floors and clamps changed beyond
  what their rates said -- mass [kg] and ullage energy [J], cumulative. Each
  guard is physics (a vent cannot pull a tank below atmosphere), but each one
  changes the inventory, and seeing how much is the point.

Read-only: nothing here changes a step.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

from feedtwin.solve.network import Network


@dataclass(frozen=True, slots=True)
class SolverRecord:
    """One tick of the solver, as the solver tab plots it."""

    t: float
    couplings: int
    """Coupling steps (network solves) the tick took."""
    iterations: int
    """Newton iterations, summed over the tick's solves."""
    iterations_max: int
    """The most any one solve took."""
    residual: float
    """Worst scaled residual norm of the tick's solves [-]."""
    continuity: float
    """Worst net mass imbalance at a free node [kg/s]."""
    converged: bool
    """Every solve in the tick converged."""
    chamber_residual_psi: float
    """``|g(p) - p|`` the chamber closure left [psi]; 0 without an engine."""
    inventory_kg: float
    """Fluid held in every vessel: liquid, ullage gas, vapour, bottles [kg]."""
    crossed_in_kg: float
    """Cumulative mass in across the boundary [kg]."""
    crossed_out_kg: float
    """Cumulative mass out across the boundary [kg]."""
    mass_error_kg: float
    """Cumulative: inventory gained less what crossed in net [kg]. Zero when
    mass is kept."""
    guard_kg: float
    """Cumulative mass the vessels' guards added (+) or removed (-) [kg]."""
    guard_J: float
    """Cumulative ullage energy the vessels' guards added or removed [J]."""

    @property
    def throughput_kg(self) -> float:
        return self.crossed_in_kg + self.crossed_out_kg

    def to_dict(self) -> dict[str, float | int | bool]:
        return {
            "t": self.t,
            "couplings": self.couplings,
            "iterations": self.iterations,
            "iterations_max": self.iterations_max,
            "residual": self.residual,
            "continuity": self.continuity,
            "converged": self.converged,
            "chamber_residual_psi": self.chamber_residual_psi,
            "inventory_kg": self.inventory_kg,
            "crossed_in_kg": self.crossed_in_kg,
            "crossed_out_kg": self.crossed_out_kg,
            "mass_error_kg": self.mass_error_kg,
            "guard_kg": self.guard_kg,
            "guard_J": self.guard_J,
        }


def boundary_nodes(net: Network, vessel_nodes: Iterable[str]) -> frozenset[str]:
    """Fixed-pressure nodes that are not a vessel's: atmosphere at a vent, the
    chamber, a drawn source the session does not integrate."""
    vessels = set(vessel_nodes)
    return frozenset(
        node_id
        for node_id, node in net.nodes.items()
        if node.pressure is not None and node_id not in vessels
    )


def crossing(
    net: Network, flows: Mapping[str, float], boundary: frozenset[str]
) -> tuple[float, float]:
    """``(in, out)`` [kg/s] across the boundary, from one solve's flows.

    A branch between two boundary nodes carries nothing the stand holds, and a
    branch with neither end on the boundary is internal; only a branch with
    exactly one end there crosses it.
    """
    into = out = 0.0
    for branch_id, branch in net.branches.items():
        flow = flows.get(branch_id, 0.0)
        if flow == 0.0:
            continue
        up, down = branch.upstream in boundary, branch.downstream in boundary
        if up == down:
            continue
        # Positive flow runs upstream -> downstream.
        signed = flow if down else -flow  # positive: leaving the stand
        if signed > 0.0:
            out += signed
        else:
            into -= signed
    return into, out
