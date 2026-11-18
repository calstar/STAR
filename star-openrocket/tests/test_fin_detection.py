"""Fin detection on rockets shaped like rockets, held to how they were built.

tests/rocket_mesh.py writes a full rocket (ogive nose, long 4 in tube, motor tube,
centering ring, swept fins with through-the-wall tabs) at known dimensions, with
Onshape-typed faces or with none, straight or tilted and moved off the origin. Every
variant must report the fins it was built with, and the CP and CNa must agree with
the OpenRocket port (orweb) on the same rocket -- an independent Barrowman, so a
detector that finds the "right" fins at the wrong size cannot pass.

Before this was written, untyped geometry found no fins at all and read the body
diameter as fin tip to fin tip (0.30 m): its fins became "skin" (outer_surface).
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

import rocket_mesh as rm
from backend import main

POSE_A = (rm._rot([1, 2, 0.5], 37), np.array([0.3, -1.2, 0.7]))
POSE_B = (rm._rot([0, 1, 1], -63), np.array([2.0, 0.1, -0.4]))
CASES = {
    "typed-3": dict(n_fins=3, typed=True),
    # A fin on the 0/360 azimuth seam: its two sides were grouped as two fins, so a
    # plain 4-fin Onshape rocket read as 5 uneven fins and was flagged asymmetric.
    "typed-4": dict(n_fins=4, typed=True),
    "typed-4-tilted": dict(n_fins=4, typed=True, pose=POSE_B),
    "untyped-3": dict(n_fins=3, typed=False),
    "untyped-4": dict(n_fins=4, typed=False),
    "untyped-3-tilted": dict(n_fins=3, typed=False, pose=POSE_A),
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    for name, kw in CASES.items():
        rm.write_rocket(tmp_path / name, **kw)
    rm.write_rocket(tmp_path / "untyped-nofins", typed=False, fins=False)
    rm.write_rocket(tmp_path / "typed-nofins", typed=True, fins=False)
    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    return TestClient(main.app)


@pytest.mark.parametrize("name", list(CASES))
def test_detects_the_fins_it_was_built_with(client, name):
    n = CASES[name]["n_fins"]
    guess = client.get(f"/api/models/{name}/fins").json()
    s = client.post(f"/api/models/{name}/stability", json={}).json()
    f = s["fins"]
    assert guess["count"] == n and f["count"] == n
    assert f["symmetric"] and not f.get("note")
    # Exact where the extraction reads an edge; within the 48-strip resolution
    # (FinSetCalc's, ~2 mm here) where it reads a chord.
    assert f["span"] == pytest.approx(rm.SPAN, abs=5e-4)
    assert f["tipChord"] == pytest.approx(rm.TIP, abs=5e-4)
    assert f["rootChord"] == pytest.approx(rm.ROOT, abs=2.5e-3)
    assert f["sweep"] == pytest.approx(rm.SWEEP, abs=2.5e-3)
    assert f["area"] == pytest.approx(rm.FIN_AREA, rel=0.01)
    assert s["bodyLength"] == pytest.approx(rm.TUBE + rm.NOSE, abs=1e-3)
    assert s["refDiameter"] == pytest.approx(2 * rm.R, abs=1e-4)


@pytest.mark.parametrize("name", ["untyped-nofins", "typed-nofins"])
def test_a_rocket_without_fins_has_none(client, name):
    s = client.post(f"/api/models/{name}/stability", json={}).json()
    assert client.get(f"/api/models/{name}/fins").json()["count"] == 0
    assert s["fins"]["count"] == 0
    assert s["refDiameter"] == pytest.approx(2 * rm.R, abs=1e-4)
    assert s["cna"] == pytest.approx(2.0, rel=0.01)  # Barrowman: a nose cone alone


def _openrocket(n_fins: int) -> dict:
    """The same rocket, built in the OpenRocket port."""
    from orweb import build_rocket, default_component, new_document
    from orweb.aero import analyze

    doc = new_document("rocket_mesh")
    stage = doc["rocket"]["children"][0]
    nose = default_component("nosecone")
    nose["params"].update(length=rm.NOSE, shape="ogive", shapeparameter=1.0,
                          aftradius={"auto": False, "value": rm.R})
    tube = default_component("bodytube")
    tube["params"].update(length=rm.TUBE, radius={"auto": False, "value": rm.R})
    fins = default_component("trapezoidfinset")
    fins["params"].update(fincount=n_fins, instancecount=n_fins, rootchord=rm.ROOT, tipchord=rm.TIP,
                          height=rm.SPAN, sweeplength=rm.SWEEP, thickness=rm.THICK,
                          crosssection="square", axialoffset={"method": "bottom", "value": 0.0})
    tube["children"].append(fins)
    stage["children"] += [nose, tube]
    return analyze(build_rocket(doc), 0.3, 0.0)


@pytest.mark.parametrize("name", list(CASES))
def test_cp_and_cna_agree_with_openrocket(client, name):
    ork = _openrocket(CASES[name]["n_fins"])
    s = client.post(f"/api/models/{name}/stability", json={}).json()
    assert s["cp"]["fromNose"] == pytest.approx(ork["cp"]["x"], abs=2e-3)
    assert s["cna"] == pytest.approx(ork["cp"]["cna"], rel=0.005)


def test_the_reference_rocket_fixture_has_its_three_fins(tmp_path, monkeypatch, empty_version_assembly):
    """The checked-in BART rocket: its tubes are 30-facet scraps (make_fixtures.py), its
    three fins are whole. They must be found -- they were not, before the skin stopped
    taking fin faces."""
    from backend.onshape import build as build_mod
    from conftest import FakeClient as FC
    from test_fin_consistency import WORKSPACE_URL

    def make_client(*a, **k):
        c = FC()
        orig = c.get_json

        def gj(path, params=None):
            if path.startswith("/assemblies/") and "/v/" in path:
                return empty_version_assembly
            return orig(path, params)

        c.get_json = gj  # type: ignore[method-assign]
        return c

    monkeypatch.setattr(build_mod, "OnshapeClient", make_client)
    build_mod.build(WORKSPACE_URL, output_dir=tmp_path / "bart")
    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    c = TestClient(main.app)
    assert c.get("/api/models/bart/fins").json()["count"] == 3
    f = c.post("/api/models/bart/stability", json={}).json()["fins"]
    assert f["count"] == 3 and f["symmetric"]
