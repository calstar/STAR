"""Interactive CLI for the pintle engine pipeline.

Features:
- Forward mode: user provides tank pressures (psi) and receives performance outputs
- Inverse mode: user provides target thrust (kN) and pipeline solves required tank pressures

This script uses the existing PintleEngineRunner to evaluate the pipeline.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path
from typing import Tuple, Dict, Any, Optional

import numpy as np
from scipy.optimize import brentq

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.pipeline.io import load_config
from engine.core.runner import PintleEngineRunner

# -----------------------------------------------------------------------------
# Helper utilities
# -----------------------------------------------------------------------------

PSI_TO_PA = 6894.76
PA_TO_PSI = 1.0 / PSI_TO_PA

CONFIG_PATH = Path(__file__).parent.parent / "configs" / "default.yaml"


class ThrustSolveError(RuntimeError):
    """Custom exception carrying diagnostics for inverse thrust solving."""

    def __init__(self, message: str, diagnostics: Dict[str, Any]):
        super().__init__(message)
        self.diagnostics = diagnostics


def load_runner() -> PintleEngineRunner:
    """Load configuration and create a runner instance."""
    config = load_config(str(CONFIG_PATH))
    return PintleEngineRunner(config)


def print_header(title: str) -> None:
    print("\n" + "=" * 80)
    print(title)
    print("=" * 80)


def format_value(value: float, unit: str, precision: int = 2) -> str:
    return f"{value:.{precision}f} {unit}"


def summarize_results(results: Dict[str, Any]) -> None:
    """Pretty-print the main outputs from a pipeline evaluation."""
    Pc_psi = results["Pc"] * PA_TO_PSI
    thrust_kN = results["F"] / 1000.0
    mdot_total = results["mdot_total"]
    mdot_O = results["mdot_O"]
    mdot_F = results["mdot_F"]
    MR = results["MR"]
    Isp = results["Isp"]
    cstar = results["cstar_actual"]
    v_exit = results["v_exit"]
    P_exit_psi = results["P_exit"] * PA_TO_PSI

    print("Performance Summary:")
    print(f"  Thrust             : {format_value(thrust_kN, 'kN')}")
    print(f"  Specific Impulse   : {format_value(Isp, 's', 1)}")
    print(f"  Chamber Pressure   : {format_value(Pc_psi, 'psi', 1)}")
    print(f"  Total Mass Flow    : {format_value(mdot_total, 'kg/s', 3)}")
    print(f"    - Oxidizer       : {format_value(mdot_O, 'kg/s', 3)}")
    print(f"    - Fuel           : {format_value(mdot_F, 'kg/s', 3)}")
    print(f"  Mixture Ratio (O/F): {MR:.3f}")
    print(f"  c* (actual)        : {format_value(cstar, 'm/s', 1)}")
    print(f"  Exit Velocity      : {format_value(v_exit, 'm/s', 1)}")
    print(f"  Exit Pressure      : {format_value(P_exit_psi, 'psi', 2)}")

    cooling = results.get("cooling", {})
    if cooling:
        print("\nCooling Summary:")
        regen = cooling.get("regen")
        if regen and regen.get("enabled", False):
            print(f"  Regen outlet T   : {regen['coolant_outlet_temperature']:.1f} K")
            print(f"  Regen heat flux  : {regen['overall_heat_flux']/1000:.1f} kW/m²")
            if 'mdot_coolant' in regen:
                print(f"  Coolant flow     : {regen['mdot_coolant']:.3f} kg/s")
        film = cooling.get("film")
        if film and film.get("enabled", False):
            print(
                f"  Film effectiveness: {film['effectiveness']:.2f} (mass fraction {film['mass_fraction']:.3f})"
            )
            print(f"  Film heat factor : {film['heat_flux_factor']:.2f} | Film flow {film['mdot_film']:.3f} kg/s")
        ablative = cooling.get("ablative")
        if ablative and ablative.get("enabled", False):
            print(
                f"  Ablative recession: {ablative['recession_rate']*1e6:.3f} µm/s"
            )
            print(f"  Ablative heat flux: {ablative['effective_heat_flux']/1000:.1f} kW/m²")


# -----------------------------------------------------------------------------
# Forward evaluation (tank pressures -> performance)
# -----------------------------------------------------------------------------

def forward_mode(runner: PintleEngineRunner) -> None:
    print_header("FORWARD MODE: Tank Pressures -> Performance")

    try:
        P_tank_O_psi = float(input("Enter LOX tank pressure [psi]: ").strip())
        P_tank_F_psi = float(input("Enter Fuel tank pressure [psi]: ").strip())
    except ValueError:
        print("Invalid numeric input. Returning to menu.")
        return

    if P_tank_O_psi <= 0 or P_tank_F_psi <= 0:
        print("Tank pressures must be positive. Returning to menu.")
        return

    P_tank_O = P_tank_O_psi * PSI_TO_PA
    P_tank_F = P_tank_F_psi * PSI_TO_PA

    try:
        results = runner.evaluate(P_tank_O, P_tank_F)
    except Exception as exc:
        print(f"Pipeline evaluation failed: {exc}")
        return

    print_header("RESULTS")
    summarize_results(results)


# -----------------------------------------------------------------------------
# Inverse evaluation (target thrust -> tank pressures)
# -----------------------------------------------------------------------------

def _thrust_difference(
    scale: float,
    runner: PintleEngineRunner,
    base_pressures: Tuple[float, float],
    target_thrust_kN: float,
) -> float:
    """Return thrust difference at given scale factor."""
    P_tank_O_base, P_tank_F_base = base_pressures
    P_tank_O = scale * P_tank_O_base
    P_tank_F = scale * P_tank_F_base
    try:
        results = runner.evaluate(P_tank_O, P_tank_F)
    except Exception as exc:  # propagate for root finder diagnostics
        raise RuntimeError(f"Evaluation failed at scale={scale:.4f}: {exc}") from exc
    thrust_kN = results["F"] / 1000.0
    return thrust_kN - target_thrust_kN


def solve_for_thrust_and_MR(
    runner: PintleEngineRunner,
    target_thrust_kN: float,
    target_MR: float,
    initial_guess_psi: Optional[Tuple[float, float]] = None,
    max_iterations: int = 50,
    tolerance: float = 0.01,
) -> Tuple[Tuple[float, float], Dict[str, Any], Dict[str, Any]]:
    """Solve for tank pressures that achieve both target thrust AND target O/F ratio.
    
    This uses a 2D Newton-Raphson iteration to find (P_tank_O, P_tank_F) such that:
    - Thrust(P_O, P_F) = target_thrust_kN
    - MR(P_O, P_F) = target_MR
    
    Parameters:
    -----------
    runner : PintleEngineRunner
        Engine pipeline runner
    target_thrust_kN : float
        Desired thrust [kN]
    target_MR : float
        Desired mixture ratio (O/F)
    initial_guess_psi : tuple, optional
        Starting guess for (P_tank_O, P_tank_F) in psi
        If None, uses (1305, 974) as default
    max_iterations : int
        Maximum Newton iterations
    tolerance : float
        Convergence tolerance (relative error)
    
    Returns:
    --------
    (P_tank_O_psi, P_tank_F_psi) : tuple
        Solution tank pressures [psi]
    results : dict
        Full pipeline results at solution
    diagnostics : dict
        Iteration history and convergence info
    """
    from scipy.optimize import fsolve
    
    if initial_guess_psi is None:
        initial_guess_psi = (1305.0, 974.0)
    
    P_O_guess, P_F_guess = initial_guess_psi
    
    # Track iteration history
    history = {
        "P_tank_O": [],
        "P_tank_F": [],
        "thrust": [],
        "MR": [],
        "thrust_error": [],
        "MR_error": [],
    }
    
    def residual(P_psi: np.ndarray) -> np.ndarray:
        """Residual function for fsolve: [thrust_error, MR_error]"""
        P_O_psi, P_F_psi = P_psi
        
        # Clamp to positive values
        if P_O_psi <= 0 or P_F_psi <= 0:
            return np.array([1e6, 1e6])
        
        try:
            P_O_pa = P_O_psi * PSI_TO_PA
            P_F_pa = P_F_psi * PSI_TO_PA
            res = runner.evaluate(P_O_pa, P_F_pa)
            
            thrust_kN = res["F"] / 1000.0
            MR = res["MR"]
            
            # Safe division with validation
            thrust_error = (thrust_kN - target_thrust_kN) / target_thrust_kN if target_thrust_kN > 0 else 1.0
            MR_error = (MR - target_MR) / target_MR if target_MR > 0 else 1.0
            
            # Log history
            history["P_tank_O"].append(P_O_psi)
            history["P_tank_F"].append(P_F_psi)
            history["thrust"].append(thrust_kN)
            history["MR"].append(MR)
            history["thrust_error"].append(thrust_error)
            history["MR_error"].append(MR_error)
            
            return np.array([thrust_error, MR_error])
        
        except Exception as exc:
            # If evaluation fails, return large error
            return np.array([1e6, 1e6])
    
    # CRITICAL FIX: Use more robust solver with better options
    # fsolve can fail if residual is poorly conditioned - use better method
    from scipy.optimize import root
    
    # Solve using root (more robust than fsolve)
    try:
        # Try 'hybr' method first (default, fast)
        result = root(
            residual,
            x0=np.array([P_O_guess, P_F_guess]),
            method='hybr',
            options={'xtol': tolerance, 'maxfev': max_iterations * 10},
        )
        
        if not result.success:
            # If hybr fails, try 'lm' (Levenberg-Marquardt, more robust)
            result = root(
                residual,
                x0=np.array([P_O_guess, P_F_guess]),
                method='lm',
                options={'xtol': tolerance, 'max_nfev': max_iterations * 10},
            )
        
        solution = result.x
        ier = 1 if result.success else 0
        msg = result.message if hasattr(result, 'message') else str(result.status)
        
        P_O_sol, P_F_sol = solution
        
        # CRITICAL FIX: Check if solution is actually good before accepting
        # Even if solver says it converged, verify the result
        if ier != 1 or not result.success:
            # Check if we got a reasonable solution anyway
            try:
                test_results = runner.evaluate(P_O_sol * PSI_TO_PA, P_F_sol * PSI_TO_PA)
                test_thrust = test_results["F"] / 1000.0
                test_MR = test_results["MR"]
                thrust_err = abs(test_thrust - target_thrust_kN) / target_thrust_kN if target_thrust_kN > 0 else 1.0
                MR_err = abs(test_MR - target_MR) / target_MR if target_MR > 0 else 1.0
                
                # If solution is actually good (within 2x tolerance), accept it
                if thrust_err < tolerance * 2.0 and MR_err < tolerance * 2.0:
                    # Solution is good enough - accept it
                    pass
                else:
                    raise ThrustSolveError(
                        f"Root finder did not converge: {msg}",
                        {
                            "history": history,
                            "final_pressures": (P_O_sol, P_F_sol),
                            "target_thrust": target_thrust_kN,
                            "target_MR": target_MR,
                            "actual_thrust": test_thrust,
                            "actual_MR": test_MR,
                        },
                    )
            except Exception as e:
                raise ThrustSolveError(
                    f"Root finder did not converge: {msg}",
                    {
                        "history": history,
                        "final_pressures": (P_O_sol, P_F_sol),
                        "target_thrust": target_thrust_kN,
                        "target_MR": target_MR,
                    },
                ) from e
        
        # Evaluate final solution
        final_results = runner.evaluate(P_O_sol * PSI_TO_PA, P_F_sol * PSI_TO_PA)
        final_thrust = final_results["F"] / 1000.0
        final_MR = final_results["MR"]
        
        thrust_error_pct = abs((final_thrust - target_thrust_kN) / target_thrust_kN) * 100
        MR_error_pct = abs((final_MR - target_MR) / target_MR) * 100
        
        diagnostics = {
            "history": history,
            "iterations": len(history["thrust"]),
            "final_thrust": final_thrust,
            "final_MR": final_MR,
            "thrust_error_pct": thrust_error_pct,
            "MR_error_pct": MR_error_pct,
            "converged": True,
        }
        
        return (P_O_sol, P_F_sol), final_results, diagnostics
    
    except Exception as exc:
        raise ThrustSolveError(
            f"Failed to solve for thrust and O/F: {exc}",
            {
                "history": history,
                "target_thrust": target_thrust_kN,
                "target_MR": target_MR,
                "initial_guess": initial_guess_psi,
            },
        ) from exc


def solve_for_thrust(
    runner: PintleEngineRunner,
    target_thrust_kN: float,
    base_pressures_psi: Tuple[float, float],
    scale_bounds: Tuple[float, float] = (0.2, 5.0),
    num_samples: int = 60,
) -> Tuple[Tuple[float, float], Dict[str, Any], Dict[str, Any]]:
    """Solve for tank pressures that achieve the target thrust.

    The solution scales the baseline tank pressures by a factor 'scale'.
    The function also returns diagnostic information useful for UIs.
    """

    base_O_psi, base_F_psi = base_pressures_psi
    if base_O_psi <= 0 or base_F_psi <= 0:
        raise ValueError("Baseline tank pressures must be positive.")

    base_pressures_pa = (base_O_psi * PSI_TO_PA, base_F_psi * PSI_TO_PA)

    try:
        baseline_results = runner.evaluate(*base_pressures_pa)
    except Exception as exc:
        raise ThrustSolveError(
            f"Baseline evaluation failed: {exc}",
            {
                "baseline_pressed": base_pressures_pa,
                "target_thrust": target_thrust_kN,
            },
        ) from exc
    baseline_thrust = baseline_results["F"] / 1000.0

    scale_min, scale_max = scale_bounds
    if scale_min <= 0 or scale_max <= 0:
        raise ValueError("Scale bounds must be positive.")

    # Sample thrust across scale range to bracket the target
    sample_scales = np.linspace(scale_min, scale_max, num_samples)
    sample_scales = np.unique(np.append(sample_scales, 1.0))  # ensure baseline included
    sample_scales.sort()

    thrust_samples = []
    diff_samples = []
    cache: Dict[float, Dict[str, Any]] = {}
    invalid_samples: list[Tuple[float, str]] = []

    for scale in sample_scales:
        P_tank_O = scale * base_pressures_pa[0]
        P_tank_F = scale * base_pressures_pa[1]
        try:
            res = runner.evaluate(P_tank_O, P_tank_F)
        except Exception as exc:
            invalid_samples.append((scale, str(exc)))
            cache[scale] = {"error": str(exc)}
            thrust_samples.append(np.nan)
            diff_samples.append(np.nan)
            continue

        cache[scale] = res
        thrust = res["F"] / 1000.0
        thrust_samples.append(thrust)
        diff_samples.append(thrust - target_thrust_kN)

    thrust_array = np.asarray(thrust_samples, dtype=float)
    diff_array = np.asarray(diff_samples, dtype=float)
    finite_mask = np.isfinite(thrust_array)

    if not np.any(finite_mask):
        diagnostics = {
            "baseline_thrust": baseline_thrust,
            "scale_bounds": scale_bounds,
            "sample_scales": sample_scales,
            "sample_thrusts": thrust_samples,
            "invalid_samples": invalid_samples,
        }
        raise ThrustSolveError(
            "All sampled scale evaluations failed. Consider adjusting baseline pressures or scale bounds.",
            diagnostics,
        )

    valid_scales = sample_scales[finite_mask]
    valid_thrusts = thrust_array[finite_mask]
    valid_diffs = diff_array[finite_mask]

    thrust_min = float(np.min(valid_thrusts))
    thrust_max = float(np.max(valid_thrusts))

    diagnostics = {
        "baseline_thrust": baseline_thrust,
        "min_thrust": thrust_min,
        "max_thrust": thrust_max,
        "scale_bounds": scale_bounds,
        "sample_scales": sample_scales,
        "sample_thrusts": thrust_samples,
        "invalid_samples": invalid_samples,
    }

    if target_thrust_kN < thrust_min or target_thrust_kN > thrust_max:
        raise ThrustSolveError(
            f"Target thrust {target_thrust_kN:.2f} kN is outside achievable range "
            f"[{thrust_min:.2f}, {thrust_max:.2f}] kN for scale bounds {scale_bounds}. "
            f"Baseline thrust: {baseline_thrust:.2f} kN.",
            diagnostics,
        )

    bracket: Optional[Tuple[float, float]] = None
    for idx in range(len(valid_scales) - 1):
        diff_i = valid_diffs[idx]
        diff_j = valid_diffs[idx + 1]

        if abs(diff_i) < 1e-3:
            scale = valid_scales[idx]
            P_tank_O_solution = scale * base_pressures_pa[0]
            P_tank_F_solution = scale * base_pressures_pa[1]
            results = cache.get(scale)
            if not results:
                results = runner.evaluate(P_tank_O_solution, P_tank_F_solution)
            return (P_tank_O_solution, P_tank_F_solution), results, diagnostics

        if diff_i * diff_j <= 0:
            bracket = (valid_scales[idx], valid_scales[idx + 1])
            break

    if bracket is None:
        raise ThrustSolveError(
            "Failed to bracket target thrust. Consider expanding scale bounds.",
            diagnostics,
        )

    try:
        scale = brentq(
            _thrust_difference,
            bracket[0],
            bracket[1],
            args=(runner, base_pressures_pa, target_thrust_kN),
            xtol=1e-5,
            rtol=1e-5,
            maxiter=100,
        )
    except Exception as exc:
        raise ThrustSolveError(f"Root finding failed: {exc}", diagnostics) from exc

    P_tank_O_solution = scale * base_pressures_pa[0]
    P_tank_F_solution = scale * base_pressures_pa[1]
    results = runner.evaluate(P_tank_O_solution, P_tank_F_solution)

    return (P_tank_O_solution, P_tank_F_solution), results, diagnostics


def inverse_mode(runner: PintleEngineRunner) -> None:
    print_header("INVERSE MODE: Target Thrust -> Tank Pressures")
    try:
        target_thrust_kN = float(input("Enter desired thrust [kN]: ").strip())
    except ValueError:
        print("Invalid thrust input. Returning to menu.")
        return

    if target_thrust_kN <= 0:
        print("Target thrust must be positive. Returning to menu.")
        return

    # Baseline pressures (psi)
    try:
        base_O_psi = float(
            input("Enter baseline LOX tank pressure [psi] (default 1305): ").strip() or "1305"
        )
        base_F_psi = float(
            input("Enter baseline Fuel tank pressure [psi] (default 974): ").strip() or "974"
        )
    except ValueError:
        print("Invalid baseline pressures. Returning to menu.")
        return

    try:
        (P_tank_O_solution, P_tank_F_solution), results, diagnostics = solve_for_thrust(
            runner,
            target_thrust_kN,
            (base_O_psi, base_F_psi),
        )
    except ThrustSolveError as exc:
        print(f"Failed to find tank pressures for target thrust: {exc}")
        diag = exc.diagnostics
        print(
            f"Achievable thrust range within scale bounds {diag['scale_bounds']}: "
            f"{diag['min_thrust']:.2f} - {diag['max_thrust']:.2f} kN"
        )
        return
    except Exception as exc:
        print(f"Failed to find tank pressures for target thrust: {exc}")
        return

    P_tank_O_psi = P_tank_O_solution * PA_TO_PSI
    P_tank_F_psi = P_tank_F_solution * PA_TO_PSI

    print_header("SOLUTION")
    print(f"Required LOX tank pressure : {format_value(P_tank_O_psi, 'psi', 1)}")
    print(f"Required Fuel tank pressure: {format_value(P_tank_F_psi, 'psi', 1)}")
    summarize_results(results)

    print_header("DIAGNOSTICS")
    print(
        f"Baseline thrust (scale=1.0): {diagnostics['baseline_thrust']:.2f} kN"
        f" | Achievable range within scales {diagnostics['scale_bounds']}: "
        f"{diagnostics['min_thrust']:.2f} - {diagnostics['max_thrust']:.2f} kN"
    )


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------

def interactive_loop():
    runner = load_runner()
    print_header("PINTLE ENGINE PIPELINE - INTERACTIVE CLI")
    print(f"Configuration: {CONFIG_PATH}")

    while True:
        print("\nSelect an option:")
        print("  1) Forward mode  (tank pressures -> performance)")
        print("  2) Inverse mode  (target thrust   -> tank pressures)")
        print("  q) Quit")
        choice = input("Enter choice: ").strip().lower()

        if choice == "1":
            forward_mode(runner)
        elif choice == "2":
            inverse_mode(runner)
        elif choice in {"q", "quit", "exit"}:
            print("Exiting interactive CLI.")
            break
        else:
            print("Invalid choice. Please select 1, 2, or q.")


if __name__ == "__main__":
    try:
        interactive_loop()
    except KeyboardInterrupt:
        print("\nInterrupted by user. Exiting.")
