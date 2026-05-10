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
    pressurant_R=None,
    branch_temperatures_K=None,
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

    branch_temperatures_K = branch_temperatures_K or {}

    def infer_pressurant_R():
        fluids = getattr(config, "fluids", None) or {}
        press_cfg = None
        if isinstance(fluids, dict):
            press_cfg = fluids.get("pressurant")
        else:
            try:
                press_cfg = fluids.get("pressurant")
            except Exception:
                press_cfg = None
        candidate_attrs = ("R", "R_specific")
        if press_cfg is not None:
            for attr in candidate_attrs:
                val = getattr(press_cfg, attr, None)
                if val is not None:
                    return float(val)
            molar_mass = getattr(press_cfg, "molar_mass", None)
            if molar_mass not in (None, 0):
                return 8.31446261815324 / float(molar_mass)
        return None

    R_default = 296.803  # J/(kg·K) for gaseous N2
    R = float(pressurant_R) if pressurant_R is not None else (infer_pressurant_R() or R_default)

    branch_meta = {
        "oxidizer": {
            "label": "oxidizer",
            "fluid_key": "oxidizer",
            "tank_attr": "lox_tank",
            "height_attr": "lox_h",
            "radius_attr": "lox_radius",
            "mdot_columns": ["mdot_O (kg/s)", "mdot_O_kg_s"],
            "pressure_columns": ["P_tank_O (psi)", "P_tank_O_psi"],
            "volume_field_candidates": ["tank_volume_m3", "volume_m3", "tank_volume", "volume"],
            "mass_field_candidates": ["mass", "initial_mass_kg"],
            "extra_volume_paths": [
                ("propellant", "tank_volume_m3"),
                ("propellant", "oxidizer_tank_volume_m3"),
            ],
            "extra_mass_paths": [
                ("propellant", "initial_mass_kg"),
                ("propellant", "initial_oxidizer_mass_kg"),
                ("press_tank", "initial_propellant_mass_kg"),
            ],
        },
        "fuel": {
            "label": "fuel",
            "fluid_key": "fuel",
            "tank_attr": "fuel_tank",
            "height_attr": "rp1_h",
            "radius_attr": "rp1_radius",
            "mdot_columns": ["mdot_F (kg/s)", "mdot_F_kg_s"],
            "pressure_columns": ["P_tank_F (psi)", "P_tank_F_psi"],
            "volume_field_candidates": ["tank_volume_m3", "volume_m3", "tank_volume", "volume"],
            "mass_field_candidates": ["mass", "initial_mass_kg"],
            "extra_volume_paths": [
                ("propellant", "tank_volume_m3"),
                ("propellant", "fuel_tank_volume_m3"),
            ],
            "extra_mass_paths": [
                ("propellant", "initial_mass_kg"),
                ("propellant", "initial_fuel_mass_kg"),
                ("press_tank", "initial_propellant_mass_kg"),
            ],
        },
    }

    def get_nested_attr(root, *attrs):
        cur = root
        for attr in attrs:
            if cur is None:
                return None
            cur = getattr(cur, attr, None)
        return cur

    # Known COPV physical volume from config
    if copv_volume_m3 is None:
        if hasattr(config, "press_tank") and hasattr(config.press_tank, "press_volume"):
            copv_volume_m3 = float(config.press_tank.press_volume)
        elif hasattr(config, "press_tank") and hasattr(config.press_tank, "volume_m3"):
            copv_volume_m3 = float(config.press_tank.volume_m3)
        else:
            raise KeyError("COPV volume not provided and not found in config.press_tank (press_volume).")
        copv_volume_m3 = config.press_tank.press_volume

    # Conversion
    psi_to_Pa = 6894.757293168

    # --- Read time-series from df ---
    time = np.asarray(df["time"].values, dtype=float)

    # Time step handling
    dt = np.diff(time)
    if dt.size == 0:
        raise ValueError("Need multiple time samples.")
    dt_full = np.concatenate(([dt[0]], dt))

    # Z lookups
    if use_real_gas:
        interp, _, _ = load_Z_lookup_table(n2_Z_csv)
    else:
        interp = None

    def pick_column(column_options, label):
        for candidate in column_options:
            if candidate in df.columns:
                return candidate, np.asarray(df[candidate].values, dtype=float)
        raise KeyError(f"Dataframe missing {label} column (tried: {column_options})")

    def resolve_tank_value(spec, field_candidates, *, allow_geometry=False):
        tank_section = getattr(config, spec["tank_attr"], None)
        for field in field_candidates:
            if tank_section is None:
                break
            val = getattr(tank_section, field, None)
            if val is not None:
                return float(val)
        for path in spec.get("extra_volume_paths" if allow_geometry else "extra_mass_paths", []):
            val = get_nested_attr(config, *path)
            if val is not None:
                return float(val)
        if allow_geometry and tank_section is not None:
            h = getattr(tank_section, spec["height_attr"], None)
            r = getattr(tank_section, spec["radius_attr"], None)
            if h is not None and r is not None:
                return float(np.pi * (r ** 2) * h)
        return None

    def resolve_tank_volume(spec):
        volume = resolve_tank_value(spec, spec["volume_field_candidates"], allow_geometry=True)
        if volume is None:
            volume = get_nested_attr(config, "propellant", "tank_volume_m3")
        if volume is None:
            raise KeyError(f"Need {spec['label']} tank volume in config (e.g., config.{spec['tank_attr']}.* or propellant.tank_volume_m3).")
        return float(volume)

    def resolve_initial_mass(spec):
        # start with direct tank fields
        tank_section = getattr(config, spec["tank_attr"], None)
        if tank_section is not None:
            for field in spec["mass_field_candidates"]:
                val = getattr(tank_section, field, None)
                if val is not None:
                    return float(val)
        for path in spec.get("extra_mass_paths", []):
            val = get_nested_attr(config, *path)
            if val is not None:
                return float(val)
        fallback = get_nested_attr(config, "press_tank", "initial_propellant_mass_kg")
        if fallback is not None:
            return float(fallback)
        raise KeyError(f"Need initial {spec['label']} mass in config (e.g., config.{spec['tank_attr']}.mass).")

    def compute_branch_requirements(branch_key, spec):
        label = spec["label"]
        mdot_col, mdot = pick_column(spec["mdot_columns"], f"{label} mass flow")
        P_col, P_tank_psi = pick_column(spec["pressure_columns"], f"{label} tank pressure")

        if mdot.shape[0] != time.shape[0] or P_tank_psi.shape[0] != time.shape[0]:
            raise ValueError(f"{label.capitalize()} timeseries length mismatch with 'time' column.")

        rho = float(config.fluids[spec["fluid_key"]].density)
        V_tank = resolve_tank_volume(spec)
        m_initial = resolve_initial_mass(spec)

        Vg0 = V_tank - (m_initial / rho)
        if Vg0 <= 0:
            raise ValueError(f"[{label}] Computed initial ullage <= 0. Check tank volume, density, or initial mass inputs.")

        dV = mdot * dt_full / rho
        Vg = Vg0 + np.cumsum(dV)

        P_tank_Pa = P_tank_psi * psi_to_Pa
        T_branch = float(branch_temperatures_K.get(branch_key, Tp_K))
        if use_real_gas:
            Zp_branch = Z_lookup(T_branch, P_tank_Pa, interp)
        else:
            Zp_branch = np.ones_like(P_tank_Pa)

        m_g_req_branch = (P_tank_Pa * Vg) / (Zp_branch * R * T_branch)
        m_prev = np.concatenate(([m_g_req_branch[0]], m_g_req_branch[:-1]))
        dm_branch = np.maximum(m_g_req_branch - m_prev, 0.0)
        M_branch = np.cumsum(dm_branch)

        return {
            "label": label,
            "mdot_column": mdot_col,
            "pressure_column": P_col,
            "mdot_kg_s": mdot,
            "P_tank_Pa": P_tank_Pa,
            "Vg0_m3": Vg0,
            "Vg_m3": Vg,
            "gas_temperature_K": T_branch,
            "rho_propellant": rho,
            "tank_volume_m3": V_tank,
            "initial_mass_kg": m_initial,
            "m_g_req_kg": m_g_req_branch,
            "dm_delivered_kg": dm_branch,
            "M_delivered_kg": M_branch,
            "Zp_trace": Zp_branch,
        }

    branch_results = {}
    for branch_key, spec in branch_meta.items():
        branch_results[branch_key] = compute_branch_requirements(branch_key, spec)

    if not branch_results:
        raise ValueError("No branch data computed; ensure dataframe includes oxidizer and fuel inputs.")

    # Combined requirements across all tanks: pressures take the maximum, mass draws sum
    pressure_traces = [data["P_tank_Pa"] for data in branch_results.values()]
    P_tank_required_Pa = pressure_traces[0].copy()
    for arr in pressure_traces[1:]:
        if arr.shape != P_tank_required_Pa.shape:
            raise ValueError("All branch traces must share the same time dimension.")
        P_tank_required_Pa = np.maximum(P_tank_required_Pa, arr)

    template_branch = next(iter(branch_results.values()))
    combined_m_g_req = np.zeros_like(template_branch["m_g_req_kg"])
    combined_dm = np.zeros_like(template_branch["dm_delivered_kg"])
    combined_M = np.zeros_like(template_branch["M_delivered_kg"])

    for data in branch_results.values():
        combined_m_g_req += data["m_g_req_kg"]
        combined_dm += data["dm_delivered_kg"]
        combined_M += data["M_delivered_kg"]

    M_total = combined_M[-1]

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
        mH = m0 - combined_M
        mH = np.maximum(mH, 1e-12)
        PH = np.array([compute_PH_from_mH(mHi, V_H, P0) for mHi in mH])
        return PH

    # Feasibility solvers (updated to compute Z0 appropriately inside)
    def solve_for_P0_given_VH(V_H):
        P0_low = np.max(P_tank_required_Pa)  # must be at least as large as peak requirement
        P0_high = max(P0_low * 3.0, 5.0e7)

        def ok(P0):
            # compute m0 from P0 and Z at P0
            Z0_trial = estimate_Z_H(P0)
            m0 = P0 * V_H / (Z0_trial * R * T0_K)
            PH = copv_pressure_trace(m0, V_H, P0)
            return np.min(PH - P_tank_required_Pa) >= 0.0

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
            return np.min(PH - P_tank_required_Pa) >= 0.0

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
        "branches": branch_results,
        "P_tank_required_Pa": P_tank_required_Pa,
        "combined_m_g_req_kg": combined_m_g_req,
        "combined_dm_delivered_kg": combined_dm,
        "combined_M_delivered_kg": combined_M,
        "total_delivered_mass_kg": float(M_total),
        "R_pressurant": R,
        "T0_K": T0_K,
        "Tp_K": Tp_K,
        "branch_gas_temperatures_K": {k: float(v["gas_temperature_K"]) for k, v in branch_results.items()},
        "n": n,
    }

    if copv_volume_m3 is not None:
        # user gave a COPV physical volume; solve for P0
        P0_star, m0_star, PH_star = solve_for_P0_given_VH(copv_volume_m3)
        branch_margins = {
            name: float(np.min(PH_star - data["P_tank_Pa"]))
            for name, data in branch_results.items()
        }
        results.update({
            "mode": "sized_P0_given_VH",
            "copv_volume_m3": float(copv_volume_m3),
            "P0_Pa": float(P0_star),
            "m0_kg": float(m0_star),
            "PH_trace_Pa": PH_star,
            "min_margin_Pa": float(np.min(PH_star - P_tank_required_Pa)),
            "branch_min_margins_Pa": branch_margins,
        })
    else:
        # user provided P0 and we size VH
        V_star, m0_star, PH_star = solve_for_VH_given_P0(copv_P0_Pa)
        branch_margins = {
            name: float(np.min(PH_star - data["P_tank_Pa"]))
            for name, data in branch_results.items()
        }
        results.update({
            "mode": "sized_VH_given_P0",
            "P0_Pa": float(copv_P0_Pa),
            "copv_volume_m3": float(V_star),
            "m0_kg": float(m0_star),
            "PH_trace_Pa": PH_star,
            "min_margin_Pa": float(np.min(PH_star - P_tank_required_Pa)),
            "branch_min_margins_Pa": branch_margins,
        })

    return results
