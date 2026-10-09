"""Hot-gas side of the chamber and nozzle wall.

Convection is Bartz, station by station along the real contour (Huzel & Huang eq. 4-13,
Sutton & Biblarz eq. 8-23), with CEA frozen-composition transport at the stagnation state,
the exact isentropic area-Mach number and the adiabatic wall temperature of a turbulent
boundary layer, recovery factor r = Pr^(1/3).

Radiation is the H2O and CO2 of the burnt gas: a gray gas in a gray enclosure. Gas
emissivity is Leckner's correlation (Modest, Radiative Heat Transfer, 3rd ed., sec. 11.10,
Table 11.3), absorptivity at the wall temperature by Hottel's scaling, and the mean beam
length is 3.6 V/A of the chamber (Modest sec. 10.x) capped at 0.95 D of the local bore.

No turbulence multiplier and no laminar switch: Bartz is a fit to turbulent rocket-nozzle
data and already carries the chamber's free-stream turbulence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

import numpy as np

from engine.pipeline.constants import STEFAN_BOLTZMANN_W_M2_K4

#: Bartz boundary-layer property exponent (viscosity ~ T^omega), Bartz 1957 / H&H eq. 4-14.
BARTZ_OMEGA = 0.6
#: Throat radii of the drawn contour (engine.core.nozzle_solver.rao): upstream 1.5 Rt,
#: downstream 0.382 Rt. Bartz's r_c is the throat radius of curvature; the mean of the two.
THROAT_RC_OVER_RT = 0.5 * (1.5 + 0.382)
#: Leckner's correlations are fitted to 2500 K (Modest sec. 11.10); the pressure corrections
#: are evaluated no hotter than this (the H2O one changes sign above ~2700 K).
LECKNER_T_MAX = 2500.0
#: Mean beam length of an enclosure, optically-thin value corrected for absorption: 3.6 V/A
#: (Modest, Radiative Heat Transfer, eq. 10.x); an infinite cylinder to its wall: 0.95 D.
BEAM_LENGTH_COEFF = 3.6
CYLINDER_BEAM_LENGTH_OVER_D = 0.95


# ── Isentropic flow ───────────────────────────────────────────────────────────

def area_ratio_of_mach(M, gamma):
    g = gamma
    M = np.asarray(M, dtype=float)
    return (1.0 / M) * ((2.0 / (g + 1.0)) * (1.0 + 0.5 * (g - 1.0) * M * M)) ** ((g + 1.0) / (2.0 * (g - 1.0)))


def _mach_bisect_py(ar, sup, gamma):
    """``mach_from_area_ratio``'s bisection as a scalar loop, for compilation (same 64 halvings)."""
    out = np.empty(ar.size)
    for i in range(ar.size):
        lo, hi = (1.0, 50.0) if sup[i] else (1e-9, 1.0)
        for _ in range(64):
            mid = 0.5 * (lo + hi)
            f = (1.0 / mid) * ((2.0 / (gamma + 1.0)) * (1.0 + 0.5 * (gamma - 1.0) * mid * mid)) ** (
                (gamma + 1.0) / (2.0 * (gamma - 1.0))) - ar[i]
            if (f < 0.0) if sup[i] else (f > 0.0):
                lo = mid
            else:
                hi = mid
        out[i] = 1.0 if ar[i] <= 1.0 + 1e-12 else 0.5 * (lo + hi)
    return out


try:  # called ~2 per chamber evaluation per station set; compiled it costs microseconds
    from numba import njit as _njit
    _mach_bisect = _njit(cache=True)(_mach_bisect_py)
except ImportError:  # pragma: no cover
    _mach_bisect = None
#: False forces the NumPy bisection (the reference the compiled one is tested against).
_USE_COMPILED_BISECT = _mach_bisect is not None


def mach_from_area_ratio(area_ratio, gamma: float, supersonic):
    """Exact inversion of the area-Mach relation on the requested branch (vectorised bisection;
    A/A* is monotone on each branch). Scalars in, scalar out."""
    ar = np.atleast_1d(np.asarray(area_ratio, dtype=float))
    sup = np.broadcast_to(np.atleast_1d(np.asarray(supersonic, dtype=bool)), ar.shape)
    if _USE_COMPILED_BISECT:
        M = _mach_bisect(np.ascontiguousarray(ar.ravel()), np.ascontiguousarray(sup.ravel()),
                         float(gamma)).reshape(ar.shape)
        return float(M[0]) if np.ndim(area_ratio) == 0 else M
    lo = np.where(sup, 1.0, 1e-9)
    hi = np.where(sup, 50.0, 1.0)
    for _ in range(64):
        mid = 0.5 * (lo + hi)
        f = area_ratio_of_mach(mid, gamma) - ar
        # subsonic: A/A* falls with M; supersonic: rises
        go_up = np.where(sup, f < 0.0, f > 0.0)
        lo = np.where(go_up, mid, lo)
        hi = np.where(go_up, hi, mid)
    M = np.where(ar <= 1.0 + 1e-12, 1.0, 0.5 * (lo + hi))
    return float(M[0]) if np.ndim(area_ratio) == 0 else M


def static_ratios(M, gamma: float):
    """(T/T0, P/P0) at Mach M."""
    t = 1.0 / (1.0 + 0.5 * (gamma - 1.0) * M * M)
    return t, t ** (gamma / (gamma - 1.0))


# ── Convection ────────────────────────────────────────────────────────────────

def recovery_temperature(T0: float, gamma: float, M, Pr: float):
    """Adiabatic wall temperature, turbulent recovery factor r = Pr^(1/3) (H&H eq. 4-10/4-11)."""
    k = 0.5 * (gamma - 1.0) * M * M
    r = Pr ** (1.0 / 3.0)
    return T0 * (1.0 + r * k) / (1.0 + k)


def bartz_sigma(Tw, T0: float, gamma: float, M, omega: float = BARTZ_OMEGA):
    """Bartz property-variation correction (H&H eq. 4-14)."""
    k = 1.0 + 0.5 * (gamma - 1.0) * M * M
    return 1.0 / ((0.5 * (Tw / T0) * k + 0.5) ** (0.8 - omega / 5.0) * k ** (omega / 5.0))


def bartz_h(Dt: float, rc: float, mu: float, cp: float, Pr: float, mass_flux_throat: float,
            area_ratio, sigma):
    """Bartz gas-side coefficient [W/(m^2 K)], SI form of H&H eq. 4-13.

    ``mass_flux_throat`` is Pc/c* = mdot/At; transport properties at the stagnation state.
    """
    return (0.026 / Dt ** 0.2 * (mu ** 0.2 * cp / Pr ** 0.6) * mass_flux_throat ** 0.8
            * (Dt / rc) ** 0.1 * (1.0 / area_ratio) ** 0.9 * sigma)


# ── Radiation ─────────────────────────────────────────────────────────────────

_LECKNER_H2O = np.array([[-2.2118, -1.1987, 0.035596],
                         [0.85667, 0.93048, -0.14391],
                         [-0.10838, -0.17156, 0.045915]])
_LECKNER_CO2 = np.array([[-3.9893, 2.7669, -2.1081, 0.39163],
                         [1.2710, -1.1090, 1.0195, -0.21897],
                         [-0.23678, 0.19731, -0.19544, 0.044644]])


def _leckner_eps0(c: np.ndarray, t, paL_barcm):
    """Zero-pressure emissivity, exp(sum_i a_i x^i), a_i = sum_j c_ij t^j, x = log10(paL/1 bar cm)."""
    t = np.asarray(t, dtype=float)
    x = np.log10(np.maximum(paL_barcm, 1e-12))
    a = [sum(c[i, j] * t ** j for j in range(c.shape[1])) for i in range(3)]
    return np.exp(a[0] + a[1] * x + a[2] * x * x)


def _leckner_species(sp: str, T, P_bar, pa_bar, L_cm):
    t = np.asarray(T, dtype=float) / 1000.0
    tc = np.minimum(np.asarray(T, dtype=float), LECKNER_T_MAX) / 1000.0
    paL = np.asarray(pa_bar, dtype=float) * L_cm
    if sp == "H2O":
        e0 = _leckner_eps0(_LECKNER_H2O, t, paL)
        PE = P_bar + 2.56 * pa_bar / np.sqrt(tc)
        a = np.where(tc > 0.75, 1.888 - 2.053 * np.log10(tc), 2.144)
        b = 1.10 / tc ** 1.4
        cc = 0.5
        paL_m = 13.2 * tc * tc
    else:
        e0 = _leckner_eps0(_LECKNER_CO2, t, paL)
        PE = P_bar + 0.28 * pa_bar
        a = 1.0 + 0.1 / tc ** 1.45
        b = 0.23
        cc = 1.47
        paL_m = np.where(tc < 0.7, 0.054 / (tc * tc), 0.225 * tc * tc)
    ratio = 1.0 - (a - 1.0) * (1.0 - PE) / (a + b - 1.0 + PE) * np.exp(
        -cc * np.log10(paL_m / np.maximum(paL, 1e-12)) ** 2)
    return np.where(paL > 0.0, e0 * ratio, 0.0)


def _leckner_overlap(p_H2O_bar, p_CO2_bar, L_cm):
    pH = np.asarray(p_H2O_bar, dtype=float)
    pC = np.asarray(p_CO2_bar, dtype=float)
    tot = np.maximum(pH + pC, 1e-30)
    zeta = pH / tot
    x = np.log10(np.maximum(tot * L_cm, 1e-30))
    d = (zeta / (10.7 + 101.0 * zeta) - 0.0089 * zeta ** 10.4) * np.maximum(x, 0.0) ** 2.76
    return np.where((pH > 0) & (pC > 0), d, 0.0)


def leckner_emissivity(T, P_bar, p_H2O_bar, p_CO2_bar, L_m) -> Dict[str, np.ndarray]:
    """Total emissivity of an H2O-CO2 mixture (Modest eqs. 11.139-11.143, Table 11.3).

    Pressures in bar, path length in m. Returns eps, the two species' contributions, the
    overlap correction and whether the pressure corrections were held at LECKNER_T_MAX.
    Scalars or arrays.
    """
    L_cm = np.asarray(L_m, dtype=float) * 100.0
    eH = _leckner_species("H2O", T, P_bar, p_H2O_bar, L_cm)
    eC = _leckner_species("CO2", T, P_bar, p_CO2_bar, L_cm)
    d = _leckner_overlap(p_H2O_bar, p_CO2_bar, L_cm)
    return {"eps": np.maximum(eH + eC - d, 0.0), "eps_H2O": eH, "eps_CO2": eC, "overlap": d,
            "pressure_correction_clamped": np.asarray(T) > LECKNER_T_MAX}


def gas_absorptivity(Tg, Tw, P_bar, p_H2O_bar, p_CO2_bar, L_m):
    """Absorptivity for wall emission at Tw (Hottel's scaling; Modest eq. 11.144):
    alpha_i = (Tg/Tw)^n_i eps_i(Tw, p_i L Tw/Tg), n = 0.45 H2O, 0.65 CO2."""
    s = np.asarray(Tw, dtype=float) / np.asarray(Tg, dtype=float)
    L_cm = np.asarray(L_m, dtype=float) * 100.0
    eH = _leckner_species("H2O", Tw, P_bar, np.asarray(p_H2O_bar) * s, L_cm)
    eC = _leckner_species("CO2", Tw, P_bar, np.asarray(p_CO2_bar) * s, L_cm)
    d = _leckner_overlap(np.asarray(p_H2O_bar) * s, np.asarray(p_CO2_bar) * s, L_cm)
    return np.maximum((1.0 / s) ** 0.45 * eH + (1.0 / s) ** 0.65 * eC - d, 0.0)


def gray_enclosure_flux(eps_g, alpha_g, eps_w, Tg, Tw):
    """Net gas-to-wall radiation of an isothermal gray gas in a gray enclosure [W/m^2]."""
    f = eps_w / (1.0 - (1.0 - eps_w) * (1.0 - alpha_g))
    return f * STEFAN_BOLTZMANN_W_M2_K4 * (eps_g * Tg ** 4 - alpha_g * Tw ** 4)


# ── Contour ───────────────────────────────────────────────────────────────────

@dataclass
class WallContour:
    """Gas-side wall radius r(x), throat at x = 0, face at x_face < 0."""
    x: np.ndarray
    r: np.ndarray
    x_face: float
    x_cone_start: float
    x_arc_start: float
    R_t: float
    R_c: float
    volume: float
    beam_length: float

    def area_elements(self) -> np.ndarray:
        """Lateral area of the frustum between consecutive stations, per station (half each side)."""
        dA_seg = np.pi * (self.r[1:] + self.r[:-1]) * np.hypot(np.diff(self.x), np.diff(self.r))
        dA = np.zeros_like(self.r)
        dA[:-1] += 0.5 * dA_seg
        dA[1:] += 0.5 * dA_seg
        return dA


def wall_contour(A_throat: float, chamber_diameter: float, volume: float,
                 A_exit: Optional[float] = None, n_chamber: int = 160, n_nozzle: int = 60,
                 theta: float = np.pi / 4.0) -> WallContour:
    """The drawn contour: barrel, cone at half-angle theta, 1.5 Rt entrance arc, Rao bell.

    The barrel length is the one that closes the declared volume (chamber_length_calc), the
    same construction the geometry generator draws; it is not read from a stored length.
    """
    from engine.core.chamber_geometry import chamber_length_calc, generate_nozzle

    R_t = float(np.sqrt(A_throat / np.pi))
    R_c = 0.5 * float(chamber_diameter)
    CR = (R_c / R_t) ** 2
    L_cyl = max(float(chamber_length_calc(volume, A_throat, CR, theta)), 0.0)
    r_tan = R_t * (1.0 + 1.5 * (1.0 - np.cos(theta)))
    x_arc = -1.5 * R_t * np.sin(theta)
    x_cone = x_arc - max(R_c - r_tan, 0.0) / np.tan(theta)
    x_face = x_cone - L_cyl

    n_cyl = max(int(n_chamber * 0.5), 8)
    n_cone = max(int(n_chamber * 0.25), 6)
    n_arc = max(n_chamber - n_cyl - n_cone, 6)
    xc = np.linspace(x_face, x_cone, n_cyl, endpoint=False)
    rc = np.full_like(xc, R_c)
    xk = np.linspace(x_cone, x_arc, n_cone, endpoint=False)
    rk = R_c - (xk - x_cone) * np.tan(theta)
    ta = np.linspace(-(np.pi / 2.0 + theta), -np.pi / 2.0, n_arc)
    xa = 1.5 * R_t * np.cos(ta)
    ra = 1.5 * R_t * np.sin(ta) + 2.5 * R_t
    x = np.concatenate([xc, xk, xa])
    r = np.concatenate([rc, rk, ra])
    if A_exit is not None and A_exit > A_throat:
        pts = generate_nozzle(A_throat, A_exit, steps=max(n_nozzle, 10), theta=theta)[0]
        keep = pts[:, 0] > 1e-12
        x = np.concatenate([x, pts[keep, 0]])
        r = np.concatenate([r, pts[keep, 1]])
    order = np.argsort(x, kind="stable")
    x, r = x[order], r[order]
    uniq = np.concatenate([[True], np.diff(x) > 1e-12])
    x, r = x[uniq], r[uniq]

    # Enclosure for the beam length: barrel, cone, arc, face and the throat opening.
    ch = x <= 0.0
    dA = np.pi * (r[ch][1:] + r[ch][:-1]) * np.hypot(np.diff(x[ch]), np.diff(r[ch]))
    A_enc = float(dA.sum()) + np.pi * R_c ** 2 + A_throat
    L_e = BEAM_LENGTH_COEFF * float(volume) / A_enc
    return WallContour(x=x, r=r, x_face=float(x_face), x_cone_start=float(x_cone),
                       x_arc_start=float(x_arc), R_t=R_t, R_c=R_c, volume=float(volume),
                       beam_length=float(L_e))


def contour_for(cg) -> WallContour:
    """wall_contour for a ChamberGeometryConfig."""
    return wall_contour(cg.A_throat, cg.chamber_diameter, cg.volume, A_exit=cg.A_exit)


# ── Station fluxes ────────────────────────────────────────────────────────────

@dataclass
class HotGasState:
    """Everything the wall sees of the gas: stagnation state, throat mass flux, CEA transport
    (frozen, chamber) and composition (equilibrium, chamber)."""
    T0: float
    P0: float
    gamma: float
    mass_flux_throat: float
    mu: float
    cp: float
    Pr: float
    x_H2O: float
    x_CO2: float


def hot_gas_state(cea_cache, MR: float, Pc: float, T0: float, gamma: float, mdot: float,
                  A_throat: float) -> HotGasState:
    """HotGasState from the CEA auxiliary tables at (MR, Pc)."""
    aux = cea_cache.aux
    tr = aux.transport(MR, Pc, "chamber")
    comp = aux.composition(MR, Pc, "chamber")
    return HotGasState(T0=float(T0), P0=float(Pc), gamma=float(gamma),
                       mass_flux_throat=float(mdot) / float(A_throat), mu=tr["mu"], cp=tr["cp"],
                       Pr=tr["Pr"], x_H2O=comp["H2O"], x_CO2=comp["CO2"])


def profile(gas: HotGasState, contour: WallContour, Tw, eps_wall, mask=None) -> Dict[str, np.ndarray]:
    """Convective and radiative flux into the wall at every contour station (or ``mask``ed
    ones), wall at Tw with emissivity eps_wall (scalars or per-station)."""
    x = contour.x if mask is None else contour.x[mask]
    r = contour.r if mask is None else contour.r[mask]
    Tw = np.broadcast_to(np.asarray(Tw, dtype=float), x.shape).astype(float)
    ew = np.broadcast_to(np.asarray(eps_wall, dtype=float), x.shape).astype(float)
    ar = np.maximum((r / contour.R_t) ** 2, 1.0)
    M = mach_from_area_ratio(ar, gas.gamma, x > 0.0)
    k = 1.0 + 0.5 * (gas.gamma - 1.0) * M * M
    tT = 1.0 / k
    tP = tT ** (gas.gamma / (gas.gamma - 1.0))
    Taw = recovery_temperature(gas.T0, gas.gamma, M, gas.Pr)
    sigma = bartz_sigma(Tw, gas.T0, gas.gamma, M)
    Dt = 2.0 * contour.R_t
    h = bartz_h(Dt, THROAT_RC_OVER_RT * contour.R_t, gas.mu, gas.cp, gas.Pr,
                gas.mass_flux_throat, ar, sigma)
    Tg = gas.T0 * tT
    P_bar = gas.P0 * tP / 1e5
    L = np.minimum(contour.beam_length, CYLINDER_BEAM_LENGTH_OVER_D * 2.0 * r)
    pH, pC = gas.x_H2O * P_bar, gas.x_CO2 * P_bar
    le = leckner_emissivity(Tg, P_bar, pH, pC, L)
    alpha = gas_absorptivity(Tg, np.minimum(Tw, Tg), P_bar, pH, pC, L)
    q_rad = gray_enclosure_flux(le["eps"], alpha, ew, Tg, Tw)
    return {"x": x, "r": r, "area_ratio": ar, "M": M, "h": h, "Taw": Taw,
            "q_conv": h * (Taw - Tw), "q_rad": q_rad, "eps_gas": le["eps"], "alpha_gas": alpha,
            "T_static": Tg, "P_static": gas.P0 * tP, "beam_length": L,
            "leckner_clamped": le["pressure_correction_clamped"]}


def station_flux(gas: HotGasState, contour: WallContour, x: float, Tw: float, eps_wall: float) -> Dict[str, float]:
    """profile() at one axial position, radius interpolated on the contour."""
    r = float(np.interp(x, contour.x, contour.r))
    one = WallContour(x=np.array([float(x)]), r=np.array([r]), x_face=contour.x_face,
                      x_cone_start=contour.x_cone_start, x_arc_start=contour.x_arc_start,
                      R_t=contour.R_t, R_c=contour.R_c, volume=contour.volume,
                      beam_length=contour.beam_length)
    p = profile(gas, one, Tw, eps_wall)
    return {k: (float(v[0]) if np.ndim(v) else v) for k, v in p.items()}
