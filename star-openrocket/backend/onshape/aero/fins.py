"""Extract a fin set's planform from CAD faces, for the Barrowman fin model.

OpenRocket's fin CP depends only on the flat planform (root/tip chord, span,
sweep), never on thickness, chamfers or fillets. So we project the selected fin
faces onto the axial-radial plane and read off the outline. Two robustness points,
both from the geometry we can trust rather than the messy edges:

  * **Tip** is the furthest point from the axis -- unambiguous.
  * **Root** is the *known* body radius, not the filleted CAD root. A root fillet
    (a separate blend surface) flares the chord right at the tube, so instead of
    trusting vertices there we fit the leading/trailing edges over the clean part
    of the fin and extrapolate them down to the tube surface. Edge chamfers only
    nibble the outline and are ignored, exactly as OpenRocket ignores them.

The result is per-strip leading/trailing edge positions spanning root->tip, ready
for ``barrowman_fins.fin_set_aero``. Fin count comes from the azimuthal symmetry
of the selected faces (or an explicit override).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..geometry_store import FaceGeometry
from .axis import Axis
from .barrowman_fins import DIVISIONS, FinSetAero, fin_set_aero


@dataclass(frozen=True)
class FinPlanform:
    chord_lead: np.ndarray  # (DIVISIONS,) axial pos of leading edge, root->tip
    chord_trail: np.ndarray
    span: float
    body_radius: float
    n_fins: int
    # OpenRocket-style trapezoid parameters read off the extracted outline, so
    # the fin is described the way ORK describes one, not as an opaque area.
    root_chord: float
    tip_chord: float
    sweep: float  # leading-edge advance from root to tip
    area: float  # single-fin planform area
    azimuths: list[float]  # degrees, one per detected fin, for placement

    @property
    def tip_radius(self) -> float:
        return self.body_radius + self.span


def _face_area(fg: FaceGeometry) -> float:
    t = fg.triangles
    return float(0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum())


def is_fin_face(fg: FaceGeometry, axis: Axis, min_azimuthal: float = 0.5) -> bool:
    """True if a face is a fin *surface*, not a protruding edge.

    A fin lies in a plane that passes through the body axis, so its flat side has an
    **azimuthal** normal -- perpendicular to both the axis and the radial direction.
    A fin's edges protrude just as far but fail this: the tip edge's normal is radial,
    the leading/trailing edges' normals are axial. Area-weighted normal (summed
    triangle cross products) so a warped or airfoil face still reads its mean facing.
    """
    t = fg.triangles
    if len(t) == 0:
        return False
    n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]).sum(axis=0)
    nn = float(np.linalg.norm(n))
    if nn < 1e-12:
        return False
    n = n / nn
    d = axis.direction
    c = t.reshape(-1, 3).mean(axis=0) - axis.origin
    radial = c - (c @ d) * d
    rr = float(np.linalg.norm(radial))
    if rr < 1e-9:
        return True  # face centred on the axis -- radial undefined, do not reject
    azimuthal = np.cross(d, radial / rr)
    return abs(float(n @ azimuthal)) >= min_azimuthal


def detect_fin_faces(
    faces: list[FaceGeometry],
    axis: Axis,
    body_r_max: float,
    protrusion: float = 1.08,
    min_area_fraction: float = 0.05,
) -> list[tuple[str, str]]:
    """Auto-detect fin faces: surfaces that protrude beyond the airframe radius.

    A fin sticks out past the body, so its vertices reach a radius well above the
    outer-skin envelope; the body skin and internal parts do not. Small lone
    protrusions (launch lugs, rail buttons) are dropped by an area floor relative
    to the biggest protruding face. Fin count is left to the azimuthal clustering
    in ``count_fins`` -- this just gathers the candidate faces.
    """
    cands: list[FaceGeometry] = []
    for fg in faces:
        _, rho = axis.axial_radial(fg.triangles.reshape(-1, 3))
        # Protrudes past the airframe *and* is a fin surface (not a protruding edge,
        # whose plane does not pass through the axis).
        if float(rho.max()) > body_r_max * protrusion and is_fin_face(fg, axis):
            cands.append(fg)
    if not cands:
        return []
    areas = [_face_area(fg) for fg in cands]
    a_max = max(areas)
    return [
        (fg.occurrence_key, fg.face_id)
        for fg, a in zip(cands, areas)
        if a >= min_area_fraction * a_max
    ]


def fins_symmetric(azimuths: list[float], threshold: float = 0.12) -> bool:
    """Whether the fin set is azimuthally symmetric, so it has no net side force.

    Uses the resultant of the fins' unit azimuth vectors, normalised by fin count:
    ~0 for an evenly spaced set (and for two opposed fins), large for a missing or
    uneven fin (e.g. 0.5 for a 3-fin set with one removed). A lone fin is inherently
    one-sided; no fins is trivially symmetric. When asymmetric the true CP sits off
    the axis and the axial model here under-states the instability -- hence a warning.
    """
    n = len(azimuths)
    if n == 0:
        return True
    if n == 1:
        return False
    rad = np.radians(np.asarray(azimuths, dtype=float))
    resultant = float(np.hypot(np.cos(rad).sum(), np.sin(rad).sum())) / n
    return resultant < threshold


def _perp_basis(direction: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    seed = np.array([1.0, 0.0, 0.0]) if abs(direction[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(direction, seed)
    u /= np.linalg.norm(u)
    v = np.cross(direction, u)
    return u, v


def count_fins(faces: list[FaceGeometry], axis: Axis, gap_deg: float = 25.0) -> int:
    """Number of fins = distinct azimuthal clusters of the selected faces."""
    u, v = _perp_basis(axis.direction)
    angles = []
    for fg in faces:
        c = fg.triangles.reshape(-1, 3).mean(axis=0) - axis.origin
        angles.append(np.degrees(np.arctan2(c @ v, c @ u)) % 360.0)
    if not angles:
        return 0
    angles = np.sort(np.array(angles))
    # Count gaps larger than gap_deg around the circle (wrap included).
    diffs = np.diff(np.concatenate([angles, [angles[0] + 360.0]]))
    return int((diffs > gap_deg).sum()) or 1


def _edges_over_strips(
    s: np.ndarray, rho: np.ndarray, body_radius: float, span: float
) -> tuple[np.ndarray, np.ndarray]:
    """Leading/trailing axial edge at each root->tip strip, root extrapolated."""
    # Bin the actual fin vertices by radius; per bin the outline is [min s, max s].
    dmin, dmax = float(rho.min()), float(rho.max())
    nb = max(8, DIVISIONS)
    edges = np.linspace(dmin, dmax, nb + 1)
    idx = np.clip(np.digitize(rho, edges) - 1, 0, nb - 1)
    lead_bin = np.full(nb, np.inf)
    trail_bin = np.full(nb, -np.inf)
    np.minimum.at(lead_bin, idx, s)
    np.maximum.at(trail_bin, idx, s)
    centres = 0.5 * (edges[:-1] + edges[1:])
    ok = np.isfinite(lead_bin) & np.isfinite(trail_bin)
    cs, lead_v, trail_v = centres[ok], lead_bin[ok], trail_bin[ok]

    rho_out = body_radius + np.linspace(0.0, span, DIVISIONS)

    def resample(vals: np.ndarray) -> np.ndarray:
        out = np.interp(rho_out, cs, vals)  # np.interp clamps outside [cs0, csN]
        # Linear-extrapolate the root gap (rho below the cleanest data) using the
        # slope of the lowest two valid bins, so a fillet does not set the root.
        if len(cs) >= 2:
            slope = (vals[1] - vals[0]) / (cs[1] - cs[0])
            below = rho_out < cs[0]
            out[below] = vals[0] + slope * (rho_out[below] - cs[0])
        return out

    return resample(lead_v), resample(trail_v)


def extract_fin_planform(
    faces: list[FaceGeometry],
    axis: Axis,
    body_radius: float,
    n_fins: int | None = None,
) -> FinPlanform:
    """Build one representative fin's planform from the selected fin faces."""
    if not faces:
        raise ValueError("no fin faces selected")

    count = n_fins if n_fins else count_fins(faces, axis)

    # Use a single fin's faces (the azimuthal cluster with the most area) so the
    # planform is one fin, not N overlaid. Group by mean azimuth.
    u, v = _perp_basis(axis.direction)

    def azimuth(fg: FaceGeometry) -> float:
        c = fg.triangles.reshape(-1, 3).mean(axis=0) - axis.origin
        return float(np.degrees(np.arctan2(c @ v, c @ u)) % 360.0)

    # Cluster faces whose azimuth is within a fin's width; keep the largest group.
    faces_sorted = sorted(faces, key=azimuth)
    groups: list[list[FaceGeometry]] = []
    for fg in faces_sorted:
        if groups and azimuth(fg) - azimuth(groups[-1][-1]) < 25.0:
            groups[-1].append(fg)
        else:
            groups.append([fg])

    def group_area(g: list[FaceGeometry]) -> float:
        tot = 0.0
        for fg in g:
            t = fg.triangles
            tot += float(0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum())
        return tot

    azimuths = [float(np.mean([azimuth(fg) for fg in g])) for g in groups]

    fin = max(groups, key=group_area)
    verts = np.concatenate([fg.triangles.reshape(-1, 3) for fg in fin])
    s, rho = axis.axial_radial(verts)

    # Clip to the EXPOSED fin: a through-the-wall mounting tab sits inside the tube
    # (radius < body radius) and is not aerodynamic surface. OpenRocket's fin
    # starts at the body surface, so drop everything at or below it before reading
    # the planform, otherwise the tab (often a different chord) skews the root.
    exposed = rho >= body_radius * 0.999
    if exposed.sum() < 3:
        raise ValueError("no fin surface outside the body radius; check the axis/selection")
    s, rho = s[exposed], rho[exposed]

    span = float(rho.max()) - body_radius
    if span <= 0:
        raise ValueError("fin tip is not outside the body radius; check the axis/selection")

    lead, trail = _edges_over_strips(s, rho, body_radius, span)

    # OpenRocket trapezoid parameters read off the outline (root extrapolated to
    # the tube surface, tip at the furthest station).
    root_chord = float(trail[0] - lead[0])
    tip_chord = float(trail[-1] - lead[-1])
    sweep = float(lead[-1] - lead[0])
    dy = span / (DIVISIONS - 1)
    chord = trail - lead
    area = float(np.trapezoid(chord, dx=dy)) if hasattr(np, "trapezoid") else float(np.trapz(chord, dx=dy))

    return FinPlanform(
        chord_lead=lead,
        chord_trail=trail,
        span=span,
        body_radius=body_radius,
        n_fins=count,
        root_chord=root_chord,
        tip_chord=tip_chord,
        sweep=sweep,
        area=area,
        azimuths=azimuths,
    )


def planform_outline_3d(pf: FinPlanform, axis: Axis, azimuth_deg: float) -> dict[str, list]:
    """The exposed fin planform as 3D points (Onshape frame) at one azimuth.

    Returns leading- and trailing-edge point lists (root->tip), so the viewer can
    render the exact aerodynamic surface the calc uses -- rooted at the body
    surface, tip outward -- instead of highlighting the CAD face (which includes
    the internal mounting tab).
    """
    u, v = _perp_basis(axis.direction)
    a = np.radians(azimuth_deg)
    uhat = np.cos(a) * u + np.sin(a) * v
    y = np.linspace(0.0, pf.span, DIVISIONS)
    rho = pf.body_radius + y
    lead_pts = [
        (axis.origin + pf.chord_lead[i] * axis.direction + rho[i] * uhat).tolist()
        for i in range(DIVISIONS)
    ]
    trail_pts = [
        (axis.origin + pf.chord_trail[i] * axis.direction + rho[i] * uhat).tolist()
        for i in range(DIVISIONS)
    ]
    return {"lead": lead_pts, "trail": trail_pts}


def fin_set_aero_from_faces(
    faces: list[FaceGeometry],
    axis: Axis,
    body_radius: float,
    r_ref: float,
    n_fins: int | None = None,
    mach: float = 0.3,
) -> tuple[FinSetAero, FinPlanform]:
    """Extract the planform and compute the fin-set Barrowman CNa/cp."""
    pf = extract_fin_planform(faces, axis, body_radius, n_fins)
    aero = fin_set_aero(pf.chord_lead, pf.chord_trail, pf.span, pf.body_radius, pf.n_fins, r_ref, mach)
    return aero, pf
