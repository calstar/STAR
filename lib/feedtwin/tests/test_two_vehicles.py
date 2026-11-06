"""One drawing, one vehicle.

pid-designer's Duplicate page is offered for "another version of the same stand
-- the hotfire and the launch configuration". It keeps every tag, and its
duplicate-tag check is per page, so the copy passes there. The twin builds every
page into one network: LE4 with its Rocket page duplicated built as two rockets
sharing seven signals, no valve bound, and Fire sat at 0 N with no message.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from feedtwin.pid import build_network, read_diagram
from feedtwin.session import assemble_model
from feedtwin.session.model import AssemblyError

DRAWING = Path(__file__).resolve().parent / "fixtures" / "le4_rocket_and_gse.json"


def _payload() -> Any:
    return json.loads(DRAWING.read_text())


def _duplicated(page: str = "Rocket", copy_name: str = "Rocket (copy)") -> Any:
    """``page`` copied as duplicatePage does: fresh ids, tags kept, pairs and
    clips inside the page remapped."""
    payload = _payload()
    on = {n["id"] for n in payload["nodes"] if n["data"].get("page") == page}
    fresh = {i: f"{i}_copy" for i in on}
    nodes, edges = [], []
    for node in payload["nodes"]:
        if node["id"] not in on:
            continue
        twin = copy.deepcopy(node)
        twin["id"] = fresh[node["id"]]
        twin["data"]["page"] = copy_name
        options = twin["data"].get("options") or {}
        if options.get("pairedWith") in fresh:
            options["pairedWith"] = fresh[options["pairedWith"]]
        if twin["data"].get("attachedTo") in fresh:
            twin["data"]["attachedTo"] = fresh[twin["data"]["attachedTo"]]
        nodes.append(twin)
    for edge in payload["edges"]:
        if edge["source"] in on and edge["target"] in on:
            twin = copy.deepcopy(edge)
            twin["id"] = f"{edge['id']}_copy"
            twin["source"], twin["target"] = (
                fresh[edge["source"]],
                fresh[edge["target"]],
            )
            edges.append(twin)
    payload["nodes"] += nodes
    payload["edges"] += edges
    return payload


@pytest.mark.parametrize("cut", [False, True])
def test_two_versions_of_the_rocket_are_refused_and_the_pages_named(cut: bool) -> None:
    diagram = read_diagram(_duplicated(), name="LE4 (6)")
    with pytest.raises(AssemblyError) as refused:
        assemble_model(diagram, diagram_id="le4", vehicle_only=cut)
    said = str(refused.value)
    assert "2 separate vehicles" in said
    assert "page Rocket" in said and "page Rocket (copy)" in said


def test_the_drawing_with_one_rocket_builds() -> None:
    built = build_network(read_diagram(_payload(), name="LE4 (6)"))
    assert not [w for w in built.warnings if "is the tag of" in w]


def test_a_tag_two_driven_valves_share_is_said() -> None:
    """A copied cart page has one engine, so it builds -- and the solenoids it
    copied answer one signal between them, which is worth a line."""
    payload = _duplicated("GSE", "GSE (copy)")
    built = build_network(read_diagram(payload, name="LE4 (6)"))
    shared = [w for w in built.warnings if "is the tag of 2 valves" in w]
    assert shared, built.warnings
    assert any("GSE and GSE (copy)" in w for w in shared)
