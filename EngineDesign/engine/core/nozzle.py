"""Nozzle model: RPA delivered thrust + isentropic exit state.

This is the AUTHORITATIVE nozzle: every runner.evaluate() call uses it (flight sim,
time series, pintle, and Layer-1 finalization). Delivered thrust is the RPA basis

    F(Pa) = zeta_n * Cf_vac * P0 * At - Pa * Ae

where Cf_vac is CEA's shifting-equilibrium vacuum thrust coefficient from the cache
tables, zeta_n = nozzle_efficiency, and combustion efficiency zeta_c (eta_c*) rides
in through the efficiency-reduced Pc from the chamber solve — so delivered
Isp = zeta_c * zeta_n * Isp_ideal. See docs/thrust_efficiency_bug_analysis.md for
why the former momentum-method reconstruction (ideal-Tc exhaust velocity) was
retired: it never applied combustion efficiency and over-predicted thrust by
~(1 - zeta_c*zeta_n). The exit state reported here (P_exit, T_exit, M_exit) is CEA's
shifting-equilibrium expansion at the same (P0, O/F, eps); thrust does not depend on it.
Pc is the injector-end pressure; the nozzle expands from P0 = Pc/kappa, the Rayleigh
stagnation loss of a finite-area combustor.

The numba accelerator (engine/accel/kernels.py) computes the SAME delivered
formula from the same tables for the Layer-1 inner loop; parity is enforced live by
tests/test_native_ab_parity.py.
"""

import numpy as np
import logging
from typing import Dict, Optional, Any
from engine.pipeline.cea_cache import CEACache
from engine.pipeline.numerical_robustness import PhysicalConstraints


def contraction_ratio_of(cg) -> Optional[float]:
    """A_chamber/A_throat of a ChamberGeometryConfig, or None when the bore is not declared."""
    D = getattr(cg, "chamber_diameter", None)
    At = getattr(cg, "A_throat", None)
    if not D or not At or D <= 0 or At <= 0:
        return None
    return float(np.pi * 0.25 * D * D / At)


def nozzle_stagnation_loss(contraction_ratio: Optional[float], gamma: float) -> float:
    """kappa = P_injector_end / P0_nozzle of a finite-area combustor (constant-area heat
    addition, Rayleigh line; Huzel & Huang sec. 2, Sutton & Biblarz Table 3-2):

        kappa = (1 + gamma M^2) / (1 + (gamma-1)/2 M^2)^(gamma/(gamma-1)),

    M the chamber-end Mach number, A/A* = contraction ratio on the subsonic branch.
    Reproduces CEA's finite-area "Pinj/Pinf" to 3e-5. 1.0 when the bore is unknown.
    """
    if contraction_ratio is None or not np.isfinite(contraction_ratio) or contraction_ratio <= 1.0:
        return 1.0
    from engine.pipeline.thermal.gas_side import mach_from_area_ratio
    M = mach_from_area_ratio(contraction_ratio, gamma, False)
    g = gamma
    return float((1.0 + g * M * M) / (1.0 + 0.5 * (g - 1.0) * M * M) ** (g / (g - 1.0)))


def expansion_ratio_for_exit_pressure(cea_cache: CEACache, MR: float, Pc: float, Pe: float,
                                      contraction_ratio: Optional[float] = None) -> float:
    """Area ratio whose CEA shifting-equilibrium exit pressure is Pe (optimum expansion is
    Pe = Pa, Sutton & Biblarz ch. 3). ``Pc`` is the injector-end pressure; with a declared
    contraction ratio the nozzle expands from Pc/kappa."""
    gamma = float(cea_cache.eval(MR, Pc, Pe)["gamma"])
    P0 = float(Pc) / nozzle_stagnation_loss(contraction_ratio, gamma)
    return cea_cache.aux.eps_for_exit_pressure(MR, P0, Pe)


def calculate_thrust(
    Pc: float,
    MR: float,
    mdot_total: float,
    cea_cache: CEACache,
    config: Any,
    Pa: float = 101325.0,
    reaction_progress: Optional[Dict] = None,
    debug: bool = False,
) -> dict:
    """
    Calculate delivered engine thrust (RPA methodology).

        F(Pa) = zeta_n * Cf_vac * P0 * At - Pa * Ae,   P0 = Pc / kappa

    Cf_vac is CEA's shifting-equilibrium vacuum thrust coefficient (cache lookup);
    zeta_n is config.chamber_geometry.nozzle_efficiency; combustion efficiency
    zeta_c (eta_c*) is already carried by the efficiency-reduced Pc from the
    chamber solve, so delivered Isp = zeta_c * zeta_n * Isp_ideal. The exit state
    also returned here (P_exit, T_exit, M_exit: CEA shifting equilibrium) is
    reporting-only; thrust does not depend on it. See the module docstring and
    docs/thrust_efficiency_bug_analysis.md.

    Parameters:
    -----------
    Pc : float
        Chamber pressure [Pa]
    MR : float
        Mixture ratio (O/F)
    mdot_total : float
        Total mass flow rate [kg/s]
    cea_cache : CEACache
        CEA cache for thermochemical properties
    config : PintleEngineConfig
        Complete engine configuration
    Pa : float
        Ambient pressure [Pa] (default: sea level)
    reaction_progress : dict, optional
        Chamber reaction progress; accepted for the call signature, not used

    Returns:
    --------
    results : dict
        Dictionary containing:
        - F: Delivered thrust [N]
        - F_momentum: vacuum term zeta_n*Cf_vac*P0*At [N]
        - F_pressure: ambient back-pressure term -Pa*Ae [N]
        - Cf / Cf_actual: delivered thrust coefficient F/(P0*At)
        - Cf_ideal: CEA ambient thrust coefficient at this Pa
        - P_exit, T_exit, M_exit: CEA shifting-equilibrium exit state; v_exit the ideal
          exhaust velocity on the same basis (reporting-only)
        - Pc_ns, stagnation_loss_kappa: nozzle stagnation pressure and Pc/Pc_ns
        - Isp: Delivered specific impulse [s]
    """
    # Extract geometry from config.chamber_geometry
    cg = config.chamber_geometry
    if cg is None:
        raise ValueError("config.chamber_geometry must be provided")

    A_throat = cg.A_throat
    A_exit = cg.A_exit
    eps = cg.expansion_ratio
    efficiency = cg.nozzle_efficiency

    # Validate geometry inputs
    if A_throat is None or A_throat <= 0:
        raise ValueError(f"Invalid A_throat: {A_throat}")
    if A_exit is None or A_exit <= 0:
        raise ValueError(f"Invalid A_exit: {A_exit}")
    if eps is None or eps <= 1.0:
        raise ValueError(f"Invalid expansion ratio: eps={eps}")

    # Verify geometric consistency: eps = A_exit / A_throat
    eps_calc = A_exit / A_throat
    if not np.isclose(eps, eps_calc, rtol=1e-4):
        raise ValueError(
            f"Geometric inconsistency: config.chamber_geometry.expansion_ratio ({eps:.6f}) "
            f"does not match A_exit / A_throat ({eps_calc:.6f})"
        )

    # Finite-area combustor: the nozzle's stagnation pressure is the injector-end Pc less
    # the Rayleigh loss of heat addition at the chamber Mach number.
    Pc_val = float(Pc)
    cea_first = cea_cache.eval(MR, Pc_val, Pa, eps)
    kappa = nozzle_stagnation_loss(contraction_ratio_of(cg), float(cea_first["gamma"]))
    P0 = Pc_val / kappa

    cea_props = cea_cache.eval(MR, P0, Pa, eps)
    Cf_ideal = cea_props["Cf_ideal"]   # ambient coefficient at this Pa: Cf_vac - Pa*eps/P0
    Cf_vac = cea_props["Cf_vac"]       # vacuum thrust coefficient (RPA delivered-thrust basis)
    gamma = cea_props["gamma"]
    Tc = cea_props["Tc"]
    R = cea_props["R"]
    gamma_val = float(gamma)
    eps_val = float(eps)

    gamma_check = PhysicalConstraints.validate_gamma(gamma_val)
    if not gamma_check.passed and gamma_check.severity == "error":
        raise ValueError(f"Invalid gamma: {gamma_check.message}")
    if mdot_total <= 0:
        raise ValueError(f"Invalid mass flow rate: mdot_total={mdot_total} kg/s. Must be positive.")

    # Exit state on CEA's shifting-equilibrium expansion -- the thermochemistry the thrust
    # uses -- not an isentrope at the chamber's gamma (which lands above both CEA bounds).
    exit_state = cea_cache.aux.exit_state(MR, P0, eps_val)
    P_exit = float(exit_state["P_exit"])
    T_exit = float(exit_state["T_exit"])
    M_exit = float(exit_state["M_exit"])
    # Ideal exhaust velocity on the same basis: F_vac = mdot v_e + Pe Ae with mdot = P0 At / c*.
    v_exit = float(cea_props["cstar_ideal"]) * (float(Cf_vac) - eps_val * P_exit / P0)
    if not (np.isfinite(P_exit) and P_exit > 0 and np.isfinite(T_exit) and T_exit > 0
            and M_exit > 1.0 and v_exit > 0):
        raise ValueError(f"Invalid CEA exit state at MR={MR:.4f}, P0={P0:.4g} Pa, eps={eps_val:.4f}: "
                         f"Pe={P_exit}, Te={T_exit}, Me={M_exit}, ve={v_exit}")
    gamma_exit = gamma_val
    R_exit = R
    equilibrium_factor = 1.0

    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZZLE][CEA] Pc={Pc_val:.3e} Pa, P0_ns={P0:.3e} Pa (kappa={kappa:.5f}), Pa={Pa:.3e} Pa, "
            f"MR={MR:.4f}, eps={eps_val:.3f} | Cf_vac={Cf_vac:.4f}, Pe={P_exit:.4g} Pa, Te={T_exit:.1f} K"
        )

    # ------------------------------------------------------------------
    # Delivered thrust -- RPA methodology (see docs/thrust_efficiency_bug_analysis.md):
    #     F(Pa) = zeta_n * Cf_vac * P0 * At  -  Pa * Ae
    # P0 is the nozzle stagnation pressure. Combustion efficiency zeta_c (= eta_c*) is
    # already carried by Pc (the chamber solve reduced it), so delivered Isp =
    # zeta_c * zeta_n * Isp_vac_ideal minus the ambient term.
    # ------------------------------------------------------------------
    zeta_n = efficiency
    Cf_vac_delivered = zeta_n * Cf_vac
    F_momentum = Cf_vac_delivered * P0 * A_throat
    F_pressure = -Pa * A_exit
    F = F_momentum + F_pressure
    F_cf = F

    if not np.isfinite(F):
        raise ValueError(
            f"Non-finite thrust: Cf_vac={Cf_vac}, zeta_n={zeta_n}, P0={P0:.3e} Pa, "
            f"At={A_throat:.3e} m^2, Pa={Pa:.3e} Pa, Ae={A_exit:.3e} m^2"
        )

    # Delivered thrust coefficient, referenced to the nozzle stagnation pressure.
    Cf_actual = F / (P0 * A_throat)
    Cf = Cf_actual

    if debug:
        logging.getLogger("evaluate").info(
            f"[NOZZLE RPA] Cf_vac={Cf_vac:.4f} zeta_n={zeta_n:.3f} -> Cf_vac_del={Cf_vac_delivered:.4f} | "
            f"F_vac={F_momentum:.1f} N, ambient(-Pa*Ae)={F_pressure:.1f} N, F={F:.1f} N | "
            f"Cf_actual={Cf_actual:.3f}, Isp={F/(mdot_total*9.80665):.1f} s"
        )

    # Throat state at the chamber gamma (reporting).
    throat_temp_ratio = 2.0 / (gamma_val + 1.0)
    T_throat = Tc * throat_temp_ratio
    P_throat = P0 * throat_temp_ratio ** (gamma_val / (gamma_val - 1.0))

    # Calculate Isp
    g0 = 9.80665  # m/s²
    Isp = F / (mdot_total * g0)
    
    if not np.isfinite(Isp):
        raise ValueError(
            f"Non-finite Isp: {Isp}. F={F:.2f} N, mdot_total={mdot_total:.4f} kg/s"
        )
    
    if Isp < 0:
        raise ValueError(
            f"Negative Isp: {Isp:.2f} s. This indicates negative thrust or negative mass flow. "
            f"F={F:.2f} N, mdot_total={mdot_total:.4f} kg/s"
        )

    results = {
        "F": float(F),
        "F_momentum": float(F_momentum),
        "F_pressure": float(F_pressure),
        "F_cf_method": float(F_cf),  # For comparison
        "Cf": float(Cf_actual),  # Return actual Cf (measured from thrust)
        "Cf_actual": float(Cf_actual),  # Explicit actual value
        "Cf_ideal": float(Cf_ideal),  # CEA ambient coefficient at this Pa
        "Cf_theoretical": float(Cf),  # zeta_n*Cf_vac - Pa*eps/P0, the delivered basis
        "Pc_ns": float(P0),  # nozzle stagnation pressure
        "stagnation_loss_kappa": float(kappa),
        "P_exit": float(P_exit),
        "exit_to_ambient_ratio": float(P_exit / Pa) if Pa > 0 else float("inf"),
        "exit_state_basis": "CEA shifting equilibrium",
        "P_throat": float(P_throat),
        "v_exit": float(v_exit),
        "T_exit": float(T_exit),
        "T_throat": float(T_throat),
        "Isp": float(Isp),
        "gamma_chamber": float(gamma_val),
        "gamma_exit": float(gamma_exit),
        "R_chamber": float(R),
        "R_exit": float(R_exit),
        "equilibrium_factor": float(equilibrium_factor),
        "M_exit": float(M_exit),
    }
    
    # Final validation of M_exit before returning
    if results["M_exit"] <= 1.0:
        raise ValueError(
            f"Invalid M_exit in results: {results['M_exit']:.6f}. "
            f"For supersonic nozzle, M_exit must be > 1.0. "
            f"eps={eps_val:.4f}, gamma_exit={gamma_exit:.4f}"
        )
    
    return results
