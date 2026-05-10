import numpy as np
import pandas as pd
from scipy.interpolate import RegularGridInterpolator

# ----------------------------
# Z(P,T) utilities (unchanged)
# ----------------------------
def load_Z_lookup_table(csv_path):
    df_z = pd.read_csv(csv_path)
    T_vals = np.unique(np.sort(df_z["T_K"].values))
    P_vals = np.unique(np.sort(df_z["P_Pa"].values))
    pivot = df_z.pivot(index="T_K", columns="P_Pa", values="Z")
    pivot = pivot.reindex(index=T_vals, columns=P_vals)
    Z_grid = pivot.values
    interp = RegularGridInterpolator((T_vals, P_vals), Z_grid,
                                     bounds_error=False, fill_value=None)
    return interp, T_vals, P_vals

def Z_lookup(T_K, P_Pa, interp, default_Z=1.0):
    T_arr = np.atleast_1d(T_K).astype(float)
    P_arr = np.atleast_1d(P_Pa).astype(float)
    if T_arr.size == 1 and P_arr.size > 1:
        T_arr = np.full_like(P_arr, T_arr[0])
    elif P_arr.size == 1 and T_arr.size > 1:
        P_arr = np.full_like(T_arr, P_arr[0])
    elif T_arr.size != P_arr.size:
        raise ValueError("Temperature and pressure arrays must have matching sizes.")
    pts = np.column_stack([T_arr, P_arr])
    Z_vals = interp(pts)
    Z_vals = np.where(np.isnan(Z_vals), default_Z, Z_vals)
    if np.isscalar(T_K) and np.isscalar(P_Pa):
        return float(Z_vals[0])
    return Z_vals

# ----------------------------
# Core solver (updated)
# ----------------------------
def size_or_check_copv_for_polytropic_N2(
    df,
    config,
    *,
    n=1.2,
    T0_K=300.0,
    Tp_K=300.0,
    use_real_gas=True,
    n2_Z_csv="n2_Z_lookup.csv",
    copv_volume_m3=None,
    copv_P0_Pa=None,
    tol=1e-4,
    max_iter=60
):
    """
    Updated solver that uses known COPV volume (config.press_tank.press_volume)
    and initial ullage computed from initial propellant mass, prop tank volume, and density.

    Provide either copv_volume_m3 OR copv_P0_Pa (exactly one).
    """

    assert (copv_volume_m3 is None) ^ (copv_P0_Pa is None), \
        "Provide exactly one: copv_volume_m3 OR copv_P0_Pa."

    # --- Extract constants from config (adapt field names if your config differs) ---
    R = float(config.fluids['pressurant'].R)              # J/(kg·K) for N2
    rho_ox = float(config.fluids['oxidizer'].density)     # kg/m^3

    # Known COPV physical volume from config (the user said they have this)
    # prefer explicit argument first, otherwise attempt to read from config
    if copv_volume_m3 is None:
        # try a few likely keys
        if hasattr(config, "press_tank") and hasattr(config.press_tank, "press_volume"):
            copv_volume_m3 = float(config.press_tank.press_volume)
        elif hasattr(config, "press_tank") and hasattr(config.press_tank, "volume_m3"):
            copv_volume_m3 = float(config.press_tank.volume_m3)
        else:
            raise KeyError("COPV volume not provided and not found in config.press_tank (press_volume).")
        copv_volume_m3 = config.press_tank.press_volume

    # Propellant tank geometry and initial prop mass used to compute ullage
    # Attempt to read initial propellant mass and prop tank volume from config
    # Adapt these field names if your config uses other keys.
    try:
        V_tank_total = float(config.propellant.tank_volume_m3)
    except Exception:
        # fallback: try press_tank.tank_volume
        V_tank_total = float(getattr(config.press_tank, "tank_volume_m3", None) or 0.0)
    try:
        m_prop_initial = float(config.lox_tank.mass)
    except Exception:
        # fallback: try press_tank.initial_propellant_mass
        m_prop_initial = float(getattr(config.press_tank, "initial_propellant_mass_kg", None) or 0.0)

    if V_tank_total <= 0 or m_prop_initial <= 0:
        raise KeyError("Need propellant tank total volume and initial propellant mass in config (e.g., config.propellant.tank_volume_m3 and config.propellant.initial_mass_kg).")

    # initial ullage volume (gas volume) in prop tank at time zero
    Vg0 = V_tank_total - (m_prop_initial / rho_ox)
    if Vg0 <= 0:
        raise ValueError("Computed initial ullage Vg0 <= 0. Check propellant mass, density, or tank volume inputs.")

    # Conversion
    psi_to_Pa = 6894.757293168

    # --- Read time-series from df ---
    time = np.asarray(df["time"].values, dtype=float)
    mdot_o = np.asarray(df["mdot_O (kg/s)"].values, dtype=float)
    # allow different column name variations for P tank psi
    if "P_tank_O (psi)" in df.columns:
        P_tank_psi = np.asarray(df["P_tank_O (psi)"].values, dtype=float)
    elif "P_tank_O_psi" in df.columns:
        P_tank_psi = np.asarray(df["P_tank_O_psi"].values, dtype=float)
    else:
        raise KeyError("Dataframe missing prop tank pressure column (expected 'P_tank_O (psi)')")

    P_tank_Pa = P_tank_psi * psi_to_Pa

    # Time step handling
    dt = np.diff(time)
    if dt.size == 0:
        raise ValueError("Need multiple time samples.")
    dt_full = np.concatenate(([dt[0]], dt))

    # Propellant volume displaced per step → ullage growth (start from Vg0)
    dV_ox = mdot_o * dt_full / rho_ox
    Vg = Vg0 + np.cumsum(dV_ox)

    # Z lookups
    if use_real_gas:
        interp, _, _ = load_Z_lookup_table(n2_Z_csv)
        Zp = Z_lookup(Tp_K, P_tank_Pa, interp)  # prop-tank Z over time
        # do not set Z0 here; Z0 depends on P0 (unknown). We'll compute Z_H when needed.
    else:
        interp = None
        Zp = np.ones_like(P_tank_Pa)

    # Required prop-tank gas mass to maintain the given pressure trace
    m_g_req = (P_tank_Pa * Vg) / (Zp * R * Tp_K)

    # Delivered mass over each step (no-backflow assumption)
    m_g_prev = np.concatenate(([m_g_req[0]], m_g_req[:-1]))
    dm_deliv = m_g_req - m_g_prev
    dm_deliv = np.maximum(dm_deliv, 0.0)
    M_deliv = np.cumsum(dm_deliv)
    M_total = M_deliv[-1]

    # --- Helper: compute Z_H at given P_H (with fallback) ---
    def estimate_Z_H(P_H):
        if not use_real_gas:
            return 1.0
        # clamp P_H inside lookup table domain by using the interp directly; interp returns nan if out of range
        z = Z_lookup(T0_K, P_H, interp, default_Z=1.0)
        return z

    # --- HPS pressure from m_H, V_H, and P0 using fixed-point on Z_H ---
    def compute_PH_from_mH(mH, V_H, P0):
        """
        Solve for P_H given mH, V_H, P0, T0_K and polytropic exponent n.
        This solves: mH = P_H * V_H / (Z_H(P_H) * R * T_H)
        with T_H = T0 * (P_H/P0)^{(n-1)/n}
        and Z_H a function of P_H (estimated via estimate_Z_H).
        We iterate a few times on P_H because Z_H depends on P_H.
        """
        # initial guess: assume Z_H = Z_at_P0
        Z_guess = estimate_Z_H(P0)
        # compute initial P_H estimate from explicit algebra assuming Z_guess
        # P_H = ( (mH * Z_guess * R * T0) / (V_H * P0^{(n-1)/n}) )^n
        prefactor = (mH * Z_guess * R * T0_K) / (V_H * (P0 ** ((n - 1.0) / n)))
        # protect against negative/zero
        prefactor = max(prefactor, 1e-20)
        P_H = prefactor ** n

        # iterate to update Z_H(P_H) then recompute P_H
        for _ in range(8):
            Z_new = estimate_Z_H(P_H)
            if Z_new <= 0:
                Z_new = Z_guess
            prefactor = (mH * Z_new * R * T0_K) / (V_H * (P0 ** ((n - 1.0) / n)))
            prefactor = max(prefactor, 1e-20)
            P_H_new = prefactor ** n
            # convergence check relative
            if abs(P_H_new - P_H) / max(1.0, P_H_new) < 1e-6:
                P_H = P_H_new
                break
            P_H = P_H_new
        return P_H

    # copv_pressure_trace now uses compute_PH_from_mH
    def copv_pressure_trace(m0, V_H, P0):
        mH = m0 - M_deliv
        mH = np.maximum(mH, 1e-12)
        PH = np.array([compute_PH_from_mH(mHi, V_H, P0) for mHi in mH])
        return PH

    # Feasibility solvers (updated to compute Z0 appropriately inside)
    def solve_for_P0_given_VH(V_H):
        P0_low = np.max(P_tank_Pa)  # must be at least as large as peak prop-tank requirement
        P0_high = max(P0_low * 3.0, 5.0e7)

        def ok(P0):
            # compute m0 from P0 and Z at P0
            Z0_trial = estimate_Z_H(P0)
            m0 = P0 * V_H / (Z0_trial * R * T0_K)
            PH = copv_pressure_trace(m0, V_H, P0)
            return np.min(PH - P_tank_Pa) >= 0.0

        itg = 0
        while not ok(P0_high) and itg < 30:
            P0_high *= 1.6
            itg += 1

        lo, hi = P0_low, P0_high
        for _ in range(max_iter):
            mid = 0.5 * (lo + hi)
            if ok(mid):
                hi = mid
            else:
                lo = mid
            if (hi - lo) / max(1.0, hi) < tol:
                break

        P0_star = hi
        Z0_star = estimate_Z_H(P0_star)
        m0_star = P0_star * V_H / (Z0_star * R * T0_K)
        PH_star = copv_pressure_trace(m0_star, V_H, P0_star)
        return P0_star, m0_star, PH_star

    def solve_for_VH_given_P0(P0):
        V_low = 1e-5
        V_high = 0.5

        def ok(VH):
            Z0_trial = estimate_Z_H(P0)
            m0 = P0 * VH / (Z0_trial * R * T0_K)
            PH = copv_pressure_trace(m0, VH, P0)
            return np.min(PH - P_tank_Pa) >= 0.0

        itg = 0
        while not ok(V_high) and itg < 30:
            V_high *= 1.6
            itg += 1

        lo, hi = V_low, V_high
        for _ in range(max_iter):
            mid = 0.5 * (lo + hi)
            if ok(mid):
                hi = mid
            else:
                lo = mid
            if (hi - lo) / max(1.0, hi) < tol:
                break

        V_star = hi
        Z0_star = estimate_Z_H(P0)
        m0_star = P0 * V_star / (Z0_star * R * T0_K)
        PH_star = copv_pressure_trace(m0_star, V_star, P0)
        return V_star, m0_star, PH_star

    # --- Results bundle ---
    results = {
        "time_s": time,
        "P_tank_Pa": P_tank_Pa,
        "mdot_o_kg_s": mdot_o,
        "Vg_m3": Vg,
        "m_g_req_kg": m_g_req,
        "dm_delivered_kg": dm_deliv,
        "M_delivered_kg": M_deliv,
        "total_delivered_mass_kg": float(M_total),
        "Zp_trace": Zp,
        "R_pressurant": R,
        "T0_K": T0_K,
        "Tp_K": Tp_K,
        "n": n
    }

    if copv_volume_m3 is not None:
        # user gave a COPV physical volume; solve for P0
        P0_star, m0_star, PH_star = solve_for_P0_given_VH(copv_volume_m3)
        results.update({
            "mode": "sized_P0_given_VH",
            "copv_volume_m3": float(copv_volume_m3),
            "P0_Pa": float(P0_star),
            "m0_kg": float(m0_star),
            "PH_trace_Pa": PH_star,
            "min_margin_Pa": float(np.min(PH_star - P_tank_Pa))
        })
    else:
        # user provided P0 and we size VH
        V_star, m0_star, PH_star = solve_for_VH_given_P0(copv_P0_Pa)
        results.update({
            "mode": "sized_VH_given_P0",
            "P0_Pa": float(copv_P0_Pa),
            "copv_volume_m3": float(V_star),
            "m0_kg": float(m0_star),
            "PH_trace_Pa": PH_star,
            "min_margin_Pa": float(np.min(PH_star - P_tank_Pa))
        })

    return results
