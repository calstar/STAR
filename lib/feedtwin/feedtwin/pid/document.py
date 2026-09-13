"""A P&ID as a document, before it is a network.

pid-designer stores a drawing as ``{"nodes": [...], "edges": [...]}`` -- React
Flow's own shape, with the engineering carried in each item's ``data``. This
module reads that into typed records and does nothing else. No physics, no
topology, no opinions: parsing and interpreting are separated because the parse
must succeed on a drawing that is half-finished, and the interpretation must be
allowed to refuse one.

The field names are pid-designer's, unchanged. A translation table between the
two apps would be a third place for a name to be wrong, and the whole reason
the drawing stores ``feedtwin.model.Param``'s exact shape is so that no such
table is needed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

from feedtwin.model.param import Param, Provenance
from feedtwin.model.segments import LineLoss
from feedtwin.pid.errors import DiagramError as DiagramError
from feedtwin.pid.segments import read_segments

#: Component types that carry mass between two points. Everything else is
#: either a place (a tank, a junction) or an observer (a transducer).
INLINE_TYPES = frozenset({"MAN", "ROT", "SOL", "PR", "RV", "CV", "QD"})

#: Types that declare a fluid and a pressure: where a solve starts.
SOURCE_TYPES = frozenset({"TANK", "KBOTTLE", "DEWAR"})

#: Symbols that are a boundary rather than a place: where the fluid goes when it
#: leaves. ``VENT`` is atmosphere. See feedtwin.pid.network.SINK_TYPES.
BOUNDARY_TYPES = frozenset({"ENGINE", "INJECTOR", "VENT"})

#: Types that measure without flowing. They read the pressure where they are
#: clipped and contribute nothing to the network -- which is exactly what a
#: transducer does, and why treating one as a component would be wrong.
INSTRUMENT_TYPES = frozenset({"PT", "PG", "RTD", "TC", "LC"})

#: Drawn, but not part of a feed solve.
ANNOTATION_TYPES = frozenset({"TEXT", "REGION"})


@dataclass(frozen=True, slots=True)
class PidNode:
    """One symbol on the drawing."""

    id: str
    type: str
    label: str
    x: float
    y: float
    fluid: str = ""
    role: str = ""
    """What pid-designer colours this by -- ``fuel``, ``lox``, ``pressurant``.
    A *role*, not a species: it says which leg a symbol belongs to and nothing
    about what is in it. Carried so a drawing that set the colour and forgot the
    fluid can be told so specifically, rather than defaulted in silence."""

    page: str = ""
    attached_to: str = ""
    params: Mapping[str, Param] = field(default_factory=dict)
    options: Mapping[str, str] = field(default_factory=dict)
    ports: Mapping[str, Mapping[str, str]] = field(default_factory=dict)

    @property
    def is_inline(self) -> bool:
        return self.type in INLINE_TYPES

    @property
    def is_source(self) -> bool:
        return self.type in SOURCE_TYPES

    @property
    def is_instrument(self) -> bool:
        return self.type in INSTRUMENT_TYPES

    @property
    def is_annotation(self) -> bool:
        return self.type in ANNOTATION_TYPES


@dataclass(frozen=True, slots=True)
class PidEdge:
    """One line between two symbols."""

    id: str
    source: str
    target: str
    source_handle: str = ""
    target_handle: str = ""
    line_type: str = "pipe"
    page: str = ""
    params: Mapping[str, Param] = field(default_factory=dict)
    options: Mapping[str, str] = field(default_factory=dict)
    segments: LineLoss = field(default_factory=LineLoss)
    """The run itemised: tube, bores, fittings. Empty when the drawing says
    nothing, which is when :attr:`params` is the whole story.

    A line that has segments has them *instead of* its line-level ``length``
    and ``bore`` -- the drawing's editor greys those fields out and says so.
    Reading both would double-count the run."""


@dataclass(frozen=True, slots=True)
class Diagram:
    """A whole drawing."""

    nodes: tuple[PidNode, ...]
    edges: tuple[PidEdge, ...]
    name: str = ""

    def node(self, node_id: str) -> PidNode | None:
        return next((n for n in self.nodes if n.id == node_id), None)

    def of_type(self, *types: str) -> list[PidNode]:
        wanted = set(types)
        return [n for n in self.nodes if n.type in wanted]

    @property
    def pages(self) -> list[str]:
        seen = {n.page for n in self.nodes if n.page}
        return sorted(seen)

    def on_page(self, page: str) -> Diagram:
        """The drawing restricted to one page, with dangling edges dropped."""
        nodes = tuple(n for n in self.nodes if not n.page or n.page == page)
        keep = {n.id for n in nodes}
        edges = tuple(e for e in self.edges if e.source in keep and e.target in keep)
        return Diagram(nodes=nodes, edges=edges, name=f"{self.name}#{page}")


_PROVENANCE = {p.value: p for p in Provenance}


def _params(raw: Any, where: str) -> dict[str, Param]:
    """Read a ``{name: {value, unit, source, reference}}`` block.

    A parameter with no ``source`` is refused rather than defaulted. The drawing
    goes out of its way to always ask, so a missing one means the document was
    written by something else -- and silently calling it a default would turn a
    format mismatch into a number nobody checked.
    """
    if not isinstance(raw, Mapping):
        return {}
    out: dict[str, Param] = {}
    for name, entry in raw.items():
        if not isinstance(entry, Mapping) or entry.get("value") is None:
            continue
        source = str(entry.get("source", ""))
        if source not in _PROVENANCE:
            raise DiagramError(
                f"{where}: parameter {name!r} has source {source!r}; expected "
                f"one of {', '.join(sorted(_PROVENANCE))}"
            )
        try:
            out[str(name)] = Param(
                value=float(entry["value"]),
                unit=str(entry.get("unit", "-")),
                source=_PROVENANCE[source],
                reference=str(entry.get("reference", "")),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise DiagramError(f"{where}: parameter {name!r} is malformed ({exc})")
    return out


def _options(raw: Any) -> dict[str, str]:
    if not isinstance(raw, Mapping):
        return {}
    return {str(k): str(v) for k, v in raw.items()}


def _ports(raw: Any) -> dict[str, dict[str, str]]:
    if not isinstance(raw, Mapping):
        return {}
    out: dict[str, dict[str, str]] = {}
    for port_id, entry in raw.items():
        if isinstance(entry, Mapping):
            out[str(port_id)] = {str(k): str(v) for k, v in entry.items()}
    return out


def read_diagram(payload: Mapping[str, Any], *, name: str = "diagram") -> Diagram:
    """Parse a saved drawing. Lenient by design -- see the module docstring."""
    raw_nodes = payload.get("nodes")
    raw_edges = payload.get("edges")
    if not isinstance(raw_nodes, Iterable) or not isinstance(raw_edges, Iterable):
        raise DiagramError(
            f"{name}: expected an object with 'nodes' and 'edges' lists; got keys "
            f"{', '.join(sorted(str(k) for k in payload))}"
        )

    nodes: list[PidNode] = []
    for raw in raw_nodes:
        if not isinstance(raw, Mapping):
            continue
        node_raw = raw.get("data")
        data: Mapping[str, Any] = node_raw if isinstance(node_raw, Mapping) else {}
        pos_raw = raw.get("position")
        position: Mapping[str, Any] = pos_raw if isinstance(pos_raw, Mapping) else {}
        node_id = str(raw.get("id", ""))
        if not node_id:
            raise DiagramError(f"{name}: a node has no id")
        nodes.append(
            PidNode(
                id=node_id,
                type=str(data.get("componentType", raw.get("type", ""))),
                label=str(data.get("label", node_id)),
                x=float(position.get("x", 0.0) or 0.0),
                y=float(position.get("y", 0.0) or 0.0),
                fluid=str(data.get("fluid", "") or ""),
                role=str(data.get("fluidType", "") or "").strip().lower(),
                page=str(data.get("page", "") or ""),
                attached_to=str(data.get("attachedTo", "") or ""),
                params=_params(data.get("params"), f"{name}:{node_id}"),
                options=_options(data.get("options")),
                ports=_ports(data.get("ports")),
            )
        )

    edges: list[PidEdge] = []
    for raw in raw_edges:
        if not isinstance(raw, Mapping):
            continue
        edge_raw = raw.get("data")
        edge_data: Mapping[str, Any] = edge_raw if isinstance(edge_raw, Mapping) else {}
        edge_id = str(raw.get("id", ""))
        source, target = str(raw.get("source", "")), str(raw.get("target", ""))
        if not edge_id or not source or not target:
            raise DiagramError(f"{name}: an edge is missing id, source or target")
        edges.append(
            PidEdge(
                id=edge_id,
                source=source,
                target=target,
                source_handle=str(raw.get("sourceHandle", "") or ""),
                target_handle=str(raw.get("targetHandle", "") or ""),
                line_type=str(edge_data.get("lineType", "pipe") or "pipe"),
                page=str(edge_data.get("page", "") or ""),
                params=_params(edge_data.get("params"), f"{name}:{edge_id}"),
                options=_options(edge_data.get("options")),
                segments=read_segments(edge_data.get("segments"), f"{name}:{edge_id}"),
            )
        )

    known = {n.id for n in nodes}
    dangling = [e.id for e in edges if e.source not in known or e.target not in known]
    if dangling:
        raise DiagramError(
            f"{name}: {len(dangling)} line(s) connect to symbols that are not on "
            f"the drawing: {', '.join(dangling[:5])}"
        )

    return Diagram(nodes=tuple(nodes), edges=tuple(edges), name=name)


def load_diagram(path: str | Path) -> Diagram:
    source = Path(path)
    if not source.exists():
        raise DiagramError(f"no diagram at {source}")
    with source.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, Mapping):
        raise DiagramError(f"{source}: not a JSON object")
    return read_diagram(payload, name=source.name)
