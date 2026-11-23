"""OpenRocket 24.12's drag model, formula for formula.

Ported from ``core/src/main/java/info/openrocket/core/aerodynamics`` (release-24.12):

* ``BarrowmanCalculator.calculateFrictionCD`` / ``calculateFrictionCoefficient`` /
  ``calculateRoughnessCorrection`` / ``calculatePressureCD`` / ``calculateBaseCD`` /
  ``calculateStagnationCD`` / ``calculateBaseCD(mach)``;
* ``barrowman.SymmetricComponentCalc.calculateFrictionCD`` / ``calculatePressureCD`` /
  ``calculateNoseInterpolator`` / ``calculateOgiveNoseInterpolator`` and its NASA
  TR-R-100 shape tables;
* ``barrowman.FinSetCalc.calculateFrictionCD`` / ``calculatePressureCD``;
* ``barrowman.RailButtonCalc.calculatePressureCD`` (Gowen & Perkins cylinder drag,
  NACA TN 2960), used here for every bluff protuberance.

Kept transcription-close on purpose: a number that disagrees with OpenRocket is a fault
here, not a modelling choice. The improvements live in ``drag_buildup``, which reuses
the pieces of this module it does not replace. OpenRocket assumes fully turbulent flow
unless the rocket is set to "perfect finish"; we port the default (turbulent) branch.

Every function takes the flow as Mach number and ``v_nu`` = V / nu (1/m), so a
Reynolds number over any length L is ``v_nu * L``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .drag_geometry import BodySegment, DragGeometry, FinSetDrag, Protuberance

GAMMA = 1.4


@dataclass(frozen=True)
class DragBreakdown:
    cd: float
    terms: dict[str, float] = field(default_factory=dict)


# -- BarrowmanCalculator ---------------------------------------------------------


def friction_coefficient(re: float, mach: float) -> float:
    """``calculateFrictionCoefficient``, fully turbulent branch."""
    cf = 1.48e-2 if re < 1.0e4 else 1.0 / (1.50 * math.log(re) - 5.6) ** 2
    c1 = 1 - 0.1 * mach**2 if mach < 1.1 else 1.0
    c2 = 1 / (1 + 0.15 * mach**2) ** 0.58 if mach > 0.9 else 1.0
    if mach < 0.9:
        return cf * c1
    if mach < 1.1:
        return cf * (c2 * (mach - 0.9) / 0.2 + c1 * (1.1 - mach) / 0.2)
    return cf * c2


def roughness_correction(mach: float) -> float:
    """``calculateRoughnessCorrection``."""
    if mach < 0.9:
        return 1 - 0.1 * mach**2
    if mach > 1.1:
        return 1 / (1 + 0.18 * mach**2)
    c1, c2 = 1 - 0.1 * 0.9**2, 1.0 / (1 + 0.18 * 1.1**2)
    return c2 * (mach - 0.9) / 0.2 + c1 * (1.1 - mach) / 0.2


def roughness_limited_cf(roughness: float, length: float, mach: float) -> float:
    """``0.032 (k / L)^0.2`` times the roughness correction (OpenRocket uses the
    rocket's aerodynamic length for ``L``, for every component)."""
    if roughness <= 0 or length <= 0:
        return 0.0
    return 0.032 * (roughness / length) ** 0.2 * roughness_correction(mach)


def stagnation_cd(m: float) -> float:
    if m <= 1:
        p = 1 + m**2 / 4 + m**4 / 40
    else:
        p = 1.84 - 0.76 / m**2 + 0.166 / m**4 + 0.035 / m**6
    return 0.85 * p


def base_cd(m: float) -> float:
    return 0.12 + 0.13 * m * m if m <= 1 else 0.25 / m


# -- SymmetricComponentCalc: nose / transition pressure drag ---------------------


def _lin(xs, ys):
    return (np.asarray(xs, dtype=np.float64), np.asarray(ys, dtype=np.float64))


# NASA TR-R-100 p.16, fineness 3, as ``SymmetricComponentCalc`` tabulates them.
_TABLES = {
    "ellipsoid": _lin([1.2, 1.25, 1.3, 1.4, 1.6, 2.0, 2.4], [0.110, 0.128, 0.140, 0.148, 0.152, 0.159, 0.162]),
    "x14": _lin([1.2, 1.3, 1.4, 1.6, 1.8, 2.2, 2.6, 3.0, 3.6], [0.140, 0.156, 0.169, 0.192, 0.206, 0.227, 0.241, 0.249, 0.252]),
    "x12": _lin([0.925, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3, 1.7, 2.0], [0, 0.014, 0.050, 0.060, 0.059, 0.081, 0.084, 0.085, 0.078]),
    "x34": _lin([0.8, 0.9, 1.0, 1.06, 1.2, 1.4, 1.6, 2.0, 2.8, 3.4], [0, 0.015, 0.078, 0.121, 0.110, 0.098, 0.090, 0.084, 0.078, 0.074]),
    "vonkarman": _lin([0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0, 3.0], [0, 0.010, 0.027, 0.055, 0.070, 0.081, 0.095, 0.097, 0.091, 0.083]),
    "lvhaack": _lin([0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0], [0, 0.010, 0.024, 0.066, 0.084, 0.100, 0.114, 0.117, 0.113]),
    "parabolic": _lin([0.95, 0.975, 1.0, 1.05, 1.1, 1.2, 1.4, 1.7], [0, 0.016, 0.041, 0.092, 0.109, 0.119, 0.113, 0.108]),
    "parabolic12": _lin([0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.3, 1.5, 1.8], [0, 0.016, 0.042, 0.100, 0.126, 0.125, 0.100, 0.090, 0.088]),
    "parabolic34": _lin([0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.7], [0, 0.023, 0.073, 0.098, 0.107, 0.106, 0.089, 0.082]),
}
_BLUNT = _lin(np.arange(0, 3, 0.05), [stagnation_cd(m) for m in np.arange(0, 3, 0.05)])


class _Interp:
    """OpenRocket's ``LinearInterpolator``: piecewise linear, constant past the ends."""

    def __init__(self, xs=(), ys=()) -> None:
        self.pts: dict[float, float] = {float(x): float(y) for x, y in zip(xs, ys)}

    def add(self, x: float, y: float) -> None:
        self.pts[float(round(x, 12))] = float(y)

    def xs(self) -> list[float]:
        return sorted(self.pts)

    def __call__(self, x: float) -> float:
        k = self.xs()
        return float(np.interp(x, k, [self.pts[v] for v in k]))


def _hermite(x0: float, x1: float, f0: float, f1: float, d0: float, d1: float):
    """``PolyInterpolator`` with values and first derivatives at two points: a cubic."""
    h = x1 - x0

    def f(x: float) -> float:
        t = (x - x0) / h
        return ((2 * t**3 - 3 * t**2 + 1) * f0 + (t**3 - 2 * t**2 + t) * h * d0
                + (-2 * t**3 + 3 * t**2) * f1 + (t**3 - t**2) * h * d1)

    return f


def _ogive_interp(param: float, sinphi: float) -> _Interp:
    """``calculateOgiveNoseInterpolator``."""
    out = _Interp()
    cd1, cd13 = sinphi, 2.1 * sinphi**2 + 0.6019 * sinphi
    poly = _hermite(1.0, 1.3, cd1, cd13, 4 / (GAMMA + 1) * (1 - 0.5 * cd1), -1.1341 * sinphi)
    mul = 0.72 * (param - 0.5) ** 2 + 0.82
    m = 1.0
    while m < 1.3001:
        out.add(m, mul * poly(m))
        m += 0.02
    m = 1.32
    while m < 4:
        out.add(m, mul * (2.1 * sinphi**2 + 0.5 * sinphi / math.sqrt(m * m - 1)))
        m += 0.02
    return out


def nose_interpolator(shape: str | None, param: float | None, sinphi: float, fineness: float) -> _Interp:
    """``calculateNoseInterpolator``: pressure CD (on the segment's frontal area) vs Mach.

    ``shape`` None (a CAD nose, shape unknown) uses the ogive form at ``param`` 1 --
    the tangent ogive, whose multiplier equals the cone's -- with the measured
    ``sinphi``.
    """
    shape = (shape or "ogive").lower()
    p_ = 0.0 if param is None else float(param)
    if shape == "ogive" and param is None:
        p_ = 1.0
    int1 = int2 = None
    p = 0.0
    if shape == "conical":
        interp = _ogive_interp(0.0, sinphi)
    elif shape == "ogive":
        interp = _ogive_interp(p_, sinphi)
    else:
        interp = _Interp()
        cone = lambda: _ogive_interp(0.0, 1 / math.sqrt(1 + 4 * fineness**2))  # noqa: E731
        if shape == "ellipsoid":
            int1 = _Interp(*_TABLES["ellipsoid"])
        elif shape == "power":
            if p_ <= 0.25:
                int1, int2, p = _Interp(*_BLUNT), _Interp(*_TABLES["x14"]), p_ * 4
            elif p_ <= 0.5:
                int1, int2, p = _Interp(*_TABLES["x14"]), _Interp(*_TABLES["x12"]), (p_ - 0.25) * 4
            elif p_ <= 0.75:
                int1, int2, p = _Interp(*_TABLES["x12"]), _Interp(*_TABLES["x34"]), (p_ - 0.5) * 4
            else:
                int1, int2, p = _Interp(*_TABLES["x34"]), cone(), (p_ - 0.75) * 4
        elif shape == "parabolic":
            if p_ <= 0.5:
                int1, int2, p = cone(), _Interp(*_TABLES["parabolic12"]), p_ * 2
            elif p_ <= 0.75:
                int1, int2, p = _Interp(*_TABLES["parabolic12"]), _Interp(*_TABLES["parabolic34"]), (p_ - 0.5) * 4
            else:
                int1, int2, p = _Interp(*_TABLES["parabolic34"]), _Interp(*_TABLES["parabolic"]), (p_ - 0.75) * 4
        elif shape == "haack":
            int1, int2, p = _Interp(*_TABLES["vonkarman"]), _Interp(*_TABLES["lvhaack"]), p_ * 3
        else:
            raise ValueError(f"unknown transition shape {shape!r}")
        if int2 is not None:
            int3 = _Interp()
            for m in int1.xs() + int2.xs():
                int3.add(m, p * int2(m) + (1 - p) * int1(m))
            int1 = int3
        log4 = math.log(fineness + 1) / math.log(4)
        blunt = _Interp(*_BLUNT)
        for m in int1.xs():
            stag = blunt(m)
            interp.add(m, stag * (int1(m) / stag) ** log4)

    lo = interp.xs()[0]
    lo_v = interp(lo)
    if lo_v < 0.001:
        return interp
    cd0 = 0.8 * sinphi**2
    deriv = (interp(lo + 0.01) - lo_v) / 0.01
    if cd0 >= lo_v - 0.01 or deriv <= 0.01:
        return interp
    b = lo * deriv / (lo_v - cd0)
    a = (lo_v - cd0) / lo**b
    m = 0.0
    while m < lo:
        interp.add(m, a * m**b + cd0)
        m += 0.05
    return interp


def segment_pressure_cd(seg: BodySegment, mach: float, ref_area: float, _cache: dict | None = None) -> float:
    """``SymmetricComponentCalc.calculatePressureCD``, on the rocket's reference area."""
    if math.isclose(seg.r_fore, seg.r_aft, rel_tol=0, abs_tol=1e-12):
        return 0.0
    frontal = abs(math.pi * (seg.r_fore**2 - seg.r_aft**2))
    if seg.length < 0.001:
        return (stagnation_cd(mach) if seg.r_fore < seg.r_aft else base_cd(mach)) * frontal / ref_area
    fineness = seg.length / (2 * abs(seg.r_aft - seg.r_fore))
    if seg.r_aft < seg.r_fore:
        if fineness >= 3:
            return 0.0
        cd = base_cd(mach) * frontal / ref_area
        return cd if fineness <= 1 else cd * (3 - fineness) / 2
    key = (seg.shape, seg.param, round(seg.sinphi, 12), round(fineness, 12))
    interp = _cache.get(key) if _cache is not None else None
    if interp is None:
        interp = nose_interpolator(seg.shape, seg.param, seg.sinphi, fineness)
        if _cache is not None:
            _cache[key] = interp
    return interp(mach) * frontal / ref_area


_NOSE_CACHE: dict = {}


# -- FinSetCalc ------------------------------------------------------------------


def fin_leading_edge_cd(mach: float) -> float:
    """Round leading edge pressure CD (``FinSetCalc``, airfoil / rounded sections)."""
    if mach < 0.9:
        return (1 - mach**2) ** -0.417 - 1
    if mach < 1:
        return 1 - 1.785 * (mach - 0.9)
    return 1.214 - 0.502 / mach**2 + 0.1095 / mach**4


def fin_pressure_cd(fin: FinSetDrag, mach: float, ref_area: float) -> float:
    """``FinSetCalc.calculatePressureCD``, one fin, on the rocket's reference area."""
    if fin.area <= 0:
        return 0.0
    if fin.section in ("airfoil", "rounded"):
        cd = fin_leading_edge_cd(mach)
    else:
        cd = stagnation_cd(mach)
    cd *= fin.cos_lead**2
    if fin.section == "square":
        cd += base_cd(mach)
    elif fin.section == "rounded":
        cd += base_cd(mach) / 2
    return cd * fin.span * fin.thickness / ref_area


def fin_friction_cd(fin: FinSetDrag, cf: float, ref_area: float) -> float:
    """``FinSetCalc.calculateFrictionCD``, one fin."""
    if fin.area <= 0 or fin.mac <= 0:
        return 0.0
    return cf * (1 + 2 * fin.thickness / fin.mac) * 2 * fin.area / ref_area


# -- RailButtonCalc (bluff protuberances) ----------------------------------------

_BUTTON_MACH = [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.6, 2.0, 2.8, 100.0]
_BUTTON_CD = [1.2, 1.22, 1.25, 1.3, 1.4, 1.5, 1.6, 2.1, 1.5, 1.45, 1.33, 1.33]


def bluff_protuberance_cd(p: Protuberance, mach: float, v_nu: float, ref_area: float) -> float:
    """``RailButtonCalc.calculatePressureCD`` for one instance: Gowen & Perkins cylinder
    CD at the mean Mach over its height, with a linear velocity profile through a
    turbulent boundary layer ``0.37 x / Re_x^0.2`` thick at its station."""
    if mach <= 1e-9:
        return 8.786395072609939e-4 * stagnation_cd(mach) * p.frontal_area / ref_area
    x = max(p.x, 1e-6)
    rex = v_nu * x
    delta = 0.37 * x / rex**0.2
    h = p.height
    m_mean = (h - 0.5 * delta) * mach / h if h > delta else (h / 2.0) / delta * mach
    cd = float(np.interp(m_mean, _BUTTON_MACH, _BUTTON_CD)) * m_mean**2 / mach**2
    return cd * stagnation_cd(mach) * p.frontal_area / ref_area


def faired_as_fin(p: Protuberance) -> FinSetDrag:
    """A faired protuberance as the rounded-edge fin the LE4 .ork draws a shroud as."""
    return FinSetDrag(
        name=p.name, count=p.count, area=p.length * p.height * 0.5, span=p.height,
        mac=p.length * 2 / 3, cos_lead=math.cos(math.atan2(p.length * 0.6, p.height)),
        thickness=p.width, section="rounded", roughness=p.roughness, root_chord=p.length,
        x_root_lead=p.x,
    )


# -- the whole rocket ------------------------------------------------------------


def drag(geom: DragGeometry, mach: float, v_nu: float) -> DragBreakdown:
    """Total zero-AoA CD on ``geom.ref_area`` at ``mach`` and V/nu ``v_nu`` (1/m)."""
    a_ref = geom.ref_area
    length = geom.length
    re = v_nu * length
    cf = friction_coefficient(re, mach)

    def comp_cf(k: float) -> float:
        return max(cf, roughness_limited_cf(k, length, mach))

    body = sum(comp_cf(s.roughness) * s.wet_area for s in geom.segments) / a_ref
    f_b = (length + 0.0001) / geom.max_radius
    t: dict[str, float] = {}
    t["friction: body"] = (1 + 1.0 / (2 * f_b)) * body

    fins = list(geom.fins) + [faired_as_fin(p) for p in geom.protuberances if p.kind == "faired"]
    t["friction: fins"] = sum(f.count * fin_friction_cd(f, comp_cf(f.roughness), a_ref) for f in fins)
    t["pressure: fins"] = sum(f.count * fin_pressure_cd(f, mach, a_ref) for f in fins)

    nose = 0.0
    other = 0.0
    stag = 0.0
    prev_r = 0.0
    for s in geom.segments:
        cd = segment_pressure_cd(s, mach, a_ref, _NOSE_CACHE)
        if s.kind == "nose":
            nose += cd
        else:
            other += cd
        if prev_r < s.r_fore:  # step up from the previous piece
            stag += stagnation_cd(mach) * math.pi * (s.r_fore**2 - prev_r**2) / a_ref
        prev_r = s.r_aft
    t["pressure: nose"] = nose
    t["pressure: transitions"] = other
    if stag:
        t["pressure: forward steps"] = stag
    t["protuberances"] = sum(p.count * bluff_protuberance_cd(p, mach, v_nu, a_ref)
                             for p in geom.protuberances if p.kind == "bluff")
    base = 0.0
    for a, b in zip(geom.segments, list(geom.segments[1:]) + [None]):
        nxt = b.r_fore if b is not None else 0.0
        if nxt < a.r_aft:
            base += base_cd(mach) * math.pi * (a.r_aft**2 - nxt**2) / a_ref
    t["base"] = base
    return DragBreakdown(cd=float(sum(t.values())), terms=t)
