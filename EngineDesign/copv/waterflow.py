"""
Water flow test simulation.

Simulates a cold-flow water test where both tanks are filled with water
and pressurized with N2. Water flows through the injector at atmospheric
back-pressure — no combustion, no chamber pressure.

Physics:
- Tank blowdown uses the same polytropic N2 expansion as hot-fire blowdown
- CdA is computed via the same effective_cda() model the hot-fire engine uses,
  with water density/viscosity substituted for propellant properties.
  If the discharge config has cda_fit_a/b set (cold-flow empirical fit),
  those are used automatically instead.
- Cd_override bypasses cd_from_re entirely when you want to manually tune
  against a specific test.
- Feed losses computed with water properties using the engine feed_loss model
- Chamber pressure = atmospheric (101325 Pa, 0 psig)

Use this to validate the blowdown/pressure solver against bench water flow tests.
"""

import numpy as np
from typing import Optional

from copv.blowdown_solver import simulate_coupled_blowdown
from engine.core.geometry import get_effective_areas, get_hydraulic_diameters
from engine.core.discharge import effective_cda, calculate_reynolds_number
from engine.pipeline.feed_loss import delta_p_feed


def simulate_waterflow(
    times: np.ndarray,
    P_lox_initial_Pa: float,
    P_fuel_initial_Pa: float,
    config,
    m_lox_override_kg: Optional[float] = None,
    m_fuel_override_kg: Optional[float] = None,
    rho_water: float = 1000.0,
    mu_water: float = 1e-3,
    P_ambient_Pa: float = 101325.0,
    T_water_K: float = 293.0,
    T_lox_gas_K: float = 293.0,
    T_fuel_gas_K: float = 293.0,
    n_polytropic: float = 1.2,
    use_real_gas: bool = True,
    n2_Z_csv: Optional[str] = None,
) -> dict:
    """
    Simulate a bench water flow test.

    Both tanks are treated as containing water (rho_water) pressurized by N2.
    Flow through the injector uses the same effective_cda() model as hot-fire, with
    water density/viscosity substituted. If the discharge config has a cold-flow
    empirical fit (cda_fit_a/b), that is used automatically.

    Parameters
    ----------
    times : np.ndarray
        Time points [s]
    P_lox_initial_Pa : float
        Initial LOX-side tank pressure [Pa]
    P_fuel_initial_Pa : float
        Initial fuel-side tank pressure [Pa]
    config : PintleEngineConfig
        Engine configuration (injector geometry, discharge, feed system, tank sizing)
    m_lox_override_kg : float or None
        Override initial water mass in the LOX-side tank [kg]. If None, uses config value.
    m_fuel_override_kg : float or None
        Override initial water mass in the fuel-side tank [kg]. If None, uses config value.
    rho_water : float
        Water density [kg/m³] (default 1000)
    mu_water : float
        Water dynamic viscosity [Pa·s] (default 1e-3)
    P_ambient_Pa : float
        Back-pressure at injector exit = atmospheric (default 101325 Pa)
    T_water_K : float
        Water temperature [K] for Cd temperature correction (default 293)
    T_lox_gas_K : float
        Initial N2 ullage temperature, LOX-side tank [K] (default 293 — room temp)
    T_fuel_gas_K : float
        Initial N2 ullage temperature, fuel-side tank [K] (default 293)
    n_polytropic : float
        Polytropic exponent for N2 expansion (default 1.2)
    use_real_gas : bool
        Use N2 compressibility Z-factor lookup table (default True)
    n2_Z_csv : str or None
        Path to N2 Z-factor CSV. Required when use_real_gas=True.

    Returns
    -------
    dict with keys:
        "lox"              : blowdown result dict (P_Pa, T_K, V_ullage_m3, mdot_kg_s, m_prop_kg, is_depleted)
        "fuel"             : blowdown result dict (same keys)
        "delta_p_inj_O_Pa" : np.ndarray — injector ΔP on LOX side over time [Pa]
        "delta_p_inj_F_Pa" : np.ndarray — injector ΔP on fuel side over time [Pa]
        "rho_water_kg_m3"  : float — water density used
        "P_ambient_Pa"     : float — back-pressure used
    """
    # --- Extract injector geometry from config ---
    try:
        A_LOX, A_fuel = get_effective_areas(config.injector.geometry)
        d_hyd_O, d_hyd_F = get_hydraulic_diameters(config.injector.geometry)
    except Exception as err:
        raise ValueError(
            f"Could not extract injector geometry from config: {err}. "
            "Ensure config has injector.geometry with pintle LOX/fuel geometry."
        ) from err

    # --- Discharge and feed configs ---
    discharge_O = config.discharge["oxidizer"]
    discharge_F = config.discharge["fuel"]
    feed_O = config.feed_system["oxidizer"]
    feed_F = config.feed_system["fuel"]

    def _compute_CdA(A: float, d_hyd: float, discharge_cfg, dp_inj: float, mdot_guess: float) -> float:
        """Compute CdA via effective_cda() with water properties."""
        u = mdot_guess / (rho_water * A) if (rho_water * A) > 0 else 0.0
        Re = calculate_reynolds_number(rho_water, u, d_hyd, mu_water)
        return effective_cda(
            discharge_cfg,
            A,
            dp_inj,
            Re,
            P_inlet=None,
            T_inlet=T_water_K,
        )

    def _waterflow_evaluator(P_lox_Pa: float, P_fuel_Pa: float):
        """
        Compute water mass flow through each injector side.

        Mirrors the hot-fire pintle injector iteration:
          1. Estimate feed losses from current mdot
          2. Compute injector ΔP
          3. Compute Re → CdA via effective_cda() (water properties)
          4. Update mdot
          5. Repeat 3 times for self-consistency
        """
        # Initial mdot guess using Cd_inf * A (or cda_fit_b if set) at full tank pressure
        dp_O_guess = max(0.0, P_lox_Pa - P_ambient_Pa)
        dp_F_guess = max(0.0, P_fuel_Pa - P_ambient_Pa)
        CdA_O_init = effective_cda(discharge_O, A_LOX, dp_O_guess, 1e4, P_inlet=None, T_inlet=T_water_K)
        CdA_F_init = effective_cda(discharge_F, A_fuel, dp_F_guess, 1e4, P_inlet=None, T_inlet=T_water_K)
        mdot_O = CdA_O_init * np.sqrt(max(0.0, 2 * rho_water * dp_O_guess))
        mdot_F = CdA_F_init * np.sqrt(max(0.0, 2 * rho_water * dp_F_guess))

        for _ in range(5):
            # Feed losses
            try:
                dp_feed_O = delta_p_feed(mdot_O, rho_water, feed_O, P_lox_Pa)
            except Exception:
                dp_feed_O = 0.0
            try:
                dp_feed_F = delta_p_feed(mdot_F, rho_water, feed_F, P_fuel_Pa)
            except Exception:
                dp_feed_F = 0.0

            P_inj_O = max(P_ambient_Pa, P_lox_Pa - dp_feed_O)
            P_inj_F = max(P_ambient_Pa, P_fuel_Pa - dp_feed_F)

            dp_inj_O = max(0.0, P_inj_O - P_ambient_Pa)
            dp_inj_F = max(0.0, P_inj_F - P_ambient_Pa)

            CdA_O = _compute_CdA(A_LOX, d_hyd_O, discharge_O, dp_inj_O, mdot_O)
            CdA_F = _compute_CdA(A_fuel, d_hyd_F, discharge_F, dp_inj_F, mdot_F)

            mdot_O = CdA_O * np.sqrt(max(0.0, 2 * rho_water * dp_inj_O))
            mdot_F = CdA_F * np.sqrt(max(0.0, 2 * rho_water * dp_inj_F))

        return float(mdot_O), float(mdot_F)

    # --- Run coupled blowdown with waterflow callback ---
    # independent_depletion=True: when one side empties the other keeps flowing,
    # unlike hot-fire where depletion of either tank causes immediate flameout.
    blowdown_results = simulate_coupled_blowdown(
        times=times,
        evaluate_engine_fn=_waterflow_evaluator,
        P_lox_initial_Pa=P_lox_initial_Pa,
        P_fuel_initial_Pa=P_fuel_initial_Pa,
        config=config,
        R_pressurant=296.803,  # N2 gas constant [J/(kg·K)]
        T_lox_gas_K=T_lox_gas_K,
        T_fuel_gas_K=T_fuel_gas_K,
        n_polytropic=n_polytropic,
        use_real_gas=use_real_gas,
        n2_Z_csv=n2_Z_csv or "",
        independent_depletion=True,
        m_lox_override_kg=m_lox_override_kg,
        m_fuel_override_kg=m_fuel_override_kg,
    )

    # --- Post-process: compute injector ΔP trace ---
    P_lox_arr = np.asarray(blowdown_results["lox"]["P_Pa"])
    P_fuel_arr = np.asarray(blowdown_results["fuel"]["P_Pa"])
    mdot_O_arr = np.asarray(blowdown_results["lox"]["mdot_kg_s"])
    mdot_F_arr = np.asarray(blowdown_results["fuel"]["mdot_kg_s"])
    N = len(times)

    delta_p_inj_O_Pa = np.zeros(N)
    delta_p_inj_F_Pa = np.zeros(N)

    for i in range(N):
        P_lox_i = float(P_lox_arr[i])
        P_fuel_i = float(P_fuel_arr[i])
        mdot_O_i = float(mdot_O_arr[i])
        mdot_F_i = float(mdot_F_arr[i])

        try:
            dp_feed_O = delta_p_feed(mdot_O_i, rho_water, feed_O, P_lox_i)
        except Exception:
            dp_feed_O = 0.0
        try:
            dp_feed_F = delta_p_feed(mdot_F_i, rho_water, feed_F, P_fuel_i)
        except Exception:
            dp_feed_F = 0.0

        P_inj_O = max(P_ambient_Pa, P_lox_i - dp_feed_O)
        P_inj_F = max(P_ambient_Pa, P_fuel_i - dp_feed_F)

        delta_p_inj_O_Pa[i] = max(0.0, P_inj_O - P_ambient_Pa)
        delta_p_inj_F_Pa[i] = max(0.0, P_inj_F - P_ambient_Pa)

    return {
        "lox": blowdown_results["lox"],
        "fuel": blowdown_results["fuel"],
        "delta_p_inj_O_Pa": delta_p_inj_O_Pa,
        "delta_p_inj_F_Pa": delta_p_inj_F_Pa,
        "rho_water_kg_m3": rho_water,
        "P_ambient_Pa": P_ambient_Pa,
    }
