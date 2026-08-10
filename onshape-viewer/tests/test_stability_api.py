"""The stability endpoint over a synthetic cone+tube model."""

from __future__ import annotations

import json

import numpy as np
from fastapi.testclient import TestClient

from backend import main
from backend.onshape.geometry import weld_vertices
from test_aero_body import surface_of_revolution


def _write_model(model_dir, parts):
    """Write a minimal manifest + geometry sidecar for a cone+tube body."""
    L_nose, L_tube, R = 0.3, 0.7, 0.05
    z_nose = np.linspace(0, L_nose, 120)
    z_tube = np.linspace(L_nose, L_nose + L_tube, 120)[1:]
    z = np.concatenate([z_nose, z_tube])
    r = np.concatenate([R * z_nose / L_nose, np.full_like(z_tube, R)])
    tris = surface_of_revolution(z, r)

    verts, flat = weld_vertices(tris.reshape(-1, 3))
    indices = flat.reshape(-1, 3)
    face_per_tri = np.zeros(len(indices), dtype=np.int32)

    model_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        model_dir / "geometry.npz",
        v0=verts,
        i0=indices,
        f0=face_per_tri,
        o0=np.array([[0.0, 0.0, 0.0]]),  # one face: axis origin on the centreline
        x0=np.array([[0.0, 0.0, 1.0]]),  # axis along +z
        r0=np.array([R]),
    )
    (model_dir / "geometry.json").write_text(
        json.dumps(
            {
                "version": 2,
                "meshes": [{"faceIds": ["F_outer"], "faceTypes": ["CYLINDER"]}],
                "occurrences": [
                    {
                        "key": "occ:body",
                        "partId": "part",
                        "mesh": 0,
                        "transform": np.eye(4).flatten().tolist(),
                    }
                ],
            }
        )
    )
    (model_dir / "manifest.json").write_text(json.dumps({"schemaVersion": 2, "parts": parts}))
    return L_nose


def client(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CACHE_ROOT", tmp_path)
    return TestClient(main.app)


def test_outer_surface_endpoint_finds_the_body(monkeypatch, tmp_path):
    _write_model(tmp_path / "m1", parts=[])
    resp = client(monkeypatch, tmp_path).get("/api/models/m1/outer-surface")
    assert resp.status_code == 200
    body = resp.json()
    assert {"key": "occ:body", "faceId": "F_outer"} in body["faces"]
    assert len(body["axis"]["direction"]) == 3


def test_stability_endpoint_returns_cp_cg_margin(monkeypatch, tmp_path):
    total = 1.0
    parts = [
        {"key": "occ:body", "mass": 0.0, "centroidWorld": [0, 0, 0.0], "hasGeometry": True},
        {"key": "m_fwd", "mass": 2.0, "centroidWorld": [0, 0, 0.2 * total], "hasGeometry": False},
        {"key": "m_aft", "mass": 1.0, "centroidWorld": [0, 0, 0.9 * total], "hasGeometry": False},
    ]
    L_nose = _write_model(tmp_path / "m2", parts)

    resp = client(monkeypatch, tmp_path).post(
        "/api/models/m2/stability",
        json={"outerFaces": [{"key": "occ:body", "faceId": "F_outer"}], "overrides": {}},
    )
    assert resp.status_code == 200
    data = resp.json()

    assert abs(data["cp"]["fromNose"] - 2 * L_nose / 3) < 0.02 * L_nose
    assert abs(data["cna"] - 2.0) < 0.03
    assert abs(data["refDiameter"] - 0.1) < 1e-3
    assert data["mass"] == 3.0
    # CG well aft of the nose-dominated CoP -> unstable.
    assert data["staticMargin"] < 0


def test_stability_auto_detects_when_faces_omitted(monkeypatch, tmp_path):
    parts = [{"key": "occ:body", "mass": 1.0, "centroidWorld": [0, 0, 0.5], "hasGeometry": True}]
    _write_model(tmp_path / "m3", parts)
    resp = client(monkeypatch, tmp_path).post("/api/models/m3/stability", json={})
    assert resp.status_code == 200
    assert resp.json()["cna"] > 0


def test_missing_sidecar_is_a_clear_409(monkeypatch, tmp_path):
    (tmp_path / "old").mkdir()
    (tmp_path / "old" / "manifest.json").write_text(json.dumps({"parts": []}))
    resp = client(monkeypatch, tmp_path).post("/api/models/old/stability", json={})
    assert resp.status_code == 409
    assert "rebuild" in resp.json()["detail"]
