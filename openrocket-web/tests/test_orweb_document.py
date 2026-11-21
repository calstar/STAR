"""The document-level helpers the API serves report OpenRocket's numbers."""

from __future__ import annotations

import json

import pytest

from _orweb_check import HERE, close, load
from orweb import (analysis_components, build_rocket, document_from_json, mass_properties, new_document,
                   read_ork, resolve_auto_values)

NAMES = ["A simple model rocket", "Pods--powered with recovery deployment", "Clustered motors",
         "Two stage high power rocket"]


@pytest.fixture(params=NAMES)
def case(request):
    g = json.loads((HERE / "golden" / f"{request.param}.json").read_text())
    return load(HERE / "rockets" / f"{request.param}.ork", g), g


def test_mass_properties(case):
    r, g = case
    mp = mass_properties(r)
    for k in ("launch", "structure", "burnout", "motor"):
        for f in ("mass", "cgx", "Ixx", "Iyy"):
            assert close(mp[k][f], g["rocket"][k][f]), (k, f)
    assert close(mp["cg"]["x"], g["rocket"]["launch"]["cgx"])
    assert close(mp["referenceLength"], g["rocket"]["refLength"])
    assert close(mp["lengthAerodynamic"], g["rocket"]["lengthAero"])
    assert sorted(m["mount"] for m in mp["motors"]) == sorted(m["mount"] for m in g["motors"])
    json.dumps(mp)  # JSON-able


def test_component_analysis_is_openrockets_cm_analysis(case):
    r, g = case
    cm = {e["id"]: e for e in g["cm"] if e["id"] is not None}
    rows = analysis_components(r)
    assert rows
    for row in rows:
        e = cm[row["id"]]
        assert close(row["eachMass"], e["eachMass"])
        if row["type"] not in ("stage", "parallelstage", "podset"):
            assert close(row["mass"], e["totalMass"])
            assert close(row["cgx"], e["cgx"])
        comp = next(c for c in g["components"] if c["id"] == row["id"])
        assert close(row["x"], comp["locations"][0][0])


def test_resolve_auto_values():
    name = "A simple model rocket"
    doc = read_ork(HERE / "rockets" / f"{name}.ork")
    g = json.loads((HERE / "golden" / f"{name}.json").read_text())
    out = resolve_auto_values(doc)
    rings = [c for c in out["rocket"]["children"][0]["children"][1]["children"] if c["type"] == "centeringring"]
    for ring in rings:
        gc = next(c for c in g["components"] if c["id"] == ring["id"])
        assert ring["params"]["outerradius"] == {"auto": True, "value": gc["outerRadius"]}
        assert ring["params"]["innerradius"] == {"auto": True, "value": gc["innerRadius"]}
    assert doc["rocket"]["children"][0]["children"][1]["children"][6]["params"]["outerradius"]["value"] is None


def test_document_validation():
    with pytest.raises(ValueError):
        document_from_json({"rocket": {"type": "stage", "id": "x"}})
    with pytest.raises(ValueError):
        document_from_json({"rocket": {"type": "rocket", "id": "r", "children": [{"type": "nosecone"}]}})
    doc = document_from_json(new_document())
    assert build_rocket(doc).warnings == []


def test_unknown_params_warn_but_build():
    doc = new_document()
    doc["rocket"]["children"][0]["children"].append(
        {"id": "n1", "type": "nosecone", "name": "N", "params": {"length": 0.2, "frobnicate": 3}, "children": []})
    r = build_rocket(doc)
    assert r.by_id["n1"].get_length() == 0.2
    assert any("frobnicate" in w for w in r.warnings)
