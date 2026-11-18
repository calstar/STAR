"""The OpenRocket tab's API: openrocket-web's router, mounted at /api/ork.

Two things are checked. That the mount answers at all (health, examples, analyze)
with OpenRocket's own numbers for one of its own examples. And the round trip the
ORK vs CAD tab rests on: the CAD's .ork export, imported through /api/ork and
analysed by the port, gives back the CAD's CP, CNa, CG and mass -- the same claims
``test_ork_openrocket.py`` checks against OpenRocket itself, but without a JDK, so
they run in the main gate.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.onshape.aero.outer_surface import detect_outer_surface
from backend.onshape.aero.stability import compute_stability
from test_ork_export import PARTS, _export, rocket

GOLDEN = Path(__file__).resolve().parents[2] / "openrocket-web" / "tests" / "golden"

client = TestClient(main.app)


def test_health_is_openrocket_24_12():
    r = client.get("/api/ork/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "openrocket": "24.12"}


def test_examples_are_the_packaged_ones():
    names = [e["name"] for e in client.get("/api/ork/examples").json()]
    assert "A simple model rocket" in names and "Two stage high power rocket" in names


def test_unknown_example_is_404():
    assert client.get("/api/ork/examples/..%2Fsecrets").status_code == 404
    assert client.get("/api/ork/examples/nope").status_code == 404


@pytest.mark.parametrize("name", ["A simple model rocket", "Two stage high power rocket"])
def test_analyze_an_example_matches_openrocket(name):
    doc = client.get(f"/api/ork/examples/{name}").json()
    r = client.post("/api/ork/analyze", json={"document": doc, "conditions": {"mach": 0.3, "aoaDeg": 0}})
    assert r.status_code == 200, r.text
    a = r.json()
    gold = json.loads((GOLDEN / f"{name}.json").read_text())
    launch = gold["rocket"]["launch"]
    point = next(p for p in gold["aero"] if p["mach"] == 0.3 and p["aoaDeg"] == 0.0)
    total = next(f for f in point["forces"] if f["id"] == doc["rocket"]["id"])
    assert math.isclose(a["cg"]["x"], launch["cgx"], rel_tol=1e-9)
    assert math.isclose(a["cg"]["mass"], launch["mass"], rel_tol=1e-9)
    assert math.isclose(a["cp"]["x"], total["cpx"], rel_tol=1e-9)
    assert math.isclose(a["cp"]["cna"], total["cna"], rel_tol=1e-9)


def test_star_openrocket_routes_are_untouched():
    """The mount is under /api/ork only: the app's own /api/health still answers as before."""
    body = client.get("/api/health").json()
    assert body["status"] == "healthy"


@pytest.mark.parametrize("section", ["square", "airfoil"])
def test_cad_export_reads_back_through_the_port(section):
    """CAD -> .ork -> /api/ork/ork/import -> /api/ork/analyze gives the CAD's numbers.

    The "Load CAD into OpenRocket" button is exactly this path, so the comparison
    starts from agreement: what it then shows is what the user changed.
    """
    store = rocket(section)
    faces = detect_outer_surface(store).faces
    cad = compute_stability(store, PARTS, faces)
    data, plan = _export(store)

    imported = client.post("/api/ork/ork/import", files={"file": ("cad.ork", data)})
    assert imported.status_code == 200, imported.text
    doc = imported.json()
    r = client.post("/api/ork/analyze", json={"document": doc, "conditions": {"mach": 0.3}})
    assert r.status_code == 200, r.text
    a = r.json()

    # The port computes what the exporter predicts OpenRocket will...
    assert a["cp"]["x"] == pytest.approx(plan.cp_ork, abs=1e-9)
    assert a["cp"]["cna"] == pytest.approx(plan.cna_ork, rel=1e-9)
    # ...which is the CAD's CP to well under a millimetre, and its CNa.
    assert abs(a["cp"]["x"] - cad.cp_from_nose) < 5e-4
    assert a["cp"]["cna"] == pytest.approx(cad.cna, rel=1e-3)
    assert a["reference"]["length"] == pytest.approx(cad.ref_diameter, rel=1e-9)
    # No motor in this export: the structure is the whole rocket, and it is the CAD's.
    assert a["cgEmpty"]["x"] == pytest.approx(cad.cg_from_nose, abs=1e-9)
    assert a["cgEmpty"]["mass"] == pytest.approx(cad.mass, rel=1e-12)
    # The airframe is the profile simplified to a tolerance (ork_export.airframe_segments).
    assert a["length"] == pytest.approx(cad.body_length, abs=5e-4)
