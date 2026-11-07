"""A probe clipped to a line reads the line.

pid-designer clips an RTD, a TC or a load cell to a tank, a valve *or a line*
(its ``attach.ts``): on a line ``attachedTo`` is the line's id and
``attachedAt`` the fraction of its drawn length from the source end. The twin
resolved a clip only against symbols, so a probe on a line read nothing and was
reported "not clipped to anything" -- and with the cart cut (``ignore_gse``)
it was dropped from the vehicle without a word.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from feedtwin.pid import build_network, read_diagram
from feedtwin.pid.roles import vehicle_ids
from feedtwin.session import assemble_model

DRAWING = Path(__file__).resolve().parent / "fixtures" / "le4_rocket_and_gse.json"
LINE = "node_38-node_36"  # FM-R to the engine
PROBE = "node_30"  # OX-RTD-1, drawn on the LOX tank


def _on_the_line(at: float | None) -> Any:
    payload = copy.deepcopy(json.loads(DRAWING.read_text()))
    for node in payload["nodes"]:
        if node["id"] == PROBE:
            node["data"]["attachedTo"] = LINE
            node["data"].pop("attachedAt", None)
            if at is not None:
                node["data"]["attachedAt"] = at
    return payload


def _reads(built: Any) -> str | None:
    return next((i.node for i in built.instruments if i.id == PROBE), None)


@pytest.mark.parametrize(("at", "end"), [(0.2, "upstream"), (0.8, "downstream")])
def test_a_probe_on_a_line_reads_the_end_it_is_clipped_nearer(
    at: float, end: str
) -> None:
    built = build_network(read_diagram(_on_the_line(at), name="LE4"))
    line = built.network.branches[LINE]
    assert _reads(built) == getattr(line, end)
    assert not [w for w in built.warnings if "OX-RTD-1" in w], built.warnings


def test_a_probe_on_a_line_with_no_position_reads_it() -> None:
    """Saved before ``attachedAt`` existed: drawn at the line's middle."""
    built = build_network(read_diagram(_on_the_line(None), name="LE4"))
    assert _reads(built) in {
        built.network.branches[LINE].upstream,
        built.network.branches[LINE].downstream,
    }


def test_a_probe_on_a_vehicle_line_stays_with_the_vehicle() -> None:
    diagram = read_diagram(_on_the_line(0.5), name="LE4")
    vehicle = vehicle_ids(diagram)
    assert vehicle is not None and PROBE in vehicle
    model = assemble_model(diagram, diagram_id="le4", vehicle_only=True)
    assert any(n.id == PROBE for n in model.diagram.nodes)
    assert _reads(model.built) is not None
    assert not [w for w in model.report.warnings if "OX-RTD-1" in w]


def test_a_probe_on_a_symbol_reads_as_before() -> None:
    built = build_network(read_diagram(json.loads(DRAWING.read_text()), name="LE4"))
    tank = built.tanks["node_22"]
    assert _reads(built) in {tank.ullage, tank.outlet}
