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

PSI = 6894.757


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
    exit_land: float = EXIT_LAND_DEFAULT,
) -> Dict[str, Any]:
    """Channels back: the passage from its exit to the channel floor, and the channel around it.

    The passage is a straight hole of diameter d along the jet axis, ``passage_ld * d`` long,
    running from the exit into the plate: toward the axis for the inner ring, away for the outer.
    It ends at ``Q``. The channel floor passes through ``Q`` -- flat (axis-normal), or ``coned``
    (normal to the passage, so the hole breaks through square) -- and the channel is centred on
    ``Q``'s radius. That centring is the alignment: the hole's whole footprint lands on the floor
    with ``exit_land`` to each wall.

    If the passage would come out through the back face before reaching that length, it is
    clipped there (``pierces_back``): the channel depth is then zero and the realised L/d short.
    """
    t = float(plate_thickness)
    s, c = _sin(theta_deg), _cos(theta_deg)
    k = -1.0 if is_inner else 1.0                  # radial direction travelled going in
    lam_want = float(passage_ld) * d
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
        # On a flat floor the hole is cut obliquely: its short wall is (d/2) tan(theta) shorter.
        "short_wall_l_over_d": (lam / d - 0.5 * _tan(theta_deg)) if (floor != "coned" and d > 0) else lam / d if d > 0 else 0.0,
        # Cross-section of the channel itself (the cover may add more).
        "flow_area": w * (t + min(floor_z(lo), floor_z(hi))) if w > 0 else 0.0,
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
        "fed_end_flow": math.sqrt(max(0.0, 1.0 - q / dp)),
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
    lay = layout_from_config(engine_config, drawings=False)
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
        "plate_thickness": _opt_float(req, "layer1_injector_plate_thickness_m") or PLATE_THICKNESS_DEFAULT,
        "plate_thickness_declared": bool(_opt_float(req, "layer1_injector_plate_thickness_m")),
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
            floor=str(plate.get("channel_floor") or "flat"), exit_land=exit_land)

    passages: Dict[str, Dict[str, Any]] = {}
    chans: Dict[str, Dict[str, Any]] = {}
    for k in ("O", "F"):
        is_in = k == inner
        z_E = fg["z_exit"]
        src = ld_source_O if k == "O" else ld_source_F
        if channels:
            ch = _channel(k, t)
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
            if ch["floor"] == "flat" and ch["short_wall_l_over_d"] < ORIFICE_LD_MIN - 1e-9 and not ch["pierces_back"]:
                warn("warn", f"short_wall_{k}",
                     f"{tag[k]} holes break into a flat floor obliquely: the short wall is L/d "
                     f"{ch['short_wall_l_over_d']:.1f}, under SP-8089's 4 — raise the hole L/d or cone the floor")
            if ch["pierces_back"]:
                warn("bad", f"pierce_{k}",
                     f"{tag[k]} passage of L/d {passage_ld[k]:.1f} runs out through the back face of a "
                     f"{mm(t)} mm plate — it gives only L/d {ch['l_over_d']:.1f}")
            if ch["floor"] == "flat" and ch["short_wall_l_over_d"] >= ORIFICE_LD_MIN - 1e-9:
                warn("info", f"oblique_inlet_{k}",
                     f"{tag[k]} holes break into a flat channel floor {th[k]:.0f}° off square; that end is the "
                     f"orifice inlet — deburr and flow-test, or cone the floor")
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


def _check_manifold(cfg: Any, out: Dict[str, Any], flows: Mapping[str, Any]) -> None:
    """Channels back: each channel's velocity head at its feed port against the injector drop
    (channel_velocity_head), from a solve's ``mdot_O/F`` and ``dp_O/F`` (and ``rho_O/F``, else the
    config's fluids). Supersedes the bare area-ratio note."""
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
        ch.update(q_over_dp=h["q_over_dp"], area_needed=h["area_needed"], channel_v=h["v"],
                  fed_end_flow=h["fed_end_flow"], inlets=h["inlets"])
        out["warnings"] = [w for w in out["warnings"] if w["code"] != f"channel_area_{k}"]
        if h["q_over_dp"] > h["q_frac"]:
            tag = "LOX" if k == "O" else "fuel"
            port = f"{inlets} feed port{'s' if inlets > 1 else ''}"
            out["warnings"].append({
                "level": "warn", "code": f"manifold_q_{k}",
                "text": (f"{tag} channel velocity head is {100 * h['q_over_dp']:.0f} % of the injector Δp at "
                         f"its {port} ({h['v']:.1f} m/s each way): the holes there see "
                         f"{100 * h['fed_end_flow']:.0f} % of design flow — make the channel ≥ "
                         f"{h['area_needed'] * 1e6:.0f} mm² (now {ch['flow_area'] * 1e6:.1f} mm²) for "
                         f"{100 * h['q_frac']:.0f} %, or add feed ports")})


def layout_from_config(
    cfg: Any, drawings: bool = True, flows: Optional[Mapping[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """``compute_layout`` on an engine config, plus its drawing primitives
    (``engine.core.injectors.drawing``); None when it is not an impinging doublet. ``flows``
    (a solve's ``mdot_O/F``, ``dp_O/F``) adds the manifold velocity-head check."""
    inputs = layout_inputs_from_config(cfg)
    if inputs is None:
        return None
    out = compute_layout(**inputs)
    out["inputs"] = inputs
    _report_cd(cfg, out)
    _check_inlet_fit(out)
    if flows is not None:
        _check_manifold(cfg, out, flows)
    if drawings:
        from engine.core.injectors.drawing import injector_drawings
        out["drawings"] = injector_drawings(out)
    return out
