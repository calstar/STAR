"""The API's numbers are OpenRocket's: /api/analyze on each example against the oracle.

The ports are held to the golden data in their own tests; this checks the API
layer does not lose or mislabel anything on the way to the UI (a CG from the
wrong body, a margin over the wrong length, a per-instance number summed twice).
"""

import json
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app

ROOT = Path(__file__).resolve().parent
client = TestClient(app)
NAMES = sorted(p.stem for p in (ROOT / "rockets").glob("*.ork"))


def close(a, b, rel=1e-9):
    return math.isclose(a, b, rel_tol=rel, abs_tol=1e-12)


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("mach,aoa", [(0.3, 0.0), (1.3, 2.0)])
def test_analyze_matches_openrocket(name, mach, aoa):
    gold = json.loads((ROOT / "golden" / f"{name}.json").read_text())
    doc = client.get(f"/api/examples/{name}").json()
    r = client.post("/api/analyze", json={"document": doc, "conditions": {"mach": mach, "aoaDeg": aoa}})
    assert r.status_code == 200, r.text
    a = r.json()
    launch, structure = gold["rocket"]["launch"], gold["rocket"]["structure"]
    assert close(a["cg"]["x"], launch["cgx"]) and close(a["cg"]["mass"], launch["mass"])
    assert close(a["cgEmpty"]["x"], structure["cgx"]) and close(a["cgEmpty"]["mass"], structure["mass"])
    assert close(a["reference"]["length"], gold["rocket"]["refLength"])
    assert close(a["length"], gold["rocket"]["length"])
    assert close(a["lengthAerodynamic"], gold["rocket"]["lengthAero"])
    # RocketPanel's "max. diameter": largest fore/aft diameter of the symmetric components
    radii = [max(c["foreRadius"], c["aftRadius"]) for c in gold["components"]
             if "foreRadius" in c and c["active"]]
    assert close(a["maxDiameter"], 2 * max(radii))

    point = next(p for p in gold["aero"] if p["mach"] == mach and p["aoaDeg"] == aoa)
    rocket_id = doc["rocket"]["id"]
    total = next(f for f in point["forces"] if f["id"] == rocket_id)
    assert close(a["cp"]["x"], total["cpx"]) and close(a["cp"]["cna"], total["cna"])
    assert close(a["cd"]["total"], total["CD"])
    for k in ("friction", "pressure", "base"):
        assert close(a["cd"][k], total[f"{k}CD"])
    # the stability readout OpenRocket's figure prints: (CP - CG) / reference length
    assert close(a["stability"]["calibers"], (total["cpx"] - launch["cgx"]) / gold["rocket"]["refLength"])

    rows = {c["id"]: c for c in a["components"]}
    for f in point["forces"]:
        if f["id"] in rows and f["cpx"] is not None and rows[f["id"]]["cpx"] is not None:
            assert close(rows[f["id"]]["cpx"], f["cpx"]), f["name"]
            assert close(rows[f["id"]]["cd"], f["CD"]), f["name"]


def test_roundtrip_export_import_is_lossless():
    doc = client.get("/api/examples/A simple model rocket").json()
    ork = client.post("/api/ork/export", json=doc)
    assert ork.status_code == 200 and ork.content[:2] == b"PK"
    back = client.post("/api/ork/import", files={"file": ("x.ork", ork.content)}).json()
    a1 = client.post("/api/analyze", json={"document": doc}).json()
    a2 = client.post("/api/analyze", json={"document": back}).json()
    assert a1["cg"] == a2["cg"] and a1["cp"] == a2["cp"]


def test_bad_document_is_422_not_500():
    r = client.post("/api/analyze", json={"document": {"rocket": {"type": "nosecone"}}})
    assert r.status_code == 422


@pytest.mark.parametrize("t", ["nosecone", "bodytube", "trapezoidfinset", "freeformfinset", "parachute", "innertube"])
def test_defaults_build_into_a_rocket(t):
    doc = client.get("/api/examples/A simple model rocket").json()
    comp = client.get(f"/api/components/defaults/{t}").json()
    body = doc["rocket"]["children"][0]["children"][1]  # the body tube
    (body if t not in ("nosecone", "bodytube") else doc["rocket"]["children"][0])["children"].append(comp)
    r = client.post("/api/analyze", json={"document": doc})
    assert r.status_code == 200, r.text
    assert any(c["id"] == comp["id"] for c in r.json()["components"])
