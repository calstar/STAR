"""
Fully coupled pressure-fed blowdown solver.

Integrates COPV pressurisation and propellant depletion in a single explicit-Euler
loop so that engine mdot, ullage expansion, tank pressure, and COPV depletion are
all self-consistent at every time step.

Unlike the two-pass approach (blowdown → COPV post-pass), this solver:
  1. Evaluates the engine at the *actual* (resupply-supported) tank pressures every step.
  2. Uses those mdots immediately for both ullage expansion and propellant depletion.
  3. Updates COPV pressure from the combined N2 outflow to both branches.

Physics summary
---------------
State per step: P_copv, P_lox, P_fuel, m_lox, m_fuel

  T_copv = T_copv0 * (P_copv / P_copv0)^((n-1)/n)          [polytropic COPV]
  P_reg  = reg_setpoint + k_droop*(P_copv0 - P_copv)        [regulator droop]

  mdot_press_lox  = n2_flow(cv_eff_lox,  P_reg, P_lox,  T_copv)  if sol_lox_open(t)
  mdot_press_fuel = n2_flow(cv_eff_fuel, P_reg, P_fuel, T_copv)  if sol_fuel_open(t)

  mdot_lox, mdot_fuel = engine_mdot_fn(P_lox, P_fuel)      [call engine once per step]
      (zeroed when either propellant is depleted — flameout)

  dP_copv = -( (mdot_press_lox + mdot_press_fuel) * R * T_copv ) / V_copv

  V_ull_lox  = V_lox  - m_lox  / rho_lox        (clamped ≥ 1e-6)
  V_ull_fuel = V_fuel - m_fuel / rho_fuel

  dP_lox  = ( mdot_press_lox  * R * T_ull_lox  - P_lox  * (mdot_lox  / rho_lox ) ) / V_ull_lox
  dP_fuel = ( mdot_press_fuel * R * T_ull_fuel - P_fuel * (mdot_fuel / rho_fuel) ) / V_ull_fuel

All quantities advance with dt = times[i+1] - times[i].
"""

from __future__ import annotations

import logging
from typing import Callable, Optional

import numpy as np

from copv.press_resupply_solver import (
    GAMMA_N2,
    R_N2,
    PSI_TO_PA,
    _make_solenoid_fn,
    n2_mass_flow_cv,
    regulator_outlet_pressure,
    series_cv,
)

log = logging.getLogger(__name__)


def simulate_pressure_fed(
    times: np.ndarray,
    engine_mdot_fn: Callable[[float, float], tuple[float, float]],
    *,
    # Initial conditions
    P_copv_initial_Pa: float,
    P_lox_initial_Pa: float,
    P_fuel_initial_Pa: float,
    m_lox_initial_kg: float,
    m_fuel_initial_kg: float,
    # Tank geometry
    V_copv_m3: float,
    V_lox_tank_m3: float,
    V_fuel_tank_m3: float,
    rho_lox: float,
    rho_fuel: float,
    # Press system config (PressSystemConfig pydantic model)
    press_system_config,
    # Solenoid schedules: list of (t_open, t_close) pairs [s]
    lox_solenoid_schedule: list[tuple[float, float]],
    fuel_solenoid_schedule: list[tuple[float, float]],
    # Thermal
    T_copv_initial_K: float = 300.0,
    T_ull_lox_K: float = 250.0,
    T_ull_fuel_K: float = 293.0,
    n_poly: float = 1.2,
    gamma: float = GAMMA_N2,
    R: float = R_N2,
) -> dict:
    """Fully coupled single-pass pressure-fed simulation.

    Parameters
    ----------
    times : 1-D array, strictly increasing [s]
    engine_mdot_fn : callable(P_lox_Pa, P_fuel_Pa) -> (mdot_lox_kg_s, mdot_fuel_kg_s)
        Engine evaluator.  Called once per time step.
    P_copv_initial_Pa, P_lox_initial_Pa, P_fuel_initial_Pa : float
        Initial pressures [Pa].
    m_lox_initial_kg, m_fuel_initial_kg : float
        Initial propellant masses [kg].
    V_copv_m3 : float
        Free gas volume of the COPV [m³].
    V_lox_tank_m3, V_fuel_tank_m3 : float
        Total tank volumes [m³].
    rho_lox, rho_fuel : float
        Liquid propellant densities [kg/m³].
    press_system_config : PressSystemConfig
        Must have: reg_cv, reg_setpoint_psi, reg_initial_copv_psi, reg_droop_coeff,
        and optionally line_cv_lox, line_cv_fuel.
    lox_solenoid_schedule, fuel_solenoid_schedule : list of (t_open, t_close)
        Solenoid open/close intervals [s].
    T_copv_initial_K : float
        Initial COPV gas temperature [K].
    T_ull_lox_K, T_ull_fuel_K : float
        Ullage gas temperatures (assumed constant) [K].
    n_poly : float
        Polytropic exponent for COPV gas expansion (1.0=isothermal, 1.4=isentropic).

    Returns
    -------
    dict with arrays (same length as *times*):
        time, P_copv_Pa, P_lox_Pa, P_fuel_Pa,
        m_lox_kg, m_fuel_kg,
        mdot_lox_kg_s, mdot_fuel_kg_s,       # propellant (from engine)
        mdot_press_lox_kg_s, mdot_press_fuel_kg_s,  # N2 pressurant
        P_reg_Pa, T_copv_K,
        solenoid_lox_open, solenoid_fuel_open
    """
    times = np.asarray(times, dtype=float)
    if times.ndim != 1 or len(times) < 2:
        raise ValueError("times must be a 1-D array with ≥ 2 elements")
    if np.any(np.diff(times) <= 0):
        raise ValueError("times must be strictly increasing")

    ps = press_system_config

    # Effective Cv for each branch (reg + line in series)
    _lcv_lox = getattr(ps, "line_cv_lox", None)
    _lcv_fuel = getattr(ps, "line_cv_fuel", None)
    cv_eff_lox = float(series_cv(ps.reg_cv, _lcv_lox)) if _lcv_lox else float(ps.reg_cv)
    cv_eff_fuel = float(series_cv(ps.reg_cv, _lcv_fuel)) if _lcv_fuel else float(ps.reg_cv)

    sol_lox_fn = _make_solenoid_fn(lox_solenoid_schedule)
    sol_fuel_fn = _make_solenoid_fn(fuel_solenoid_schedule)

    N = len(times)

    # Output arrays
    P_copv_arr       = np.zeros(N)
    P_lox_arr        = np.zeros(N)
    P_fuel_arr       = np.zeros(N)
    m_lox_arr        = np.zeros(N)
    m_fuel_arr       = np.zeros(N)
    mdot_lox_arr     = np.zeros(N)
    mdot_fuel_arr    = np.zeros(N)
    mdot_plox_arr    = np.zeros(N)   # N2 pressurant → LOX tank
    mdot_pfuel_arr   = np.zeros(N)   # N2 pressurant → fuel tank
    P_reg_arr        = np.zeros(N)
    T_copv_arr       = np.zeros(N)
    sol_lox_open_arr = np.zeros(N, dtype=bool)
    sol_fuel_open_arr= np.zeros(N, dtype=bool)

    # State variables
    P_copv  = float(P_copv_initial_Pa)
    P_lox   = float(P_lox_initial_Pa)
    P_fuel  = float(P_fuel_initial_Pa)
    m_lox   = float(m_lox_initial_kg)
    m_fuel  = float(m_fuel_initial_kg)
    P_copv0 = float(P_copv_initial_Pa)
    T_copv0 = float(T_copv_initial_K)

    def _T_copv(P: float) -> float:
        """Polytropic COPV gas temperature."""
        if P <= 0 or P_copv0 <= 0:
            return T_copv0
        return T_copv0 * (P / P_copv0) ** ((n_poly - 1.0) / n_poly)

    # Evaluate at t=0
    T_copv = _T_copv(P_copv)
    P_reg = regulator_outlet_pressure(P_copv, float(ps.reg_setpoint_psi), float(ps.reg_initial_copv_psi), float(ps.reg_droop_coeff))
    t0 = float(times[0])
    mdot_plox  = n2_mass_flow_cv(cv_eff_lox, P_reg, P_lox, T_copv, gamma, R) if sol_lox_fn(t0) and P_reg > P_lox else 0.0
    mdot_pfuel = n2_mass_flow_cv(cv_eff_fuel, P_reg, P_fuel, T_copv, gamma, R) if sol_fuel_fn(t0) and P_reg > P_fuel else 0.0

    try:
        mdot_lox_0, mdot_fuel_0 = engine_mdot_fn(P_lox, P_fuel) if (m_lox > 0 and m_fuel > 0) else (0.0, 0.0)
    except Exception as e:
        log.warning(f"[PRESS_FED] engine_mdot_fn failed at t=0: {e}")
        mdot_lox_0, mdot_fuel_0 = 0.0, 0.0

    P_copv_arr[0]       = P_copv
    P_lox_arr[0]        = P_lox
    P_fuel_arr[0]       = P_fuel
    m_lox_arr[0]        = m_lox
    m_fuel_arr[0]       = m_fuel
    mdot_lox_arr[0]     = mdot_lox_0
    mdot_fuel_arr[0]    = mdot_fuel_0
    mdot_plox_arr[0]    = mdot_plox
    mdot_pfuel_arr[0]   = mdot_pfuel
    P_reg_arr[0]        = P_reg
    T_copv_arr[0]       = T_copv
    sol_lox_open_arr[0] = bool(sol_lox_fn(t0))
    sol_fuel_open_arr[0]= bool(sol_fuel_fn(t0))

    for i in range(1, N):
        dt = float(times[i] - times[i - 1])
        t_mid = float(times[i - 1])  # solenoid state evaluated at start of interval

        # ---------- COPV temperature (polytropic) ----------
        T_copv = _T_copv(P_copv)

        # ---------- Regulator output ----------
        P_reg = regulator_outlet_pressure(
            P_copv,
            float(ps.reg_setpoint_psi),
            float(ps.reg_initial_copv_psi),
            float(ps.reg_droop_coeff),
        )

        # ---------- N2 pressurant flows ----------
        sol_lox_open  = bool(sol_lox_fn(t_mid))
        sol_fuel_open = bool(sol_fuel_fn(t_mid))

        mdot_plox  = n2_mass_flow_cv(cv_eff_lox,  P_reg, P_lox,  T_copv, gamma, R) if (sol_lox_open  and P_reg > P_lox)  else 0.0
        mdot_pfuel = n2_mass_flow_cv(cv_eff_fuel, P_reg, P_fuel, T_copv, gamma, R) if (sol_fuel_open and P_reg > P_fuel) else 0.0

        # ---------- Engine evaluation ----------
        lox_depleted  = m_lox  <= 1e-6
        fuel_depleted = m_fuel <= 1e-6
        if lox_depleted or fuel_depleted:
            # Flameout: no combustion without both propellants
            mdot_lox  = 0.0
            mdot_fuel = 0.0
        else:
            try:
                mdot_lox, mdot_fuel = engine_mdot_fn(P_lox, P_fuel)
            except Exception as e:
                log.warning(
                    f"[PRESS_FED] engine_mdot_fn failed at t={t_mid:.3f}s, "
                    f"P_lox={P_lox/PSI_TO_PA:.1f} psi, P_fuel={P_fuel/PSI_TO_PA:.1f} psi: {e}"
                )
                mdot_lox  = 0.0
                mdot_fuel = 0.0

        # ---------- State derivatives ----------
        # COPV: N2 mass leaves to both branches
        dP_copv = -((mdot_plox + mdot_pfuel) * R * T_copv) / max(V_copv_m3, 1e-9)

        # LOX tank: pressurant in, propellant out (ullage grows)
        V_ull_lox = max(V_lox_tank_m3 - m_lox / rho_lox, 1e-6)
        dP_lox = (mdot_plox * R * float(T_ull_lox_K) - P_lox * (mdot_lox / rho_lox)) / V_ull_lox

        # Fuel tank
        V_ull_fuel = max(V_fuel_tank_m3 - m_fuel / rho_fuel, 1e-6)
        dP_fuel = (mdot_pfuel * R * float(T_ull_fuel_K) - P_fuel * (mdot_fuel / rho_fuel)) / V_ull_fuel

        # ---------- Explicit Euler advance ----------
        P_copv = max(P_copv + dP_copv * dt, 0.0)
        P_lox  = max(P_lox  + dP_lox  * dt, 0.0)
        P_fuel = max(P_fuel + dP_fuel * dt, 0.0)
        m_lox  = max(m_lox  - mdot_lox  * dt, 0.0)
        m_fuel = max(m_fuel - mdot_fuel * dt, 0.0)

        # ---------- Store ----------
        P_copv_arr[i]       = P_copv
        P_lox_arr[i]        = P_lox
        P_fuel_arr[i]       = P_fuel
        m_lox_arr[i]        = m_lox
        m_fuel_arr[i]       = m_fuel
        mdot_lox_arr[i]     = mdot_lox
        mdot_fuel_arr[i]    = mdot_fuel
        mdot_plox_arr[i]    = mdot_plox
        mdot_pfuel_arr[i]   = mdot_pfuel
        P_reg_arr[i]        = P_reg
        T_copv_arr[i]       = T_copv
        sol_lox_open_arr[i] = sol_lox_open
        sol_fuel_open_arr[i]= sol_fuel_open

    return {
        "time":                  times,
        "P_copv_Pa":             P_copv_arr,
        "P_lox_Pa":              P_lox_arr,
        "P_fuel_Pa":             P_fuel_arr,
        "m_lox_kg":              m_lox_arr,
        "m_fuel_kg":             m_fuel_arr,
        "mdot_lox_kg_s":         mdot_lox_arr,
        "mdot_fuel_kg_s":        mdot_fuel_arr,
        "mdot_press_lox_kg_s":   mdot_plox_arr,
        "mdot_press_fuel_kg_s":  mdot_pfuel_arr,
        "P_reg_Pa":              P_reg_arr,
        "T_copv_K":              T_copv_arr,
        "solenoid_lox_open":     sol_lox_open_arr,
        "solenoid_fuel_open":    sol_fuel_open_arr,
    }
