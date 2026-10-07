"""A drawing on two pages, joined where the stand joins: a mated disconnect.

pid-designer draws the vehicle and the GSE cart on separate pages and has no
off-page connector; the coupling between them is a quick-disconnect on each page,
paired through ``options.pairedWith``. Read page-blind, the two halves each had a
free side and the cart could not feed the vehicle. Mated (``_mate_disconnects``),
their free sides are one place.

Checked by flow: gas from a cart bottle on the GSE page reaches a vent on the
vehicle page only through the pair, and a drawing that pairs nothing builds
exactly as before.
"""

from __future__ import annotations

from typing import Any

import pytest
from test_pid_drawn_freely import P, line, node

from feedtwin.pid import build_network, read_diagram
from feedtwin.solve.steady import solve_steady


def _two_pages(pair: str = "both") -> Any:
    """Cart bottle -> QD-G (page GSE)  ||  QD-R -> vent (page Main)."""
    cart = node(
        "BANK",
        "KBOTTLE",
        "BANK-1",
        page="GSE",
        fluidType="nitrogen",
        params={"pressure": P(300, "psi"), "temperature": P(293, "K")},
    )
    qd_g = node("QG", "QD", "QD-GSE", page="GSE", params={"Cv": P(2.0, "Cv")})
    qd_r = node("QR", "QD", "QD-VEH", page="Main", params={"Cv": P(2.0, "Cv")})
    vent = node("V", "VENT", "VENT-1", page="Main")
    if pair in ("both", "gse"):
        qd_g["data"]["options"] = {"pairedWith": "QR"}  # type: ignore[index]
    if pair in ("both", "vehicle"):
        qd_r["data"]["options"] = {"pairedWith": "QG"}  # type: ignore[index]
    return {
        "nodes": [cart, qd_g, qd_r, vent],
        "edges": [line("b-g", "BANK", "QG"), line("r-v", "QR", "V")],
    }


def _flow(payload: Any) -> tuple[float, Any]:
    built = build_network(read_diagram(payload, name="two pages"))
    result = solve_steady(built.network)
    assert result.converged
    return result.flows.get("r-v", 0.0), built


@pytest.mark.parametrize("pair", ["both", "gse", "vehicle"])
def test_a_paired_disconnect_joins_the_cart_page_to_the_vehicle_page(pair: str) -> None:
    flow, built = _flow(_two_pages(pair))
    assert flow > 0.01, "the cart's gas reaches the vehicle's vent through the pair"
    assert built.mated == (("QG", "QR"),)
    assert any("joining pages GSE and Main" in w for w in built.warnings)


def test_unpaired_the_two_pages_are_two_systems() -> None:
    """The test can fail: without the pairing nothing crosses."""
    flow, built = _flow(_two_pages("none"))
    assert abs(flow) < 1e-9
    assert built.mated == ()


def test_a_drawing_that_pairs_nothing_builds_as_before() -> None:
    payload = _two_pages("none")
    a = build_network(read_diagram(payload, name="x"))
    for n in payload["nodes"]:
        n["data"].pop("page", None)
    b = build_network(read_diagram(payload, name="x"))
    assert sorted(a.network.branches) == sorted(b.network.branches)
    assert sorted(a.network.nodes) == sorted(b.network.nodes)


def test_halves_naming_different_partners_are_left_apart_and_said_so() -> None:
    payload = _two_pages("both")
    payload["nodes"].append(node("Q3", "QD", "QD-3", page="GSE"))
    payload["nodes"][2]["data"]["options"] = {"pairedWith": "Q3"}
    flow, built = _flow(payload)
    assert built.mated == ()
    assert any("left unmated" in w for w in built.warnings)


def test_a_cart_drawn_on_the_gse_page_charges_the_copv_itself() -> None:
    """LE4's layout plus its cart on a GSE page: a bank bottle, the table's own
    `GSE High Press Control` valve, and a paired disconnect onto the COPV. In GN2
    High Press the bank charges the COPV through the drawing, and the session's
    built-in charge (which stands in for an undrawn cart) is off -- or the bottle
    would be filled twice."""
    from test_pid_drawn_freely import _le4_like, _machine

    from feedtwin.session import Session, assemble_model
    from feedtwin.session.hookup import binding

    payload: Any = _le4_like()
    payload["nodes"] += [
        node(
            "BANK",
            "KBOTTLE",
            "BANK-1",
            page="GSE",
            fluid="nitrogen",
            params={
                "pressure": P(4500, "psi"),
                "temperature": P(293, "K"),
                "volume": P(50, "L"),
            },
        ),
        node(
            "HPC",
            "SOL",
            "GSE High Press Control",
            page="GSE",
            params={"Cv": P(0.3, "Cv")},
        ),
        node("QG", "QD", "QD-CART", page="GSE", options={"pairedWith": "QV"}),
        node("QV", "QD", "QD-COPV", page="Main"),
    ]
    payload["edges"] += [
        line("bank-hpc", "BANK", "HPC"),
        line("hpc-qg", "HPC", "QG"),
        line("qv-kb", "QV", "KB"),
    ]
    model = assemble_model(read_diagram(payload, name="le4+cart"), diagram_id="x")
    machine = _machine()
    session = Session(model, machine, binding(model, machine, None))
    assert session.binding.to_symbol.get("GSE High Press Control") == "HPC"
    assert any("charged through the drawing" in a for a in session.assumptions)

    session.prime(tank_psi=0.0, copv_psi=1000.0, state="Idle", hold_s=1.0)
    bank = session.bottles["BANK"]  # prime sets every bottle; the cart's is full
    bank.state = bank.volume.initial_state(
        pressure=4500 * 6894.757 + 101325.0, temperature=293.15
    )
    session.state = "GN2 High Press"
    copv = session.bottles["KB"]
    start = copv.pressure
    for _ in range(100):
        session.step(0.05)
    assert not copv.filling, "the built-in charge stands aside"
    assert copv.pressure > start + 200 * 6894.757, "the drawn cart charged it"
    assert session.bottles["BANK"].pressure < 4500 * 6894.757 + 101325.0
