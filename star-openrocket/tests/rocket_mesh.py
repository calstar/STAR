"""A whole rocket as a built model: nose cone, long body tube, fins on the tube.

The checked-in Onshape fixtures keep 30 facets per part (make_fixtures.py), which is
fine for the build tests and useless for geometry: the reference rocket's tubes and
nose are scraps, so nothing there ever tested fin detection on a rocket-shaped
rocket. This writes one, with known dimensions, so detection can be held to them.

Geometry (metres), built along +z with the tail at z = 0 and the nose tip at
z = TUBE + NOSE, then moved by an optional rigid ``pose`` so nothing depends on the
rocket sitting on a world axis:

* body tube: outer + inner cylinder, radius R, length TUBE
* nose: tangent ogive, length NOSE, base radius R
* motor tube: cylinder radius MOTOR_R, aft MOTOR_LEN of the tube; a centering ring
* ``n_fins`` trapezoidal fins (ROOT, TIP, SPAN, SWEEP), thickness THICK, trailing
  edge at the tail, each with a tab through the tube wall down to the motor tube

``typed=True`` labels faces as Onshape does (CYLINDER with an axis, SPUN, PLANE);
``typed=False`` labels everything OTHER with no axis -- the fallback path.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

R = 0.0508          # 4 in body tube
TUBE = 1.20
NOSE = 0.40
MOTOR_R = 0.030
MOTOR_LEN = 0.30
WALL = 0.002
ROOT, TIP, SPAN, SWEEP, THICK = 0.20, 0.05, 0.10, 0.15, 0.005
FIN_AREA = 0.5 * (ROOT + TIP) * SPAN


def _revolve(z: np.ndarray, r: np.ndarray, n: int = 48) -> np.ndarray:
    """Triangles of the surface of revolution of the profile (z, r) about +z."""
    th = np.linspace(0, 2 * np.pi, n + 1)
    ring = lambda zi, ri: np.stack([ri * np.cos(th), ri * np.sin(th), np.full_like(th, zi)], axis=1)
    tris = []
    for i in range(len(z) - 1):
        a, b = ring(z[i], r[i]), ring(z[i + 1], r[i + 1])
        for j in range(n):
            tris.append([a[j], a[j + 1], b[j + 1]])
            tris.append([a[j], b[j + 1], b[j]])
    return np.asarray(tris)


def _annulus(z: float, r_in: float, r_out: float, n: int = 48) -> np.ndarray:
    th = np.linspace(0, 2 * np.pi, n + 1)
    tris = []
    for j in range(n):
        p = lambda r, t: [r * np.cos(t), r * np.sin(t), z]
        a, b, c, d = p(r_in, th[j]), p(r_out, th[j]), p(r_out, th[j + 1]), p(r_in, th[j + 1])
        tris += [[a, b, c], [a, c, d]]
    return np.asarray(tris)


def _fin_faces() -> dict[str, np.ndarray]:
    """One fin in the x-z plane (radial = +x), its thickness along y.

    Outline (r, z): the tab from the motor tube to the tube wall over the root, then
    the exposed trapezoid. Convex, so a fan triangulates it.
    """
    outline = [(MOTOR_R, 0.0), (MOTOR_R, ROOT), (R, ROOT), (R + SPAN, ROOT - SWEEP),
               (R + SPAN, ROOT - SWEEP - TIP), (R, 0.0)]
    h = THICK / 2
    side = lambda y: [np.array([r, y, z]) for r, z in outline]
    a, b = side(+h), side(-h)
    faces = {
        "F_side_a": np.asarray([[a[0], a[i], a[i + 1]] for i in range(1, len(a) - 1)]),
        "F_side_b": np.asarray([[b[0], b[i + 1], b[i]] for i in range(1, len(b) - 1)]),
    }
    names = ["F_root_in", "F_tab_top", "F_le", "F_tip", "F_te", "F_te_tab"]
    for k, name in enumerate(names):
        i, j = k, (k + 1) % len(outline)
        faces[name] = np.asarray([[a[i], b[i], b[j]], [a[i], b[j], a[j]]])
    return faces


def _rot(axis: np.ndarray, deg: float) -> np.ndarray:
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    t = np.radians(deg)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * K @ K


def _matrix(rot: np.ndarray, shift) -> list[float]:
    m = np.eye(4)
    m[:3, :3] = rot
    m[:3, 3] = shift
    return m.flatten().tolist()


def write_rocket(model_dir: Path, n_fins: int = 3, typed: bool = True,
                 pose: tuple[np.ndarray, np.ndarray] | None = None, fins: bool = True) -> dict:
    """Write geometry.npz/json + manifest.json for the rocket; return its dimensions."""
    pose_rot, pose_shift = (np.eye(3), np.zeros(3)) if pose is None else pose
    zt = np.linspace(0, TUBE, 13)
    rho_ogive = (R * R + NOSE * NOSE) / (2 * R)
    zn = np.linspace(0, NOSE, 40)
    rn = np.sqrt(np.maximum(rho_ogive ** 2 - (NOSE - zn) ** 2, 0.0)) + R - rho_ogive
    rn[-1] = 0.0

    nan3 = [np.nan] * 3
    cyl = lambda r: ("CYLINDER", [0, 0, 0], [0, 0, 1], r) if typed else ("OTHER", nan3, nan3, np.nan)
    spun = ("SPUN", [0, 0, 0], [0, 0, 1], np.nan) if typed else ("OTHER", nan3, nan3, np.nan)
    plane = ("PLANE", nan3, nan3, np.nan) if typed else ("OTHER", nan3, nan3, np.nan)

    # part -> [(face id, triangles, (type, origin, axis, radius))]
    parts: dict[str, list] = {
        "tube": [("F_out", _revolve(zt, np.full_like(zt, R)), cyl(R)),
                 ("F_in", _revolve(zt, np.full_like(zt, R - WALL))[:, ::-1], cyl(R - WALL))],
        "nose": [("F_ogive", _revolve(TUBE + zn, rn), spun)],
        "motor": [("F_mt", _revolve(np.linspace(0, MOTOR_LEN, 5), np.full(5, MOTOR_R)), cyl(MOTOR_R))],
        "ring": [("F_ring", _annulus(MOTOR_LEN * 0.8, MOTOR_R, R - WALL), plane)],
    }
    if fins:
        parts["fin"] = [(fid, t, plane) for fid, t in _fin_faces().items()]

    arrays, meshes, occurrences, manifest = {}, [], [], []
    masses = {"tube": 0.9, "nose": 0.35, "motor": 0.15, "ring": 0.05, "fin": 0.06}
    for j, (part, faces) in enumerate(parts.items()):
        tris = np.concatenate([t for _, t, _ in faces])
        verts = tris.reshape(-1, 3)
        arrays[f"v{j}"] = verts
        arrays[f"i{j}"] = np.arange(len(verts)).reshape(-1, 3)
        arrays[f"f{j}"] = np.concatenate([np.full(len(t), k, dtype=np.int32) for k, (_, t, _) in enumerate(faces)])
        arrays[f"o{j}"] = np.array([f[2][1] for f in faces], float)
        arrays[f"x{j}"] = np.array([f[2][2] for f in faces], float)
        arrays[f"r{j}"] = np.array([f[2][3] for f in faces], float)
        meshes.append({"faceIds": [f[0] for f in faces], "faceTypes": [f[2][0] for f in faces]})
        copies = range(n_fins) if part == "fin" else [None]
        for k in copies:
            local = _rot([0, 0, 1], 360.0 * k / n_fins) if k is not None else np.eye(3)
            key = f"occ:{part}{'' if k is None else k}"
            occurrences.append({"key": key, "partId": part, "mesh": j,
                                "transform": _matrix(pose_rot @ local, pose_shift)})
            centroid = (pose_rot @ (local @ verts.mean(axis=0))) + pose_shift
            manifest.append({"key": key, "name": key, "mass": masses[part],
                             "centroidWorld": centroid.tolist(), "hasGeometry": True})

    model_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(model_dir / "geometry.npz", **arrays)
    (model_dir / "geometry.json").write_text(json.dumps(
        {"version": 2, "meshes": meshes, "occurrences": occurrences}))
    (model_dir / "manifest.json").write_text(json.dumps({"schemaVersion": 2, "parts": manifest}))
    return {"length": TUBE + NOSE, "radius": R, "n_fins": n_fins if fins else 0}
