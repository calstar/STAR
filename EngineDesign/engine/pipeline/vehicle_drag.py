"""Axial drag of the vehicle the flight sim builds: Cd(M), motor off and motor on.

Component build-up of the OpenRocket technical documentation (S. Niskanen, "OpenRocket
technical documentation", v13.05, 2013, sec. 3.4 and app. B), which is Barrowman's method
(TIR-33, 1967) with Hoerner's (Fluid-Dynamic Drag, 1965) and Stoney's (NASA TR R-100, 1961)
data:

  friction  (3.78)-(3.85)   fully turbulent Cf, roughness-limited Cf, compressibility,
                            body-fineness and fin-thickness corrections on the wetted area
  nose      (3.86)-(3.87), (B.1)-(B.9)   0.8 sin^2(phi) at M = 0, wave drag from Stoney's
                            fineness-3 curves scaled to this nose's fineness
  fins      (3.89)-(3.93)   leading edge by profile with the cos^2 sweep correction, trailing
                            edge as base drag, on the fin frontal area N*t*s
  base      (3.94)          0.12 + 0.13 M^2 below M 1, 0.25/M above; while thrusting the
                            nozzle exit is taken out of the base area (sec. 3.4.5)

Where the document and OpenRocket's source (BarrowmanCalculator, SymmetricComponentCalc)
differ, the source is followed and the line says so. Not modelled: launch lugs and rail
buttons (3.95), fin-body interference, boattails (the built body has none), laminar runs
(the doc assumes turbulent from the tip, sec. 3.4.1).

RocketPy takes Cd as a function of Mach alone, so each row's Reynolds number is taken in the
ISA at one reference altitude, the launch site. At 1.5 km MSL the smooth-wall Cf is ~2 % higher;
a roughness-limited Cf does not depend on Re at all.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

GAMMA_AIR = 1.4
R_AIR = 287.05287  # J/(kg K), US Standard Atmosphere 1976
FIN_PROFILES = ("square", "rounded", "airfoil")
MODEL_NAME = "openrocket_barrowman"

#: Mach rows of a built-up table. RocketPy extrapolates constant below the first row; M = 0
#: itself is left out because Re = 0 there hits the (3.81) low-Re floor.
MACH_GRID = tuple(round(0.01 * i, 2) for i in range(1, 201))

#: Stoney (NASA TR R-100) wave drag of fineness-3 noses, as tabulated in OpenRocket's
#: SymmetricComponentCalc (vonKarmanInterpolator, lvHaackInterpolator). Constant beyond the ends.
_STONEY_FN3: Dict[str, Tuple[Tuple[float, ...], Tuple[float, ...]]] = {
    "vonkarman": (
        (0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0, 3.0),
        (0.0, 0.010, 0.027, 0.055, 0.070, 0.081, 0.095, 0.097, 0.091, 0.083),
    ),
    "lvhaack": (
        (0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0),
        (0.0, 0.010, 0.024, 0.066, 0.084, 0.100, 0.114, 0.117, 0.113),
    ),
}


def isa_troposphere(h_m: float) -> Tuple[float, float, float, float, float]:
    """(T [K], p [Pa], rho [kg/m3], a [m/s], nu [m2/s]) of the 1976 US Standard Atmosphere at a
    geometric altitude, layers 0-2 (to 32 km geopotential). Sutherland viscosity, the standard's
    1.458e-6 / 110.4 K."""
    h = 6356766.0 * float(h_m) / (6356766.0 + float(h_m))  # geopotential
    if not -610.0 <= h <= 32000.0:
        raise ValueError(f"ISA 1976 layers 0-2 only: {h:.0f} m is outside -610..32000 m")
    g_R = 9.80665 / R_AIR
    if h <= 11000.0:
        T = 288.15 - 0.0065 * h
        p = 101325.0 * (T / 288.15) ** (g_R / 0.0065)
    else:
        p11 = 101325.0 * (216.65 / 288.15) ** (g_R / 0.0065)
        if h <= 20000.0:
            T = 216.65
            p = p11 * math.exp(-g_R * (h - 11000.0) / T)
        else:
            T = 216.65 + 0.001 * (h - 20000.0)
            p = p11 * math.exp(-g_R * 9000.0 / 216.65) * (T / 216.65) ** (-g_R / 0.001)
    rho = p / (R_AIR * T)
    mu = 1.458e-6 * T**1.5 / (T + 110.4)
    return T, p, rho, math.sqrt(GAMMA_AIR * R_AIR * T), mu / rho


@dataclass(frozen=True)
class VehicleGeometry:
    """What the drag sees. Lengths in m, tail at z = 0, fins as RocketPy builds them."""

    length_m: float  # tail to nose tip
    radius_m: float  # body; also the reference radius
    nose_kind: str
    nose_length_m: float
    fin_count: int
    fin_root_chord_m: float
    fin_tip_chord_m: float
    fin_span_m: float
    fin_sweep_length_m: float  # root LE to tip LE along the axis
    fin_thickness_m: float
    fin_profile: str
    surface_roughness_m: float
    nozzle_exit_area_m2: float

    @property
    def reference_area_m2(self) -> float:
        return math.pi * self.radius_m**2


@dataclass(frozen=True)
class DragCurves:
    """Cd(M) with the motor off and on, plus where they came from."""

    mach: Tuple[float, ...]
    cd_power_off: Tuple[float, ...]
    cd_power_on: Tuple[float, ...]
    model: str  # MODEL_NAME, or "table"
    source: str
    inputs: Dict[str, Any] = field(default_factory=dict)
    components_power_off: Dict[str, Tuple[float, ...]] = field(default_factory=dict)

    def rocketpy(self, power_on: bool) -> List[List[float]]:
        cd = self.cd_power_on if power_on else self.cd_power_off
        return [[m, c] for m, c in zip(self.mach, cd)]

    def at(self, mach: float, power_on: bool = False) -> float:
        cd = self.cd_power_on if power_on else self.cd_power_off
        return float(np.interp(mach, self.mach, cd))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model": self.model,
            "source": self.source,
            "mach": list(self.mach),
            "cd_power_off": list(self.cd_power_off),
            "cd_power_on": list(self.cd_power_on),
            "components_power_off": {k: list(v) for k, v in self.components_power_off.items()},
            "inputs": dict(self.inputs),
        }


# ---------------------------------------------------------------- component coefficients


def skin_friction_cf(Re: float, mach: float, roughness_m: float, length_m: float) -> float:
    """Compressibility-corrected Cf on the wetted area, (3.78)-(3.84)."""
    M = float(mach)
    # (3.81): below R = 1e4 the value at 1e4
    cf_turb = 1.48e-2 if Re < 1.0e4 else 1.0 / (1.50 * math.log(Re) - 5.6) ** 2
    # (3.82) subsonic, (3.83) supersonic; OpenRocket switches at M 1.1
    c_turb = 1.0 - 0.1 * M * M if M < 1.1 else 1.0 / (1.0 + 0.15 * M * M) ** 0.58
    turb = cf_turb * c_turb
    if roughness_m <= 0.0:
        return turb
    # (3.80) with (3.82)/(3.84); OpenRocket blends the two linearly across M 0.9-1.1
    if M < 0.9:
        c_rough = 1.0 - 0.1 * M * M
    elif M > 1.1:
        c_rough = 1.0 / (1.0 + 0.18 * M * M)
    else:
        c_lo, c_hi = 1.0 - 0.1 * 0.9**2, 1.0 / (1.0 + 0.18 * 1.1**2)
        c_rough = c_hi * (M - 0.9) / 0.2 + c_lo * (1.1 - M) / 0.2
    rough = 0.032 * (roughness_m / length_m) ** 0.2 * c_rough
    # sec. 3.4.2: the roughness-limited value is never used below the turbulent one
    return max(turb, rough)


def stagnation_cd(mach: float) -> float:
    """Blunt-cylinder front drag on its frontal area, (B.1)-(B.2)."""
    M = float(mach)
    if M <= 1.0:
        q = 1.0 + M**2 / 4.0 + M**4 / 40.0
    else:
        q = 1.84 - 0.76 / M**2 + 0.166 / M**4 + 0.035 / M**6
    return 0.85 * q


def base_cd(mach: float) -> float:
    """(3.94), on the base area."""
    M = float(mach)
    return 0.12 + 0.13 * M * M if M <= 1.0 else 0.25 / M


def _subsonic_fit(M: float, m_lo: float, value: float, slope: float, cd0: float) -> float:
    """(3.87): a M^b + cd0, fitted to the value and slope at the transonic lower bound."""
    if value <= cd0:
        return cd0  # non-decreasing and zero-slope at M = 0: flat
    b = m_lo * slope / (value - cd0)
    a = (value - cd0) / m_lo**b
    return a * M**b + cd0


def _nose_key(kind: str) -> str:
    return str(kind).replace(" ", "").replace("_", "").replace("-", "").lower()


def _haack_wave_cd(mach: float, fineness: float, key: str) -> float:
    xs, ys = _STONEY_FN3[key]
    log4 = math.log(fineness + 1.0) / math.log(4.0)

    def scaled(m: float) -> float:  # (B.9)
        c3 = float(np.interp(m, xs, ys))
        stag = stagnation_cd(m)
        return 0.0 if c3 <= 0.0 else stag * (c3 / stag) ** log4

    m_lo = xs[0]
    if mach >= m_lo:
        return scaled(mach)
    v = scaled(m_lo)
    return _subsonic_fit(mach, m_lo, v, (scaled(m_lo + 0.01) - v) / 0.01, 0.0)


def _cone_wave_cd(mach: float, fineness: float, cd0: float, shape_factor: float) -> float:
    """Conical wave drag (B.4)-(B.6), times the ogive shape factor (B.8) at and above M 1."""
    sin_e = 1.0 / math.sqrt(1.0 + 4.0 * fineness**2)  # (B.3)
    cd1 = 1.0 * sin_e  # (B.6)
    slope1 = 4.0 / (GAMMA_AIR + 1.0) * (1.0 - 0.5 * cd1)  # (B.5)

    def sup(m: float) -> float:  # (B.4)
        return 2.1 * sin_e**2 + 0.5 * sin_e / math.sqrt(m * m - 1.0)

    M = float(mach)
    if M >= 1.3:
        return shape_factor * sup(M)
    if M >= 1.0:  # cubic Hermite through (B.6)/(B.5) at M 1 and (B.4) at M 1.3
        h = 0.3
        y1 = sup(1.3)
        d1 = -0.5 * sin_e * 1.3 / (1.3**2 - 1.0) ** 1.5
        s = (M - 1.0) / h
        h00, h10 = 2 * s**3 - 3 * s**2 + 1, s**3 - 2 * s**2 + s
        h01, h11 = -2 * s**3 + 3 * s**2, s**3 - s**2
        return shape_factor * (h00 * cd1 + h10 * h * slope1 + h01 * y1 + h11 * h * d1)
    return _subsonic_fit(M, 1.0, shape_factor * cd1, shape_factor * slope1, cd0)


def nose_pressure_cd(mach: float, kind: str, fineness: float) -> float:
    """Nose pressure (wave) drag on the nose base area, for a nose flush with the body."""
    key = _nose_key(kind)
    if key in _STONEY_FN3:
        return _haack_wave_cd(mach, fineness, key)  # tangent joint: (3.86) gives 0 at M 0
    if key == "conical":
        sin_e = 1.0 / math.sqrt(1.0 + 4.0 * fineness**2)
        return _cone_wave_cd(mach, fineness, 0.8 * sin_e**2, 1.0)  # joint angle = half-apex
    if key in ("ogive", "tangent", "tangentogive"):
        # RocketPy's "ogive" is the tangent ogive, kappa = 1: (B.8) factor 1.0, joint angle 0
        return _cone_wave_cd(mach, fineness, 0.0, 0.72 * (1.0 - 0.5) ** 2 + 0.82)
    raise ValueError(
        f"No transonic nose drag data for nose kind '{kind}' (have: vonKarman, lvhaack, conical, "
        "ogive). Give rocket.drag_curve_power_off / drag_curve_power_on from OpenRocket or RASAero."
    )


def fin_pressure_cd(mach: float, profile: str, le_sweep_rad: float) -> float:
    """Leading plus trailing edge drag on the fin frontal area N*t*s, (3.89)-(3.93)."""
    M = float(mach)
    if profile == "square":
        le_perp = stagnation_cd(M)  # (3.90)
    elif profile in ("rounded", "airfoil"):  # (3.89)
        if M < 0.9:
            le_perp = (1.0 - M * M) ** -0.417 - 1.0
        elif M < 1.0:
            le_perp = 1.0 - 1.785 * (M - 0.9)
        else:
            le_perp = 1.214 - 0.502 / M**2 + 0.1095 / M**4
    else:
        raise ValueError(f"fin_profile must be one of {FIN_PROFILES}, not {profile!r}")
    le = le_perp * math.cos(le_sweep_rad) ** 2  # (3.91)
    te = {"square": 1.0, "rounded": 0.5, "airfoil": 0.0}[profile] * base_cd(M)  # (3.92)
    return le + te


# ---------------------------------------------------------------- geometry


def nose_profile(kind: str, length_m: float, radius_m: float, x: np.ndarray) -> np.ndarray:
    """Nose radius at distance x from the tip (the shapes RocketPy draws)."""
    key = _nose_key(kind)
    xi = np.clip(np.asarray(x, dtype=float) / length_m, 0.0, 1.0)
    if key == "conical":
        return radius_m * xi
    if key in ("vonkarman", "lvhaack"):
        th = np.arccos(1.0 - 2.0 * xi)
        c = 1.0 / 3.0 if key == "lvhaack" else 0.0
        return radius_m * np.sqrt(np.maximum(th - np.sin(2 * th) / 2 + c * np.sin(th) ** 3, 0.0)) / math.sqrt(math.pi)
    if key in ("ogive", "tangent", "tangentogive"):
        rho = (radius_m**2 + length_m**2) / (2.0 * radius_m)
        return np.sqrt(rho**2 - (length_m * (1.0 - xi)) ** 2) + radius_m - rho
    raise ValueError(f"No profile for nose kind '{kind}'")


@lru_cache(maxsize=64)
def nose_wetted_area(kind: str, length_m: float, radius_m: float, n: int = 20001) -> float:
    """Surface of revolution, summed as frusta (exact for the polyline)."""
    x = np.linspace(0.0, length_m, n)
    y = nose_profile(kind, length_m, radius_m, x)
    return float(np.sum(math.pi * (y[1:] + y[:-1]) * np.hypot(np.diff(x), np.diff(y))))


def _tank_height(section: Any, h_attr: str, r_attr: str) -> float:
    """Tank cylinder height from the volume the caps and the ullage use (tank_capacity)."""
    from engine.pipeline.tank_capacity import resolve_cylindrical_tank_volume_m3

    V = resolve_cylindrical_tank_volume_m3(section, height_attr=h_attr, radius_attr=r_attr)
    return V / (math.pi * float(getattr(section, r_attr)) ** 2)


def built_stack(config: Any) -> Dict[str, float]:
    """The stack ui/flight_sim.py assembles, tail at z = 0 (RocketPy tail_to_nose).

    Tank tops sit at motor_position + tank centre + h/2; the nose TIP is avionics_payload_length_m
    above the highest of them (RocketPy's add_nose position is the tip). So the avionics length
    includes the nose, and the body is a plain cylinder from the tail to the nose base.
    """
    rk = config.rocket
    motor_position = float(getattr(rk, "motor_position", 0.0) or 0.0)
    lox_h = _tank_height(config.lox_tank, "lox_h", "lox_radius")
    fuel_h = _tank_height(config.fuel_tank, "rp1_h", "rp1_radius")
    lox_top = motor_position + config.lox_tank.ox_tank_pos + lox_h / 2
    fuel_pos = config.fuel_tank.fuel_tank_pos
    fuel_top = motor_position + fuel_pos + fuel_h / 2 if fuel_pos > 0 else 0.0
    press_top = 0.0
    if getattr(config, "press_tank", None):
        press_top = motor_position + config.press_tank.pres_tank_pos + config.press_tank.press_h / 2
    avionics = float(getattr(rk, "avionics_payload_length_m", 4.0) or 0.0)
    nose_tip = max(lox_top, fuel_top, press_top, motor_position) + avionics
    diameter = 2.0 * float(rk.radius)
    nose_len_override = getattr(rk, "nose_length", None)
    if nose_len_override and float(nose_len_override) > 0:
        nose_length = float(nose_len_override)
    else:
        nose_length = float(getattr(rk, "nose_fineness_ratio", 4.5) or 4.5) * diameter
    return {
        "motor_position": motor_position,
        "lox_h": lox_h,
        "fuel_h": fuel_h,
        "lox_top": lox_top,
        "fuel_top": fuel_top,
        "press_top": press_top,
        "nose_tip": nose_tip,
        "nose_length": nose_length,
        "length": nose_tip,
    }


def vehicle_geometry(config: Any, nozzle_exit_area_m2: float, stack: Optional[Dict[str, float]] = None) -> VehicleGeometry:
    rk = config.rocket
    stack = stack or built_stack(config)
    fins = getattr(rk, "fins", None)
    if fins is not None:
        n, cr, ct, s = int(fins.no_fins), float(fins.root_chord), float(fins.tip_chord), float(fins.fin_span)
        sweep = cr - ct  # RocketPy's default: right trapezoid, trailing edge square to the body
    else:
        n, cr, ct, s, sweep = 0, 1.0, 1.0, 0.0, 0.0
    return VehicleGeometry(
        length_m=float(stack["length"]),
        radius_m=float(rk.radius),
        nose_kind=str(getattr(rk, "nose_kind", None) or "vonKarman"),
        nose_length_m=float(stack["nose_length"]),
        fin_count=n,
        fin_root_chord_m=cr,
        fin_tip_chord_m=ct,
        fin_span_m=s,
        fin_sweep_length_m=sweep,
        fin_thickness_m=float(rk.fin_thickness_m),
        fin_profile=str(rk.fin_profile),
        surface_roughness_m=float(rk.surface_roughness_m),
        nozzle_exit_area_m2=float(nozzle_exit_area_m2),
    )


# ---------------------------------------------------------------- build-up


def drag_components(geom: VehicleGeometry, mach: float, *, a_m_s: float, nu_m2_s: float, thrusting: bool) -> Dict[str, float]:
    """Cd on the body cross-section, by component, (3.97)."""
    M = float(mach)
    D, L, A_ref = 2.0 * geom.radius_m, geom.length_m, geom.reference_area_m2
    Re = M * a_m_s * L / nu_m2_s
    cf = skin_friction_cf(Re, M, geom.surface_roughness_m, L)
    body_wet = nose_wetted_area(geom.nose_kind, geom.nose_length_m, geom.radius_m) + math.pi * D * (L - geom.nose_length_m)
    fin_planform = 0.5 * (geom.fin_root_chord_m + geom.fin_tip_chord_m) * geom.fin_span_m
    fins_wet = 2.0 * geom.fin_count * fin_planform
    lam = geom.fin_tip_chord_m / geom.fin_root_chord_m
    mac = (2.0 / 3.0) * geom.fin_root_chord_m * (1.0 + lam + lam * lam) / (1.0 + lam)
    fB = L / D  # rocket fineness, length over diameter as the doc defines f
    friction = cf * ((1.0 + 1.0 / (2.0 * fB)) * body_wet + (1.0 + 2.0 * geom.fin_thickness_m / mac) * fins_wet) / A_ref  # (3.85)
    nose = nose_pressure_cd(M, geom.nose_kind, geom.nose_length_m / D)
    fins = 0.0
    if geom.fin_count > 0 and geom.fin_span_m > 0:
        sweep = math.atan2(geom.fin_sweep_length_m, geom.fin_span_m)
        fins = fin_pressure_cd(M, geom.fin_profile, sweep) * geom.fin_count * geom.fin_thickness_m * geom.fin_span_m / A_ref
    base_area = A_ref  # flat base: the body ends in the nozzle plane, no boattail
    if thrusting:
        base_area = max(base_area - geom.nozzle_exit_area_m2, 0.0)  # sec. 3.4.5
    base = base_cd(M) * base_area / A_ref
    return {"Re": Re, "cf": cf, "friction": friction, "nose": nose, "fins": fins, "base": base, "total": friction + nose + fins + base}


def buildup_curves(geom: VehicleGeometry, reference_altitude_m: float, mach_grid: Sequence[float] = MACH_GRID) -> DragCurves:
    _, _, _, a, nu = isa_troposphere(reference_altitude_m)
    off = [drag_components(geom, m, a_m_s=a, nu_m2_s=nu, thrusting=False) for m in mach_grid]
    on = [drag_components(geom, m, a_m_s=a, nu_m2_s=nu, thrusting=True) for m in mach_grid]
    return DragCurves(
        mach=tuple(float(m) for m in mach_grid),
        cd_power_off=tuple(c["total"] for c in off),
        cd_power_on=tuple(c["total"] for c in on),
        model=MODEL_NAME,
        source="Component build-up, OpenRocket technical documentation (Niskanen 2013) sec. 3.4 / app. B",
        inputs={
            "length_m": geom.length_m,
            "diameter_m": 2.0 * geom.radius_m,
            "nose_kind": geom.nose_kind,
            "nose_length_m": geom.nose_length_m,
            "fin_count": geom.fin_count,
            "fin_le_sweep_deg": math.degrees(math.atan2(geom.fin_sweep_length_m, geom.fin_span_m)) if geom.fin_span_m > 0 else None,
            "fin_thickness_m": geom.fin_thickness_m,
            "fin_profile": geom.fin_profile,
            "surface_roughness_m": geom.surface_roughness_m,
            "nozzle_exit_area_m2": geom.nozzle_exit_area_m2,
            "reynolds_reference_altitude_m": float(reference_altitude_m),
        },
        components_power_off={k: tuple(c[k] for c in off) for k in ("friction", "nose", "fins", "base")},
    )


def table_curves(power_off: Sequence[Sequence[float]], power_on: Sequence[Sequence[float]], source: str) -> DragCurves:
    """A user's Cd(M) tables, put on one Mach grid (the union of both, linear in between)."""
    off = np.asarray(power_off, dtype=float)
    on = np.asarray(power_on, dtype=float)
    mach = np.unique(np.concatenate([off[:, 0], on[:, 0]]))
    return DragCurves(
        mach=tuple(float(m) for m in mach),
        cd_power_off=tuple(float(v) for v in np.interp(mach, off[:, 0], off[:, 1])),
        cd_power_on=tuple(float(v) for v in np.interp(mach, on[:, 0], on[:, 1])),
        model="table",
        source=str(source),
        inputs={"rows_power_off": int(len(off)), "rows_power_on": int(len(on))},
    )


def resolve_drag_curves(config: Any, nozzle_exit_area_m2: float, stack: Optional[Dict[str, float]] = None, **overrides: Any) -> DragCurves:
    """The user's tables when given, else the build-up of the vehicle the sim assembles.

    ``overrides`` replaces build-up inputs by VehicleGeometry field name, e.g. the ceiling check's
    ``surface_roughness_m=0.0`` (hydraulically smooth: the low-drag end of the finish).
    """
    rk = config.rocket
    if getattr(rk, "drag_curve_power_off", None) is not None:
        return table_curves(rk.drag_curve_power_off, rk.drag_curve_power_on, rk.drag_curve_source)
    geom = vehicle_geometry(config, nozzle_exit_area_m2, stack)
    if overrides:
        geom = replace(geom, **overrides)
    return buildup_curves(geom, float(config.environment.elevation))
