"""Numba port of the C ed_evaluate impinging inner-loop physics.

Faithful mirror of engine/native/src/{ed_injector_impinging,ed_discharge,ed_feed_loss,
ed_spray,ed_combustion_physics,ed_cea,ed_nozzle,ed_chamber,ed_cooling,ed_evaluate,
ed_root_find}.c for the config class the accelerated path handles: impinging
injector, advanced/exponential combustion, ablative cooling (film/regen fall back
to Python, as the C kernel also refuses them).

All state arrives as one flat float64 vector built by params.build_params, plus
the CEA tables as plain arrays -- @njit sees no Python objects.
"""
from __future__ import annotations

import numpy as np
from numba import njit

from engine.accel.cea import cea_arrays, _cea_arrays_cached
from engine.accel.params import _IDX, NP, extract_params

globals().update(_IDX)          # param indices as module-level int constants

# physical constants (ed_phys_const.h)
# physical constants (ed_phys_const.h)
PI = np.pi
G0 = 9.80665
P_SEA = 101325.0
# ed_cooling.c / ed_phys_const.h
RANKINE_PER_K = 1.8; HUZEL_COEFF = 46.6e-10; LB_S_PER_IN2_TO_PA_S = 6894.76
STEFAN = 5.670374419e-8; MIN_DENS = 0.01; EPS_SMALL = 1e-6; EPS_TINY = 1e-8
NU_LAMINAR = 4.36; NU_TURB_COEF = 0.023; NU_TURB_RE_EXP = 0.8; NU_TURB_PR_EXP = 0.4
PRANDTL = 0.8
D_M_REF = 5e-5; D_M_TREF = 1500.0; D_M_PREF = 2.5e6; U_SLIP_CAP = 50.0; D_MIN_GAS = 1e-6
CS_C_L = 0.1; CS_C_U = 0.5; CS_U_RMS_CAP = 200.0
GAS_MU = 7e-5; GAS_RHO_L = 800.0; GAS_CP_L = 2000.0; GAS_T_INJ = 293.0; GAS_CP_G = 2200.0
SMD_INGEBO = 1; SPRAYANG_J = 1; PHI_NONE = 0; PHI_SQRTP = 1; PHI_LOGP = 2
EFF_CONSTANT = 0; EFF_LINEAR = 1


# ------------------------- njit kernels --------------------------------------
@njit(cache=True)
def _clip(x, lo, hi):
    return lo if x < lo else (hi if x > hi else x)

@njit(cache=True)
def _tri(table, ip, im, ie, w0, w1, w2, w3, w4, w5, w6, w7):
    f0 = table[ip-1, im-1, ie-1]; f1 = table[ip, im-1, ie-1]
    f2 = table[ip-1, im, ie-1];   f3 = table[ip, im, ie-1]
    f4 = table[ip-1, im-1, ie];   f5 = table[ip, im-1, ie]
    f6 = table[ip-1, im, ie];     f7 = table[ip, im, ie]
    if (np.isnan(f0) or np.isnan(f1) or np.isnan(f2) or np.isnan(f3) or
            np.isnan(f4) or np.isnan(f5) or np.isnan(f6) or np.isnan(f7)):
        return f0
    return f0*w0 + f1*w1 + f2*w2 + f3*w3 + f4*w4 + f5*w5 + f6*w6 + f7*w7

@njit(cache=True)
def cea_eval(Pcg, MRg, epsg, cstar, Cf, Tc, gam, Rt, Mt, Cfvac, MR, Pc, eps):
    Pc_c = _clip(Pc, Pcg[0], Pcg[-1]); MR_c = _clip(MR, MRg[0], MRg[-1]); eps_c = _clip(eps, epsg[0], epsg[-1])
    npc = Pcg.shape[0]; nmr = MRg.shape[0]; nep = epsg.shape[0]
    ip = np.searchsorted(Pcg, Pc_c, side="left"); ip = 1 if ip < 1 else (npc-1 if ip > npc-1 else ip)
    im = np.searchsorted(MRg, MR_c, side="left"); im = 1 if im < 1 else (nmr-1 if im > nmr-1 else im)
    ie = np.searchsorted(epsg, eps_c, side="left"); ie = 1 if ie < 1 else (nep-1 if ie > nep-1 else ie)
    Pc0, Pc1 = Pcg[ip-1], Pcg[ip]; MR0, MR1 = MRg[im-1], MRg[im]; e0, e1 = epsg[ie-1], epsg[ie]
    wx = (Pc_c-Pc0)/(Pc1-Pc0) if Pc1 != Pc0 else 0.0
    wy = (MR_c-MR0)/(MR1-MR0) if MR1 != MR0 else 0.0
    wz = (eps_c-e0)/(e1-e0) if e1 != e0 else 0.0
    w0=(1-wx)*(1-wy)*(1-wz); w1=wx*(1-wy)*(1-wz); w2=(1-wx)*wy*(1-wz); w3=wx*wy*(1-wz)
    w4=(1-wx)*(1-wy)*wz; w5=wx*(1-wy)*wz; w6=(1-wx)*wy*wz; w7=wx*wy*wz
    return (_tri(cstar,ip,im,ie,w0,w1,w2,w3,w4,w5,w6,w7),
            _tri(Cf,ip,im,ie,w0,w1,w2,w3,w4,w5,w6,w7),
            _tri(Tc,ip,im,ie,w0,w1,w2,w3,w4,w5,w6,w7),
            _tri(gam,ip,im,ie,w0,w1,w2,w3,w4,w5,w6,w7),
            _tri(Rt,ip,im,ie,w0,w1,w2,w3,w4,w5,w6,w7),
            _tri(Mt,ip,im,ie,w0,w1,w2,w3,w4,w5,w6,w7),
            _tri(Cfvac,ip,im,ie,w0,w1,w2,w3,w4,w5,w6,w7))

@njit(cache=True)
def _reynolds(rho, u, d, mu):
    if mu <= 0.0:
        return 1e6
    return rho*u*d/mu

@njit(cache=True)
def _cd_inf_orifice(d_hyd, cdinf, geom, dref, dmin, exps, logg, cdmax, cdfloor):
    if geom == 0.0:
        return cdinf
    if not np.isfinite(d_hyd) or d_hyd <= 0.0:
        return cdinf
    d = dmin if dmin > d_hyd else d_hyd
    if dref <= 0.0:
        return _clip(cdinf, cdfloor, cdmax)
    ratio = d/dref
    if ratio < 1.0:
        cd = cdinf * ratio**(exps if exps > 0.0 else 0.0)
    else:
        cd = cdinf + logg*np.log(ratio)
    return _clip(cd, cdfloor, cdmax)

@njit(cache=True)
def _cd_from_re(Re, P_in, T_in, d_hyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg,
                cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT):
    cd_inf_eff = _cd_inf_orifice(d_hyd, cdinf, geom, dref, dmin, exps, logg, cdmax, cdfloor)
    if Re <= 0.0:
        return cdmin
    cd = cd_inf_eff - aRe/np.sqrt(Re if Re > 1e-6 else 1e-6)
    if upc != 0.0 and np.isfinite(P_in) and Pref > 0.0:
        cd *= 1.0 + aP*(P_in/Pref - 1.0)
    if utc != 0.0 and np.isfinite(T_in) and Tref > 0.0:
        cd *= 1.0 + aT*(T_in/Tref - 1.0)
    return _clip(cd, cdmin, cd_inf_eff)

@njit(cache=True)
def _dpf(mdot, rho, din, ah, k0, k1, phi, P_tank):
    if phi == PHI_NONE:
        keff = k0
    elif phi == PHI_SQRTP:
        keff = k0 + k1*np.sqrt(P_tank if P_tank > 0 else 0.0)
    elif phi == PHI_LOGP:
        keff = k0 + k1*np.log(P_tank)
    else:
        return np.nan
    A = PI*(din*0.5)**2 if din > 0.0 else ah
    if not (A > 0.0) or not (rho > 0.0) or mdot < 0.0:
        return np.nan
    v = mdot/(rho*A)
    dp = keff*(rho*0.5)*v*v
    return 0.0 if dp < 0.0 else dp

@njit(cache=True)
def _bern(mdot_seed, dP, Pi, rho, area, dhyd, mu, Tin, cd_cap,
          cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT):
    if dP <= 0.0:
        c0 = _cd_from_re(0.0, Pi, Tin, dhyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT)
        return 0.0, c0 if c0 < cd_cap else cd_cap
    cdlo = _cd_from_re(0.0, Pi, Tin, dhyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT)
    cdlo = cdlo if cdlo < cd_cap else cd_cap
    m = mdot_seed if mdot_seed > 1e-18 else cdlo*area*np.sqrt(2.0*rho*dP)
    cd = cdlo
    for _ in range(120):
        m_was = m
        u = m/(rho*area) if area > 0.0 else 0.0
        Re = _reynolds(rho, u, dhyd, mu)
        cd = _cd_from_re(Re, Pi, Tin, dhyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT)
        cd = cd if cd < cd_cap else cd_cap
        m = cd*area*np.sqrt(2.0*rho*dP)
        denom = np.abs(m_was) if np.abs(m_was) > 1e-18 else 1e-18
        if np.abs(m - m_was)/denom < 1e-12:
            break
    return m, cd


@njit(cache=True)
def _ingebo(d_jet, u_rel, rho_l, mu_l, sigma, rho_g, C):
    if d_jet <= 0 or u_rel <= 0 or sigma <= 0 or rho_g <= 0 or rho_l <= 0 or mu_l <= 0 or C <= 0:
        return d_jet
    We_g = rho_g*u_rel*u_rel*d_jet/sigma
    Re_l = rho_l*u_rel*d_jet/mu_l
    p = We_g*Re_l
    if p <= 0:
        return d_jet
    return C*d_jet*p**(-0.25)

@njit(cache=True)
def _lefebvre(d_or, We, Oh, C, m, p):
    if We <= 0 or d_or <= 0:
        return d_or
    return C*d_or*We**(-m)*(1.0+Oh)**p

@njit(cache=True)
def _ohnesorge(mu, rho, sigma, d):
    if rho <= 0 or sigma <= 0 or d <= 0:
        return 0.0
    arg = rho*sigma*d
    return mu/np.sqrt(arg if arg > 1e-12 else 1e-12) if arg > 0 else 0.0

@njit(cache=True)
def injector_solve(P, P_tank_O, P_tank_F, Pc):
    """Returns (ok, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, mom_R, Cd_O, Cd_F,
    Pi_O, Pi_F, dpi_O, dpi_F, A_geom_O, A_geom_F,
    dpf_O, dpf_F, We_O, We_F, u_rel, x_star, constraints_ok, n_iter).
    ok=0 => NaN/invalid.

    The trailing eight are already computed by the solve; they are returned so the
    diagnostics dict can be assembled here instead of by a second solve in C.
    """
    rho_O = P[RHO_O]; mu_O = P[MU_O]; sig_O = P[SIG_O]; tO = P[T_O]
    rho_F = P[RHO_F]; mu_F = P[MU_F]; sig_F = P[SIG_F]; tF = P[T_F]
    djo = P[DJO]; djf = P[DJF]; nO = int(P[NO]); nF = int(P[NF])
    A_O = nO*PI*(djo*0.5)**2; A_F = nF*PI*(djf*0.5)**2
    max_iter = int(P[SV_CLMAX]); Cd_red = P[SV_CLCDRED]
    Cd_O_eff = _cd_inf_orifice(djo, P[DO_CDINF], P[DO_GEOM], P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR])
    Cd_F_eff = _cd_inf_orifice(djf, P[DF_CDINF], P[DF_GEOM], P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR])
    imp_sep = _clip(P[ANG_O] + P[ANG_F], 1.0, 179.0)
    imp_angle = imp_sep*PI/180.0

    mdot_O = 0.1; mdot_F = 0.1
    Cd_O = 0.0; Cd_F = 0.0; Pi_O = P_tank_O; Pi_F = P_tank_F
    dpi_O = 0.0; dpi_F = 0.0
    We_O = 0.0; We_F = 0.0; D32_O = 0.0; D32_F = 0.0; u_rel = 0.0
    dpf_O = 0.0; dpf_F = 0.0; x_star = 0.0; n_iter = 0
    u_O = 0.0; u_F = 0.0
    constraints_ok = 0

    for iteration in range(max_iter):
        n_iter = iteration + 1
        mo = mdot_O; mf = mdot_F
        for fp in range(1, 151):
            mo_prev = mo; mf_prev = mf
            dpf_O = _dpf(mo, rho_O, P[FO_DIN], P[FO_AH], P[FO_K0], P[FO_K1], P[FO_PHI], P_tank_O)
            dpf_F = _dpf(mf, rho_F, P[FF_DIN], P[FF_AH], P[FF_K0], P[FF_K1], P[FF_PHI], P_tank_F)
            Pi_O = P_tank_O - dpf_O; Pi_F = P_tank_F - dpf_F
            dpi_O = Pi_O - Pc if Pi_O - Pc > 0 else 0.0
            dpi_F = Pi_F - Pc if Pi_F - Pc > 0 else 0.0
            if Pi_O < Pc:
                mo_new = 0.0
            else:
                mo_new, _c = _bern(mo, dpi_O, Pi_O, rho_O, A_O, djo, mu_O, tO, Cd_O_eff,
                    P[DO_CDINF], P[DO_ARE], P[DO_CDMIN], P[DO_GEOM], P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR], P[DO_UPC], P[DO_PREF], P[DO_AP], P[DO_UTC], P[DO_TREF], P[DO_AT])
            if Pi_F < Pc:
                mf_new = 0.0
            else:
                mf_new, _c = _bern(mf, dpi_F, Pi_F, rho_F, A_F, djf, mu_F, tF, Cd_F_eff,
                    P[DF_CDINF], P[DF_ARE], P[DF_CDMIN], P[DF_GEOM], P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR], P[DF_UPC], P[DF_PREF], P[DF_AP], P[DF_UTC], P[DF_TREF], P[DF_AT])
            w = 0.35
            mo = mo_prev + w*(mo_new - mo_prev)
            mf = mf_prev + w*(mf_new - mf_prev)
            dpf_O = _dpf(mo, rho_O, P[FO_DIN], P[FO_AH], P[FO_K0], P[FO_K1], P[FO_PHI], P_tank_O)
            dpf_F = _dpf(mf, rho_F, P[FF_DIN], P[FF_AH], P[FF_K0], P[FF_K1], P[FF_PHI], P_tank_F)
            Pi_O = P_tank_O - dpf_O; Pi_F = P_tank_F - dpf_F
            dpi_O = Pi_O - Pc if Pi_O - Pc > 0 else 0.0
            dpi_F = Pi_F - Pc if Pi_F - Pc > 0 else 0.0
            if Pi_O < Pc:
                Cd_O = _cd_from_re(0.0, Pi_O, tO, djo, P[DO_CDINF], P[DO_ARE], P[DO_CDMIN], P[DO_GEOM], P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR], P[DO_UPC], P[DO_PREF], P[DO_AP], P[DO_UTC], P[DO_TREF], P[DO_AT])
                Cd_O = Cd_O if Cd_O < Cd_O_eff else Cd_O_eff
            else:
                u_o2 = mo/(rho_O*A_O) if A_O > 0 else 0.0
                Re_o2 = _reynolds(rho_O, u_o2, djo, mu_O)
                Cd_O = _cd_from_re(Re_o2, Pi_O, tO, djo, P[DO_CDINF], P[DO_ARE], P[DO_CDMIN], P[DO_GEOM], P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR], P[DO_UPC], P[DO_PREF], P[DO_AP], P[DO_UTC], P[DO_TREF], P[DO_AT])
                Cd_O = Cd_O if Cd_O < Cd_O_eff else Cd_O_eff
            if Pi_F < Pc:
                Cd_F = _cd_from_re(0.0, Pi_F, tF, djf, P[DF_CDINF], P[DF_ARE], P[DF_CDMIN], P[DF_GEOM], P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR], P[DF_UPC], P[DF_PREF], P[DF_AP], P[DF_UTC], P[DF_TREF], P[DF_AT])
                Cd_F = Cd_F if Cd_F < Cd_F_eff else Cd_F_eff
            else:
                u_f2 = mf/(rho_F*A_F) if A_F > 0 else 0.0
                Re_f2 = _reynolds(rho_F, u_f2, djf, mu_F)
                Cd_F = _cd_from_re(Re_f2, Pi_F, tF, djf, P[DF_CDINF], P[DF_ARE], P[DF_CDMIN], P[DF_GEOM], P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR], P[DF_UPC], P[DF_PREF], P[DF_AP], P[DF_UTC], P[DF_TREF], P[DF_AT])
                Cd_F = Cd_F if Cd_F < Cd_F_eff else Cd_F_eff
            den_o = max(abs(mo_prev), abs(mo)); den_o = den_o if den_o > 1e-18 else 1e-18
            den_f = max(abs(mf_prev), abs(mf)); den_f = den_f if den_f > 1e-18 else 1e-18
            if abs(mo - mo_prev)/den_o < 1e-6 and abs(mf - mf_prev)/den_f < 1e-6:
                break
        mdot_O = mo; mdot_F = mf
        u_O = mdot_O/(rho_O*A_O) if A_O > 0 else 0.0
        u_F = mdot_F/(rho_F*A_F) if A_F > 0 else 0.0
        u_rel = np.sqrt(u_O*u_O + u_F*u_F - 2.0*u_O*u_F*np.cos(imp_angle))
        rho_gas = Pc/(P[SP_GASR]*P[SP_GAST]); rho_gas = rho_gas if rho_gas > 1e-6 else 1e-6
        if P[SP_SMDMODEL] == SMD_INGEBO:
            D32_O = _ingebo(djo, u_rel, rho_O, mu_O, sig_O, rho_gas, P[SP_SMDCING])
            D32_F = _ingebo(djf, u_rel, rho_F, mu_F, sig_F, rho_gas, P[SP_SMDCING])
            We_O = rho_gas*u_rel*u_rel*djo/sig_O if sig_O > 0 else np.inf
            We_F = rho_gas*u_rel*u_rel*djf/sig_F if sig_F > 0 else np.inf
        else:
            alpha = 0.35
            uo_ = max(u_O, 0.0); uf_ = max(u_F, 0.0); ur_ = max(u_rel, 0.0)
            ue_O = np.sqrt(uo_*uo_ + (alpha*ur_)**2); ue_F = np.sqrt(uf_*uf_ + (alpha*ur_)**2)
            We_O = rho_O*ue_O*ue_O*djo/sig_O if sig_O > 0 else np.inf
            We_F = rho_F*ue_F*ue_F*djf/sig_F if sig_F > 0 else np.inf
            weO = We_O; weF = We_F
            if P[SP_SMDWECORR] > 0 and np.isfinite(P[SP_SMDWECORR]):
                weO = min(We_O, P[SP_SMDWECORR]); weF = min(We_F, P[SP_SMDWECORR])
            Oh_O = _ohnesorge(mu_O, rho_O, sig_O, djo); Oh_F = _ohnesorge(mu_F, rho_F, sig_F, djf)
            D32_O = _lefebvre(djo, weO, Oh_O, P[SP_SMDC], P[SP_SMDM], P[SP_SMDP])
            D32_F = _lefebvre(djf, weF, Oh_F, P[SP_SMDC], P[SP_SMDM], P[SP_SMDP])
        te_O = P[SP_EVAPK]*D32_O*D32_O; te_F = P[SP_EVAPK]*D32_F*D32_F
        x_star = max(u_rel*te_O, u_rel*te_F)
        constraints_ok = 1
        if We_O < P[SP_WEMIN] or We_F < P[SP_WEMIN]:
            constraints_ok = 0
        if P[SP_EVAPUSE] != 0 and x_star >= P[SP_EVAPXLIM]:
            constraints_ok = 0
        if constraints_ok:
            break
        Cd_O_eff *= Cd_red; Cd_F_eff *= Cd_red
        Cd_O_eff = max(Cd_O_eff, P[DO_CDMIN]); Cd_F_eff = max(Cd_F_eff, P[DF_CDMIN])

    # momentum ratio (bulk jet velocities)
    A_jet_O = PI*(djo*0.5)**2; A_jet_F = PI*(djf*0.5)**2
    n_O = nO if nO >= 1 else 1; n_F = nF if nF >= 1 else 1
    den_O = rho_O*n_O*A_jet_O; den_F = rho_F*n_F*A_jet_F
    v_O = mdot_O/den_O if den_O > 0 else np.nan
    v_F = mdot_F/den_F if den_F > 0 else np.nan
    mom_R = np.nan
    if rho_O > 0 and rho_F > 0 and np.isfinite(v_O) and np.isfinite(v_F) and v_F != 0.0:
        num = rho_O*v_O*v_O; den = rho_F*v_F*v_F
        if den > 0 and num >= 0:
            mom_R = np.sqrt(num/den)
    if not (np.isfinite(mdot_O) and np.isfinite(mdot_F)) or mdot_F <= 0.0:
        return (0, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, mom_R, Cd_O, Cd_F, Pi_O, Pi_F, dpi_O, dpi_F, A_O, A_F, dpf_O, dpf_F, We_O, We_F, u_rel, x_star, float(constraints_ok), float(n_iter))
    return (1, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, mom_R, Cd_O, Cd_F, Pi_O, Pi_F, dpi_O, dpi_F, A_O, A_F, dpf_O, dpf_F, We_O, We_F, u_rel, x_star, float(constraints_ok), float(n_iter))


@njit(cache=True)
def _gasification(Tc, Pc, tau_res, SMD, L_eff, cp_g, rho_g, U_slip, T_star_cap):
    rho_l = GAS_RHO_L; cp_l = GAS_CP_L; T_inj = GAS_T_INJ; mu_g = GAS_MU; Pr = PRANDTL
    D = SMD if SMD > D_MIN_GAS else D_MIN_GAS
    D_sq = D*D
    dT_safe = max(200.0, 0.10*Tc)
    T_star_upper = min(T_star_cap, Tc - dT_safe)
    T_star_lower = T_inj + 50.0
    T_star = _clip(T_star_upper, T_star_lower, Tc - dT_safe)
    k_g = mu_g*cp_g/Pr
    D_m = D_M_REF*(Tc/D_M_TREF)**1.75*(D_M_PREF/(Pc if Pc > 1e3 else 1e3))
    Us = min(abs(U_slip), U_SLIP_CAP); Us = max(Us, 0.1)
    Re = rho_g*Us*D/(mu_g if mu_g > 1e-10 else 1e-10)
    Sc = mu_g/(rho_g*(D_m if D_m > 1e-12 else 1e-12))
    Nu = 2.0 + 0.6*np.sqrt(max(Re, 0.0))*Pr**(1.0/3.0)
    Sh = 2.0 + 0.6*np.sqrt(max(Re, 0.0))*Sc**(1.0/3.0)
    dT_initial = Tc - T_inj; dT_final = Tc - T_star
    if dT_final <= 0 or dT_initial <= dT_final:
        tau_heat = 1e-9
    else:
        tau_heat = (rho_l*cp_l*D_sq)/(6.0*Nu*k_g)*np.log(dT_initial/dT_final)
    energy_available = cp_g*(Tc - T_star)
    energy_required = energy_available + L_eff
    Phi = _clip(energy_available/max(energy_required, 1e-6), 1e-6, 1.0)
    denom = 6.0*rho_g*D_m*Sh*Phi
    tau_gasify = np.inf if denom <= 0 else (rho_l*D_sq)/denom
    th = max(tau_heat, 1e-12); tg = max(tau_gasify, 1e-12)
    tau_vap = 1.0/(1.0/th + 1.0/tg)
    if tau_vap <= 0 or not np.isfinite(tau_vap):
        return 1.0
    return 1.0 - np.exp(-tau_res/tau_vap)

@njit(cache=True)
def _eta_advanced(P, Lstar, Pc, Tc, gamma, R, MR, Ac, At, Dinj, mdot_total,
                  u_F, u_O, D32_O, D32_F, mom_R, R_opt):
    if R <= 0 or Tc <= 0 or Ac <= 0 or At <= 0 or Dinj <= 0 or Lstar <= 0 or mdot_total <= 0:
        return -1.0
    rho_ch = Pc/(R*Tc)
    U_bulk = mdot_total/(rho_ch*Ac)
    G_throat = mdot_total/At
    tau_res = (Lstar*rho_ch)/G_throat
    U_rms = np.sqrt(0.5*(u_F*u_F + u_O*u_O))
    if not np.isfinite(U_rms) or U_rms < 0 or U_rms > CS_U_RMS_CAP:
        return -1.0
    dU = abs(u_F - u_O)
    U_mix = np.sqrt(dU*dU + CS_C_U*U_rms*U_rms)
    if not np.isfinite(U_mix) or U_mix <= 0:
        return -1.0
    cp_g = gamma*R/(gamma - 1.0) if gamma > 1.0 else GAS_CP_G
    # eta_Lstar
    model = int(P[C_MODEL])
    if model == EFF_CONSTANT:
        eta_L = 1.0 - P[C_C]
    elif model == EFF_LINEAR:
        eta_L = _clip(1.0 - P[C_C]*(1.0 - Lstar/1.0), 0.0, 1.0)
    else:
        o_ok = D32_O > 0 and np.isfinite(D32_O); f_ok = D32_F > 0 and np.isfinite(D32_F)
        if o_ok and f_ok:
            if np.isfinite(MR) and MR > 0:
                SMD = (MR/(1.0+MR))*D32_O + (1.0/(1.0+MR))*D32_F
            else:
                SMD = 0.5*(D32_O + D32_F)
        elif o_ok:
            SMD = D32_O
        elif f_ok:
            SMD = D32_F
        else:
            return -1.0
        if SMD <= 0:
            return -1.0
        U_slip = max(U_bulk, U_mix)
        eta_L = _gasification(Tc, Pc, tau_res, SMD, P[LAT_F], cp_g, rho_ch, U_slip, P[C_TSTARCAP])
    # eta_kinetics
    Ea_norm = 12.0 if MR < 1.5 else (8.0 if MR > 3.0 else 10.0)
    pf = (P[C_TAUREFP]/(Pc if Pc > 1e5 else 1e5))**P[C_NPRESS]
    Tc_eff = Tc
    if P[C_HASFLOOR] != 0 and np.isfinite(P[C_TAUFLOOR]) and P[C_TAUFLOOR] > 0:
        Tc_eff = max(Tc_eff, P[C_TAUFLOOR])
    exp_arg = _clip(Ea_norm*(P[C_TAUREFT]/max(Tc_eff, 1000.0) - 1.0), -20.0, 20.0)
    tau_chem = P[C_TAUREF]*pf*np.exp(exp_arg)
    Da = np.inf if tau_chem <= 0 else tau_res/tau_chem
    eta_k = 1.0 - np.exp(-np.sqrt(Da))
    # eta_mixing (Rupe)
    if not (mom_R > 0.0 and np.isfinite(mom_R)):
        return -1.0
    Ro = R_opt if (R_opt > 0 and np.isfinite(R_opt)) else 1.0
    sig = P[C_SIGMA] if (P[C_SIGMA] > 0 and np.isfinite(P[C_SIGMA])) else 1.5
    z = np.log(mom_R/Ro)
    eta_m = P[C_EMPEAK]*np.exp(-(z*z)/(2.0*sig*sig))
    eta_total = eta_L*eta_k*eta_m
    if not np.isfinite(eta_total):
        return -1.0
    return eta_total

@njit(cache=True)
def _gas_viscosity_huzel(T_K, M):
    """ed_gas_viscosity_huzel: Huzel-Huang gas viscosity correlation."""
    mu_lb_s_in2 = HUZEL_COEFF*np.sqrt(M)*(T_K*RANKINE_PER_K)**0.6
    return mu_lb_s_in2*LB_S_PER_IN2_TO_PA_S


@njit(cache=True)
def _chamber_wetted_area(P):
    """ed_chamber_wetted_area: frustum when both sub-lengths present, else cylinder."""
    d = P[G_DCHAM]
    if d <= 0:
        d = 0.08                      # matches Python's final fallback
    if d < 1e-6:
        d = 1e-6
    area_cross = PI*(d*0.5)*(d*0.5)
    circumference = PI*d
    if P[G_LCYL] > 0 and P[G_LCONTR] > 0:
        area_cyl = circumference*P[G_LCYL]
        r1 = d*0.5
        A_t = P[G_AT] if P[G_AT] > 0 else area_cross/3.0
        r2 = np.sqrt(A_t/PI)
        slant = np.sqrt((r1-r2)*(r1-r2) + P[G_LCONTR]*P[G_LCONTR])
        return area_cyl + PI*(r1+r2)*slant
    return circumference*P[G_LEN]


@njit(cache=True)
def _hot_wall_flux(P, Pc, Tc, gamma, R, M, mdot_total, wall_T):
    """estimate_hot_wall_heat_flux -> (q_total, q_conv, q_rad).

    NOTE the diameter: this uses the REGEN block's chamber_inner_diameter, while
    _cooling_evaluate's bulk-velocity term uses geom.chamber_diameter. They are
    different numbers and ed_cooling.c:43 vs :151 keeps them distinct -- do not
    collapse them.
    """
    d = P[K_DREGEN]
    A_cross = PI*d*d/4.0
    rho_g = max(Pc/(R*max(Tc, 1.0)), MIN_DENS)
    V_g = mdot_total/(rho_g*A_cross)
    mu_g = _gas_viscosity_huzel(Tc, M) if (M > 0 and Tc > 0) else P[K_HGMU]
    k_g = P[K_HGK]
    cp_g = gamma*R/max(gamma-1.0, EPS_SMALL)
    Pr_g = P[K_HGPR] if P[K_HGPR] > 0 else (mu_g*cp_g/max(k_g, EPS_SMALL))
    Re_g = rho_g*V_g*d/max(mu_g, EPS_TINY)
    if Re_g < 2000.0:
        Nu_g = NU_LAMINAR
    else:
        Nu_g = NU_TURB_COEF*Re_g**NU_TURB_RE_EXP*Pr_g**NU_TURB_PR_EXP
    h_g = Nu_g*k_g/d
    Taw = Tc*P[K_RECOV]
    dT = max(Taw - wall_T, 0.0)
    q_conv = h_g*dT
    qr = P[K_EMISHOT]*P[K_VIEWF]*STEFAN*(Tc**4 - wall_T**4)
    q_rad = max(qr, 0.0)
    return q_conv + q_rad, q_conv, q_rad


@njit(cache=True)
def _ablative_heat_removed(P, surface_T, area, ti, q_conv, q_rad, gas_mdot):
    """compute_ablative_response -> heat_removed (cooling_power)."""
    if P[K_ABLEN] == 0 or area <= 0:
        return 0.0
    turb = 1.0
    if ti > 0 and P[AB_TIREF] > 0:
        ratio = (ti/P[AB_TIREF])**P[AB_TIEXP]
        turb = 1.0 + P[AB_TISENS]*ratio
    turb = _clip(turb, 1.0, P[AB_TIMAX])

    below_pyro = surface_T < P[AB_TPYRO]
    use_physics = False
    convective_reduction = 1.0
    if below_pyro:
        convective_reduction = 1.0
    elif P[AB_USEPHYS] != 0 and gas_mdot > 0:
        use_physics = True
    else:
        convective_reduction = 1.0 - _clip(P[AB_BLOWEFF], 0.0, 1.0)

    T_sink = P[AB_SINKFB] if P[AB_TAMB] < P[AB_SINKMIN] else P[AB_TAMB]
    radiative_relief = max(P[AB_EMIS]*STEFAN*(surface_T**4 - T_sink**4), 0.0)

    if use_physics:
        q_conv_prov = q_conv*turb
        q_total_prov = max(q_conv_prov + q_rad - radiative_relief, 0.0)
        if q_total_prov > 0:
            dT_pyro = max(surface_T - P[AB_TPYRO], 0.0)
            energy_per_mass = P[AB_HABL] + P[AB_CP]*dT_pyro
            if energy_per_mass > 0:
                mass_flux_prov = q_total_prov/max(energy_per_mass, EPS_SMALL)
                m_dot_pyro = mass_flux_prov*area
                B = m_dot_pyro/max(gas_mdot, EPS_SMALL)
                blow = 1.0/(1.0 + P[AB_BLOWC]*B)
                convective_reduction = max(blow, P[AB_BLOWMIN])
            else:
                convective_reduction = 1.0
        else:
            convective_reduction = 1.0

    q_conv_eff = q_conv*turb*convective_reduction
    effective_heat_flux = max(q_conv_eff + q_rad - radiative_relief, 0.0)
    if below_pyro or effective_heat_flux <= 0:
        return 0.0
    dT_pyro = max(surface_T - P[AB_TPYRO], 0.0)
    if P[AB_HABL] + P[AB_CP]*dT_pyro <= 0:
        return 0.0
    return effective_heat_flux*area


@njit(cache=True)
def _cooling_evaluate(P, Pc, mdot_total, Tc, gamma, R, M):
    """ed_cooling_evaluate -> (ok, cooling_eff, effective_Tc).

    ok==0 mirrors C's ED_ERR_NOT_IMPLEMENTED (film/regen enabled), which the
    caller turns into a Python fallback rather than a wrong number.
    """
    if mdot_total <= 0:
        return 1.0, 1.0, Tc
    if P[K_FILMEN] != 0 or P[K_REGENEN] != 0:
        return 0.0, 1.0, Tc                 # not ported -> fall back to Python
    if P[K_USECOUP] == 0 or P[K_ABLEN] == 0:
        return 1.0, 1.0, Tc

    d = P[G_DCHAM]
    if d <= 0:
        d = 0.08
    if d < 1e-6:
        d = 1e-6
    area_cross = PI*(d*0.5)*(d*0.5)
    rho_g = max(Pc/(R*max(Tc, 1.0)), 1e-6)
    velocity_g = mdot_total/(rho_g*area_cross)
    mu_g = _gas_viscosity_huzel(Tc, M) if (M > 0 and Tc > 0) else P[K_HGMU]
    Re_g = rho_g*velocity_g*d/max(mu_g, 1e-8)

    ti = 0.05
    if Re_g > 0:
        ti = _clip(0.16*Re_g**(-0.125), 0.02, 0.25)
    ti = max(ti, _clip(P[K_TI], 0.0, 0.5))

    # hot-wall flux uses Tc_ideal (film disabled => effective_Tc == Tc here)
    q_total, q_conv, q_rad = _hot_wall_flux(P, Pc, Tc, gamma, R, M, mdot_total, P[AB_TSURF])
    abl_area = _chamber_wetted_area(P)*_clip(P[AB_COV], 0.0, 1.0)
    heat_removed = _ablative_heat_removed(P, P[AB_TSURF], abl_area, ti, q_conv, q_rad, mdot_total)

    effective_Tc = Tc
    cp = gamma*R/max(gamma-1.0, EPS_SMALL)
    if heat_removed > 0 and mdot_total > 0:
        delta_T = heat_removed/max(mdot_total*cp, EPS_SMALL)
        effective_Tc = max(effective_Tc - delta_T, 1.0)

    cooling_eff = 1.0
    if heat_removed > 0:
        available = mdot_total*cp*max(effective_Tc, 1.0)
        if available > 0:
            cooling_eff = _clip(1.0 - heat_removed/available, P[K_EFFFLOOR], 1.0)
    return 1.0, cooling_eff, effective_Tc


@njit(cache=True)
def _residual(Pc, P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F):
    if not (np.isfinite(Pc) and Pc > 0):
        return np.nan
    (ok, mO, mF, uO, uF, D32O, D32F, momR, CdO, CdF, PiO, PiF, dpiO, dpiF, AgO, AgF,
     dpfO, dpfF, WeO, WeF, urel, xstar, constr, nit) = injector_solve(P, P_O, P_F, Pc)
    if ok == 0:
        return np.nan
    mdot_supply = mO + mF
    MR = mO/mF
    cs_id, cf_id, tc, gm, Rg, Mg, cfv = cea_eval(Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, MR, Pc, P[G_EPS])
    if not (cs_id > 0 and np.isfinite(cs_id)):
        return np.nan
    Lstar = P[G_LSTAR] if P[G_LSTAR] > 0 else (P[G_VOL]/P[G_AT] if P[G_AT] > 0 else 0.0)
    Dinj = P[DJO]
    Ac = PI*(P[G_DCHAM]*0.5)**2
    if P[C_ROPT] > 0.0:
        R_opt = P[C_ROPT]
    else:
        sO = np.sin(P[ANG_O]*PI/180.0); sF = np.sin(P[ANG_F]*PI/180.0)
        R_opt = np.sqrt(sF/sO) if (sO > 0 and sF > 0) else 1.0
    eta_total = _eta_advanced(P, Lstar, Pc, tc, gm, Rg, MR, Ac, P[G_AT], Dinj, mdot_supply, uF, uO, D32O, D32F, momR, R_opt)
    if eta_total < 0:
        return np.nan
    cok, cooling_eff, _tc_eff = _cooling_evaluate(P, Pc, mdot_supply, tc, gm, Rg, Mg)
    if cok == 0.0:
        return np.nan
    eta_final = eta_total*cooling_eff
    if not (np.isfinite(eta_final) and eta_final > 0.0 and eta_final <= 1.0):
        return np.nan
    cstar_actual = eta_final*cs_id
    mdot_demand = Pc*P[G_AT]/cstar_actual
    r = mdot_supply - mdot_demand
    return r if np.isfinite(r) else np.nan

@njit(cache=True)
def _sign(x):
    return -1.0 if x < 0 else (1.0 if x > 0 else 0.0)

@njit(cache=True)
def _brentq(P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F, a, b, xtol, rtol, maxit):
    fa = _residual(a, P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F)
    fb = _residual(b, P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F)
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
        fb = _residual(b, P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F)
        if not np.isfinite(fb):
            return np.nan
    return b

@njit(cache=True)
def _solve_exit_mach(eps, g):
    tol = 1e-10
    if eps > 10.0:
        pref = ((g+1.0)/(g-1.0))**((g+1.0)/4.0); Mg = pref*eps**((g-1.0)/2.0)
    elif eps > 1.5:
        Mg = 1.0 + np.sqrt(2.0*(eps-1.0)/(g+1.0))
    else:
        Mg = 1.0 + 0.5*(eps-1.0)
    M = max(Mg, 1.0+1e-6)
    for _ in range(50):
        term = (2.0/(g+1.0))*(1.0+(g-1.0)/2.0*M*M)
        A = (1.0/M)*term**((g+1.0)/(2.0*(g-1.0)))
        err = A - eps
        if abs(err) < tol:
            return M
        num = 2.0*(M*M-1.0); den = M*(2.0+(g-1.0)*M*M); dA = A*(num/den)
        if abs(dA) < 1e-12:
            M = M*(0.99 if err > 0 else 1.01)
        else:
            step = _clip(err/dA, -0.5*M, 0.5*M); M = M - step
        if M <= 1.0:
            M = 1.0 + 1e-6
    return M

@njit(cache=True)
def evaluate_core(P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F, Pa):
    """Returns (ok, Pc, F, Isp, MR, cstar_actual, gamma, Tc, mdot_total, v_exit, Cf_actual)."""
    Pc_min = 100000.0
    Pc_max = min(P_O, P_F)*(1.0 - 0.15)
    Pc_min = max(Pc_min, P[SV_PCMIN]); Pc_max = min(Pc_max, P[SV_PCMAX])
    if Pc_max <= Pc_min:
        return (0.0,)*22
    xtol = P[SV_TOL]; rtol = P[SV_TOL]*1e-3; maxit = int(P[SV_MAXIT]) if P[SV_MAXIT] > 0 else 100
    rmin = _residual(Pc_min, P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F)
    rmax = _residual(Pc_max, P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F)
    if not np.isfinite(rmin) or not np.isfinite(rmax):
        return (0.0,)*22
    if _sign(rmin) == _sign(rmax):
        if rmin > 0 and rmax > 0 and rmax < 0.1:
            Pc = Pc_max
        else:
            return (0.0,)*22
    else:
        Pc = _brentq(P, Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, P_O, P_F, Pc_min, Pc_max, xtol, rtol, maxit)
        if not np.isfinite(Pc):
            return (0.0,)*22
    # recompute converged state
    (ok, mO, mF, uO, uF, D32O, D32F, momR, CdO, CdF, PiO, PiF, dpiO, dpiF, AgO, AgF,
     dpfO, dpfF, WeO, WeF, urel, xstar, constr, nit) = injector_solve(P, P_O, P_F, Pc)
    if ok == 0:
        return (0.0,)*22
    mdot_total = mO + mF; MR = mO/mF
    cs_id, cf_id, tc, gm, Rg, Mg, cfv = cea_eval(Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, MR, Pc, P[G_EPS])
    Lstar = P[G_LSTAR] if P[G_LSTAR] > 0 else (P[G_VOL]/P[G_AT] if P[G_AT] > 0 else 0.0)
    Ac = PI*(P[G_DCHAM]*0.5)**2
    if P[C_ROPT] > 0.0:
        R_opt = P[C_ROPT]
    else:
        sO = np.sin(P[ANG_O]*PI/180.0); sF = np.sin(P[ANG_F]*PI/180.0)
        R_opt = np.sqrt(sF/sO) if (sO > 0 and sF > 0) else 1.0
    eta_total = _eta_advanced(P, Lstar, Pc, tc, gm, Rg, MR, Ac, P[G_AT], P[DJO], mdot_total, uF, uO, D32O, D32F, momR, R_opt)
    # Cooling at the converged point, matching the residual. C reports
    # eta_cstar = eta_total*cooling_eff and derives cstar_actual from THAT
    # (ed_chamber.c:91-92), so report eta_final here, not eta_total.
    cok, cooling_eff, Tc_eff = _cooling_evaluate(P, Pc, mdot_total, tc, gm, Rg, Mg)
    if cok == 0.0:
        return (0.0,)*22
    eta_final = eta_total*cooling_eff
    cstar_actual = eta_final*cs_id
    # nozzle CEA at converged point (Pa ignored in 3D lookup)
    cs2, cf2, tc2, gm2, Rg2, Mg2, cfv2 = cea_eval(Pcg, MRg, epsg, cstar, Cf, Tc_t, gam, Rt, Mt, Cfv, MR, Pc, P[G_EPS])
    if not np.isfinite(cfv2):
        return (0.0,)*22
    M_exit = _solve_exit_mach(P[G_EPS], gm2)
    factor = 1.0 + (gm2-1.0)/2.0*M_exit*M_exit
    T_exit = tc2/factor
    P_exit = Pc*factor**(-gm2/(gm2-1.0))
    v_exit = M_exit*np.sqrt(gm2*Rg2*T_exit)
    thr = 2.0/(gm2+1.0)
    T_throat = tc2*thr
    P_throat = Pc*thr**(gm2/(gm2-1.0))
    F = P[G_NOZZEFF]*cfv2*Pc*P[G_AT] - Pa*P[G_AE]
    if not np.isfinite(F):
        return (0.0,)*22
    Isp = F/(mdot_total*G0)
    Cf_actual = F/(Pc*P[G_AT])
    # Index 7 is Tc_IDEAL (EdEvaluateResult.Tc = ch.Tc_ideal, ed_evaluate.c:89) and
    # index 21 is Tc_EFFECTIVE (out->Tc_effective = ch.Tc, :111). The wrapper dict's
    # "Tc" must use the EFFECTIVE one -- native_injector.py:538 does, and it feeds
    # comprehensive_stability_analysis. They are equal only while cooling is off.
    return (1.0, Pc, F, Isp, MR, cstar_actual, gm, tc, mdot_total, v_exit, Cf_actual,
            mO, mF, cs_id, eta_final, Rg2, P_exit, P_throat, T_exit, T_throat, cf2,
            Tc_eff)




# ---- Python wrappers matching native_injector -------------------------------
class NumbaEvaluator:
    """Parity/bench helper: core physics only (Pc, F, Isp, ...)."""
    def __init__(self, config, cache):
        self.P = extract_params(config)
        self.cea = cea_arrays(cache)

    def chamber_solve(self, P_O, P_F):
        r = evaluate_core(self.P, *self.cea, float(P_O), float(P_F), 101325.0)
        return float(r[1]) if r[0] else None

    def evaluate(self, P_O, P_F, Pa=101325.0):
        r = evaluate_core(self.P, *self.cea, float(P_O), float(P_F), float(Pa))
        if not r[0]:
            return None
        (_, Pc, F, Isp, MR, csa, gm, tc, mdt, vex, cfa,
         mO, mF, cs_id, eta, Rg, Pex, Pth, Tex, Tth, cf_id, tc_eff) = r
        return {"Pc": Pc, "F": F, "Isp": Isp, "MR": MR, "cstar_actual": csa,
                "gamma": gm, "Tc": tc_eff, "mdot_total": mdt, "v_exit": vex, "Cf_actual": cfa}
