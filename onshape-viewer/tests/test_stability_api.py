"""The stability endpoint over a synthetic cone+tube model."""

from __future__ import annotations

import json

import numpy as np
from fastapi.testclient import TestClient

from backend import main
from backend.motors import load_rasp
from backend.motors.db import MotorDB, motor_to_dict
from backend.onshape.geometry import weld_vertices
from test_aero_body import surface_of_revolution
from test_motors_loader import _text


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


# -- Motor catalog + motor-inclusive stability --------------------------------


def _install_motor_db(monkeypatch, tmp_path):
    """Point main._motor_db at a one-motor mirror built from the RASP fixture."""
    motors_dir = tmp_path / "motors"
    (motors_dir / "data").mkdir(parents=True)
    motor = load_rasp(_text("test1.eng"))[0]
    motor.motor_id = "mtr1"
    motor.simfile_id = "sf1"
    (motors_dir / "data" / "mtr1.json").write_text(
        json.dumps({"motorId": "mtr1", "simfiles": [motor_to_dict(motor)]})
    )
    (motors_dir / "index.json").write_text(
        json.dumps(
            {
                "fetchedAt": "2026-08-11T00:00:00+00:00",
                "count": 1,
                "motors": [
                    {"motorId": "mtr1", "manufacturer": "AeroTech",
                     "manufacturerAbbrev": "AT", "designation": motor.designation,
                     "commonName": "D10", "impulseClass": "D",
                     "simfiles": [{"simfileId": "sf1", "format": "RASP", "quality": "basic"}]}
                ],
            }
        )
    )
    monkeypatch.setattr(main, "_motor_db", MotorDB(motors_dir))
    return motor


def test_motor_search_endpoint(monkeypatch, tmp_path):
    _install_motor_db(monkeypatch, tmp_path)
    resp = client(monkeypatch, tmp_path).get("/api/motors", params={"query": "AeroTech"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert [m["motorId"] for m in body["items"]] == ["mtr1"]


def test_motor_detail_endpoint_carries_curve_and_quality(monkeypatch, tmp_path):
    _install_motor_db(monkeypatch, tmp_path)
    resp = client(monkeypatch, tmp_path).get("/api/motors/mtr1")
    assert resp.status_code == 200
    sim = resp.json()["simfiles"][0]
    assert sim["quality"] == "basic"
    assert sim["format"] == "RASP"
    assert len(sim["time"]) == len(sim["thrust"]) > 2
    assert sim["wetMass"] > sim["dryMass"]


def test_stability_with_motor_shifts_cg_and_margin(monkeypatch, tmp_path):
    motor = _install_motor_db(monkeypatch, tmp_path)
    parts = [
        {"key": "occ:body", "mass": 0.0, "centroidWorld": [0, 0, 0.0], "hasGeometry": True},
        {"key": "nose", "mass": 0.2, "centroidWorld": [0, 0, 0.1], "hasGeometry": False},
    ]
    _write_model(tmp_path / "mm", parts)
    tc = client(monkeypatch, tmp_path)

    base = tc.post(
        "/api/models/mm/stability",
        json={"outerFaces": [{"key": "occ:body", "faceId": "F_outer"}]},
    ).json()
    withm = tc.post(
        "/api/models/mm/stability",
        json={
            "outerFaces": [{"key": "occ:body", "faceId": "F_outer"}],
            "motor": {"motorId": "mtr1", "state": "launch"},
        },
    ).json()

    assert withm["motor"]["quality"] == "basic"
    assert withm["motor"]["wetMass"] == motor.launch_mass
    assert withm["motor"]["aftFromNose"] == 1.0  # aft-flush with the 1 m body
    assert withm["mass"] == base["mass"] + motor.launch_mass
    # Motor added aft of the nose part -> CG moves aft, margin drops.
    assert withm["cg"]["fromNose"] > base["cg"]["fromNose"]
    assert withm["staticMargin"] < base["staticMargin"]


def test_stability_unknown_motor_is_404(monkeypatch, tmp_path):
    _install_motor_db(monkeypatch, tmp_path)
    _write_model(tmp_path / "mm2", [{"key": "occ:body", "mass": 1.0,
                                     "centroidWorld": [0, 0, 0.5], "hasGeometry": True}])
    resp = client(monkeypatch, tmp_path).post(
        "/api/models/mm2/stability", json={"motor": {"motorId": "nope"}}
    )
    assert resp.status_code == 404
