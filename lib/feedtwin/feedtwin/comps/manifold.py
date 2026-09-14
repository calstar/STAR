"""Manifolds: one inlet, several outlets, and a right-angle turn at each.

A manifold is a block with a bore through it and ports tapped into the side.
The team uses them everywhere -- a COPV manifold typically carries a pressure
transducer, a relief valve, a fill quick-disconnect and the regulator feed off
one inlet -- and modelling one as a bare node is the mistake worth avoiding.

What a manifold actually is
---------------------------
A **plenum** at one pressure, plus one **branch per port**. Flow entering the
plenum and leaving through a side port turns through ninety degrees into a bore
that is usually smaller than the plenum's; that turn is a real loss and it is
not the same as the fitting screwed into the port. So each port branch carries
two things in series: the turn out of the plenum, and whatever is threaded in.

The ports themselves carry no information. Every port on the team's manifolds is
female, so the port is just a hole -- **the fitting in it is the whole story**,
which is why :class:`ManifoldPort` takes a bore and a K and not a thread
designation.

Three kinds of port, and the difference matters
-----------------------------------------------
``flow``
    Carries mass. Turn loss plus fitting loss, solved normally.

``instrument``
    A transducer port. It is a dead end -- no flow, ever -- so it reads plenum
    pressure exactly and contributes nothing but a node. Phase 04's dead-end
    peeling already handles this correctly; declaring the port as an instrument
    is what tells a reader *why* the stub is there, and stops someone
    "fixing" it later.

``conditional``
    A relief valve or a burst disc: shut now, a flow path the moment it opens.
    Modelled as a dead end while shut, which is exactly what it is, and named so
    that a scenario can open it without restructuring the network.

The last case is why port type is declared rather than inferred from
connectivity. A shut relief and a capped port are topologically identical and
physically nothing alike, and only one of them belongs in a burst analysis.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

import fluids.fittings as ft

from feedtwin.comps.base import (
    FlowConditions,
    HydraulicComponent,
    Violation,
    register_builder,
)
from feedtwin.comps.correlations import reynolds, velocity
from feedtwin.model.component import ComponentInstance
from feedtwin.model.spec import SpecError


class PortKind(Enum):
    """What a manifold port is for. See the module docstring."""

    FLOW = "flow"
    INSTRUMENT = "instrument"
    CONDITIONAL = "conditional"

    @property
    def carries_flow(self) -> bool:
        return self is PortKind.FLOW


#: Loss coefficient for turning out of a plenum into a side port, referenced to
#: the *port* bore. A branch tee taken at ninety degrees is about 1.0 (Crane
#: TP-410 gives K = 60 f_T, roughly 1.0-1.4 in small sizes); a plenum is a
#: little worse than a tee because the approach velocity is lower and the
#: turn sharper. Overridable per port, and a prime candidate for Phase 12
#: fitting -- it is exactly the kind of number a cold-flow test pins down.
DEFAULT_TURN_K = 1.3


@dataclass(frozen=True, slots=True)
class ManifoldPort:
    """One tapping in a manifold body.

    Args:
        id: Port tag, unique within the manifold.
        bore: Flow diameter of the port itself [m]. Not the thread size --
            see the note on ``bore`` throughout this library.
        kind: What the port is for.
        fitting_K: Loss of whatever is screwed into the port, referenced to
            ``bore``. Zero means nothing but the tapping.
        turn_K: Loss of turning out of the plenum into this port. Defaults to
            :data:`DEFAULT_TURN_K`; set it to zero for an in-line port -- a
            manifold whose outlet is straight through does not turn.
        elevation: Height of this port above the manifold's reference
            point [m]. Usually millimetres, and usually negligible; carried
            because a vertical manifold on a cryogenic line is not.
    """

    id: str
    bore: float
    kind: PortKind = PortKind.FLOW
    fitting_K: float = 0.0
    turn_K: float = DEFAULT_TURN_K
    elevation: float = 0.0

    @property
    def total_K(self) -> float:
        return self.turn_K + self.fitting_K

    @property
    def area(self) -> float:
        return math.pi * self.bore * self.bore / 4.0


class ManifoldBranch(HydraulicComponent):
    """The path from a manifold plenum out through one port.

    Built by :func:`expand_manifold` rather than declared directly, because a
    manifold is one symbol on a drawing and several branches in a solve. That
    asymmetry is the whole point of an assembly.
    """

    def __init__(self, instance: ComponentInstance, port: ManifoldPort) -> None:
        super().__init__(instance)
        self.port = port

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        if not self.port.kind.carries_flow or mdot == 0.0:
            return 0.0
        v = velocity(mdot, self.port.bore, flow.rho)
        return self.port.total_K * 0.5 * flow.rho * v * v

    def static_head(self, flow: FlowConditions) -> float:
        from feedtwin.vessels.volume import GRAVITY

        return -flow.rho * GRAVITY * self.port.elevation

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        return {
            "K_turn": self.port.turn_K,
            "K_fitting": self.port.fitting_K,
            "K_total": self.port.total_K,
            "velocity": velocity(mdot, self.port.bore, flow.rho),
            "Re": reynolds(mdot, self.port.bore, flow.rho, flow.mu),
            "dp": self.pressure_drop(mdot, flow),
        }


class Manifold(HydraulicComponent):
    """A manifold body: a plenum with ports tapped into it.

    Not itself a branch. It has no single inlet-to-outlet pressure drop, which
    is why :meth:`pressure_drop` refuses rather than returning zero -- a
    manifold that silently costs nothing is a manifold whose port losses have
    gone missing. Use :func:`expand_manifold` to turn one into the node and
    branches a solver consumes.

    Args:
        instance: The configured component. Reads ``bore`` (the plenum's own
            flow diameter) and ``volume`` (used by transient work, not by a
            steady solve).
        ports: The tappings.
    """

    def __init__(
        self, instance: ComponentInstance, ports: list[ManifoldPort] | None = None
    ) -> None:
        super().__init__(instance)
        self.ports = list(ports or [])
        seen: set[str] = set()
        for port in self.ports:
            if port.id in seen:
                raise SpecError(f"{self.id}: duplicate port {port.id!r}")
            seen.add(port.id)

    @property
    def flow_ports(self) -> list[ManifoldPort]:
        return [p for p in self.ports if p.kind.carries_flow]

    @property
    def dead_ports(self) -> list[ManifoldPort]:
        return [p for p in self.ports if not p.kind.carries_flow]

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        raise SpecError(
            f"{self.id}: a manifold is not a single branch -- it is a plenum "
            f"with {len(self.ports)} ports, each with its own loss. Expand it "
            "with feedtwin.comps.manifold.expand_manifold() and solve the "
            "branches."
        )

    def check(self) -> list[Violation]:
        out: list[Violation] = []
        if len(self.flow_ports) < 2:
            out.append(
                Violation(
                    self.id,
                    "ports",
                    f"{len(self.flow_ports)} flow port(s). A manifold with "
                    "fewer than two is a fitting; model it as one.",
                    severity="warning",
                )
            )
        plenum = self.p.get("bore", 0.0)
        for port in self.ports:
            if plenum > 0.0 and port.bore > plenum:
                out.append(
                    Violation(
                        self.id,
                        "port_bore",
                        f"port {port.id!r} bore {port.bore * 1e3:.2f} mm exceeds "
                        f"the plenum bore {plenum * 1e3:.2f} mm; the port is not "
                        "the restriction it is being modelled as",
                        severity="warning",
                    )
                )
        return out

    def __repr__(self) -> str:
        kinds = ", ".join(f"{p.id}:{p.kind.value}" for p in self.ports)
        return f"Manifold({self.id!r}, [{kinds}])"


def turn_K_from_geometry(port_bore: float, plenum_bore: float) -> float:
    """A turn loss derived from the two bores, for when nobody measured one.

    The port sees the plenum as a large volume, so the entry is a contraction
    from the plenum bore into the port bore plus the ninety-degree turn. Both
    come from ``fluids``: the contraction from the area ratio, the turn from
    the branch-tee correlation.

    A derived number, and it says so. Rung 6 of the K ladder -- fine for a first
    pass, worth replacing with a fitted value the moment a flow test exists.
    """
    if plenum_bore <= 0.0 or port_bore <= 0.0:
        return DEFAULT_TURN_K
    if port_bore >= plenum_bore:
        return float(ft.entrance_sharp())
    contraction = float(ft.contraction_sharp(Di1=plenum_bore, Di2=port_bore))
    return contraction + DEFAULT_TURN_K


def expand_manifold(
    network: object,
    manifold: Manifold,
    plenum_node: str,
    port_nodes: dict[str, str],
) -> list[str]:
    """Add a manifold's branches to a network. Returns the branch ids.

    The plenum node must already exist and each port must be mapped to a node,
    including the instrument and conditional ones -- those become dead-end
    stubs, which Phase 04 peels and back-fills exactly.

    Args:
        network: The :class:`~feedtwin.solve.network.Network` to add to. Typed
            loosely to keep this module free of a solver import; the solver
            already imports components and the reverse would be a cycle.
        manifold: The expanded body.
        plenum_node: Node id for the plenum interior.
        port_nodes: ``{port id: node id}`` for every port.
    """
    missing = {p.id for p in manifold.ports} - set(port_nodes)
    if missing:
        raise SpecError(
            f"{manifold.id}: no node given for port(s) "
            f"{', '.join(sorted(missing))}. Every port needs one, including "
            "instrument and conditional ports -- they become dead-end stubs, "
            "which is how a transducer tap reads plenum pressure exactly."
        )
    extra = set(port_nodes) - {p.id for p in manifold.ports}
    if extra:
        raise SpecError(
            f"{manifold.id}: node(s) given for unknown port(s) "
            f"{', '.join(sorted(extra))}"
        )

    ids: list[str] = []
    for port in manifold.ports:
        branch_id = f"{manifold.id}.{port.id}"
        component = ManifoldBranch(manifold.instance, port)
        network.add_branch(  # type: ignore[attr-defined]
            branch_id, component, plenum_node, port_nodes[port.id]
        )
        ids.append(branch_id)
    return ids


# A manifold declared with no ports yet: the assembly layer attaches them. It
# is registered so that a config naming `manifold` loads and validates like any
# other type, and so `check()` runs on it.
register_builder("manifold", "plenum", Manifold)
