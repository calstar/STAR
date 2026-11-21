"""Every route sees the same fins, and a fin with no planform is no fin.

Found by the ORK vs CAD tab on the reference rocket (the fixture build): Compute
stability seeds from GET /fins, which found no fins, while Export .ork and "Load
CAD into OpenRocket" auto-detect, which found two -- with zero chord and zero
area, written into the .ork 4.87 m ahead of the body and making the exported
rocket 309 % longer than the CAD. Two causes, one test each:

  * /fins measured against the model's cylinder axis; the other routes, sent no
    axis, re-fitted one to the body triangles, and the fin detector run against
    that tilted axis accepted faces /fins did not (main._resolve_body).
  * nothing rejected a planform with no chord or area
    (fins.degenerate_fin_reason).
"""

from __future__ import annotations

import io
import json
import re
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.onshape import build as build_mod
from backend.onshape.aero.fins import FinPlanform, degenerate_fin_reason
from conftest import FakeClient

WORKSPACE_URL = (
    "https://starberkeley.onshape.com/documents/dbf4d35d8e9fe37819466f72"
    "/w/1df1c851058d46a5e5f08114/e/a194351ef67344579daff54b"
)


@pytest.fixture
def reference_rocket(tmp_path, monkeypatch, empty_version_assembly):
    """The reference rocket built from fixtures (as test_build does), served by the app."""

    def make_client(*args, **kwargs):
        client = FakeClient()
        original = client.get_json

        def get_json(path, params=None):
            if path.startswith("/assemblies/") and "/v/" in path:
                client.requests.append((path, params or {}))
                return empty_version_assembly
            return original(path, params)

        client.get_json = get_json  # type: ignore[method-assign]
        return client

    monkeypatch.setattr(build_mod, "OnshapeClient", make_client)
    build_mod.build(WORKSPACE_URL, output_dir=tmp_path / "model")
    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    return TestClient(main.app), "model"


def _ork_xml(content: bytes) -> str:
    z = zipfile.ZipFile(io.BytesIO(content))
    return z.read(z.namelist()[0]).decode()


def test_fins_stability_and_export_agree_on_the_fins(reference_rocket):
    client, mid = reference_rocket
    guess = client.get(f"/api/models/{mid}/fins").json()

    # What the CAD tab's Compute stability sends: /fins' guess, as an explicit list.
    seeded = client.post(f"/api/models/{mid}/stability", json={"finFaces": guess["faces"]}).json()
    # What Export .ork and Load CAD send: nothing picked, so the route auto-detects.
    auto = client.post(f"/api/models/{mid}/stability", json={}).json()
    # The UI's other path: body faces picked (seeded from /outer-surface), no axis sent.
    body = client.get(f"/api/models/{mid}/outer-surface").json()["faces"]
    picked = client.post(f"/api/models/{mid}/stability", json={"outerFaces": body}).json()

    counts = {"/fins": guess["count"], "seeded": seeded["fins"]["count"],
              "auto": auto["fins"]["count"], "picked body": picked["fins"]["count"]}
    assert len(set(counts.values())) == 1, counts

    xml = _ork_xml(client.post(f"/api/models/{mid}/export.ork", json={}).content)
    exported = len(re.findall(r"<(?:freeform|trapezoid)finset>", xml))
    assert exported == (1 if guess["count"] else 0), (exported, counts)


def test_degenerate_fins_are_rejected_and_say_why(reference_rocket):
    """Force the old, re-fitted axis: the detector finds the slivers again, and the guard
    must turn them away -- in /stability and in the .ork -- and say why.

    With one axis per model (the fix above) this rocket no longer produces them at all,
    so the axis that did is passed explicitly to exercise the guard end to end.
    """
    client, mid = reference_rocket
    from backend.onshape.aero.profile import build_profile

    store = main._load_store(main._model_dir(mid))
    body = client.get(f"/api/models/{mid}/outer-surface").json()["faces"]
    tris = np.concatenate([f.triangles for f in store.faces_for([(b["key"], b["faceId"]) for b in body])])
    _, refit = build_profile(tris, axis=None)
    axis = {"origin": refit.origin.tolist(), "direction": refit.direction.tolist()}

    r = client.post(f"/api/models/{mid}/stability", json={"outerFaces": body, "axis": axis}).json()
    assert r["fins"]["count"] == 0 and r["fins"]["area"] == 0.0
    assert r["fins"]["note"] and "do not form one" in r["fins"]["note"], r["fins"]

    xml = _ork_xml(client.post(f"/api/models/{mid}/export.ork", json={"outerFaces": body, "axis": axis}).content)
    assert not re.search(r"<(?:freeform|trapezoid)finset>", xml)


def test_exported_length_is_the_cad_body(reference_rocket):
    """The .ork the CAD exports is as long as the CAD: no fin set hung metres off it."""
    client, mid = reference_rocket
    body_length = client.post(f"/api/models/{mid}/stability", json={}).json()["bodyLength"]
    xml = _ork_xml(client.post(f"/api/models/{mid}/export.ork", json={}).content)

    from orweb import build_rocket, read_ork, write_ork  # noqa: F401  (orweb: the OpenRocket tab's port)

    doc = read_ork(xml.encode())
    config = build_rocket(doc).get_selected_configuration()
    assert config.get_length() == pytest.approx(body_length, rel=0.01)


def _planform(**kw) -> FinPlanform:
    base = dict(chord_lead=np.zeros(3), chord_trail=np.full(3, 0.1), span=0.08, body_radius=0.05,
                n_fins=4, root_chord=0.1, tip_chord=0.05, sweep=0.04, area=0.006, azimuths=[0, 90, 180, 270])
    base.update(kw)
    return FinPlanform(**base)


@pytest.mark.parametrize("bad", [dict(root_chord=0.0, area=0.0), dict(span=0.0), dict(area=1e-8)])
def test_a_planform_with_nothing_to_it_is_not_a_fin(bad):
    assert degenerate_fin_reason(_planform(**bad)) is not None


def test_a_small_real_fin_is_still_a_fin():
    # 25 mm root, 20 mm span: a model-rocket fin, well clear of the 1 mm guard.
    assert degenerate_fin_reason(_planform(root_chord=0.025, tip_chord=0.01, span=0.02, area=0.00035)) is None


def test_routes_measure_against_the_models_axis(reference_rocket):
    """No axis sent means the model's own (/outer-surface's, from the CAD cylinders) --
    whether the body faces were picked or left to auto-detect. Re-fitting one per
    request is what made /fins and /stability see different fins; the degenerate-fin
    guard happens to hide that on this model, so it is checked here directly."""
    client, mid = reference_rocket
    surface = client.get(f"/api/models/{mid}/outer-surface").json()
    model_axis = np.asarray(surface["axis"]["direction"], dtype=float)
    for body in ([], surface["faces"]):
        d = np.asarray(client.post(f"/api/models/{mid}/stability",
                                   json={"outerFaces": body}).json()["axisDirection"], dtype=float)
        # build_profile may flip it nose->tail; the line must be the same.
        assert abs(float(np.dot(d, model_axis))) == pytest.approx(1.0, abs=1e-12), (len(body), d, model_axis)
