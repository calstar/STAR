"""Static stability at angle of attack: the body lift that linear Barrowman leaves out.

The static margin is a slope at zero angle of attack. Barrowman gives a straight tube
no normal force there, and at small angles that holds. At an angle, though, the tube
sits in a crossflow of speed V sin(a) and is pushed sideways like a cylinder in a wind.
That force grows as sin^2(a), acts at the centroid of the body's side (planform) area,
and on a long rocket that centroid is well ahead of the CG. Fin lift only grows as a.
So past some angle the body's push overtakes the fins and the CP crosses the CG: the
**critical angle of attack**. Below it the rocket rights itself; above it the push
runs away.

Balancing the two moments about the CG (small angles, fins below stall):

    CNa * SM * d * a  =  K * (A_side / A_ref) * (x_cg - x_side) * a^2

    sin(a_crit) ~ CNa * SM * d / [K * (A_side / A_ref) * (x_cg - x_side)]

Dynamic pressure cancels, so a_crit is a property of the shape and the CG alone. Speed
only sets how large an angle a crosswind w gives at rail exit, atan(w / V). A rocket
leaving the rail slowly in wind past a_crit goes sideways at once, whatever its
zero-angle margin and damping ratio say.

The model is OpenRocket 24.12's, term for term:

* each body component's Barrowman lift, CNa * sin(a), at its Barrowman CP
  (``SymmetricComponentCalc.calculateNonaxialForces``: CNa * sinc(a) * a);
* the body lift, ``BODY_LIFT_K * A_plan / A_ref * sin(a) * sinc(a) * a``, at the
  planform centre (``SymmetricComponentCalc.getLiftCP``, "according to Galejs");
* the fins, CNa * min(a, ``STALL_ANGLE``) (``FinSetCalc.calculateNonaxialForces``).

OpenRocket's extra multiplier on body lift below Mach 0.05 above 45 deg (an apogee
turn-around fix) is not reproduced: it never applies at the angles this answers.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

#: OpenRocket 24.12 ``SymmetricComponentCalc.BODY_LIFT_K`` (Galejs' crossflow lift).
BODY_LIFT_K = 1.1
#: OpenRocket 24.12 ``FinSetCalc.STALL_ANGLE``: fin normal force stops growing here.
FIN_STALL_DEG = 20.0
#: Angles the margin curve is reported at, degrees.
CURVE_AOA_DEG = tuple(range(0, 31))
#: Rail-exit speeds the largest tolerable crosswind is reported at, m/s.
RAIL_SPEEDS = (15.0, 20.0, 25.0, 30.0, 35.0)
#: Search ceiling for the critical angle, degrees.
_MAX_AOA_DEG = 90.0


@dataclass(frozen=True)
class HighAoA:
    """Margin against angle of attack, and the angle where it reaches zero."""

    #: Smallest angle (deg) where the CP reaches the CG. 0 when the rocket is unstable
    #: at zero angle; None when it stays stable to 90 deg (no crossing).
    critical_aoa_deg: float | None
    cg_from_nose: float
    #: Side-view (planform) area of the body of revolution, m^2, and its ratio to A_ref.
    side_area: float
    side_area_ratio: float
    side_centroid_from_nose: float
    #: The two sides of the small-angle balance, both in metres (moments per q*A_ref):
    #: the fins' and body's restoring moment per radian, CNa * (x_cp - x_cg) ...
    restoring_per_rad: float
    #: ... and the crossflow's overturning moment per radian squared,
    #: K * (A_side/A_ref) * (x_cg - x_side). Negative when the planform centre is aft
    #: of the CG (body lift then stabilizes).
    overturning_per_rad2: float
    #: [{aoa (deg), cpFromNose (m), margin (cal)}] at ``CURVE_AOA_DEG``.
    curve: list[dict]
    #: [{railSpeed (m/s), maxCrosswind (m/s)}]: V * tan(a_crit). Empty when there is no
    #: critical angle (stable to 90 deg) and all zeros when unstable at zero angle.
    max_crosswind: list[dict]


def body_planform(s: np.ndarray, r: np.ndarray) -> tuple[float, float]:
    """Side-view area (m^2) of a body of revolution with radius ``r`` at stations ``s``,
    and the axial position of its centroid (same frame as ``s``)."""
    s = np.asarray(s, dtype=np.float64)
    r = np.asarray(r, dtype=np.float64)
    ds = np.diff(s)
    if len(ds) == 0:
        return 0.0, float(s[0]) if len(s) else 0.0
    # Each station interval is a trapezoid of width ds and heights 2 r0, 2 r1.
    r0, r1 = r[:-1], r[1:]
    area = ds * (r0 + r1)
    # Trapezoid centroid from its fore edge: ds (r0 + 2 r1) / (3 (r0 + r1)).
    with np.errstate(invalid="ignore", divide="ignore"):
        x_c = np.where(r0 + r1 > 0, s[:-1] + ds * (r0 + 2 * r1) / (3 * (r0 + r1)), s[:-1] + ds / 2)
    total = float(area.sum())
    if total <= 0:
        return 0.0, float(s[0])
    return total, float((area * x_c).sum() / total)


def _moment_and_force(a: float, parts: list[tuple[float, float, str]], cg: float,
                      k_side: float, x_side: float) -> tuple[float, float]:
    """Normal force (per q A_ref) and its moment about the CG (m, positive = restoring)."""
    sa = math.sin(a)
    stall = math.radians(FIN_STALL_DEG)
    cn = m = 0.0
    for cna, x, kind in parts:
        f = cna * (min(a, stall) if kind == "fin" else sa)
        cn += f
        m += f * (x - cg)
    f = k_side * sa * sa
    cn += f
    m += f * (x_side - cg)
    return cn, m


def high_aoa(
    *,
    body_cna: float,
    body_cp: float,
    fin_cna: float,
    fin_cp: float,
    cg: float,
    nose: float,
    s_grid: np.ndarray,
    r_grid: np.ndarray,
    r_ref: float,
) -> HighAoA:
    """The margin against angle of attack for one CG.

    Positions (``body_cp``, ``fin_cp``, ``cg``, ``nose``, ``s_grid``) are axial, in one
    frame; ``nose`` is the tip, so results are reported from it. ``body_cna`` /
    ``fin_cna`` are on A_ref = pi r_ref^2, as the stability panel's are.
    """
    d = 2.0 * r_ref
    a_ref = math.pi * r_ref * r_ref
    side_area, x_side = body_planform(s_grid, r_grid)
    ratio = side_area / a_ref if a_ref > 0 else 0.0
    k_side = BODY_LIFT_K * ratio

    parts = [(body_cna, body_cp, "body")]
    if fin_cna:
        parts.append((fin_cna, fin_cp, "fin"))
    cna0 = body_cna + fin_cna
    restoring = float(body_cna * (body_cp - cg) + fin_cna * (fin_cp - cg))
    overturning = float(k_side * (cg - x_side))

    def margin(a_deg: float) -> tuple[float, float]:
        """(CP from nose, margin in calibers) at ``a_deg``."""
        if a_deg == 0.0:
            if abs(cna0) < 1e-12:
                return float("nan"), float("nan")
            arm = restoring / cna0
        else:
            cn, m = _moment_and_force(math.radians(a_deg), parts, cg, k_side, x_side)
            if abs(cn) < 1e-12:
                return float("nan"), float("nan")
            arm = m / cn
        return float(cg + arm - nose), float(arm / d)

    curve = []
    for a in CURVE_AOA_DEG:
        cp, sm = margin(float(a))
        curve.append({"aoa": float(a), "cpFromNose": cp, "margin": sm})

    critical = _critical_angle(parts, cg, k_side, x_side, restoring)
    if critical is None:
        winds: list[dict] = []
    else:
        winds = [{"railSpeed": v, "maxCrosswind": v * math.tan(math.radians(critical))}
                 for v in RAIL_SPEEDS]

    return HighAoA(
        critical_aoa_deg=critical,
        cg_from_nose=float(cg - nose),
        side_area=side_area,
        side_area_ratio=ratio,
        side_centroid_from_nose=float(x_side - nose),
        restoring_per_rad=restoring,
        overturning_per_rad2=overturning,
        curve=curve,
        max_crosswind=winds,
    )


def _critical_angle(parts, cg, k_side, x_side, restoring) -> float | None:
    """Smallest angle (deg) where the restoring moment reaches zero."""
    if restoring <= 0:
        return 0.0

    def m(a_deg: float) -> float:
        return _moment_and_force(math.radians(a_deg), parts, cg, k_side, x_side)[1]

    # Scan finely enough not to step over a crossing, then bisect the bracket.
    grid = np.arange(0.1, _MAX_AOA_DEG + 1e-9, 0.1)
    lo = 0.0
    for hi in grid:
        if m(float(hi)) <= 0:
            a, b = lo, float(hi)
            for _ in range(50):
                mid = 0.5 * (a + b)
                if m(mid) > 0:
                    a = mid
                else:
                    b = mid
            return 0.5 * (a + b)
        lo = float(hi)
    return None


def high_aoa_for_core(core, cg_axial: float, mach: float | None = None) -> HighAoA:
    """``high_aoa`` for an ``stability.AeroCore`` at CG ``cg_axial`` (axial frame).

    The fins are taken at the core's own Mach (the panel's 0.3), or re-evaluated at
    ``mach`` -- the rail exit's, where the 6-DOF asks -- from the stored planform.
    """
    prof = core.profile
    fin_cna, fin_cp = float(core.fin_cna), 0.0
    pf = core.fin_pf
    if mach is not None and pf is not None:
        from .barrowman_fins import fin_set_aero

        f = fin_set_aero(pf.chord_lead, pf.chord_trail, pf.span, pf.body_radius, pf.n_fins,
                         prof.r_max, max(float(mach), 0.0))
        fin_cna, fin_cp = f.cna, f.cp
    elif fin_cna:
        # The merged CP is the CNa-weighted mean of body and fins; take the fins back out.
        fin_cp = (core.cna_total * core.cp_axial - core.body_cna * core.body_cp_axial) / core.fin_cna
    return high_aoa(
        body_cna=float(core.body_cna),
        body_cp=float(core.body_cp_axial),
        fin_cna=float(fin_cna),
        fin_cp=float(fin_cp),
        cg=float(cg_axial),
        nose=float(prof.x_fore),
        s_grid=np.asarray(prof.s_grid),
        r_grid=np.asarray(prof.r_grid),
        r_ref=prof.r_max,
    )


def to_json(h: HighAoA | None) -> dict | None:
    if h is None:
        return None
    return {
        "criticalAoaDeg": h.critical_aoa_deg,
        "cgFromNose": h.cg_from_nose,
        "sideArea": h.side_area,
        "sideAreaRatio": h.side_area_ratio,
        "sideCentroidFromNose": h.side_centroid_from_nose,
        "restoringPerRad": h.restoring_per_rad,
        "overturningPerRad2": h.overturning_per_rad2,
        "curve": h.curve,
        "maxCrosswind": h.max_crosswind,
        "model": (f"OpenRocket 24.12 body lift (Galejs, K = {BODY_LIFT_K}) at the planform "
                  f"centre; fin lift capped at {FIN_STALL_DEG:g} deg stall"),
    }
