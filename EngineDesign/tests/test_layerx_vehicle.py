"""Layer X burns the vehicle, not the GSE drawn beside it (engine/layerx/vehicle.py).

LE4 (6) drew the rocket on one page and the GSE on another, joined only by quick-disconnects paired
across the pages. Layer X then found two ethanol tanks (the vehicle's and the GSE transfer tank),
swapped the GSE K-bottles to helium along with the COPV, and -- with the GSE dome regulator mated
to the vehicle's dome line -- tripped the LOX tank before T-0. These pin the cut on a small drawing
of the same shape, and that a one-piece drawing is untouched.
"""

from __future__ import annotations

import copy

import pytest

pytest.importorskip("feedtwin", reason="lib/feedtwin is not installed")


def _node(nid, typ, label, page, fluid=None, **params):
    data = {"componentType": typ, "label": label, "page": page, "options": {}, "params": {
        k: {"value": v[0], "unit": v[1], "source": "estimated"} for k, v in params.items()}}
    if fluid:
        data["fluid"] = fluid
    return {"id": nid, "type": typ, "position": {"x": 0, "y": 0}, "data": data}


def _edge(a, b):
    return {"id": f"{a}-{b}", "source": a, "target": b, "data": {}}


def stand_with_gse():
    nodes = [
        _node("eng", "ENGINE", "ENG-1", "Rocket"),
        _node("copv", "KBOTTLE", "COPV", "Rocket", "nitrogen", pressure=(4000, "psi"), volume=(4.69, "L")),
        _node("reg", "PR", "DPR", "Rocket"),
        _node("fut", "TANK", "Eth-Tank", "Rocket", "ethanol", volume=(8.19, "L")),
        _node("oxt", "TANK", "LOX-Tank", "Rocket", "oxygen", volume=(8.19, "L")),
        _node("fm", "ROT", "FM", "Rocket"),
        _node("om", "ROT", "OM", "Rocket"),
        _node("qv", "QD", "QD-FF-B", "Rocket"),
        _node("rtd", "RTD", "OX-RTD", "Rocket"),
        # GSE page: a transfer tank and a cart bottle, behind the disconnect's other half.
        _node("qg", "QD", "QD-FF-A", "GSE"),
        _node("xfer", "TANK", "Fuel Transfer Tank", "GSE", "ethanol", volume=(20, "L")),
        _node("k6", "KBOTTLE", "6K-GN2", "GSE", "nitrogen", pressure=(6000, "psi"), volume=(49, "L")),
    ]
    by = {n["id"]: n for n in nodes}
    by["qv"]["data"]["options"]["pairedWith"] = "qg"
    by["rtd"]["data"]["attachedTo"] = "oxt"
    edges = [_edge("copv", "reg"), _edge("reg", "fut"), _edge("reg", "oxt"), _edge("fut", "fm"), _edge("fm", "eng"),
             _edge("oxt", "om"), _edge("om", "eng"), _edge("fut", "qv"), _edge("qg", "xfer"), _edge("k6", "xfer")]
    return {"nodes": nodes, "edges": edges}


def test_the_vehicle_is_what_lines_join_to_the_engine():
    from feedtwin.pid import read_diagram

    from engine.layerx.vehicle import vehicle_ids

    v = vehicle_ids(read_diagram(stand_with_gse(), name="t"))
    assert {"eng", "copv", "reg", "fut", "oxt", "fm", "om", "qv", "rtd"} <= v
    assert not v & {"qg", "xfer", "k6"}


def test_the_cut_drops_the_gse_and_caps_the_vehicle_half():
    from engine.layerx.vehicle import vehicle_payload

    payload = stand_with_gse()
    cut, ground = vehicle_payload(payload)
    ids = {n["id"] for n in cut["nodes"]}
    assert "xfer" not in ids and "k6" not in ids and "qg" not in ids
    assert sorted(ground) == ["6K-GN2", "Fuel Transfer Tank"]
    assert next(n for n in cut["nodes"] if n["id"] == "qv")["data"]["options"]["pairedWith"] == ""
    assert all(e["source"] in ids and e["target"] in ids for e in cut["edges"])
    # The caller's drawing is not mutated.
    assert next(n for n in payload["nodes"] if n["id"] == "qv")["data"]["options"]["pairedWith"] == "qg"


def test_a_one_piece_drawing_comes_back_untouched():
    from engine.layerx.vehicle import vehicle_payload

    payload = stand_with_gse()
    payload["edges"].append(_edge("qv", "qg"))  # GSE drawn with a line into the vehicle: one piece
    same, ground = vehicle_payload(payload)
    assert same is payload and ground == []


def test_helium_swaps_only_the_vehicle_bottle():
    from engine.layerx.prepare import swap_pressurant

    out, n, was = swap_pressurant(stand_with_gse(), "helium")
    fluid = {nd["id"]: nd["data"].get("fluid") for nd in out["nodes"]}
    assert was == "nitrogen" and n == 1
    assert fluid["copv"] == "helium" and fluid["k6"] == "nitrogen"


def test_the_summary_lists_the_vehicle_and_the_gse_apart():
    from engine.layerx.sources import summarize

    s = summarize(copy.deepcopy(stand_with_gse()), "t")
    assert [t["label"] for t in s["tanks"]] == ["Eth-Tank", "LOX-Tank"]
    assert [b["label"] for b in s["bottles"]] == ["COPV"]
    assert {g["label"] for g in s["ground_support"]} == {"Fuel Transfer Tank", "6K-GN2"}
