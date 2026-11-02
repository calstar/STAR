"""The pressurant is a gas wherever it is on the drawing.

The team's rocket-and-GSE drawing vents the LOX tank through a mated QD pair
and the cart's vent solenoid. Those cart nodes are neither in the pressurant
reach nor painted with a tank's contents, so they were left with no declared
phase and fell to the property layer's temperature rule. GN2 vented off a LOX
tank chilling through Ox Fill crosses nitrogen's 126.2 K critical temperature,
and from there the vent valve was priced on the saturated-*liquid* line:
414 kg/m^3 at 125 K, 730 at 93 K, against ~2.7 for the gas -- the vent's
back-pressure (about a psi at 12.6 g/s) vanished mid-load.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from feedtwin.pid import build_network, read_diagram

DRAWING = Path(__file__).resolve().parent / "fixtures" / "le4_rocket_and_gse.json"


def _built():  # type: ignore[no-untyped-def]
    return build_network(
        read_diagram(json.loads(DRAWING.read_text()), name="le4_rocket_and_gse")
    )


def test_every_pressurant_node_is_declared_gas() -> None:
    net = _built().network
    undeclared = sorted(
        node_id
        for node_id, node in net.nodes.items()
        if node.fluid == "nitrogen" and node.phase != "gas"
    )
    assert undeclared == []


def test_cold_vent_gas_is_priced_as_gas() -> None:
    """Below 126 K, at the cart's LOX vent solenoid: p / (R T), not the
    liquid line."""
    net = _built().network
    node_id = "node_58.in"  # behind OU-QD-A, ahead of the cart's vent valve
    assert net.nodes[node_id].fluid == "nitrogen"
    net.nodes[node_id].temperature = 110.0
    flow = net.conditions(node_id, 101325.0)
    ideal = 101325.0 / (8314.46261815324 / 28.0134 * 110.0)
    assert flow.rho == pytest.approx(ideal, rel=0.03)
