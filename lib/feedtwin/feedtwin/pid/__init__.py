"""Phase 11: the drawing is the document.

pid-designer stores a P&ID as ``{"nodes": [...], "edges": [...]}`` with every
hardware number in :class:`feedtwin.model.Param`'s exact shape -- value, unit,
source, reference. This package reads that and builds a solvable network from
it, so a system is drawn once and analysed where it was drawn::

    from feedtwin.pid import build_network, load_diagram

    drawing = load_diagram("stand.json")
    built = build_network(drawing)
    solve_steady(built.network)

Two graphs, two shapes. A P&ID carries hardware on symbols *and* on lines; a
network carries pressures on nodes and hardware on branches only. The rewrite
between them is :mod:`feedtwin.pid.network`, and the case that matters is the
inline symbol -- a valve becomes a branch with a node spliced either side.
"""

from __future__ import annotations

from feedtwin.pid.document import (
    ANNOTATION_TYPES,
    INLINE_TYPES,
    INSTRUMENT_TYPES,
    SOURCE_TYPES,
    Diagram,
    DiagramError,
    PidEdge,
    PidNode,
    load_diagram,
    read_diagram,
)
from feedtwin.pid.segments import read_segments
from feedtwin.pid.network import (
    BRANCH_KINDS,
    FALLBACKS,
    LINE_KINDS,
    BuiltNetwork,
    Instrument,
    Placement,
    build_network,
)

__all__ = [
    "ANNOTATION_TYPES",
    "BRANCH_KINDS",
    "BuiltNetwork",
    "Diagram",
    "DiagramError",
    "FALLBACKS",
    "INLINE_TYPES",
    "INSTRUMENT_TYPES",
    "Instrument",
    "LINE_KINDS",
    "Placement",
    "PidEdge",
    "PidNode",
    "SOURCE_TYPES",
    "build_network",
    "load_diagram",
    "read_segments",
    "read_diagram",
]
