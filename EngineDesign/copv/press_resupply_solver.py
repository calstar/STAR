"""
COPV → Regulator → Solenoid → Propellant Tank press resupply ODE.
Reference: docs/copv_resupply_model.md
"""

from __future__ import annotations

from functools import partial
from typing import Callable, Optional

import numpy as np
from scipy.integrate import solve_ivp

# N2 constants
GAMMA_N2 = 1.40
R_N2 = 296.803  # J/(kg·K)
M_N2 = 0.028014  # kg/mol
PSI_TO_PA = 6894.757
CRIT_PRESS_RATIO = 0.528  # (2/(γ+1))^(γ/(γ-1)) for γ=1.4


def series_cv(cv_reg: float, cv_line: float) -> float:
    """1/Cv_eff² = 1/Cv_reg² + 1/Cv_line²"""
    return 1.0 / np.sqrt(1.0 / cv_reg**2 + 1.0 / cv_line**2)


def cv_to_effective_area(cv: float) -> float:
    """Convert Cv (flow-coefficient, gpm-H2O basis) to effective orifice area [m²] for N2.

    ISA gas flow: Q_scfh = Cv * 963 * sqrt((P_up - P_down)*P_up / (SG * T_up_R))
    For N2: SG=0.967. Rearranging for mass flow and matching to isentropic nozzle gives:
        A_eff = Cv * 2.853e-5   [m²]
    """
    return cv * 2.853e-5


def n2_mass_flow_cv(
    cv_eff: float,
    P_up_Pa: float,
    P_down_Pa: float,
    T_up_K: float,
    gamma: float = GAMMA_N2,
    R: float = R_N2,
) -> float:
    """N2 compressible mass flow through a Cv restriction [kg/s].

    Uses isentropic nozzle equations with A_eff = cv_to_effective_area(cv_eff).
    Choked when P_down/P_up <= CRIT_PRESS_RATIO (0.528 for N2).
    Returns 0 if P_up <= P_down (no reverse flow).
    """
    if P_up_Pa <= P_down_Pa:
        return 0.0
    A = cv_to_effective_area(cv_eff)
    ratio = P_down_Pa / P_up_Pa
    if ratio <= CRIT_PRESS_RATIO:
        # Choked flow
        factor = (2.0 / (gamma + 1)) ** ((gamma + 1) / (2 * (gamma - 1)))
        mdot = A * P_up_Pa * np.sqrt(gamma / (R * T_up_K)) * factor
    else:
        # Subsonic (unchoked) — isentropic nozzle relation
        #
        # mdot = A * P0 * sqrt( (2*gamma)/(R*T0*(gamma-1)) *
        #                       ( (P/P0)^(2/gamma) - (P/P0)^((gamma+1)/gamma) ) )
        term = ratio ** (2.0 / gamma) - ratio ** ((gamma + 1.0) / gamma)
        mdot = A * P_up_Pa * np.sqrt((2.0 * gamma) / (R * T_up_K * (gamma - 1.0)) * max(term, 0.0))
    return float(max(mdot, 0.0))


def regulator_outlet_pressure(
    P_copv_Pa: float,
    P_set0_psi: float,
    P_copv0_psi: float,
    k_droop: float = 0.070,
) -> float:
    """Regulator outlet pressure [Pa] including unbalanced-poppet droop.

    P_reg = P_set0 + k_droop*(P_COPV0 - P_COPV)   [psi arithmetic]
    Returns min(P_reg, P_copv) to handle unregulated blowdown regime.
    """
    P_copv_psi = P_copv_Pa / PSI_TO_PA
    P_reg_psi = P_set0_psi + k_droop * (P_copv0_psi - P_copv_psi)
    P_reg_Pa = P_reg_psi * PSI_TO_PA
    return float(min(P_reg_Pa, P_copv_Pa))


def _make_solenoid_fn(schedule: list[tuple[float, float]]) -> Callable[[float], bool]:
    """Return a function solenoid_open(t) -> bool from a list of (t_open, t_close) pairs."""

    def _fn(t: float) -> bool:
        for t_open, t_close in schedule:
            if t_open <= t <= t_close:
                return True
        return False

    return _fn


def _press_ode(
    t: float,
    state: np.ndarray,
    *,
    cv_eff: float,
    P_set0_psi: float,
    P_copv0_psi: float,
    k_droop: float,
    V_copv_m3: float,
    V_ull_fn: Callable[[float], float],
    mdot_prop_fn: Callable[[float], float],
    solenoid_open_fn: Callable[[float], bool],
    T_copv_K: float,
    T_ull_K: float,
    rho_prop: Optional[float],
    gamma: float,
    R: float,
) -> np.ndarray:
    """ODE RHS. State = [P_copv_Pa, P_tank_Pa]."""
    P_copv, P_tank = state
    P_up = regulator_outlet_pressure(P_copv, P_set0_psi, P_copv0_psi, k_droop)
    mdot_press = 0.0
    if solenoid_open_fn(t) and P_up > P_tank:
        mdot_press = n2_mass_flow_cv(cv_eff, P_up, P_tank, T_copv_K, gamma, R)

    # COPV pressure drop
    dP_copv = -(mdot_press * R * T_copv_K) / V_copv_m3

    # Tank pressure rise — include ullage expansion from propellant drain
    V_ull = max(float(V_ull_fn(t)), 1e-6)
    mdot_prop = float(mdot_prop_fn(t))
    dV_ull = 0.0
    if rho_prop is not None and rho_prop > 0 and mdot_prop > 0:
        dV_ull = mdot_prop / rho_prop

    dP_tank = (mdot_press * R * T_ull_K - P_tank * dV_ull) / V_ull
    return np.array([dP_copv, dP_tank], dtype=float)


def simulate_press_resupply(
    times: np.ndarray,
    *,
    P_copv_initial_Pa: float,
    P_tank_initial_Pa: float,
    V_copv_m3: float,
    V_ull_initial_m3: float,
    press_system_config,
    solenoid_schedule: list[tuple[float, float]],
    line_cv: Optional[float] = None,  # explicit override; if None uses press_system_config.line_cv_lox
    mdot_prop_arr: Optional[np.ndarray] = None,  # Case 2 only
    rho_prop: Optional[float] = None,  # Case 2 only [kg/m³]
    m_prop_initial_kg: Optional[float] = None,  # Case 2 only [kg]
    T_copv_K: float = 300.0,
    T_ull_K: float = 293.0,
    gamma: float = GAMMA_N2,
    R: float = R_N2,
    method: str = "RK45",
) -> dict:
    """Simulate COPV→tank press resupply via ODE.

    Case 1 (static, no propellant flow): pass mdot_prop_arr=None.
    Case 2 (dynamic during burn): pass mdot_prop_arr, rho_prop, m_prop_initial_kg.

    Returns dict with arrays keyed: 'time', 'P_copv_Pa', 'P_tank_Pa',
    'mdot_press', 'P_reg_Pa', 'solenoid_open'.
    """
    times = np.asarray(times, dtype=float)
    if times.ndim != 1 or len(times) < 2:
        raise ValueError("times must be a 1D array with >= 2 elements")
    if not np.all(np.isfinite(times)):
        raise ValueError("times contains non-finite values")
    if np.any(np.diff(times) <= 0):
        raise ValueError("times must be strictly increasing")

    ps = press_system_config
    # line_cv kwarg takes precedence; fall back to legacy ps.line_cv_lox if present
    _lcv = line_cv if line_cv is not None else getattr(ps, "line_cv_lox", None)
    if _lcv is None:
        cv_eff = float(ps.reg_cv)
    else:
        cv_eff = float(series_cv(ps.reg_cv, _lcv))

    solenoid_fn = _make_solenoid_fn(solenoid_schedule)

    # Build ullage volume function
    if mdot_prop_arr is not None and rho_prop is not None and m_prop_initial_kg is not None:
        mdot_prop_arr = np.asarray(mdot_prop_arr, dtype=float)
        if mdot_prop_arr.shape != times.shape:
            raise ValueError("mdot_prop_arr must have the same shape as times")
        if rho_prop <= 0 or m_prop_initial_kg <= 0:
            raise ValueError("rho_prop and m_prop_initial_kg must be > 0 for Case 2")

        # Case 2: integrate mdot_prop to get propellant mass consumed, then ullage volume
        # V_ull(t) = V_ull0 + (m_prop0 - m_prop(t)) / rho_prop
        from scipy.integrate import cumulative_trapezoid

        m_consumed = np.concatenate([[0.0], cumulative_trapezoid(mdot_prop_arr, times)])
        m_prop_arr = m_prop_initial_kg - m_consumed
        V_ull_arr = V_ull_initial_m3 + (m_prop_initial_kg - m_prop_arr) / rho_prop
        V_ull_fn = lambda t: float(np.interp(t, times, V_ull_arr))
        mdot_prop_fn = lambda t: float(np.interp(t, times, mdot_prop_arr))
        rho_prop_for_ode: Optional[float] = float(rho_prop)
    else:
        # Case 1: constant ullage
        V_ull_fn = lambda t: float(V_ull_initial_m3)
        mdot_prop_fn = lambda t: 0.0
        rho_prop_for_ode = None

    state0 = np.array([float(P_copv_initial_Pa), float(P_tank_initial_Pa)], dtype=float)
    rhs = partial(
        _press_ode,
        cv_eff=cv_eff,
        P_set0_psi=float(ps.reg_setpoint_psi),
        P_copv0_psi=float(ps.reg_initial_copv_psi),
        k_droop=float(ps.reg_droop_coeff),
        V_copv_m3=float(V_copv_m3),
        V_ull_fn=V_ull_fn,
        mdot_prop_fn=mdot_prop_fn,
        solenoid_open_fn=solenoid_fn,
        T_copv_K=float(T_copv_K),
        T_ull_K=float(T_ull_K),
        rho_prop=rho_prop_for_ode,
        gamma=float(gamma),
        R=float(R),
    )

    sol = solve_ivp(
        rhs,
        t_span=(float(times[0]), float(times[-1])),
        y0=state0,
        t_eval=times,
        method=method,
        max_step=0.005,
    )
    if not sol.success:
        raise RuntimeError(f"press resupply ODE failed: {sol.message}")

    P_copv_out = np.asarray(sol.y[0], dtype=float)
    P_tank_out = np.asarray(sol.y[1], dtype=float)
    sol_open = np.array([bool(solenoid_fn(t)) for t in times], dtype=bool)

    P_reg_out = np.array(
        [
            regulator_outlet_pressure(
                P_copv_out[i],
                float(ps.reg_setpoint_psi),
                float(ps.reg_initial_copv_psi),
                float(ps.reg_droop_coeff),
            )
            for i in range(len(times))
        ],
        dtype=float,
    )

    mdot_out = np.array(
        [
            n2_mass_flow_cv(cv_eff, P_reg_out[i], P_tank_out[i], float(T_copv_K), float(gamma), float(R))
            * float(sol_open[i])
            for i in range(len(times))
        ],
        dtype=float,
    )

    return {
        "time": times,
        "P_copv_Pa": P_copv_out,
        "P_tank_Pa": P_tank_out,
        "mdot_press": mdot_out,
        "P_reg_Pa": P_reg_out,
        "solenoid_open": sol_open,
    }


def fit_cv_line_from_static_test(
    times: np.ndarray,
    P_copv_Pa: np.ndarray,
    P_tank_Pa: np.ndarray,
    V_copv_m3: float,
    V_ull_m3: float,
    press_system_config,
    T_copv_K: float = 300.0,
    T_ull_K: float = 293.0,
    R: float = R_N2,
    gamma: float = GAMMA_N2,
) -> dict:
    """Fit Cv_line from static press test time series (Case 1).

    Algorithm per Section 7 of docs/copv_resupply_model.md:
    1. mdot from COPV side: mdot = -(V_copv / R / T_copv) * dP_copv/dt
    2. P_reg(t) from droop model (P_up = min(P_reg, P_copv))
    3. Solve Cv_eff at each timestep from orifice equation
    4. Back-calculate Cv_line: 1/Cv_line² = 1/Cv_eff² - 1/Cv_reg²
    5. Cross-check with tank side: mdot_check = (V_ull / R / T_ull) * dP_tank/dt
    """
    ps = press_system_config

    times = np.asarray(times, dtype=float)
    P_copv_Pa = np.asarray(P_copv_Pa, dtype=float)
    P_tank_Pa = np.asarray(P_tank_Pa, dtype=float)

    if times.ndim != 1 or len(times) < 3:
        raise ValueError("times must be 1D with >= 3 points")
    if P_copv_Pa.shape != times.shape or P_tank_Pa.shape != times.shape:
        raise ValueError("P_copv_Pa and P_tank_Pa must have same shape as times")
    if np.any(np.diff(times) <= 0):
        raise ValueError("times must be strictly increasing")

    dP_copv_dt = np.gradient(P_copv_Pa, times)
    dP_tank_dt = np.gradient(P_tank_Pa, times)

    mdot_copv = -(float(V_copv_m3) / (float(R) * float(T_copv_K))) * dP_copv_dt
    mdot_tank = (float(V_ull_m3) / (float(R) * float(T_ull_K))) * dP_tank_dt

    valid = mdot_copv > 1e-6
    if not np.any(valid):
        raise ValueError("No positive mdot detected — check time window selection")

    P_up = np.array(
        [
            regulator_outlet_pressure(
                P_copv_Pa[i],
                float(ps.reg_setpoint_psi),
                float(ps.reg_initial_copv_psi),
                float(ps.reg_droop_coeff),
            )
            for i in range(len(times))
        ],
        dtype=float,
    )

    cv_eff_arr = np.full_like(times, np.nan, dtype=float)

    for i in np.where(valid)[0]:
        P_u = float(P_up[i])
        P_d = float(P_tank_Pa[i])
        if P_u <= P_d:
            continue
        ratio = P_d / P_u
        if ratio <= CRIT_PRESS_RATIO:
            factor = (2.0 / (gamma + 1)) ** ((gamma + 1) / (2 * (gamma - 1)))
            A_eff_i = mdot_copv[i] / (P_u * np.sqrt(gamma / (R * T_copv_K)) * factor)
        else:
            term = ratio ** (2.0 / gamma) - ratio ** ((gamma + 1.0) / gamma)
            denom = P_u * np.sqrt((2.0 * gamma) / (R * T_copv_K * (gamma - 1.0)) * max(term, 0.0))
            if denom <= 0:
                continue
            A_eff_i = mdot_copv[i] / denom
        cv_eff_arr[i] = float(A_eff_i / 2.853e-5)

    cv_line_arr = np.full_like(times, np.nan, dtype=float)
    for i in np.where(valid)[0]:
        if np.isnan(cv_eff_arr[i]):
            continue
        inv = 1.0 / cv_eff_arr[i] ** 2 - 1.0 / float(ps.reg_cv) ** 2
        if inv > 0:
            cv_line_arr[i] = float(1.0 / np.sqrt(inv))

    good = np.isfinite(cv_line_arr)
    if not np.any(good):
        raise ValueError("Could not infer any finite Cv_line values (check regulator Cv vs effective Cv)")

    denom_mask = valid & (mdot_copv > 1e-9)
    cross_check_ratio = float(np.mean(mdot_tank[denom_mask] / mdot_copv[denom_mask])) if np.any(denom_mask) else float("nan")

    return {
        "cv_line_median": float(np.nanmedian(cv_line_arr)),
        "cv_line_mean": float(np.nanmean(cv_line_arr)),
        "cv_line_per_step": cv_line_arr,
        "mdot_copv_side": mdot_copv,
        "mdot_tank_side": mdot_tank,
        "cross_check_ratio": cross_check_ratio,
    }


# ---------------------------------------------------------------------------
# Dual-tank coupled ODE (single COPV → two propellant tanks simultaneously)
# ---------------------------------------------------------------------------

def _press_ode_dual(
    t: float,
    state: np.ndarray,
    *,
    cv_eff_lox: float,
    cv_eff_fuel: float,
    P_set0_psi: float,
    P_copv0_psi: float,
    k_droop: float,
    V_copv_m3: float,
    V_ull_lox_fn: Callable[[float], float],
    V_ull_fuel_fn: Callable[[float], float],
    mdot_prop_lox_fn: Callable[[float], float],
    mdot_prop_fuel_fn: Callable[[float], float],
    sol_lox_fn: Callable[[float], bool],
    sol_fuel_fn: Callable[[float], bool],
    T_copv_K: float,
    T_ull_lox_K: float,
    T_ull_fuel_K: float,
    rho_lox: Optional[float],
    rho_fuel: Optional[float],
    gamma: float,
    R: float,
) -> np.ndarray:
    """ODE RHS for single COPV feeding two tanks. State = [P_copv, P_lox, P_fuel]."""
    P_copv, P_lox, P_fuel = state
    P_reg = regulator_outlet_pressure(P_copv, P_set0_psi, P_copv0_psi, k_droop)

    mdot_lox = 0.0
    if sol_lox_fn(t) and P_reg > P_lox:
        mdot_lox = n2_mass_flow_cv(cv_eff_lox, P_reg, P_lox, T_copv_K, gamma, R)

    mdot_fuel = 0.0
    if sol_fuel_fn(t) and P_reg > P_fuel:
        mdot_fuel = n2_mass_flow_cv(cv_eff_fuel, P_reg, P_fuel, T_copv_K, gamma, R)

    # COPV depletes from the total N2 outflow to both branches
    dP_copv = -((mdot_lox + mdot_fuel) * R * T_copv_K) / V_copv_m3

    # LOX tank
    V_ull_lox = max(float(V_ull_lox_fn(t)), 1e-6)
    dV_lox = (float(mdot_prop_lox_fn(t)) / rho_lox) if (rho_lox and rho_lox > 0) else 0.0
    dP_lox = (mdot_lox * R * T_ull_lox_K - P_lox * dV_lox) / V_ull_lox

    # Fuel tank
    V_ull_fuel = max(float(V_ull_fuel_fn(t)), 1e-6)
    dV_fuel = (float(mdot_prop_fuel_fn(t)) / rho_fuel) if (rho_fuel and rho_fuel > 0) else 0.0
    dP_fuel = (mdot_fuel * R * T_ull_fuel_K - P_fuel * dV_fuel) / V_ull_fuel

    return np.array([dP_copv, dP_lox, dP_fuel], dtype=float)


def simulate_press_resupply_dual_tank(
    times: np.ndarray,
    *,
    P_copv_initial_Pa: float,
    P_lox_initial_Pa: float,
    P_fuel_initial_Pa: float,
    V_copv_m3: float,
    V_ull_lox_initial_m3: float,
    V_ull_fuel_initial_m3: float,
    press_system_config,
    lox_solenoid_schedule: list[tuple[float, float]],
    fuel_solenoid_schedule: list[tuple[float, float]],
    # Dynamic propellant flow (Case 2) — pass all or none
    mdot_lox_arr: Optional[np.ndarray] = None,
    rho_lox: Optional[float] = None,
    m_lox_initial_kg: Optional[float] = None,
    mdot_fuel_arr: Optional[np.ndarray] = None,
    rho_fuel: Optional[float] = None,
    m_fuel_initial_kg: Optional[float] = None,
    T_copv_K: float = 300.0,
    T_ull_lox_K: float = 250.0,
    T_ull_fuel_K: float = 293.0,
    gamma: float = GAMMA_N2,
    R: float = R_N2,
    method: str = "RK45",
) -> dict:
    """Simulate a single COPV supplying both LOX and fuel tanks via separate solenoids.

    The COPV pressure is shared — N2 mass flow to both tanks is drawn from the same
    pressurant volume, so opening one solenoid while the other is open depletes the
    COPV faster.

    Returns dict with arrays keyed:
        'time', 'P_copv_Pa', 'P_lox_Pa', 'P_fuel_Pa',
        'mdot_lox', 'mdot_fuel', 'P_reg_Pa',
        'solenoid_lox_open', 'solenoid_fuel_open'
    """
    times = np.asarray(times, dtype=float)
    if times.ndim != 1 or len(times) < 2:
        raise ValueError("times must be a 1D array with >= 2 elements")
    if not np.all(np.isfinite(times)):
        raise ValueError("times contains non-finite values")
    if np.any(np.diff(times) <= 0):
        raise ValueError("times must be strictly increasing")

    ps = press_system_config

    # Compute effective Cv for each branch (reg + line in series)
    _lcv_lox = getattr(ps, "line_cv_lox", None)
    _lcv_fuel = getattr(ps, "line_cv_fuel", None)
    cv_eff_lox = float(series_cv(ps.reg_cv, _lcv_lox)) if _lcv_lox else float(ps.reg_cv)
    cv_eff_fuel = float(series_cv(ps.reg_cv, _lcv_fuel)) if _lcv_fuel else float(ps.reg_cv)

    sol_lox_fn = _make_solenoid_fn(lox_solenoid_schedule)
    sol_fuel_fn = _make_solenoid_fn(fuel_solenoid_schedule)

    from scipy.integrate import cumulative_trapezoid

    def _build_ull_fns(mdot_arr, rho, m_initial, V_ull_initial):
        if mdot_arr is not None and rho is not None and m_initial is not None:
            mdot_arr = np.asarray(mdot_arr, dtype=float)
            m_consumed = np.concatenate([[0.0], cumulative_trapezoid(mdot_arr, times)])
            m_prop = m_initial - m_consumed
            V_ull = V_ull_initial + (m_initial - m_prop) / rho
            V_fn = lambda t, _t=times, _v=V_ull: float(np.interp(t, _t, _v))
            mdot_fn = lambda t, _t=times, _m=mdot_arr: float(np.interp(t, _t, _m))
            rho_out = float(rho)
        else:
            V_fn = lambda t: float(V_ull_initial)
            mdot_fn = lambda t: 0.0
            rho_out = None
        return V_fn, mdot_fn, rho_out

    V_ull_lox_fn, mdot_lox_fn, rho_lox_out = _build_ull_fns(
        mdot_lox_arr, rho_lox, m_lox_initial_kg, V_ull_lox_initial_m3
    )
    V_ull_fuel_fn, mdot_fuel_fn, rho_fuel_out = _build_ull_fns(
        mdot_fuel_arr, rho_fuel, m_fuel_initial_kg, V_ull_fuel_initial_m3
    )

    state0 = np.array([
        float(P_copv_initial_Pa),
        float(P_lox_initial_Pa),
        float(P_fuel_initial_Pa),
    ], dtype=float)

    rhs = partial(
        _press_ode_dual,
        cv_eff_lox=cv_eff_lox,
        cv_eff_fuel=cv_eff_fuel,
        P_set0_psi=float(ps.reg_setpoint_psi),
        P_copv0_psi=float(ps.reg_initial_copv_psi),
        k_droop=float(ps.reg_droop_coeff),
        V_copv_m3=float(V_copv_m3),
        V_ull_lox_fn=V_ull_lox_fn,
        V_ull_fuel_fn=V_ull_fuel_fn,
        mdot_prop_lox_fn=mdot_lox_fn,
        mdot_prop_fuel_fn=mdot_fuel_fn,
        sol_lox_fn=sol_lox_fn,
        sol_fuel_fn=sol_fuel_fn,
        T_copv_K=float(T_copv_K),
        T_ull_lox_K=float(T_ull_lox_K),
        T_ull_fuel_K=float(T_ull_fuel_K),
        rho_lox=rho_lox_out,
        rho_fuel=rho_fuel_out,
        gamma=float(gamma),
        R=float(R),
    )

    sol = solve_ivp(
        rhs,
        t_span=(float(times[0]), float(times[-1])),
        y0=state0,
        t_eval=times,
        method=method,
        max_step=0.005,
    )
    if not sol.success:
        raise RuntimeError(f"dual-tank press resupply ODE failed: {sol.message}")

    P_copv_out = np.asarray(sol.y[0], dtype=float)
    P_lox_out = np.asarray(sol.y[1], dtype=float)
    P_fuel_out = np.asarray(sol.y[2], dtype=float)

    sol_lox_open = np.array([bool(sol_lox_fn(t)) for t in times], dtype=bool)
    sol_fuel_open = np.array([bool(sol_fuel_fn(t)) for t in times], dtype=bool)

    P_reg_out = np.array(
        [
            regulator_outlet_pressure(
                P_copv_out[i],
                float(ps.reg_setpoint_psi),
                float(ps.reg_initial_copv_psi),
                float(ps.reg_droop_coeff),
            )
            for i in range(len(times))
        ],
        dtype=float,
    )

    mdot_lox_out = np.array(
        [
            n2_mass_flow_cv(cv_eff_lox, P_reg_out[i], P_lox_out[i], float(T_copv_K), float(gamma), float(R))
            * float(sol_lox_open[i])
            for i in range(len(times))
        ],
        dtype=float,
    )
    mdot_fuel_out = np.array(
        [
            n2_mass_flow_cv(cv_eff_fuel, P_reg_out[i], P_fuel_out[i], float(T_copv_K), float(gamma), float(R))
            * float(sol_fuel_open[i])
            for i in range(len(times))
        ],
        dtype=float,
    )

    return {
        "time": times,
        "P_copv_Pa": P_copv_out,
        "P_lox_Pa": P_lox_out,
        "P_fuel_Pa": P_fuel_out,
        "mdot_lox": mdot_lox_out,
        "mdot_fuel": mdot_fuel_out,
        "P_reg_Pa": P_reg_out,
        "solenoid_lox_open": sol_lox_open,
        "solenoid_fuel_open": sol_fuel_open,
    }

