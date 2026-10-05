"""Every node and branch of a burn, every step: the opt-in network recorder.

A burn's ordinary trace (:class:`~feedtwin.session.burn.BurnTrace`) keeps its
probes -- the tank ullages and outlets, the regulator outlets, the injector
face, the chamber. That is what a summary needs and what the COPV study always
read. A pressure *ladder* -- bottle to chamber, element by element -- needs all
of it: every node's pressure and temperature, every branch's flow, its own drop
and (valves) how far open it is, and the two paths a propellant's pressure
travels. :class:`NetworkTrace` records that when
:attr:`~feedtwin.session.burn.Probes.network` asks for it. It reads the
:class:`~feedtwin.session.core.Sample` a step already produced and changes no
physics; off (the default) the trace is exactly what it always was.

Node values, not vessel states
------------------------------
Everything here is read off the sample: the pressures of the step's last network
solve. A vessel node in there (the bottle, a tank ullage, a tank outlet) is the
*boundary value that solve started from*, not the vessel's state after the step
-- on the LE4 helium burn the bottle node read 1651.4 psia against the bottle
state's 1645.6 at burnout (``EngineDesign/docs/layerx/AUDIT.md`` 5.5). The
ladder is built from node values only, so its rungs telescope exactly to the
first node minus the last of one solve. Mixing in the post-step vessel states
(``BurnTrace.tank``, ``BurnTrace.bottle``) would put a step's worth of blowdown
into one rung.

What a rung's ``dp`` is
-----------------------
``p(from) - p(to)`` of the same solve: the element's own drop, positive
downstream. Liquid nodes carry the lumped-K convention's pressures (total, not
wall-static; see AUDIT.md 9.6 B4). A tank's liquid column is its own element,
``<tank>.head``, from the ullage node to the outlet node: its ``dp`` is negative,
a gain. A branch a path runs against its drawn direction is reported along the
path (``from``/``to`` swapped, ``mdot`` and ``dp`` negated) so that "positive
downstream" means downstream in the feed.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Iterable, Mapping

from feedtwin.session.gauge import PSI

if TYPE_CHECKING:  # pragma: no cover - typing only
    from feedtwin.session.core import Sample, Session

#: Species read as an oxidiser when nothing better says which side a tank is
#: on (no engine attached, no colour on the drawing). Normalised: lower case,
#: no spaces, dashes or underscores.
OXIDISERS = frozenset(
    {
        "oxygen",
        "o2",
        "lox",
        "nitrousoxide",
        "n2o",
        "hydrogenperoxide",
        "h2o2",
        "nitrogentetroxide",
        "n2o4",
    }
)

#: Drawing symbol type to the kind a ladder calls the element.
SYMBOL_KINDS = {
    "PR": "regulator",
    "SOL": "solenoid",
    "ROT": "valve",
    "MOV": "valve",
    "MAN": "valve",
    "RV": "valve",  # "relief" when it was built as one; see _branch_kind
    "CV": "check",
    "QD": "fitting",
}

#: Library component type to the kind, for lines and anything not a symbol.
COMPONENT_KINDS = {
    "pipe": "line",
    "flex_hose": "line",
    "fitting": "fitting",
    "bend": "fitting",
    "orifice": "orifice",
    "valve": "valve",
    "check_valve": "check",
    "regulator": "regulator",
    "relief_valve": "relief",
}

#: The tank head element's id suffix.
HEAD = ".head"


@dataclass(frozen=True, slots=True)
class NodeInfo:
    """What a node is, recorded once."""

    id: str
    label: str
    kind: str
    """``tank`` (an ullage), ``tank_outlet``, ``bottle``, ``chamber``,
    ``injector_inlet``, ``ambient`` (any other fixed pressure: a vent),
    ``manifold``, ``junction``, or ``port`` (one side of an inline symbol)."""
    side: str | None
    """``ox``, ``fuel`` or ``gas``; ``None`` for the chamber and anything the
    drawing does not settle."""
    phase: str
    """``gas`` or ``liquid``, as the network prices it."""


@dataclass(frozen=True, slots=True)
class BranchInfo:
    """What a branch (or a tank's head) is, recorded once."""

    id: str
    label: str
    kind: str
    """``line``, ``valve``, ``solenoid``, ``regulator``, ``orifice``,
    ``fitting``, ``check``, ``relief``, ``injector`` or ``tank_head``."""
    upstream: str
    """Node the element is reported *from* (the contract's ``from``)."""
    downstream: str
    side: str | None
    cv: float | None
    """Flow coefficient at full open, where the component has one."""
    valve: bool
    """Whether :attr:`NetworkTrace.state` carries an open fraction for it."""
    reversed: bool = False
    """Reported against its drawn direction, because a path runs it that way."""


@dataclass
class NetworkTrace:
    """The whole network, sampled at every step of a burn. Absolute SI.

    Built by :meth:`of` from a session, then fed each :class:`Sample` by
    :meth:`append`. Columns are as long as the burn's ``t``.
    """

    nodes: dict[str, NodeInfo] = field(default_factory=dict)
    branches: dict[str, BranchInfo] = field(default_factory=dict)
    paths: dict[str, list[str]] = field(default_factory=dict)
    """``ox`` / ``fuel`` to the element ids from a bottle to the chamber, in
    order: gas leg, ``<tank>.head``, liquid leg, injector."""
    pressure: dict[str, list[float]] = field(default_factory=dict)
    """Node id to the solve's pressure [Pa] (boundary values for vessels)."""
    temperature: dict[str, list[float]] = field(default_factory=dict)
    """Node id to temperature [K], from the enthalpy walk."""
    mdot: dict[str, list[float]] = field(default_factory=dict)
    """Element id to mass flow [kg/s], positive ``upstream`` to ``downstream``."""
    dp: dict[str, list[float]] = field(default_factory=dict)
    """Element id to ``p(upstream) - p(downstream)`` [Pa], one solve."""
    state: dict[str, list[float]] = field(default_factory=dict)
    """Valve id to open fraction, 0 shut to 1 open."""
    _flow_terms: dict[str, tuple[tuple[str, float], ...]] = field(
        default_factory=dict, repr=False
    )
    _state_keys: dict[str, tuple[str, ...]] = field(default_factory=dict, repr=False)

    # ------------------------------------------------------------ building

    @classmethod
    def of(cls, session: "Session") -> "NetworkTrace":
        """The static description of ``session``'s network, columns empty."""
        built = session.model.built
        net = built.network
        diagram = session.model.diagram
        symbols = {n.id: n for n in diagram.nodes}
        edges = {e.id for e in diagram.edges}

        chamber = _chamber_node(session)
        ports = built.engine_ports
        injector_of: dict[str, str] = {}
        inlets: dict[str, str] = {}
        for side, key in (("ox", "oxidiser"), ("fuel", "fuel")):
            branch_id = ports.get(key, "")
            if branch_id in net.branches:
                injector_of[branch_id] = side
                inlets[net.branches[branch_id].upstream] = side

        vessels = {sim.ullage_node for sim in session.tanks.values()}
        vessels |= {sim.outlet_node for sim in session.tanks.values()}
        vessels |= {b.node for b in session.bottles.values()}
        fixed = {n for n, node in net.nodes.items() if node.pressure is not None}

        def phase_of(node_id: str) -> str:
            phase = net.nodes[node_id].phase
            if phase in ("gas", "liquid"):
                return str(phase)
            return "gas" if node_id == chamber else "liquid"

        # Edges, undirected, for the walks: (neighbour, branch id, forward).
        adjacency: dict[str, list[tuple[str, str, bool]]] = {n: [] for n in net.nodes}
        for branch_id, branch in net.branches.items():
            adjacency[branch.upstream].append((branch.downstream, branch_id, True))
            adjacency[branch.downstream].append((branch.upstream, branch_id, False))

        # Which side each tank is on: the injector its liquid reaches, then the
        # drawing's colour, then the species.
        tank_side: dict[str, str] = {}
        liquid_reach: dict[str, set[str]] = {}
        for tank_id, sim in session.tanks.items():
            reach = _walk(
                sim.outlet_node,
                adjacency,
                lambda n: phase_of(n) == "liquid" and n not in fixed,
            )
            liquid_reach[tank_id] = reach
            side = next((inlets[n] for n in reach if n in inlets), "")
            if not side:
                side = _side_from_drawing(symbols.get(tank_id))
            if not side:
                species = _normal(net.nodes[sim.outlet_node].fluid)
                side = "ox" if species in OXIDISERS else "fuel"
            tank_side[tank_id] = side

        node_side: dict[str, str | None] = {}
        for tank_id, reach in liquid_reach.items():
            for node_id in reach:
                node_side.setdefault(node_id, tank_side[tank_id])
        for node_id in net.nodes:
            if node_id in node_side:
                continue
            if node_id == chamber:
                node_side[node_id] = None
            elif node_id in inlets:
                node_side[node_id] = inlets[node_id]
            elif phase_of(node_id) == "gas":
                node_side[node_id] = "gas"
            else:
                node_side[node_id] = None
        # A liquid boundary off a propellant line (an inferred vent on a fill
        # valve's free port) is on that line's side; the walk stops at it.
        for node_id in net.nodes:
            if node_side[node_id] is None and node_id in fixed and node_id != chamber:
                near = [
                    node_side.get(far)
                    for far, _, _ in adjacency[node_id]
                    if node_side.get(far) in ("ox", "fuel")
                ]
                if near:
                    node_side[node_id] = near[0]

        trace = cls()
        bottles = {b.node for b in session.bottles.values()}
        ullages = {sim.ullage_node: tank_id for tank_id, sim in session.tanks.items()}
        outlets = {sim.outlet_node: tank_id for tank_id, sim in session.tanks.items()}
        for node_id, node in net.nodes.items():
            trace.nodes[node_id] = NodeInfo(
                id=node_id,
                label=_node_label(node_id, symbols, ullages, outlets, chamber, inlets),
                kind=_node_kind(
                    node_id, symbols, bottles, ullages, outlets, chamber, inlets, fixed
                ),
                side=node_side.get(node_id),
                phase=phase_of(node_id),
            )

        for branch_id, branch in net.branches.items():
            component = branch.component
            symbol = symbols.get(branch_id)
            if branch_id in injector_of:
                kind = "injector"
                label = f"{injector_of[branch_id]} injector"
            elif symbol is not None:
                kind = _branch_kind(symbol.type, component)
                label = symbol.label or branch_id
            else:
                kind = COMPONENT_KINDS.get(getattr(component, "type", ""), "line")
                label = branch_id if branch_id in edges else str(component.id)
            ends = (branch.upstream, branch.downstream)
            liquid_sides = [
                node_side[n] for n in ends if node_side.get(n) in ("ox", "fuel")
            ]
            if branch_id in injector_of:
                branch_side: str | None = injector_of[branch_id]
            elif liquid_sides:
                branch_side = liquid_sides[0]
            elif all(node_side.get(n) == "gas" for n in ends):
                branch_side = "gas"
            else:
                branch_side = None
            params = getattr(component, "p", {}) or {}
            cv = params.get("Cv")
            keys = _state_keys(component)
            trace.branches[branch_id] = BranchInfo(
                id=branch_id,
                label=label,
                kind=kind,
                upstream=branch.upstream,
                downstream=branch.downstream,
                side=branch_side,
                cv=float(cv) if cv is not None else None,
                valve=bool(keys),
                reversed=False,
            )
            trace._flow_terms[branch_id] = ((branch_id, 1.0),)
            if keys:
                trace._state_keys[branch_id] = keys

        # A tank's liquid column, as its own element: ullage to outlet, carrying
        # what leaves the outlet node.
        for tank_id, sim in session.tanks.items():
            head = f"{tank_id}{HEAD}"
            label = symbols[tank_id].label if tank_id in symbols else tank_id
            trace.branches[head] = BranchInfo(
                id=head,
                label=f"{label or tank_id} liquid head",
                kind="tank_head",
                upstream=sim.ullage_node,
                downstream=sim.outlet_node,
                side=tank_side[tank_id],
                cv=None,
                valve=False,
            )
            terms: list[tuple[str, float]] = []
            for branch_id, branch in net.branches.items():
                if branch.upstream == sim.outlet_node:
                    terms.append((branch_id, 1.0))
                elif branch.downstream == sim.outlet_node:
                    terms.append((branch_id, -1.0))
            trace._flow_terms[head] = tuple(terms)

        # Bottle -> ... -> tank ullage -> head -> ... -> chamber, per side.
        for tank_id, sim in session.tanks.items():
            path_side = tank_side[tank_id]
            if path_side in trace.paths:
                continue  # two tanks on one side: the first drawn is the path
            gas = _shortest(
                bottles,
                sim.ullage_node,
                adjacency,
                lambda n: phase_of(n) == "gas" and n not in fixed,
            )
            liquid_leg = (
                _shortest(
                    {sim.outlet_node},
                    chamber,
                    adjacency,
                    lambda n: n not in fixed and phase_of(n) == "liquid",
                )
                if chamber
                else None
            )
            steps = (
                list(gas or []) + [(f"{tank_id}{HEAD}", True)] + list(liquid_leg or [])
            )
            for branch_id, forward in steps:
                if not forward and not trace.branches[branch_id].reversed:
                    trace._reverse(branch_id)
            trace.paths[path_side] = [branch_id for branch_id, _ in steps]

        for node_id in trace.nodes:
            trace.pressure[node_id] = []
            trace.temperature[node_id] = []
        for branch_id, info in trace.branches.items():
            trace.mdot[branch_id] = []
            trace.dp[branch_id] = []
            if info.valve:
                trace.state[branch_id] = []
        return trace

    def _reverse(self, branch_id: str) -> None:
        info = self.branches[branch_id]
        self.branches[branch_id] = BranchInfo(
            id=info.id,
            label=info.label,
            kind=info.kind,
            upstream=info.downstream,
            downstream=info.upstream,
            side=info.side,
            cv=info.cv,
            valve=info.valve,
            reversed=True,
        )
        self._flow_terms[branch_id] = tuple(
            (term, -sign) for term, sign in self._flow_terms[branch_id]
        )

    # ------------------------------------------------------------ recording

    def append(self, sample: "Sample") -> None:
        """Record one step from the sample it produced."""
        pressures = sample.pressures
        temperatures = sample.temperatures
        flows = sample.flows
        signals = sample.signals
        for node_id in self.nodes:
            self.pressure[node_id].append(float(pressures.get(node_id, 0.0)))
            self.temperature[node_id].append(float(temperatures.get(node_id, 0.0)))
        for branch_id, info in self.branches.items():
            self.mdot[branch_id].append(
                float(
                    sum(
                        sign * flows.get(term, 0.0)
                        for term, sign in self._flow_terms[branch_id]
                    )
                )
            )
            self.dp[branch_id].append(
                float(
                    pressures.get(info.upstream, 0.0)
                    - pressures.get(info.downstream, 0.0)
                )
            )
            keys = self._state_keys.get(branch_id)
            if keys:
                self.state[branch_id].append(_opening(signals, keys))

    # -------------------------------------------------------------- export

    def record(self, t: Iterable[float]) -> dict[str, Any]:
        """The contract's ``result.network`` block: psia, psi, K, kg/s.

        ``t`` is the burn's clock (``BurnTrace.t``), carried so the block stands
        on its own.
        """
        nodes: dict[str, Any] = {}
        for node_id, node in self.nodes.items():
            nodes[node_id] = {
                "label": node.label,
                "kind": node.kind,
                "side": node.side,
                "phase": node.phase,
                "p_psia": [p / PSI for p in self.pressure[node_id]],
                "T_K": list(self.temperature[node_id]),
            }
        branches: dict[str, Any] = {}
        for branch_id, info in self.branches.items():
            entry: dict[str, Any] = {
                "label": info.label,
                "kind": info.kind,
                "from": info.upstream,
                "to": info.downstream,
                "side": info.side,
                "mdot": list(self.mdot[branch_id]),
                "dp_psi": [d / PSI for d in self.dp[branch_id]],
            }
            if info.cv is not None:
                entry["cv"] = info.cv
            if info.valve:
                entry["state"] = list(self.state[branch_id])
            if info.reversed:
                entry["reversed"] = True
            branches[branch_id] = entry
        return {
            "t": list(t),
            "nodes": nodes,
            "branches": branches,
            "paths": {side: list(path) for side, path in self.paths.items()},
            "basis": (
                "node values of each step's last network solve; a vessel node is "
                "the boundary value that solve used, not the post-step vessel "
                "state. dp = p(from) - p(to) of one solve, positive downstream; "
                "<tank>.head is the liquid column (negative: a gain)."
            ),
        }


# ---------------------------------------------------------------- helpers


def _normal(name: object) -> str:
    return "".join(c for c in str(name or "").lower() if c.isalnum())


def _side_from_drawing(symbol: object) -> str:
    """``ox`` / ``fuel`` from pid-designer's colour tag on a tank, or ''."""
    tag = _normal(getattr(symbol, "fluid", ""))
    if tag in ("lox", "ox", "oxidiser", "oxidizer") or tag in OXIDISERS:
        return "ox"
    if tag in ("fuel", "ethanol", "kerosene", "rp1", "ipa", "methanol"):
        return "fuel"
    return ""


def _chamber_node(session: "Session") -> str:
    """The chamber node with an engine attached, else the ENGINE symbol's node."""
    built = session.model.built
    net = built.network
    found = built.engine_ports.get("chamber", "")
    if found in net.nodes:
        return found
    for symbol in session.model.diagram.nodes:
        if symbol.type in ("ENGINE", "INJECTOR"):
            anchor = built.node_of.get(symbol.id, symbol.id)
            if anchor in net.nodes:
                return anchor
    return ""


def _walk(
    start: str,
    adjacency: Mapping[str, list[tuple[str, str, bool]]],
    passable: Any,
) -> set[str]:
    """Nodes reachable from ``start`` through nodes ``passable`` accepts.

    ``start`` itself is always in; a node that is not passable is a wall and is
    not entered.
    """
    seen = {start}
    queue = deque([start])
    while queue:
        here = queue.popleft()
        for far, _, _ in adjacency.get(here, ()):
            if far in seen or not passable(far):
                continue
            seen.add(far)
            queue.append(far)
    return seen


def _shortest(
    starts: Iterable[str],
    goal: str,
    adjacency: Mapping[str, list[tuple[str, str, bool]]],
    passable: Any,
) -> list[tuple[str, bool]] | None:
    """Fewest-branch path from any of ``starts`` to ``goal``, as
    ``(branch id, forward)`` pairs; ``None`` if there is none.

    Intermediate nodes must be ``passable``; the goal need not be (it is a
    vessel or the chamber, both fixed pressures).
    """
    origin = list(starts)
    if not origin or not goal:
        return None
    previous: dict[str, tuple[str, str, bool] | None] = {s: None for s in origin}
    queue = deque(origin)
    while queue:
        here = queue.popleft()
        if here == goal:
            break
        for far, branch_id, forward in adjacency.get(here, ()):
            if far in previous:
                continue
            if far != goal and not passable(far):
                continue
            previous[far] = (here, branch_id, forward)
            queue.append(far)
    if goal not in previous:
        return None
    steps: list[tuple[str, bool]] = []
    node = goal
    while previous[node] is not None:
        here, branch_id, forward = previous[node]  # type: ignore[misc]
        steps.append((branch_id, forward))
        node = here
    steps.reverse()
    return steps


def _branch_kind(symbol_type: str, component: object) -> str:
    if getattr(component, "type", "") == "relief_valve":
        return "relief"
    return SYMBOL_KINDS.get(symbol_type, "valve")


def _state_keys(component: object) -> tuple[str, ...]:
    """The signal names a component's open fraction is read from, or ()."""
    from feedtwin.comps.elements import Valve

    ident = str(getattr(component, "id", ""))
    if getattr(component, "type", "") == "relief_valve":
        return (f"{ident}.lift", "lift")
    if isinstance(component, Valve):
        return (f"{ident}.command", "command")
    return ()


def _opening(signals: Mapping[str, float], keys: tuple[str, ...]) -> float:
    """What the component itself reads: the qualified key, the bare one, else
    fully open -- :meth:`HydraulicComponent.signal`'s own precedence."""
    for key in keys:
        if key in signals:
            return float(min(max(signals[key], 0.0), 1.0))
    return 1.0


def _node_label(
    node_id: str,
    symbols: Mapping[str, Any],
    ullages: Mapping[str, str],
    outlets: Mapping[str, str],
    chamber: str,
    inlets: Mapping[str, str],
) -> str:
    def named(symbol_id: str) -> str:
        symbol = symbols.get(symbol_id)
        return str(getattr(symbol, "label", "") or symbol_id)

    if node_id == chamber:
        return "Chamber"
    if node_id in inlets:
        return f"Injector inlet ({inlets[node_id]})"
    if node_id in ullages:
        return f"{named(ullages[node_id])} ullage"
    if node_id in outlets:
        return f"{named(outlets[node_id])} outlet"
    if node_id in symbols:
        return named(node_id)
    for suffix, word in ((".in", "inlet"), (".out", "outlet")):
        if node_id.endswith(suffix) and node_id[: -len(suffix)] in symbols:
            return f"{named(node_id[: -len(suffix)])} {word}"
    return node_id


def _node_kind(
    node_id: str,
    symbols: Mapping[str, Any],
    bottles: set[str],
    ullages: Mapping[str, str],
    outlets: Mapping[str, str],
    chamber: str,
    inlets: Mapping[str, str],
    fixed: set[str],
) -> str:
    if node_id in bottles:
        return "bottle"
    if node_id in ullages:
        return "tank"
    if node_id in outlets:
        return "tank_outlet"
    if node_id == chamber:
        return "chamber"
    if node_id in inlets:
        return "injector_inlet"
    if node_id in fixed:
        return "ambient"
    symbol = symbols.get(node_id)
    if symbol is not None:
        return "manifold" if symbol.type == "MANIFOLD" else "junction"
    for suffix in (".in", ".out"):
        if node_id.endswith(suffix) and node_id[: -len(suffix)] in symbols:
            return "port"
    return "junction"
