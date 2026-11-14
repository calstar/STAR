"""Geometry for imported .ork components, in the shape an Onshape build produces.

Each component becomes one :class:`PartMesh` (closed, outward-wound, triangles
grouped by face) plus a ``FaceSurface`` per face carrying the B-rep type the CAD
analysis reads: a tube's skin is a CYLINDER on the rocket axis, a nose cone or
transition SPUN (CONE when conical), every flat face a PLANE. The outer-surface
detector, the fin detector and the Barrowman code then treat an imported rocket
exactly as they treat a CAD one.

Frame: Onshape's Z-up assembly frame, rocket axis on Z, nose tip at the origin and
the tail toward -Z, so axial position x maps to z = -x.
"""

from __future__ import annotations

import math

import numpy as np

from ..onshape.bodydetails import FaceSurface
from ..onshape.tessellate import PartMesh
from .document import Component, FinPlates, Revolution

#: Segments around the axis.
AROUND = 64

_AXIS_ORIGIN = [0.0, 0.0, 0.0]
_AXIS_DIR = [0.0, 0.0, 1.0]


def _point(x: np.ndarray, r: np.ndarray, theta: np.ndarray) -> np.ndarray:
    x, r, theta = np.broadcast_arrays(x, r, theta)
    return np.stack([r * np.cos(theta), r * np.sin(theta), -x], axis=-1)


def _band(x0, r0, x1, r1, inward: bool) -> np.ndarray:
    """Triangles of the surface swept between rings (x0, r0) and (x1, r1).

    Arrays broadcast over stations. Outward-facing unless ``inward``.
    """
    t = np.linspace(0.0, 2 * math.pi, AROUND + 1)
    t0, t1 = t[:-1], t[1:]
    a = _point(x0[:, None], r0[:, None], t0[None, :])
    b = _point(x1[:, None], r1[:, None], t0[None, :])
    c = _point(x1[:, None], r1[:, None], t1[None, :])
    d = _point(x0[:, None], r0[:, None], t1[None, :])
    tris = np.concatenate([np.stack([a, b, c], -2), np.stack([a, c, d], -2)], axis=1).reshape(-1, 3, 3)
    if inward:
        tris = tris[:, [0, 2, 1]]
    return tris


def _annulus(x: float, r_in: float, r_out: float, facing_fore: bool) -> np.ndarray:
    """A flat ring at station x. Faces fore (+Z) or aft (-Z)."""
    xs = np.array([x])
    # An annulus is the band from r_in to r_out at one station: its normal is the
    # band's (axial) direction, so the winding of an outward band from r_in to r_out
    # at constant x faces aft; flip it to face fore.
    tris = _band(xs, np.array([r_out]), xs, np.array([r_in]), inward=False)
    return tris if not facing_fore else tris[:, [0, 2, 1]]


def _drop_degenerate(tris: np.ndarray) -> np.ndarray:
    area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1)
    return tris[area > 1e-14]


def _revolution_faces(rev: Revolution, prefix: str) -> list[tuple[str, np.ndarray, FaceSurface]]:
    x, ro, ri = rev.x, rev.r_out, rev.r_in
    faces = []
    outer_type = rev.surface
    radius = float(ro[0]) if outer_type == "CYLINDER" else None
    faces.append(
        (f"{prefix}outer", _band(x[:-1], ro[:-1], x[1:], ro[1:], inward=False),
         FaceSurface(f"{prefix}outer", outer_type, _AXIS_ORIGIN, _AXIS_DIR, radius))
    )
    if np.any(ri > 1e-12):
        inner_type = "CYLINDER" if outer_type == "CYLINDER" else "SPUN"
        faces.append(
            (f"{prefix}inner", _band(x[:-1], ri[:-1], x[1:], ri[1:], inward=True),
             FaceSurface(f"{prefix}inner", inner_type, _AXIS_ORIGIN, _AXIS_DIR,
                         float(ri[0]) if inner_type == "CYLINDER" else None))
        )
    if ro[0] - ri[0] > 1e-12:
        faces.append((f"{prefix}fore", _annulus(float(x[0]), float(ri[0]), float(ro[0]), True),
                      FaceSurface(f"{prefix}fore", "PLANE", None, None, None)))
    if ro[-1] - ri[-1] > 1e-12:
        faces.append((f"{prefix}aft", _annulus(float(x[-1]), float(ri[-1]), float(ro[-1]), False),
                      FaceSurface(f"{prefix}aft", "PLANE", None, None, None)))
    return faces


def _triangulate(points: np.ndarray) -> list[tuple[int, int, int]]:
    """Ear-clipping triangulation of a simple polygon (a freeform fin may be concave)."""
    pts = [tuple(p) for p in points]
    idx = list(range(len(pts)))
    x, y = points[:, 0], points[:, 1]
    if (x * np.roll(y, -1) - np.roll(x, -1) * y).sum() < 0:
        idx.reverse()  # make it counter-clockwise

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def inside(p, a, b, c):
        return cross(a, b, p) >= 0 and cross(b, c, p) >= 0 and cross(c, a, p) >= 0

    out: list[tuple[int, int, int]] = []
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if cross(a, b, c) <= 1e-18:
                continue
            if any(inside(pts[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            out.append((i0, i1, i2))
            idx.pop(k)
            break
        else:
            break  # degenerate remainder; drop it
    if len(idx) == 3:
        out.append(tuple(idx))
    return out


def _fin_faces(fins: FinPlates, prefix: str) -> list[tuple[str, np.ndarray, FaceSurface]]:
    pts = np.asarray(fins.points, dtype=np.float64)
    # One winding for the outline, so the side faces and the edge strip agree.
    x, y = pts[:, 0], pts[:, 1]
    if (x * np.roll(y, -1) - np.roll(x, -1) * y).sum() < 0:
        pts = pts[::-1].copy()
    tri_idx = _triangulate(pts)
    half = fins.thickness / 2
    faces = []
    for k in range(fins.count):
        phi = math.radians(fins.first_angle_deg) + 2 * math.pi * k / fins.count
        e_r = np.array([math.cos(phi), math.sin(phi), 0.0])
        e_t = np.array([-math.sin(phi), math.cos(phi), 0.0])

        def world(u, v, w):
            return (fins.root_radius + v) * e_r + w * e_t + np.array([0.0, 0.0, -(fins.x_lead + u)])

        top = np.array([world(u, v, half) for u, v in pts])
        bot = np.array([world(u, v, -half) for u, v in pts])
        side_p = np.array([[top[a], top[b], top[c]] for a, b, c in tri_idx])
        side_m = np.array([[bot[a], bot[c], bot[b]] for a, b, c in tri_idx])
        n = len(pts)
        edges = []
        for i in range(n):
            j = (i + 1) % n
            edges.append([top[i], bot[i], bot[j]])
            edges.append([top[i], bot[j], top[j]])
        for name, tris in ((f"fin{k}-a", side_p), (f"fin{k}-b", side_m), (f"fin{k}-edge", np.array(edges))):
            faces.append((f"{prefix}{name}", tris, FaceSurface(f"{prefix}{name}", "PLANE", None, None, None)))
    return faces


def _oriented(faces: list[tuple[str, np.ndarray, FaceSurface]]) -> list[tuple[str, np.ndarray, FaceSurface]]:
    """Wind one closed shape outward: flip all of it if its signed volume is negative."""
    tris = np.concatenate([t for _, t, _ in faces]) if faces else np.zeros((0, 3, 3))
    if not len(tris):
        return faces
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    if np.einsum("ij,ij->i", a, np.cross(b, c)).sum() < 0:
        return [(fid, t[:, [0, 2, 1]], s) for fid, t, s in faces]
    return faces


def _internal(faces: list[tuple[str, np.ndarray, FaceSurface]]) -> list[tuple[str, np.ndarray, FaceSurface]]:
    """Mark a component inside the airframe as not airframe.

    OpenRocket's aerodynamics see only the airframe and the fins; a mass component,
    coupler or retainer drawn at the full body radius (LE4 SD's motor retainer pokes
    through the boattail) would otherwise be offered to the outer-skin detector as a
    coaxial cylinder and reshape the body the Barrowman code sees."""
    return [(fid, t, FaceSurface(s.face_id, "INTERNAL", None, None, None)) for fid, t, s in faces]


def component_mesh(comp: Component) -> tuple[PartMesh, dict[str, FaceSurface]] | None:
    """One closed mesh for the component, or None when it has nothing to draw."""
    faces: list[tuple[str, np.ndarray, FaceSurface]] = []
    for n, shape in enumerate(comp.shapes):
        prefix = "" if n == 0 else f"s{n}-"
        if isinstance(shape, Revolution):
            # Shoulders (n > 0) sit inside the neighbouring tube: not airframe either.
            revolution = _oriented(_revolution_faces(shape, prefix))
            faces.extend(revolution if comp.depth == 0 and n == 0 else _internal(revolution))
        elif isinstance(shape, FinPlates):
            plate = _fin_faces(shape, prefix)
            # Each fin is its own closed plate; orient them one at a time.
            for k in range(shape.count):
                faces.extend(_oriented([f for f in plate if f[0].startswith(f"{prefix}fin{k}-")]))
    faces = [(fid, _drop_degenerate(t), s) for fid, t, s in faces]
    faces = [f for f in faces if len(f[1])]
    if not faces:
        return None

    tris = np.concatenate([t for _, t, _ in faces])
    vertices = tris.reshape(-1, 3)
    indices = np.arange(len(vertices), dtype=np.uint32).reshape(-1, 3)

    mesh = PartMesh(
        part_id="ork",
        vertices=vertices,
        indices=indices,
        facet_count=len(indices),
        face_ids=[fid for fid, _, _ in faces],
        face_tri_counts=[len(t) for _, t, _ in faces],
    )
    return mesh, {fid: s for fid, _, s in faces}
