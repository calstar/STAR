"""The network: nodes that hold a pressure, branches that carry a flow.

A feed system is a graph. Nodes are places where pressure is defined -- a tank
outlet, a tee, an injector face -- and branches are the components between them.
Every unknown is one of two things: a node pressure or a branch mass flow.

Two kinds of equation close the system, and between them they are the whole
steady solve:

* **Mass balance** at every free node -- what flows in flows out.
* **A pressure relation** on every branch -- ``p_up - p_dn = dp(mdot)``, where
  ``dp`` is whatever the component says.

Boundary conditions are nodes whose pressure is *fixed*: a pressurised tank, an
ambient vent, a chamber. They contribute no mass balance, because whatever they
need flows in or out of them by definition. A network with no fixed node has no
reference pressure and is singular -- which is checked and reported, rather than
discovered as a linear algebra failure.

Scope, stated plainly: this is **steady, isothermal, single-phase** flow. Node
temperatures are given rather than solved, so there is no energy equation here.
Phase 05 adds the gas side and tank thermodynamics; Phase 07 makes it transient.
A network that boils inside a line is outside what this can say.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Mapping

from feedtwin.comps import FlowConditions, HydraulicComponent, Violation
from feedtwin.props import Fluid


class NetworkError(ValueError):
    """A network is malformed -- dangling branch, no reference pressure."""


@dataclass(slots=True)
class Node:
    """A point in the network where a pressure is defined.

    Args:
        id: Unique identifier. These are the tags on the P&ID.
        fluid: Species name or alias -- resolved through the property layer.
        temperature: Static temperature [K]. Given, not solved: this phase is
            isothermal.
        pressure: Fixed pressure [Pa] for a boundary node, or ``None`` for a
            free node whose pressure is solved.
        demand: Mass flow drawn *out* of this node by something outside the
            network [kg/s]. How an engine's appetite enters a feed-system solve
            without modelling the engine.
    """

    id: str
    fluid: str
    temperature: float
    pressure: float | None = None
    demand: float = 0.0
    phase: str | None = None
    """``"liquid"``, ``"gas"``, or ``None`` for "decide from temperature".

    Declared by whatever built the network -- a drawing knows which side of a
    tank a line is on -- so a subcritical *vapour* line can say it is gas and
    stop being priced as the liquid it would otherwise be taken for. See
    :func:`feedtwin.comps.elements.conditions_from_fluid`."""

    @property
    def is_fixed(self) -> bool:
        return self.pressure is not None


@dataclass(slots=True)
class Branch:
    """A component connecting two nodes, carrying one mass flow.

    Flow is positive from ``upstream`` to ``downstream``. That is a labelling
    convention, not a constraint -- a solved branch may well carry a negative
    flow, which simply means it runs the other way, and check valves are
    specifically written to notice.
    """

    id: str
    component: HydraulicComponent
    upstream: str
    downstream: str


@dataclass(frozen=True, slots=True)
class DeadEnd:
    """A branch that can carry no flow, and the node hanging off it.

    Not a modelling mistake -- it is most of a real feed system. A pressure
    transducer port, a capped fill quick-disconnect, a shut relief valve: each
    is a legitimate stub whose flow is zero by mass balance and whose pressure
    follows its live end.

    They are peeled off before the solve rather than solved for. Their answer is
    exact and needs no iteration, they would otherwise sit on the derivative
    floor and be reported as anomalies on every run, and every one removed is
    two unknowns the Newton step does not carry.
    """

    node: str
    branch: str
    live_end: str
    """The node the stub hangs from -- solved normally."""


@dataclass(slots=True)
class Network:
    """A feed system: nodes, branches, and the fluids in them."""

    nodes: dict[str, Node] = field(default_factory=dict)
    branches: dict[str, Branch] = field(default_factory=dict)

    multiphase: bool = False
    """Let the property layer decide phase from ``(p, T)``.

    Off. A declared liquid is evaluated on its saturated-liquid line, so a leg
    can never silently come back as a gas at a thirtieth of the density because
    a temperature reached it wrong -- which has happened twice here, from two
    different causes, and both times read as a flow discrepancy rather than a
    property lookup.

    Turn it on when flashing and cavitation are the subject rather than the
    hazard. See :func:`feedtwin.comps.elements.conditions_from_fluid`.
    """

    _fluids: dict[str, Fluid] = field(default_factory=dict, repr=False)

    # ------------------------------------------------------------ construction

    def add_node(
        self,
        id: str,
        fluid: str,
        temperature: float,
        *,
        pressure: float | None = None,
        demand: float = 0.0,
    ) -> Node:
        if id in self.nodes:
            raise NetworkError(f"duplicate node {id!r}")
        node = Node(id, fluid, temperature, pressure, demand)
        self.nodes[id] = node
        return node

    def add_branch(
        self, id: str, component: HydraulicComponent, upstream: str, downstream: str
    ) -> Branch:
        if id in self.branches:
            raise NetworkError(f"duplicate branch {id!r}")
        for end in (upstream, downstream):
            if end not in self.nodes:
                raise NetworkError(
                    f"branch {id!r} connects to unknown node {end!r}; "
                    f"nodes are: {', '.join(sorted(self.nodes)) or '(none)'}"
                )
        if upstream == downstream:
            raise NetworkError(f"branch {id!r} starts and ends at {upstream!r}")
        branch = Branch(id, component, upstream, downstream)
        self.branches[id] = branch
        return branch

    # ------------------------------------------------------------- inspection

    @property
    def free_nodes(self) -> list[str]:
        """Nodes whose pressure is solved, in a stable order."""
        return [n for n in self.nodes if not self.nodes[n].is_fixed]

    @property
    def fixed_nodes(self) -> list[str]:
        return [n for n in self.nodes if self.nodes[n].is_fixed]

    def branches_at(self, node_id: str) -> list[tuple[Branch, int]]:
        """Branches touching a node, with +1 for inflow and -1 for outflow."""
        out: list[tuple[Branch, int]] = []
        for branch in self.branches.values():
            if branch.downstream == node_id:
                out.append((branch, +1))
            if branch.upstream == node_id:
                out.append((branch, -1))
        return out

    def isolated(self, signals: Mapping[str, float] | None = None) -> set[str]:
        """Branches commanded shut, which carry no flow and are not solved for.

        See :meth:`feedtwin.comps.base.HydraulicComponent.isolates`. Removing
        them is what turns "a shut valve" from a near-singular row into what it
        physically is -- no connection.
        """
        return {
            branch_id
            for branch_id, branch in self.branches.items()
            if branch.component.isolates(signals)
        }

    def dead_ends(self, exclude: Iterable[str] | None = None) -> list[DeadEnd]:
        """Stubs that can carry no flow, peeled outermost-first.

        Args:
            exclude: Branches already removed from the solve -- shut valves.
                A node left with one live branch once those are gone is a stub
                exactly as if nothing had ever been drawn on its other side,
                which is why this takes them rather than being told twice.

        Found iteratively, because stubs chain: a plenum port feeding a short
        line into a capped quick-disconnect is two branches deep, and removing
        the outer one is what makes the inner one a stub in turn.

        The returned order is safe to back-fill in reverse -- each entry's live
        end is either solved or an earlier entry.
        """
        removed = set(exclude or ())
        remaining = {b: v for b, v in self.branches.items() if b not in removed}
        found: list[DeadEnd] = []

        while True:
            degree: dict[str, int] = {}
            for branch in remaining.values():
                for end in (branch.upstream, branch.downstream):
                    degree[end] = degree.get(end, 0) + 1

            peeled = False
            for node_id, node in self.nodes.items():
                if node.is_fixed or node.demand != 0.0:
                    continue
                if degree.get(node_id, 0) != 1:
                    continue
                branch = next(
                    b
                    for b in remaining.values()
                    if node_id in (b.upstream, b.downstream)
                )
                live = (
                    branch.downstream if branch.upstream == node_id else branch.upstream
                )
                found.append(DeadEnd(node=node_id, branch=branch.id, live_end=live))
                del remaining[branch.id]
                peeled = True
                break

            if peeled:
                continue

            # Nothing left with one live branch. What can remain is a node with
            # *none* -- the far side of a shut valve, cut off from the network
            # entirely. It has no equation, so leaving it among the unknowns
            # makes the Jacobian singular; it is a stub whose live end lies
            # across the branch that was removed.
            taken = {d.node for d in found}
            for node_id, node in self.nodes.items():
                if node.is_fixed or node.demand != 0.0 or node_id in taken:
                    continue
                if degree.get(node_id, 0) != 0:
                    continue
                bridge = next(
                    (
                        b
                        for b in self.branches.values()
                        if b.id in removed and node_id in (b.upstream, b.downstream)
                    ),
                    None,
                )
                if bridge is None:
                    continue
                live = (
                    bridge.downstream if bridge.upstream == node_id else bridge.upstream
                )
                found.append(DeadEnd(node=node_id, branch=bridge.id, live_end=live))
                peeled = True
                break

            if not peeled:
                return found

    def fluid(self, name: str) -> Fluid:
        """A cached :class:`~feedtwin.props.Fluid`, one per species."""
        cached = self._fluids.get(name)
        if cached is None:
            cached = Fluid(name)
            self._fluids[name] = cached
        return cached

    def conditions(
        self, node_id: str, pressure: float, signals: dict[str, float] | None = None
    ) -> FlowConditions:
        """Fluid conditions at a node, for evaluating a branch leaving it."""
        from feedtwin.comps import conditions_from_fluid

        node = self.nodes[node_id]
        return conditions_from_fluid(
            self.fluid(node.fluid),
            pressure,
            node.temperature,
            signals,
            multiphase=self.multiphase,
            phase=node.phase,
        )

    # ------------------------------------------------------------- validation

    def validate(self) -> None:
        """Every structural problem that can be found without solving.

        Raises:
            NetworkError: with all problems listed together, because fixing a
                network six errors at a time beats six solve attempts.
        """
        problems: list[str] = []

        if not self.branches:
            problems.append("  the network has no branches")

        if not self.fixed_nodes:
            problems.append(
                "  no node has a fixed pressure. Without one there is no "
                "reference and every pressure is arbitrary -- the system is "
                "singular. Fix a tank or an ambient vent."
            )

        touched = {b.upstream for b in self.branches.values()} | {
            b.downstream for b in self.branches.values()
        }
        for node_id in sorted(set(self.nodes) - touched):
            problems.append(
                f"  node {node_id!r} has no branches attached; it cannot take part"
            )

        # Dead-ended stubs are deliberately NOT an error. A transducer port, a
        # capped fill QD and a shut relief valve are all one-branch nodes with
        # no demand, and all of them are correct hardware. They are peeled off
        # by dead_ends() and back-filled exactly after the solve.

        for node_id in sorted(self.nodes):
            try:
                self.fluid(self.nodes[node_id].fluid)
            except Exception as exc:
                problems.append(f"  node {node_id!r}: {exc}")

        if problems:
            raise NetworkError("this network cannot be solved:\n" + "\n".join(problems))

    def check(self) -> list[Violation]:
        """Design limits broken by any component in the network.

        Configuration only, so it runs before a solve. A bend inside its
        minimum radius does not stop the network solving; it stops the hardware
        being right, which is a different and equally worth-knowing thing.
        """
        return [v for b in self.branches.values() for v in b.component.check()]

    def __str__(self) -> str:
        return (
            f"Network({len(self.nodes)} nodes, {len(self.branches)} branches, "
            f"{len(self.fixed_nodes)} fixed)"
        )
