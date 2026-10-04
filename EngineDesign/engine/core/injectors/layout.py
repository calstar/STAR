"""Impinging-injector layout: the one place the injector's geometry is derived.

Layer 1, ``scripts/design_audit.py``, the forward solver and the Geometry tab all read the same
derived quantities from here -- pitch circles, where the jets meet, where each drilled passage
runs and what it breaks into, how much metal is left. Callers do not re-derive them.

The hardware this describes
---------------------------
The injector is a plug that fills the chamber sleeve's bore. Its chamber-side face bears on the
phenolic liner's forward end; the gas sees the face only inside the liner bore.

* **Face.** ``flat``: every orifice leaves an axis-normal face at its jet angle, so the exit is an
  ellipse and the drill enters off square. ``contoured``: the face is turned with an annular
  groove whose two flanks are normal to the two jets (a cone per ring, since every jet lies in a
  radial plane), so each orifice leaves its flank square and round. That groove is a valley: the
  inner ring's jet points outward, so its flank faces outward, and the outer ring's the reverse.
Both default to the plug this stand machines (contoured, channels), also when ``injector.plate``
is not declared; Layer 1 applies their constraints only once the block is declared.

* **Back.** ``plenum``: the passages run straight through to a flat back face (a dome or plate
  manifold behind it). ``channels``: the back face is flat with one annular channel per ring;
  each passage runs from its exit straight to its channel's floor, and the channel is centred on
  where the passage axis meets that floor. That is what "the channels line up" means.

Seals, the manifold cover, the igniter hardware and how the plug is retained are the designer's,
not this module's. It reports the lands those parts would have to fit in; it does not size them.

Coordinates: axisymmetric, ``r`` radial, ``z`` axial with ``z = 0`` the face DATUM (the flat
lands, and the liner's forward end), the chamber toward ``+z`` and the back face at ``z = -t``.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping, NamedTuple, Optional, Tuple

from engine.core.injectors.hardware_tables import NPT

# =============================================================================================
# Standoff band
# =============================================================================================

#: Target for Layer 1's standoff L/d, the AXIAL height of the impingement point above the exits
#: over the mean orifice diameter. NOTE this is not SP-8089's impingement distance, which is
#: measured ALONG the jet (``free_jet_*`` below); the axial figure is what the optimizer has
#: always used, and the layout reports both.
IMPINGEMENT_LD_TARGET_DEFAULT = 4.0

#: Half-width of the standoff search window when the spacing is NOT derived and no explicit
#: band or tolerance is given. With the derivation on the window has zero width.
IMPINGEMENT_LD_TOL_UNDERIVED = 1.0


class LdBand(NamedTuple):
    target: float
    lo: float
    hi: float


def _opt_float(req: Mapping[str, Any], key: str) -> Optional[float]:
    v = req.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _opt_bool(req: Mapping[str, Any], key: str, default: bool) -> bool:
    v = req.get(key)
    if v is None:
        return default
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("false", "0", "no", "off", ""):
            return False
        if s in ("true", "1", "yes", "on"):
            return True
        return default
    return bool(v)


def impingement_ld_band(requirements: Optional[Mapping[str, Any]]) -> LdBand:
    """Resolve the standoff L/d band from design requirements.

    Precedence, highest first: explicit ``layer1_impingement_Ld_min`` / ``_max``; then
    ``layer1_impingement_Ld_target`` +/- ``layer1_impingement_Ld_tol``; the tolerance defaults
    to 0 when ``layer1_derive_impingement_spacing`` is on (the default) and to 1.0 when off.
    """
    req = requirements or {}
    target = _opt_float(req, "layer1_impingement_Ld_target")
    if target is None:
        target = IMPINGEMENT_LD_TARGET_DEFAULT
    derived = _opt_bool(req, "layer1_derive_impingement_spacing", True)
    tol = _opt_float(req, "layer1_impingement_Ld_tol")
    if tol is None:
        tol = 0.0 if derived else IMPINGEMENT_LD_TOL_UNDERIVED
    tol = max(0.0, tol)
    lo = _opt_float(req, "layer1_impingement_Ld_min")
    hi = _opt_float(req, "layer1_impingement_Ld_max")
    if lo is None:
        lo = max(0.0, target - tol)
    if hi is None:
        hi = target + tol
    return LdBand(float(target), float(lo), float(hi))


# =============================================================================================
# Limits with a source, and the one assumed default
# =============================================================================================

#: Floor on |cos(theta)| when sizing an inclined hole's trace, so a near-90 deg jet cannot
#: report an infinite footprint. Layer 1 uses the same floor.
_COS_FLOOR = 0.10

#: Twist-drill practice: past about 10 diameters a small drill wanders and the shop reaches for
#: a gundrill or EDM.
DRILL_LD_PRACTICE_MAX = 10.0

#: SP-8089 criterion 3.1.2.2 (p.85): "an orifice L/d of at least 4 should be used to guarantee
#: full flow" (the stream leaves concentric with the hole).
ORIFICE_LD_MIN = 4.0

#: Sandvik Coromant, irregular-surface drilling: a solid-carbide drill tolerates at most 10 deg
#: off square on entry; beyond that a flat is milled first. A flat face drilled at the jet angle
#: is theta off square.
DRILL_ENTRY_MAX_OFF_SQUARE_DEG = 10.0

#: SP-8089 p.26: included angles above 90 deg give high heat flux to the injector face.
FACE_HEATING_INCLUDED_DEG = 90.0

#: SP-8089 criterion 3.1.1.1.4 (p.80): impingement distance, measured ALONG the jet, "no greater
#: than 5 to 7 orifice diameters" -- an upper bound, not a band.
FREE_JET_MAX_D = 7.0

#: Share of the chamber cross-section inside the impingement circle below which the spray is
#: feeding a core rather than the chamber.
CORE_FRAC_WARN = 0.25

#: ASSUMED: the metal left between the edge of a round exit and the edge of its flank on a
#: contoured face (and between a passage and its channel wall). Override with
#: ``injector.plate.exit_land``.
EXIT_LAND_DEFAULT = 0.0005

#: ASSUMED plate thickness when ``design_requirements.layer1_injector_plate_thickness_m`` is not
#: set (0.5 in). Layer 1 uses the same fallback so the two agree; the layout says when it is used.
PLATE_THICKNESS_DEFAULT = 0.0127

#: Channel velocity head allowed at a feed port, as a share of the injector drop (config audit
#: H-1, 2026-09-25). Holes fed across a channel see its static pressure and recover none of its
#: velocity head (NASA TN D-5467); at 5 % the holes beside the port lose ~2.5 % of their flow.
MANIFOLD_Q_FRAC = 0.05

#: Factor on the plate material's yield that the plate-bending check allows (ASSUMED; the check
#: says so when it fires). The stress it is compared with is already a conservative estimate.
PLATE_YIELD_FACTOR = 1.5

#: ASSUMED Poisson ratio for the plate-bending check when ``injector.plate.poisson_ratio`` is not
#: declared (steels, aluminium and copper alloys sit at 0.28-0.34).
PLATE_POISSON_DEFAULT = 0.3

PSI = 6894.757
ATM = 101325.0


# =============================================================================================
# Small helpers
# =============================================================================================

def _half_major(d: float, theta_deg: float) -> float:
    """Radial half-extent of an inclined hole's elliptical trace on an axis-normal plane."""
    return 0.5 * d / max(_COS_FLOOR, abs(math.cos(math.radians(theta_deg))))


def _get(m: Any, key: str) -> Any:
    if m is None:
        return None
    if isinstance(m, Mapping):
        return m.get(key)
    return getattr(m, key, None)


def _f(v: Any, default: float = 0.0) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


def _stream(raw: Any) -> Dict[str, float]:
    return {
        "n_elements": _f(_get(raw, "n_elements")),
        "d_jet": _f(_get(raw, "d_jet")),
        "impingement_angle": _f(_get(raw, "impingement_angle")),
        "spacing": _f(_get(raw, "spacing")),
    }


def _plain(m: Any) -> Optional[Dict[str, Any]]:
    """A config sub-block as a plain dict (None stays None)."""
    if m is None:
        return None
    if isinstance(m, Mapping):
        return dict(m)
    if hasattr(m, "model_dump"):
        return m.model_dump()
    return None


def _req_dict(cfg: Any) -> Dict[str, Any]:
    req = _get(cfg, "design_requirements") or {}
    if isinstance(req, Mapping):
        return dict(req)
    return req.model_dump() if hasattr(req, "model_dump") else {}


def _tan(th: float) -> float:
    return math.tan(math.radians(th))


def _sin(th: float) -> float:
    return math.sin(math.radians(th))


def _cos(th: float) -> float:
    return math.cos(math.radians(th))


# =============================================================================================
# The envelope the plug fills
# =============================================================================================

def assembly_envelope(cfg: Any) -> Dict[str, Any]:
    """Bore, liner and sleeve radii from the engine config.

    * gas bore: ``chamber_geometry.chamber_diameter``;
    * liner: ``ablative_cooling.initial_thickness`` when ablative cooling is on;
    * sleeve: OD from ``frozen_parameters.D_chamber_outer_mm``, else
      ``design_requirements.max_chamber_outer_diameter``; wall from
      ``metal_wall_thickness_per_side_m`` -- the same numbers Layer 1 sizes the bore from.

    The injector plug's radius is the sleeve's inner radius. When the sleeve is not declared it
    is taken as bore + liner, and ``sleeve_declared`` says so.
    """
    r_bore = 0.5 * _f(_get(_get(cfg, "chamber_geometry"), "chamber_diameter"))
    abl = _get(cfg, "ablative_cooling")
    liner = _f(_get(abl, "initial_thickness")) if (abl is not None and _get(abl, "enabled")) else 0.0
    req = _req_dict(cfg)
    frozen = req.get("frozen_parameters") or {}
    od = _f(_get(frozen, "D_chamber_outer_mm")) / 1000.0 or _f(req.get("max_chamber_outer_diameter"))
    wall = _f(req.get("metal_wall_thickness_per_side_m"))
    declared = od > 0 and wall > 0
    r_sleeve_id = 0.5 * od - wall if declared else r_bore + liner
    return {
        "r_bore": r_bore,
        "liner_thickness": liner,
        "r_sleeve_id": r_sleeve_id,
        "r_sleeve_od": 0.5 * od if declared else r_sleeve_id,
        "sleeve_wall": wall if declared else 0.0,
        "sleeve_declared": declared,
        # Radial gap (+) or interference (-) between the liner OD and the sleeve bore.
        "liner_gap": r_sleeve_id - (r_bore + liner),
    }


# =============================================================================================
# Face
# =============================================================================================

def exit_recess(*, d_in: float, th_in: float, d_out: float, th_out: float, exit_land: float) -> float:
    """Depth below the face datum both exits sit at on a contoured face [m, positive].

    Each exit is a round hole of diameter d in a flank inclined theta to the face; for the whole
    hole plus ``exit_land`` to sit on the flank below its edge, the exit centre must be
    ``(d/2 + land) sin(theta)`` below the datum. Both exits go to the deeper of the two, so they
    share one plane: then the jets meet at exactly the flat-face radius and axial height above
    the exits, and every ring formula Layer 1 uses stays exact.
    """
    return max((0.5 * d_in + exit_land) * _sin(th_in), (0.5 * d_out + exit_land) * _sin(th_out))


def ring_face_reach(
    *, contoured: bool, r_in: float, d_in: float, th_in: float,
    r_out: float, d_out: float, th_out: float, exit_land: float = EXIT_LAND_DEFAULT,
) -> Tuple[float, float]:
    """Innermost and outermost radius the ring pair occupies on the face datum.

    Flat face: the elliptical exit traces, ``d / (2 cos theta)`` radially. Contoured face: the
    groove's edges, where each flank reaches the datum. These are what an igniter keep-out and the
    bore clearance are measured against.
    """
    if not contoured:
        return r_in - _half_major(d_in, th_in), r_out + _half_major(d_out, th_out)
    dE = exit_recess(d_in=d_in, th_in=th_in, d_out=d_out, th_out=th_out, exit_land=exit_land)
    return r_in - dE / max(1e-9, _tan(th_in)), r_out + dE / max(1e-9, _tan(th_out))


def face_geometry(
    *, contoured: bool, r_in: float, r_out: float, d_in: float, d_out: float,
    th_in: float, th_out: float, exit_land: float = EXIT_LAND_DEFAULT, groove_bottom: str = "flat",
) -> Dict[str, Any]:
    """Exits, impingement point, free-jet lengths and the face profile for one ring pair.

    The inner ring's jet leaves along (sin th_in, cos th_in) -- outward and downstream -- and the
    outer ring's along (-sin th_out, cos th_out). With both exits at depth ``z_E`` they meet
    ``L_ax = (r_out - r_in) / (tan th_in + tan th_out)`` downstream of the exits, at
    ``r_imp = r_in + L_ax tan th_in``. Along each jet that is ``L_ax / cos th`` -- the
    impingement distance as SP-8089 defines it.

    Contoured groove: inner flank ``z = z_E - (r - r_in) tan th_in``, outer flank
    ``z = z_E - (r_out - r) tan th_out``. The bottom is flat at the depth where each flank still
    gives ``d/2 + land`` of slant below its exit, unless the flanks meet first (a sharp V), or
    ``groove_bottom = "v"`` asks for the V.
    """
    dr = r_out - r_in
    ts = _tan(th_in) + _tan(th_out)
    L_ax = dr / ts if ts > 1e-9 else 0.0
    out: Dict[str, Any] = {"contoured": bool(contoured)}
    if contoured:
        dE = exit_recess(d_in=d_in, th_in=th_in, d_out=d_out, th_out=th_out, exit_land=exit_land)
        z_E = -dE
        edge_in = r_in - dE / max(1e-9, _tan(th_in))
        edge_out = r_out + dE / max(1e-9, _tan(th_out))
        # The flanks' own intersection (the deepest the groove can be).
        x = dr * _tan(th_out) / ts if ts > 1e-9 else 0.0
        r_v, d_v = r_in + x, dE + x * _tan(th_in)
        want = dE + max((0.5 * d_in + exit_land) * _sin(th_in), (0.5 * d_out + exit_land) * _sin(th_out))
        if groove_bottom == "v" or want >= d_v:
            bottom = [(r_v, -d_v)]
            depth = d_v
        else:
            depth = want
            bottom = [(r_in + (depth - dE) / _tan(th_in), -depth),
                      (r_out - (depth - dE) / _tan(th_out), -depth)]
        profile = [(0.0, 0.0), (edge_in, 0.0), *bottom, (edge_out, 0.0)]
        out.update(
            exit_depth=dE, z_exit=z_E, groove_edge_in=edge_in, groove_edge_out=edge_out,
            groove_depth=depth, groove_v_depth=d_v, groove_v_r=r_v,
            groove_is_v=len(bottom) == 1, groove_short_of_land=want > d_v + 1e-12,
            groove_width=edge_out - edge_in,
            flank_included=180.0 - th_in - th_out,
        )
    else:
        z_E = 0.0
        profile = [(0.0, 0.0)]
        out.update(exit_depth=0.0, z_exit=0.0)
    out.update(
        profile=profile,
        l_ax=L_ax,
        r_imp=r_in + L_ax * _tan(th_in),
        z_imp=z_E + L_ax,
        free_jet_in=L_ax / max(1e-9, _cos(th_in)),
        free_jet_out=L_ax / max(1e-9, _cos(th_out)),
    )
    return out


def face_z_at(profile: List[Tuple[float, float]], r: float) -> float:
    """Face surface height at radius r (0 outside the groove)."""
    for (r0, z0), (r1, z1) in zip(profile, profile[1:]):
        if r0 <= r <= r1 and r1 > r0:
            return z0 + (z1 - z0) * (r - r0) / (r1 - r0)
    return 0.0


# =============================================================================================
# Passages, plenum or channels
# =============================================================================================

class BackEntry(NamedTuple):
    r_back: float        # radius of the passage axis on the back face [m]
    entry_d: float       # diameter of what opens there: counterbore, or the orifice if none
    inner_edge: float    # radial extent of the entry's elliptical trace [m]
    outer_edge: float
    web: float           # chord to the neighbouring entry, less its width [m]


def passage_back_entry(
    *, r_face: float, d: float, theta_deg: float, plate_thickness: float,
    counterbore_dia: float, land_ld: float, is_inner: bool, n: int, exit_depth: float = 0.0,
) -> BackEntry:
    """Plenum back: where one ring's passage opens on the flat back face.

    From an exit at depth ``exit_depth`` the hole runs ``(t - exit_depth) / cos(theta)`` along its
    axis and moves ``(t - exit_depth) tan(theta)`` radially -- inward for the inner ring, outward
    for the outer, because the jets aim at each other. What opens there is the counterbore when
    the land leaves room for one, the orifice otherwise.
    """
    t = float(plate_thickness) - float(exit_depth)
    c = _cos(theta_deg)
    thru = t / c if c > 1e-9 else float("inf")
    land = min(thru, land_ld * d)
    entry_d = counterbore_dia if (counterbore_dia > d and thru - land > 0.0) else d
    shift = t * _tan(theta_deg)
    r_back = r_face - shift if is_inner else r_face + shift
    hm = _half_major(entry_d, theta_deg)
    web = 2.0 * r_back * math.sin(math.pi / max(1, n)) - entry_d if r_back > 0 else -entry_d
    return BackEntry(r_back, entry_d, r_back - hm, r_back + hm, web)


def channel_for_ring(
    *, r_exit: float, z_exit: float, d: float, theta_deg: float, is_inner: bool,
    plate_thickness: float, passage_ld: float, width: Optional[float], floor: str = "flat",
    exit_land: float = EXIT_LAND_DEFAULT, spot_length: Optional[float] = None,
) -> Dict[str, Any]:
    """Channels back: the passage from its exit to the channel floor, and the channel around it.

    The passage is a straight hole of diameter d along the jet axis, ``passage_ld * d`` long,
    running from the exit into the plate: toward the axis for the inner ring, away for the outer.
    It ends at ``Q``. The channel floor passes through ``Q`` -- flat (axis-normal), or ``coned``
    (normal to the passage, so the hole breaks through square) -- and the channel is centred on
    ``Q``'s radius. That centring is the alignment: the hole's whole footprint lands on the floor
    with ``exit_land`` to each wall.

    ``spot``: the floor stays flat, and where the passage enters a drill spot -- a facet square
    to the passage, ``spot_length`` across (None => d + 2 x exit_land) -- is cut at the floor's
    edge. The facet is centred on ``Q``; the flat floor runs ``width`` from the facet's end
    nearer the face, away from the exit side, and the channel's walls go straight up to the back
    face from the floor's far edge and the facet's other end. (The stand's plate: a 0.300 in
    floor beside a 0.100 in spot.)

    If the passage would come out through the back face before reaching that length, it is
    clipped there (``pierces_back``): the channel depth is then zero and the realised L/d short.
    """
    t = float(plate_thickness)
    s, c = _sin(theta_deg), _cos(theta_deg)
    k = -1.0 if is_inner else 1.0                  # radial direction travelled going in
    lam_want = float(passage_ld) * d
    if floor == "spot":
        return _spot_channel(r_exit=r_exit, z_exit=z_exit, d=d, theta_deg=theta_deg, k=k, t=t,
                             lam_want=lam_want, width=width, exit_land=exit_land,
                             spot=float(spot_length) if spot_length else d + 2.0 * exit_land)
    if floor == "coned":
        foot = d * c                               # square breakthrough: a circle of d, seen radially
        # Floor normal along the passage. Going outward the inner ring's floor falls toward the
        # back face and the outer ring's rises toward the face.
        slope = (1.0 if k > 0 else -1.0) * _tan(theta_deg)
    else:
        foot = d / c if c > 1e-9 else float("inf")  # oblique breakthrough: an ellipse d / cos
        slope = 0.0
    w_min = foot + 2.0 * exit_land
    w = max(float(width), w_min) if width else w_min
    # The floor must stay inside the plate at its SHALLOWEST wall, not just on the passage axis:
    # a coned floor tilts by theta, so one wall sits (w/2) tan(theta) nearer the back face.
    lam_max = (t + z_exit - abs(slope) * 0.5 * w) / c if c > 1e-9 else float("inf")
    pierces = lam_want > lam_max
    lam = max(0.0, min(lam_want, lam_max))
    rQ, zQ = r_exit + k * lam * s, z_exit - lam * c
    floor_z = lambda r: zQ + slope * (r - rQ)  # noqa: E731
    lo, hi = rQ - 0.5 * w, rQ + 0.5 * w
    return {
        "exit": (r_exit, z_exit),
        "end": (rQ, zQ),
        "length": lam,
        "length_wanted": lam_want,
        "l_over_d": lam / d if d > 0 else 0.0,
        "pierces_back": pierces,
        "r_center": rQ,
        "width": w,
        "width_min": w_min,
        "width_widened": bool(width) and float(width) < w_min,
        "r_lo": lo,
        "r_hi": hi,
        "floor": floor,
        "floor_slope": slope,
        "floor_z_lo": floor_z(lo),
        "floor_z_hi": floor_z(hi),
        # Depth from the back face at the centre and at the shallowest wall.
        "depth": t + zQ,
        "depth_min": t + min(floor_z(lo), floor_z(hi)),
        "footprint": foot,
        "breakthrough": "square" if floor == "coned" else f"{theta_deg:.0f} deg off square",
        # The metal lip where the hole meets the floor, on its acute side: 90 deg is the square
        # sharp edge the Cd model's inlets are measured on; a flat floor leaves (90 - theta).
        "entry_lip_deg": 90.0 if floor == "coned" else 90.0 - float(theta_deg),
        # Cross-section of the channel itself (the cover may add more).
        "flow_area": w * (t + min(floor_z(lo), floor_z(hi))) if w > 0 else 0.0,
        # Its outline in (r, z), back face -> floor -> back face, in increasing r.
        "section": [(lo, -t), (lo, max(-t, floor_z(lo))), (hi, max(-t, floor_z(hi))), (hi, -t)],
        "r_floor": rQ,
    }


def _poly_area_centroid_r(ps: List[Tuple[float, float]]) -> Tuple[float, float, float]:
    """(area, centroid radius, perimeter) of a closed polygon in (r, z)."""
    a = cx = per = 0.0
    for i in range(len(ps)):
        (x0, y0), (x1, y1) = ps[i], ps[(i + 1) % len(ps)]
        cr = x0 * y1 - x1 * y0
        a += cr
        cx += (x0 + x1) * cr
        per += math.hypot(x1 - x0, y1 - y0)
    return abs(0.5 * a), (cx / (3.0 * a) if abs(a) > 1e-30 else 0.0), per


def _spot_channel(*, r_exit: float, z_exit: float, d: float, theta_deg: float, k: float, t: float,
                  lam_want: float, width: Optional[float], exit_land: float, spot: float) -> Dict[str, Any]:
    """``channel_for_ring`` with ``floor == "spot"``; see there."""
    s, c = _sin(theta_deg), _cos(theta_deg)
    h = 0.5 * spot
    # The facet's end away from the face sits (spot/2) sin(theta) nearer the back than Q.
    lam_max = (t + z_exit - h * s) / c if c > 1e-9 else float("inf")
    pierces = lam_want > lam_max
    lam = max(0.0, min(lam_want, lam_max))
    rQ, zQ = r_exit + k * lam * s, z_exit - lam * c
    # Facet direction, square to the passage (k s, -c): (c, k s). Its end nearer the face has
    # the larger z; the flat floor runs from there, away from the facet's other end.
    e1 = (rQ + h * c, zQ + h * k * s)
    e2 = (rQ - h * c, zQ - h * k * s)
    near, far = (e1, e2) if e1[1] >= e2[1] else (e2, e1)
    w = float(width) if width else spot
    out_dir = 1.0 if near[0] > far[0] else -1.0
    edge = near[0] + out_dir * w
    zf = near[1]
    if out_dir > 0:
        sec = [(far[0], -t), far, near, (edge, zf), (edge, -t)]
    else:
        sec = [(edge, -t), (edge, zf), near, far, (far[0], -t)]
    area, r_cen, per = _poly_area_centroid_r(sec)
    wet = per                          # walls, floor and spot, and the cover across the top
    lo, hi = sec[0][0], sec[-1][0]
    return {
        "exit": (r_exit, z_exit), "end": (rQ, zQ), "length": lam, "length_wanted": lam_want,
        "l_over_d": lam / d if d > 0 else 0.0, "pierces_back": pierces,
        "r_center": r_cen, "width": hi - lo, "width_min": spot, "width_widened": False,
        "r_lo": lo, "r_hi": hi, "floor": "spot", "floor_slope": 0.0,
        "floor_z_lo": zf, "floor_z_hi": zf,
        "depth": t + zf, "depth_min": t + max(zf, far[1]),
        "footprint": d, "breakthrough": "square (drill spot)", "entry_lip_deg": 90.0,
        "flow_area": area, "hydraulic_diameter": 4.0 * area / wet if wet > 0 else 0.0,
        "section": sec, "r_floor": near[0] + 0.5 * out_dir * w,
        "spot_length": spot, "floor_width": w, "spot": (near, far),
    }


def channel_velocity_head(
    *, flow_area: float, mdot: float, rho: float, dp: float, inlets: int = 1,
    q_frac: float = MANIFOLD_Q_FRAC,
) -> Dict[str, float]:
    """A channel's velocity head at its feed port against the injector drop, and the area that
    keeps it to ``q_frac`` of that drop.

    Each of ``inlets`` ports splits two ways around the ring, so a branch leaves the port with
    ``mdot / (2 inlets)``: ``v = mdot_branch / (rho A)``, ``q = rho v^2 / 2``. The holes beside the
    port are driven by the channel's static pressure, ``dp - q`` (Rohde, Richards & Metger, NASA
    TN D-5467: no velocity-head recovery with the approach flow normal to the hole), so they flow
    ``sqrt(1 - q/dp)`` of design. ``A_needed = mdot_branch / sqrt(2 rho q_frac dp)``.
    """
    n = max(1, int(inlets))
    branch = float(mdot) / (2.0 * n)
    if not (flow_area > 0 and rho > 0 and dp > 0):
        return {"branch_mdot": branch, "v": float("nan"), "q": float("nan"), "q_over_dp": float("nan"),
                "area_needed": float("nan"), "fed_end_flow": float("nan"), "inlets": n, "q_frac": q_frac}
    v = branch / (rho * flow_area)
    q = 0.5 * rho * v * v
    return {
        "branch_mdot": branch, "v": v, "q": q, "q_over_dp": q / dp,
        "area_needed": branch / math.sqrt(2.0 * rho * q_frac * dp),
        # The uniform-flow estimate for the holes beside the port. It assumes the design flow
        # through every hole, so it means something only while q << dp: past dp it is undefined
        # (the flow that makes q could not pass), not zero -- None.
        "fed_end_flow": math.sqrt(1.0 - q / dp) if q < dp else None,
        "inlets": n, "q_frac": q_frac,
    }


def channel_lands(
    *, ch_in: Dict[str, Any], ch_out: Dict[str, Any], r_centre_hole: float, r_plate: float,
) -> Dict[str, float]:
    """Metal left on the back face: centre hole to inner channel, between channels, outer channel
    to the plate edge. These are what any seal, and the wall between propellants, must fit in."""
    return {
        "inner": ch_in["r_lo"] - r_centre_hole,
        "between": ch_out["r_lo"] - ch_in["r_hi"],
        "outer": r_plate - ch_out["r_hi"],
    }


# =============================================================================================
# Igniter port
# =============================================================================================

def igniter_keepouts(
    igniter: Optional[Mapping[str, Any]], *, plate_thickness: float, min_web: float,
) -> Optional[Dict[str, Any]]:
    """What a declared igniter port takes out of the plate, from its thread alone.

    Front: the tapped hole at thread OD plus ``min_web`` of wall. Engagement: the plate (or a
    thicker centre hub, as wide as that keep-out) must be at least the thread's effective length
    L2. None when no igniter is declared.
    """
    if not igniter or not igniter.get("thread"):
        return None
    thr = NPT[str(igniter["thread"])]
    wall = float(min_web or 0.0)
    hub_t = igniter.get("hub_thickness")
    engaged = float(hub_t) if hub_t is not None else float(plate_thickness)
    keepout = thr.od + 2.0 * wall
    # A centre left thicker than the field is as wide as the port's keep-out: the back face
    # steps up there, and the inner channel must clear it.
    hub_d = keepout if (hub_t is not None and float(hub_t) > float(plate_thickness)) else 0.0
    return {
        "thread": str(igniter["thread"]),
        "thread_od": thr.od,
        "l2": thr.l2_effective,
        "tap_drill": thr.tap_drill,
        "face_wall": wall,
        "face_keepout_dia": keepout,
        "engaged_thickness": engaged,
        "hub_thickness": float(hub_t) if hub_t is not None else None,
        "hub_diameter": hub_d or None,
        "back_keepout_dia": hub_d,
        "source": thr.source,
    }


# =============================================================================================
# The plate's half-section
# =============================================================================================

def _fillet(a: Tuple[float, float], P: Tuple[float, float], b: Tuple[float, float], rho: float,
            n: int = 6) -> List[Tuple[float, float]]:
    """Corner P (coming from a, going to b) rounded to radius rho: the arc's points, P if 0."""
    if rho <= 0:
        return [P]
    ua = (a[0] - P[0], a[1] - P[1])
    ub = (b[0] - P[0], b[1] - P[1])
    la, lb = math.hypot(*ua), math.hypot(*ub)
    if la <= 0 or lb <= 0:
        return [P]
    ua, ub = (ua[0] / la, ua[1] / la), (ub[0] / lb, ub[1] / lb)
    ang = math.acos(max(-1.0, min(1.0, ua[0] * ub[0] + ua[1] * ub[1])))
    tl = rho / math.tan(0.5 * ang)
    bis = (ua[0] + ub[0], ua[1] + ub[1])
    bl = math.hypot(*bis)
    C = (P[0] + bis[0] / bl * rho / math.sin(0.5 * ang), P[1] + bis[1] / bl * rho / math.sin(0.5 * ang))
    T1, T2 = (P[0] + ua[0] * tl, P[1] + ua[1] * tl), (P[0] + ub[0] * tl, P[1] + ub[1] * tl)
    a1, a2 = math.atan2(T1[1] - C[1], T1[0] - C[0]), math.atan2(T2[1] - C[1], T2[0] - C[0])
    sw = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
    return [(C[0] + rho * math.cos(a1 + sw * i / n), C[1] + rho * math.sin(a1 + sw * i / n)) for i in range(n + 1)]


def _rounded(ps: List[Tuple[float, float]], radii: List[float]) -> List[Tuple[float, float]]:
    """An open polyline with its interior corners rounded (radii per interior vertex)."""
    out = [ps[0]]
    for i in range(1, len(ps) - 1):
        out += _fillet(ps[i - 1], ps[i], ps[i + 1], radii[i - 1])
    out.append(ps[-1])
    return out


def plate_profile(out: Mapping[str, Any], plate: Mapping[str, Any], *, with_port: bool = True
                  ) -> Dict[str, Any]:
    """The plug's half-section as one closed loop in (r, z) -- face datum z = 0, back face z = -t --
    from the layout and the plate's declared features: the face (groove), the centre port's
    drilled bore, the rim gland, and along the back each channel's section and each groove.

    This is the revolve sketch: what CAD turns round the axis, what the bending check cuts, and
    what a drawing (``profile_dxf``) is compared with. A groove that would cut into a channel, the
    port or another groove is left out and reported, so the loop stays one simple outline."""
    t = float(out["inputs"]["plate_thickness"])
    R = float(out["envelope"]["r_sleeve_id"])
    ign = out.get("igniter") if with_port else None
    r_port = 0.5 * float(ign["tap_drill"]) if ign else 0.0
    hub_t = float(ign.get("hub_thickness") or t) if ign else t
    hub_r = 0.5 * float(ign.get("hub_diameter") or 0.0) if ign else 0.0
    face = [(r, z) for r, z in out["face"]["profile"] if r_port < r < R - 1e-12]
    loop: List[Tuple[float, float]] = [(r_port, 0.0), *face, (R, 0.0)]

    gl = plate.get("rim_gland")
    if gl:
        z0, z1 = float(gl["z_start"]), float(gl["z_start"]) + float(gl["width"])
        dep, rc = float(gl["depth"]), float(gl.get("corner_radius") or 0.0)
        if z1 < t and dep < R - r_port:
            loop += _rounded([(R, 0.0), (R, -z0), (R - dep, -z0), (R - dep, -z1), (R, -z1), (R, -t)],
                             [0.0, rc, rc, 0.0])[1:-1]
    loop.append((R, -t))

    # Back-face features, each an open outline from its high-r edge to its low-r edge.
    feats: List[Tuple[float, float, str, List[Tuple[float, float]]]] = []
    for k in ("O", "F"):
        ch = out["passages"][k].get("channel")
        if ch and ch.get("section"):
            sec = [(r, max(z, -t)) for r, z in ch["section"]]
            feats.append((sec[0][0], sec[-1][0], f"{'LOX' if k == 'O' else 'fuel'} channel", sec[::-1]))
    skipped: List[str] = []
    grooves = []
    for i, g in enumerate(plate.get("back_grooves") or []):
        ri, ro, dep = float(g["r_inner"]), float(g["r_outer"]), float(g["depth"])
        rc = float(g.get("corner_radius") or 0.0)
        name = f"back groove {i + 1}"
        grooves.append({"name": name, "r_inner": ri, "r_outer": ro, "depth": dep})
        if not (ro > ri and dep < t):
            skipped.append(f"{name}: not a groove inside the plate")
            continue
        pts = _rounded([(ro, -t), (ro, -t + dep), (ri, -t + dep), (ri, -t)], [rc, rc])
        feats.append((ri, ro, name, pts))
    # Channels first: they are the engine's; a groove gives way to them, never the reverse.
    feats.sort(key=lambda f: (f[2].startswith("back groove"), -f[1]))
    kept: List[Tuple[float, float, str, List[Tuple[float, float]]]] = []
    lo_edge = hub_r if hub_t > t else r_port
    for f in feats:
        clash = [q[2] for q in kept if f[0] < q[1] and q[0] < f[1]]
        if f[1] > R or f[0] < lo_edge or clash:
            why = ", ".join(clash) or ("the rim" if f[1] > R else "the centre port")
            if f[2].startswith("back groove"):
                skipped.append(f"{f[2]} (r {f[0] * 1000:.2f}–{f[1] * 1000:.2f}) runs into {why}")
                continue
        kept.append(f)
    kept.sort(key=lambda f: -f[1])
    for f in kept:
        loop += f[3]
    if hub_t > t and hub_r > r_port:
        loop += [(hub_r, -t), (hub_r, -hub_t), (r_port, -hub_t)]
    else:
        loop.append((r_port, -t))
    # Lands on the back face between neighbouring cuts (and the port, and the rim).
    edges = sorted([(f[0], f[1], f[2]) for f in kept], key=lambda e: e[0])
    lands = []
    prev_hi, prev_name = lo_edge, ("the centre port" if r_port > 0 else "the axis")
    for lo, hi, name in edges:
        lands.append({"between": f"{prev_name} and {name}", "land": lo - prev_hi})
        prev_hi, prev_name = hi, name
    lands.append({"between": f"{prev_name} and the rim", "land": R - prev_hi})
    # The port is tapped from the back: at the back face it is the thread's major diameter.
    clash = []
    if ign:
        r_thr = 0.5 * float(ign["thread_od"])
        for f in kept:
            if f[0] < r_thr:
                clash.append(f"the {ign['thread']} igniter thread (⌀{2 * r_thr * 1000:.2f} at the back face) "
                             f"cuts {f[2]} (r {f[0] * 1000:.2f}–{f[1] * 1000:.2f})")
    return {"loop": loop, "grooves": grooves, "skipped": skipped, "back_lands": lands,
            "thread_clash": clash, "thickness": t, "with_port": bool(ign)}


def feed_ports(out: Mapping[str, Any], plate: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The cover plate's feed ports, ``channel_inlets`` per ring on its channel: where they sit,
    and the back-face grooves each port's bore lands across (a face seal with its sealing land
    opened by a port does not seal). None without ``port_thread`` or channels."""
    thread = plate.get("port_thread")
    if not thread or out["back"]["mode"] != "channels":
        return None
    thr = NPT[str(thread)]
    n = int(_f(plate.get("channel_inlets"), 1.0) or 1)
    bore = _f(plate.get("port_bore"), 0.0) or thr.tap_drill
    pitch = 360.0 / n
    clock_F = plate.get("port_clock_F_deg")
    clock_F = 0.5 * pitch if clock_F is None else float(clock_F)
    rings = {}
    for k in ("O", "F"):
        ch = out["passages"][k]["channel"]
        r = _f(plate.get(f"port_radius_{k}"), 0.0) or 0.5 * (ch["r_lo"] + ch["r_hi"])
        a0 = 0.0 if k == "O" else clock_F
        rings[k] = {"r": r, "angles_deg": [a0 + i * pitch for i in range(n)],
                    "bore_r_lo": r - 0.5 * bore, "bore_r_hi": r + 0.5 * bore,
                    "channel_r_lo": ch["r_lo"], "channel_r_hi": ch["r_hi"]}
    return {"thread": str(thread), "thread_od": thr.od, "tap_drill": thr.tap_drill, "bore": bore,
            "bore_declared": plate.get("port_bore") is not None, "per_ring": n,
            "clock_F_deg": clock_F, "rings": rings, "source": thr.source}


def _check_back_features(out: Dict[str, Any]) -> None:
    prof, ports = out.get("profile"), out.get("ports")
    if not prof:
        return
    for msg in prof["skipped"]:
        out["warnings"].append({"level": "bad", "code": "back_groove", "text": msg + " — not drawn"})
    for msg in prof.get("thread_clash") or []:
        out["warnings"].append({"level": "bad", "code": "igniter_groove", "text": msg})
    if prof["grooves"]:
        worst = min(prof["back_lands"], key=lambda l: l["land"])
        out["warnings"].append({"level": "info", "code": "back_lands",
                                "text": "back-face lands: " + "; ".join(
                                    f"{l['between']} {l['land'] * 1000:.2f} mm" for l in prof["back_lands"])
                                        + f" (least {worst['land'] * 1000:.2f} mm)"})
    if ports:
        for k, ring in ports["rings"].items():
            tag = "LOX" if k == "O" else "fuel"
            for g in prof["grooves"]:
                ov = min(ring["bore_r_hi"], g["r_outer"]) - max(ring["bore_r_lo"], g["r_inner"])
                if ov > 0:
                    out["warnings"].append({
                        "level": "warn", "code": f"port_over_groove_{k}",
                        "text": (f"{tag} port bore ⌀{ports['bore'] * 1000:.2f} on r {ring['r'] * 1000:.2f} spans r "
                                 f"{ring['bore_r_lo'] * 1000:.2f}–{ring['bore_r_hi'] * 1000:.2f}, {ov * 1000:.2f} mm over "
                                 f"{g['name']} (r {g['r_inner'] * 1000:.2f}–{g['r_outer'] * 1000:.2f}): the seal there has no "
                                 f"land under the port — move the port, or open it with a smaller bore (injector.plate.port_bore)")})


# =============================================================================================
# Discharge coupling
# =============================================================================================

def realized_land(
    *, d: float, theta_deg: float, plate_thickness: float, counterbore_dia: float,
    declared_land_ld: Optional[float],
) -> Dict[str, Any]:
    """Plenum back: the orifice land the plate actually gives, and the counterbore feeding it.

    With a counterbore wider than the orifice, the land is what the counterbore leaves:
    ``declared_land_ld * d``, capped at the passage length. Without one, the small drill runs the
    whole passage, ``t / cos(theta)``. Measured on the hole axis.
    """
    c = _cos(theta_deg)
    thru = plate_thickness / c if c > 1e-9 else float("inf")
    if counterbore_dia > d:
        want = (declared_land_ld * d) if declared_land_ld else thru
        land = min(thru, want)
        beta = d / counterbore_dia if thru - land > 1e-12 else None
    else:
        land, beta = thru, None
    return {"land": land, "land_ld": land / d if d > 0 else 0.0, "thru": thru, "beta": beta,
            "wall_skew": d * _tan(theta_deg)}


def _plate_block(cfg: Any) -> Dict[str, Any]:
    return _plain(_get(_get(cfg, "injector"), "plate")) or {}


def effective_discharge(engine_config: Any, side: str) -> Any:
    """The discharge block the Cd model should use for ``side``, given the plate as built.

    Unchanged unless the block says ``l_over_d_source: plate``. Then the orifice L/d is the one the
    geometry gives: with channels, the passage length to the channel floor; with a plenum, the
    land (or the whole passage when there is no counterbore). Both solver paths call this.
    """
    dc = engine_config.discharge[side]
    if getattr(dc, "l_over_d_source", "declared") != "plate":
        return dc
    lay = layout_from_config(engine_config, drawings=False, checks=False)
    key = "O" if side == "oxidizer" else "F"
    if lay is None:
        from engine.pipeline.assumptions import assume
        assume(f"discharge.{side}.l_over_d_source", "declared",
               reason="l_over_d_source is 'plate' but there is no impinging injector layout")
        return dc
    return _discharge_as_built(dc, lay["passages"][key])


def _discharge_as_built(dc: Any, passage: Mapping[str, Any]) -> Any:
    """``dc`` with the L/d (and counterbore approach) the plate gives, when it asks for that."""
    if getattr(dc, "l_over_d_source", "declared") != "plate":
        return dc
    return dc.model_copy(update={"orifice_l_over_d": passage["plate_l_over_d"],
                                 "approach_beta": passage.get("beta")})


def _check_inlet_fit(out: Dict[str, Any]) -> None:
    """A radiused or chamfered inlet takes floor beside the hole: on a flat floor the hole meets
    it (90 - theta) on its acute side, where a fillet of radius r runs r / tan((90 - theta)/2)
    onto the floor. The channel is sized from the bare hole, so say when the inlet does not fit
    and what width would take it."""
    from engine.core.injectors.drawing import _inlet_shape
    for k in ("O", "F"):
        p = out["passages"][k]
        ch = p.get("channel")
        shape = _inlet_shape(p)
        if ch is None or shape is None or ch["pierces_back"]:
            continue
        st = out["inputs"]["oxidizer" if k == "O" else "fuel"]
        d, th = float(st["d_jet"]), float(st["impingement_angle"])
        kind, size = shape
        alpha = math.radians(90.0 if ch["floor"] == "coned" else 90.0 - th)
        reach = size * d if kind == "chamfer" else size * d / math.tan(0.5 * alpha)
        room = 0.5 * (ch["width"] - ch["footprint"])
        p["inlet_reach"] = reach
        if reach > room + 1e-9:
            tag = "LOX" if k == "O" else "fuel"
            out["warnings"].append({
                "level": "warn", "code": f"inlet_fit_{k}",
                "text": (f"{tag} inlet runs {reach * 1000:.2f} mm onto the channel floor beside the hole; the "
                         f"channel leaves {room * 1000:.2f} mm — make the channel ≥ "
                         f"{(ch['footprint'] + 2 * reach) * 1000:.2f} mm wide, or use a smaller inlet")})


def _report_cd(cfg: Any, out: Dict[str, Any]) -> None:
    """Each hole's high-Re Cd from the discharge model the solver uses, at the L/d it uses, and
    what that number is made of -- so a change of hole L/d shows its effect on Cd (and Δp)
    where it is made. ``passages[k]["cd"]`` is None without a discharge block."""
    from engine.core.discharge import (
        INLET_GEOMETRY_CD, cd_from_inlet_radius_ratio, cd_inf_from_orifice_diameter,
        cd_length_factor, cd_with_approach,
    )
    from engine.pipeline.config_schemas import DischargeConfig

    dis = _get(cfg, "discharge")
    for k, side in (("O", "oxidizer"), ("F", "fuel")):
        p = out["passages"][k]
        raw = _get(dis, side) if dis is not None else None
        if raw is None:
            p["cd"] = None
            continue
        dc = raw if isinstance(raw, DischargeConfig) else DischargeConfig.model_validate(_plain(raw))
        dc = _discharge_as_built(dc, p)
        d = float(out["inputs"]["oxidizer" if k == "O" else "fuel"]["d_jet"])
        cd = cd_inf_from_orifice_diameter(d, dc)
        rd, name = getattr(dc, "inlet_radius_ratio", None), getattr(dc, "inlet_geometry", None)
        info: Dict[str, Any] = {"value": cd, "l_over_d": getattr(dc, "orifice_l_over_d", None),
                                "model": getattr(dc, "length_model", "lichtarowicz"),
                                # what the drawing cuts at the hole's entry edge
                                "inlet_name": str(name).lower() if name is not None else None,
                                "inlet_r_over_d": float(rd) if rd is not None else None}
        if rd is None and name is None:
            # Diameter-scaled Cd_inf: the hole's L/d does not enter it.
            info.update(inlet=None, inlet_cd=None, length_factor=None, approach=None, uses_ld=False)
        else:
            base = cd_from_inlet_radius_ratio(float(rd)) if rd is not None else INLET_GEOMETRY_CD[str(name).lower()]
            lod = info["l_over_d"]
            lf = cd_length_factor(float(lod), info["model"]) if lod is not None else 1.0
            beta = getattr(dc, "approach_beta", None)
            info.update(inlet=(f"r/d {float(rd):g}" if rd is not None else str(name)), inlet_cd=base,
                        length_factor=lf,
                        approach=(cd_with_approach(base * lf, beta) / (base * lf)) if beta else None,
                        uses_ld=lod is not None)
        p["cd"] = info


# =============================================================================================
# Reading a config
# =============================================================================================

def layout_inputs_from_config(cfg: Any) -> Optional[Dict[str, Any]]:
    """Everything the layout needs, from an engine config (dict or pydantic model). None when the
    injector is not an impinging doublet or the geometry is incomplete."""
    inj = _get(cfg, "injector")
    if inj is None or str(_get(inj, "type") or "").lower() != "impinging":
        return None
    geom = _get(inj, "geometry")
    ox, fu = _get(geom, "oxidizer"), _get(geom, "fuel")
    bore = _f(_get(_get(cfg, "chamber_geometry"), "chamber_diameter"))
    if ox is None or fu is None or not bore > 0:
        return None
    req = _req_dict(cfg)
    dis = _get(cfg, "discharge") or {}
    band = impingement_ld_band(req)
    land_O = _f(_get(_get(dis, "oxidizer"), "orifice_l_over_d"), 4.0) or 4.0
    land_F = _f(_get(_get(dis, "fuel"), "orifice_l_over_d"), land_O) or land_O
    plate = _plate_block(cfg)
    t_drawn = _drawing(plate)["thickness"] if plate.get("profile_dxf") else None
    return {
        "oxidizer": _stream(ox),
        "fuel": _stream(fu),
        "bore_diameter": bore,
        "envelope": assembly_envelope(cfg),
        "fuel_outboard": _opt_bool(req, "layer1_ring_order_fuel_outboard", True),
        "center_clear_dia": _opt_float(req, "layer1_injector_center_clear_dia_m") or 0.0,
        "min_web": _opt_float(req, "layer1_injector_min_web_m") or 0.0,
        "wall_clearance": _opt_float(req, "layer1_injector_wall_clearance_m") or 0.0,
        "ld_min": band.lo,
        "ld_max": band.hi,
        "plate_thickness": t_drawn or _opt_float(req, "layer1_injector_plate_thickness_m") or PLATE_THICKNESS_DEFAULT,
        "plate_thickness_declared": bool(t_drawn or _opt_float(req, "layer1_injector_plate_thickness_m")),
        "counterbore_dia": _opt_float(req, "layer1_injector_counterbore_dia_m") or 0.0,
        "land_ld_O": land_O,
        "land_ld_F": land_F,
        "min_back_web": _opt_float(req, "layer1_injector_min_back_web_m") or 0.0,
        "igniter": _plain(_get(inj, "igniter")),
        "plate": plate,
        "ld_source_O": str(_get(_get(dis, "oxidizer"), "l_over_d_source") or "declared"),
        "ld_source_F": str(_get(_get(dis, "fuel"), "l_over_d_source") or "declared"),
    }


# =============================================================================================
# The layout
# =============================================================================================

def compute_layout(
    *,
    oxidizer: Mapping[str, float],
    fuel: Mapping[str, float],
    bore_diameter: float,
    envelope: Optional[Mapping[str, Any]] = None,
    fuel_outboard: bool = True,
    center_clear_dia: float = 0.0,
    min_web: float = 0.0,
    wall_clearance: float = 0.0,
    ld_min: float = IMPINGEMENT_LD_TARGET_DEFAULT,
    ld_max: float = IMPINGEMENT_LD_TARGET_DEFAULT,
    plate_thickness: float = 0.0127,
    counterbore_dia: float = 0.0,
    land_ld_O: float = 4.0,
    land_ld_F: Optional[float] = None,
    min_back_web: float = 0.0,
    igniter: Optional[Mapping[str, Any]] = None,
    plate: Optional[Mapping[str, Any]] = None,
    ld_source_O: str = "declared",
    ld_source_F: str = "declared",
    plate_thickness_declared: bool = True,
) -> Dict[str, Any]:
    """Every derived dimension of an unlike-doublet ring pair in its plug, and what is wrong with
    it. Lengths in metres, angles in degrees from the chamber axis."""
    plate = dict(plate or {})
    plate_declared = bool(plate)
    # Undeclared => the stand's plug: contoured face, channel back (the schema's defaults).
    contoured = str(plate.get("face") or "contoured") == "contoured"
    channels = str(plate.get("back") or "channels") == "channels"
    exit_land = float(plate["exit_land"]) if plate.get("exit_land") is not None else EXIT_LAND_DEFAULT
    env = dict(envelope or {})
    r_bore = bore_diameter / 2.0
    env.setdefault("r_bore", r_bore)
    env.setdefault("liner_thickness", 0.0)
    env.setdefault("r_sleeve_id", r_bore + env["liner_thickness"])
    env.setdefault("r_sleeve_od", env["r_sleeve_id"])
    env.setdefault("sleeve_wall", 0.0)
    env.setdefault("sleeve_declared", False)
    env.setdefault("liner_gap", env["r_sleeve_id"] - r_bore - env["liner_thickness"])
    r_plate = env["r_sleeve_id"]

    n = max(1, int(round(oxidizer["n_elements"])))
    n_F = max(1, int(round(fuel["n_elements"])))
    th = {"O": float(oxidizer["impingement_angle"]), "F": float(fuel["impingement_angle"])}
    d = {"O": float(oxidizer["d_jet"]), "F": float(fuel["d_jet"])}
    s = {"O": float(oxidizer["spacing"]), "F": float(fuel["spacing"])}
    d_pitch = {"O": n * s["O"] / math.pi, "F": n_F * s["F"] / math.pi}
    r = {k: d_pitch[k] / 2.0 for k in ("O", "F")}
    dr = abs(d_pitch["O"] - d_pitch["F"]) / 2.0
    ox_inner = fuel_outboard if d_pitch["O"] == d_pitch["F"] else d_pitch["O"] < d_pitch["F"]
    inner, outer = ("O", "F") if ox_inner else ("F", "O")
    tag = {"O": "LOX", "F": "fuel"}

    fg = face_geometry(contoured=contoured, r_in=r[inner], r_out=r[outer], d_in=d[inner],
                       d_out=d[outer], th_in=th[inner], th_out=th[outer], exit_land=exit_land,
                       groove_bottom=str(plate.get("groove_bottom") or "flat"))
    fg["profile"] = [*fg["profile"], (r_plate, 0.0)]
    reach_in, reach_out = ring_face_reach(
        contoured=contoured, r_in=r[inner], d_in=d[inner], th_in=th[inner],
        r_out=r[outer], d_out=d[outer], th_out=th[outer], exit_land=exit_land)
    d_avg = 0.5 * (d["O"] + d["F"])
    l_imp = fg["l_ax"]
    r_imp = fg["r_imp"]
    free = {inner: fg["free_jet_in"], outer: fg["free_jet_out"]}
    face = {
        "n": n,
        "n_F": n_F,
        "r_bore": r_bore,
        "r_O": r["O"], "r_F": r["F"],
        "d_pitch_O": d_pitch["O"], "d_pitch_F": d_pitch["F"],
        "dr": dr,
        "l_imp": l_imp,                                   # axial, exits -> impingement
        "l_over_d": l_imp / d_avg if d_avg > 0 else 0.0,  # what Layer 1's band means
        "free_jet_O": free["O"], "free_jet_F": free["F"],
        "free_jet_ld_O": free["O"] / d["O"] if d["O"] > 0 else 0.0,
        "free_jet_ld_F": free["F"] / d["F"] if d["F"] > 0 else 0.0,
        "free_jet_ld_avg": 0.5 * (free["O"] + free["F"]) / d_avg if d_avg > 0 else 0.0,
        "z_exit": fg["z_exit"],
        "z_imp": fg["z_imp"],                             # impingement height above the datum
        "included": th["O"] + th["F"],
        "web_O": s["O"] - d["O"],
        "web_F": s["F"] - d["F"],
        "ox_is_inner": ox_inner,
        "r_inner": r[inner], "r_outer": r[outer],
        "r_imp": r_imp,
        "centre_clear": 2.0 * reach_in,
        "wall_land": r_bore - reach_out,
        "core_frac": (r_imp / r_bore) ** 2 if r_bore > 0 else 0.0,
        "overflow": reach_out > r_bore,
        "degenerate": not (l_imp > 1e-6),
        "contoured": contoured,
        "plate_declared": plate_declared,
        "profile": fg["profile"],
        "groove": ({k: fg[k] for k in ("groove_edge_in", "groove_edge_out", "groove_depth",
                                        "groove_v_depth", "groove_v_r", "groove_is_v",
                                        "groove_short_of_land", "groove_width", "flank_included",
                                        "exit_depth")} if contoured else None),
        "exit_land": exit_land,
    }

    t = float(plate_thickness)
    land_ld = {"O": float(land_ld_O), "F": float(land_ld_O if land_ld_F is None else land_ld_F)}
    # One L/d per hole: discharge.<side>.orifice_l_over_d sets the Cd and, with channels, how far
    # the passage runs before it opens into its channel.
    passage_ld = dict(land_ld)
    ign = igniter_keepouts(igniter, plate_thickness=plate_thickness, min_web=min_web)
    r_hole = 0.5 * ign["thread_od"] if ign else 0.0

    def _channel(k: str, tt: float) -> Dict[str, Any]:
        return channel_for_ring(
            r_exit=r[k], z_exit=fg["z_exit"], d=d[k], theta_deg=th[k], is_inner=(k == inner),
            plate_thickness=tt, passage_ld=passage_ld[k],
            width=_f(plate.get(f"channel_width_{k}") or plate.get("channel_width"), 0.0) or None,
            floor=str(plate.get("channel_floor") or "flat"), exit_land=exit_land,
            spot_length=_f(plate.get("channel_spot_length"), 0.0) or None)

    passages: Dict[str, Dict[str, Any]] = {}
    chans: Dict[str, Dict[str, Any]] = {}
    for k in ("O", "F"):
        is_in = k == inner
        z_E = fg["z_exit"]
        src = ld_source_O if k == "O" else ld_source_F
        if channels:
            ch = _channel(k, t)
            h_flow = _f(plate.get(f"channel_flow_height_{k}"), 0.0)
            if h_flow and h_flow > 0:
                # The passage the manifold flow sees (channel + cover groove), as declared.
                ch["flow_height"] = h_flow
                ch["flow_area"] = ch["width"] * h_flow
            chans[k] = ch
            web_end = 2.0 * ch["r_center"] * math.sin(math.pi / (n if k == "O" else n_F)) - d[k]
            passages[k] = {
                "exit": ch["exit"], "end": ch["end"],
                "thru": ch["length"], "land": ch["length"], "land_ld": ch["l_over_d"],
                "bore": d[k], "bore_len": 0.0, "bore_ld": 0.0,
                "entry_off_square": 0.0 if contoured else th[k],
                "r_back": ch["r_center"], "entry_d": d[k],
                "back_inner_edge": ch["r_lo"], "back_outer_edge": ch["r_hi"],
                "back_web": web_end,
                "cd_l_over_d": ch["l_over_d"] if src == "plate" else land_ld[k],
                "cd_ld_source": src,
                "plate_l_over_d": ch["l_over_d"],
                "beta": None,
                "channel": ch,
            }
        else:
            c = _cos(th[k])
            thru = (t + z_E) / c if c > 1e-9 else float("inf")
            land = min(thru, land_ld[k] * d[k])
            bore = counterbore_dia if counterbore_dia > d[k] else d[k]
            bore_len = max(0.0, thru - land)
            be = passage_back_entry(
                r_face=r[k], d=d[k], theta_deg=th[k], plate_thickness=t,
                counterbore_dia=counterbore_dia, land_ld=land_ld[k], is_inner=is_in,
                n=n if k == "O" else n_F, exit_depth=-z_E)
            plate_ld = land / d[k] if bore > d[k] else thru / d[k]
            passages[k] = {
                "exit": (r[k], z_E), "end": (be.r_back, -t),
                "thru": thru, "land": land, "land_ld": land / d[k] if d[k] > 0 else 0.0,
                "bore": bore, "bore_len": bore_len, "bore_ld": bore_len / bore if bore > 0 else 0.0,
                "entry_off_square": 0.0 if contoured else th[k],
                "r_back": be.r_back, "entry_d": be.entry_d,
                "back_inner_edge": be.inner_edge, "back_outer_edge": be.outer_edge,
                "back_web": be.web,
                "cd_l_over_d": plate_ld if src == "plate" else land_ld[k],
                "cd_ld_source": src,
                "plate_l_over_d": plate_ld,
                "beta": (d[k] / bore) if (bore > d[k] and bore_len > 0) else None,
                "channel": None,
            }
    back: Dict[str, Any] = {
        "mode": "channels" if channels else "plenum",
        "o_f_land": passages[outer]["back_inner_edge"] - passages[inner]["back_outer_edge"],
        "inner_edge": passages[inner]["back_inner_edge"],
        "outer_edge": passages[outer]["back_outer_edge"],
    }
    if channels:
        back["lands"] = channel_lands(ch_in=chans[inner], ch_out=chans[outer],
                                      r_centre_hole=r_hole, r_plate=r_plate)

    warnings: List[Dict[str, str]] = []

    def warn(level: str, code: str, text: str) -> None:
        warnings.append({"level": level, "code": code, "text": text})

    mm = lambda v: f"{v * 1000:.2f}"  # noqa: E731

    # ---- envelope ---------------------------------------------------------------------------
    if env["sleeve_declared"] and abs(env["liner_gap"]) > 1e-4:
        warn("warn", "liner_gap",
             f"bore ⌀{mm(2 * r_bore)} + 2 × {mm(env['liner_thickness'])} liner = "
             f"⌀{mm(2 * (r_bore + env['liner_thickness']))}, but the sleeve bore is ⌀{mm(2 * r_plate)}")

    # ---- centre keep-out -------------------------------------------------------------------
    if center_clear_dia > 0:
        cc_req, cc_src = float(center_clear_dia), "layer1_injector_center_clear_dia_m"
    elif ign is not None:
        cc_req, cc_src = ign["face_keepout_dia"], f"igniter {ign['thread']}"
    else:
        cc_req, cc_src = 0.0, None

    # ---- face -------------------------------------------------------------------------------
    if face["overflow"]:
        warn("bad", "overflow", f"the {tag[outer]} ring reaches r {mm(reach_out)} mm on the face, past the "
                                f"{mm(r_bore)} mm bore — it would sit under the liner")
    if face["degenerate"]:
        warn("bad", "degenerate",
             "the two rings are on the same pitch circle — the jets meet at the face, not in front of it")
    if cc_req > 0 and face["centre_clear"] < cc_req:
        warn("bad", "centre_clear",
             f"centre clear ⌀{mm(face['centre_clear'])} < ⌀{mm(cc_req)} reserved ({cc_src})")
    if wall_clearance > 0 and face["wall_land"] < wall_clearance:
        warn("bad", "wall_land", f"land to the bore {mm(face['wall_land'])} mm < {mm(wall_clearance)} mm required")
    if min_web > 0 and min(face["web_O"], face["web_F"]) < min_web:
        warn("bad", "web", f"web between holes on a ring {mm(min(face['web_O'], face['web_F']))} mm "
                           f"< {mm(min_web)} mm required")
    if face["included"] > FACE_HEATING_INCLUDED_DEG:
        warn("warn", "included", f"included {face['included']:.0f}° > 90° — SP-8089's face-heating threshold")
    ld_tol = 1e-3 * max(1.0, ld_max)
    if not face["degenerate"] and (face["l_over_d"] < ld_min - ld_tol or face["l_over_d"] > ld_max + ld_tol):
        band = f"target {ld_min:g}" if ld_min == ld_max else f"{ld_min:g}–{ld_max:g} band"
        warn("warn", "standoff", f"axial standoff {face['l_over_d']:.2f} d̄ outside the {band}")
    if not face["degenerate"] and max(face["free_jet_ld_O"], face["free_jet_ld_F"]) > FREE_JET_MAX_D:
        warn("warn", "free_jet",
             f"free jet {face['free_jet_ld_O']:.1f} d (LOX) / {face['free_jet_ld_F']:.1f} d (fuel) along the "
             f"jet — SP-8089 keeps it under 5–7 d")
    if not face["degenerate"] and face["core_frac"] < CORE_FRAC_WARN:
        warn("warn", "core_frac",
             f"all {n} elements collide on a ⌀{mm(2 * r_imp)} circle — only {face['core_frac'] * 100:.0f}% "
             f"of the chamber area is fed directly")
    if contoured and not face["degenerate"]:
        if face["z_imp"] <= 0:
            warn("warn", "imp_in_groove",
                 f"the jets meet {mm(-face['z_imp'])} mm inside the groove — the reaction sits in the face")
        if fg["groove_short_of_land"]:
            warn("warn", "groove_land",
                 "the flanks meet before each exit has its land below it — the V is shallower than the holes need")
    elif not face["degenerate"]:
        worst = max(("O", "F"), key=lambda k: th[k])
        if th[worst] > DRILL_ENTRY_MAX_OFF_SQUARE_DEG:
            warn("info", "flat_entry",
                 f"flat face: the {tag[worst]} drill enters {th[worst]:.0f}° off square "
                 f"(drill makers allow {DRILL_ENTRY_MAX_OFF_SQUARE_DEG:.0f}°) — spot-face each hole, or contour the face")

    # ---- passages -----------------------------------------------------------------------------
    for k in ("O", "F"):
        p = passages[k]
        if p["land_ld"] > DRILL_LD_PRACTICE_MAX:
            warn("warn", f"drill_ld_{k}",
                 f"{tag[k]} orifice drilled {p['land'] * 1000:.1f} mm at ⌀{d[k] * 1000:.3f} — L/d {p['land_ld']:.1f}, "
                 f"past twist-drill practice")
        if p["land_ld"] < ORIFICE_LD_MIN - 1e-9:
            warn("warn", f"short_ld_{k}",
                 f"{tag[k]} orifice L/d {p['land_ld']:.1f} < 4 — SP-8089's minimum for a jet that leaves on axis")
        if p["bore_ld"] > DRILL_LD_PRACTICE_MAX:
            warn("warn", f"bore_ld_{k}",
                 f"{tag[k]} counterbore {p['bore_len'] * 1000:.1f} mm at ⌀{mm(p['bore'])} — L/d {p['bore_ld']:.1f}")
        if not channels and p["cd_ld_source"] != "plate" and abs(p["plate_l_over_d"] - p["cd_l_over_d"]) > 0.25:
            # Plenum back only: there the plate, not the typed number, decides the hole length.
            warn("warn", f"cd_ld_{k}",
                 f"{tag[k]} Cd uses the typed L/d {p['cd_l_over_d']:.1f}; this plate drills L/d "
                 f"{p['plate_l_over_d']:.1f} — set 'Cd L/d from' to the plug")

    if not plate_declared:
        warn("info", "plate_default",
             "injector.plate not declared: drawn as a contoured face with channels on the back. "
             "Layer 1 checks the groove and channels only once it is declared (Injector hardware, Apply)")
    if not plate_thickness_declared:
        warn("info", "plate_assumed",
             f"plate thickness not declared (layer1_injector_plate_thickness_m): {mm(t)} mm assumed")
    if channels:
        for k in ("O", "F"):
            ch = chans[k]
            n_k = n if k == "O" else n_F
            ch["orifice_area"] = n_k * math.pi * d[k] ** 2 / 4.0
            ch["area_ratio"] = ch["flow_area"] / ch["orifice_area"] if ch["orifice_area"] > 0 else 0.0
            if ch["area_ratio"] < 1.0 and not ch["pierces_back"]:
                warn("info", f"channel_area_{k}",
                     f"{tag[k]} channel cross-section {ch['flow_area'] * 1e6:.1f} mm² is {ch['area_ratio']:.2f}× the "
                     f"{ch['orifice_area'] * 1e6:.1f} mm² of orifices it feeds — the channel (and any groove in the "
                     f"cover) is the manifold; SP-8089: as large a cross-section as possible, confirm by cold flow")
            if ch["pierces_back"]:
                warn("bad", f"pierce_{k}",
                     f"{tag[k]} passage of L/d {passage_ld[k]:.1f} runs out through the back face of a "
                     f"{mm(t)} mm plate — it gives only L/d {ch['l_over_d']:.1f}")
            elif ch["floor"] == "flat":
                # SP-8089's L/d >= 4 is the AXIS length of a square-entry hole (checked above as
                # short_ld); the oblique breakthrough does not shorten it. What it changes is the
                # inlet: a lip of (90 - theta) on the acute side, which no Cd table here covers.
                warn("info", f"oblique_inlet_{k}",
                     f"{tag[k]} holes break into the flat channel floor {th[k]:.0f}° off square: the inlet lip "
                     f"on the acute side is {ch['entry_lip_deg']:.0f}°, not the 90° sharp edge the Cd (and "
                     f"the cavitation Cc) are for; its effect on Cd and on the jet direction is not modelled "
                     f"— cone the floor (channel_floor: coned) or cold-flow one element for its Cd")
        L = back["lands"]
        if L["between"] < 0:
            warn("bad", "channels_cross", "the LOX and fuel channels overlap on the back face")
        if L["inner"] < 0:
            warn("bad", "channel_port",
                 f"the {tag[inner]} channel reaches the centre port (r {mm(chans[inner]['r_lo'])} mm)")
        if L["outer"] < 0:
            warn("bad", "channel_edge",
                 f"the {tag[outer]} channel runs off the plate (r {mm(chans[outer]['r_hi'])} mm > {mm(r_plate)})")
    else:
        for k in ("O", "F") if not face["degenerate"] else ():
            p = passages[k]
            if p["back_inner_edge"] < 0.0:
                warn("bad", f"back_axis_{k}",
                     f"{tag[k]} passages cross the axis before reaching the back face — the plate is too "
                     f"thick for a {th[k]:.0f}° hole starting at r {mm(r[k])} mm")
            elif p["back_web"] < 0.0:
                warn("bad", f"back_overlap_{k}",
                     f"{tag[k]} passages run into each other at the back face — web {mm(p['back_web'])} mm")
            elif min_back_web > 0 and p["back_web"] < min_back_web:
                warn("bad", f"back_web_{k}",
                     f"{tag[k]} back-face web {mm(p['back_web'])} mm < {mm(min_back_web)} mm required")
        if not face["degenerate"] and back["o_f_land"] < 0.0:
            warn("bad", "back_cross", "LOX and fuel passages overlap at the back face")

    # ---- centre port and the igniter's back keep-out, on the back face -----------------------
    if not face["degenerate"]:
        inner_back = passages[inner]["back_inner_edge"]
        if r_hole > 0 and not channels and inner_back < r_hole:     # channels: see channel_port
            warn("bad", "back_port",
                 f"{tag[inner]} passages reach r {mm(inner_back)} mm on the back, inside the ⌀{mm(2 * r_hole)} "
                 f"centre port")
        if ign is not None and ign["back_keepout_dia"] > 0 and inner_back < 0.5 * ign["back_keepout_dia"] + ign["face_wall"]:
            warn("bad", "igniter_back",
                 f"{tag[inner]} passages reach r {mm(inner_back)} mm on the back, inside the igniter's "
                 f"⌀{mm(ign['back_keepout_dia'])} thick centre plus {mm(ign['face_wall'])} mm")

    # ---- igniter ------------------------------------------------------------------------------
    if ign is not None:
        if ign["engaged_thickness"] < ign["l2"]:
            warn("bad", "igniter_engagement",
                 f"{ign['thread']} needs {mm(ign['l2'])} mm of thread (ASME B1.20.1 L2); the plate is "
                 f"{mm(ign['engaged_thickness'])} mm at the port — raise 'Thickness at port' "
                 f"(injector.igniter.hub_thickness) or thicken the plate")
        if center_clear_dia > 0 and center_clear_dia > 1.2 * ign["face_keepout_dia"]:
            warn("info", "centre_reserve_oversized",
                 f"⌀{mm(center_clear_dia)} is reserved at the centre; the {ign['thread']} port needs "
                 f"⌀{mm(ign['face_keepout_dia'])} — unset layer1_injector_center_clear_dia_m to let the igniter set it")

    return {"face": face, "passages": passages, "back": back, "warnings": warnings,
            "igniter": ign, "centre_keepout": {"dia": cc_req, "source": cc_src},
            "envelope": env}


def flows_from_result(result: Mapping[str, Any], cfg: Any) -> Dict[str, float]:
    """The ``flows`` mapping :func:`layout_from_config` takes, from a
    ``PintleEngineRunner.evaluate`` result: per stream ``mdot``, injector ``dp`` and inlet
    pressure ``P_inj``, ``Cd``, density and vapour pressure (the config's fluids), plus ``Pc`` and
    the ambient pressure the solve used."""
    dg = result.get("diagnostics") or {}
    fl = _get(cfg, "fluids") or {}
    out: Dict[str, float] = {"Pc": _f(result.get("Pc")),
                             "P_amb": _f(result.get("P_ambient"), ATM) or ATM}
    for k, side in (("O", "oxidizer"), ("F", "fuel")):
        f = _get(fl, side)
        cd = result.get(f"Cd_{k}")
        out.update({
            f"mdot_{k}": _f(result.get(f"mdot_{k}")),
            f"dp_{k}": _f(dg.get(f"delta_p_injector_{k}")),
            f"P_inj_{k}": _f(dg.get(f"P_injector_{k}")),
            f"Cd_{k}": _f(cd if cd is not None else dg.get(f"Cd_{k}")),
            f"rho_{k}": _f(_get(f, "density")),
            f"Pv_{k}": _f(_get(f, "vapor_pressure")),
        })
    return out


def _check_manifold(cfg: Any, out: Dict[str, Any], flows: Mapping[str, Any]) -> None:
    """Channels back: each channel's velocity head at its feed port against the injector drop
    (channel_velocity_head), from a solve's ``mdot_O/F`` and ``dp_O/F`` (and ``rho_O/F``, else the
    config's fluids). Supersedes the bare area-ratio note. Over ``MANIFOLD_Q_FRAC`` it is 'bad':
    the holes by the port are not flowing what the solve assumed, so the solve is not the
    hardware."""
    inlets = int(_f(out["inputs"]["plate"].get("channel_inlets"), 1.0) or 1)
    fl = _get(cfg, "fluids") or {}
    for k, side in (("O", "oxidizer"), ("F", "fuel")):
        ch = out["passages"][k].get("channel")
        if ch is None or ch["pierces_back"]:
            continue
        rho = _f(flows.get(f"rho_{k}")) or _f(_get(_get(fl, side), "density"))
        m, dp = _f(flows.get(f"mdot_{k}")), _f(flows.get(f"dp_{k}"))
        if not (m > 0 and dp > 0 and rho > 0):
            continue
        h = channel_velocity_head(flow_area=ch["flow_area"], mdot=m, rho=rho, dp=dp, inlets=inlets)
        by_ports = {str(n): channel_velocity_head(flow_area=ch["flow_area"], mdot=m, rho=rho, dp=dp,
                                                  inlets=n)["area_needed"]
                    for n in sorted({inlets, 1, 2, 4})}
        ch.update(q_over_dp=h["q_over_dp"], area_needed=h["area_needed"], channel_v=h["v"],
                  channel_q=h["q"], injector_dp=dp, fed_end_flow=h["fed_end_flow"], inlets=h["inlets"],
                  area_needed_by_ports=by_ports)
        out["warnings"] = [w for w in out["warnings"] if w["code"] != f"channel_area_{k}"]
        if h["q_over_dp"] > h["q_frac"]:
            tag = "LOX" if k == "O" else "fuel"
            port = f"{inlets} feed port{'s' if inlets > 1 else ''}"
            order = [inlets] + [n for n in (1, 2, 4) if n != inlets]
            need = ", ".join(f"{by_ports[str(n)] * 1e6:.0f} mm² ({n} port{'s' if n > 1 else ''}"
                             f"{', as drawn' if n == inlets else ''})" for n in order)
            out["warnings"].append({
                "level": "bad", "code": f"manifold_q_{k}",
                "text": (f"{tag} channel velocity head at its {port}: q = {h['q'] / 1e3:.0f} kPa "
                         f"({h['v']:.1f} m/s each way) is {100 * h['q_over_dp']:.0f} % of the "
                         f"{dp / 1e3:.0f} kPa injector Δp (limit {100 * h['q_frac']:.0f} %). Holes by the "
                         f"port see the channel's static pressure, so they do not flow what the solve "
                         f"assumed. Channel is {ch['flow_area'] * 1e6:.1f} mm²; for q ≤ "
                         f"{100 * h['q_frac']:.0f} % of Δp it needs ≥ {need}")})


def _discharge_r_over_d(cfg: Any, side: str) -> float:
    """Inlet r/d a discharge block describes (dict or model), via engine.core.discharge."""
    from types import SimpleNamespace
    from engine.core.discharge import inlet_radius_ratio_of
    dc = _get(_get(cfg, "discharge"), side)
    if dc is None:
        return 0.0
    ns = SimpleNamespace(**dc) if isinstance(dc, Mapping) else dc
    return float(inlet_radius_ratio_of(ns))


def _check_cavitation(cfg: Any, out: Dict[str, Any], flows: Mapping[str, Any]) -> None:
    """Each orifice's cavitation number against Nurick's (1976) critical value:
    ``K = (P_inj - P_v) / (P_inj - Pc)`` vs ``K_crit = (Cd / Cc)^2``, with Cc from the inlet's r/d
    (engine.core.discharge.cavitation_margin). K below K_crit: the vena contracta reaches vapour
    pressure and the Cd (and momentum ratio) the solve used do not hold."""
    from engine.core.discharge import cavitation_margin
    fl = _get(cfg, "fluids") or {}
    Pc = _f(flows.get("Pc"))
    for k, side in (("O", "oxidizer"), ("F", "fuel")):
        p = out["passages"][k]
        P_in, cd = _f(flows.get(f"P_inj_{k}")), _f(flows.get(f"Cd_{k}"))
        pv = flows.get(f"Pv_{k}")
        pv = _f(pv) if pv is not None else _f(_get(_get(fl, side), "vapor_pressure"), float("nan"))
        if not (Pc > 0 and P_in > Pc and cd > 0 and math.isfinite(pv)):
            continue
        rd = _discharge_r_over_d(cfg, side)
        m = cavitation_margin(P_in=P_in, Pc=Pc, Pv=pv, Cd=cd, r_over_d=rd)
        p["cavitation"] = {**m, "Cd": cd, "r_over_d": rd, "P_inj": P_in, "Pc": Pc}
        tag = "LOX" if k == "O" else "fuel"
        ch = p.get("channel")
        lip = (f"; Cc is the square edge's, and this inlet's lip is {ch['entry_lip_deg']:.0f}°"
               if ch is not None and ch["floor"] == "flat" else "")
        body = (f"K = (P_inj − P_v)/(P_inj − Pc) = {m['K']:.2f} vs K_crit = (Cd/Cc)² = {m['K_crit']:.2f} "
                f"(Cd {cd:.3f}, Cc {m['Cc']:.2f} at r/d {rd:g}; Nurick 1976){lip}")
        if m["margin"] < 1.0:
            out["warnings"].append({"level": "bad", "code": f"cavitation_{k}",
                                    "text": f"{tag} orifices cavitate: {body} — the solve's Cd does not hold"})
        else:
            out["warnings"].append({"level": "info", "code": f"cavitation_{k}",
                                    "text": f"{tag} orifices clear of cavitation, margin {m['margin']:.2f}: {body}"})


# =============================================================================================
# Plate bending
# =============================================================================================

def plate_bending_moments(
    r: Any, *, a: float, b: float, p: float, nu: float, support: str = "simply_supported",
    r_hole: float = 0.0,
) -> Tuple[Any, Any]:
    """Radial and tangential bending moments ``(M_r, M_t)`` [N m / m] at radius r (scalar or
    array) in a circular plate of radius a under a uniform pressure p over r <= b (Timoshenko &
    Woinowsky-Krieger §19; Roark Table 11.2). ``support``: ``simply_supported`` or ``clamped``
    at r = a.

    Positive sags toward the load. With ``r_hole`` > 0 the plate has a centre hole whose plug
    (the igniter) carries its share of p into the hole edge as shear, with no moment there
    (M_r(r_hole) = 0); r_hole = 0 is the solid plate. Solved exactly: slope
    phi = p r^3/(16 D) + A r + C/r inside b and (p b^2/(4 D)) r (ln(r/a) - 1/2) + B r + E/r
    outside, continuous in phi and phi' at b, with the edge condition at a. D = 1 throughout:
    the moments do not depend on it.
    """
    import numpy as np
    b = min(float(b), float(a))
    q = p * b * b / 4.0

    # phi and phi' at x: (coefficients on [A, C, B, E], particular part)
    def ph_i(x: float) -> Tuple[Any, float]:
        return np.array([x, 1.0 / x, 0.0, 0.0]), p * x ** 3 / 16.0

    def dph_i(x: float) -> Tuple[Any, float]:
        return np.array([1.0, -1.0 / x ** 2, 0.0, 0.0]), 3.0 * p * x ** 2 / 16.0

    def ph_o(x: float) -> Tuple[Any, float]:
        return np.array([0.0, 0.0, x, 1.0 / x]), q * x * (math.log(x / a) - 0.5)

    def dph_o(x: float) -> Tuple[Any, float]:
        return np.array([0.0, 0.0, 1.0, -1.0 / x ** 2]), q * (math.log(x / a) + 0.5)

    rows: List[Any] = []
    rhs: List[float] = []

    def eq(*terms: Tuple[float, Tuple[Any, float]]) -> None:
        c, v = np.zeros(4), 0.0
        for k, (cc, vv) in terms:
            c, v = c + k * cc, v + k * vv
        rows.append(c)
        rhs.append(-v)

    if r_hole > 0:
        eq((1.0, dph_i(r_hole)), (nu / r_hole, ph_i(r_hole)))     # M_r(r_hole) = 0
    else:
        eq((1.0, (np.array([0.0, 1.0, 0.0, 0.0]), 0.0)))          # C = 0: finite at the centre
    eq((1.0, ph_i(b)), (-1.0, ph_o(b)))
    eq((1.0, dph_i(b)), (-1.0, dph_o(b)))
    if support == "clamped":
        eq((1.0, ph_o(a)))                                          # no slope at the edge
    else:
        eq((1.0, dph_o(a)), (nu / a, ph_o(a)))                      # no moment at the edge
    A, C, B, E = np.linalg.solve(np.array(rows), np.array(rhs))
    rr = np.maximum(np.asarray(r, dtype=float), 1e-12)
    inner = rr <= b
    L = np.log(rr / a)
    phi = np.where(inner, p * rr ** 3 / 16.0 + A * rr + C / rr, q * rr * (L - 0.5) + B * rr + E / rr)
    dphi = np.where(inner, 3.0 * p * rr ** 2 / 16.0 + A - C / rr ** 2, q * (L + 0.5) + B - E / rr ** 2)
    Mr, Mt = -(dphi + nu * phi / rr), -(phi / rr + nu * dphi)
    if np.ndim(r) == 0:
        return float(Mr), float(Mt)
    return Mr, Mt


def _check_plate(cfg: Any, out: Dict[str, Any], flows: Optional[Mapping[str, Any]]) -> None:
    """Bending of the plug under chamber pressure: a circular plate of the plug's radius, Pc
    (gauge) over the gas bore, edge support as declared (``injector.plate.support``). Moments
    from the solid-plate solution (with the igniter port as a centre hole), divided at every
    radius by the section left there (face groove above, channel floor below): the full radial
    moment crosses the ligament, ``sigma_r = 6 M_r / t_n^2``, and the hoop stress follows the
    curvature the full plate imposes. Stress is Tresca at the surface. Keeping the solid plate's
    M_r across a thinned ring is conservative; it is an estimate, not an FEA. Not in this load
    case: manifold pressure in the channels and the cover's bolt loads (the designer's)."""
    import numpy as np
    inp = out["inputs"]
    plate = inp.get("plate") or {}
    env = out["envelope"]
    a, b = float(env["r_sleeve_id"]), float(env["r_bore"])
    t = float(inp["plate_thickness"])
    req = _req_dict(cfg)
    if flows is not None and _f(flows.get("Pc")) > 0:
        P_amb = _f(flows.get("P_amb"), ATM) or ATM
        p, src = _f(flows.get("Pc")) - P_amb, "solved Pc"
    elif _f(req.get("target_chamber_pressure_psi")) > 0:
        p, src = _f(req.get("target_chamber_pressure_psi")) * PSI - ATM, "target_chamber_pressure_psi, 1 atm outside"
    else:
        p, src = 0.0, None
    if not (p > 0 and a > 0 and b > 0 and t > 0):
        out["plate_bending"] = None
        out["warnings"].append({"level": "info", "code": "plate_bending",
                                "text": "plate bending not checked: no chamber pressure (solve, or "
                                        "target_chamber_pressure_psi)"})
        return
    support = str(plate.get("support") or "simply_supported")
    nu_decl = plate.get("poisson_ratio")
    nu = float(nu_decl) if nu_decl is not None else PLATE_POISSON_DEFAULT
    ys = _f(plate.get("yield_strength")) or None
    ign = out.get("igniter")
    r_hole = 0.5 * ign["thread_od"] if ign else 0.0
    prof = out["face"]["profile"]
    chans = {k: out["passages"][k].get("channel") for k in ("O", "F")}

    r0 = max(r_hole, 1e-6)
    parts_r = [np.linspace(r0, a, 801)]
    for ch in chans.values():
        if ch is not None:
            parts_r.append(np.linspace(max(r0, ch["r_lo"]), min(a, ch["r_hi"]), 41))
    R = np.unique(np.concatenate(parts_r))
    # Section left at each radius: face surface (groove) down to the channel floor, else the back
    # face. A thicker port hub is not credited: the moments are the uniform-t plate's.
    face = np.interp(R, [x for x, _ in prof], [z for _, z in prof])
    back = np.full_like(R, -t)
    in_ch = {}
    for k, ch in chans.items():
        if ch is None:
            continue
        m = (R >= ch["r_lo"] - 1e-12) & (R <= ch["r_hi"] + 1e-12)
        in_ch[k] = m
        back = np.where(m, np.maximum(-t, ch["end"][1] + ch["floor_slope"] * (R - ch["r_center"])), back)
    tn = np.minimum(t, face - back)
    if out.get("profile"):
        # The section as built (or drawn): groove, channels, back grooves and gland come off it.
        from engine.core.injectors.plate_dxf import loop_section
        # At a wall the section steps: take the thinner side (the corner the ligament starts at).
        L = out["profile"]["loop"]
        tn = np.minimum(t, np.minimum.reduce([loop_section(L, R - 1e-9), loop_section(L, R),
                                               loop_section(L, R + 1e-9)]))
    Mr, Mt = plate_bending_moments(R, a=a, b=b, p=p, nu=nu, support=support, r_hole=r_hole)
    ok = tn > 1e-9                     # no metal: a channel through the plate is flagged (pierce_*)
    tq = np.where(ok, tn, 1.0)
    # Radial: the moment crosses the thinned ring, so the ligament carries all of it.
    sr = 6.0 * Mr / tq ** 2
    # Hoop: the surrounding full plate imposes the hoop curvature kappa_t = (M_t - nu M_r) /
    # (D (1 - nu^2)); on a ligament of t_n that is sigma_t = nu sigma_r + 6 (M_t - nu M_r) t_n / t^3
    # (E cancels). At t_n = t it is 6 M_t / t^2.
    st = nu * sr + 6.0 * (Mt - nu * Mr) * tq / t ** 3
    sig = np.where(ok, np.maximum.reduce([np.abs(sr), np.abs(st), np.abs(sr - st)]), -1.0)  # Tresca

    def at(i: int) -> Dict[str, float]:
        return {"r": float(R[i]), "t_net": float(tn[i]), "M_r": float(Mr[i]), "M_t": float(Mt[i]),
                "sigma": float(sig[i]), "sigma_r": float(sr[i]), "sigma_t": float(st[i])}

    worst = at(int(np.argmax(sig)))
    per_ch: Dict[str, Any] = {}
    for k, m in in_ch.items():
        if (m & ok).any():
            per_ch[k] = at(int(np.argmax(np.where(m, sig, -1.0))))
    solid = at(int(np.argmax(ok)))       # the innermost radius with metal: port edge, or centre

    def where(r: float) -> str:
        for k, ch in chans.items():
            if ch is not None and ch["r_lo"] <= r <= ch["r_hi"]:
                return f"{'LOX' if k == 'O' else 'fuel'} channel root"
        if r_hole > 0 and r <= r_hole + 1e-9:
            return "igniter port edge"
        if face_z_at(prof, r) < 0:
            return "face groove"
        return "full section"

    allow = ys / PLATE_YIELD_FACTOR if ys else None
    out["plate_bending"] = {
        "p_gauge": p, "p_source": src, "support": support, "poisson_ratio": nu,
        "poisson_assumed": nu_decl is None, "r_plate": a, "r_loaded": b, "r_hole": r_hole,
        "thickness": t, "channels": per_ch, "centre": solid, "max": {**worst, "where": where(worst["r"])},
        "yield_strength": ys, "yield_factor": PLATE_YIELD_FACTOR, "allowable": allow,
    }
    MPa = lambda v: f"{v / 1e6:.0f}"  # noqa: E731
    parts = [f"{'LOX' if k == 'O' else 'fuel'} channel ligament {d['t_net'] * 1000:.2f} mm at r "
             f"{d['r'] * 1000:.1f}: {MPa(d['sigma'])} MPa" for k, d in per_ch.items()]
    parts.append(f"{'port edge' if r_hole > 0 else 'centre'} {MPa(solid['sigma'])} MPa")
    head = (f"plate bending under Pc {p / 1e6:.2f} MPa gauge ({src}) over ⌀{2 * b * 1000:.1f}, "
            f"⌀{2 * a * 1000:.1f} plug {support.replace('_', ' ')}, ν {nu:g}"
            f"{' assumed' if nu_decl is None else ''}, Tresca: "
            + "; ".join(parts)
            + f"; max {MPa(worst['sigma'])} MPa at r {worst['r'] * 1000:.1f} mm ({where(worst['r'])})")
    tail = " (manifold pressure in the channels and cover/bolt loads not included)"
    if allow is None:
        out["warnings"].append({"level": "info", "code": "plate_bending",
                                "text": head + " — material undeclared (injector.plate.yield_strength): "
                                               "stress only" + tail})
    elif worst["sigma"] > allow:
        out["warnings"].append({"level": "bad", "code": "plate_bending",
                                "text": head + f" > yield {MPa(ys)} MPa / {PLATE_YIELD_FACTOR:g} = "
                                               f"{MPa(allow)} MPa — thicken the plate or shallow the channels" + tail})
    else:
        out["warnings"].append({"level": "info", "code": "plate_bending",
                                "text": head + f" ≤ yield {MPa(ys)} MPa / {PLATE_YIELD_FACTOR:g} = "
                                               f"{MPa(allow)} MPa" + tail})


# =============================================================================================
# The plate as drawn
# =============================================================================================

#: How far the config's ring radius may sit from the drawing's exit before the layout says the
#: two describe different plates [m] (a CAD dimension rounded to 0.001 in is 0.0254 mm).
DRAWING_RING_TOL = 0.05e-3

#: Same, for a passage's L/d (config vs drawn length / d) [fraction].
DRAWING_LD_TOL = 0.02

#: Check mode: how far the model's half-section may sit from the drawing's anywhere [m]. A
#: sketch dimensioned to 0.0001 in lands within ~0.003 mm; 0.025 mm (0.001 in) is a tolerance
#: no machinist would hold the revolve to, and far below any feature here.
DRAWING_PROFILE_TOL = 0.025e-3


def _drawing(plate: Mapping[str, Any]) -> Dict[str, Any]:
    from engine.core.injectors.plate_dxf import load_plate_profile
    return load_plate_profile(str(plate["profile_dxf"]))


def _apply_drawing(cfg: Any, out: Dict[str, Any]) -> None:
    """Replace the layout's drawn geometry with the plate's revolve sketch
    (``injector.plate.profile_dxf``): face groove, passages (exit, length, entry), channel
    sections. What the config says that the drawing contradicts -- ring radius, L/d, plug
    radius, a centre port -- is flagged ``bad``; the drawing is what gets machined."""
    from engine.core.injectors.plate_dxf import drilled_passages, loop_deviation
    inp = out["inputs"]
    plate = inp.get("plate") or {}
    if not plate.get("profile_dxf"):
        return
    prof = _drawing(plate)
    st = {"O": inp["oxidizer"], "F": inp["fuel"]}
    th = {k: float(st[k]["impingement_angle"]) for k in st}
    d = {k: float(st[k]["d_jet"]) for k in st}
    holes = drilled_passages(prof, th)
    tag = {"O": "LOX", "F": "fuel"}
    src = str(plate["profile_dxf"])
    warn = out["warnings"]
    mm = lambda v: f"{v * 1000:.3f}"  # noqa: E731
    t = float(prof["thickness"])
    fl = prof["_face_line"]
    drawn_loop = [(r, -abs(z - fl)) for r, z in prof["loop"]]
    summary = {
        "source": src, "mode": str(plate.get("profile_dxf_mode") or "geometry"), "thickness": t,
        "plate_radius": prof["plate_radius"], "axis_hole": prof["axis_hole"],
        "face_groove": {k: v for k, v in (prof["face_groove"] or {}).items() if k != "flanks"},
        "channels": [{k: v for k, v in c.items() if not k.startswith("_") and k != "floor"}
                     for c in prof["channels"]],
        "passages": {k: {kk: vv for kk, vv in v.items() if kk not in ("flank", "facet")}
                     for k, v in holes.items()},
        "seal_grooves_back": prof["seal_grooves_back"],
    }

    if summary["mode"] == "check":
        # The plate is the model's; the drawing is what it is held to.
        out["drawing"] = summary
        if out.get("igniter") and not prof["axis_hole"]:
            warn.append({"level": "warn", "code": "drawing_igniter",
                         "text": f"the drawing has no centre port; the {out['igniter']['thread']} igniter is "
                                 f"the config's (compared without it)"})
        if abs(t - float(inp["plate_thickness"])) > DRAWING_RING_TOL:
            warn.append({"level": "bad", "code": "drawing_thickness",
                         "text": f"plate {mm(inp['plate_thickness'])} mm in the config, {mm(t)} mm in the drawing"})
        for k in ("O", "F"):
            h, p = holes.get(k), out["passages"][k]
            if h is None:
                warn.append({"level": "bad", "code": f"drawing_passage_{k}",
                             "text": f"{tag[k]}: the drawing has no channel facet and flank at {th[k]:g}°"})
                continue
            de = math.hypot(h["exit_r"] - p["exit"][0], h["exit_depth"] + p["exit"][1])
            dl = h["length"] - float(p["thru"])
            summary["passages"][k].update(model_exit=p["exit"], model_length=p["thru"],
                                          exit_offset=de, length_offset=dl)
            if de > DRAWING_RING_TOL or abs(dl) > DRAWING_RING_TOL:
                warn.append({"level": "bad", "code": f"drawing_passage_{k}",
                             "text": f"{tag[k]} passage: exit {mm(de)} mm and length {mm(dl)} mm off the drawing "
                                     f"(drawn exit r {mm(h['exit_r'])}, length {mm(h['length'])})"})
        if out.get("profile"):
            bare = plate_profile(out, plate, with_port=False)["loop"]
            dev = loop_deviation(bare, drawn_loop)
            summary["deviation"] = dev
            ok = dev["max"] <= DRAWING_PROFILE_TOL
            warn.append({"level": "info" if ok else "bad", "code": "drawing_profile",
                         "text": (f"the model's section matches the drawing to {mm(dev['max'])} mm"
                                  if ok else
                                  f"the model's section is {mm(dev['max'])} mm off the drawing (model at r "
                                  f"{mm(dev['where_a'][0])}, z {mm(dev['where_a'][1])}; drawing at r "
                                  f"{mm(dev['where_b'][0])}, z {mm(dev['where_b'][1])})")})
        return

    # Face: the groove as drawn.
    face = out["face"]
    g = prof.get("_face_groove_pts")
    if g:
        fl = prof["_face_line"]
        pts = [(r, -abs(z - fl)) for r, z in g]
        if pts[0][0] > pts[-1][0]:
            pts = pts[::-1]
        face["profile"] = [(0.0, 0.0), *pts, (float(out["envelope"]["r_sleeve_id"]), 0.0)]
        fg = prof["face_groove"]
        if face.get("groove") is not None:
            face["groove"].update(groove_edge_in=fg["r_lo"], groove_edge_out=fg["r_hi"],
                                  groove_depth=fg["depth"], groove_width=fg["r_hi"] - fg["r_lo"])

    if abs(prof["plate_radius"] - float(out["envelope"]["r_sleeve_id"])) > DRAWING_RING_TOL:
        warn.append({"level": "bad", "code": "drawing_plug_radius",
                     "text": f"the drawing's plug is r {mm(prof['plate_radius'])} mm; the sleeve bore "
                             f"the config gives is r {mm(out['envelope']['r_sleeve_id'])} mm"})
    if out.get("igniter") and not prof["axis_hole"]:
        warn.append({"level": "warn", "code": "drawing_igniter",
                     "text": f"the config declares a centre igniter ({out['igniter'].get('thread')}); "
                             f"the drawing has no hole on the axis — the section is the drawing's"})
    out["profile"] = {**(out.get("profile") or {"grooves": [], "skipped": [], "back_lands": []}),
                      "loop": drawn_loop, "thickness": t, "with_port": prof["axis_hole"]}

    for k in ("O", "F"):
        p = out["passages"][k]
        h = holes.get(k)
        if h is None:
            warn.append({"level": "bad", "code": f"drawing_passage_{k}",
                         "text": f"{tag[k]}: the drawing has no channel facet and face-groove flank "
                                 f"at {th[k]:g}° to locate the passage between; the model's passage is kept"})
            continue
        ch_d = prof["channels"][h["channel"]]
        r_cfg = float(face[f"r_{k}"])
        if abs(h["exit_r"] - r_cfg) > DRAWING_RING_TOL:
            warn.append({"level": "bad", "code": f"drawing_ring_{k}",
                         "text": f"{tag[k]} exits are on r {mm(h['exit_r'])} mm in the drawing and r "
                                 f"{mm(r_cfg)} mm in the config (spacing "
                                 f"{2 * math.pi * h['exit_r'] / max(1, face['n']) * 1000:.4f} mm matches the drawing)"})
        ld = h["length"] / d[k]
        ld_cfg = float(p.get("plate_l_over_d") or p.get("land_ld") or 0.0)
        z_exit, z_end = -h["exit_depth"], -h["entry_depth"]
        land = min(h["flank_slant"]) - 0.5 * d[k]
        p.update(exit=(h["exit_r"], z_exit), end=(h["entry_r"], z_end), thru=h["length"],
                 land=h["length"], land_ld=ld, plate_l_over_d=ld, cd_l_over_d=ld,
                 entry_off_square=h["entry_off_square_deg"], r_back=h["entry_r"],
                 exit_flank_land=land, source="drawing")
        if abs(ld - ld_cfg) > DRAWING_LD_TOL * ld:
            ds = (_get(_get(_get(cfg, "discharge"), "oxidizer" if k == "O" else "fuel"), "l_over_d_source")
                  or "declared")
            if str(ds) != "plate":
                warn.append({"level": "bad", "code": f"drawing_ld_{k}",
                             "text": f"{tag[k]} passage is {mm(h['length'])} mm = {ld:.2f} d in the drawing; "
                                     f"the Cd is taken at L/d {ld_cfg:.2f} — set discharge."
                                     f"{'oxidizer' if k == 'O' else 'fuel'}.l_over_d_source: plate"})
        if land < 0:
            warn.append({"level": "bad", "code": f"drawing_exit_land_{k}",
                         "text": f"{tag[k]} exit ({mm(d[k])} mm) is wider than its flank allows: "
                                 f"{mm(land)} mm land"})
        ch = p.get("channel")
        if ch is not None:
            A = float(ch_d["flow_area"])
            ch.update(r_lo=ch_d["r_lo"], r_hi=ch_d["r_hi"], r_center=ch_d["r_centroid"],
                      width=ch_d["width"], depth=ch_d["depth"], flow_area=A,
                      hydraulic_diameter=ch_d["hydraulic_diameter"], exit=(h["exit_r"], z_exit),
                      end=(h["entry_r"], z_end), length=h["length"], length_wanted=h["length"],
                      l_over_d=ld, pierces_back=False, floor="drawing", floor_slope=0.0,
                      floor_z_lo=-(t - ch_d["depth"]), floor_z_hi=-(t - ch_d["depth"]),
                      ligament_min=ch_d["ligament_min"],
                      breakthrough=("square" if h["entry_off_square_deg"] < 1.0
                                    else f"{h['entry_off_square_deg']:.0f} deg off square"),
                      entry_lip_deg=90.0 - h["entry_off_square_deg"],
                      area_ratio=A / (face["n"] * math.pi * d[k] ** 2 / 4.0), source="drawing")
            ch.pop("flow_height", None)
        # The model's own checks of this passage and channel are about geometry now replaced.
        stale = {f"oblique_inlet_{k}", f"channel_area_{k}", f"short_ld_{k}", f"drill_ld_{k}", "groove_land"}
        out["warnings"] = warn = [w for w in warn if w.get("code") not in stale]
        if h["entry_off_square_deg"] >= 1.0:
            warn.append({"level": "info", "code": f"oblique_inlet_{k}",
                         "text": f"{tag[k]} passage enters its drawn channel facet "
                                 f"{h['entry_off_square_deg']:.1f}° off square"})
        if ld < ORIFICE_LD_MIN:
            warn.append({"level": "warn", "code": f"short_ld_{k}",
                         "text": f"{tag[k]} orifice L/d {ld:.1f} < 4 — SP-8089's minimum for a jet that "
                                 f"leaves on axis"})
        if ch is not None and ch["area_ratio"] < 1.0:
            warn.append({"level": "info", "code": f"channel_area_{k}",
                         "text": f"{tag[k]} channel cross-section {ch['flow_area'] * 1e6:.1f} mm² (drawn) is "
                                 f"{ch['area_ratio']:.2f}× the orifice area it feeds"})

    out["drawing"] = summary


def layout_from_config(
    cfg: Any, drawings: bool = True, flows: Optional[Mapping[str, Any]] = None, *, checks: bool = True,
) -> Optional[Dict[str, Any]]:
    """``compute_layout`` on an engine config, plus its drawing primitives
    (``engine.core.injectors.drawing``); None when it is not an impinging doublet. ``flows``
    (a solve, see :func:`flows_from_result`) adds the manifold velocity-head and orifice
    cavitation checks and puts the solved Pc on the plate-bending check (else the target Pc).

    ``checks=False`` is the geometry alone -- passages and channels, a drawing in geometry mode
    applied -- for the flow solve, which needs the channel sections many times per operating point:
    the plate-bending check and the drawing comparison cost ~0.1 s each and were 80 % of a solve."""
    inputs = layout_inputs_from_config(cfg)
    if inputs is None:
        return None
    out = compute_layout(**inputs)
    out["inputs"] = inputs
    plate = inputs.get("plate") or {}
    if not checks:
        if (plate.get("profile_dxf") and str(plate.get("profile_dxf_mode") or "geometry") == "geometry"):
            _apply_drawing(cfg, out)
        return out
    if out["back"]["mode"] == "channels" or plate.get("rim_gland") or plate.get("back_grooves"):
        out["profile"] = plate_profile(out, plate)
        out["ports"] = feed_ports(out, plate)
    _apply_drawing(cfg, out)
    _check_back_features(out)
    _report_cd(cfg, out)
    _check_inlet_fit(out)
    if flows is not None:
        _check_manifold(cfg, out, flows)
        _check_cavitation(cfg, out, flows)
    _check_plate(cfg, out, flows)
    if drawings:
        from engine.core.injectors.drawing import injector_drawings
        out["drawings"] = injector_drawings(out)
    return out
