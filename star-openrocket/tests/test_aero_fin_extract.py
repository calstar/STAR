"""Fin planform extraction from CAD-like fin meshes.

Builds three trapezoidal fins (Estes Alpha III geometry) around a +z axis, with a
radial GAP at the root so the flat fin faces start above the tube surface -- the
stand-in for a root fillet. The extractor must count 3 fins, take the tip as the
furthest point, extrapolate the root down to the known body radius, and reproduce
OpenRocket's fin CNa/cp.
"""

from __future__ import annotations

import numpy as np

from backend.onshape.aero.axis import Axis
from backend.onshape.aero.fins import (
    detect_fin_faces,
    extract_fin_planform,
    fin_set_aero_from_faces,
    is_fin_face,
)
from backend.onshape.geometry_store import FaceGeometry

ROOT, TIP, SWEEP, SPAN = 0.05, 0.03, 0.02, 0.05
BODY_R = 0.012
GAP = 0.008  # flat face starts this far above the tube (fillet region)


def make_fin(phi_deg: float) -> FaceGeometry:
    phi = np.radians(phi_deg)
    u = np.array([np.cos(phi), np.sin(phi), 0.0])  # radial direction
    z = np.array([0.0, 0.0, 1.0])  # axis
    ys = np.linspace(GAP, SPAN, 24)
    fracs = np.linspace(0.0, 1.0, 6)
    grid = np.empty((len(ys), len(fracs), 3))
    for iy, y in enumerate(ys):
        lead = SWEEP * y / SPAN
        trail = SWEEP + TIP  # straight trailing edge (=0.05)
        for jf, f in enumerate(fracs):
            s = lead + f * (trail - lead)
            grid[iy, jf] = s * z + (BODY_R + y) * u
    tris = []
    for iy in range(len(ys) - 1):
        for jf in range(len(fracs) - 1):
            a, b, c, d = grid[iy, jf], grid[iy, jf + 1], grid[iy + 1, jf], grid[iy + 1, jf + 1]
            tris.append([a, b, c])
            tris.append([b, d, c])
    return FaceGeometry(
        occurrence_key=f"occ:fin{phi_deg:.0f}",
        part_id="fin",
        face_id=f"F{phi_deg:.0f}",
        triangles=np.asarray(tris),
        surface_type="PLANE",
        axis_origin=None,
        axis_dir=None,
        radius=None,
    )


AXIS = Axis(origin=np.zeros(3), direction=np.array([0.0, 0.0, 1.0]))


def test_counts_three_fins_and_span():
    fins = [make_fin(a) for a in (0, 120, 240)]
    pf = extract_fin_planform(fins, AXIS, BODY_R)
    assert pf.n_fins == 3
    assert abs(pf.span - SPAN) < 1e-3
    # Root chord (extrapolated to the tube) recovered near the true 0.05.
    root_chord = pf.chord_trail[0] - pf.chord_lead[0]
    assert abs(root_chord - ROOT) < 2e-3, root_chord


def _quad_face(occ, corners) -> FaceGeometry:
    a, b, c, d = corners
    return FaceGeometry(
        occurrence_key=occ, part_id="p", face_id=occ,
        triangles=np.asarray([[a, b, c], [b, d, c]]),
        surface_type="PLANE", axis_origin=None, axis_dir=None, radius=None,
    )


def test_fin_flat_face_passes_edges_rejected():
    phi = 0.0
    u = np.array([np.cos(phi), np.sin(phi), 0.0])  # radial
    w = np.array([-np.sin(phi), np.cos(phi), 0.0])  # azimuthal
    z = np.array([0.0, 0.0, 1.0])  # axis
    R = BODY_R + SPAN

    # Flat fin side: lies in the (axis, radial) plane -> azimuthal normal -> a fin.
    assert is_fin_face(make_fin(phi), AXIS) is True
    # Tip edge: faces radially outward (normal = radial) -> not a fin.
    tip = _quad_face("tip", [0 * z + R * u - 1e-3 * w, 0.05 * z + R * u - 1e-3 * w,
                             0 * z + R * u + 1e-3 * w, 0.05 * z + R * u + 1e-3 * w])
    assert is_fin_face(tip, AXIS) is False
    # Leading edge: faces along the axis (normal = axis) -> not a fin.
    lead = _quad_face("lead", [0 * z + BODY_R * u - 1e-3 * w, 0 * z + R * u - 1e-3 * w,
                               0 * z + BODY_R * u + 1e-3 * w, 0 * z + R * u + 1e-3 * w])
    assert is_fin_face(lead, AXIS) is False


def test_detect_excludes_edge_faces():
    fins = [make_fin(a) for a in (0, 120, 240)]
    R = BODY_R + SPAN
    u = np.array([1.0, 0.0, 0.0])
    w = np.array([0.0, 1.0, 0.0])
    z = np.array([0.0, 0.0, 1.0])
    tip = _quad_face("tipedge", [R * u - 1e-3 * w, 0.05 * z + R * u - 1e-3 * w,
                                 R * u + 1e-3 * w, 0.05 * z + R * u + 1e-3 * w])
    detected = detect_fin_faces([*fins, tip], AXIS, BODY_R)
    keys = {k for k, _ in detected}
    assert "occ:fin0" in keys and "tipedge" not in keys  # the edge is not a fin face


def test_extracted_cna_matches_openrocket():
    fins = [make_fin(a) for a in (0, 120, 240)]
    aero, pf = fin_set_aero_from_faces(fins, AXIS, BODY_R, r_ref=BODY_R)
    assert pf.n_fins == 3
    # Reproduce OpenRocket's 3-fin Alpha III CNa (24.146933) within a few percent;
    # the root fillet gap + strip resampling cost a little accuracy.
    assert abs(aero.cna - 24.146933) < 24.146933 * 0.03, aero.cna
    assert abs(aero.cp - 0.0193484) < 1e-3, aero.cp
