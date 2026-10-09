"""Numba mirror of the Python chamber solve, for the Layer 1 inner loop.

Each function here is a transcription of the Python function named in its docstring, in the same
order of operations, so the two paths compute the same physics and differ only by rounding and
by the one tabulation below. tests/test_numba_ab_parity.py diffs them live at 1e-6.

    residual(Pc) = mdot_injector(Pc) - (Pc/kappa) At / (eta_c* c*_ideal)       chamber_solver.residual
    eta_c* = eta_vap eta_mix eta_HL                                          combustion_eff.eta_cstar

The one thing numba cannot call is CoolProp, which the droplet heat-up reads at the chamber
pressure (combustion_physics.liquid_heatup_properties). It is tabulated here once per fluid as
functions of ln P -- cp at the 24 Gauss-Legendre nodes the Python integral uses, cp at the upper
limit, the density at the mean drop temperature, and CoolProp's saturation temperature -- as
cubic splines between the pressures where the integrand changes form (the critical pressure, where
the Clausius-Clapeyron surface temperature meets CoolProp's saturation line, where it reaches the
critical temperature, where the heat-up vanishes). Every interval is checked against CoolProp at
its midpoint when the table is built; an interval that misses is refused, and a pressure there
makes the kernel return no solution so the caller runs the Python solve.
"""
from __future__ import annotations

import math
from collections import OrderedDict

import numpy as np
from numba import njit

from engine.accel.kernels import _clip, _sign, _solve_injector, cea_eval
from engine.accel.params import _IDX
from engine.pipeline.combustion_physics import (
    P_BOIL_REF, WATSON_EXPONENT, _HEATUP_GL_W, _HEATUP_GL_X, _MARCH_STEPS, _RR_NODES,
    _RR_WEIGHTS, _UNIT_MAD, _V_FLOOR, _march_core,
)
from engine.pipeline.constants import STEFAN_BOLTZMANN_W_M2_K4 as SIGMA_SB
from engine.pipeline.physics_constants import PRANDTL_DEFAULT, R_UNIVERSAL_KMOL
from engine.pipeline.thermal.gas_side import (
    BARTZ_OMEGA, CYLINDER_BEAM_LENGTH_OVER_D, LECKNER_T_MAX, THROAT_RC_OVER_RT,
    _LECKNER_CO2, _LECKNER_H2O,
)

globals().update(_IDX)          # injector param indices (P vector) as module constants

G0 = 9.80665
RR_W = np.ascontiguousarray(_RR_WEIGHTS, np.float64)
GL_X = np.ascontiguousarray(_HEATUP_GL_X, np.float64)
GL_W = np.ascontiguousarray(_HEATUP_GL_W, np.float64)
LK_H2O = np.ascontiguousarray(_LECKNER_H2O, np.float64)
LK_CO2 = np.ascontiguousarray(_LECKNER_CO2, np.float64)
N_HEAT = GL_X.size              # heat-up table columns: cp at each node, cp(T_hi), rho(T_mean)

# ---- chamber scalar vector layout (the Q in every signature below) ---------------------------
_QNAMES = [
    "AT", "AE", "EPS", "EPS_CUR", "LSTAR", "AC", "CR", "ZETA_N",
    "EFF_MODEL", "EFF_C", "RR_Q", "RR_XSCALE", "BLOW_AS", "EM_OPT", "M_OPT", "EM_CURV", "USE_COUP",
    "IMP",
    "SO_OK", "SO_RHO", "SO_TB", "SO_LB", "SO_MW", "SO_TCRIT", "SO_T0", "SO_CP", "SO_HT",
    "SF_OK", "SF_RHO", "SF_TB", "SF_LB", "SF_MW", "SF_TCRIT", "SF_T0", "SF_CP", "SF_HT",
    "AB_ON", "AB_TS", "AB_EW", "AB_E", "AB_BELOW", "AB_PHYS", "AB_BC", "AB_BMIN", "AB_BEFF",
    "AB_RT", "AB_LB",
    "AX_MR0", "AX_MR1", "AX_NMR", "AX_PC0", "AX_PC1", "AX_NPC", "AX_E0", "AX_E1", "AX_NE",
]
_Q = {n: i for i, n in enumerate(_QNAMES)}
globals().update({f"Q_{n}": i for n, i in _Q.items()})
NQ = len(_QNAMES)
_S_STRIDE = _Q["SF_OK"] - _Q["SO_OK"]   # stream block: O then F

# ---- result vector layout (evaluate_core) ------------------------------------------------------
_RNAMES = [
    "PC", "F", "ISP", "MR", "CSTAR", "GAMMA", "R", "TC_EFF", "TC_IDEAL", "MDOT", "MDOT_O",
    "MDOT_F", "V_EXIT", "CF", "CF_IDEAL", "P_EXIT", "P_THROAT", "T_EXIT", "T_THROAT", "M_EXIT",
    "CSTAR_IDEAL", "ETA", "ETA_VAP", "ETA_MIX", "ETA_HL", "KAPPA", "P0", "Q_ABL", "F_VAP",
    "F_VAP_O", "F_VAP_F", "X0", "U_DROP0", "EM", "RUPE_M", "M_MOL", "CF_VAC",
]
_R = {n: i for i, n in enumerate(_RNAMES)}
globals().update({f"R_{n}": i for n, i in _R.items()})
NR = len(_RNAMES)


# =============================================================================================
# Liquid heat-up tables (the CoolProp half of combustion_physics.liquid_heatup_properties)
# =============================================================================================
_P_LO, _P_HI = 1.0e5, 2.5e7     # the chamber solve's Pc window lies inside (2 atm .. tank)
_DX_KNOT = 0.004                # knot spacing in ln P
# Spline tolerances against CoolProp at each interval's midpoint. eta_c* moves 2.4e-3 per unit
# relative change of the heat-up integral and 3.3e-2 per unit of the liquid density (6.5 kN
# design), so these hold the table's share of the parity budget below 1e-7.
_TOL_CP, _TOL_RHO, _TOL_T = 1e-5, 2e-7, 2e-6
_HEAT_MEMO: dict = {}


def _sat_T(P, Tb, Lb, MW, Tcrit):
    """combustion_physics.saturation_state's surface temperature (Tcrit 0 => none)."""
    from engine.pipeline.combustion_physics import saturation_state
    return saturation_state(P, Tb, Lb, MW, Tcrit if Tcrit > 0 else None)[0]


def _spline_block(xs, ys):
    """Per-interval cubic coefficients (highest power first) of not-a-knot splines through ys."""
    from scipy.interpolate import CubicSpline
    out = np.empty((ys.shape[0], xs.size - 1, 4))
    for k in range(ys.shape[0]):
        out[k] = CubicSpline(xs, ys[k]).c.T
    return out


_REFINE, _MAX_DEPTH = 8, 4       # a failing run is re-tabulated 8x finer, at most 4 times


def _tab_range(lo, hi, flag, h_target, fn, nf, tol_rel, tol_abs, depth):
    """Pieces (lo, hi, h, n, coef, ok, flag) covering [lo, hi]: one not-a-knot spline per run
    of knots, each interval checked against fn at its midpoint; a run of intervals that misses
    is tabulated again finer, and still refused after _MAX_DEPTH refinements."""
    n = max(3, int(math.ceil((hi - lo) / h_target)))
    xs = np.linspace(lo, hi, n + 1)
    ys = np.empty((nf, n + 1))
    good = np.ones(n + 1, dtype=bool)
    for i, x in enumerate(xs):
        try:
            ys[:, i] = fn(x, flag)
        except Exception:
            good[i] = False
    idx = np.flatnonzero(good)
    if idx.size == 0:
        return []
    for i in np.flatnonzero(~good):
        # a knot CoolProp would not evaluate: carry its neighbour so the spline exists, and
        # refuse the intervals that touch it
        ys[:, i] = ys[:, idx[np.argmin(np.abs(idx - i))]]
    c = _spline_block(xs, ys)
    h = (hi - lo) / n
    ok = good[:-1] & good[1:]
    for i in range(n):
        if not ok[i]:
            continue
        try:
            want = fn(lo + (i + 0.5) * h, flag)
        except Exception:
            ok[i] = False
            continue
        dx = 0.5 * h
        got = ((c[:, i, 0] * dx + c[:, i, 1]) * dx + c[:, i, 2]) * dx + c[:, i, 3]
        if not np.all(np.isfinite(want)) or np.any(np.abs(got - want) > tol_rel * np.abs(want) + tol_abs):
            ok[i] = False
    pieces = []
    i = 0
    while i < n:
        j = i
        while j + 1 < n and ok[j + 1] == ok[i]:
            j += 1
        a, b = lo + i * h, lo + (j + 1) * h
        if j == n - 1:
            b = hi
        if ok[i] or depth >= _MAX_DEPTH:
            pieces.append((a, b, h, j - i + 1, c[:, i:j + 1, :], ok[i:j + 1].copy(), flag))
        else:
            pieces.extend(_tab_range(a, b, flag, h / _REFINE, fn, nf, tol_rel, tol_abs, depth + 1))
        i = j + 1
    return pieces


def _piecewise(segments, fn, nf, tol_rel, tol_abs):
    """Tabulate fn(x, flag) -> (nf,) on each (lo, hi, flag) segment. Returns (segs, coef, ok)."""
    tol_rel = np.broadcast_to(np.asarray(tol_rel, dtype=float), (nf,))
    pieces = []
    for lo, hi, flag in segments:
        pieces.extend(_tab_range(lo, hi, flag, _DX_KNOT, fn, nf, tol_rel, tol_abs, 0))
    if not pieces:
        return np.zeros((0, 6)), np.zeros((nf, 0, 4)), np.zeros(0)
    pieces.sort(key=lambda p: p[0])
    rows, coefs, oks = [], [], []
    off = 0
    for a, b, h, n, c, ok, flag in pieces:
        rows.append((a, b, h, n, off, flag))
        coefs.append(c)
        oks.append(ok)
        off += n
    return (np.array(rows, dtype=np.float64), np.ascontiguousarray(np.concatenate(coefs, axis=1)),
            np.concatenate(oks).astype(np.float64))


def _roots(f, a, b, n=800):
    """Sign changes of f on [a, b], each refined by Brent."""
    from scipy.optimize import brentq
    xs = np.linspace(a, b, n + 1)
    vals = []
    for x in xs:
        try:
            vals.append(f(x))
        except Exception:
            vals.append(np.nan)
    out = []
    for i in range(n):
        fa, fb = vals[i], vals[i + 1]
        if np.isfinite(fa) and np.isfinite(fb) and np.sign(fa) != np.sign(fb) and fa != 0.0:
            try:
                out.append(brentq(f, xs[i], xs[i + 1], xtol=1e-13, rtol=1e-14))
            except Exception:
                pass
    return out


def heatup_tables(name, T0, Tb, Lb, MW, Tcrit):
    """(HT segs, HT coef, HT ok, TL segs, TL coef) for a fluid CoolProp knows, else None.

    HT columns, as functions of x = ln P: cp at T_n = T0 + (T_hi - T0)(x_n + 1)/2 for each
    Gauss-Legendre node x_n, cp at T_hi, and rho at (T0 + T_hi)/2, with T_hi = min(T_s, T_lim);
    segment flag 1 = above the critical pressure (T_lim infinite). TL: T_lim(x) below it.
    """
    key = (str(name), float(T0), float(Tb), float(Lb), float(MW), float(Tcrit))
    if key in _HEAT_MEMO:
        return _HEAT_MEMO[key]
    from engine.pipeline.combustion_physics import _coolprop_state
    st = _coolprop_state(name)
    if st is None:
        _HEAT_MEMO[key] = None
        return None
    CP, AS = st
    x_lo, x_hi = math.log(_P_LO), math.log(_P_HI)
    try:
        xc = math.log(float(AS.p_critical()))
    except Exception:
        xc = x_hi + 1.0
    gap = 1e-7                                  # no knot on the critical pressure itself

    def T_lim(x):
        AS.update(CP.PQ_INPUTS, math.exp(x), 0.0)
        return float(AS.T()) - 0.05

    def T_hi(x, sup):
        Ts = _sat_T(math.exp(x), Tb, Lb, MW, Tcrit)
        return Ts if sup else min(Ts, T_lim(x))

    def ht(x, sup):
        P = math.exp(x)
        th = T_hi(x, sup)
        Tn = 0.5 * (th - T0) * (GL_X + 1.0) + T0
        out = np.empty(N_HEAT + 2)
        for k, T in enumerate(Tn):
            AS.update(CP.PT_INPUTS, P, float(T))
            out[k] = AS.cpmass()
        AS.update(CP.PT_INPUTS, P, th)
        out[N_HEAT] = AS.cpmass()
        AS.update(CP.PT_INPUTS, P, 0.5 * (T0 + th))
        out[N_HEAT + 1] = AS.rhomass()
        return out

    # breakpoints in x where a column changes form
    br = {x_lo, x_hi}
    sub_hi = min(xc - gap, x_hi)
    if xc < x_hi:
        br.update({xc - gap, xc + gap})
    if Tcrit > 0:
        x_cc = math.log(P_BOIL_REF) + (1.0 / Tb - 1.0 / Tcrit) * MW * Lb / R_UNIVERSAL_KMOL
        if x_lo < x_cc < x_hi:
            br.add(x_cc)
    if sub_hi > x_lo:
        br.update(_roots(lambda x: _sat_T(math.exp(x), Tb, Lb, MW, Tcrit) - T_lim(x), x_lo, sub_hi))
        br.update(_roots(lambda x: T_hi(x, False) - T0, x_lo, sub_hi))
    if xc + gap < x_hi:
        br.update(_roots(lambda x: T_hi(x, True) - T0, xc + gap, x_hi))
    pts = sorted(b for b in br if x_lo <= b <= x_hi)

    segs = []
    for a, b in zip(pts[:-1], pts[1:]):
        if b - a < 1e-9 or (xc - gap < 0.5 * (a + b) < xc + gap):
            continue
        sup = 0.5 * (a + b) > xc
        try:
            if not T_hi(0.5 * (a + b), sup) > T0:
                continue                         # no heat-up here: the kernel skips the table
        except Exception:
            continue
        segs.append((a, b, 1.0 if sup else 0.0))

    def ht_rel(x, flag):
        return ht(x, flag > 0.5)

    tol = np.full(N_HEAT + 2, _TOL_CP)
    tol[N_HEAT + 1] = _TOL_RHO
    HT = _piecewise(segs, ht_rel, N_HEAT + 2, tol, 0.0)
    TL = (_piecewise([(x_lo, sub_hi, 0.0)], lambda x, f: np.array([T_lim(x)]), 1, 0.0, _TOL_T)
          if sub_hi > x_lo else (np.zeros((0, 6)), np.zeros((1, 0, 4)), np.zeros(0)))
    out = (HT[0], HT[1], HT[2], TL[0], TL[1], TL[2])
    _HEAT_MEMO[key] = out
    return out


_NO_HT = (np.zeros((0, 6)), np.zeros((N_HEAT + 2, 0, 4)), np.zeros(0),
          np.zeros((0, 6)), np.zeros((1, 0, 4)), np.zeros(0))


@njit(cache=True)
def _pw_find(segs, ok, x):
    """(interval index, dx) of x in a piecewise table, or (-1, 0) outside or on a refused one."""
    for s in range(segs.shape[0]):
        lo = segs[s, 0]
        if lo <= x <= segs[s, 1]:
            h = segs[s, 2]
            n = int(segs[s, 3])
            i = int((x - lo)/h)
            if i >= n:
                i = n - 1
            j = int(segs[s, 4]) + i
            if ok[j] < 0.5:
                return -1, 0.0
            return j, x - (lo + i*h)
    return -1, 0.0


@njit(cache=True)
def _pw_val(coef, k, j, dx):
    return ((coef[k, j, 0]*dx + coef[k, j, 1])*dx + coef[k, j, 2])*dx + coef[k, j, 3]


@njit(cache=True)
def _pw_flag(segs, x):
    for s in range(segs.shape[0]):
        if segs[s, 0] <= x <= segs[s, 1]:
            return segs[s, 5]
    return -1.0


# =============================================================================================
# Small mirrors
# =============================================================================================
@njit(cache=True)
def _saturation_state(P, Tb, Lb, MW, Tcrit):
    """combustion_physics.saturation_state -> (ok, T_sat, h_fg)."""
    if not (P > 0.0 and Tb > 0.0 and Lb > 0.0 and MW > 0.0):
        return False, 0.0, 0.0
    inv_T = 1.0/Tb - (R_UNIVERSAL_KMOL/(MW*Lb))*math.log(P/P_BOIL_REF)
    if Tcrit > 0.0:
        if Tcrit <= Tb:
            return False, 0.0, 0.0
        if inv_T <= 1.0/Tcrit:
            return True, Tcrit, 0.0
        T_sat = 1.0/inv_T
        return True, T_sat, Lb*((Tcrit - T_sat)/(Tcrit - Tb))**WATSON_EXPONENT
    if inv_T <= 0.0:
        return False, 0.0, 0.0
    return True, 1.0/inv_T, Lb


@njit(cache=True)
def _huzel_mu(T, M):
    """regen_cooling.calculate_gas_viscosity_huzel."""
    return 46.6e-10*(M**0.5)*((T*1.8)**0.6)*(0.45359237/0.0254)


@njit(cache=True)
def _area_ratio(M, gamma):
    return (1.0/M)*((2.0/(gamma + 1.0))*(1.0 + 0.5*(gamma - 1.0)*M*M))**(
        (gamma + 1.0)/(2.0*(gamma - 1.0)))


@njit(cache=True)
def _mach(ar, gamma, sup):
    """gas_side.mach_from_area_ratio for one station: the root of A/A*(M) = ar on the requested
    branch. The Python bisects 64 times; this is Newton kept inside the same shrinking bracket,
    which lands on the same root to the last bit or two in ~6 steps instead of 64."""
    if ar <= 1.0 + 1e-12:
        return 1.0
    if sup:
        lo = 1.0; hi = 50.0
        M = 1.0 + math.sqrt(2.0*(ar - 1.0)/(gamma + 1.0)) if ar < 2.0 else \
            ((gamma + 1.0)/(gamma - 1.0))**((gamma + 1.0)/4.0)*ar**((gamma - 1.0)/2.0)
    else:
        lo = 1e-9; hi = 1.0
        M = (2.0/(gamma + 1.0))**((gamma + 1.0)/(2.0*(gamma - 1.0)))/ar
        if ar < 2.0:
            M = 1.0 - math.sqrt(2.0*(ar - 1.0)/(gamma + 1.0))
    if not (lo < M < hi):
        M = 0.5*(lo + hi)
    for _ in range(100):
        A = _area_ratio(M, gamma)
        f = A - ar
        # keep the bracket: subsonic A/A* falls with M, supersonic rises
        if (f < 0.0) if sup else (f > 0.0):
            lo = M
        else:
            hi = M
        dA = A*(M*M - 1.0)/(M*(1.0 + 0.5*(gamma - 1.0)*M*M))
        Mn = M - f/dA if dA != 0.0 else 0.5*(lo + hi)
        if not (lo < Mn < hi):
            Mn = 0.5*(lo + hi)
        if abs(Mn - M) <= 1e-16*M or hi - lo <= 1e-16*M:
            return Mn
        M = Mn
    return M


@njit(cache=True)
def _kappa(CR, gamma):
    """nozzle.nozzle_stagnation_loss (CR <= 1: bore not declared)."""
    if not (CR > 1.0) or not np.isfinite(CR):
        return 1.0
    M = _mach(CR, gamma, False)
    g = gamma
    return (1.0 + g*M*M)/(1.0 + 0.5*(g - 1.0)*M*M)**(g/(g - 1.0))


@njit(cache=True)
def _axis(lo, hi, n, x, log):
    """cea_cache._aux_axis on a uniform (or log-uniform) grid of n points."""
    xc = min(max(x, lo), hi)
    if log:
        f = (math.log(xc) - math.log(lo))/(math.log(hi) - math.log(lo))*(n - 1)
    else:
        f = (xc - lo)/(hi - lo)*(n - 1)
    i = int(f)
    if i > n - 2:
        i = n - 2
    return i, f - i


@njit(cache=True)
def _aux2(Q, tab, k, MR, Pc):
    """CEAAuxTables._bilinear."""
    i, wi = _axis(Q[Q_AX_MR0], Q[Q_AX_MR1], int(Q[Q_AX_NMR]), MR, False)
    j, wj = _axis(Q[Q_AX_PC0], Q[Q_AX_PC1], int(Q[Q_AX_NPC]), Pc, True)
    return ((1 - wi)*(1 - wj)*tab[k, i, j] + wi*(1 - wj)*tab[k, i + 1, j]
            + (1 - wi)*wj*tab[k, i, j + 1] + wi*wj*tab[k, i + 1, j + 1])


@njit(cache=True)
def _aux3(Q, tab, k, MR, Pc, eps):
    """CEAAuxTables._exit."""
    i, wi = _axis(Q[Q_AX_MR0], Q[Q_AX_MR1], int(Q[Q_AX_NMR]), MR, False)
    j, wj = _axis(Q[Q_AX_PC0], Q[Q_AX_PC1], int(Q[Q_AX_NPC]), Pc, True)
    kk, wk = _axis(Q[Q_AX_E0], Q[Q_AX_E1], int(Q[Q_AX_NE]), eps, True)
    v = 0.0
    for di in range(2):
        fi = (1 - wi) if di == 0 else wi
        for dj in range(2):
            fj = (1 - wj) if dj == 0 else wj
            for dk in range(2):
                fk = (1 - wk) if dk == 0 else wk
                v += fi*fj*fk*tab[k, i + di, j + dj, kk + dk]
    return v


# =============================================================================================
# c*(O/F) from the wide CEA table (combustion_physics.CstarOfMR)
# =============================================================================================
@njit(cache=True)
def _wide_row(lnPc, cs, Pc, row):
    """CstarWideTable.row into ``row``."""
    x = math.log(Pc)
    if x < lnPc[0]:
        x = lnPc[0]
    elif x > lnPc[-1]:
        x = lnPc[-1]
    j = np.searchsorted(lnPc, x) - 1
    if j < 0:
        j = 0
    elif j > lnPc.size - 2:
        j = lnPc.size - 2
    f = (x - lnPc[j])/(lnPc[j + 1] - lnPc[j])
    for i in range(row.size):
        row[i] = (1.0 - f)*cs[i, j] + f*cs[i, j + 1]


@njit(cache=True)
def _interp(x, xp, fp):
    """np.interp for one point."""
    n = xp.size
    if x <= xp[0]:
        return fp[0]
    if x >= xp[n - 1]:
        return fp[n - 1]
    j = np.searchsorted(xp, x, side="right") - 1
    slope = (fp[j + 1] - fp[j])/(xp[j + 1] - xp[j])
    return slope*(x - xp[j]) + fp[j]


@njit(cache=True)
def _cs_of_r(r, lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi):
    """CstarOfMR.of_fraction for one oxidizer mass fraction -> (c*, outside the table)."""
    r = _clip(r, 0.0, 1.0)
    if r < r_lo:
        return c_lo*math.sqrt(r/r_lo), True
    if r > r_hi:
        return c_hi*math.sqrt((1.0 - r)/(1.0 - r_hi)), True
    mr = _clip(r/(1.0 - r), MR_lo, MR_hi)
    return _interp(math.log(mr), lnMR, row), False


@njit(cache=True)
def _cs_of_MR(MR, lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi):
    """CstarOfMR.__call__."""
    r = MR/(1.0 + MR) if np.isfinite(MR) else 1.0
    return _cs_of_r(r, lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi)[0]


@njit(cache=True)
def _rupe_Em_at_M(M, Em_opt, M_opt, curv):
    """combustion_physics.rupe_Em_at_M (NaN where the Python raises)."""
    if not (np.isfinite(M) and M > 0.0 and np.isfinite(M_opt) and M_opt > 0.0):
        return np.nan
    if not (Em_opt > 0.0 and Em_opt <= 1.0) or not (np.isfinite(curv) and curv >= 0.0):
        return np.nan
    N = M/(1.0 + M)
    N0 = M_opt/(1.0 + M_opt)
    return max(Em_opt*(1.0 - curv*(N - N0)**2), 0.0)


# =============================================================================================
# eta_vap: the droplet march (combustion_physics.calculate_vaporization_efficiency)
# =============================================================================================
@njit(cache=True)
def _heatup(Q, b, HTs, HTc, HTo, TLs, TLc, TLo, Pc, T0, Ts, Tc):
    """liquid_heatup_properties from the tables -> (status, I, rho_l).

    status 1: CoolProp values; 0: Python returns None here (configured props);
    -1: the tables cannot answer (a refused interval / outside them) -- no solution."""
    x = math.log(Pc)
    flag = _pw_flag(HTs, x)
    if flag > 0.5:
        T_lim = np.inf
    else:
        j, dx = _pw_find(TLs, TLo, x)
        if j < 0:
            return -1, 0.0, 0.0
        T_lim = _pw_val(TLc, 0, j, dx)
    T_hi = Ts if Ts < T_lim else T_lim
    if not (T_hi > T0):
        return 0, 0.0, 0.0
    j, dx = _pw_find(HTs, HTo, x)
    if j < 0:
        return -1, 0.0, 0.0
    acc = 0.0
    for k in range(N_HEAT):
        Tn = 0.5*(T_hi - T0)*(GL_X[k] + 1.0) + T0
        acc += GL_W[k]*_pw_val(HTc, k, j, dx)/(Tc - Tn)
    I = 0.5*(T_hi - T0)*acc
    if Ts > T_hi:
        I += _pw_val(HTc, N_HEAT, j, dx)*math.log((Tc - T_hi)/(Tc - Ts))
    rho = _pw_val(HTc, N_HEAT + 1, j, dx)
    cp_mean = I/math.log((Tc - T0)/(Tc - Ts))
    if not (np.isfinite(I) and I > 0.0 and np.isfinite(rho) and rho > 0.0
            and np.isfinite(cp_mean) and cp_mean > 0.0):
        return 0, 0.0, 0.0
    return 1, I, rho


@njit(cache=True)
def _eta_vap(Q, CH, Pc, Tc, gamma, R, MR, mdot, D32_O, D32_F, u_O, u_F, u_ax, L_imp, L_b,
             lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi, out):
    """calculate_vaporization_efficiency -> eta_vap (NaN where the Python raises)."""
    w = np.empty(2)
    w[0] = MR/(1.0 + MR)
    w[1] = 1.0/(1.0 + MR)
    D32 = np.empty(2); D32[0] = D32_O; D32[1] = D32_F
    uu = np.empty(2); uu[0] = u_O; uu[1] = u_F
    instant = np.zeros(2, dtype=np.bool_)
    Ts = np.zeros(2); hfg = np.zeros(2); rho_l = np.zeros(2); I_h = np.zeros(2); T0s = np.zeros(2)
    has_I = np.zeros(2, dtype=np.bool_)
    n_valid_d32 = 0
    for s in range(2):
        b = Q_SO_OK + s*_S_STRIDE
        d = D32[s]
        # the injector publishes NaN for a stream that does not flow
        ok_d = np.isfinite(d) and d > 0.0 and uu[s] > 0.0
        if ok_d:
            n_valid_d32 += 1
        if not ok_d or Q[b] < 0.5:
            instant[s] = True
            continue
        okS, T_s, h_fg = _saturation_state(Pc, Q[b + 2], Q[b + 3], Q[b + 4], Q[b + 5])
        if not okS:
            return np.nan
        T0 = Q[b + 6]
        Ts[s] = T_s; hfg[s] = h_fg; T0s[s] = T0
        st = 0
        I = 0.0; rho = 0.0
        if T_s > T0 and Q[b + 8] > 0.5:
            if s == 0:
                st, I, rho = _heatup(Q, b, CH[12], CH[13], CH[14], CH[15], CH[16], CH[17], Pc, T0, T_s, Tc)
            else:
                st, I, rho = _heatup(Q, b, CH[18], CH[19], CH[20], CH[21], CH[22], CH[23], Pc, T0, T_s, Tc)
            if st < 0:
                return np.nan
        if st == 1:
            rho_l[s] = rho; I_h[s] = I; has_I[s] = True
        else:
            rho_l[s] = Q[b + 1]
            I_h[s] = Q[b + 7]*max(math.log((Tc - T0)/(Tc - T_s)), 0.0)
    if n_valid_d32 == 0:
        return np.nan

    L_ch = Q[Q_LSTAR]*Q[Q_AT]/Q[Q_AC]
    x0 = 0.0
    if np.isfinite(L_imp) and L_imp >= 0.0:
        x0 += L_imp
    if np.isfinite(L_b) and L_b >= 0.0:
        x0 += L_b
    L_march = L_ch - x0
    marched_any = (not instant[0]) or (not instant[1])
    F0 = 0.0
    for s in range(2):
        if instant[s]:
            F0 += w[s]
    fO = 1.0; fF = 1.0
    if L_march > 0.0 or not marched_any:
        L_c = L_march if L_march > 1e-9 else 1e-9
        if not (Q[Q_RR_Q] > 1.0 and np.isfinite(Q[Q_RR_Q])):
            return np.nan
        if not (Pc > 0.0 and Tc > 0.0 and R > 0.0 and mdot > 0.0 and Q[Q_AC] > 0.0
                and u_ax > 0.0 and np.isfinite(u_ax)) or not (gamma > 1.0):
            return np.nan
        cp_g = gamma*R/(gamma - 1.0)
        rho_c = Pc/(R*Tc)
        U_c = mdot/(rho_c*Q[Q_AC])
        M_gas = R_UNIVERSAL_KMOL/R
        Pr = PRANDTL_DEFAULT
        pr3 = Pr**(1.0/3.0)
        nq = _RR_NODES.size
        nm = (0 if instant[0] else 1) + (0 if instant[1] else 1)
        if nm > 0:
            n = nm*nq
            D2_0 = np.empty(n); w_cls = np.empty(n); rl = np.empty(n); mu = np.empty(n)
            rf = np.empty(n); kf = np.empty(n); lnB = np.empty(n); t_h = np.empty(n)
            inv_FB = np.empty(n); cd_blow = np.empty(n)
            starts = np.empty(nm, dtype=np.int64)
            m = 0
            for s in range(2):
                if instant[s]:
                    continue
                T_s = Ts[s]
                T_f = T_s + (Tc - T_s)/3.0
                mu_f = _huzel_mu(T_f, M_gas)
                k_f = mu_f*cp_g/Pr
                rho_f = Pc/(R*T_f)
                B = cp_g*(Tc - T_s)/hfg[s] if hfg[s] > 0 else np.inf
                lB = math.log1p(B)
                iFB = 1.0; cdb = 1.0
                if Q[Q_BLOW_AS] > 0.5 and np.isfinite(B):
                    if not (B >= 0.0):
                        return np.nan
                    FB = 1.0 if B < 1e-8 else (1.0 + B)**0.7*math.log1p(B)/B
                    iFB = 1.0/FB
                    cdb = (1.0 + B)**-0.2
                starts[m] = m*nq
                for k in range(nq):
                    D0 = D32[s]*Q[Q_RR_XSCALE]*CH[11][k]
                    Nu0 = 2.0 + 0.6*math.sqrt(rho_f*u_ax*D0/mu_f)*pr3
                    idx = m*nq + k
                    D2_0[idx] = D0**2
                    w_cls[idx] = w[s]*RR_W[k]
                    rl[idx] = rho_l[s]; mu[idx] = mu_f; rf[idx] = rho_f; kf[idx] = k_f
                    lnB[idx] = lB
                    t_h[idx] = rho_l[s]*D0**2/(6.0*Nu0*k_f)*max(I_h[s], 0.0)
                    inv_FB[idx] = iFB; cd_blow[idx] = cdb
                m += 1
            dx = L_c/_MARCH_STEPS
            fv, xv, F = _march_core(D2_0, w_cls, rl, mu, rf, kf, lnB, t_h, inv_FB, cd_blow,
                                    U_c, rho_c, pr3, cp_g, dx, _MARCH_STEPS, u_ax, F0, _V_FLOOR,
                                    RR_W, starts, nq)
            m = 0
            for s in range(2):
                if instant[s]:
                    continue
                if s == 0:
                    fO = fv[m]
                else:
                    fF = fv[m]
                m += 1
        else:
            F = F0
    else:
        F = F0
        if not instant[0]:
            fO = 0.0
        if not instant[1]:
            fF = 0.0
    MR_vap = MR*fO/fF if fF > 0.0 else np.inf
    ratio = (_cs_of_MR(MR_vap, lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi)
             / _cs_of_MR(MR, lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi))
    out[R_F_VAP] = F; out[R_F_VAP_O] = fO; out[R_F_VAP_F] = fF; out[R_X0] = x0; out[R_U_DROP0] = u_ax
    return F*ratio


# =============================================================================================
# eta_mix: Rupe E_m -> stream tubes (combustion_physics.stream_tube_mixing_efficiency)
# =============================================================================================
@njit(cache=True)
def _eta_mix(Q, CH, MR, rupe_M, holes_O, holes_F, lnMR, row, MR_lo, MR_hi, r_lo, r_hi,
             c_lo, c_hi, out):
    Em_opt = Q[Q_EM_OPT]; M_opt = Q[Q_M_OPT]; curv = Q[Q_EM_CURV]
    has_M = np.isfinite(rupe_M) and rupe_M > 0.0
    if has_M:
        Em = _rupe_Em_at_M(rupe_M, Em_opt, M_opt, curv)
    else:
        Em = Em_opt
    if not np.isfinite(Em):
        return np.nan
    out[R_EM] = Em
    split = holes_O.size > 0 and holes_F.size > 0 and holes_O.size == holes_F.size
    ne = holes_O.size if split else 1
    W = np.empty(ne); mr = np.empty(ne); Emj = np.empty(ne)
    if split:
        for j in range(ne):
            o = holes_O[j]; f = holes_F[j]
            mr_j = o/f if f > 0.0 else np.inf
            tot = o + f
            if not (np.isfinite(mr_j) and mr_j > 0.0 and np.isfinite(tot) and tot >= 0.0):
                return np.nan          # _element_split raises
            W[j] = tot; mr[j] = mr_j
            if has_M:
                Emj[j] = _rupe_Em_at_M(rupe_M*(mr_j/MR)**2, Em_opt, M_opt, curv)
                if not np.isfinite(Emj[j]):
                    return np.nan
            else:
                Emj[j] = Em
    else:
        W[0] = 1.0; mr[0] = MR; Emj[0] = Em
    if not (np.isfinite(MR) and MR > 0.0):
        return np.nan
    R = MR/(1.0 + MR)
    Ws = 0.0
    for j in range(ne):
        if W[j] < 0.0:
            return np.nan
        Ws += W[j]
    if not (Ws > 0.0):
        return np.nan
    for j in range(ne):
        W[j] = W[j]/Ws
    rj = np.empty(ne)
    sw = 0.0
    for j in range(ne):
        rj[j] = mr[j]/(1.0 + mr[j])
        sw += W[j]*rj[j]
    shift = R - sw
    z = CH[9]; wz = CH[10]
    num = 0.0
    for j in range(ne):
        r0 = rj[j] + shift
        mad = 2.0*(1.0 - Emj[j])*r0*(1.0 - r0)
        for k in range(z.size):
            r = r0 + mad*z[k]
            r = _clip(r, 0.0, 1.0)
            num += W[j]*wz[k]*_cs_of_r(r, lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi)[0]
    return num/_cs_of_MR(MR, lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi)


# =============================================================================================
# Ablative liner (ablative_cooling.liner_response over gas_side.profile)
# =============================================================================================
@njit(cache=True)
def _lk_eps0(c, t, paL):
    x = math.log10(max(paL, 1e-12))
    a0 = 0.0; a1 = 0.0; a2 = 0.0
    for j in range(c.shape[1]):
        tj = t**j
        a0 += c[0, j]*tj
        a1 += c[1, j]*tj
        a2 += c[2, j]*tj
    return math.exp(a0 + a1*x + a2*x*x)


@njit(cache=True)
def _lk_species(h2o, T, P_bar, pa_bar, L_cm):
    t = T/1000.0
    tc = min(T, LECKNER_T_MAX)/1000.0
    paL = pa_bar*L_cm
    if h2o:
        e0 = _lk_eps0(LK_H2O, t, paL)
        PE = P_bar + 2.56*pa_bar/math.sqrt(tc)
        a = 1.888 - 2.053*math.log10(tc) if tc > 0.75 else 2.144
        b = 1.10/tc**1.4
        cc = 0.5
        paL_m = 13.2*tc*tc
    else:
        e0 = _lk_eps0(LK_CO2, t, paL)
        PE = P_bar + 0.28*pa_bar
        a = 1.0 + 0.1/tc**1.45
        b = 0.23
        cc = 1.47
        paL_m = 0.054/(tc*tc) if tc < 0.7 else 0.225*tc*tc
    ratio = 1.0 - (a - 1.0)*(1.0 - PE)/(a + b - 1.0 + PE)*math.exp(
        -cc*math.log10(paL_m/max(paL, 1e-12))**2)
    return e0*ratio if paL > 0.0 else 0.0


@njit(cache=True)
def _lk_overlap(pH, pC, L_cm):
    tot = max(pH + pC, 1e-30)
    zeta = pH/tot
    x = math.log10(max(tot*L_cm, 1e-30))
    d = (zeta/(10.7 + 101.0*zeta) - 0.0089*zeta**10.4)*max(x, 0.0)**2.76
    return d if (pH > 0 and pC > 0) else 0.0


@njit(cache=True)
def _ablative_Q(Q, CH, T0, P0, gamma, G, mu, cp, Pr, xH, xC, gas_mdot):
    """liner_response's heat_removed [W]: the lined stations' flux at the ablation temperature,
    through the pyrolysis-blowing fixed point."""
    xs = CH[6]; rs = CH[7]; dA = CH[8]
    n = xs.size
    Tw = Q[Q_AB_TS]; ew = Q[Q_AB_EW]; Rt = Q[Q_AB_RT]; beam = Q[Q_AB_LB]
    Dt = 2.0*Rt
    rc = THROAT_RC_OVER_RT*Rt
    E = Q[Q_AB_E]
    qc = np.empty(n); qr = np.empty(n)
    rr = Pr**(1.0/3.0)
    for k in range(n):
        r = rs[k]
        if k > 0 and r == rs[k - 1] and (xs[k] > 0.0) == (xs[k - 1] > 0.0):
            # the barrel: every station at the same radius sees the same gas
            qc[k] = qc[k - 1]; qr[k] = qr[k - 1]
            continue
        ar = (r/Rt)**2
        if ar < 1.0:
            ar = 1.0
        M = _mach(ar, gamma, xs[k] > 0.0)
        kk = 1.0 + 0.5*(gamma - 1.0)*M*M
        tT = 1.0/kk
        tP = tT**(gamma/(gamma - 1.0))
        k2 = 0.5*(gamma - 1.0)*M*M
        Taw = T0*(1.0 + rr*k2)/(1.0 + k2)
        sig = 1.0/((0.5*(Tw/T0)*kk + 0.5)**(0.8 - BARTZ_OMEGA/5.0)*kk**(BARTZ_OMEGA/5.0))
        h = (0.026/Dt**0.2*(mu**0.2*cp/Pr**0.6)*G**0.8
             *(Dt/rc)**0.1*(1.0/ar)**0.9*sig)
        Tg = T0*tT
        P_bar = P0*tP/1e5
        L = min(beam, CYLINDER_BEAM_LENGTH_OVER_D*2.0*r)
        L_cm = L*100.0
        pH = xH*P_bar; pC = xC*P_bar
        eps_g = max(_lk_species(True, Tg, P_bar, pH, L_cm) + _lk_species(False, Tg, P_bar, pC, L_cm)
                    - _lk_overlap(pH, pC, L_cm), 0.0)
        Twa = Tw if Tw < Tg else Tg
        s = Twa/Tg
        aH = _lk_species(True, Twa, P_bar, pH*s, L_cm)
        aC = _lk_species(False, Twa, P_bar, pC*s, L_cm)
        dd = _lk_overlap(pH*s, pC*s, L_cm)
        alpha = max((1.0/s)**0.45*aH + (1.0/s)**0.65*aC - dd, 0.0)
        fe = ew/(1.0 - (1.0 - ew)*(1.0 - alpha))
        q_rad = fe*SIGMA_SB*(eps_g*Tg**4 - alpha*Tw**4)
        q_conv = h*(Taw - Tw)
        qc[k] = q_conv if q_conv > 0.0 else 0.0
        qr[k] = q_rad if q_rad > 0.0 else 0.0
    f = 1.0
    for _ in range(50):
        m_pyro = 0.0
        for k in range(n):
            qn = f*qc[k] + qr[k]
            if qn < 0.0:
                qn = 0.0
            m_pyro += qn/E*dA[k]
        if Q[Q_AB_PHYS] > 0.5:
            if not (gas_mdot > 0.0):
                return np.nan
            B = m_pyro/gas_mdot
            f_new = max(1.0/(1.0 + Q[Q_AB_BC]*B), Q[Q_AB_BMIN])
        else:
            f_new = 1.0 - Q[Q_AB_BEFF]
        if abs(f_new - f) < 1e-12:
            f = f_new
            break
        f = f_new
    if Q[Q_AB_BELOW] > 0.5:
        return 0.0
    Qt = 0.0
    for k in range(n):
        qn = f*qc[k] + qr[k]
        if qn < 0.0:
            qn = 0.0
        Qt += qn*dA[k]
    return Qt


# =============================================================================================
# One chamber state at Pc (chamber_solver.residual / the converged diagnostics)
# =============================================================================================
@njit(cache=True)
def _point(Pc, P, CH, C, P_O, P_F, eps_cea, out):
    """supply - demand at Pc (NaN where the Python residual is NaN or raises); fills ``out``."""
    if not (np.isfinite(Pc) and Pc > 0.0):
        return np.nan
    Q = CH[0]
    sol = _solve_injector(P, P_O, P_F, Pc)
    ok = sol[0]; mO = sol[1]; mF = sol[2]; uO = sol[3]; uF = sol[4]; D32O = sol[5]; D32F = sol[6]
    if ok == 0.0 or not (np.isfinite(mO) and np.isfinite(mF)):
        return np.nan
    holes_O = sol[26]; holes_F = sol[27]
    mdot = mO + mF
    if abs(mF) < 1e-12:
        return np.nan
    MR = mO/mF
    if not np.isfinite(MR):
        return np.nan
    cs_id, cf_id, Tc, gm, Rg, Mg, cfv = cea_eval(C[0], C[1], C[2], C[3], C[4], C[5], C[6], C[7],
                                                 C[8], C[9], MR, Pc, eps_cea)
    if not (np.isfinite(cs_id) and cs_id > 0.0):
        return np.nan

    # ablative liner and the heat it takes
    Q_abl = 0.0
    Tc_eff = Tc
    if Q[Q_AB_ON] > 0.5 and mdot > 0.0:
        MRt = mO/mF if mF > 0.0 else MR
        aux2 = CH[1]
        mu = _aux2(Q, aux2, 0, MRt, Pc)
        cpg = _aux2(Q, aux2, 1, MRt, Pc)
        Prg = _aux2(Q, aux2, 2, MRt, Pc)
        xH = max(_aux2(Q, aux2, 3, MRt, Pc), 0.0)
        xC = max(_aux2(Q, aux2, 4, MRt, Pc), 0.0)
        Q_abl = _ablative_Q(Q, CH, Tc, Pc, gm, mdot/Q[Q_AT], mu, cpg, Prg, xH, xC, mdot)
        if not np.isfinite(Q_abl):
            return np.nan
        if Q_abl > 0.0:
            cp = gm*Rg/max(gm - 1.0, 1e-6)
            Tc_eff = max(Tc - Q_abl/max(mdot*cp, 1e-6), 1.0)

    # c*(O/F) at this Pc
    lnMR = CH[3]; lnPc = CH[4]; cs = CH[5]
    row = np.empty(lnMR.size)
    _wide_row(lnPc, cs, Pc, row)
    MR_lo = CH[2][0]; MR_hi = CH[2][1]     # CstarOfMR: wide.MR_min / MR_max
    r_lo = MR_lo/(1.0 + MR_lo); r_hi = MR_hi/(1.0 + MR_hi)
    c_lo = _interp(math.log(MR_lo), lnMR, row)
    c_hi = _interp(math.log(MR_hi), lnMR, row)

    # injector quantities the c* model reads from the diagnostics
    u_ax = np.nan; L_imp = np.nan; L_b = np.nan; rupe_M = np.nan
    w_O = MR/(1.0 + MR); w_F = 1.0/(1.0 + MR)
    if Q[Q_IMP] > 0.5:
        # spray.spray_axial_velocity, u_rel when it is not positive (impinging.py u_transport)
        if mdot > 0.0:
            ua = (mO*uO*math.cos(math.radians(P[ANG_O])) + mF*uF*math.cos(math.radians(P[ANG_F])))/mdot
        else:
            ua = np.nan
        u_ax = ua if (np.isfinite(ua) and ua > 0.0) else sol[20]
        # impinging.impingement_standoff_m and the sheet breakup length
        nn = max(1.0, 0.5*(P[NO] + P[NF]))
        dr = 0.5*abs(nn*P[SPO]/math.pi - nn*P[SPF]/math.pi)
        tan_sum = math.tan(math.radians(P[ANG_O])) + math.tan(math.radians(P[ANG_F]))
        if np.isfinite(tan_sum) and tan_sum > 1e-9 and dr > 0.0:
            L_imp = dr/tan_sum
        rho_gas = max(Pc/(P[SP_GASR]*P[SP_GAST]), 1e-6)
        d_avg = 0.5*(P[DJO] + P[DJF])
        if np.isfinite(L_imp) and L_imp > 0 and d_avg > 0 and rho_gas > 1e-4:
            L_b = _clip(d_avg**2/(4.0*L_imp)*math.sqrt(0.5*(P[RHO_O] + P[RHO_F])/rho_gas),
                        0.0, 20.0*d_avg)
        else:
            L_b = 0.0
        # impinging.rupe_mixing_ratio on the bulk jet velocities
        vO = mO/(P[RHO_O]*sol[14]) if (P[RHO_O] > 0 and sol[14] > 0) else np.nan
        vF = mF/(P[RHO_F]*sol[15]) if (P[RHO_F] > 0 and sol[15] > 0) else np.nan
        den = P[RHO_F]*vF**2*P[DJF]
        if np.isfinite(den) and den > 0 and np.isfinite(vO) and P[RHO_O] > 0 and P[DJO] > 0:
            rupe_M = P[RHO_O]*vO**2*P[DJO]/den
    else:
        # no impingement geometry: drops leave axially at the mass-averaged injection speed
        u_ax = w_O*uO + w_F*uF

    # eta_vap
    model = Q[Q_EFF_MODEL]
    if model == 0.0:
        eta_vap = 1.0 - Q[Q_EFF_C]
    elif model == 1.0:
        eta_vap = _clip(1.0 - Q[Q_EFF_C]*(1.0 - Q[Q_LSTAR]/1.0), 0.0, 1.0)
    else:
        eta_vap = _eta_vap(Q, CH, Pc, Tc, gm, Rg, MR, mdot, D32O, D32F, uO, uF, u_ax, L_imp, L_b,
                           lnMR, row, MR_lo, MR_hi, r_lo, r_hi, c_lo, c_hi, out)
    if not np.isfinite(eta_vap):
        return np.nan
    eta_mix = _eta_mix(Q, CH, MR, rupe_M, holes_O, holes_F, lnMR, row, MR_lo, MR_hi, r_lo, r_hi,
                       c_lo, c_hi, out)
    if not np.isfinite(eta_mix):
        return np.nan

    # heat lost through the wall (combustion_eff.heat_loss_cstar_efficiency)
    eta_HL = 1.0
    if Q[Q_USE_COUP] > 0.5 and Q_abl > 0.0:
        if not (mdot > 0.0 and Tc > 0.0 and Rg > 0.0 and gm > 1.0):
            return np.nan
        xq = Q_abl/(mdot*gm*Rg/(gm - 1.0)*Tc)
        eta_HL = math.sqrt(max(1.0 - xq, 0.0))
    eta = eta_vap*eta_mix*eta_HL
    if not (np.isfinite(eta) and eta > 0.0):
        return np.nan
    cstar = eta*cs_id
    kappa = _kappa(Q[Q_CR], gm)
    num = Pc/kappa*Q[Q_AT]
    if not (np.isfinite(num) and np.isfinite(cstar)) or abs(cstar) < 1e-12:
        return np.nan
    demand = num/cstar
    if not np.isfinite(demand):
        return np.nan
    res = mdot - demand
    out[R_MR] = MR; out[R_MDOT] = mdot; out[R_MDOT_O] = mO; out[R_MDOT_F] = mF
    out[R_CSTAR_IDEAL] = cs_id; out[R_CSTAR] = cstar; out[R_ETA] = eta; out[R_ETA_VAP] = eta_vap
    out[R_ETA_MIX] = eta_mix; out[R_ETA_HL] = eta_HL; out[R_GAMMA] = gm; out[R_R] = Rg
    out[R_TC_IDEAL] = Tc; out[R_TC_EFF] = Tc_eff; out[R_KAPPA] = kappa; out[R_Q_ABL] = Q_abl
    out[R_RUPE_M] = rupe_M; out[R_M_MOL] = Mg
    return res if np.isfinite(res) else np.nan


@njit(cache=True)
def _brentq(P, CH, C, P_O, P_F, a, b, xtol, rtol, maxit, out):
    """scipy.optimize.brentq (the C original), on _point."""
    eps = CH[0][Q_EPS]
    fa = _point(a, P, CH, C, P_O, P_F, eps, out)
    fb = _point(b, P, CH, C, P_O, P_F, eps, out)
    if not np.isfinite(fa) or not np.isfinite(fb):
        return np.nan
    if fa == 0.0:
        return a
    if fb == 0.0:
        return b
    if _sign(fa) == _sign(fb):
        return np.nan
    c = a; fc = fa; d = b - a; e = d
    for _ in range(maxit):
        if _sign(fb) == _sign(fc):
            c = a; fc = fa; d = b - a; e = d
        if abs(fc) < abs(fb):
            a = b; b = c; c = a; fa = fb; fb = fc; fc = fa
        tol = 2.0*rtol*abs(b) + 0.5*xtol
        m = 0.5*(c - b)
        if fb == 0.0 or abs(m) <= tol:
            return b
        if abs(e) < tol or abs(fa) <= abs(fb):
            d = m; e = m
        else:
            s = fb/fa
            if a == c:
                p = 2.0*m*s; q = 1.0 - s
            else:
                qa = fa/fc; r = fb/fc
                p = s*(2.0*m*qa*(qa - r) - (b - a)*(r - 1.0))
                q = (qa - 1.0)*(r - 1.0)*(s - 1.0)
            if p > 0.0:
                q = -q
            else:
                p = -p
            if 2.0*p < min(3.0*m*q - abs(tol*q), abs(e*q)):
                e = d; d = p/q
            else:
                d = m; e = m
        a = b; fa = fb
        if abs(d) > tol:
            b += d
        else:
            b += tol if m > 0.0 else -tol
        fb = _point(b, P, CH, C, P_O, P_F, eps, out)
        if not np.isfinite(fb):
            return np.nan
    return b


@njit(cache=True)
def evaluate_core(P, CH, C, P_O, P_F, Pa):
    """Pc root, converged state and delivered thrust -> (ok, result vector).

    The window and the top-down bracket scan are chamber_solver.solve's (PC_CHOKE_FLOOR_PA,
    PC_MIN_TOTAL_DROP_FRAC, _highest_sign_change); the thrust is nozzle.calculate_thrust."""
    Q = CH[0]
    res = np.full(NR, np.nan)
    scratch = np.full(NR, np.nan)
    Pc_min = 2.0*101325.0
    Pc_max = min(P_O, P_F)*(1.0 - 0.02)
    Pc_min = max(Pc_min, P[SV_PCMIN]); Pc_max = min(Pc_max, P[SV_PCMAX])
    if Pc_max <= Pc_min:
        return False, res
    xtol = P[SV_TOL]; rtol = P[SV_TOL]*1e-3
    maxit = int(P[SV_MAXIT]) if P[SV_MAXIT] > 0 else 100
    eps = Q[Q_EPS]
    rmin = _point(Pc_min, P, CH, C, P_O, P_F, eps, scratch)
    rmax = _point(Pc_max, P, CH, C, P_O, P_F, eps, scratch)
    if not np.isfinite(rmin) or not np.isfinite(rmax):
        return False, res
    n = 32
    lo = 0.0; hi = 0.0; found = False
    pb = Pc_max; rb = rmax
    for i in range(n - 1, -1, -1):
        pa = Pc_min + (Pc_max - Pc_min)*(i/n)
        ra = rmin if i == 0 else _point(pa, P, CH, C, P_O, P_F, eps, scratch)
        if np.isfinite(ra) and np.isfinite(rb) and _sign(ra) != _sign(rb):
            lo = pa; hi = pb; found = True
            break
        pb = pa; rb = ra
    if not found:
        return False, res
    Pc = _brentq(P, CH, C, P_O, P_F, lo, hi, xtol, rtol, maxit, scratch)
    if not np.isfinite(Pc):
        return False, res
    # the converged state, CEA at the geometry's own Ae/At as the Python final solve does
    r = _point(Pc, P, CH, C, P_O, P_F, Q[Q_EPS_CUR], res)
    if not np.isfinite(r):
        return False, res
    res[R_PC] = Pc
    # nozzle.calculate_thrust
    MR = res[R_MR]
    g1 = cea_eval(C[0], C[1], C[2], C[3], C[4], C[5], C[6], C[7], C[8], C[9], MR, Pc, eps)[3]
    kappa = _kappa(Q[Q_CR], g1)
    P0 = Pc/kappa
    cs2, cf2, tc2, gm2, Rg2, Mg2, cfv2 = cea_eval(C[0], C[1], C[2], C[3], C[4], C[5], C[6], C[7],
                                                  C[8], C[9], MR, P0, eps)
    if not np.isfinite(cfv2):
        return False, res
    aux3 = CH[24]
    ln_r = _aux3(Q, aux3, 0, MR, P0, eps)
    Te = _aux3(Q, aux3, 1, MR, P0, eps)
    Me = _aux3(Q, aux3, 2, MR, P0, eps)
    P_exit = P0/math.exp(ln_r)
    v_exit = cs2*(cfv2 - eps*P_exit/P0)
    if not (np.isfinite(P_exit) and P_exit > 0 and np.isfinite(Te) and Te > 0
            and Me > 1.0 and v_exit > 0):
        return False, res
    F = Q[Q_ZETA_N]*cfv2*P0*Q[Q_AT] - Pa*Q[Q_AE]
    if not np.isfinite(F):
        return False, res
    mdot = res[R_MDOT]
    thr = 2.0/(gm2 + 1.0)
    res[R_F] = F
    res[R_ISP] = F/(mdot*G0)
    res[R_CF] = F/(P0*Q[Q_AT])
    res[R_CF_IDEAL] = cfv2 - Pa*eps/P0 if P0 > 0 else cf2
    res[R_CF_VAC] = cfv2
    res[R_P_EXIT] = P_exit; res[R_T_EXIT] = Te; res[R_M_EXIT] = Me; res[R_V_EXIT] = v_exit
    res[R_T_THROAT] = tc2*thr
    res[R_P_THROAT] = P0*thr**(gm2/(gm2 - 1.0))
    res[R_P0] = P0
    if not (res[R_ISP] >= 0.0):
        return False, res
    return True, res


# =============================================================================================
# Config -> the chamber tuple (Python)
# =============================================================================================
_CONTOUR_MEMO: "OrderedDict" = OrderedDict()


def _contour(cg):
    from engine.pipeline.thermal.gas_side import contour_for
    key = (cg.A_throat, cg.chamber_diameter, cg.volume, cg.A_exit)
    c = _CONTOUR_MEMO.get(key)
    if c is None:
        c = contour_for(cg)
        _CONTOUR_MEMO[key] = c
        if len(_CONTOUR_MEMO) > 64:
            _CONTOUR_MEMO.popitem(last=False)
    return c


def _aux_arrays(cache):
    aux = cache.aux
    arr = getattr(aux, "_numba_arrays", None)
    if arr is None:
        t = aux.t
        a2 = np.ascontiguousarray(np.stack([t["mu_c"], t["cp_c"], t["Pr_c"], t["x_H2O_c"],
                                            t["x_CO2_c"]]), np.float64)
        a3 = np.ascontiguousarray(np.stack([t["lnPcPe"], t["Te"], t["Me"]]), np.float64)
        arr = (a2, a3, (float(aux.MR[0]), float(aux.MR[-1]), len(aux.MR),
                        float(aux.Pc[0]), float(aux.Pc[-1]), len(aux.Pc),
                        float(aux.eps[0]), float(aux.eps[-1]), len(aux.eps)))
        try:
            aux._numba_arrays = arr
        except Exception:
            pass
    return arr


def _wide_arrays(cache):
    from engine.pipeline.combustion_physics import get_cstar_wide_table
    cfg = getattr(cache, "config", None)
    if cfg is None or not getattr(cfg, "ox_name", None) or not getattr(cfg, "fuel_name", None):
        return None
    wide = get_cstar_wide_table(cfg.ox_name, cfg.fuel_name)
    if wide is None:
        return None
    arr = getattr(wide, "_numba_arrays", None)
    if arr is None:
        arr = (np.ascontiguousarray(wide._lnMR, np.float64), np.ascontiguousarray(wide._lnPc, np.float64),
               np.ascontiguousarray(wide.cstar, np.float64),
               np.array([float(wide.MR_min), float(wide.MR_max)]))
        try:
            wide._numba_arrays = arr
        except Exception:
            pass
    return arr


def chamber_inputs(config, cache):
    """The chamber tuple for evaluate_core, or None when a piece of the Python chamber solve is
    not mirrored here (the caller then runs Python)."""
    from engine.core.nozzle import contraction_ratio_of
    from engine.pipeline.config_schemas import ensure_chamber_geometry
    from engine.pipeline.thermal.ablative_cooling import ablation_energy_per_mass

    cg = ensure_chamber_geometry(config)
    eff = config.combustion.efficiency
    wide = _wide_arrays(cache)
    if wide is None:
        return None                     # c* would come from the design cache (not mirrored)
    dist = str(eff.mixing_distribution)
    blowing = str(getattr(eff, "droplet_blowing_model", "abramzon_sirignano"))
    if dist not in _UNIT_MAD or blowing not in ("abramzon_sirignano", "none"):
        return None
    z, wz = _UNIT_MAD[dist]
    q = float(eff.spray_size_spread_q)
    Q = np.zeros(NQ)
    Q[_Q["AT"]] = float(cg.A_throat)
    Q[_Q["AE"]] = float(cg.A_exit)
    Q[_Q["EPS"]] = float(cg.expansion_ratio)
    Q[_Q["EPS_CUR"]] = (float(cg.A_exit / cg.A_throat) if cg.A_throat and cg.A_exit and cg.A_throat > 0
                        else float(cg.expansion_ratio))
    Q[_Q["LSTAR"]] = float(cg.Lstar) if cg.Lstar is not None else float(cg.volume / cg.A_throat)
    D = cg.chamber_diameter
    if (D is None or D <= 0) and config.regen_cooling is not None and config.regen_cooling.chamber_inner_diameter:
        D = config.regen_cooling.chamber_inner_diameter
    if D is None or D <= 0:
        D = 0.08
    D = max(D, 1e-6)
    Q[_Q["AC"]] = float(np.pi * (D / 2.0) ** 2)
    CR = contraction_ratio_of(cg)
    Q[_Q["CR"]] = float(CR) if CR is not None else 0.0
    Q[_Q["ZETA_N"]] = float(cg.nozzle_efficiency)
    Q[_Q["EFF_MODEL"]] = {"constant": 0.0, "linear": 1.0}.get(str(eff.model), 2.0)
    Q[_Q["EFF_C"]] = float(eff.C)
    Q[_Q["RR_Q"]] = q
    Q[_Q["RR_XSCALE"]] = math.gamma(1.0 - 1.0 / q) if q > 1.0 else np.nan
    Q[_Q["BLOW_AS"]] = 1.0 if blowing == "abramzon_sirignano" else 0.0
    Q[_Q["EM_OPT"]] = float(eff.rupe_Em_opt)
    Q[_Q["M_OPT"]] = float(eff.rupe_M_opt)
    Q[_Q["EM_CURV"]] = float(eff.rupe_Em_curvature)
    Q[_Q["USE_COUP"]] = 1.0 if eff.use_cooling_coupling else 0.0
    Q[_Q["IMP"]] = 1.0 if config.injector.type == "impinging" else 0.0

    tables = []
    for pre, side in (("SO", "oxidizer"), ("SF", "fuel")):
        fl = config.fluids[side]
        g = lambda k: getattr(fl, k, None)  # noqa: E731
        dens, Tb, Lb, MW = g("density"), g("boiling_point"), g("latent_heat"), g("molecular_weight")
        ok = bool(dens and Tb and Lb and MW)
        Q[_Q[f"{pre}_OK"]] = 1.0 if ok else 0.0
        Q[_Q[f"{pre}_RHO"]] = float(dens or 0.0)
        Q[_Q[f"{pre}_TB"]] = float(Tb or 0.0)
        Q[_Q[f"{pre}_LB"]] = float(Lb or 0.0)
        Q[_Q[f"{pre}_MW"]] = float(MW or 0.0)
        Tcrit = g("critical_temperature") or 0.0
        Q[_Q[f"{pre}_TCRIT"]] = float(Tcrit)
        T0 = g("temperature")
        T0 = 293.0 if T0 is None else float(T0)
        Q[_Q[f"{pre}_T0"]] = T0
        cp = g("specific_heat")
        Q[_Q[f"{pre}_CP"]] = 2000.0 if cp is None else float(cp)
        ht = None
        if ok and g("name"):
            ht = heatup_tables(str(fl.name), T0, float(Tb), float(Lb), float(MW), float(Tcrit))
        Q[_Q[f"{pre}_HT"]] = 1.0 if ht is not None else 0.0
        tables.append(ht if ht is not None else _NO_HT)

    ab = config.ablative_cooling
    xs = rs = dA = np.zeros(0)
    if ab is not None and ab.enabled:
        contour = _contour(cg)
        gr = getattr(config, "graphite_insert", None)
        if gr is None or not gr.enabled:
            x_end = 0.0
        else:
            x_end = -float(gr.axial_half_length or gr.axial_half_length_ratio * 2.0 * contour.R_t)
        lined = (contour.x >= contour.x_face - 1e-12) & (contour.x <= x_end + 1e-12)
        xs = np.ascontiguousarray(contour.x[lined], np.float64)
        rs = np.ascontiguousarray(contour.r[lined], np.float64)
        dA = np.ascontiguousarray(contour.area_elements()[lined]
                                  * float(np.clip(ab.coverage_fraction, 0.0, 1.0)), np.float64)
        Ts = float(ab.ablation_surface_temperature)
        Q[_Q["AB_ON"]] = 1.0
        Q[_Q["AB_TS"]] = Ts
        Q[_Q["AB_EW"]] = float(ab.surface_emissivity)
        Q[_Q["AB_E"]] = float(ablation_energy_per_mass(ab, Ts))
        Q[_Q["AB_BELOW"]] = 1.0 if Ts < ab.pyrolysis_temperature else 0.0
        Q[_Q["AB_PHYS"]] = 1.0 if ab.use_physics_based_blowing else 0.0
        Q[_Q["AB_BC"]] = float(ab.blowing_coefficient)
        Q[_Q["AB_BMIN"]] = float(ab.blowing_min_reduction_factor)
        Q[_Q["AB_BEFF"]] = float(np.clip(ab.blowing_efficiency, 0.0, 1.0))
        Q[_Q["AB_RT"]] = float(contour.R_t)
        Q[_Q["AB_LB"]] = float(contour.beam_length)

    a2, a3, g = _aux_arrays(cache)
    for k, v in zip(("AX_MR0", "AX_MR1", "AX_NMR", "AX_PC0", "AX_PC1", "AX_NPC", "AX_E0", "AX_E1",
                     "AX_NE"), g):
        Q[_Q[k]] = float(v)

    lnMR, lnPc, cs, mrlim = wide
    ypow = np.ascontiguousarray(_RR_NODES ** (1.0 / q) if q > 1.0 else _RR_NODES, np.float64)
    (hOs, hOc, hOo, tOs, tOc, tOo), (hFs, hFc, hFo, tFs, tFc, tFo) = tables
    return (Q, a2, mrlim, lnMR, lnPc, cs, xs, rs, dA,
            np.ascontiguousarray(z, np.float64), np.ascontiguousarray(wz, np.float64), ypow,
            hOs, hOc, hOo, tOs, tOc, tOo, hFs, hFc, hFo, tFs, tFc, tFo, a3)


def warmup():
    """Load (or compile) evaluate_core for the argument types every config produces, so a worker
    pool does not pay it inside its first generation. Never raises."""
    try:
        from engine.accel.params import NP
        z1 = np.zeros(2)
        CH = (np.zeros(NQ), np.zeros((5, 2, 2)), z1, z1, z1, np.zeros((2, 2)), z1, z1, z1, z1, z1,
              z1, _NO_HT[0], _NO_HT[1], _NO_HT[2], _NO_HT[3], _NO_HT[4], _NO_HT[5],
              _NO_HT[0], _NO_HT[1], _NO_HT[2], _NO_HT[3], _NO_HT[4], _NO_HT[5],
              np.zeros((3, 2, 2, 2)))
        t3 = np.ones((2, 2, 2))
        C = (z1, z1, z1, t3, t3, t3, t3, t3, t3, t3)
        evaluate_core(np.zeros(NP), CH, C, 1.0, 1.0, 1.0)
        return True
    except Exception:
        return False
