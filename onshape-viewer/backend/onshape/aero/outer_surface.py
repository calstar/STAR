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
        candidates = faces  # non-standard model: let the user correct everything

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
