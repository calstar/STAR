"""Auto-detect the outer airframe from B-rep surface types.

The airframe is the set of **coaxial surfaces of revolution**: the body tubes
(CYLINDER), the nose cone and boattail (CONE / SPUN), rounded tips (SPHERE), all
sharing one axis. Fins, lugs and bulkheads are PLANE/SWEEP or sit on a different
axis, so they fall out for free -- no radial-envelope guessing, no fin tips
inflating r_max (the bug that gave BART a 285 mm reference diameter).

The centreline itself is read off the cylinders: a rocket's tubes are all coaxial,
so their surface axes agree, and the dominant axis cluster *is* the centreline.
Bolt holes are cylinders too, but their axes point radially and cluster apart.

Then, among the coaxial surfaces of revolution, the airframe is the outermost:
concentric inner tubes (motor mount, couplers) share the axis but sit below the
outer radial envelope and are dropped.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..geometry_store import FaceGeometry, GeometryStore
from .axis import Axis, detect_axis

#: Axes within this of parallel (|cos|) count as the same direction.
PARALLEL_COS = 0.98

#: A coaxial surface's axis line may sit at most this fraction of the body
#: radius off the centreline before it is treated as a separate axis.
AXIS_OFFSET_FRACTION = 0.25


@dataclass(frozen=True)
class OuterSurfaceGuess:
    faces: list[tuple[str, str]]  # (occurrence_key, face_id)
    axis: Axis


def _tri_area(tris: np.ndarray) -> float:
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    return float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())


def _line_distance(point: np.ndarray, origin: np.ndarray, direction: np.ndarray) -> float:
    """Perpendicular distance from ``point`` to the line (origin, direction)."""
    rel = point - origin
    return float(np.linalg.norm(rel - (rel @ direction) * direction))


def detect_axis_from_cylinders(faces: list[FaceGeometry]) -> Axis | None:
    """Centreline from the dominant cluster of coaxial cylinder axes.

    Returns None when there are no cylinders to fit, so the caller can fall back
    to a mesh-based axis.
    """
    cyls = [fg for fg in faces if fg.surface_type == "CYLINDER" and fg.axis_dir is not None]
    if not cyls:
        return None

    dirs = np.array([fg.axis_dir for fg in cyls])
    origins = np.array([fg.axis_origin for fg in cyls])
    areas = np.array([_tri_area(fg.triangles) for fg in cyls])

    # Sign-align every axis to a common hemisphere so opposite-pointing but
    # collinear axes cluster together, using the highest-area axis as reference.
    ref = dirs[int(np.argmax(areas))]
    signs = np.sign(dirs @ ref)
    signs[signs == 0] = 1
    aligned = dirs * signs[:, None]

    # Greedy dominant cluster: everything parallel to the reference.
    parallel = np.abs(aligned @ ref) >= PARALLEL_COS
    weight = areas[parallel]
    direction = np.average(aligned[parallel], axis=0, weights=weight)
    direction /= np.linalg.norm(direction)
    origin = np.average(origins[parallel], axis=0, weights=weight)
    return Axis(origin=origin, direction=direction)


#: A face is flat when its area-weighted normal keeps this much of the summed triangle
#: normals' length: 1 for a plane, well under it for anything curved.
FLAT_COS = 0.995


def _flatness(fg: FaceGeometry) -> tuple[np.ndarray | None, float]:
    """Unit normal and flatness (|sum n_i| / sum |n_i|, area-weighted) of a face."""
    t = fg.triangles
    if len(t) == 0:
        return None, 0.0
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    total = float(np.linalg.norm(n, axis=1).sum())
    s = n.sum(axis=0)
    ns = float(np.linalg.norm(s))
    if total < 1e-15 or ns < 1e-15:
        return None, 0.0
    return s / ns, ns / total


#: Without typed surfaces, a skin candidate must wrap at least this much of the axis.
#: A tube segment or nose panel does; a fin's side or edge (a few degrees) does not.
MIN_SKIN_SPAN_DEG = 20.0


def _azimuth_span_deg(fg: FaceGeometry, axis: Axis) -> float:
    """How much of the circle round the axis a face covers, in degrees (360 for a ring)."""
    v = fg.triangles.reshape(-1, 3) - axis.origin
    v = v - np.outer(v @ axis.direction, axis.direction)
    r = np.linalg.norm(v, axis=1)
    v = v[r > 1e-9]
    if len(v) < 2:
        return 0.0
    e1 = np.cross(axis.direction, [1.0, 0.0, 0.0])
    if np.linalg.norm(e1) < 1e-6:
        e1 = np.cross(axis.direction, [0.0, 1.0, 0.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(axis.direction, e1)
    ang = np.sort(np.degrees(np.arctan2(v @ e2, v @ e1)) % 360.0)
    gaps = np.diff(np.concatenate([ang, ang[:1] + 360.0]))
    return float(360.0 - gaps.max())


def _flat_fin_like(fg: FaceGeometry, axis: Axis) -> bool:
    """A flat face whose plane contains the axis: what a fin's side looks like."""
    from .fins import is_fin_face

    _, flat = _flatness(fg)
    return flat >= FLAT_COS and is_fin_face(fg, axis)


def axis_from_fin_planes(faces: list[FaceGeometry], rough: Axis) -> Axis | None:
    """The centreline as the common line of the fins' planes, or None.

    A fin is flat and its plane contains the rocket's axis, so with fins at two or more
    azimuths the planes' intersection *is* the axis -- exact, where a vertex fit is not.
    Candidates are flat faces that look like fin sides against ``rough`` (normal mostly
    azimuthal), weighted by area. Both sides of a fin are parallel planes a thickness
    apart; least squares puts the line midway, as it should. Returns None when fewer
    than two plane orientations exist (one fin, or two opposed fins in one plane).
    """
    normals, points, weights = [], [], []
    for fg in faces:
        n, flat = _flatness(fg)
        if n is None or flat < FLAT_COS:
            continue
        from .fins import _face_area, is_fin_face

        if not is_fin_face(fg, rough, min_azimuthal=0.8):
            continue
        normals.append(n)
        points.append(fg.triangles.reshape(-1, 3).mean(axis=0))
        weights.append(_face_area(fg))
    if len(normals) < 2:
        return None
    N, P, W = np.array(normals), np.array(points), np.array(weights)
    W = W / W.max()
    # Two orientations at least: some pair of normals far from parallel.
    if float(np.min(np.abs(N @ N.T))) > 0.9:
        return None

    # Direction: the one most perpendicular to every plane normal.
    M = (N * W[:, None]).T @ N
    vals, vecs = np.linalg.eigh(M)
    d = vecs[:, 0]
    if vals[1] < 1e-3 * vals[2]:  # degenerate: normals do not span two directions
        return None
    if d @ rough.direction < 0:
        d = -d
    # Origin: least-squares point on all planes, pinned along d to the rough origin.
    A = M + np.outer(d, d)
    b = (N * (W * np.einsum("ij,ij->i", N, P))[:, None]).sum(axis=0) + d * (d @ rough.origin)
    origin = np.linalg.solve(A, b)
    # Sanity: the refined line must stay close to the rough one; a fit pulled onto
    # something that only resembles fins is worse than no refinement.
    if abs(float(d @ rough.direction)) < np.cos(np.radians(10)):
        return None
    return Axis(origin=origin, direction=d)


def _is_coaxial(fg: FaceGeometry, axis: Axis, tol: float) -> bool:
    """Is this surface of revolution coaxial with the centreline?"""
    if fg.axis_dir is not None:
        if abs(float(fg.axis_dir @ axis.direction)) < PARALLEL_COS:
            return False
        if fg.axis_origin is not None:
            return _line_distance(fg.axis_origin, axis.origin, axis.direction) <= tol
        return True
    # SPHERE (rounded tip): no axis, accept if its centre is near the line.
    if fg.axis_origin is not None:
        return _line_distance(fg.axis_origin, axis.origin, axis.direction) <= tol
    return False


def detect_outer_surface(
    store: GeometryStore,
    n_stations: int = 200,
) -> OuterSurfaceGuess:
    faces = store.iter_faces()
    if not faces:
        raise ValueError("no geometry to analyse")

    axis = detect_axis_from_cylinders(faces)
    if axis is None:
        all_verts = np.concatenate([fg.triangles.reshape(-1, 3) for fg in faces])
        axis = detect_axis(all_verts)
        # No cylinder to read the centreline off: a vertex fit is pulled about by
        # whatever is asymmetric inside. Every fin's plane contains the true axis,
        # so where there are fins, their planes pin it down exactly.
        axis = axis_from_fin_planes(faces, axis) or axis

    # Coaxial surfaces of revolution = airframe candidates. A radius tolerance for
    # the axis-offset test scaled to the largest coaxial cylinder radius.
    cyl_radii = [
        fg.radius
        for fg in faces
        if fg.surface_type == "CYLINDER" and fg.radius and _is_coaxial(fg, axis, np.inf)
    ]
    body_radius = max(cyl_radii) if cyl_radii else 0.05
    tol = AXIS_OFFSET_FRACTION * body_radius

    candidates = [fg for fg in faces if fg.is_sor and _is_coaxial(fg, axis, tol)]
    if not candidates:
        # Non-standard model (no typed surfaces of revolution): let the user correct
        # everything -- but never offer a fin as airframe skin. At the fin stations a
        # fin face is the outermost surface, so it would win the skin, set r_max to a
        # fin tip, and leave no fin able to protrude past the "body" -- every fin lost.
        # Nor a fin's edges: its tip edge faces outward like skin, but it is a strip one
        # fin-thickness wide, where any airframe surface wraps a real angle round the axis.
        candidates = [
            fg for fg in faces
            if not _flat_fin_like(fg, axis) and _azimuth_span_deg(fg, axis) >= MIN_SKIN_SPAN_DEG
        ] or faces

    chosen = _outer_skin(candidates, axis, n_stations)
    return OuterSurfaceGuess(faces=chosen, axis=axis)


def _outer_skin(
    candidates: list[FaceGeometry], axis: Axis, n_bins: int
) -> list[tuple[str, str]]:
    """Keep only faces that are the *outermost* surface at their axial stations.

    Proximity to the radial envelope is not enough: a centering ring's outer face
    is a coaxial cylinder at nearly the body radius, so it passes a radius test
    even though the body tube encloses it. Instead, bin the length and let each
    face compete: the body tube spans the ring's stations at a larger radius, so
    the tube "owns" them and the ring owns none. A face is skin only if it owns
    (is within eps of the max radius at) most of the stations it occupies -- which
    holds regardless of wall thickness.
    """
    verts = np.concatenate([fg.triangles.reshape(-1, 3) for fg in candidates])
    s_all, _ = axis.axial_radial(verts)
    s_min, s_max = float(s_all.min()), float(s_all.max())
    if s_max - s_min < 1e-9:
        return [(fg.occurrence_key, fg.face_id) for fg in candidates]
    edges = np.linspace(s_min, s_max, n_bins + 1)

    def face_coverage(fg: FaceGeometry) -> np.ndarray:
        """Per-bin radius across the face's whole axial extent.

        A tessellated cylinder/cone has vertices only at its two end rings, so a
        raw per-bin max would leave its interior empty and misjudge who is
        outermost there. Interpolating between the first and last occupied bin
        fills the extent at the surface's true radius (constant for a cylinder,
        linear for a cone), so an enclosing tube correctly dominates an inner one
        along its full length.
        """
        s, rho = axis.axial_radial(fg.triangles.reshape(-1, 3))
        idx = np.clip(np.digitize(s, edges) - 1, 0, n_bins - 1)
        bm = np.full(n_bins, -np.inf)
        np.maximum.at(bm, idx, rho)
        occ = np.flatnonzero(np.isfinite(bm))
        if len(occ) == 0:
            return bm
        span = np.arange(occ[0], occ[-1] + 1)
        out = np.full(n_bins, -np.inf)
        out[span] = np.interp(span, occ, bm[occ])
        return out

    face_bm = [face_coverage(fg) for fg in candidates]
    global_bm = np.maximum.reduce(face_bm)
    r_max = float(global_bm[np.isfinite(global_bm)].max())
    # Tolerance below the outermost radius that still counts as "on the skin".
    # Smaller than any real wall thickness so inner surfaces lose to the shell.
    eps = max(3e-4, 5e-3 * r_max)

    chosen: list[tuple[str, str]] = []
    for fg, bm in zip(candidates, face_bm):
        occupied = np.isfinite(bm)
        n_occ = int(occupied.sum())
        if n_occ == 0:
            continue
        owned = int(((bm >= global_bm - eps) & occupied).sum())
        if owned / n_occ >= 0.5:
            chosen.append((fg.occurrence_key, fg.face_id))
    return chosen
