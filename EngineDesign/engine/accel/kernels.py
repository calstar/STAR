"""Numba mirror of the Python injector solve (impinging and pintle) and the CEA lookup.

All state arrives as one flat float64 vector built by params.extract_params, plus the CEA tables
as plain arrays -- @njit sees no Python objects.

injector_solve / injector_solve_pintle / _dpf mirror the Python injector exactly (one closure
pass with Cd untouched, the K_exit exit dump, A_hydraulic, pintle's fixed-K x*, the back-channel
ring network hole by hole), and that is what accel.solve serves on the default path. The chamber
(c* efficiency, ablative liner, nozzle, Pc root) is engine/accel/chamber.py.
"""
from __future__ import annotations

import numpy as np
from numba import njit

from engine.accel.cea import cea_arrays, _cea_arrays_cached
from engine.accel.params import _IDX, NP, extract_params

globals().update(_IDX)          # param indices as module-level int constants

# Lichtarowicz (1965) Re law + counterbore entrance K: the Python model's own constants, so the
# kernel cannot drift from engine.core.discharge.
from engine.core.discharge import (
    LICHTAROWICZ_RE_A as LICH_RE_A, LICHTAROWICZ_RE_B as LICH_RE_B,
    LICHTAROWICZ_RE_C as LICH_RE_C, LICHTAROWICZ_RE_D as LICH_RE_D,
    LICHTAROWICZ_RE_E as LICH_RE_E, COUNTERBORE_ENTRANCE_K as COUNTERBORE_K,
)

# physical constants (ed_phys_const.h)
# physical constants (ed_phys_const.h)
PI = np.pi
G0 = 9.80665
P_SEA = 101325.0
# ed_cooling.c / ed_phys_const.h
RANKINE_PER_K = 1.8; HUZEL_COEFF = 46.6e-10; LBM_PER_IN_S_TO_PA_S = 0.45359237 / 0.0254  # Huzel fit is lbm/(in s)
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
def _cd_lichtarowicz_re(cd_u, Re, x):
    """engine.core.discharge.cd_lichtarowicz_re (Lichtarowicz, Duggins & Markland 1965)."""
    lg = np.log10(LICH_RE_E*Re)
    inv = (1.0/cd_u
           + LICH_RE_A*(1.0 + LICH_RE_B*x)/Re
           - LICH_RE_C*x/(1.0 + LICH_RE_D*lg*lg))
    return 1.0/inv

@njit(cache=True)
def _cd_from_re(Re, P_in, T_in, d_hyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg,
                cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu):
    cd_inf_eff = _cd_inf_orifice(d_hyd, cdinf, geom, dref, dmin, exps, logg, cdmax, cdfloor)
    if Re <= 0.0:
        return cdmin
    if lod > 0.0:
        cd = _cd_lichtarowicz_re(cdu, Re, lod)
        if beta > 0.0:
            b4 = beta**4
            cd = 1.0/np.sqrt((1.0 - b4)/cd**2 + b4*(1.0 + COUNTERBORE_K))
        if cd > 0.98:
            cd = 0.98
    else:
        cd = cd_inf_eff - aRe/np.sqrt(Re if Re > 1e-6 else 1e-6)
    if upc != 0.0 and np.isfinite(P_in) and Pref > 0.0:
        cd *= 1.0 + aP*(P_in/Pref - 1.0)
    if utc != 0.0 and np.isfinite(T_in) and Tref > 0.0:
        cd *= 1.0 + aT*(T_in/Tref - 1.0)
    return _clip(cd, cdmin, cd_inf_eff)

@njit(cache=True)
def _dpf(mdot, rho, ah, k0, k1, phi, P_tank, kx, dex):
    """feed_loss.delta_p_feed: K_eff(P) velocity head on A_hydraulic plus the exit dump.

    dp = K_eff (rho/2) (mdot/(rho A_hyd))^2 + K_exit (rho/2) (mdot/(rho A_exit))^2, with
    A_exit the d_exit bore when one is declared and A_hyd otherwise. The passage is ALWAYS
    A_hydraulic (the schema derives it from d_inlet), never pi d_inlet^2/4: a twin line
    declares the summed area, and the bore-derived area overstated its loss 4x.

    k0 arrives with the itemised fittings already summed in (params._feed). The Colebrook
    friction path (feed_system.<side>.roughness_m) is NOT mirrored -- it needs mu per call --
    and accel.can_handle hands those configs to Python.
    """
    if phi == PHI_NONE:
        keff = k0
    elif phi == PHI_SQRTP:
        keff = k0 + k1*np.sqrt(P_tank if P_tank > 0 else 0.0)
    elif phi == PHI_LOGP:
        keff = k0 + k1*np.log(P_tank)
    else:
        return np.nan
    A = ah
    if not (A > 0.0) or not (rho > 0.0) or mdot < 0.0:
        return np.nan
    Ax = PI*(dex*0.5)**2 if dex > 0.0 else A
    v = mdot/(rho*A)
    vx = mdot/(rho*Ax)
    dp = keff*(rho*0.5)*v**2 + kx*(rho*0.5)*vx**2
    return 0.0 if dp < 0.0 else dp

@njit(cache=True)
def _bern(mdot_seed, dP, Pi, rho, area, dhyd, mu, Tin, cd_cap,
          cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu):
    if dP <= 0.0:
        c0 = _cd_from_re(0.0, Pi, Tin, dhyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu)
        return 0.0, c0 if c0 < cd_cap else cd_cap
    cdlo = _cd_from_re(0.0, Pi, Tin, dhyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu)
    cdlo = cdlo if cdlo < cd_cap else cd_cap
    m = mdot_seed if mdot_seed > 1e-18 else cdlo*area*np.sqrt(2.0*rho*dP)
    cd = cdlo
    for _ in range(120):
        m_was = m
        u = m/(rho*area) if area > 0.0 else 0.0
        Re = _reynolds(rho, u, dhyd, mu)
        cd = _cd_from_re(Re, Pi, Tin, dhyd, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu)
        cd = cd if cd < cd_cap else cd_cap
        m = cd*area*np.sqrt(2.0*rho*dP)
        denom = np.abs(m_was) if np.abs(m_was) > 1e-18 else 1e-18
        if np.abs(m - m_was)/denom < 1e-12:
            break
    return m, cd


@njit(cache=True)
def _stream_state(m, Pc, P_tank, rho, A, dh, mu, Tin, cd_cap, AH, K0, K1, PHI, KX, DEX,
                  cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu, pv, cc):
    dpf = _dpf(m, rho, AH, K0, K1, PHI, P_tank, KX, DEX)
    Pi = P_tank - dpf
    u = m/(rho*A) if A > 0.0 else 0.0
    Re = _reynolds(rho, u, dh, mu)
    cd = _cd_from_re(Re, Pi, Tin, dh, cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu)
    cd = cd if cd < cd_cap else cd_cap
    if cc > 0.0 and pv == pv and Pi > Pc:
        # Cavitating orifice (Nurick 1976), mirrors impinging._stream_flow.cd_of
        K = (Pi - pv)/(Pi - Pc)
        cdc = cc*np.sqrt(K if K > 0.0 else 0.0)
        cd = cd if cd < cdc else cdc
    dpi = Pi - Pc
    mb = cd*A*np.sqrt(2.0*rho*dpi) if dpi > 0.0 else 0.0
    return m - mb, cd, Pi, dpf, (dpi if dpi > 0.0 else 0.0)


@njit(cache=True)
def _stream_flow(Pc, P_tank, rho, A, dh, mu, Tin, cd_cap, AH, K0, K1, PHI, KX, DEX,
                 cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu, pv, cc):
    """Mirrors impinging._stream_flow: Illinois false position on [0, Cd_cap A sqrt(2 rho (P_tank - Pc))]."""
    if not (A > 0.0) or not (P_tank > Pc):
        g, cd, Pi, dpf, dpi = _stream_state(0.0, Pc, P_tank, rho, A, dh, mu, Tin, cd_cap, AH, K0, K1, PHI, KX, DEX,
                                            cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu, pv, cc)
        return 0.0, cd, Pi, dpf, dpi
    hi = cd_cap*A*np.sqrt(2.0*rho*(P_tank - Pc))
    a = 0.0; b = hi
    ga = _stream_state(a, Pc, P_tank, rho, A, dh, mu, Tin, cd_cap, AH, K0, K1, PHI, KX, DEX,
                       cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu, pv, cc)[0]
    gb = _stream_state(b, Pc, P_tank, rho, A, dh, mu, Tin, cd_cap, AH, K0, K1, PHI, KX, DEX,
                       cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu, pv, cc)[0]
    tol = 1e-13*hi
    if gb <= 0.0:
        m = b
    elif ga >= 0.0:
        m = a
    else:
        side = 0
        m = b
        for _ in range(200):
            m = (a*gb - b*ga)/(gb - ga)
            gm = _stream_state(m, Pc, P_tank, rho, A, dh, mu, Tin, cd_cap, AH, K0, K1, PHI, KX, DEX,
                               cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu, pv, cc)[0]
            if abs(gm) <= tol or b - a <= tol:
                break
            if gm > 0.0:
                b = m; gb = gm
                if side == -1:
                    ga *= 0.5
                side = -1
            else:
                a = m; ga = gm
                if side == 1:
                    gb *= 0.5
                side = 1
    g, cd, Pi, dpf, dpi = _stream_state(m, Pc, P_tank, rho, A, dh, mu, Tin, cd_cap, AH, K0, K1, PHI, KX, DEX,
                                        cdinf, aRe, cdmin, geom, dref, dmin, exps, logg, cdmax, cdfloor, upc, Pref, aP, utc, Tref, aT, lod, beta, cdu, pv, cc)
    return m, cd, Pi, dpf, dpi


@njit(cache=True)
def _churchill_f(Re, rel_rough):
    """impinging._churchill_f: Darcy friction, Churchill (1977)."""
    if not (Re > 0.0):
        return 0.0
    A = (2.457*np.log(1.0/((7.0/Re)**0.9 + 0.27*rel_rough)))**16
    B = (37530.0/Re)**16
    return 8.0*((8.0/Re)**12 + 1.0/(A + B)**1.5)**(1.0/12.0)


@njit(cache=True)
def _cd_side(P, side, Re, P_in, Pc, cd_cap):
    """impinging._stream_flow.cd_of for one stream: Cd(Re, P_in) capped, then the Nurick limit."""
    if side == 0:
        cd = _cd_from_re(Re, P_in, P[T_O], P[DJO], P[DO_CDINF], P[DO_ARE], P[DO_CDMIN], P[DO_GEOM],
                         P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR],
                         P[DO_UPC], P[DO_PREF], P[DO_AP], P[DO_UTC], P[DO_TREF], P[DO_AT], P[DO_LOD],
                         P[DO_BETA], P[DO_CDU])
        pv = P[VP_O]; cc = P[CC_O]
    else:
        cd = _cd_from_re(Re, P_in, P[T_F], P[DJF], P[DF_CDINF], P[DF_ARE], P[DF_CDMIN], P[DF_GEOM],
                         P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR],
                         P[DF_UPC], P[DF_PREF], P[DF_AP], P[DF_UTC], P[DF_TREF], P[DF_AT], P[DF_LOD],
                         P[DF_BETA], P[DF_CDU])
        pv = P[VP_F]; cc = P[CC_F]
    cd = cd if cd < cd_cap else cd_cap
    if cc > 0.0 and pv == pv and P_in > Pc:
        K = (P_in - pv)/(P_in - Pc)
        cdc = cc*np.sqrt(K if K > 0.0 else 0.0)
        cd = cd if cd < cdc else cdc
    return cd


@njit(cache=True)
def _net_march(P, side, m_total, P_port, Pc, cd_cap, holes):
    """impinging._RingManifold.march: one branch of the dividing-flow ring, hole by hole.

    Fills ``holes`` with each hole's flow (port first); returns (stream total, flow-weighted Cd)."""
    if side == 0:
        b = NET_O; rho = P[RHO_O]; mu = P[MU_O]
    else:
        b = NET_F; rho = P[RHO_F]; mu = P[MU_F]
    n_ports = P[b + 1]; h = int(P[b + 2]); A_ch = P[b + 3]; D_h = P[b + 4]; s = P[b + 5]
    eps = P[b + 6]; scale = P[b + 7]; A_hole = P[b + 8]; d_hole = P[b + 9]
    K_ent = P[b + 10]; C_R = P[b + 11]
    mb = m_total/(2.0*n_ports)
    u = mb/(rho*A_ch)
    p = P_port - (1.0 + K_ent)*0.5*rho*u*u
    s_q = 0.0; s_cq = 0.0; cd0 = 0.0
    for j in range(h):
        seg = 0.5*s if j == 0 else s
        Re_ch = rho*abs(u)*D_h/mu
        p -= _churchill_f(Re_ch, eps)*(seg/D_h)*0.5*rho*u*abs(u)
        dp = p - Pc
        q = 0.0
        if dp > 0.0:
            q = _cd_side(P, side, 0.0, p, Pc, cd_cap)*A_hole*np.sqrt(2.0*rho*dp)
            for _ in range(3):   # the hole's Cd at its own Reynolds number
                Re_h = rho*(q/(rho*A_hole))*d_hole/mu
                q = _cd_side(P, side, Re_h, p, Pc, cd_cap)*A_hole*np.sqrt(2.0*rho*dp)
        if dp > 0.0 and q > 0.0:
            c = q/(A_hole*np.sqrt(2.0*rho*dp))
        else:
            c = _cd_side(P, side, 0.0, p, Pc, cd_cap)
        if j == 0:
            cd0 = c
        mb -= q
        u_new = mb/(rho*A_ch)
        p += C_R*0.5*rho*(u*u - u_new*u_new)
        u = u_new
        holes[j] = q
        s_q += q
        s_cq += c*q
    total = 2.0*n_ports*scale*s_q
    return total, (s_cq/s_q if s_q > 0.0 else cd0)


@njit(cache=True)
def _stream_state_net(m, Pc, P_tank, side, A, cd_cap, P, holes):
    """impinging._stream_flow.state with a ring network."""
    if side == 0:
        dpf = _dpf(m, P[RHO_O], P[FO_AH], P[FO_K0], P[FO_K1], P[FO_PHI], P_tank, P[FO_KX], P[FO_DEX])
    else:
        dpf = _dpf(m, P[RHO_F], P[FF_AH], P[FF_K0], P[FF_K1], P[FF_PHI], P_tank, P[FF_KX], P[FF_DEX])
    Pi = P_tank - dpf
    dpi = Pi - Pc
    mb, cd = _net_march(P, side, m, Pi, Pc, cd_cap, holes)
    return m - mb, cd, Pi, dpf, (dpi if dpi > 0.0 else 0.0)


@njit(cache=True)
def _stream_flow_net(Pc, P_tank, side, A, cd_cap, P, holes):
    """impinging._stream_flow with ``network``: the same Illinois root on the stream total; the
    last state evaluated is the root's, so ``holes`` ends holding the solved per-hole flows."""
    rho = P[RHO_O] if side == 0 else P[RHO_F]
    if not (A > 0.0) or not (P_tank > Pc):
        g, cd, Pi, dpf, dpi = _stream_state_net(0.0, Pc, P_tank, side, A, cd_cap, P, holes)
        return 0.0, cd, Pi, dpf, dpi
    hi = cd_cap*A*np.sqrt(2.0*rho*(P_tank - Pc))
    a = 0.0; b = hi
    ga = _stream_state_net(a, Pc, P_tank, side, A, cd_cap, P, holes)[0]
    gb = _stream_state_net(b, Pc, P_tank, side, A, cd_cap, P, holes)[0]
    tol = 1e-13*hi
    if gb <= 0.0:
        m = b
    elif ga >= 0.0:
        m = a
    else:
        side_ = 0
        m = b
        for _ in range(200):
            m = (a*gb - b*ga)/(gb - ga)
            gm = _stream_state_net(m, Pc, P_tank, side, A, cd_cap, P, holes)[0]
            if abs(gm) <= tol or b - a <= tol:
                break
            if gm > 0.0:
                b = m; gb = gm
                if side_ == -1:
                    ga *= 0.5
                side_ = -1
            else:
                a = m; ga = gm
                if side_ == 1:
                    gb *= 0.5
                side_ = 1
    g, cd, Pi, dpf, dpi = _stream_state_net(m, Pc, P_tank, side, A, cd_cap, P, holes)
    return m, cd, Pi, dpf, dpi


@njit(cache=True)
def _tn4222(d_jet, v_jet, rho_l, mu_l, sigma, rho_g, scale, prop):
    """Mirrors spray.smd_impinging_tn4222 (NACA TN 4222, dV = Vj) times smd_scale."""
    if d_jet <= 0 or v_jet <= 0 or sigma <= 0 or rho_g <= 0 or rho_l <= 0 or mu_l <= 0:
        return d_jet
    dj = d_jet/0.0254
    vj = v_jet/0.3048
    d30 = dj/(2.64*np.sqrt(dj*vj) + 0.97*dj*vj)*0.0254
    d32 = (5.0/3.915)*d30
    if prop != 0.0:
        rho_air = 29.3*3386.389/(287.05*((82.0 - 32.0)*5.0/9.0 + 273.15))
        ratio = (sigma*mu_l/rho_l)/(0.0197*3.8e-4/684.0)
        d32 = d32*(rho_g/rho_air)**(-0.25)*ratio**0.25
    return scale*d32

@njit(cache=True)
def _lefebvre(d_or, We, Oh, C, m, p):
    if We <= 0 or d_or <= 0:
        return d_or
    return C*d_or*We**(-m)*(1.0+Oh)**p

@njit(cache=True)
def _tau_evap(D32, rho_l, Lv, Tb, Tc, Pc, rho_ch, cp_g, C_ev, ev_model, K_legacy):
    """Droplet evaporation time [s]. ONE definition, shared by every kernel site.

    The kernel used to hardcode the legacy fixed-K law (tau = K*D32^2) at the impinging and
    pintle injector-solve sites while the Python reference
    (engine/core/injectors/impinging.py) used the DERIVED Spalding constant, which is the
    schema default (spray.evaporation.model = "derived"). x_star gates the Cd-reduction
    loop, so the two paths disagreed on mass flow: measured 9.7% on thrust and 8.7% on Pc
    for a shipped config. The A/B parity suite missed it because it sweeps tank pressure at
    fixed geometry and never diffs x_star.

    Derived branch (matches _evap_k_derived on the Python side):
        B_M  = cp_g (Tc - Tb) / Lv          Spalding mass-transfer number
        D_v  = 2e-5 (Tc/300)^1.75 (101325/Pc)   binary diffusivity, same scaling law
        k_ev = C_ev (8 rho_ch D_v / rho_l) ln(1 + B_M)
        tau  = D32^2 / k_ev
    Falls back to the legacy law when the model is off or an input is missing, so a config
    that does not declare the derived model is bit-identical to before.
    """
    if D32 <= 0.0:
        return 0.0
    if ev_model > 0.5 and Lv > 0.0 and Tb > 0.0 and rho_l > 0.0 and Pc > 0.0 and Tc > 0.0:
        D_v = 2.0e-5*(Tc/300.0)**1.75*(101325.0/Pc)
        if D_v > 0.0:
            B_M = cp_g*max(0.0, Tc - Tb)/Lv
            k_ev = C_ev*(8.0*rho_ch*D_v/rho_l)*np.log1p(B_M)
            if k_ev > 0.0:
                return (D32*D32)/k_ev
    return K_legacy*D32*D32


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
    Cd_O_eff = _cd_inf_orifice(djo, P[DO_CDINF], P[DO_GEOM], P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR])
    Cd_F_eff = _cd_inf_orifice(djf, P[DF_CDINF], P[DF_GEOM], P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR])
    imp_sep = _clip(P[ANG_O] + P[ANG_F], 1.0, 179.0)
    imp_angle = imp_sep*PI/180.0

    mdot_O = 0.1; mdot_F = 0.1
    Cd_O = 0.0; Cd_F = 0.0; Pi_O = P_tank_O; Pi_F = P_tank_F
    dpi_O = 0.0; dpi_F = 0.0
    We_O = 0.0; We_F = 0.0; D32_O = 0.0; D32_F = 0.0; u_rel = 0.0
    dpf_O = 0.0; dpf_F = 0.0; x_star = 0.0; n_iter = 0
    ti_O = 0.1; ti_F = 0.1
    u_O = 0.0; u_F = 0.0
    constraints_ok = 0
    # Per-hole flows along one branch of each back-channel ring (empty for a plenum).
    holes_O = np.zeros(int(P[NET_O_H]) if P[NET_O] > 0.0 else 0)
    holes_F = np.zeros(int(P[NET_F_H]) if P[NET_F] > 0.0 else 0)

    # ONE pass (impinging.py): Cd is orifice geometry and Reynolds number, not a lever for the
    # spray constraints. A We/x* violation is reported (constraints_ok = 0), never traded for a
    # smaller Cd -- the old loop multiplied Cd by closure.Cd_reduction_factor per violation.
    # The loop shape is kept so the body below reads as before; it runs exactly once.
    for iteration in range(1):
        n_iter = iteration + 1
        if P[NET_O] > 0.0:
            mo, Cd_O, Pi_O, dpf_O, dpi_O = _stream_flow_net(Pc, P_tank_O, 0, A_O, Cd_O_eff, P, holes_O)
        else:
            mo, Cd_O, Pi_O, dpf_O, dpi_O = _stream_flow(
                Pc, P_tank_O, rho_O, A_O, djo, mu_O, tO, Cd_O_eff,
                P[FO_AH], P[FO_K0], P[FO_K1], P[FO_PHI], P[FO_KX], P[FO_DEX],
                P[DO_CDINF], P[DO_ARE], P[DO_CDMIN], P[DO_GEOM], P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR], P[DO_UPC], P[DO_PREF], P[DO_AP], P[DO_UTC], P[DO_TREF], P[DO_AT], P[DO_LOD], P[DO_BETA], P[DO_CDU], P[VP_O], P[CC_O])
        if P[NET_F] > 0.0:
            mf, Cd_F, Pi_F, dpf_F, dpi_F = _stream_flow_net(Pc, P_tank_F, 1, A_F, Cd_F_eff, P, holes_F)
        else:
            mf, Cd_F, Pi_F, dpf_F, dpi_F = _stream_flow(
                Pc, P_tank_F, rho_F, A_F, djf, mu_F, tF, Cd_F_eff,
                P[FF_AH], P[FF_K0], P[FF_K1], P[FF_PHI], P[FF_KX], P[FF_DEX],
                P[DF_CDINF], P[DF_ARE], P[DF_CDMIN], P[DF_GEOM], P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR], P[DF_UPC], P[DF_PREF], P[DF_AP], P[DF_UTC], P[DF_TREF], P[DF_AT], P[DF_LOD], P[DF_BETA], P[DF_CDU], P[VP_F], P[CC_F])
        mdot_O = mo; mdot_F = mf
        u_O = mdot_O/(rho_O*A_O) if A_O > 0 else 0.0
        u_F = mdot_F/(rho_F*A_F) if A_F > 0 else 0.0
        u_rel = np.sqrt(u_O*u_O + u_F*u_F - 2.0*u_O*u_F*np.cos(imp_angle))
        rho_gas = Pc/(P[SP_GASR]*P[SP_GAST]); rho_gas = rho_gas if rho_gas > 1e-6 else 1e-6
        if P[SP_SMDMODEL] == SMD_INGEBO:
            D32_O = _tn4222(djo, u_O, rho_O, mu_O, sig_O, rho_gas, P[SP_SMDSCALE], P[SP_SMDPROP])
            D32_F = _tn4222(djf, u_F, rho_F, mu_F, sig_F, rho_gas, P[SP_SMDSCALE], P[SP_SMDPROP])
            # Measured D32 replaces the correlation where it was measured (impinging.py).
            if P[D32M_O] > 0.0 and u_O > 0.0:
                D32_O = P[D32M_O]
            if P[D32M_F] > 0.0 and u_F > 0.0:
                D32_F = P[D32M_F]
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
        # Shared with the Python reference via _tau_evap -- see its docstring. rho_gas is
        # the chamber gas density computed above from P[SP_GASR]*P[SP_GAST].
        _Tc_ev = P[SP_GAST]
        te_O = _tau_evap(D32_O, rho_O, P[LAT_O], P[RHO_O_BOIL], _Tc_ev, Pc, rho_gas,
                         P[EV_CPGAS], P[EV_CEVAP], P[EV_MODEL], P[SP_EVAPK])
        te_F = _tau_evap(D32_F, rho_F, P[LAT_F], P[RHO_F_BOIL], _Tc_ev, Pc, rho_gas,
                         P[EV_CPGAS], P[EV_CEVAP], P[EV_MODEL], P[SP_EVAPK])
        # x* is a TRANSPORT length, so it takes the momentum-weighted axial velocity of the
        # collided pair, not u_rel (the jet-to-jet closing speed, which belongs in the Ingebo
        # Weber number). Mirrors spray.spray_axial_velocity() on the Python path; using u_rel
        # here over-predicted x* by ~2x and left this constraint disagreeing with Python.
        _mt = mdot_O + mdot_F
        if _mt > 0.0:
            _u_ax = (mdot_O*u_O*np.cos(np.deg2rad(P[ANG_O]))
                     + mdot_F*u_F*np.cos(np.deg2rad(P[ANG_F])))/_mt
        else:
            _u_ax = 0.0
        if not np.isfinite(_u_ax) or _u_ax <= 0.0:
            _u_ax = u_rel
        x_star = max(_u_ax*te_O, _u_ax*te_F)
        constraints_ok = 1
        if We_O < P[SP_WEMIN] or We_F < P[SP_WEMIN]:
            constraints_ok = 0
        if P[SP_EVAPUSE] != 0 and x_star >= P[SP_EVAPXLIM]:
            constraints_ok = 0

    # Shear-layer turbulence. impinging.py calls _injector_turbulence_fields with
    # the FINAL velocities (:612), so Re and the ti_mix weighting are consistent
    # here -- unlike pintle, which weights pre-update Re with post-update u.
    _reO = _reynolds(rho_O, u_O, djo, mu_O); _reF = _reynolds(rho_F, u_F, djf, mu_F)
    ti_O = _clip(0.16*(_reO**(-0.125)) if _reO > 0 else 0.1, 0.02, 0.3)
    ti_F = _clip(0.16*(_reF**(-0.125)) if _reF > 0 else 0.1, 0.02, 0.3)

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
        return (0.0, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, mom_R, Cd_O, Cd_F, Pi_O, Pi_F, dpi_O, dpi_F, A_O, A_F, dpf_O, dpf_F, We_O, We_F, u_rel, x_star, float(constraints_ok), float(n_iter), ti_O, ti_F, holes_O, holes_F)
    return (1.0, mdot_O, mdot_F, u_O, u_F, D32_O, D32_F, mom_R, Cd_O, Cd_F, Pi_O, Pi_F, dpi_O, dpi_F, A_O, A_F, dpf_O, dpf_F, We_O, We_F, u_rel, x_star, float(constraints_ok), float(n_iter), ti_O, ti_F, holes_O, holes_F)


@njit(cache=True)
def _smd_pintle(L_open, V_rel, rho_f, mu_f, sigma_f, C, B, n, p):
    """spray.smd_pintle: SMD = C * L_open * We_rel^(-n) * (1 + B*Oh_f)^p."""
    We_rel = (rho_f*V_rel*V_rel*L_open)/sigma_f
    denom = np.sqrt(rho_f*sigma_f*L_open)
    Oh_f = mu_f/denom if denom > 0 else 0.0
    factor_we = We_rel**(-n) if We_rel > 0 else 1.0
    factor_oh = (1.0 + B*Oh_f)**p
    return C*L_open*factor_we*factor_oh


@njit(cache=True)
def injector_solve_pintle(P, P_tank_O, P_tank_F, Pc):
    """Pintle branch flows. Same 24-tuple shape as injector_solve.

    Ports what PintleInjector.solve actually EXECUTES. Two things in that
    function do not run and are deliberately not reproduced:
      * the `if feed_iter < 2:` quick-update block is dead -- `feed_iter` is 2
        once the `for feed_iter in range(3)` loop exits, so the condition is
        never true (confirmed by counting cd_from_re calls: 2/iteration, not 4);
      * that 3-iteration feed loop recomputes delta_p_feed from an unchanged
        mdot, so its 6 calls all return the same two values.
    Mass flow therefore converges through the outer Cd-relaxation loop alone.

    mom_R is left NaN: pintle has no momentum_ratio_R (see _eta_advanced).
    """
    rho_O = P[RHO_O]; mu_O = P[MU_O]; sig_O = P[SIG_O]; tO = P[T_O]
    rho_F = P[RHO_F]; mu_F = P[MU_F]; sig_F = P[SIG_F]; tF = P[T_F]
    A_O = P[PIN_AO]; A_F = P[PIN_AF]
    dh_O = P[PIN_DHO]; dh_F = P[PIN_DHF]
    d_orif = P[PIN_DORIF]; h_gap = P[PIN_HGAP]
    max_iter = int(P[SV_CLMAX]); Cd_red = P[SV_CLCDRED]
    Cd_O_eff = P[DO_CDINF]; Cd_F_eff = P[DF_CDINF]

    mdot_O = 0.1; mdot_F = 0.1
    Cd_O = 0.0; Cd_F = 0.0; Pi_O = P_tank_O; Pi_F = P_tank_F
    dpi_O = 0.0; dpi_F = 0.0; dpf_O = 0.0; dpf_F = 0.0
    We_O = 0.0; We_F = 0.0; D32 = 0.0; u_O = 0.0; u_F = 0.0
    V_rel = 0.0; x_star = 0.0; constraints_ok = 0; n_iter = 0
    ti_O = 0.1; ti_F = 0.1

    for iteration in range(max_iter):
        n_iter = iteration + 1
        dpf_bal_O = _dpf(mdot_O, rho_O, P[FO_AH], P[FO_K0], P[FO_K1], P[FO_PHI], P_tank_O, P[FO_KX], P[FO_DEX])
        dpf_bal_F = _dpf(mdot_F, rho_F, P[FF_AH], P[FF_K0], P[FF_K1], P[FF_PHI], P_tank_F, P[FF_KX], P[FF_DEX])
        Pi_O = P_tank_O - dpf_bal_O
        Pi_F = P_tank_F - dpf_bal_F
        dpi_O = Pi_O - Pc if Pi_O - Pc > 0.0 else 0.0
        dpi_F = Pi_F - Pc if Pi_F - Pc > 0.0 else 0.0
        if Pi_F < Pc:
            mdot_F = 0.0
        if Pi_O < Pc:
            mdot_O = 0.0

        u_O = mdot_O/(rho_O*A_O) if A_O > 0 else 0.0
        u_F = mdot_F/(rho_F*A_F) if A_F > 0 else 0.0
        Re_O = _reynolds(rho_O, u_O, dh_O, mu_O)
        Re_F = _reynolds(rho_F, u_F, dh_F, mu_F)
        cO = _cd_from_re(Re_O, Pi_O, tO, dh_O, P[DO_CDINF], P[DO_ARE], P[DO_CDMIN], P[DO_GEOM],
                         P[DO_DREF], P[DO_DMIN], P[DO_EXPS], P[DO_LOGG], P[DO_CDMAX], P[DO_CDFLOOR],
                         P[DO_UPC], P[DO_PREF], P[DO_AP], P[DO_UTC], P[DO_TREF], P[DO_AT], P[DO_LOD], P[DO_BETA], P[DO_CDU])
        cF = _cd_from_re(Re_F, Pi_F, tF, dh_F, P[DF_CDINF], P[DF_ARE], P[DF_CDMIN], P[DF_GEOM],
                         P[DF_DREF], P[DF_DMIN], P[DF_EXPS], P[DF_LOGG], P[DF_CDMAX], P[DF_CDFLOOR],
                         P[DF_UPC], P[DF_PREF], P[DF_AP], P[DF_UTC], P[DF_TREF], P[DF_AT], P[DF_LOD], P[DF_BETA], P[DF_CDU])
        Cd_O = cO if cO < Cd_O_eff else Cd_O_eff
        Cd_F = cF if cF < Cd_F_eff else Cd_F_eff

        mdot_O = Cd_O*A_O*np.sqrt(2.0*rho_O*dpi_O) if dpi_O > 0 else 0.0
        mdot_F = Cd_F*A_F*np.sqrt(2.0*rho_F*dpi_F) if dpi_F > 0 else 0.0
        u_O = mdot_O/(rho_O*A_O) if A_O > 0 else 0.0
        u_F = mdot_F/(rho_F*A_F) if A_F > 0 else 0.0

        We_O = rho_O*u_O*u_O*d_orif/sig_O if sig_O > 0 else np.inf
        We_F = rho_F*u_F*u_F*dh_F/sig_F if sig_F > 0 else np.inf

        V_rel = np.sqrt(u_O*u_O + u_F*u_F)
        D32 = _smd_pintle(h_gap, V_rel, rho_F, mu_F, sig_F,
                          P[PIN_SMDC], P[PIN_SMDB], P[PIN_SMDN], P[PIN_SMDP])

        # ti uses the PRE-UPDATE Reynolds numbers, while the ti_mix weighting
        # below uses the POST-update velocities. That asymmetry is pintle.py's
        # (Re_O/Re_F are computed before mdot is refreshed, ti at :218 after);
        # impinging is self-consistent instead, recomputing Re from the same u.
        ti_O = 0.16*(Re_O**(-0.125)) if Re_O > 0 else 0.1
        ti_F = 0.16*(Re_F**(-0.125)) if Re_F > 0 else 0.1
        ti_O = _clip(ti_O, 0.02, 0.3); ti_F = _clip(ti_F, 0.02, 0.3)

        # pintle.py prices evaporation with the legacy fixed-K law, tau = K*D32^2, on both
        # streams (spray.tau_evap), NOT the derived Spalding constant the impinging solve uses.
        # This site used _tau_evap's derived branch, so x* -- which gates pintle's Cd-reduction
        # loop -- read 0.09% off Python on canonical/pintle.yaml. Both streams share D32.
        te = P[SP_EVAPK]*(D32**2)
        x_star = V_rel*te
        if P[SP_USETURB] != 0.0:
            v_tot = u_O + u_F if u_O + u_F > 1e-6 else 1e-6
            ti_mix = _clip((ti_O*u_O + ti_F*u_F)/v_tot, 0.02, 0.35)
            x_star *= _clip(1.0/(1.0 + P[SP_PENGAIN]*ti_mix), 0.3, 1.0)

        # Reported feed loss is recomputed from the CONVERGED mdot, matching
        # pintle.py's "recalculate one final time ... so diagnostics have the
        # correct final values". This deliberately makes the reported
        # delta_p_feed inconsistent with the P_inj used in the balance above,
        # which came from the previous iteration's mdot. Faithful, not tidy.
        dpf_O = _dpf(mdot_O, rho_O, P[FO_AH], P[FO_K0], P[FO_K1], P[FO_PHI], P_tank_O, P[FO_KX], P[FO_DEX])
        dpf_F = _dpf(mdot_F, rho_F, P[FF_AH], P[FF_K0], P[FF_K1], P[FF_PHI], P_tank_F, P[FF_KX], P[FF_DEX])

        constraints_ok = 1
        if We_O < P[SP_WEMIN] or We_F < P[SP_WEMIN]:
            constraints_ok = 0
        if P[SP_EVAPUSE] != 0 and x_star >= P[SP_EVAPXLIM]:
            constraints_ok = 0
        if constraints_ok:
            break
        Cd_O_eff *= Cd_red; Cd_F_eff *= Cd_red
        if Cd_O_eff < P[DO_CDMIN]: Cd_O_eff = P[DO_CDMIN]
        if Cd_F_eff < P[DF_CDMIN]: Cd_F_eff = P[DF_CDMIN]

    if not (np.isfinite(mdot_O) and np.isfinite(mdot_F) and mdot_F > 0.0):
        return (0.0, mdot_O, mdot_F, u_O, u_F, D32, D32, np.nan, Cd_O, Cd_F, Pi_O, Pi_F,
                dpi_O, dpi_F, A_O, A_F, dpf_O, dpf_F, We_O, We_F, V_rel, x_star,
                float(constraints_ok), float(n_iter), ti_O, ti_F, np.zeros(0), np.zeros(0))
    return (1.0, mdot_O, mdot_F, u_O, u_F, D32, D32, np.nan, Cd_O, Cd_F, Pi_O, Pi_F,
            dpi_O, dpi_F, A_O, A_F, dpf_O, dpf_F, We_O, We_F, V_rel, x_star,
            float(constraints_ok), float(n_iter), ti_O, ti_F, np.zeros(0), np.zeros(0))


@njit(cache=True)
def _solve_injector(P, P_O, P_F, Pc):
    """Dispatch on injector type. Both branches return the same tuple type."""
    if P[INJ_TYPE] == 0.0:
        return injector_solve_pintle(P, P_O, P_F, Pc)
    return injector_solve(P, P_O, P_F, Pc)


@njit(cache=True)
def _sign(x):
    return -1.0 if x < 0 else (1.0 if x > 0 else 0.0)
