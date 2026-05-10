"""Layer 3: Thermal Protection Optimization (Final Sizing)

This layer optimizes final ablative liner and graphite insert thicknesses to
meet recession requirements with margin while minimizing mass.

Once Layer 2 passes, this refines the thermal protection to right-size
the thicknesses (20% margin over max recession).
"""

from __future__ import annotations

from typing import Dict, Any, Optional, Tuple, Callable
from pathlib import Path
import numpy as np
import copy
import logging
import time
from datetime import datetime
import itertools

from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner


def run_layer3_thermal_protection(
    optimized_config: PintleEngineConfig,
    time_array: np.ndarray,
    P_tank_O_array: np.ndarray,
    P_tank_F_array: np.ndarray,
    full_time_results: Dict[str, Any],
    n_time_points: int,
    update_progress: Callable,
    log_status: Callable,
    objective_callback: Optional[Callable[[int, float, float], None]] = None,
    optimization_method: str = "gradient",  # "gradient", "cma", or "de"
) -> Tuple[PintleEngineConfig, Dict[str, Any], Dict[str, Any]]:
    """
    Run Layer 3: Thermal Protection Optimization.

    Optimizes final thermal protection thicknesses to meet recession requirements
    with margin while minimizing mass, while preserving the Layer 2 burn
    quality (impulse, stability).

    Args:
        optimization_method: Optimization algorithm to use:
            - "gradient": Fast gradient descent (recommended). Exploits monotonic
              relationship between thickness and recession. ~5-10 evaluations.
            - "cma": CMA-ES global optimizer. More thorough but slower. ~60-80 evals.
            - "de": Differential Evolution fallback. Similar to CMA-ES.

    Returns:
        Tuple of (optimized_config, updated_time_results, thermal_results)
    """
    from scipy.optimize import minimize as scipy_minimize
    
    # Try to import CMA-ES, fall back to DE if not available
    try:
        import cma
        use_cma = True
    except ImportError:
        use_cma = False
        from scipy.optimize import differential_evolution

    # ------------------------------------------------------------------
    # Set up Layer 3 logging (mirrors Layer 2 style)
    # ------------------------------------------------------------------
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Ensure output/logs directory exists
    output_logs_dir = Path(__file__).resolve().parents[3] / "output" / "logs"
    output_logs_dir.mkdir(parents=True, exist_ok=True)
    log_file_path = output_logs_dir / f"layer3_thermal_{timestamp}.log"

    layer3_logger = logging.getLogger("layer3_thermal")
    layer3_logger.setLevel(logging.INFO)
    layer3_logger.handlers.clear()

    file_handler = logging.FileHandler(log_file_path, mode="w", encoding="utf-8")
    file_handler.setLevel(logging.INFO)
    file_formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
    file_handler.setFormatter(file_formatter)
    layer3_logger.addHandler(file_handler)
    layer3_logger.propagate = False

    layer3_logger.info("=" * 70)
    layer3_logger.info("Layer 3: Thermal Protection Optimization")
    layer3_logger.info("=" * 70)
    layer3_logger.info(f"Log file: {log_file_path}")
    layer3_logger.info(f"Time points: {n_time_points}")

    ablative_cfg = optimized_config.ablative_cooling if hasattr(optimized_config, "ablative_cooling") else None
    graphite_cfg = optimized_config.graphite_insert if hasattr(optimized_config, "graphite_insert") else None

    thermal_results = {
        "max_recession_chamber": None,
        "max_recession_throat": None,
        "ablative_adequate": True,
        "graphite_adequate": True,
        "thermal_protection_valid": True,
        "log_file": log_file_path,
    }

    layer3_bounds = []
    layer3_x0 = []

    if ablative_cfg and ablative_cfg.enabled:
        # Generic ablative bounds: 3–20 mm. Layer 3 will determine the actual
        # required thickness based solely on its own time-series recession
        # results, independent of any Layer 1 / Layer 2 guesses.
        bounds_abl = (0.003, 0.025)
        layer3_bounds.append(bounds_abl)
        # Start from the midpoint of the search interval (independent of prior layers).
        ablative_x0 = 0.5 * (bounds_abl[0] + bounds_abl[1])
        layer3_x0.append(ablative_x0)
        layer3_logger.info(
            "Ablative enabled: search bounds=[%.3f, %.3f] mm, x0=%.3f mm",
            bounds_abl[0] * 1000.0,
            bounds_abl[1] * 1000.0,
            ablative_x0 * 1000.0,
        )

    if graphite_cfg and graphite_cfg.enabled:
        # Generic graphite bounds: 3–25 mm.
        bounds_gra = (0.003, 0.025)
        layer3_bounds.append(bounds_gra)
        graphite_x0 = 0.5 * (bounds_gra[0] + bounds_gra[1])
        layer3_x0.append(graphite_x0)
        layer3_logger.info(
            "Graphite enabled: search bounds=[%.3f, %.3f] mm, x0=%.3f mm",
            bounds_gra[0] * 1000.0,
            bounds_gra[1] * 1000.0,
            graphite_x0 * 1000.0,
        )

    # Preserve the original Layer 2 time-series as the baseline burn that all
    # Layer 3 candidates must still satisfy.
    updated_time_results = full_time_results

    # ------------------------------------------------------------------
    # Baseline metrics from the incoming time-series (Layer 2 candidate)
    # ------------------------------------------------------------------
    try:
        baseline_thrust = np.atleast_1d(full_time_results.get("F", np.zeros_like(time_array)))
        if baseline_thrust.size > n_time_points:
            baseline_thrust = baseline_thrust[:n_time_points]
        baseline_impulse = float(np.trapezoid(baseline_thrust, time_array[: baseline_thrust.size]))
    except Exception:
        baseline_impulse = 0.0

    # Baseline stability (use chugging margin if available, else stability_score)
    baseline_min_stability = None
    try:
        if "chugging_stability_margin" in full_time_results:
            chug = np.nan_to_num(
                np.atleast_1d(full_time_results["chugging_stability_margin"]),
                nan=0.0,
                posinf=0.0,
                neginf=0.0,
            )
            baseline_min_stability = float(np.min(chug))
        elif "stability_score" in full_time_results:
            stab = np.nan_to_num(
                np.atleast_1d(full_time_results["stability_score"]),
                nan=0.0,
                posinf=0.0,
                neginf=0.0,
            )
            baseline_min_stability = float(np.min(stab))
    except Exception:
        baseline_min_stability = None

    layer3_logger.info(
        "Baseline metrics from Layer 2: impulse=%.3f kN·s, min_stability=%s",
        baseline_impulse / 1000.0,
        f"{baseline_min_stability:.3f}" if baseline_min_stability is not None else "N/A",
    )

    if len(layer3_x0) > 0:
        layer3_x0 = np.array(layer3_x0, dtype=float)

        # Track optimization evaluations for optional streaming to UI
        layer3_state: Dict[str, Any] = {
            "eval_index": 0,
            "best_objective": float("inf"),
        }

        # Simple cache so we don't rerun the expensive time-varying solver for
        # identical (quantized) thickness combinations. Because we quantize to
        # 0.1 mm, many optimizer proposals map to the same physical design.
        _objective_cache: Dict[Tuple[float, ...], float] = {}

        def downsample_array(arr: np.ndarray, n_coarse: int) -> np.ndarray:
            """Downsample array from fine grid to coarse grid using linear interpolation."""
            n_fine = len(arr)
            if n_coarse >= n_fine:
                return arr.copy()
            # Use evenly spaced indices for downsampling
            indices = np.linspace(0, n_fine - 1, n_coarse)
            return np.interp(indices, np.arange(n_fine), arr)

        def layer3_objective(x_layer3: np.ndarray, n_eval_points: Optional[int] = None) -> float:
            """Optimize thermal protection to minimize mass while meeting recession requirements."""
            eval_start = time.time()
            layer3_state["eval_index"] += 1
            eval_idx = int(layer3_state["eval_index"])

            try:
                x_layer3 = np.asarray(x_layer3, dtype=float)
                if not np.all(np.isfinite(x_layer3)):
                    layer3_logger.warning(
                        "Eval %d received non-finite thickness vector %s; returning large penalty.",
                        eval_idx,
                        repr(x_layer3),
                    )
                    return 1e6

                # Create isolated config copy - use Pydantic's model_copy if available for better isolation
                # Otherwise fall back to deepcopy
                if hasattr(optimized_config, 'model_copy'):
                    config_layer3 = optimized_config.model_copy(deep=True)
                else:
                    config_layer3 = copy.deepcopy(optimized_config)
                # CRITICAL: Always enable turbulence coupling for consistent physics
                if hasattr(config_layer3, 'combustion') and hasattr(config_layer3.combustion, 'efficiency'):
                    config_layer3.combustion.efficiency.use_turbulence_coupling = True
                idx_param = 0
                chosen_thicknesses: list[float] = []

                # Quantize thicknesses to a practical resolution (0.05 mm) so the
                # local optimizer does not waste iterations on micrometer‑scale
                # tweaks that are meaningless at the model fidelity.
                quantum_m = 0.00005  # 0.05 mm

                if ablative_cfg and ablative_cfg.enabled:
                    t_abl = float(np.clip(x_layer3[idx_param], layer3_bounds[idx_param][0], layer3_bounds[idx_param][1]))
                    t_abl = float(np.round(t_abl / quantum_m) * quantum_m)
                    config_layer3.ablative_cooling.initial_thickness = t_abl
                    chosen_thicknesses.append(t_abl)
                    idx_param += 1

                if graphite_cfg and graphite_cfg.enabled:
                    t_gra = float(
                        np.clip(x_layer3[idx_param], layer3_bounds[idx_param][0], layer3_bounds[idx_param][1])
                    )
                    t_gra = float(np.round(t_gra / quantum_m) * quantum_m)
                    config_layer3.graphite_insert.initial_thickness = t_gra
                    chosen_thicknesses.append(t_gra)

                # Verify config was updated correctly before creating runner
                if ablative_cfg and ablative_cfg.enabled:
                    if abs(config_layer3.ablative_cooling.initial_thickness - chosen_thicknesses[0]) > 1e-9:
                        layer3_logger.warning(
                            "Eval %03d: Config ablative thickness mismatch! Expected %.6f, got %.6f",
                            eval_idx,
                            chosen_thicknesses[0],
                            config_layer3.ablative_cooling.initial_thickness,
                        )
                if graphite_cfg and graphite_cfg.enabled:
                    gra_idx = 0 if not ablative_cfg or not ablative_cfg.enabled else 1
                    if abs(config_layer3.graphite_insert.initial_thickness - chosen_thicknesses[gra_idx]) > 1e-9:
                        layer3_logger.warning(
                            "Eval %03d: Config graphite thickness mismatch! Expected %.6f, got %.6f",
                            eval_idx,
                            chosen_thicknesses[gra_idx],
                            config_layer3.graphite_insert.initial_thickness,
                        )

                # Check cache before running the expensive time solver.
                cache_key = (tuple(chosen_thicknesses), n_eval_points)
                if cache_key in _objective_cache:
                    obj_cached = float(_objective_cache[cache_key])
                    eval_time = time.time() - eval_start
                    layer3_logger.info(
                        "Eval %03d (cached): thicknesses=%s mm, n_pts=%s, obj=%.3f, dt=%.2fs",
                        eval_idx,
                        [t * 1000.0 for t in chosen_thicknesses],
                        n_eval_points,
                        obj_cached,
                        eval_time,
                    )
                    return obj_cached

                # CRITICAL: Create a fresh PintleEngineRunner with the updated config for each evaluation
                # This ensures the runner's internal state (solver, geometry, etc.) reflects the new thicknesses
                runner_layer3 = PintleEngineRunner(config_layer3)
                
                # Verify runner is using the correct config thicknesses
                if ablative_cfg and ablative_cfg.enabled:
                    runner_abl_thick = runner_layer3.config.ablative_cooling.initial_thickness
                    if abs(runner_abl_thick - chosen_thicknesses[0]) > 1e-9:
                        layer3_logger.error(
                            "Eval %03d: Runner config ablative thickness mismatch! Expected %.6f, got %.6f",
                            eval_idx,
                            chosen_thicknesses[0],
                            runner_abl_thick,
                        )
                if graphite_cfg and graphite_cfg.enabled:
                    gra_idx = 0 if not ablative_cfg or not ablative_cfg.enabled else 1
                    runner_gra_thick = runner_layer3.config.graphite_insert.initial_thickness
                    if abs(runner_gra_thick - chosen_thicknesses[gra_idx]) > 1e-9:
                        layer3_logger.error(
                            "Eval %03d: Runner config graphite thickness mismatch! Expected %.6f, got %.6f",
                            eval_idx,
                            chosen_thicknesses[gra_idx],
                            runner_gra_thick,
                        )
                
                # Downsample arrays if using coarse grid for faster evaluation
                # Downsample arrays if using coarse grid for faster evaluation
                if n_eval_points is not None and n_eval_points < n_time_points:
                    eval_time_array = downsample_array(time_array, n_eval_points)
                    eval_P_tank_O = downsample_array(P_tank_O_array, n_eval_points)
                    eval_P_tank_F = downsample_array(P_tank_F_array, n_eval_points)
                else:
                    # Use full resolution arrays
                    eval_time_array = time_array
                    eval_P_tank_O = P_tank_O_array
                    eval_P_tank_F = P_tank_F_array
                
                # CRITICAL: Use same solver settings as ui_app.py for consistency
                # During optimization, we use fully-coupled solver to match final results
                results_layer3 = runner_layer3.evaluate_arrays_with_time(
                    eval_time_array,
                    eval_P_tank_O,
                    eval_P_tank_F,
                    track_ablative_geometry=True,  # Enable ablative geometry tracking
                    use_coupled_solver=True,  # Use fully-coupled solver (matches ui_app.py and final analysis)
                )

                recession_chamber = float(np.max(np.atleast_1d(results_layer3.get("recession_chamber", [0.0]))))
                recession_throat = float(np.max(np.atleast_1d(results_layer3.get("recession_throat", [0.0]))))

                # ------------------------------------------------------------------
                # Re-check key Layer 2 burn metrics for this candidate
                # ------------------------------------------------------------------
                # Total impulse (use eval_time_array for integration)
                thrust_hist = np.atleast_1d(results_layer3.get("F", np.zeros_like(eval_time_array)))
                n_eval = len(eval_time_array)
                if thrust_hist.size > n_eval:
                    thrust_hist = thrust_hist[:n_eval]
                thrust_hist = np.nan_to_num(
                    thrust_hist,
                    nan=0.0,
                    posinf=0.0,
                    neginf=0.0,
                )
                total_impulse = float(np.trapezoid(thrust_hist, eval_time_array[: thrust_hist.size]))


                impulse_penalty = 0.0
                if baseline_impulse > 0.0 and total_impulse < baseline_impulse:
                    # Penalize fractional loss of impulse relative to baseline.
                    # Increased scale from 1e3 to 1e4 to make impulse preservation competitive
                    # with recession penalties while still prioritizing safety.
                    frac_loss = (baseline_impulse - total_impulse) / baseline_impulse
                    impulse_penalty = max(0.0, frac_loss) * 1e4

                # Stability penalty (discourage worse-than-baseline stability)
                stability_penalty = 0.0
                try:
                    if "chugging_stability_margin" in results_layer3:
                        chug = np.nan_to_num(
                            np.atleast_1d(results_layer3["chugging_stability_margin"]),
                            nan=0.0,
                            posinf=0.0,
                            neginf=0.0,
                        )
                        min_stability = float(np.min(chug))
                    elif "stability_score" in results_layer3:
                        stab = np.nan_to_num(
                            np.atleast_1d(results_layer3["stability_score"]),
                            nan=0.0,
                            posinf=0.0,
                            neginf=0.0,
                        )
                        min_stability = float(np.min(stab))
                    else:
                        min_stability = None

                    if baseline_min_stability is not None and min_stability is not None:
                        # Penalize any drop below the baseline minimum stability.
                        # Increased scale from 5e2 to 5e3 to make stability preservation competitive
                        # with recession penalties while still prioritizing safety.
                        if min_stability < baseline_min_stability:
                            stability_penalty = (baseline_min_stability - min_stability) * 5e3
                except Exception:
                    # If stability cannot be evaluated, don't add a penalty but
                    # also don't crash the objective.
                    pass

                # Check if recession exceeds a safe margin of the thickness.
                # We require recession to stay below (thickness / margin_factor),
                # e.g. with margin_factor=1.25 → max_recession <= 0.8 * thickness.
                idx_param = 0
                recession_penalty = 0.0
                margin_factor = 1.25  # 25% thickness margin over max recession
                # Reduced from 1e5 to 5e4 to balance with impulse/stability penalties.
                # Recession safety is still prioritized but not completely dominant.
                penalty_scale = 5e4   # Strongly discourage unsafe solutions

                if ablative_cfg and ablative_cfg.enabled:
                    thickness = x_layer3[idx_param]
                    required_thickness = recession_chamber * margin_factor
                    if required_thickness > 0.0 and thickness < required_thickness:
                        deficit = required_thickness - thickness
                        frac = deficit / required_thickness
                        recession_penalty += penalty_scale * frac * frac
                    idx_param += 1

                if graphite_cfg and graphite_cfg.enabled:
                    thickness = x_layer3[idx_param]
                    required_thickness = recession_throat * margin_factor
                    if required_thickness > 0.0 and thickness < required_thickness:
                        deficit = required_thickness - thickness
                        frac = deficit / required_thickness
                        recession_penalty += penalty_scale * frac * frac

                # Objective: minimize total thickness (proxy for mass) while
                # honouring the recession safety margin and preserving the
                # Layer 2 burn quality (impulse, stability).
                total_thickness = float(np.sum(x_layer3))
                obj = (
                    total_thickness * 1000.0  # thickness in mm for scaling
                    + recession_penalty
                    + impulse_penalty
                    + stability_penalty
                )

                # Optional: stream objective history to external callback (e.g., UI plot)
                if objective_callback is not None:
                    try:
                        best_obj = float(layer3_state["best_objective"])
                        if obj < best_obj:
                            best_obj = obj
                            layer3_state["best_objective"] = best_obj
                        objective_callback(eval_idx, float(obj), float(best_obj))
                    except Exception:
                        # Never let UI/consumer callback break the optimizer loop
                        pass

                eval_time = time.time() - eval_start
                # Store in cache and log full diagnostics.
                _objective_cache[cache_key] = obj

                layer3_logger.info(
                    "Eval %03d: thicknesses=%s mm, recession (chamber/throat)=%.3f/%.3f mm, "
                    "penalties: recession=%.3f, impulse=%.3f, stability=%.3f, "
                    "obj=%.3f, dt=%.2fs",
                    eval_idx,
                    [t * 1000.0 for t in chosen_thicknesses],
                    recession_chamber * 1000.0,
                    recession_throat * 1000.0,
                    recession_penalty,
                    impulse_penalty,
                    stability_penalty,
                    obj,
                    eval_time,
                )

                return obj
            except Exception as exc:
                eval_time = time.time() - eval_start
                layer3_logger.error("Exception in eval %03d (%.2fs): %r", eval_idx, eval_time, exc)
                import traceback

                layer3_logger.error(traceback.format_exc())
                return 1e6

        # Optimize Layer 3 using the selected method
        try:
            if optimization_method == "gradient":
                # ------------------------------------------------------------------
                # Fast Gradient Descent / Binary Search (exploits monotonicity)
                # ------------------------------------------------------------------
                # Key insight: thickness and recession have a monotonic relationship.
                # More thickness = material lasts longer = less recession ratio.
                # So we can use a simple bisection/gradient approach to find the
                # minimum thickness that satisfies the margin constraint.
                # ------------------------------------------------------------------
                layer3_logger.info(
                    "Starting Layer 3 optimization using GRADIENT DESCENT (fast mode) with %d dims...",
                    len(layer3_x0),
                )
                layer3_logger.info(
                    "This exploits the monotonic relationship: more thickness = less recession ratio."
                )
                
                margin_factor = 1.25  # 25% margin (thickness >= recession * 1.25)
                
                def evaluate_thickness_feasibility(thicknesses: np.ndarray) -> Tuple[bool, Dict[str, float]]:
                    """
                    Evaluate if given thicknesses meet the margin requirement.
                    Returns (is_feasible, recession_data).
                    """
                    # Create config with these thicknesses
                    if hasattr(optimized_config, 'model_copy'):
                        config_test = optimized_config.model_copy(deep=True)
                    else:
                        config_test = copy.deepcopy(optimized_config)
                    
                    if hasattr(config_test, 'combustion') and hasattr(config_test.combustion, 'efficiency'):
                        config_test.combustion.efficiency.use_turbulence_coupling = True
                    
                    idx = 0
                    if ablative_cfg and ablative_cfg.enabled:
                        config_test.ablative_cooling.initial_thickness = float(thicknesses[idx])
                        idx += 1
                    if graphite_cfg and graphite_cfg.enabled:
                        config_test.graphite_insert.initial_thickness = float(thicknesses[idx])
                    
                    # Run simulation
                    runner_test = PintleEngineRunner(config_test)
                    results_test = runner_test.evaluate_arrays_with_time(
                        time_array,
                        P_tank_O_array,
                        P_tank_F_array,
                        track_ablative_geometry=True,
                        use_coupled_solver=True,
                    )
                    
                    recession_chamber = float(np.max(np.atleast_1d(results_test.get("recession_chamber", [0.0]))))
                    recession_throat = float(np.max(np.atleast_1d(results_test.get("recession_throat", [0.0]))))
                    
                    # Check feasibility for each component
                    feasible = True
                    recession_data = {
                        "recession_chamber": recession_chamber,
                        "recession_throat": recession_throat,
                    }
                    
                    idx = 0
                    if ablative_cfg and ablative_cfg.enabled:
                        required_abl = recession_chamber * margin_factor
                        recession_data["required_ablative"] = required_abl
                        if thicknesses[idx] < required_abl:
                            feasible = False
                        idx += 1
                    
                    if graphite_cfg and graphite_cfg.enabled:
                        required_gra = recession_throat * margin_factor
                        recession_data["required_graphite"] = required_gra
                        if thicknesses[idx] < required_gra:
                            feasible = False
                    
                    return feasible, recession_data
                
                # Step 1: Evaluate at lower bound to get baseline recession
                lower_bounds = np.array([b[0] for b in layer3_bounds])
                upper_bounds = np.array([b[1] for b in layer3_bounds])
                
                layer3_logger.info("Step 1: Evaluating recession at lower bounds...")
                layer3_state["eval_index"] += 1
                _, recession_at_min = evaluate_thickness_feasibility(lower_bounds)
                
                layer3_logger.info(
                    "Recession at min thickness: chamber=%.3f mm, throat=%.3f mm",
                    recession_at_min["recession_chamber"] * 1000,
                    recession_at_min["recession_throat"] * 1000,
                )
                
                # Step 2: Calculate initial estimate based on recession at minimum
                # Since recession is roughly independent of thickness (it depends on heat flux),
                # we can estimate: required_thickness ≈ recession * margin_factor
                initial_estimate = []
                idx = 0
                if ablative_cfg and ablative_cfg.enabled:
                    est_abl = recession_at_min["recession_chamber"] * margin_factor * 1.1  # 10% extra safety
                    est_abl = float(np.clip(est_abl, lower_bounds[idx], upper_bounds[idx]))
                    initial_estimate.append(est_abl)
                    idx += 1
                if graphite_cfg and graphite_cfg.enabled:
                    est_gra = recession_at_min["recession_throat"] * margin_factor * 1.1
                    est_gra = float(np.clip(est_gra, lower_bounds[idx], upper_bounds[idx]))
                    initial_estimate.append(est_gra)
                
                initial_estimate = np.array(initial_estimate)
                layer3_logger.info(
                    "Initial thickness estimate: %s mm",
                    [t * 1000 for t in initial_estimate],
                )
                
                # Step 3: Binary search refinement for each dimension independently
                # This works because thickness dimensions are largely independent
                best_thicknesses = initial_estimate.copy()
                
                for dim_idx in range(len(layer3_bounds)):
                    lo = lower_bounds[dim_idx]
                    hi = upper_bounds[dim_idx]
                    
                    dim_name = "ablative" if dim_idx == 0 and ablative_cfg and ablative_cfg.enabled else "graphite"
                    layer3_logger.info("Binary search for %s thickness...", dim_name)
                    
                    # Binary search to find minimum feasible thickness
                    for iteration in range(6):  # ~6 iterations gives <1% precision
                        mid = (lo + hi) / 2
                        test_thicknesses = best_thicknesses.copy()
                        test_thicknesses[dim_idx] = mid
                        
                        layer3_state["eval_index"] += 1
                        eval_idx = int(layer3_state["eval_index"])
                        
                        feasible, recession_data = evaluate_thickness_feasibility(test_thicknesses)
                        
                        # Calculate objective for callback
                        obj = float(np.sum(test_thicknesses)) * 1000  # mm
                        if not feasible:
                            obj += 1e4  # Penalty for infeasible
                        
                        if objective_callback is not None:
                            best_obj = float(layer3_state["best_objective"])
                            if obj < best_obj:
                                best_obj = obj
                                layer3_state["best_objective"] = best_obj
                            objective_callback(eval_idx, obj, best_obj)
                        
                        layer3_logger.info(
                            "Eval %03d: %s=%.3f mm, feasible=%s, recession=%.3f mm",
                            eval_idx,
                            dim_name,
                            mid * 1000,
                            feasible,
                            (recession_data.get("recession_chamber", 0) if dim_name == "ablative" 
                             else recession_data.get("recession_throat", 0)) * 1000,
                        )
                        
                        if feasible:
                            hi = mid  # Can try thinner
                            best_thicknesses[dim_idx] = mid
                        else:
                            lo = mid  # Need thicker
                    
                    # Final value with small safety margin
                    best_thicknesses[dim_idx] = hi * 1.02  # 2% extra margin
                    best_thicknesses[dim_idx] = float(np.clip(
                        best_thicknesses[dim_idx], 
                        lower_bounds[dim_idx], 
                        upper_bounds[dim_idx]
                    ))
                
                layer3_logger.info(
                    "Gradient descent finished: optimal thicknesses = %s mm",
                    [t * 1000 for t in best_thicknesses],
                )
                
                # Create result object
                class GradientResult:
                    def __init__(self, x, fun):
                        self.x = x
                        self.fun = fun
                        self.success = True
                
                final_obj = float(np.sum(best_thicknesses)) * 1000
                result_layer3 = GradientResult(best_thicknesses, final_obj)
                
            elif use_cma and optimization_method != "de":
                # ------------------------------------------------------------------
                # CMA-ES optimization (preferred: better exploration for small dimensions)
                # ------------------------------------------------------------------
                layer3_logger.info(
                    "Starting Layer 3 optimization using CMA-ES with %d dims...",
                    len(layer3_x0),
                )
                
                # Calculate initial step size: ~15% of the range for good exploration
                span = np.array([hi - lo for lo, hi in layer3_bounds])
                sigma0 = float(np.mean(span) * 0.15)  # 15% of average range
                if not np.isfinite(sigma0) or sigma0 <= 0:
                    sigma0 = 0.002  # Default: 2mm
                
                # Population size: CMA-ES default is 4+floor(3*ln(n)), but for 1-2D we want more exploration
                # Use popsize ~8-12 for better exploration in small dimensions
                n_dims = len(layer3_x0)
                cma_popsize = max(8, 4 + int(3 * np.log(n_dims)))
                
                # Budget: ~60-80 evaluations (reasonable for 3-4s per eval)
                # This gives CMA-ES ~8-10 generations to explore and converge
                cma_budget = min(80, cma_popsize * 10)
                
                # Per-dimension scaling (larger ranges get larger step sizes)
                cma_stds = span / np.mean(span) if np.mean(span) > 0 else np.ones(n_dims)
                
                # Prepare bounds for CMA
                lower_bounds = np.array([b[0] for b in layer3_bounds])
                upper_bounds = np.array([b[1] for b in layer3_bounds])
                
                # CMA-ES options
                opts = {
                    "bounds": [lower_bounds.tolist(), upper_bounds.tolist()],
                    "popsize": cma_popsize,
                    "maxiter": 1000,  # High limit, we'll stop based on budget
                    "verb_disp": 0,
                    "verb_log": 0,
                    "tolx": 1e-6,
                    "tolfun": 1e-4,
                    "tolstagnation": 20,
                    "ftarget": -np.inf,
                    "seed": 42,  # Deterministic
                }
                if n_dims > 1:
                    opts["CMA_stds"] = cma_stds.tolist()
                
                # Initialize CMA-ES
                x0_clamped = np.clip(layer3_x0, lower_bounds, upper_bounds)
                es = cma.CMAEvolutionStrategy(x0_clamped.tolist(), sigma0, opts)
                
                # CMA-ES uses coarse 25-point grid for fast global search
                n_coarse_points = 25
                layer3_logger.info(
                    "CMA-ES will use coarse %d-point grid (vs full %d-point grid) for ~8x speedup",
                    n_coarse_points,
                    n_time_points,
                )
                
                best_x_cma = x0_clamped.copy()
                best_f_cma = float(layer3_objective(best_x_cma, n_eval_points=n_coarse_points))
                evals_used = 1
                
                # Run CMA-ES iterations
                while not es.stop() and evals_used < cma_budget:
                    candidates = es.ask()
                    fitnesses = []
                    
                    # Limit candidates if we're close to budget
                    remaining_budget = cma_budget - evals_used
                    if remaining_budget < len(candidates):
                        candidates = candidates[:remaining_budget]
                    
                    for candidate in candidates:
                        x_candidate = np.asarray(candidate, dtype=float)
                        # Ensure within bounds (CMA handles this, but double-check)
                        x_candidate = np.clip(x_candidate, lower_bounds, upper_bounds)
                        obj_val = float(layer3_objective(x_candidate, n_eval_points=n_coarse_points))
                        fitnesses.append(obj_val)
                        evals_used += 1
                        
                        # Track best
                        if obj_val < best_f_cma:
                            best_f_cma = obj_val
                            best_x_cma = x_candidate.copy()
                    
                    # Tell CMA-ES about all evaluated candidates
                    es.tell(candidates, fitnesses)
                    
                    # Log progress every few generations
                    if evals_used % (cma_popsize * 2) == 0:
                        layer3_logger.info(
                            "CMA-ES progress: evals=%d/%d, best_obj=%.6f, sigma=%.6f",
                            evals_used,
                            cma_budget,
                            best_f_cma,
                            es.sigma,
                        )
                
                layer3_logger.info(
                    "CMA-ES finished: final_obj=%.6f, evals=%d, sigma=%.6f",
                    best_f_cma,
                    evals_used,
                    es.sigma,
                )
                
                # Final local polish with L-BFGS-B on full 200-point grid
                layer3_logger.info(
                    "Starting final local polish with L-BFGS-B on full %d-point grid...",
                    n_time_points,
                )
                
                # Create wrapper that uses full resolution
                def layer3_objective_full_res(x):
                    return layer3_objective(x, n_eval_points=None)
                
                result_layer3 = scipy_minimize(
                    layer3_objective_full_res,
                    best_x_cma,
                    method="L-BFGS-B",
                    bounds=layer3_bounds,
                    options={
                        "maxiter": 10,
                        "maxfun": 15,
                        "ftol": 1e-4,
                    },
                )
                
                # Use the better of CMA-ES best or L-BFGS-B result
                if result_layer3.success and np.isfinite(result_layer3.fun):
                    if result_layer3.fun < best_f_cma:
                        best_x_cma = np.asarray(result_layer3.x, dtype=float)
                        best_f_cma = float(result_layer3.fun)
                        layer3_logger.info(
                            "L-BFGS-B polish improved: final_obj=%.6f",
                            best_f_cma,
                        )
                    else:
                        layer3_logger.info(
                            "L-BFGS-B polish did not improve (CMA-ES best was better)"
                        )
                
                # Create result object compatible with rest of code
                class CMA_Result:
                    def __init__(self, x, fun):
                        self.x = x
                        self.fun = fun
                        self.success = True
                
                result_layer3 = CMA_Result(best_x_cma, best_f_cma)
                
            else:
                # ------------------------------------------------------------------
                # Fallback: DE + grid search + L-BFGS-B (original approach)
                # Used when optimization_method="de" or CMA-ES is not available
                # ------------------------------------------------------------------
                layer3_logger.info(
                    "Using differential_evolution with %d dims (method=%s, cma_available=%s)...",
                    len(layer3_x0),
                    optimization_method,
                    use_cma,
                )
                de_result = differential_evolution(
                    layer3_objective,
                    layer3_bounds,
                    maxiter=3,
                    popsize=2,
                    polish=False,
                    tol=0.3,
                )
                layer3_logger.info(
                    "Global search finished: de_obj=%.6f, nfev=%s",
                    float(de_result.fun) if np.isfinite(de_result.fun) else float("nan"),
                    getattr(de_result, "nfev", "N/A"),
                )

                best_local_x = np.asarray(de_result.x, dtype=float)
                best_local_obj = float(de_result.fun) if np.isfinite(de_result.fun) else float("inf")

                # Coarse local sweep
                coarse_step_m = 0.0002  # 0.2 mm
                offsets = [-2, -1, 0, 1, 2]

                for delta_indices in itertools.product(offsets, repeat=len(layer3_bounds)):
                    delta_vec = np.asarray(delta_indices, dtype=float) * coarse_step_m
                    candidate_x = best_local_x + delta_vec
                    for i, (lo, hi) in enumerate(layer3_bounds):
                        candidate_x[i] = float(np.clip(candidate_x[i], lo, hi))

                    obj_val = float(layer3_objective(candidate_x))
                    if obj_val < best_local_obj:
                        best_local_obj = obj_val
                        best_local_x = candidate_x

                layer3_logger.info(
                    "Coarse local sweep finished: best_obj=%.6f at x=%s mm",
                    best_local_obj,
                    [float(v) * 1000.0 for v in np.atleast_1d(best_local_x)],
                )

                layer3_logger.info("Starting Layer 3 local optimization using L-BFGS-B...")
                result_layer3 = scipy_minimize(
                    layer3_objective,
                    best_local_x,
                    method="L-BFGS-B",
                    bounds=layer3_bounds,
                    options={
                        "maxiter": 12,
                        "maxfun": 25,
                        "ftol": 1e-3,
                    },
                )
                layer3_logger.info(
                    "Local optimization finished: success=%s, final_obj=%.6f, nit=%s, nfev=%s",
                    result_layer3.success,
                    float(result_layer3.fun) if np.isfinite(result_layer3.fun) else float("nan"),
                    getattr(result_layer3, "nit", "N/A"),
                    getattr(result_layer3, "nfev", "N/A"),
                )

            # Update config with optimized thicknesses
            idx_param = 0
            if ablative_cfg and ablative_cfg.enabled:
                optimized_config.ablative_cooling.initial_thickness = float(
                    np.clip(result_layer3.x[idx_param], layer3_bounds[idx_param][0], layer3_bounds[idx_param][1])
                )
                thermal_results["optimized_ablative_thickness"] = optimized_config.ablative_cooling.initial_thickness
                update_progress(
                    "Layer 3: Burn Analysis Optimization",
                    0.70,
                    (
                        f"✓ Optimized ablative: "
                        f"{optimized_config.ablative_cooling.initial_thickness*1000:.2f}mm "
                    ),
                )
                layer3_logger.info(
                    "Optimized ablative thickness: %.3f mm",
                    optimized_config.ablative_cooling.initial_thickness * 1000.0,
                )
                idx_param += 1

            if graphite_cfg and graphite_cfg.enabled:
                optimized_config.graphite_insert.initial_thickness = float(
                    np.clip(result_layer3.x[idx_param], layer3_bounds[idx_param][0], layer3_bounds[idx_param][1])
                )
                thermal_results["optimized_graphite_thickness"] = optimized_config.graphite_insert.initial_thickness
                update_progress(
                    "Layer 3: Burn Analysis Optimization",
                    0.72,
                    (
                        f"✓ Optimized graphite: "
                        f"{optimized_config.graphite_insert.initial_thickness*1000:.2f}mm "
                    ),
                )
                layer3_logger.info(
                    "Optimized graphite thickness: %.3f mm",
                    optimized_config.graphite_insert.initial_thickness * 1000.0,
                )
        except Exception as e:
            layer3_logger.error("Layer 3 optimization failed: %r", e)
            import traceback

            layer3_logger.error(traceback.format_exc())
            update_progress(
                "Layer 3: Burn Analysis Optimization",
                0.72,
                f"⚠️ Layer 3 optimization failed: {e}, using current values",
            )

        # Re-run time series with optimized thermal protection to verify
        update_progress("Layer 3: Burn Analysis", 0.74, "Re-running time series with optimized thermal protection...")
        try:
            # CRITICAL: Ensure ablative and graphite tracking are enabled in config for complete time series
            if ablative_cfg and ablative_cfg.enabled:
                optimized_config.ablative_cooling.track_geometry_evolution = True
            if graphite_cfg and graphite_cfg.enabled:
                # Ensure graphite insert is properly configured for tracking
                if hasattr(optimized_config.graphite_insert, 'enabled'):
                    optimized_config.graphite_insert.enabled = True
            
            # CRITICAL: Always enable turbulence coupling for consistent physics
            if hasattr(optimized_config, 'combustion') and hasattr(optimized_config.combustion, 'efficiency'):
                optimized_config.combustion.efficiency.use_turbulence_coupling = True
            
            # CRITICAL: Create a fresh PintleEngineRunner with the optimized config
            # This ensures the runner uses the final optimized thicknesses, not any cached values
            optimized_runner_updated = PintleEngineRunner(optimized_config)
            
            # Verify runner has correct optimized thicknesses
            if ablative_cfg and ablative_cfg.enabled:
                runner_abl = optimized_runner_updated.config.ablative_cooling.initial_thickness
                config_abl = optimized_config.ablative_cooling.initial_thickness
                if abs(runner_abl - config_abl) > 1e-9:
                    layer3_logger.error(
                        "Post-opt runner ablative thickness mismatch! Config: %.6f, Runner: %.6f",
                        config_abl,
                        runner_abl,
                    )
            if graphite_cfg and graphite_cfg.enabled:
                runner_gra = optimized_runner_updated.config.graphite_insert.initial_thickness
                config_gra = optimized_config.graphite_insert.initial_thickness
                if abs(runner_gra - config_gra) > 1e-9:
                    layer3_logger.error(
                        "Post-opt runner graphite thickness mismatch! Config: %.6f, Runner: %.6f",
                        config_gra,
                        runner_gra,
                    )
            
            # CRITICAL: Re-run with all tracking features enabled for complete time series analysis
            # This ensures we get recession rates, cumulative recession, L*, throat area evolution, etc.
            full_time_results_updated = optimized_runner_updated.evaluate_arrays_with_time(
                time_array,
                P_tank_O_array,
                P_tank_F_array,
                track_ablative_geometry=True,  # Enable ablative geometry tracking (L*, volume, recession)
                use_coupled_solver=True,  # Use fully-coupled solver for accurate results
            )
            updated_time_results = full_time_results_updated
            thermal_results["max_recession_chamber"] = float(
                np.max(np.atleast_1d(full_time_results_updated.get("recession_chamber", [0.0])))
            )
            thermal_results["max_recession_throat"] = float(
                np.max(np.atleast_1d(full_time_results_updated.get("recession_throat", [0.0])))
            )
            layer3_logger.info(
                "Post-optimization max recession (chamber / throat): "
                "%.3f mm / %.3f mm",
                thermal_results["max_recession_chamber"] * 1000.0,
                thermal_results["max_recession_throat"] * 1000.0,
            )

            # Final safety check: mark thermal_protection_valid only if the
            # optimized thicknesses satisfy the margin criteria against the
            # post-optimization recession histories.
            margin_factor = 1.25
            ablative_ok = True
            graphite_ok = True

            if ablative_cfg and ablative_cfg.enabled:
                t_abl = optimized_config.ablative_cooling.initial_thickness
                required_abl = thermal_results["max_recession_chamber"] * margin_factor
                ablative_ok = t_abl >= required_abl

            if graphite_cfg and graphite_cfg.enabled:
                t_gra = optimized_config.graphite_insert.initial_thickness
                required_gra = thermal_results["max_recession_throat"] * margin_factor
                graphite_ok = t_gra >= required_gra

            thermal_results["ablative_adequate"] = bool(ablative_ok)
            thermal_results["graphite_adequate"] = bool(graphite_ok)
            thermal_results["thermal_protection_valid"] = bool(ablative_ok and graphite_ok)
        except Exception as e:
            layer3_logger.error("Re-evaluation after optimization failed: %r", e)
            import traceback

            layer3_logger.error(traceback.format_exc())
            update_progress(
                "Layer 3: Burn Analysis",
                0.74,
                f"⚠️ Re-evaluation failed: {e}, using original results",
            )

        status_msg = (
            "Completed | Ablative {:.2f} mm, Graphite {:.2f} mm, "
            "Max recession chamber {:.2f} mm, throat {:.2f} mm "
            "(valid: {}) (see {} for detailed log)".format(
                (optimized_config.ablative_cooling.initial_thickness * 1000)
                if ablative_cfg and ablative_cfg.enabled
                else 0.0,
                (optimized_config.graphite_insert.initial_thickness * 1000)
                if graphite_cfg and graphite_cfg.enabled
                else 0.0,
                (thermal_results.get("max_recession_chamber") or 0.0) * 1000,
                (thermal_results.get("max_recession_throat") or 0.0) * 1000,
                thermal_results.get("thermal_protection_valid", False),
                log_file_path,
            )
        )
        log_status("Layer 3", status_msg)

    # CRITICAL: Final verification - ensure optimized_config has the optimized thicknesses
    # This is the authoritative source that will be returned and saved to session state
    if ablative_cfg and ablative_cfg.enabled:
        if "optimized_ablative_thickness" in thermal_results:
            optimized_config.ablative_cooling.initial_thickness = thermal_results["optimized_ablative_thickness"]
            layer3_logger.info(
                "Final optimized ablative thickness in config: %.3f mm",
                optimized_config.ablative_cooling.initial_thickness * 1000.0,
            )
    
    if graphite_cfg and graphite_cfg.enabled:
        if "optimized_graphite_thickness" in thermal_results:
            optimized_config.graphite_insert.initial_thickness = thermal_results["optimized_graphite_thickness"]
            layer3_logger.info(
                "Final optimized graphite thickness in config: %.3f mm",
                optimized_config.graphite_insert.initial_thickness * 1000.0,
            )

    layer3_logger.info("Layer 3 optimization complete. Log saved to: %s", log_file_path)
    # Clean up handlers so repeated calls don't leak file descriptors
    layer3_logger.handlers.clear()

    return optimized_config, updated_time_results, thermal_results

