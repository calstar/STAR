"""A rounded nose tip is part of the airframe.

A sphere has a centre but no axis. The geometry store used to rebuild a face's
centre only when the face also had an axis, so every SPHERE came back without one
and outer-surface detection -- which accepts a sphere by its centre lying on the
centreline -- dropped it. On BART that left the 2.5 mm tip cap out, and the nose
started blunt at the cone/cap seam.
"""

from __future__ import annotations

import json

import numpy as np

from backend.onshape.aero.outer_surface import detect_outer_surface
from backend.onshape.aero.profile import build_profile
from backend.onshape.geometry import weld_vertices
from backend.onshape.geometry_store import GeometryStore
from test_aero_body import surface_of_revolution

A = 0.0025  # cap radius
R, L_NOSE, L_TUBE = 0.05, 0.30, 0.70
SHIFT = np.array([0.1, 0.2, 0.3])  # occurrence translation, so centres must be transformed


def _write(model_dir):
    phi = np.linspace(0.0, np.radians(80.0), 30)
    z_cap, r_cap = A - A * np.cos(phi), A * np.sin(phi)
    z_cone = np.linspace(z_cap[-1], L_NOSE, 60)
    r_cone = r_cap[-1] + (R - r_cap[-1]) * (z_cone - z_cap[-1]) / (L_NOSE - z_cap[-1])
    z_tube = np.linspace(L_NOSE, L_NOSE + L_TUBE, 30)
    pieces = [surface_of_revolution(z_cap, r_cap), surface_of_revolution(z_cone, r_cone),
              surface_of_revolution(z_tube, np.full_like(z_tube, R))]
    tris = np.concatenate(pieces)
    face_per_tri = np.concatenate([np.full(len(p), k, dtype=np.int32) for k, p in enumerate(pieces)])
    verts, flat = weld_vertices(tris.reshape(-1, 3))
    model_dir.mkdir(parents=True)
    nan3 = [np.nan] * 3
    np.savez_compressed(
        model_dir / "geometry.npz",
        v0=verts, i0=flat.reshape(-1, 3), f0=face_per_tri,
        o0=np.array([[0.0, 0.0, A], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]),
        x0=np.array([nan3, [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]]),
        r0=np.array([A, np.nan, R]),
    )
    transform = np.eye(4)
    transform[:3, 3] = SHIFT
    (model_dir / "geometry.json").write_text(json.dumps({
        "version": 2,
        "meshes": [{"faceIds": ["F_cap", "F_cone", "F_tube"], "faceTypes": ["SPHERE", "CONE", "CYLINDER"]}],
        "occurrences": [{"key": "occ:nose", "partId": "p", "mesh": 0, "transform": transform.flatten().tolist()}],
    }))


def test_sphere_keeps_its_centre(tmp_path):
    _write(tmp_path / "m")
    cap = next(f for f in GeometryStore.load(tmp_path / "m").iter_faces() if f.face_id == "F_cap")
    assert cap.axis_dir is None
    assert np.allclose(cap.axis_origin, SHIFT + [0.0, 0.0, A])


def test_rounded_tip_is_in_the_airframe_and_the_nose_is_pointed(tmp_path):
    _write(tmp_path / "m")
    store = GeometryStore.load(tmp_path / "m")
    guess = detect_outer_surface(store)
    assert ("occ:nose", "F_cap") in guess.faces
    tris = np.concatenate([f.triangles for f in store.faces_for(guess.faces)])
    profile, _ = build_profile(tris, axis=guess.axis)
    assert profile.r_fore < 1e-6
    assert abs((profile.x_aft - profile.x_fore) - (L_NOSE + L_TUBE)) < 1e-9
