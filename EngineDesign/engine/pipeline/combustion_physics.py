"""c* efficiency physics: vaporization and mixing.

    eta_c* = eta_vap * eta_mix * eta_HL

eta_HL, the heat lost to the wall upstream of the throat, is applied in combustion_eff.eta_cstar.

- eta_vap: mass fraction of the propellant vaporized by the throat, from a one-dimensional spray
  march in the manner of Priem & Heidmann (NASA TR R-67, 1960), who showed c* efficiency follows
  the fraction vaporized.
- eta_mix: an ASSUMED peak mixing efficiency at the Rupe/Elverum-Morey optimum, falling off with
  the mixing parameter M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F) (JPL Memo 30-5 eq. 1; SP-8089
  eq. 1). No correlation predicts the peak; it is an input, reported with the result.
- Chemical kinetics carry no c* loss. At ~3200 K and ~3 MPa the LOX/ethanol products relax in about
  a microsecond (CO + OH, H + OH + M) against a millisecond stay time. Kinetic losses belong to the
  nozzle, where CEA's frozen and shifting Cf bracket them (JANNAF, CPIA 246).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from engine.pipeline.config_schemas import CombustionEfficiencyConfig
from engine.pipeline.physics_constants import PRANDTL_DEFAULT, R_UNIVERSAL_KMOL

P_BOIL_REF = 101325.0      # normal boiling point pressure [Pa]
WATSON_EXPONENT = 0.38     # Watson (1943); Poling, Prausnitz & O'Connell eq. 7-12.1

# Resolution of the spray march -- numerics, not physics. Size classes are Gauss-Legendre points in
# the cumulative volume fraction V (y = -ln(1 - V) = (D/X)^q); steps are Heun (second order). 100
# steps and 16 classes agree with 3200 and 200 to 5e-5 in eta_vap (6500 N design, L* 0.5-2 m,
# D32 x1-x3).
_MARCH_STEPS = 100
_GL_X, _GL_W = np.polynomial.legendre.leggauss(16)
_RR_NODES = -np.log1p(-0.5 * (_GL_X + 1.0))
_RR_WEIGHTS = 0.5 * _GL_W
# dx/v guard for a drop stalled in still gas at the face: it then evaporates within that step.
_V_FLOOR = 1.0e-3          # [m/s]

try:  # the march is ~75 % of a chamber evaluation in NumPy; the same loop compiled is ~50x cheaper
    from numba import njit as _njit
except ImportError:  # pragma: no cover
    _njit = None
#: False forces the NumPy march (the reference the compiled one is tested against).
_USE_COMPILED_MARCH = _njit is not None


def _march_core_py(D2_0, w_cls, rho_l, mu, rho_f, k_f, lnB, t_h, U_c, rho_c, pr3, cp_g, dx,
                   n_steps, u_drop0, F0, v_floor, rr_w, starts, nq):
    """The Heun march of ``spray_vaporization_march`` as scalar loops, for compilation.

    Same formulas and step order as the NumPy loop there; returns (fraction vaporized per stream,
    x at 95 % per stream (NaN if not reached), F at the end).
    """
    n = D2_0.size
    ns = starts.size
    D2 = D2_0.copy()
    v = np.full(n, u_drop0)
    t = np.zeros(n)
    K1 = np.empty(n)
    it1 = np.empty(n)
    dt1 = np.empty(n)
    D2p = np.empty(n)
    vp = np.empty(n)
    rem = np.empty(n)
    F = F0
    prev = np.zeros(ns)
    x95 = np.full(ns, np.nan)
    for i in range(n_steps):
        Ug1 = U_c * F
        for j in range(n):
            D = math.sqrt(D2[j])
            dU = abs(Ug1 - v[j])
            Re = rho_c * dU * D / mu[j]
            K1[j] = 4.0 * (2.0 + 0.6 * math.sqrt(rho_f[j] * dU * D / mu[j]) * pr3) * k_f[j] * lnB[j] / (rho_l[j] * cp_g)
            phi = 1.0 + Re ** (2.0 / 3.0) / 6.0 if Re <= 1000.0 else 0.424 * Re / 24.0
            it1[j] = 18.0 * mu[j] * phi / (rho_l[j] * D2[j])
            dt1[j] = dx / max(v[j], v_floor)
            t_ev = min(max(t[j] + dt1[j] - t_h[j], 0.0), dt1[j])
            D2p[j] = max(D2[j] - K1[j] * t_ev, 0.0) if t_ev > 0.0 else D2[j]
            vp[j] = Ug1 + (v[j] - Ug1) * math.exp(-dt1[j] * it1[j]) if D2[j] > 0.0 else Ug1
        Fp = 0.0
        for j in range(n):
            Fp += w_cls[j] * (1.0 - (D2p[j] / D2_0[j]) ** 1.5)
        Ug2 = U_c * (F0 + Fp)
        Ug = 0.5 * (Ug1 + Ug2)
        for j in range(n):
            D = math.sqrt(D2p[j])
            dU = abs(Ug2 - vp[j])
            Re = rho_c * dU * D / mu[j]
            K2 = 4.0 * (2.0 + 0.6 * math.sqrt(rho_f[j] * dU * D / mu[j]) * pr3) * k_f[j] * lnB[j] / (rho_l[j] * cp_g)
            phi = 1.0 + Re ** (2.0 / 3.0) / 6.0 if Re <= 1000.0 else 0.424 * Re / 24.0
            it2 = 18.0 * mu[j] * phi / (rho_l[j] * D2p[j])
            dt2 = dx / max(vp[j], v_floor)
            K = 0.5 * (K1[j] + K2)
            itau = 0.5 * (it1[j] + it2)
            dt = 0.5 * (dt1[j] + dt2)
            t_ev = min(max(t[j] + dt - t_h[j], 0.0), dt)
            D2n = max(D2[j] - K * t_ev, 0.0) if t_ev > 0.0 else D2[j]
            vn = Ug + (v[j] - Ug) * math.exp(-dt * itau) if D2[j] > 0.0 else Ug
            t[j] = t[j] + dt
            D2[j] = D2n
            v[j] = vn
        acc = 0.0
        for j in range(n):
            rem[j] = (D2[j] / D2_0[j]) ** 1.5
            acc += w_cls[j] * (1.0 - rem[j])
        F = F0 + acc
        x_i = (i + 1) * dx
        for s in range(ns):
            f = 0.0
            for k in range(nq):
                f += rr_w[k] * rem[starts[s] + k]
            f = 1.0 - f
            if math.isnan(x95[s]) and f >= 0.95:
                p = prev[s]
                x95[s] = x_i - dx * (f - 0.95) / (f - p) if f > p else x_i
            prev[s] = f
    return prev, x95, F


_march_core = _njit(cache=True, error_model="numpy")(_march_core_py) if _njit is not None else None


def _record(assumptions: List[Dict[str, Any]], name: str, value: Any, unit: str, reason: str) -> Any:
    """Note an assumed input in the result and in the process-wide assumptions registry."""
    from engine.pipeline.assumptions import assume
    assumptions.append({"name": name, "value": value, "unit": unit, "reason": reason})
    return assume(name, value, unit=unit, reason=reason)


def compute_combustion_state(
    Pc: float,
    Tc: float,
    R: float,
    Ac: float,
    At: float,
    Lstar: float,
    m_dot_total: float,
) -> Dict[str, float]:
    """Chamber gas state and stay time.

    tau_res is the stay time t_s = V_c rho / mdot = L* rho_c / (mdot/A_t) (Sutton & Biblarz ch. 8),
    the transit time of the gas at the chamber exit velocity.
    """
    for name, v in (("R", R), ("Tc", Tc), ("Ac", Ac), ("At", At), ("Lstar", Lstar),
                    ("m_dot_total", m_dot_total), ("Pc", Pc)):
        if not (np.isfinite(v) and v > 0):
            raise ValueError(f"Invalid {name}={v}. Must be positive and finite.")
    rho_ch = Pc / (R * Tc)
    U_bulk = m_dot_total / (rho_ch * Ac)
    G_throat = m_dot_total / At
    return {
        "rho_ch": float(rho_ch),
        "U_bulk": float(U_bulk),
        "G_throat": float(G_throat),
        "tau_res": float(Lstar * rho_ch / G_throat),
    }


def saturation_state(
    P: float,
    T_boil: float,
    L_boil: float,
    molecular_weight: float,
    T_crit: Optional[float] = None,
) -> Tuple[float, float]:
    """Surface temperature [K] and latent heat [J/kg] of a drop evaporating at pressure P.

    T_sat from Clausius-Clapeyron through the normal boiling point,
        1/T_sat = 1/T_boil - R_u/(M L_boil) ln(P/101325),
    and h_fg(T_sat) from Watson, h_fg = L_boil ((T_c - T_sat)/(T_c - T_boil))^0.38.
    At 2.977 MPa this gives ethanol 472.1 K / 503 kJ/kg and oxygen 143.6 K / 109 kJ/kg; CoolProp
    gives 473.1 / 506 and 141.5 / 120. At or above the critical pressure the surface reaches T_c
    and h_fg = 0. Without T_c the normal-boiling-point latent heat is kept, which overstates h_fg.
    """
    for name, v in (("P", P), ("T_boil", T_boil), ("L_boil", L_boil),
                    ("molecular_weight", molecular_weight)):
        if not (np.isfinite(v) and v > 0):
            raise ValueError(f"saturation_state: invalid {name}={v}")
    inv_T = 1.0 / T_boil - (R_UNIVERSAL_KMOL / (molecular_weight * L_boil)) * math.log(P / P_BOIL_REF)
    if T_crit is not None and np.isfinite(T_crit) and T_crit > 0:
        if T_crit <= T_boil:
            raise ValueError(f"saturation_state: T_crit={T_crit} K must exceed T_boil={T_boil} K")
        if inv_T <= 1.0 / T_crit:
            return float(T_crit), 0.0
        T_sat = 1.0 / inv_T
        return float(T_sat), float(L_boil * ((T_crit - T_sat) / (T_crit - T_boil)) ** WATSON_EXPONENT)
    if inv_T <= 0.0:
        raise ValueError(f"saturation_state: P={P:.3e} Pa is beyond Clausius-Clapeyron for this "
                         f"fluid and no critical temperature was given")
    return float(1.0 / inv_T), float(L_boil)


def _gas_viscosity(T: float, M_gas: float) -> float:
    from engine.pipeline.thermal.regen_cooling import calculate_gas_viscosity_huzel
    return float(calculate_gas_viscosity_huzel(T, M_gas))


def spray_vaporization_march(
    streams: List[Dict[str, float]],
    *,
    Pc: float,
    Tc: float,
    gamma: float,
    R: float,
    m_dot_total: float,
    Ac: float,
    L_chamber: float,
    u_drop0: float,
    rr_q: float,
) -> Dict[str, Any]:
    """Fraction of each stream vaporized along the chamber (Priem & Heidmann, NASA TR R-67).

    Each stream is a Rosin-Rammler spray (volume basis, X = D32 Gamma(1 - 1/q)) resolved into
    size classes. Drops leave the face at ``u_drop0``. The gas is the burned vaporized
    propellant: U_g(x) = U_c F(x), F the fraction vaporized, U_c = mdot/(rho_c A_c). Per class:

    - heat-up then evaporation, in series (Law, Prog. Energy Combust. Sci. 8, 1982):
      t_heat = rho_l c_pl D0^2 / (6 Nu0 k_f) ln((T_c - T_0)/(T_c - T_s)), lumped, at the face slip;
    - d^2-law, dD^2/dt = -K, K = 4 Nu k_f ln(1 + B)/(rho_l c_pg), B = c_pg (T_c - T_s)/h_fg
      (Spalding; Turns ch. 3 and 10), Nu = 2 + 0.6 Re_f^0.5 Pr^(1/3) (Ranz-Marshall);
    - drag, dv/dt = (U_g - v)/tau_p, tau_p = rho_l D^2/(18 mu_f phi), phi = 1 + Re^(2/3)/6 below
      Re = 1000 and 0.424 Re/24 above (Putnam), Re on free-stream density (Yuen & Chen 1976).

    Film properties at T_f = T_s + (T_c - T_s)/3 (1/3 rule): mu_f from Huzel & Huang,
    k_f = mu_f c_pg/Pr, rho_f = Pc/(R T_f), c_pg = gamma R/(gamma - 1).

    ``streams``: dicts with name, mass_fraction, D32, rho_l, cp_l, T0, T_s, h_fg; a stream with
    ``instant`` set is vaporized at the face.
    """
    if not (rr_q > 1.0 and np.isfinite(rr_q)):
        raise ValueError(f"Rosin-Rammler spread q={rr_q} must exceed 1")
    for name, v in (("Pc", Pc), ("Tc", Tc), ("R", R), ("m_dot_total", m_dot_total), ("Ac", Ac),
                    ("L_chamber", L_chamber), ("u_drop0", u_drop0)):
        if not (np.isfinite(v) and v > 0):
            raise ValueError(f"spray_vaporization_march: invalid {name}={v}")
    if not (np.isfinite(gamma) and gamma > 1.0):
        raise ValueError(f"spray_vaporization_march: invalid gamma={gamma}")

    cp_g = gamma * R / (gamma - 1.0)
    rho_c = Pc / (R * Tc)
    U_c = m_dot_total / (rho_c * Ac)
    M_gas = R_UNIVERSAL_KMOL / R
    Pr = PRANDTL_DEFAULT
    pr3 = Pr ** (1.0 / 3.0)
    x_scale = math.gamma(1.0 - 1.0 / rr_q)
    y_pow = _RR_NODES ** (1.0 / rr_q)
    nq = _RR_NODES.size

    F0 = 0.0
    cols: Dict[str, List[np.ndarray]] = {k: [] for k in
                                          ("D0", "w", "rho_l", "mu", "rho_f", "k", "lnB", "t_h")}
    marched: List[Tuple[str, float, slice]] = []
    for s in streams:
        w = float(s["mass_fraction"])
        if s.get("instant"):
            F0 += w
            continue
        T_s, h_fg, rho_l = float(s["T_s"]), float(s["h_fg"]), float(s["rho_l"])
        T_f = T_s + (Tc - T_s) / 3.0
        mu_f = _gas_viscosity(T_f, M_gas)
        k_f = mu_f * cp_g / Pr
        rho_f = Pc / (R * T_f)
        D0 = float(s["D32"]) * x_scale * y_pow
        Nu0 = 2.0 + 0.6 * np.sqrt(rho_f * u_drop0 * D0 / mu_f) * pr3
        # A drop injected at or above its surface temperature needs no heat-up.
        ln_heat = max(math.log((Tc - float(s["T0"])) / (Tc - T_s)), 0.0)
        t_h = rho_l * float(s["cp_l"]) * D0 ** 2 / (6.0 * Nu0 * k_f) * ln_heat
        lnB = math.log1p(cp_g * (Tc - T_s) / h_fg) if h_fg > 0 else math.inf
        i0 = sum(a.size for a in cols["D0"])
        marched.append((str(s["name"]), w, slice(i0, i0 + nq)))
        for key, val in (("D0", D0), ("w", w * _RR_WEIGHTS), ("rho_l", rho_l), ("mu", mu_f),
                         ("rho_f", rho_f), ("k", k_f), ("lnB", lnB), ("t_h", t_h)):
            cols[key].append(np.broadcast_to(np.asarray(val, dtype=float), (nq,)).copy())

    out: Dict[str, Any] = {"U_c": float(U_c), "L_chamber": float(L_chamber),
                           "u_drop0": float(u_drop0), "frac_vaporized": {}, "x_vap95": {}}
    for s in streams:
        if s.get("instant"):
            out["frac_vaporized"][str(s["name"])] = 1.0
            out["x_vap95"][str(s["name"])] = 0.0
    if not marched:
        out["F_throat"] = float(F0)
        return out

    D0, w_cls, rho_l, mu, rho_f, k_f, lnB, t_h = (np.concatenate(cols[k]) for k in
                                                   ("D0", "w", "rho_l", "mu", "rho_f", "k", "lnB", "t_h"))
    D2_0 = D0 ** 2
    dx = L_chamber / _MARCH_STEPS

    def _rates(D2: np.ndarray, v: np.ndarray, F: float):
        U_g = U_c * F
        D = np.sqrt(D2)
        dU = np.abs(U_g - v)
        Re_d = rho_c * dU * D / mu
        K = 4.0 * (2.0 + 0.6 * np.sqrt(rho_f * dU * D / mu) * pr3) * k_f * lnB / (rho_l * cp_g)
        phi = np.where(Re_d <= 1000.0, 1.0 + Re_d ** (2.0 / 3.0) / 6.0, 0.424 * Re_d / 24.0)
        inv_tau = 18.0 * mu * phi / (rho_l * D2)
        return U_g, K, inv_tau, dx / np.maximum(v, _V_FLOOR)

    def _advance(D2, v, t, U_g, K, inv_tau, dt):
        t_ev = np.clip(t + dt - t_h, 0.0, dt)
        D2n = np.where(t_ev > 0.0, np.maximum(D2 - K * t_ev, 0.0), D2)
        vn = np.where(D2 > 0.0, U_g + (v - U_g) * np.exp(-dt * inv_tau), U_g)
        return D2n, vn, t + dt

    def _vaporized(D2: np.ndarray) -> Tuple[np.ndarray, float]:
        rem = (D2 / D2_0) ** 1.5
        return rem, F0 + float(np.sum(w_cls * (1.0 - rem)))

    if _USE_COMPILED_MARCH:
        starts = np.array([sl.start for _, _, sl in marched], dtype=np.int64)
        fv, xv, F = _march_core(D2_0, w_cls, rho_l, mu, rho_f, k_f, lnB, t_h, float(U_c), float(rho_c),
                                float(pr3), float(cp_g), float(dx), int(_MARCH_STEPS), float(u_drop0),
                                float(F0), float(_V_FLOOR), _RR_WEIGHTS, starts, int(nq))
        for (name, _, _), f, x in zip(marched, fv, xv):
            out["frac_vaporized"][name] = float(f)
            out["x_vap95"][name] = None if math.isnan(x) else float(x)
        out["F_throat"] = float(F)
        return out

    D2 = D2_0.copy()
    v = np.full(D0.size, float(u_drop0))
    t = np.zeros(D0.size)
    F = F0
    prev = {name: 0.0 for name, _, _ in marched}
    x95 = {name: math.nan for name, _, _ in marched}
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        for i in range(_MARCH_STEPS):
            # Heun: rates at both ends of the step, averaged (trapezoid in x).
            r1 = _rates(D2, v, F)
            D2p, vp, _ = _advance(D2, v, t, *r1)
            r2 = _rates(D2p, vp, _vaporized(D2p)[1])
            D2, v, t = _advance(D2, v, t, *(0.5 * (a + b) for a, b in zip(r1, r2)))
            rem, F = _vaporized(D2)
            x_i = (i + 1) * dx
            for name, w, sl in marched:
                f = 1.0 - float(np.sum(_RR_WEIGHTS * rem[sl]))
                if math.isnan(x95[name]) and f >= 0.95:
                    p = prev[name]
                    x95[name] = x_i - dx * (f - 0.95) / (f - p) if f > p else x_i
                prev[name] = f
    for name, w, sl in marched:
        out["frac_vaporized"][name] = float(prev[name])
        out["x_vap95"][name] = None if math.isnan(x95[name]) else float(x95[name])
    out["F_throat"] = float(F)
    return out


def calculate_vaporization_efficiency(
    *,
    Pc: float,
    Tc: float,
    gamma: float,
    R: float,
    MR: float,
    m_dot_total: float,
    Ac: float,
    At: float,
    Lstar: float,
    spray_diagnostics: Dict[str, Any],
    fuel_props: Optional[Dict[str, Any]],
    ox_props: Optional[Dict[str, Any]],
    u_fuel: float,
    u_lox: float,
    rr_q: float,
    assumptions: List[Dict[str, Any]],
) -> Tuple[float, Dict[str, Any]]:
    """eta_vap = mass fraction vaporized at the throat (Priem & Heidmann, NASA TR R-67).

    The chamber is its volume-equivalent cylinder, L = L* A_t/A_c. Each stream evaporates at its
    own saturation state at Pc with its own D32 and liquid properties. The c* of the vaporized gas
    is not re-evaluated at its own O/F (no CEA table here); for a fuel-limited spray below the c*
    peak that is slightly conservative.
    """
    if not (np.isfinite(MR) and MR > 0):
        raise ValueError(f"Invalid MR={MR}")
    w_O = MR / (1.0 + MR)
    w_F = 1.0 / (1.0 + MR)
    diag = spray_diagnostics or {}

    def _d32(key: str) -> Optional[float]:
        try:
            v = float(diag.get(key))
        except (TypeError, ValueError):
            return None
        return v if (np.isfinite(v) and v > 0) else None

    def _instant(tag: str, w: float, why: str) -> Dict[str, Any]:
        label = "fuel" if tag == "F" else "oxidizer"
        _record(assumptions, f"combustion.vaporization.{label}", "vaporized at the face", "", why)
        return {"name": tag, "mass_fraction": w, "instant": True}

    def _stream(tag: str, w: float, props: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        label = "fuel" if tag == "F" else "oxidizer"
        D32 = _d32(f"D32_{tag}")
        if D32 is None:
            return _instant(tag, w, "no D32 from the injector")
        if props is None:
            return _instant(tag, w, f"fluids.{label} properties not passed to the c* model")
        p = dict(props)
        p["density"] = p.get("density") or diag.get(f"rho_{tag}_momentum")
        p["latent_heat"] = p.get("L_vap") or p.get("latent_heat")
        missing = [k for k in ("density", "boiling_point", "latent_heat", "molecular_weight") if not p.get(k)]
        if missing:
            return _instant(tag, w, f"fluids.{label} {', '.join(missing)} not passed to the c* model")
        for key, default, unit in (("specific_heat", 2000.0, "J/(kg K)"), ("temperature", 293.0, "K")):
            if p.get(key) is None:
                p[key] = _record(assumptions, f"combustion.vaporization.{label}.{key}", default, unit,
                                 f"fluids.{label}.{key} not passed to the c* model")
        T_crit = p.get("critical_temperature") or None
        if T_crit is None:
            _record(assumptions, f"combustion.vaporization.{label}.critical_temperature", None, "K",
                    "no critical temperature: latent heat kept at its normal-boiling-point value")
        T_s, h_fg = saturation_state(Pc, float(p["boiling_point"]), float(p["latent_heat"]),
                                     float(p["molecular_weight"]), T_crit)
        return {"name": tag, "mass_fraction": w, "D32": D32, "rho_l": float(p["density"]),
                "cp_l": float(p["specific_heat"]), "T0": float(p["temperature"]),
                "T_s": T_s, "h_fg": h_fg}

    if fuel_props is None:
        raise ValueError("fuel_props is required for the vaporization model.")
    if _d32("D32_O") is None and _d32("D32_F") is None:
        raise ValueError(f"spray_diagnostics must carry D32_O or D32_F; got keys {list(diag.keys())}")
    streams = [_stream("O", w_O, ox_props), _stream("F", w_F, fuel_props)]

    # Drops leave the impingement with the pair's axial momentum per unit mass,
    # u_ax = (mdot_O u_O cos th_O + mdot_F u_F cos th_F) / mdot (spray.spray_axial_velocity).
    u_ax = diag.get("u_axial_spray")
    try:
        u_ax = float(u_ax)
    except (TypeError, ValueError):
        u_ax = float("nan")
    if not (np.isfinite(u_ax) and u_ax > 0):
        u_mass = w_O * u_lox + w_F * u_fuel
        included = diag.get("impingement_angle_deg")
        if included is not None and np.isfinite(float(included)):
            u_ax = u_mass * math.cos(math.radians(0.5 * float(included)))
            _record(assumptions, "combustion.vaporization.spray_axial_velocity", u_ax, "m/s",
                    "u_axial_spray not in the injector diagnostics: both jets taken at half the "
                    "included impingement angle")
        else:
            u_ax = u_mass
            _record(assumptions, "combustion.vaporization.spray_axial_velocity", u_ax, "m/s",
                    "no impingement geometry: drops leave the face axially with the streams' "
                    "mass-averaged injection speed")

    L_ch = Lstar * At / Ac
    march = spray_vaporization_march(
        streams, Pc=Pc, Tc=Tc, gamma=gamma, R=R, m_dot_total=m_dot_total, Ac=Ac,
        L_chamber=L_ch, u_drop0=u_ax, rr_q=rr_q,
    )
    eta_vap = float(march["F_throat"])
    diag_out = {
        "frac_vaporized_O": march["frac_vaporized"].get("O"),
        "frac_vaporized_F": march["frac_vaporized"].get("F"),
        "x_vap95_O": march["x_vap95"].get("O"),
        "x_vap95_F": march["x_vap95"].get("F"),
        "L_chamber_equiv": float(L_ch),
        "u_drop0": float(u_ax),
        "rr_q": float(rr_q),
    }
    for s in streams:
        if not s.get("instant"):
            diag_out[f"T_surface_{s['name']}"] = s["T_s"]
            diag_out[f"h_fg_{s['name']}"] = s["h_fg"]
    return eta_vap, diag_out


def calculate_gasification_efficiency(
    Tc: float,
    Pc: float,
    tau_res: float,
    SMD: float,
    rho_l: float,
    cp_l: float,
    L_eff: float,
    T_inj: float,
    cp_g: float,
    rho_g: float,
    mu_g: float,
    U_slip: float,
    D_m: Optional[float] = None,
    Pr: float = 0.8,
    fuel_props: Optional[dict] = None,
    debug: bool = False,
) -> Tuple[float, Dict[str, float]]:
    """Single-drop gasification time scale. Used only by reaction_chemistry's progress diagnostics;
    c* comes from ``spray_vaporization_march``.

    eta = 1 - exp(-tau_res/tau_vap), tau_vap = tau_heat + tau_gasify: heat-up and gasification are
    successive stages of one drop's life, so their times add (Law 1982; Lefebvre, Atomization and
    Sprays ch. 8). They were combined as parallel rates, which made tau_vap shorter than either.
    """
    from engine.pipeline.physics_constants import (
        D_M_REF, D_M_T_REF, D_M_P_REF, U_SLIP_CAP, D_MIN_GASIFICATION
    )
    if Tc <= 0 or Pc <= 0 or tau_res <= 0:
        raise ValueError(f"Invalid inputs: Tc={Tc}, Pc={Pc}, tau_res={tau_res}")
    if SMD <= 0:
        raise ValueError(f"Invalid SMD: {SMD}")

    D = max(SMD, D_MIN_GASIFICATION)
    D_sq = D ** 2
    T_star_fuel_cap_K = fuel_props.get("T_star_fuel_cap_K", 1000.0) if fuel_props else 1000.0
    dT_safe = max(200.0, 0.10 * Tc)
    T_star = float(np.clip(min(T_star_fuel_cap_K, Tc - dT_safe), T_inj + 50.0, Tc - dT_safe))
    k_g = mu_g * cp_g / Pr
    if D_m is None:
        D_m = D_M_REF * (Tc / D_M_T_REF) ** 1.75 * (D_M_P_REF / max(Pc, 1e3))
    U_slip_capped = max(min(abs(U_slip), U_SLIP_CAP), 0.1)
    Re = rho_g * U_slip_capped * D / max(mu_g, 1e-10)
    Sc = mu_g / (rho_g * max(D_m, 1e-12))
    Nu = 2.0 + 0.6 * np.sqrt(max(Re, 0.0)) * (Pr ** (1.0 / 3.0))
    Sh = 2.0 + 0.6 * np.sqrt(max(Re, 0.0)) * (Sc ** (1.0 / 3.0))
    dT_initial, dT_final = Tc - T_inj, Tc - T_star
    if dT_final <= 0 or dT_initial <= dT_final:
        tau_heat = 0.0
    else:
        tau_heat = (rho_l * cp_l * D_sq) / (6.0 * Nu * k_g) * np.log(dT_initial / dT_final)
    energy_available = cp_g * (Tc - T_star)
    Phi = float(np.clip(energy_available / max(energy_available + L_eff, 1e-6), 1e-6, 1.0))
    denominator = 6.0 * rho_g * D_m * Sh * Phi
    tau_gasify = (rho_l * D_sq) / denominator if denominator > 0 else np.inf
    tau_vap = tau_heat + tau_gasify
    eta_vap = 1.0 - np.exp(-tau_res / tau_vap) if (np.isfinite(tau_vap) and tau_vap > 0) else 1.0
    diagnostics = {
        "tau_heat": float(tau_heat),
        "tau_gasify": float(tau_gasify),
        "tau_vap": float(tau_vap),
        "T_star": float(T_star),
        "Nu": float(Nu),
        "Sh": float(Sh),
        "Phi": float(Phi),
        "k_g": float(k_g),
        "D_m": float(D_m),
        "U_slip_capped": float(U_slip_capped),
        "Re": float(Re),
        "Sc": float(Sc),
        "D": float(D),
    }
    return float(eta_vap), diagnostics


def rupe_mixing_parameter(
    rho_O: float, v_O: float, d_O: float,
    rho_F: float, v_F: float, d_F: float,
) -> float:
    """Elverum & Morey mixing parameter M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F).

    JPL Memo 30-5 (1959) eq. 1, SP-8089 eq. 1: mixture-ratio uniformity of an unlike element is
    best at M = M_opt, 1.0 for a 1-on-1 doublet (SP-8089 Table IV). No angle term.
    """
    num = rho_O * v_O * v_O * d_O
    den = rho_F * v_F * v_F * d_F
    if not (np.isfinite(num) and np.isfinite(den) and num > 0 and den > 0):
        raise ValueError(f"Rupe M needs positive rho, v, d on both streams; got {num} / {den}")
    return float(num / den)


def rupe_M_from_diagnostics(diag: Optional[Dict[str, Any]]) -> Optional[float]:
    """Rupe M from injector diagnostics: ``rupe_M`` if published, else from the jet state
    (rho_*_momentum, v_*_bulk, d_jet_*), else from momentum_ratio_R and the jet diameters
    (M = R^2 d_O/d_F). None when the injector is not an impinging doublet."""
    if not diag:
        return None

    def _f(key: str) -> float:
        try:
            return float(diag.get(key))
        except (TypeError, ValueError):
            return float("nan")

    M = _f("rupe_M")
    if np.isfinite(M) and M > 0:
        return M
    rO, vO, dO = _f("rho_O_momentum"), _f("v_O_bulk"), _f("d_jet_O")
    rF, vF, dF = _f("rho_F_momentum"), _f("v_F_bulk"), _f("d_jet_F")
    if all(np.isfinite(x) and x > 0 for x in (rO, vO, dO, rF, vF, dF)):
        return rupe_mixing_parameter(rO, vO, dO, rF, vF, dF)
    Rm = _f("momentum_ratio_R")
    if all(np.isfinite(x) and x > 0 for x in (Rm, dO, dF)):
        return float(Rm * Rm * dO / dF)
    return None


def rupe_R_opt_from_angles(
    theta_O_deg: Optional[float],
    theta_F_deg: Optional[float],
    d_O: Optional[float] = None,
    d_F: Optional[float] = None,
) -> float:
    """Momentum ratio R = sqrt(rho_O u_O^2 / rho_F u_F^2) at which a doublet's resultant is axial.

    The transverse momenta cancel when mdot_O u_O sin(theta_O) = mdot_F u_F sin(theta_F), i.e.
    rho_O u_O^2 A_O sin(theta_O) = rho_F u_F^2 A_F sin(theta_F), so
        R_tilt = (d_F/d_O) sqrt(sin(theta_F)/sin(theta_O)).
    This sets the spray direction, not the mixing optimum (that is Rupe's M = 1); the c* model does
    not use it. Without diameters the orifices are taken equal. 1.0 without angles.
    """
    if theta_O_deg is None or theta_F_deg is None:
        return 1.0
    sO = np.sin(np.deg2rad(float(theta_O_deg)))
    sF = np.sin(np.deg2rad(float(theta_F_deg)))
    if not (np.isfinite(sO) and np.isfinite(sF)) or sO <= 0.0 or sF <= 0.0:
        return 1.0
    area = 1.0
    if d_O is not None and d_F is not None and d_O > 0 and d_F > 0:
        area = float(d_F) / float(d_O)
    return float(area * np.sqrt(sF / sO))


def calculate_rupe_mixing_efficiency(
    rupe_M: float,
    M_opt: float,
    Em_peak: float,
    sigma: float,
) -> float:
    """eta_mix = Em_peak exp(-(ln sqrt(M/M_opt))^2 / (2 sigma^2)).

    Em_peak is the assumed c* mixing efficiency at the optimum. sigma is the log-Gaussian width in
    ln sqrt(M), the scale of the old momentum-ratio model (sqrt(M) = R sqrt(d_O/d_F)).
    """
    M = float(rupe_M)
    Mo = float(M_opt)
    if not (np.isfinite(M) and M > 0.0):
        raise ValueError(f"Rupe mixing efficiency needs a positive, finite M; got {rupe_M}.")
    if not (np.isfinite(Mo) and Mo > 0.0):
        raise ValueError(f"Invalid rupe_M_opt={M_opt}. Must be positive.")
    if not (np.isfinite(sigma) and sigma > 0.0):
        raise ValueError(f"Invalid mixing_sigma={sigma}. Must be positive.")
    z = 0.5 * math.log(M / Mo)
    eta_mix = float(Em_peak) * math.exp(-(z * z) / (2.0 * sigma * sigma))
    if not np.isfinite(eta_mix):
        raise ValueError(f"Non-finite eta_mix from M={M}, M_opt={Mo}, Em_peak={Em_peak}, sigma={sigma}.")
    return float(eta_mix)


def calculate_combustion_efficiency_advanced(
    Lstar: float,
    Pc: float,
    Tc: float,
    cstar_ideal: float,
    gamma: float,
    R: float,
    MR: float,
    config: CombustionEfficiencyConfig,
    Ac: float,
    At: float,
    m_dot_total: float,
    u_fuel: Optional[float] = None,
    u_lox: Optional[float] = None,
    spray_diagnostics: Optional[Dict] = None,
    fuel_props: Optional[Dict] = None,
    ox_props: Optional[Dict] = None,
    debug: bool = False,
) -> Dict[str, Any]:
    """eta_vap * eta_mix. Heat loss is applied by combustion_eff.eta_cstar.

    Returns eta_total, eta_vaporization, eta_mixing, the inputs that set them and the assumptions
    made for missing inputs.
    """
    if u_fuel is None or u_lox is None:
        raise ValueError("u_fuel and u_lox (injection velocities, diagnostics 'u_F'/'u_O') are required.")
    assumptions: List[Dict[str, Any]] = []
    state = compute_combustion_state(Pc, Tc, R, Ac, At, Lstar, m_dot_total)

    vap_diag: Dict[str, Any] = {}
    if config.model == "constant":
        eta_vap = 1.0 - config.C
    elif config.model == "linear":
        eta_vap = float(np.clip(1.0 - config.C * (1.0 - Lstar / 1.0), 0.0, 1.0))
    else:
        if spray_diagnostics is None:
            raise ValueError("spray_diagnostics (D32_O/D32_F, u_O/u_F) are required for the vaporization model.")
        eta_vap, vap_diag = calculate_vaporization_efficiency(
            Pc=Pc, Tc=Tc, gamma=gamma, R=R, MR=MR, m_dot_total=m_dot_total, Ac=Ac, At=At,
            Lstar=Lstar, spray_diagnostics=spray_diagnostics, fuel_props=fuel_props,
            ox_props=ox_props, u_fuel=float(u_fuel), u_lox=float(u_lox),
            rr_q=float(config.spray_size_spread_q), assumptions=assumptions,
        )

    Em_peak = float(config.Em_peak)
    sigma = float(config.mixing_sigma)
    M_opt = float(config.rupe_M_opt)
    rupe_M = rupe_M_from_diagnostics(spray_diagnostics)
    if rupe_M is not None:
        eta_mixing = calculate_rupe_mixing_efficiency(rupe_M, M_opt, Em_peak, sigma)
        mixing_basis = "Rupe M against M_opt"
    else:
        # Pintle and coaxial elements have no Rupe M; their mixing is taken at the assumed peak.
        eta_mixing = Em_peak
        mixing_basis = "assumed peak (no impinging-element Rupe M)"

    eta_total = eta_vap * eta_mixing
    return {
        "eta_total": float(eta_total),
        "eta_vaporization": float(eta_vap),
        "eta_mixing": float(eta_mixing),
        "rupe_M": float(rupe_M) if rupe_M is not None else None,
        "rupe_M_opt": M_opt,
        "Em_peak": Em_peak,
        "mixing_sigma": sigma,
        "mixing_basis": mixing_basis,
        "vaporization_model": str(config.model),
        "tau_res": state["tau_res"],
        **vap_diag,
        "assumptions": assumptions,
    }
