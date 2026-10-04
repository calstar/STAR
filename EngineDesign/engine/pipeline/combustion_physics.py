"""c* efficiency physics: vaporization and mixing.

    eta_c* = eta_vap * eta_mix * eta_HL

eta_HL, the heat lost to the wall upstream of the throat, is applied in combustion_eff.eta_cstar.

- eta_vap: c* retained by incomplete vaporization, F c*(O/F_vap)/c*(O/F), F the mass fraction
  vaporized by the throat from a one-dimensional spray march started where the doublet's sheet
  breaks into drops, in the manner of Priem & Heidmann (NASA TR R-67, 1960).
- eta_mix: the stream-tube c* integral (Pieper, Dean & Valentine, JSR 4(6), 1967) of an O/F
  distribution that reproduces Rupe's mixing factor E_m (JPL TR 32-1546 eq. 1), E_m from Rupe's
  correlation against M = rho_O v_O^2 d_O / (rho_F v_F^2 d_F) (TR 32-1546 Fig. 1), plus any
  element-to-element striation the injector reports. c*(O/F) is CEA.
- Chemical kinetics carry no c* loss. At ~3200 K and ~3 MPa the LOX/ethanol products relax in about
  a microsecond (CO + OH, H + OH + M) against a millisecond stay time. Kinetic losses belong to the
  nozzle, where CEA's frozen and shifting Cf bracket them (JANNAF, CPIA 246).
"""

from __future__ import annotations

import json
import math
import os
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


def _march_core_py(D2_0, w_cls, rho_l, mu, rho_f, k_f, lnB, t_h, inv_FB, cd_blow, U_c, rho_c, pr3,
                   cp_g, dx, n_steps, u_drop0, F0, v_floor, rr_w, starts, nq):
    """The Heun march of ``spray_vaporization_march`` as scalar loops, for compilation.

    Same formulas and step order as the NumPy loop there; returns (fraction vaporized per stream,
    x at 95 % per stream (NaN if not reached), F at the end). ``inv_FB`` divides the convective
    part of Nu (Abramzon-Sirignano) and ``cd_blow`` multiplies the drag of an evaporating drop
    (Yuen-Chen); both are 1 with the blowing model off.
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
            if D2[j] == 0.0:
                # Gone: D^2 stays 0 and nothing reads this class's velocity or clock again, so
                # its rates are not computed (the sums below see exactly what they saw before).
                D2p[j] = 0.0
                continue
            D = math.sqrt(D2[j])
            dU = abs(Ug1 - v[j])
            Re = rho_c * dU * D / mu[j]
            K1[j] = 4.0 * (2.0 + 0.6 * math.sqrt(rho_f[j] * dU * D / mu[j]) * pr3 * inv_FB[j]) * k_f[j] * lnB[j] / (rho_l[j] * cp_g)
            phi = 1.0 + Re ** (2.0 / 3.0) / 6.0 if Re <= 1000.0 else 0.424 * Re / 24.0
            if t[j] > t_h[j]:
                phi *= cd_blow[j]
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
            if D2[j] == 0.0:
                continue
            D = math.sqrt(D2p[j])
            dU = abs(Ug2 - vp[j])
            Re = rho_c * dU * D / mu[j]
            K2 = 4.0 * (2.0 + 0.6 * math.sqrt(rho_f[j] * dU * D / mu[j]) * pr3 * inv_FB[j]) * k_f[j] * lnB[j] / (rho_l[j] * cp_g)
            phi = 1.0 + Re ** (2.0 / 3.0) / 6.0 if Re <= 1000.0 else 0.424 * Re / 24.0
            if t[j] + dt1[j] > t_h[j]:
                phi *= cd_blow[j]
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


# --------------------------------------------------------------------------- c*(O/F) off the table
# The stream-tube mixing integral and the vaporized-gas O/F need c* well outside a design's CEA
# cache (LOX/ethanol caches span O/F 1.0-2.5; a Rupe E_m of 0.8 puts ~40 % of a Gaussian's mass
# outside that). This is a second CEA table, c* only, over O/F 0.1-20 on the aux-table Pc grid,
# built once per propellant pair from rocketcea (same CEA_Obj(oxName, fuelName) cards as the
# cache) and committed beside it.
CSTAR_WIDE_SCHEMA_VERSION = 1
_CSTAR_WIDE_MR = np.geomspace(0.1, 20.0, 161)
_CSTAR_WIDE_PC = np.geomspace(1.0e5, 1.2e7, 16)      # Pa (the aux-table grid)
_PSI_PA = 6894.757293168361
_FT_M = 0.3048
_CSTAR_WIDE_MEMO: Dict[Tuple[str, str], Optional["CstarWideTable"]] = {}


class CstarWideTable:
    """c* [m/s] on (O/F, Pc) from CEA, interpolated linearly in (ln O/F, ln Pc)."""

    def __init__(self, ox_name: str, fuel_name: str, MR: np.ndarray, Pc: np.ndarray,
                 cstar: np.ndarray, path: Optional[str] = None):
        self.ox_name, self.fuel_name, self.path = ox_name, fuel_name, path
        self.MR, self.Pc, self.cstar = np.asarray(MR, float), np.asarray(Pc, float), np.asarray(cstar, float)
        self._lnMR, self._lnPc = np.log(self.MR), np.log(self.Pc)
        self.MR_min, self.MR_max = float(self.MR[0]), float(self.MR[-1])

    @staticmethod
    def default_path(ox_name: str, fuel_name: str) -> str:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return os.path.join(root, "output", "cache", f"cstar_wide_{ox_name}_{fuel_name}.npz")

    @classmethod
    def load(cls, ox_name: str, fuel_name: str, path: Optional[str] = None) -> Optional["CstarWideTable"]:
        path = path or cls.default_path(ox_name, fuel_name)
        if not os.path.exists(path):
            return None
        with np.load(path, allow_pickle=False) as d:
            try:
                meta = json.loads(str(d["meta"]))
            except Exception:
                return None
            if (meta.get("schema") != CSTAR_WIDE_SCHEMA_VERSION or meta.get("ox_name") != ox_name
                    or meta.get("fuel_name") != fuel_name):
                return None
            return cls(ox_name, fuel_name, d["MR"], d["Pc"], d["cstar"], path)

    @classmethod
    def build(cls, ox_name: str, fuel_name: str, path: Optional[str] = None) -> "CstarWideTable":
        from rocketcea.cea_obj import CEA_Obj
        C = CEA_Obj(oxName=ox_name, fuelName=fuel_name)
        tab = np.full((_CSTAR_WIDE_MR.size, _CSTAR_WIDE_PC.size), np.nan)
        for i, mr in enumerate(_CSTAR_WIDE_MR):
            for j, pc in enumerate(_CSTAR_WIDE_PC):
                try:
                    v = float(C.get_Cstar(float(pc) / _PSI_PA, float(mr))) * _FT_M
                except Exception:
                    v = float("nan")
                tab[i, j] = v if (np.isfinite(v) and v > 0) else np.nan
        if np.isnan(tab).any():
            raise RuntimeError(f"CEA returned no c* at {int(np.isnan(tab).sum())} points for "
                               f"{ox_name}/{fuel_name}; the wide c* table would have holes")
        path = path or cls.default_path(ox_name, fuel_name)
        meta = {"schema": CSTAR_WIDE_SCHEMA_VERSION, "ox_name": ox_name, "fuel_name": fuel_name,
                "source": "rocketcea CEA_Obj.get_Cstar (equilibrium chamber)"}
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            np.savez(path, MR=_CSTAR_WIDE_MR, Pc=_CSTAR_WIDE_PC, cstar=tab, meta=json.dumps(meta))
        except OSError:
            pass
        return cls(ox_name, fuel_name, _CSTAR_WIDE_MR, _CSTAR_WIDE_PC, tab, path)

    def row(self, Pc: float) -> np.ndarray:
        """c*(O/F grid) at Pc, linear in ln Pc (clamped to the grid: c* moves ~1 % per doubling)."""
        x = float(np.clip(math.log(Pc), self._lnPc[0], self._lnPc[-1]))
        j = int(np.clip(np.searchsorted(self._lnPc, x) - 1, 0, self._lnPc.size - 2))
        f = (x - self._lnPc[j]) / (self._lnPc[j + 1] - self._lnPc[j])
        return (1.0 - f) * self.cstar[:, j] + f * self.cstar[:, j + 1]


def get_cstar_wide_table(ox_name: str, fuel_name: str) -> Optional[CstarWideTable]:
    """The committed wide c* table for a propellant pair; built from rocketcea when missing and CEA
    builds are allowed (cea_cache._cea_build_allowed). None when neither is possible."""
    key = (str(ox_name), str(fuel_name))
    if key in _CSTAR_WIDE_MEMO:
        return _CSTAR_WIDE_MEMO[key]
    tab = CstarWideTable.load(*key)
    if tab is None:
        from engine.pipeline.cea_cache import _cea_build_allowed
        if _cea_build_allowed():
            try:
                tab = CstarWideTable.build(*key)
            except Exception:
                tab = None
    _CSTAR_WIDE_MEMO[key] = tab
    return tab


class CstarOfMR:
    """c*(O/F) at one chamber pressure, for ratios of c* between stream tubes.

    One function serves numerator and denominator, so a perfectly mixed spray gives exactly 1.
    Source, in order: the wide CEA table (O/F 0.1-20); else the design's CEA cache inside its O/F
    range. Beyond either range the tube is the edge mixture diluted with unburned propellant:
    with cp and molecular weight held, T0 and so c*^2 scale with the limiting propellant's
    fraction, c* = c*_edge sqrt(r/r_edge) (fuel side) or sqrt((1 - r)/(1 - r_edge)) (oxidizer
    side), r = O/(O + F). Against rocketcea for LOX/ethanol at 374 psia from the 1.0/2.5 edges this
    is +8 % at O/F 0.7, -4 % at 0.3, -3 % at 3.0, -14 % at 6. Every use is recorded
    (``outside``) so the caller can say how much mass rode on it.
    """

    def __init__(self, Pc: float, wide: Optional[CstarWideTable] = None, cea_cache: Any = None):
        if wide is None and cea_cache is None:
            raise ValueError("c*(O/F) needs the wide CEA c* table or the design's CEA cache")
        self.Pc = float(Pc)
        if wide is not None:
            self.source = f"CEA c* table O/F {wide.MR_min:g}-{wide.MR_max:g} ({os.path.basename(wide.path or '')})"
            self._lnMR = wide._lnMR
            self._row = wide.row(self.Pc)
            self.MR_lo, self.MR_hi = wide.MR_min, wide.MR_max
            self._cache = None
        else:
            self.MR_lo, self.MR_hi = float(cea_cache.MR_min), float(cea_cache.MR_max)
            self.source = f"design CEA cache O/F {self.MR_lo:g}-{self.MR_hi:g}"
            self._cache = cea_cache
        self.r_lo = self.MR_lo / (1.0 + self.MR_lo)
        self.r_hi = self.MR_hi / (1.0 + self.MR_hi)
        self._c_lo = float(self._in_range(np.array([self.MR_lo]))[0])
        self._c_hi = float(self._in_range(np.array([self.MR_hi]))[0])

    def _in_range(self, mr: np.ndarray) -> np.ndarray:
        if self._cache is None:
            return np.interp(np.log(mr), self._lnMR, self._row)
        return np.array([float(self._cache.eval(float(m), self.Pc)["cstar_ideal"]) for m in mr])

    def of_fraction(self, r: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """c* at oxidizer mass fractions r = O/(O+F) in [0, 1]; returns (c*, outside-range mask)."""
        r = np.clip(np.asarray(r, dtype=float), 0.0, 1.0)
        out = np.empty_like(r)
        lo, hi = r < self.r_lo, r > self.r_hi
        mid = ~(lo | hi)
        if mid.any():
            rm = r[mid]
            out[mid] = self._in_range(np.clip(rm / (1.0 - rm), self.MR_lo, self.MR_hi))
        out[lo] = self._c_lo * np.sqrt(r[lo] / self.r_lo)
        out[hi] = self._c_hi * np.sqrt((1.0 - r[hi]) / (1.0 - self.r_hi))
        return out, (lo | hi)

    def __call__(self, MR: float) -> float:
        MR = float(MR)
        r = 1.0 if not np.isfinite(MR) else MR / (1.0 + MR)
        return float(self.of_fraction(np.array([r]))[0][0])


# --------------------------------------------------------------------------- liquid properties
#: Config fluid names -> CoolProp names. A name not here is tried as given.
_COOLPROP_ALIASES = {"LOX": "Oxygen", "O2": "Oxygen", "GOX": "Oxygen", "LCH4": "Methane",
                     "CH4": "Methane", "LNG": "Methane", "LH2": "Hydrogen", "H2": "Hydrogen",
                     "N2O": "NitrousOxide", "H2O2": None, "RP-1": None, "RP1": None,
                     "Kerosene": None, "Jet-A": None}
_AS_MEMO: Dict[str, Any] = {}
_HEATUP_GL_X, _HEATUP_GL_W = np.polynomial.legendre.leggauss(24)


def _coolprop_state(name: Optional[str]):
    if not name:
        return None
    cp_name = _COOLPROP_ALIASES.get(str(name), str(name))
    if cp_name is None:
        return None
    if cp_name in _AS_MEMO:
        return _AS_MEMO[cp_name]
    try:
        import CoolProp.CoolProp as CP
        st = (CP, CP.AbstractState("HEOS", cp_name))
    except Exception:
        st = None
    _AS_MEMO[cp_name] = st
    return st


def liquid_heatup_properties(name: Optional[str], P: float, T0: float, T_s: float,
                             Tc: float) -> Optional[Dict[str, float]]:
    """Heat-up integral I = int_{T0}^{Ts} cp_l(T, P) dT / (T_c - T) and the liquid density at the
    mean drop temperature (T0 + Ts)/2, from CoolProp for the named fluid. None when CoolProp does
    not know the fluid.

    The drop's surface temperature Ts comes from Clausius-Clapeyron; when it lies above CoolProp's
    own T_sat(P) the liquid is integrated to T_sat - 0.05 K and the last sliver is carried at the
    cp there (reported as ``T_liquid_limit``). Above the critical pressure there is no saturation
    and the liquid is integrated to Ts.
    """
    st = _coolprop_state(name)
    if st is None or not (T_s > T0):
        return None
    CP, AS = st
    try:
        try:
            AS.update(CP.PQ_INPUTS, float(P), 0.0)
            T_lim = float(AS.T()) - 0.05
        except Exception:
            T_lim = float("inf")        # supercritical: single phase to Ts
        T_hi = min(float(T_s), T_lim)
        if not T_hi > T0:
            return None
        Tn = 0.5 * (T_hi - T0) * (_HEATUP_GL_X + 1.0) + T0
        cp = np.empty_like(Tn)
        for k, T in enumerate(Tn):
            AS.update(CP.PT_INPUTS, float(P), float(T))
            cp[k] = AS.cpmass()
        I = 0.5 * (T_hi - T0) * float(np.sum(_HEATUP_GL_W * cp / (Tc - Tn)))
        if T_s > T_hi:
            AS.update(CP.PT_INPUTS, float(P), T_hi)
            I += float(AS.cpmass()) * math.log((Tc - T_hi) / (Tc - T_s))
        T_mean = 0.5 * (T0 + min(float(T_s), T_hi))
        AS.update(CP.PT_INPUTS, float(P), T_mean)
        rho = float(AS.rhomass())
        cp_mean = I / math.log((Tc - T0) / (Tc - T_s))
    except Exception:
        return None
    if not all(np.isfinite(v) and v > 0 for v in (I, rho, cp_mean)):
        return None
    return {"heatup_integral": float(I), "rho_l": rho, "T_mean": float(T_mean),
            "cp_l_effective": float(cp_mean), "T_liquid_limit": float(T_hi)}


#: Droplet blowing (Stefan-flow) models for the march. Named so a run report says which law set
#: the vaporization rate. The Spalding transfer numbers here are B_T = 16-80 (LOX and ethanol in a
#: ~3200 K gas), far past the B < 1-ish range where uncorrected Ranz-Marshall convection and
#: solid-sphere drag hold.
BLOWING_MODELS = ("abramzon_sirignano", "none")


def abramzon_sirignano_F(B: float) -> float:
    """Film-thickening factor F(B) = (1 + B)^0.7 ln(1 + B) / B (Abramzon & Sirignano, Int. J. Heat
    Mass Transfer 32(9), 1989, eq. 19). Nu* = 2 + (Nu0 - 2)/F(B_T): the Stefan flow thickens the
    film and cuts the convective part of the heat transfer. F(0) = 1."""
    if not (np.isfinite(B) and B >= 0.0):
        raise ValueError(f"abramzon_sirignano_F: B={B} must be finite and >= 0")
    if B < 1e-8:
        return 1.0
    return float((1.0 + B) ** 0.7 * math.log1p(B) / B)


def yuen_chen_drag_factor(B: float) -> float:
    """C_D of an evaporating drop over the standard curve at film properties, (1 + B)^-0.2
    (Yuen & Chen, Combust. Sci. Technol. 14, 1976, eq. 5; Faeth, PECS 9, 1983)."""
    if not (np.isfinite(B) and B >= 0.0):
        raise ValueError(f"yuen_chen_drag_factor: B={B} must be finite and >= 0")
    return float((1.0 + B) ** -0.2)


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
    blowing: str = "abramzon_sirignano",
    profile_points: int = 0,
) -> Dict[str, Any]:
    """Fraction of each stream vaporized along the chamber (Priem & Heidmann, NASA TR R-67).

    ``profile_points`` > 0 also records each stream's fraction vaporized at about that many
    stations (``out["profile"][name] = [[x, f], ...]``, x from where the drops form). It runs the
    Python march, which the compiled one matches (tests/test_compiled_hot_loops.py); 0, the
    default, is the solver's path and records nothing.

    Each stream is a Rosin-Rammler spray (volume basis, X = D32 Gamma(1 - 1/q)) resolved into
    size classes. Drops start at ``u_drop0`` where they form (the caller places that plane, and
    ``L_chamber`` is the distance from it to the throat). The gas is the burned vaporized
    propellant: U_g(x) = U_c F(x), F the fraction vaporized, U_c = mdot/(rho_c A_c). Per class:

    - heat-up then evaporation, in series (Law, Prog. Energy Combust. Sci. 8, 1982), lumped, at
      the initial slip: t_heat = rho_l D0^2 / (6 Nu0 k_f) * I, I = int_{T0}^{Ts} cp_l dT/(T_c - T)
      (``heatup_integral`` when the caller has the liquid's cp(T); else cp_l ln((T_c - T0)/(T_c - Ts)));
    - d^2-law, dD^2/dt = -K, K = 4 Nu k_f ln(1 + B)/(rho_l c_pg), B = c_pg (T_c - T_s)/h_fg
      (Spalding; Turns ch. 3 and 10), Nu = 2 + 0.6 Re_f^0.5 Pr^(1/3) (Ranz-Marshall);
    - drag, dv/dt = (U_g - v)/tau_p, tau_p = rho_l D^2/(18 mu_f phi), phi = 1 + Re^(2/3)/6 below
      Re = 1000 and 0.424 Re/24 above (Putnam), Re on free-stream density (Yuen & Chen 1976).

    ``blowing`` = "abramzon_sirignano" corrects both for the Stefan flow of an evaporating drop:
    Nu* = 2 + (Nu0 - 2)/F(B) (Abramzon & Sirignano 1989) and C_D (1 + B)^-0.2 (Yuen & Chen 1976),
    applied while the drop evaporates (not during heat-up). "none" is the uncorrected laws.

    Film properties at T_f = T_s + (T_c - T_s)/3 (1/3 rule): mu_f from Huzel & Huang,
    k_f = mu_f c_pg/Pr, rho_f = Pc/(R T_f), c_pg = gamma R/(gamma - 1).

    ``streams``: dicts with name, mass_fraction, D32, rho_l, cp_l, T0, T_s, h_fg (and optionally
    heatup_integral); a stream with ``instant`` set is vaporized at the face.
    """
    if blowing not in BLOWING_MODELS:
        raise ValueError(f"blowing model {blowing!r} is not one of {BLOWING_MODELS}")
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
    keys = ("D0", "w", "rho_l", "mu", "rho_f", "k", "lnB", "t_h", "inv_FB", "cd_blow")
    cols: Dict[str, List[np.ndarray]] = {k: [] for k in keys}
    marched: List[Tuple[str, float, slice]] = []
    blow_out: Dict[str, Dict[str, float]] = {}
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
        I_heat = s.get("heatup_integral")
        if I_heat is None:
            # A drop injected at or above its surface temperature needs no heat-up.
            I_heat = float(s["cp_l"]) * max(math.log((Tc - float(s["T0"])) / (Tc - T_s)), 0.0)
        t_h = rho_l * D0 ** 2 / (6.0 * Nu0 * k_f) * max(float(I_heat), 0.0)
        B = cp_g * (Tc - T_s) / h_fg if h_fg > 0 else math.inf
        lnB = math.log1p(B)
        inv_FB, cd_blow = 1.0, 1.0
        if blowing == "abramzon_sirignano" and np.isfinite(B):
            inv_FB = 1.0 / abramzon_sirignano_F(B)
            cd_blow = yuen_chen_drag_factor(B)
        blow_out[str(s["name"])] = {"B_T": float(B), "F_B": 1.0 / inv_FB, "drag_factor": cd_blow}
        i0 = sum(a.size for a in cols["D0"])
        marched.append((str(s["name"]), w, slice(i0, i0 + nq)))
        for key, val in (("D0", D0), ("w", w * _RR_WEIGHTS), ("rho_l", rho_l), ("mu", mu_f),
                         ("rho_f", rho_f), ("k", k_f), ("lnB", lnB), ("t_h", t_h),
                         ("inv_FB", inv_FB), ("cd_blow", cd_blow)):
            cols[key].append(np.broadcast_to(np.asarray(val, dtype=float), (nq,)).copy())

    out: Dict[str, Any] = {"U_c": float(U_c), "L_chamber": float(L_chamber),
                           "u_drop0": float(u_drop0), "frac_vaporized": {}, "x_vap95": {},
                           "blowing_model": blowing, "blowing": blow_out}
    for s in streams:
        if s.get("instant"):
            out["frac_vaporized"][str(s["name"])] = 1.0
            out["x_vap95"][str(s["name"])] = 0.0
    if not marched:
        out["F_throat"] = float(F0)
        return out

    D0, w_cls, rho_l, mu, rho_f, k_f, lnB, t_h, inv_FB, cd_blow = (np.concatenate(cols[k]) for k in keys)
    D2_0 = D0 ** 2
    dx = L_chamber / _MARCH_STEPS

    def _rates(D2: np.ndarray, v: np.ndarray, F: float, t_drag: np.ndarray):
        U_g = U_c * F
        D = np.sqrt(D2)
        dU = np.abs(U_g - v)
        Re_d = rho_c * dU * D / mu
        K = 4.0 * (2.0 + 0.6 * np.sqrt(rho_f * dU * D / mu) * pr3 * inv_FB) * k_f * lnB / (rho_l * cp_g)
        phi = np.where(Re_d <= 1000.0, 1.0 + Re_d ** (2.0 / 3.0) / 6.0, 0.424 * Re_d / 24.0)
        phi = np.where(t_drag > t_h, phi * cd_blow, phi)
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

    if _USE_COMPILED_MARCH and not profile_points:
        starts = np.array([sl.start for _, _, sl in marched], dtype=np.int64)
        fv, xv, F = _march_core(D2_0, w_cls, rho_l, mu, rho_f, k_f, lnB, t_h, inv_FB, cd_blow,
                                float(U_c), float(rho_c), float(pr3), float(cp_g), float(dx),
                                int(_MARCH_STEPS), float(u_drop0), float(F0), float(_V_FLOOR),
                                _RR_WEIGHTS, starts, int(nq))
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
    every = max(1, _MARCH_STEPS // int(profile_points)) if profile_points else 0
    prof: Dict[str, List[List[float]]] = {name: [[0.0, 0.0]] for name, _, _ in marched}
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        for i in range(_MARCH_STEPS):
            # Heun: rates at both ends of the step, averaged (trapezoid in x).
            r1 = _rates(D2, v, F, t)
            D2p, vp, _ = _advance(D2, v, t, *r1)
            r2 = _rates(D2p, vp, _vaporized(D2p)[1], t + r1[3])
            D2, v, t = _advance(D2, v, t, *(0.5 * (a + b) for a, b in zip(r1, r2)))
            rem, F = _vaporized(D2)
            x_i = (i + 1) * dx
            for name, w, sl in marched:
                f = 1.0 - float(np.sum(_RR_WEIGHTS * rem[sl]))
                if math.isnan(x95[name]) and f >= 0.95:
                    p = prev[name]
                    x95[name] = x_i - dx * (f - 0.95) / (f - p) if f > p else x_i
                prev[name] = f
                if every and ((i + 1) % every == 0 or i + 1 == _MARCH_STEPS):
                    prof[name].append([float(x_i), float(f)])
    for name, w, sl in marched:
        out["frac_vaporized"][name] = float(prev[name])
        out["x_vap95"][name] = None if math.isnan(x95[name]) else float(x95[name])
    out["F_throat"] = float(F)
    if every:
        out["profile"] = prof
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
    blowing: str = "abramzon_sirignano",
    cstar_fn: Optional[CstarOfMR] = None,
) -> Tuple[float, Dict[str, Any]]:
    """c* retained by incomplete vaporization (Priem & Heidmann, NASA TR R-67).

    Unvaporized liquid crosses the throat carrying mass and no energy, so
    c*_eff = Pc At/mdot = (mdot_gas/mdot) c*(O/F_gas):

        eta_vap = F c*(O/F_vap)/c*(O/F),   F = fraction vaporized,  O/F_vap = O/F f_O/f_F,

    f_O, f_F each stream's fraction vaporized. The c* ratio has either sign: it is above 1 when
    the vaporized gas lies nearer the c* peak than the injected O/F, and below 1 past it (the
    6.5 kN ethalox design sits at the LOX/ethanol c* peak, O/F ~1.53 at 374 psia, and its
    fuel-limited gas at 1.62 loses 0.1 %). Without ``cstar_fn`` it is taken as 1 and recorded.

    Drops form where the doublet's sheet breaks up, x0 = L_imp + L_sheet_breakup from the face
    (injector diagnostics), and are marched from there over L - x0; L = L* A_t/A_c is the
    volume-equivalent cylinder. Each stream evaporates at its own saturation state at Pc with its
    own D32. Liquid heat-up integrates CoolProp's cp(T) at Pc for the named fluid, with the liquid
    density at the mean drop temperature; a fluid CoolProp does not know uses the configured cp
    and density, recorded.
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
        if p.get("temperature") is None:
            p["temperature"] = _record(assumptions, f"combustion.vaporization.{label}.temperature", 293.0,
                                       "K", f"fluids.{label}.temperature not passed to the c* model")
        T_crit = p.get("critical_temperature") or None
        if T_crit is None:
            _record(assumptions, f"combustion.vaporization.{label}.critical_temperature", None, "K",
                    "no critical temperature: latent heat kept at its normal-boiling-point value")
        T_s, h_fg = saturation_state(Pc, float(p["boiling_point"]), float(p["latent_heat"]),
                                     float(p["molecular_weight"]), T_crit)
        T0 = float(p["temperature"])
        st = {"name": tag, "mass_fraction": w, "D32": D32, "T0": T0, "T_s": T_s, "h_fg": h_fg}
        liq = liquid_heatup_properties(p.get("name"), Pc, T0, T_s, Tc) if T_s > T0 else None
        if liq is not None:
            st.update(rho_l=liq["rho_l"], cp_l=liq["cp_l_effective"], heatup_integral=liq["heatup_integral"],
                      liquid_source=f"CoolProp {p.get('name')}: cp(T) at Pc, rho at {liq['T_mean']:.1f} K",
                      T_liquid_limit=liq["T_liquid_limit"])
        else:
            if p.get("specific_heat") is None:
                p["specific_heat"] = _record(assumptions, f"combustion.vaporization.{label}.specific_heat",
                                             2000.0, "J/(kg K)",
                                             f"fluids.{label}.specific_heat not passed to the c* model")
            if T_s > T0:
                _record(assumptions, f"combustion.vaporization.{label}.liquid_properties",
                        {"cp_l": float(p["specific_heat"]), "rho_l": float(p["density"])}, "SI",
                        (f"CoolProp has no fluid {p.get('name')!r}" if p.get("name") else
                         f"fluids.{label}.name not passed") + ": heat-up at constant cp_l and the "
                        "configured density")
            st.update(rho_l=float(p["density"]), cp_l=float(p["specific_heat"]),
                      liquid_source="configured cp_l and density (constant)")
        return st

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

    # Where drops exist: the jets meet at L_imp and the sheet breaks up L_sheet_breakup further on.
    def _len(key: str) -> Optional[float]:
        try:
            v = float(diag.get(key))
        except (TypeError, ValueError):
            return None
        return v if (np.isfinite(v) and v >= 0) else None

    L_imp, L_b = _len("L_imp"), _len("L_sheet_breakup")
    if L_imp is None and L_b is None:
        x0 = 0.0
        _record(assumptions, "combustion.vaporization.drop_formation_x", 0.0, "m",
                "no L_imp / L_sheet_breakup from the injector: drops taken to form at the face")
    else:
        x0 = (L_imp or 0.0) + (L_b or 0.0)

    L_ch = Lstar * At / Ac
    L_march = L_ch - x0
    marched_any = any(not s.get("instant") for s in streams)
    march_kw = dict(Pc=Pc, Tc=Tc, gamma=gamma, R=R, m_dot_total=m_dot_total, Ac=Ac,
                    L_chamber=max(L_march, 1e-9), u_drop0=u_ax, rr_q=rr_q, blowing=blowing)
    if L_march > 0.0 or not marched_any:
        march = spray_vaporization_march(streams, **march_kw)
    else:
        # The sheet reaches the throat before it breaks up: no drop evaporates in the chamber.
        march = {"F_throat": float(sum(s["mass_fraction"] for s in streams if s.get("instant"))),
                 "frac_vaporized": {s["name"]: (1.0 if s.get("instant") else 0.0) for s in streams},
                 "x_vap95": {s["name"]: (0.0 if s.get("instant") else None) for s in streams},
                 "blowing_model": blowing, "blowing": {}}
    F = float(march["F_throat"])
    fO = float(march["frac_vaporized"].get("O", 1.0))
    fF = float(march["frac_vaporized"].get("F", 1.0))
    if cstar_fn is not None:
        MR_vap = MR * fO / fF if fF > 0.0 else math.inf
        cstar_ratio = cstar_fn(MR_vap) / cstar_fn(MR)
    else:
        MR_vap = MR * fO / fF if fF > 0.0 else math.inf
        cstar_ratio = 1.0
        _record(assumptions, "combustion.vaporization.cstar_of_vaporized_OF", 1.0, "",
                "no c*(O/F) source passed: the vaporized gas's c* taken at the injected O/F")
    eta_vap = F * cstar_ratio
    diag_out = {
        "fraction_vaporized": F,
        "frac_vaporized_O": march["frac_vaporized"].get("O"),
        "frac_vaporized_F": march["frac_vaporized"].get("F"),
        "MR_vaporized": float(MR_vap),
        "cstar_vaporized_ratio": float(cstar_ratio),
        "x_vap95_O": march["x_vap95"].get("O"),
        "x_vap95_F": march["x_vap95"].get("F"),
        "L_chamber_equiv": float(L_ch),
        "x_drop_formation": float(x0),
        "L_march": float(max(L_march, 0.0)),
        "u_drop0": float(u_ax),
        "rr_q": float(rr_q),
        "blowing_model": blowing,
        # What it takes to run this march again with a profile (vaporization_profile): the
        # stability report draws the same drops that set eta_vap, not a model of its own.
        "march_replay": {"streams": [{k: v for k, v in st.items() if isinstance(v, (int, float, str, bool))}
                                     for st in streams],
                         "kw": {k: (float(v) if not isinstance(v, str) else v) for k, v in march_kw.items()},
                         "x0": float(x0), "L_chamber": float(L_ch)},
    }
    for s in streams:
        if not s.get("instant"):
            n = s["name"]
            diag_out[f"T_surface_{n}"] = s["T_s"]
            diag_out[f"h_fg_{n}"] = s["h_fg"]
            diag_out[f"rho_l_{n}"] = s["rho_l"]
            diag_out[f"cp_l_{n}"] = s["cp_l"]
            diag_out[f"liquid_props_{n}"] = s["liquid_source"]
            b = march.get("blowing", {}).get(n)
            if b:
                diag_out[f"B_T_{n}"] = b["B_T"]
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


# --------------------------------------------------------------------------- mixing
#: Rupe's correlation of E_m against N_R = 1/(1 + phi), phi = rho_F V_F^2 D_F/(rho_O V_O^2 D_O)
#: (= 1/M), for free circular jets of unlike doublets: Hoehn, Rupe & Sotter, JPL TR 32-1546 (1972)
#: eq. 2 and Fig. 1 (reproduced from Rupe's 1956 data, orifice area ratios 0.26-1.0). The mean
#: line, digitized from Fig. 1 at 13 points over N_R 0.26-0.78 and fitted with
#: E_m = E_max (1 - a (N_R - N_opt)^2), gives E_max 77.2, N_opt 0.525, a = 6.07, within 2.4 points
#: of the digitized line (the data scatter +-5 points about it). The curvature a is used here
#: with the optimum N_opt = M_opt/(1 + M_opt) of rupe_M_opt; E_max is rupe_Em_opt.
RUPE_FIG1_N_RANGE = (0.26, 0.78)
# The normal is resolved by Gauss-Legendre on each half, [0, 6 sigma] mirrored: E_m is a mean
# absolute deviation, and |z| has a kink at the centre that Gauss-Hermite does not integrate (24
# Hermite nodes put the MAD 1.7 % high, which moved eta_mix by 2.6e-3 against a direct CEA quad).
_HALF_X, _HALF_W = np.polynomial.legendre.leggauss(32)
_HALF_X = 3.0 * (_HALF_X + 1.0)
_HALF_W = 3.0 * _HALF_W * np.exp(-0.5 * _HALF_X ** 2)
_GAUSS_X = np.concatenate([-_HALF_X[::-1], _HALF_X])
_GAUSS_W = np.concatenate([_HALF_W[::-1], _HALF_W])
_GAUSS_W = _GAUSS_W / _GAUSS_W.sum()
#: Symmetric unit-MAD distributions of r - R: sum w |z| = 1 (the Rupe E_m of r = R + MAD z is
#: 1 - MAD/(2 R (1 - R)) exactly, for both shapes).
_UNIT_MAD = {
    "gaussian": (_GAUSS_X / float(np.sum(_GAUSS_W * np.abs(_GAUSS_X))), _GAUSS_W),
    "two_tube": (np.array([-1.0, 1.0]), np.array([0.5, 0.5])),
}
MIXING_DISTRIBUTIONS = tuple(_UNIT_MAD)


def rupe_Em_at_M(M: float, Em_opt: float, M_opt: float = 1.0, curvature: float = 6.07) -> float:
    """Rupe mixing factor E_m of an unlike doublet at mixing parameter M = rho_O v_O^2 d_O /
    (rho_F v_F^2 d_F), from Rupe's correlation (JPL TR 32-1546 Fig. 1, see RUPE_FIG1_N_RANGE):

        N_R = M/(1 + M),   E_m = Em_opt (1 - curvature (N_R - N_opt)^2),   floored at 0.
    """
    for name, v in (("M", M), ("M_opt", M_opt)):
        if not (np.isfinite(v) and v > 0):
            raise ValueError(f"rupe_Em_at_M: {name}={v} must be positive and finite")
    if not (0.0 < Em_opt <= 1.0):
        raise ValueError(f"rupe_Em_at_M: Em_opt={Em_opt} must lie in (0, 1]")
    if not (np.isfinite(curvature) and curvature >= 0):
        raise ValueError(f"rupe_Em_at_M: curvature={curvature} must be finite and >= 0")
    N = M / (1.0 + M)
    N0 = M_opt / (1.0 + M_opt)
    return float(max(Em_opt * (1.0 - curvature * (N - N0) ** 2), 0.0))


def rupe_Em_of_distribution(r: np.ndarray, w: np.ndarray, R: float) -> float:
    """Rupe's mixing factor (JPL TR 32-1546 eq. 1, as a fraction) of stream tubes with oxidizer
    mass fractions r and mass weights w about the bulk R:
        E_m = 1 - sum_{r<R} w (R - r)/R - sum_{r>R} w (r - R)/(1 - R)."""
    r, w = np.asarray(r, float), np.asarray(w, float) / float(np.sum(w))
    lo = r < R
    return float(1.0 - np.sum(w[lo] * (R - r[lo])) / R - np.sum(w[~lo] * (r[~lo] - R)) / (1.0 - R))


def stream_tube_mixing_efficiency(
    MR: float,
    cstar_fn: CstarOfMR,
    elements: List[Tuple[float, float, float]],
    distribution: str = "gaussian",
) -> Dict[str, Any]:
    """c* mixing efficiency by stream tubes (Pieper, Dean & Valentine, JSR 4(6), 1967; Dickerson
    et al., AFRPL-TR-68-147): each tube burns to equilibrium at its own O/F and none mixes with
    another before the throat, so

        eta_mix = sum_i w_i c*(O/F_i) / c*(O/F_bulk).

    ``elements`` = [(mass weight, element O/F, element E_m)]. Within an element the oxidizer mass
    fraction r = O/(O+F) is spread about the element's own r_j with the mean absolute deviation
    that reproduces Rupe's E_m, MAD = 2 (1 - E_m) r_j (1 - r_j), in the named shape:
    "gaussian" (normal in r, 64 tubes to 6 sigma) or "two_tube" (equal-mass tubes at r_j +- MAD).
    Element-to-element striation enters through the r_j; the element centres are shifted together
    so their mass-weighted mean is the bulk (the injector's element split and MR come from
    different solves; the shift is reported). The integral stays unmixed to the throat, which
    over-states the loss by whatever gas-phase mixing does downstream of the spray.
    """
    if distribution not in _UNIT_MAD:
        raise ValueError(f"mixing distribution {distribution!r} is not one of {MIXING_DISTRIBUTIONS}")
    if not (np.isfinite(MR) and MR > 0):
        raise ValueError(f"stream_tube_mixing_efficiency: MR={MR}")
    R = MR / (1.0 + MR)
    W = np.array([e[0] for e in elements], float)
    if not (W.size and np.all(W >= 0) and W.sum() > 0):
        raise ValueError("stream_tube_mixing_efficiency: element weights must be >= 0 with a positive sum")
    W = W / W.sum()
    rj = np.array([e[1] / (1.0 + e[1]) for e in elements], float)
    Em = np.array([e[2] for e in elements], float)
    shift = R - float(np.sum(W * rj))
    rj = rj + shift
    z, wz = _UNIT_MAD[distribution]
    mad = 2.0 * (1.0 - Em) * rj * (1.0 - rj)
    r = (rj[:, None] + mad[:, None] * z[None, :]).ravel()
    w = (W[:, None] * wz[None, :]).ravel()
    clipped = (r < 0.0) | (r > 1.0)
    r = np.clip(r, 0.0, 1.0)
    cs, outside = cstar_fn.of_fraction(r)
    c_bulk = cstar_fn(MR)
    eta = float(np.sum(w * cs) / c_bulk)
    return {
        "eta_mix": eta,
        "distribution": distribution,
        "Em_total": rupe_Em_of_distribution(r, w, R),
        "element_centre_shift": float(shift),
        "mass_outside_cstar_table": float(np.sum(w[outside])),
        "mass_clipped_to_pure_propellant": float(np.sum(w[clipped])),
        "OF_range_99pct": _mass_quantiles_OF(r, w, (0.005, 0.995)),
    }


def _mass_quantiles_OF(r: np.ndarray, w: np.ndarray, qs: Tuple[float, float]) -> Tuple[float, float]:
    """O/F at the given cumulative mass fractions of the stream tubes."""
    o = np.argsort(r)
    c = np.cumsum(w[o]) / float(np.sum(w))
    out = []
    for q in qs:
        rq = float(r[o][min(int(np.searchsorted(c, q)), r.size - 1)])
        out.append(rq / (1.0 - rq) if rq < 1.0 else math.inf)
    return tuple(out)


def _element_split(diag: Dict[str, Any], MR: float) -> Optional[List[Tuple[float, float]]]:
    """Per-element (mass flow, O/F) from the injector's manifold model, or None.

    ``element_mixture_ratios``: O/F per element. ``element_mass_flows``: per element either the
    total mdot, or (mdot_O, mdot_F) pairs (which then also give the O/F).
    """
    mrs = diag.get("element_mixture_ratios")
    flows = diag.get("element_mass_flows")
    if mrs is None and flows is None:
        return None
    fl = np.asarray(flows, float) if flows is not None else None
    if fl is not None and fl.ndim == 2 and fl.shape[1] == 2:
        tot = fl.sum(axis=1)
        mr = fl[:, 0] / fl[:, 1]
    else:
        mr = np.asarray(mrs, float).ravel()
        tot = np.ones_like(mr) if fl is None else fl.ravel()
        if tot.size != mr.size:
            raise ValueError(f"element_mass_flows ({tot.size}) and element_mixture_ratios ({mr.size}) differ in length")
    if not (np.all(np.isfinite(mr)) and np.all(mr > 0) and np.all(np.isfinite(tot)) and np.all(tot >= 0)):
        raise ValueError("element_mixture_ratios / element_mass_flows must be finite and positive")
    return list(zip(tot.tolist(), mr.tolist()))


def _cstar_source(Pc: float, cea_cache: Any, assumptions: List[Dict[str, Any]]) -> Optional[CstarOfMR]:
    if cea_cache is None:
        return None
    cfg = getattr(cea_cache, "config", None)
    wide = None
    if cfg is not None and getattr(cfg, "ox_name", None) and getattr(cfg, "fuel_name", None):
        wide = get_cstar_wide_table(cfg.ox_name, cfg.fuel_name)
    if wide is None:
        _record(assumptions, "combustion.cstar_wide_table", None, "",
                "no wide CEA c* table for this propellant pair (none committed, rocketcea "
                "unavailable): c* beyond the design cache's O/F range by the dilution law")
    return CstarOfMR(Pc, wide=wide, cea_cache=cea_cache)


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
    cea_cache: Any = None,
    cstar_fn: Optional[CstarOfMR] = None,
) -> Dict[str, Any]:
    """eta_vap * eta_mix. Heat loss is applied by combustion_eff.eta_cstar.

    eta_mix is the stream-tube c* integral (``stream_tube_mixing_efficiency``) of an O/F
    distribution built from Rupe's mixing factor E_m: E_m at the element's M from
    ``rupe_Em_at_M`` (impinging doublets) or ``rupe_Em_opt`` itself (other elements, recorded),
    and element-to-element striation from the injector's ``element_mixture_ratios`` /
    ``element_mass_flows`` when it publishes them (uniform elements otherwise). c*(O/F) comes from
    ``cstar_fn``, else the wide CEA c* table / ``cea_cache`` (``CstarOfMR``).

    Returns eta_total, eta_vaporization, eta_mixing, the inputs that set them and the assumptions
    made for missing inputs.
    """
    if u_fuel is None or u_lox is None:
        raise ValueError("u_fuel and u_lox (injection velocities, diagnostics 'u_F'/'u_O') are required.")
    assumptions: List[Dict[str, Any]] = []
    state = compute_combustion_state(Pc, Tc, R, Ac, At, Lstar, m_dot_total)
    if cstar_fn is None:
        cstar_fn = _cstar_source(Pc, cea_cache, assumptions)
    if cstar_fn is None:
        raise ValueError("The mixing and vaporization c* ratios need c*(O/F): pass cea_cache (the "
                         "design's CEACache) or cstar_fn.")
    blowing = str(getattr(config, "droplet_blowing_model", "abramzon_sirignano"))

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
            blowing=blowing, cstar_fn=cstar_fn,
        )

    # --- mixing: Rupe E_m -> O/F distribution -> stream-tube c* integral
    Em_opt = float(config.rupe_Em_opt)
    M_opt = float(config.rupe_M_opt)
    curv = float(config.rupe_Em_curvature)
    dist = str(config.mixing_distribution)
    diag = spray_diagnostics or {}
    rupe_M = rupe_M_from_diagnostics(spray_diagnostics)
    if rupe_M is not None:
        Em = rupe_Em_at_M(rupe_M, Em_opt, M_opt, curv)
        N_R = rupe_M / (1.0 + rupe_M)
        mixing_basis = "Rupe E_m at the element's M (JPL TR 32-1546 Fig. 1)"
        if not (RUPE_FIG1_N_RANGE[0] <= N_R <= RUPE_FIG1_N_RANGE[1]):
            _record(assumptions, "combustion.mixing.rupe_N_R_extrapolated", float(N_R), "",
                    f"N_R = M/(1+M) outside Rupe's data {RUPE_FIG1_N_RANGE}: E_m extrapolated")
    else:
        Em = Em_opt
        mixing_basis = "rupe_Em_opt (no Rupe M: not an impinging doublet)"
        _record(assumptions, "combustion.mixing.Em_non_impinging", Em_opt, "",
                "no mixing correlation for this element type: E_m taken as rupe_Em_opt")

    split = _element_split(diag, MR)
    if split is None:
        elements = [(1.0, float(MR), Em)]
        striation = "uniform elements (no element_mixture_ratios from the injector)"
    else:
        # An element's M moves with its own split: same orifices, v ~ mdot, so M_j = M (MR_j/MR)^2.
        elements = []
        for w_j, mr_j in split:
            Em_j = Em if rupe_M is None else rupe_Em_at_M(rupe_M * (mr_j / MR) ** 2, Em_opt, M_opt, curv)
            elements.append((w_j, mr_j, Em_j))
        striation = f"{len(split)} elements from the injector's manifold model"
    mix = stream_tube_mixing_efficiency(MR, cstar_fn, elements, dist)
    alt_name = "two_tube" if dist == "gaussian" else "gaussian"
    mix_alt = stream_tube_mixing_efficiency(MR, cstar_fn, elements, alt_name)
    if mix["mass_outside_cstar_table"] > 0.0:
        _record(assumptions, "combustion.mixing.cstar_outside_table", mix["mass_outside_cstar_table"],
                "mass fraction", f"stream tubes beyond {cstar_fn.source}: c* by the dilution law")
    if mix["mass_clipped_to_pure_propellant"] > 1e-3:
        _record(assumptions, "combustion.mixing.clipped_to_pure_propellant",
                mix["mass_clipped_to_pure_propellant"], "mass fraction",
                f"the {dist} O/F spread reaches past pure propellant; those tubes are taken as pure")
    if split is not None and abs(mix["element_centre_shift"]) > 1e-3:
        _record(assumptions, "combustion.mixing.element_centre_shift", mix["element_centre_shift"], "",
                "the injector's element O/F split does not average to the chamber O/F; element "
                "oxidizer fractions shifted together to the bulk")
    eta_mixing = float(mix["eta_mix"])

    eta_total = eta_vap * eta_mixing
    return {
        "eta_total": float(eta_total),
        "eta_vaporization": float(eta_vap),
        "eta_mixing": eta_mixing,
        "rupe_M": float(rupe_M) if rupe_M is not None else None,
        "rupe_M_opt": M_opt,
        "rupe_Em_opt": Em_opt,
        "rupe_Em": float(Em),
        "rupe_Em_total": float(mix["Em_total"]),
        "mixing_distribution": dist,
        f"eta_mixing_{alt_name}": float(mix_alt["eta_mix"]),
        "mixing_OF_range_99pct": mix["OF_range_99pct"],
        "mixing_mass_outside_cstar_table": mix["mass_outside_cstar_table"],
        "mixing_striation": striation,
        "mixing_basis": mixing_basis,
        "cstar_source": cstar_fn.source,
        "vaporization_model": str(config.model),
        "tau_res": state["tau_res"],
        **vap_diag,
        "assumptions": assumptions,
    }


def vaporization_profile(ce: Dict[str, Any], points: int = 40) -> Optional[Dict[str, Any]]:
    """The droplet march that set eta_vap, run again with its profile, in chamber coordinates
    (x from the injector face). ``ce`` is the c* model's diagnostics
    (``diagnostics["cstar_efficiency"]``). Per stream: the fraction vaporized along the chamber,
    where it reaches 95 % (None if it does not), and the fraction at the chamber end. None when
    the solve carried no march (the sheet reached the throat, or an older result)."""
    rp = (ce or {}).get("march_replay")
    if not rp:
        return None
    x0, L = float(rp["x0"]), float(rp["L_chamber"])
    m = spray_vaporization_march(rp["streams"], **rp["kw"], profile_points=points)
    out: Dict[str, Any] = {"L_chamber": L, "x_drop_formation": x0, "streams": {}}
    for st in rp["streams"]:
        n = str(st["name"])
        if st.get("instant"):
            out["streams"][n] = {"instant": True, "x95": 0.0, "frac_end": 1.0, "profile": [[0.0, 1.0], [L, 1.0]]}
            continue
        x95 = m["x_vap95"].get(n)
        out["streams"][n] = {
            "instant": False,
            "x95": None if x95 is None else x0 + float(x95),
            "frac_end": float(m["frac_vaporized"][n]),
            "profile": [[0.0, 0.0]] + [[x0 + x, f] for x, f in m.get("profile", {}).get(n, [])],
        }
    return out
