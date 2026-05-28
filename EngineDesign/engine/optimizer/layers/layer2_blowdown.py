"""
Layer 2 — Pure Blowdown mode.

Optimizes initial LOX/fuel tank pressures **and** initial propellant masses (4D)
using **CMA-ES** (bounded, derivative-free) on a coarse time grid, then one
full-resolution evaluation for export.

Pressure-vs-time emerges from coupled ullage physics — the same path as
Time Series Analysis > Pure Blowdown: ``simulate_coupled_blowdown`` plus
``engine.pipeline.timeseries_engine_eval.eval_runner_timeseries_like_api`` for the
full performance trace (including flameout masking when mass histories exist).

Decision variables:
  x = [P_lox_initial_Pa, P_fuel_initial_Pa, m_lox_kg, m_fuel_kg]

Initial mass matters because it sets the ullage volume in each tank, which directly
controls the pressure-decay profile through the polytropic expansion.
"""

from __future__ import annotations

import copy
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
from scipy.integrate import cumulative_trapezoid

from copv.blowdown_solver import simulate_coupled_blowdown
from engine.core.runner import PintleEngineRunner
from engine.optimizer.layers.layer2_pressure import (
    LAYER2_BURN_TIME_SOFT_SCALE,
    LAYER2_BURN_DURATION_SCALE,
    N2_Z_LOOKUP_CSV,
    calculate_required_impulse_from_mass,
    effective_burn_time_for_layer2_objective,
    active_burn_prefix_len,
    injector_dp_ratio_penalty_from_results,
)
from engine.pipeline.config_schemas import (
    PintleEngineConfig,
    PressureCurvesConfig,
    PressureSegmentConfig,
)
from engine.pipeline.timeseries_engine_eval import (
    apply_propellant_depletion_mask_to_runner_results,
    eval_runner_timeseries_like_api,
)

N_SEGMENTS_TRACE = 8
PSI_TO_PA = 6894.76


def _trace_to_segments(P_tank: np.ndarray, n_segments: int) -> List[Dict[str, Any]]:
    """Piecewise-linear segments approximating a pressure trace (for YAML export)."""
    n = len(P_tank)
    if n < 2:
        return [
            {
                "length_ratio": 1.0,
                "type": "linear",
                "start_pressure": float(P_tank[0]),
                "end_pressure": float(P_tank[0]),
                "k": None,
            }
        ]
    segments: List[Dict[str, Any]] = []
    for i in range(n_segments):
        t0 = int(round(i * (n - 1) / n_segments))
        t1 = int(round((i + 1) * (n - 1) / n_segments)) if i < n_segments - 1 else n - 1
        p_start = float(P_tank[t0])
        p_end = float(P_tank[t1])
        if p_end > p_start:
            p_end = p_start * 0.999
        segments.append(
            {
                "length_ratio": 1.0 / n_segments,
                "type": "linear",
                "start_pressure": p_start,
                "end_pressure": p_end,
                "k": None,
            }
        )
    return segments


def _compute_penalties_from_results(
    results_layer2: Dict[str, Any],
    time_hist: np.ndarray,
    peak_thrust: float,
    target_apogee_m: float,
    rocket_dry_mass_kg: float,
    max_lox_tank_capacity_kg: float,
    max_fuel_tank_capacity_kg: float,
    target_burn_time: float,
    optimal_of_ratio: Optional[float],
    min_stability_margin: Optional[float],
    loaded_lox_kg: float,
    loaded_fuel_kg: float,
    disable_impulse_requirement: bool = False,
) -> Tuple[float, Dict[str, float]]:
    """
    Same penalty structure as `layer2_pressure.layer2_objective` (impulse, burn time,
    stability, O/F, Pc, injector ΔP/Pc band), except **capacity**: only **overfull**
    tanks are penalized (loaded propellant mass above physical max). Partial fill is free.

    COPV and controller penalties are omitted (always 0).
    """
    n_points = len(time_hist)
    thrust_hist = np.atleast_1d(results_layer2.get("F", np.full(n_points, peak_thrust)))
    available_n = min(thrust_hist.shape[0], n_points)
    if available_n < 1:
        return 1e6, {"invalid": 1e6}

    thrust_hist = thrust_hist[:available_n]
    time_hist = time_hist[:available_n]

    finite_thrust_mask = np.isfinite(thrust_hist)
    finite_thrust_ratio = float(np.sum(finite_thrust_mask)) / float(available_n)
    if finite_thrust_ratio < 0.5:
        return 1e6, {"invalid": 1e6}

    mdot_O_hist = np.nan_to_num(
        np.atleast_1d(results_layer2.get("mdot_O", np.zeros(available_n)))[:available_n],
        nan=0.0, posinf=0.0, neginf=0.0,
    )
    mdot_F_hist = np.nan_to_num(
        np.atleast_1d(results_layer2.get("mdot_F", np.zeros(available_n)))[:available_n],
        nan=0.0, posinf=0.0, neginf=0.0,
    )

    # Trim post-burnout tail so zeros don't corrupt averages / validity.
    active_n = active_burn_prefix_len(time_hist, mdot_O_hist, mdot_F_hist, target_burn_time, thrust_hist=thrust_hist)
    active_n = max(2, min(active_n, available_n))
    thrust_hist = thrust_hist[:active_n]
    time_hist = time_hist[:active_n]
    mdot_O_hist = mdot_O_hist[:active_n]
    mdot_F_hist = mdot_F_hist[:active_n]
    finite_thrust_mask = np.isfinite(thrust_hist) & (thrust_hist > 0.0)

    valid_thrust_values = thrust_hist[finite_thrust_mask]
    if len(valid_thrust_values) == 0:
        return 1e6, {"invalid": 1e6}
    avg_thrust = float(np.mean(valid_thrust_values))
    if not np.isfinite(avg_thrust) or avg_thrust <= 0:
        return 1e6, {"invalid": 1e6}

    MR_hist = np.atleast_1d(
        results_layer2.get("MR", np.full(available_n, optimal_of_ratio if optimal_of_ratio else 2.3))
    )
    MR_hist = MR_hist[:active_n]
    finite_MR_mask = np.isfinite(MR_hist) & (MR_hist > 0) & (MR_hist < 100)
    if float(np.sum(finite_MR_mask)) < max(1.0, active_n * 0.5):
        return 1e6, {"invalid": 1e6}

    thrust_hist = np.nan_to_num(thrust_hist, nan=0.0, posinf=1e6, neginf=-1e6)

    total_lox_mass = float(np.trapezoid(mdot_O_hist, time_hist))
    total_fuel_mass = float(np.trapezoid(mdot_F_hist, time_hist))
    total_propellant_mass = total_lox_mass + total_fuel_mass

    effective_burn_time = effective_burn_time_for_layer2_objective(
        time_hist, mdot_O_hist, mdot_F_hist, target_burn_time
    )
    required_impulse = calculate_required_impulse_from_mass(
        target_apogee_m, rocket_dry_mass_kg, total_propellant_mass, effective_burn_time,
    )
    total_impulse = float(np.trapezoid(thrust_hist, time_hist))
    if disable_impulse_requirement:
        impulse_penalty = 0.0
    else:
        impulse_deficit = max(0, required_impulse - total_impulse)
        impulse_penalty = (impulse_deficit / max(required_impulse, 1e-9)) * 20.0

    burn_time_penalty = 0.0
    if total_impulse > 0:
        cumulative_impulse = cumulative_trapezoid(thrust_hist, time_hist, initial=0.0)
        impulse_95 = 0.95 * total_impulse
        idx_95 = int(np.searchsorted(cumulative_impulse, impulse_95, side="right"))
        if idx_95 >= len(time_hist):
            idx_95 = len(time_hist) - 1
        t95 = float(time_hist[idx_95])
        if t95 + 1e-9 < effective_burn_time:
            burn_completion_slack = max(0.0, effective_burn_time - t95)
            burn_time_penalty = (
                burn_completion_slack / max(effective_burn_time, 1e-9)
            ) * LAYER2_BURN_TIME_SOFT_SCALE

    burn_duration_penalty = 0.0
    if target_burn_time > 0:
        utilisation = min(effective_burn_time / target_burn_time, 1.0)
        shortfall = 1.0 - utilisation
        burn_duration_penalty = shortfall * shortfall * LAYER2_BURN_DURATION_SCALE

    # Capacity: only physical overfill (loaded mass > tank max). How full the tank is
    # below capacity does not enter the objective.
    lox_capacity_exceeded = max(0.0, float(loaded_lox_kg) - max_lox_tank_capacity_kg)
    fuel_capacity_exceeded = max(0.0, float(loaded_fuel_kg) - max_fuel_tank_capacity_kg)
    capacity_penalty = 0.0
    if lox_capacity_exceeded > 0:
        capacity_penalty += (lox_capacity_exceeded / max(max_lox_tank_capacity_kg, 1e-9)) * 300.0
    if fuel_capacity_exceeded > 0:
        capacity_penalty += (fuel_capacity_exceeded / max(max_fuel_tank_capacity_kg, 1e-9)) * 300.0

    stability_scores = results_layer2.get("stability_score", None)
    if stability_scores is not None:
        stability_scores = np.nan_to_num(np.atleast_1d(stability_scores), nan=0.0, posinf=0.0, neginf=0.0)
        min_stability = float(np.min(stability_scores))
    else:
        chugging = results_layer2.get("chugging_stability_margin", np.array([1.0]))
        chugging = np.nan_to_num(np.atleast_1d(chugging), nan=0.0, posinf=0.0, neginf=0.0)
        min_stability = max(0.0, min(1.0, (float(np.min(chugging)) - 0.3) * 1.5))

    stability_penalty = 0.0
    if min_stability_margin is not None:
        chugging_margins = results_layer2.get("chugging_stability_margin", np.array([1.0]))
        chugging_margins = np.nan_to_num(np.atleast_1d(chugging_margins), nan=0.0, posinf=0.0, neginf=0.0)
        min_chugging = float(np.min(chugging_margins))
        if min_chugging < min_stability_margin:
            stability_penalty = (min_stability_margin - min_chugging) * 50.0
    else:
        stability_penalty = max(0, 0.7 - min_stability) * 10.0

    of_penalty = 0.0
    if optimal_of_ratio is not None:
        valid_MR_values = MR_hist[finite_MR_mask]
        if len(valid_MR_values) > 0:
            deviations = np.abs(valid_MR_values - optimal_of_ratio) / max(optimal_of_ratio, 1e-9)
            deadband = 0.05
            pointwise_penalties = np.where(
                deviations <= deadband,
                deviations * 1.0,
                deadband * 1.0 + (deviations - deadband) * 20.0,
            )
            mean_penalty = np.mean(pointwise_penalties)
            max_penalty = np.max(pointwise_penalties)
            combined_penalty = 0.4 * mean_penalty + 0.6 * max_penalty
            of_penalty = combined_penalty * 50.0
        else:
            of_penalty = 100.0

    pc_penalty = 0.0
    if "Pc" in results_layer2:
        Pc_hist = np.atleast_1d(results_layer2["Pc"])[:available_n]
        valid_Pc_mask = np.isfinite(Pc_hist) & (Pc_hist > 0)
        valid_Pc = Pc_hist[valid_Pc_mask]
        if len(valid_Pc) > 0:
            Pc_initial = valid_Pc[0]
            if Pc_initial > 0:
                pc_devs = np.abs(valid_Pc - Pc_initial) / Pc_initial
                # Blowdown: large Pc decay is expected; only penalize extreme drift.
                excess = np.maximum(0.0, pc_devs - 0.60)
                if np.any(excess > 0):
                    pc_penalty = float(np.mean(excess)) * 200.0
        else:
            pc_penalty = 100.0

    injector_dp_penalty = injector_dp_ratio_penalty_from_results(
        results_layer2,
        available_n,
        min_delta_p_over_pc=0.15,
        max_delta_p_over_pc=0.50,
        scale=400.0,
    )

    components = {
        "impulse_penalty": float(impulse_penalty),
        "burn_time_penalty": float(burn_time_penalty),
        "burn_duration_penalty": float(burn_duration_penalty),
        "capacity_penalty": float(capacity_penalty),
        "stability_penalty": float(stability_penalty),
        "of_penalty": float(of_penalty),
        "pc_penalty": float(pc_penalty),
        "injector_dp_penalty": float(injector_dp_penalty),
    }
    obj = sum(components.values())
    if not np.isfinite(obj):
        return 1e6, {"invalid": 1e6}
    return float(obj), components


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_layer2_blowdown(
    optimized_config: PintleEngineConfig,
    initial_lox_pressure_pa: float,
    initial_fuel_pressure_pa: float,
    peak_thrust: float,
    target_apogee_m: float,
    rocket_dry_mass_kg: float,
    max_lox_tank_capacity_kg: float,
    max_fuel_tank_capacity_kg: float,
    target_burn_time: float,
    n_time_points: int = 200,
    update_progress: Optional[Callable] = None,
    log_status: Optional[Callable] = None,
    optimal_of_ratio: Optional[float] = None,
    min_stability_margin: Optional[float] = None,
    max_iterations: int = 20,
    save_evaluation_plots: bool = False,
    objective_callback: Optional[Callable[[int, float, float], None]] = None,
    pressure_curve_callback: Optional[
        Callable[
            [np.ndarray, np.ndarray, np.ndarray, Optional[np.ndarray], Optional[np.ndarray]],
            None,
        ]
    ] = None,
    stop_event: Optional[Any] = None,
    de_maxiter: int = 5,
    de_popsize: int = 2,
    de_n_time_points: int = 25,
    disable_impulse_requirement: bool = False,
) -> Tuple[PintleEngineConfig, np.ndarray, np.ndarray, np.ndarray, Dict[str, Any], bool]:
    """
    Optimize initial tank pressures **and propellant masses** for pure blowdown.

    Decision variables (4-D):
        x = [P_lox_init_Pa, P_fuel_init_Pa, m_lox_kg, m_fuel_kg]

    Post-blowdown evaluation matches Time Series Analysis (``eval_runner_timeseries_like_api``).
    """
    # ---- logging setup ----
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_logs_dir = Path(__file__).resolve().parents[3] / "output" / "logs"
    output_logs_dir.mkdir(parents=True, exist_ok=True)
    log_file_path = output_logs_dir / f"layer2_blowdown_{timestamp}.log"

    log = logging.getLogger("layer2_blowdown")
    log.setLevel(logging.INFO)
    log.handlers.clear()
    fh = logging.FileHandler(log_file_path, mode="w", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    log.addHandler(fh)
    log.propagate = False

    log.info("=" * 70)
    log.info("Layer 2: Pure Blowdown (4-D: pressures + masses)")
    log.info("=" * 70)
    log.info(f"Log file: {log_file_path}")
    log.info(
        f"Seed pressures — LOX: {initial_lox_pressure_pa / PSI_TO_PA:.1f} psi, "
        f"Fuel: {initial_fuel_pressure_pa / PSI_TO_PA:.1f} psi"
    )
    log.info(f"Tank capacities — LOX: {max_lox_tank_capacity_kg:.2f} kg, Fuel: {max_fuel_tank_capacity_kg:.2f} kg")
    if disable_impulse_requirement:
        log.info("Impulse requirement: DISABLED (impulse penalty zeroed)")
    log.info("COPV calculations: SKIPPED (pure blowdown is self-pressurized)")

    # ---- config copy (same physics as Time Series / loaded config; ablative may track geometry) ----
    config_layer2 = copy.deepcopy(optimized_config)

    runner = PintleEngineRunner(config_layer2)
    n2_csv = str(N2_Z_LOOKUP_CSV)

    # ---- time grids ----
    time_array = np.linspace(0.0, target_burn_time, n_time_points)
    n_time_points_de = min(de_n_time_points, n_time_points)
    time_array_de = np.linspace(0.0, target_burn_time, n_time_points_de)

    # ---- seed masses from config ----
    seed_m_lox = max_lox_tank_capacity_kg  # default: fill to capacity
    if config_layer2.lox_tank is not None and config_layer2.lox_tank.mass is not None:
        seed_m_lox = float(config_layer2.lox_tank.mass)
    seed_m_fuel = max_fuel_tank_capacity_kg
    if config_layer2.fuel_tank is not None and config_layer2.fuel_tank.mass is not None:
        seed_m_fuel = float(config_layer2.fuel_tank.mass)

    log.info(f"Seed masses — LOX: {seed_m_lox:.3f} kg, Fuel: {seed_m_fuel:.3f} kg")

    # ---- bounds ----
    def _pressure_bounds_pa(p_pa: float) -> Tuple[float, float]:
        psi = p_pa / PSI_TO_PA
        lo = max(150.0, min(1000.0, psi * 0.5))
        hi = max(150.0, min(1000.0, psi * 1.5))
        if hi <= lo:
            hi = lo + 1.0
        return lo * PSI_TO_PA, hi * PSI_TO_PA

    def _mass_bounds_kg(capacity_kg: float, seed_kg: float) -> Tuple[float, float]:
        lo = max(0.5, capacity_kg * 0.2)
        hi = capacity_kg * 1.0
        if hi <= lo:
            hi = lo + 0.1
        return lo, hi

    b_P_lox = _pressure_bounds_pa(initial_lox_pressure_pa)
    b_P_fuel = _pressure_bounds_pa(initial_fuel_pressure_pa)
    b_m_lox = _mass_bounds_kg(max_lox_tank_capacity_kg, seed_m_lox)
    b_m_fuel = _mass_bounds_kg(max_fuel_tank_capacity_kg, seed_m_fuel)
    bounds = [b_P_lox, b_P_fuel, b_m_lox, b_m_fuel]

    log.info(
        f"Bounds — P_lox: [{b_P_lox[0]/PSI_TO_PA:.0f}, {b_P_lox[1]/PSI_TO_PA:.0f}] psi, "
        f"P_fuel: [{b_P_fuel[0]/PSI_TO_PA:.0f}, {b_P_fuel[1]/PSI_TO_PA:.0f}] psi, "
        f"m_lox: [{b_m_lox[0]:.2f}, {b_m_lox[1]:.2f}] kg, "
        f"m_fuel: [{b_m_fuel[0]:.2f}, {b_m_fuel[1]:.2f}] kg"
    )

    # ---- optimiser state ----
    state: Dict[str, Any] = {
        "eval_count": 0,
        "best_obj": float("inf"),
        "best_x": None,
        "best_P_lox": None,
        "best_P_fuel": None,
        "converged": False,
    }

    def finish_evaluation(
        final_obj: float,
        x_vec: np.ndarray,
        p_lox: Optional[np.ndarray] = None,
        p_fuel: Optional[np.ndarray] = None,
    ) -> float:
        if final_obj < state["best_obj"] and np.isfinite(final_obj):
            state["best_obj"] = float(final_obj)
            state["best_x"] = np.array(x_vec, copy=True)
            if p_lox is not None and p_fuel is not None:
                state["best_P_lox"] = p_lox.copy()
                state["best_P_fuel"] = p_fuel.copy()
        if objective_callback is not None:
            try:
                objective_callback(
                    int(state["eval_count"]),
                    float(final_obj),
                    float(state["best_obj"]),
                )
            except Exception:
                pass
        return float(final_obj)

    # ---- candidate evaluation ----
    def evaluate_candidate(
        P_lox_init: float,
        P_fuel_init: float,
        m_lox_kg: float,
        m_fuel_kg: float,
        time_eval: np.ndarray,
        n_pts: int,
        phase: str,
        record_best: bool = True,
    ) -> Tuple[
        float,
        Optional[np.ndarray],
        Optional[np.ndarray],
        Optional[Dict[str, Any]],
        Optional[np.ndarray],
        Optional[np.ndarray],
    ]:
        """Run blowdown + same engine time-series path as Time Series Analysis API.

        When ``record_best`` is False (e.g. full-resolution export), we skip
        objective bookkeeping and streaming callbacks — only traces matter.
        """
        if record_best:
            if stop_event is not None and stop_event.is_set():
                return state.get("best_obj", 1e6), None, None, None, None, None

            state["eval_count"] += 1
            eval_num = state["eval_count"]
        else:
            eval_num = -1

        x_vec = np.array([P_lox_init, P_fuel_init, m_lox_kg, m_fuel_kg], dtype=float)
        if not np.all(np.isfinite(x_vec)):
            if record_best:
                return finish_evaluation(1e6, x_vec), None, None, None, None, None
            return 1e6, None, None, None, None, None

        times = np.asarray(time_eval, dtype=float)
        if len(times) != n_pts:
            times = np.linspace(0.0, target_burn_time, n_pts)

        # Stamp the candidate masses onto config so blowdown_solver picks them up
        if config_layer2.lox_tank is not None:
            config_layer2.lox_tank.mass = float(m_lox_kg)
        if config_layer2.fuel_tank is not None:
            config_layer2.fuel_tank.mass = float(m_fuel_kg)

        def engine_evaluator(P_lox_Pa: float, P_fuel_Pa: float) -> Tuple[float, float]:
            try:
                res = runner.evaluate(
                    P_tank_O=P_lox_Pa,
                    P_tank_F=P_fuel_Pa,
                    silent=True,
                    debug=True,
                )
                return float(res["mdot_O"]), float(res["mdot_F"])
            except Exception:
                return 0.0, 0.0

        try:
            blowdown_results = simulate_coupled_blowdown(
                times=times,
                evaluate_engine_fn=engine_evaluator,
                P_lox_initial_Pa=float(P_lox_init),
                P_fuel_initial_Pa=float(P_fuel_init),
                config=config_layer2,
                R_pressurant=296.803,
                T_lox_gas_K=250.0,
                T_fuel_gas_K=293.0,
                n_polytropic=1.2,
                use_real_gas=True,
                n2_Z_csv=n2_csv,
            )
        except Exception as e:
            log.warning(f"simulate_coupled_blowdown failed eval #{eval_num}: {e!r}")
            if record_best:
                return finish_evaluation(1e6, x_vec), None, None, None, None, None
            return 1e6, None, None, None, None, None

        P_lox = np.asarray(blowdown_results["lox"]["P_Pa"], dtype=float)
        P_fuel = np.asarray(blowdown_results["fuel"]["P_Pa"], dtype=float)
        lox_mass_trace = np.asarray(blowdown_results["lox"]["m_prop_kg"], dtype=float)
        fuel_mass_trace = np.asarray(blowdown_results["fuel"]["m_prop_kg"], dtype=float)
        if P_lox.size != len(times) or P_fuel.size != len(times):
            log.warning(f"Length mismatch blowdown vs times eval #{eval_num}")
            if record_best:
                return finish_evaluation(1e6, x_vec), None, None, None, None, None
            return 1e6, None, None, None, None, None

        try:
            results_ts = eval_runner_timeseries_like_api(runner, times, P_lox, P_fuel)
            apply_propellant_depletion_mask_to_runner_results(
                results_ts, times, lox_mass_trace, fuel_mass_trace
            )
        except Exception as e:
            log.warning(f"eval_runner_timeseries_like_api failed eval #{eval_num}: {e!r}")
            if record_best:
                return finish_evaluation(1e6, x_vec), None, None, None, None, None
            return 1e6, None, None, None, None, None

        obj, comp = _compute_penalties_from_results(
            results_ts, times, peak_thrust, target_apogee_m, rocket_dry_mass_kg,
            max_lox_tank_capacity_kg, max_fuel_tank_capacity_kg, target_burn_time,
            optimal_of_ratio, min_stability_margin,
            m_lox_kg,
            m_fuel_kg,
            disable_impulse_requirement=disable_impulse_requirement,
        )

        if record_best:
            if obj < state["best_obj"] and np.isfinite(obj):
                log.info(
                    f"  New best [{phase}] eval #{eval_num}: obj={obj:.4f} "
                    f"P_lox={P_lox_init/PSI_TO_PA:.0f}psi P_fuel={P_fuel_init/PSI_TO_PA:.0f}psi "
                    f"m_lox={m_lox_kg:.2f}kg m_fuel={m_fuel_kg:.2f}kg "
                    f"(imp={comp.get('impulse_penalty',0):.2f} cap={comp.get('capacity_penalty',0):.2f} "
                    f"stab={comp.get('stability_penalty',0):.2f} dP={comp.get('injector_dp_penalty',0):.2f})"
                )
                if pressure_curve_callback is not None:
                    try:
                        pressure_curve_callback(times.copy(), P_lox.copy(), P_fuel.copy(), None, None)
                    except Exception:
                        pass
            else:
                log.info(f"  [{phase}] eval #{eval_num}: obj={obj:.4f} (best={state['best_obj']:.4f})")

            finish_evaluation(obj, x_vec, P_lox, P_fuel)
        return obj, P_lox, P_fuel, results_ts, lox_mass_trace, fuel_mass_trace

    def objective_cma(x: np.ndarray) -> float:
        obj, _, _, _, _, _ = evaluate_candidate(
            float(x[0]), float(x[1]), float(x[2]), float(x[3]),
            time_array_de, n_time_points_de, "CMA",
        )
        return obj

    # ---- CMA-ES (derivative-free; avoids L-BFGS-B finite-difference cost) ----
    import cma

    lb = np.array([b[0] for b in bounds], dtype=float)
    ub = np.array([b[1] for b in bounds], dtype=float)
    x0_clamped = np.clip(
        np.array([initial_lox_pressure_pa, initial_fuel_pressure_pa, seed_m_lox, seed_m_fuel], dtype=float),
        lb,
        ub,
    )
    span = ub - lb
    sigma0 = float(np.mean(span) * 0.15)
    if not np.isfinite(sigma0) or sigma0 <= 0:
        sigma0 = 1e5

    n_dims = 4
    cma_popsize = max(6, min(14, int(de_popsize) * 3))
    # Hard cap on expensive evals (same order as old DE × pop, but no extra polish passes).
    cma_budget = max(100, min(400, int(de_maxiter) * cma_popsize))

    opts: Dict[str, Any] = {
        "bounds": [lb.tolist(), ub.tolist()],
        "popsize": cma_popsize,
        "maxfevals": cma_budget,
        "maxiter": 10_000,
        "verb_disp": 0,
        "verb_log": 0,
        "verb_filename": "",
        "seed": 42,
        "tolx": 1e-6,
        "tolfun": 1e-4,
    }
    if float(np.mean(span)) > 0:
        opts["CMA_stds"] = (span / np.mean(span)).tolist()

    if update_progress:
        update_progress(
            "Layer 2: Pure Blowdown",
            0.3,
            f"CMA-ES (pop {cma_popsize}, ≤{cma_budget} evals, {n_time_points_de} time pts)...",
        )

    log.info(
        f"CMA-ES: popsize={cma_popsize} maxfevals={cma_budget} sigma0={sigma0:.4g} "
        f"(coarse {n_time_points_de} pts; same as Layer 3 pattern)"
    )

    try:
        es = cma.CMAEvolutionStrategy(x0_clamped.tolist(), sigma0, opts)
        while not es.stop():
            if stop_event is not None and stop_event.is_set():
                log.info("CMA-ES stopped by user")
                break
            candidates = es.ask()
            fitnesses = [float(objective_cma(np.asarray(x, dtype=float))) for x in candidates]
            es.tell(candidates, fitnesses)
        log.info(
            f"CMA-ES finished: stop={es.stop()} best_f={getattr(es.result, 'fbest', None)}"
        )
    except Exception as e:
        log.error(f"CMA-ES failed: {e!r}")

    x0_fallback = x0_clamped
    best_x = state["best_x"] if state["best_x"] is not None else x0_fallback
    success = bool(np.isfinite(state["best_obj"]) and state["best_obj"] < 1e5)

    opt_P_lox_pa = float(best_x[0])
    opt_P_fuel_pa = float(best_x[1])
    opt_m_lox_kg = float(best_x[2])
    opt_m_fuel_kg = float(best_x[3])
    log.info(
        f"Optimised: P_lox={opt_P_lox_pa/PSI_TO_PA:.1f}psi  P_fuel={opt_P_fuel_pa/PSI_TO_PA:.1f}psi  "
        f"m_lox={opt_m_lox_kg:.3f}kg  m_fuel={opt_m_fuel_kg:.3f}kg"
    )

    # ---- full-resolution blowdown + same evaluation path as Time Series API (summary + YAML curves) ----
    if n_time_points_de < n_time_points:
        log.info(
            f"Exporting best solution at {n_time_points} time points "
            f"(CMA used {n_time_points_de} pts)..."
        )
    else:
        log.info(f"Exporting best solution at {n_time_points} time points...")
    _, P_lox_opt, P_fuel_opt, results_final, lox_mass_trace_final, fuel_mass_trace_final = evaluate_candidate(
        opt_P_lox_pa, opt_P_fuel_pa, opt_m_lox_kg, opt_m_fuel_kg,
        time_array, n_time_points, "final_export",
        record_best=False,
    )
    thrust_final = None
    if results_final is not None:
        thrust_final = np.atleast_1d(results_final.get("F", []))
    if P_lox_opt is None or P_fuel_opt is None:
        P_lox_opt = np.linspace(initial_lox_pressure_pa, initial_lox_pressure_pa * 0.8, n_time_points)
        P_fuel_opt = np.linspace(initial_fuel_pressure_pa, initial_fuel_pressure_pa * 0.8, n_time_points)
        results_final = None
        thrust_final = None

    total_impulse_actual = 0.0
    initial_thrust_actual = 0.0
    total_lox_mass_final = 0.0
    total_fuel_mass_final = 0.0
    required_impulse_final = 0.0
    avg_of_ratio = None
    min_stability_margin_val = None

    if results_final is not None and thrust_final is not None and len(thrust_final) > 0:
        mdot_O_final = np.atleast_1d(results_final.get("mdot_O", np.zeros(len(time_array))))
        mdot_F_final = np.atleast_1d(results_final.get("mdot_F", np.zeros(len(time_array))))
        total_impulse_actual = float(np.trapezoid(thrust_final, time_array[:len(thrust_final)]))
        initial_thrust_actual = float(thrust_final[0])
        total_lox_mass_final = float(np.trapezoid(mdot_O_final, time_array[:len(mdot_O_final)]))
        total_fuel_mass_final = float(np.trapezoid(mdot_F_final, time_array[:len(mdot_F_final)]))
        total_prop = total_lox_mass_final + total_fuel_mass_final
        n_fin = min(len(time_array), len(mdot_O_final), len(mdot_F_final))
        eff_burn_final = effective_burn_time_for_layer2_objective(
            time_array[:n_fin], mdot_O_final[:n_fin], mdot_F_final[:n_fin], target_burn_time
        )
        required_impulse_final = calculate_required_impulse_from_mass(
            target_apogee_m, rocket_dry_mass_kg, total_prop, eff_burn_final,
        )
        # Build a thrust-based burn mask so post-burnout zero-masked values
        # don't corrupt avg_of_ratio or min_stability_margin.
        thrust_arr = np.atleast_1d(thrust_final).astype(float)
        peak_thrust_val = float(np.nanmax(thrust_arr)) if thrust_arr.size else 0.0
        if np.isfinite(peak_thrust_val) and peak_thrust_val > 0:
            burn_mask = thrust_arr > max(peak_thrust_val * 1e-3, 1.0)
        else:
            burn_mask = np.ones(len(thrust_arr), dtype=bool)

        n_burn = int(np.sum(burn_mask))
        log.info(f"Burn mask: {n_burn}/{len(burn_mask)} points active (peak_thrust={peak_thrust_val:.1f} N)")

        MR_hist = np.atleast_1d(results_final.get("MR", []))
        if len(MR_hist) > 0:
            MR_hist = MR_hist[:len(burn_mask)]
            vm = MR_hist[burn_mask[:len(MR_hist)] & np.isfinite(MR_hist) & (MR_hist > 0)]
            if len(vm) > 0:
                avg_of_ratio = float(np.mean(vm))
                log.info(f"avg_of_ratio={avg_of_ratio:.4f} from {len(vm)} active-burn MR points")
        chm = results_final.get("chugging_stability_margin")
        if chm is not None:
            chm = np.atleast_1d(chm)[:len(burn_mask)]
            vf = chm[burn_mask[:len(chm)] & np.isfinite(chm) & (chm > 0)]
            if len(vf) > 0:
                min_stability_margin_val = float(np.min(vf))
                log.info(f"min_stability_margin={min_stability_margin_val:.4f} from {len(vf)} active-burn points")

    # Pure blowdown is self-pressurized — no COPV needed.
    copv_P0_Pa = None
    copv_pressure_trace_Pa = None
    copv_time_s = None

    # ---- thrust / OF curves for UI ----
    thrust_curve_time = None
    thrust_curve_values = None
    of_curve_values = None
    pc_curve_values = None
    mdot_O_curve_values = None
    mdot_F_curve_values = None
    mdot_total_curve_values = None
    if results_final is not None and thrust_final is not None and len(thrust_final) > 0:
        thrust_curve_time = time_array[:len(thrust_final)].tolist()
        thrust_curve_values = thrust_final.tolist()
        MR_final = np.atleast_1d(results_final.get("MR", np.zeros(len(thrust_final))))
        if len(MR_final) > 0:
            of_curve_values = MR_final.tolist()
        Pc_final = np.atleast_1d(results_final.get("Pc", np.zeros(len(thrust_final))))
        if len(Pc_final) > 0:
            pc_curve_values = Pc_final.tolist()
        mdot_O_final_curve = np.atleast_1d(results_final.get("mdot_O", np.zeros(len(thrust_final))))
        mdot_F_final_curve = np.atleast_1d(results_final.get("mdot_F", np.zeros(len(thrust_final))))
        mdot_total_final_curve = np.atleast_1d(results_final.get("mdot_total", np.zeros(len(thrust_final))))
        if len(mdot_O_final_curve) > 0:
            mdot_O_curve_values = mdot_O_final_curve.tolist()
        if len(mdot_F_final_curve) > 0:
            mdot_F_curve_values = mdot_F_final_curve.tolist()
        if len(mdot_total_final_curve) > 0:
            mdot_total_curve_values = mdot_total_final_curve.tolist()

    # ---- fill level curves (fraction of physical max capacity) ----
    lox_fill_fraction_curve = None
    fuel_fill_fraction_curve = None
    if (
        lox_mass_trace_final is not None
        and fuel_mass_trace_final is not None
        and max_lox_tank_capacity_kg > 0
        and max_fuel_tank_capacity_kg > 0
    ):
        lox_trace = np.asarray(lox_mass_trace_final, dtype=float)
        fuel_trace = np.asarray(fuel_mass_trace_final, dtype=float)
        n_fill = int(min(len(time_array), lox_trace.size, fuel_trace.size))
        if n_fill > 1:
            lox_fill_fraction_curve = np.clip(lox_trace[:n_fill] / float(max_lox_tank_capacity_kg), 0.0, 1.0).tolist()
            fuel_fill_fraction_curve = np.clip(fuel_trace[:n_fill] / float(max_fuel_tank_capacity_kg), 0.0, 1.0).tolist()

    # ---- summary dict (same schema as regulated Layer 2) ----
    summary: Dict[str, Any] = {
        "layer2_mode": "pure_blowdown",
        "optimizer_backend": "cma-es",
        "lox_segments": N_SEGMENTS_TRACE,
        "fuel_segments": N_SEGMENTS_TRACE,
        "initial_lox_pressure_pa": opt_P_lox_pa,
        "initial_fuel_pressure_pa": opt_P_fuel_pa,
        "optimized_lox_mass_kg": opt_m_lox_kg,
        "optimized_fuel_mass_kg": opt_m_fuel_kg,
        "lox_start_pressure_pa": float(P_lox_opt[0]),
        "lox_end_pressure_pa": float(P_lox_opt[-1]),
        "fuel_start_pressure_pa": float(P_fuel_opt[0]),
        "fuel_end_pressure_pa": float(P_fuel_opt[-1]),
        "target_burn_time": target_burn_time,
        "n_time_points": n_time_points,
        "peak_thrust": peak_thrust,
        "initial_thrust_actual": initial_thrust_actual,
        "total_impulse_Ns": total_impulse_actual,
        "required_impulse_Ns": required_impulse_final,
        "lox_mass_kg": total_lox_mass_final,
        "fuel_mass_kg": total_fuel_mass_final,
        "burn_time_s": target_burn_time,
        "avg_of_ratio": avg_of_ratio,
        "min_stability_margin": min_stability_margin_val,
        "is_success": success,
        "thrust_curve_time": thrust_curve_time,
        "thrust_curve_values": thrust_curve_values,
        "of_curve_values": of_curve_values,
        "pc_curve_values": pc_curve_values,
        "mdot_O_curve_values": mdot_O_curve_values,
        "mdot_F_curve_values": mdot_F_curve_values,
        "mdot_total_curve_values": mdot_total_curve_values,
        # Tank fill level curves (% of physical max capacity, 0-1)
        "lox_fill_fraction_curve": lox_fill_fraction_curve,
        "fuel_fill_fraction_curve": fuel_fill_fraction_curve,
        "total_lox_mass_kg": total_lox_mass_final,
        "total_fuel_mass_kg": total_fuel_mass_final,
        "total_propellant_mass_kg": total_lox_mass_final + total_fuel_mass_final,
        "max_lox_tank_capacity_kg": max_lox_tank_capacity_kg,
        "max_fuel_tank_capacity_kg": max_fuel_tank_capacity_kg,
        "required_impulse": required_impulse_final,
        "total_impulse_actual": total_impulse_actual,
        "impulse_ratio": total_impulse_actual / max(required_impulse_final, 1e-9),
        "copv_P0_Pa": copv_P0_Pa,
        "copv_pressure_trace_Pa": (
            copv_pressure_trace_Pa.tolist()
            if copv_pressure_trace_Pa is not None and hasattr(copv_pressure_trace_Pa, "tolist")
            else None
        ),
        "copv_time_s": (
            copv_time_s.tolist() if copv_time_s is not None and hasattr(copv_time_s, "tolist") else None
        ),
    }

    # ---- persist to config ----
    optimized_config = copy.deepcopy(optimized_config)
    if optimized_config.lox_tank is not None:
        optimized_config.lox_tank.initial_pressure_psi = float(opt_P_lox_pa / PSI_TO_PA)
        optimized_config.lox_tank.mass = opt_m_lox_kg
    if optimized_config.fuel_tank is not None:
        optimized_config.fuel_tank.initial_pressure_psi = float(opt_P_fuel_pa / PSI_TO_PA)
        optimized_config.fuel_tank.mass = opt_m_fuel_kg

    lox_seg_dicts = _trace_to_segments(P_lox_opt, N_SEGMENTS_TRACE)
    fuel_seg_dicts = _trace_to_segments(P_fuel_opt, N_SEGMENTS_TRACE)
    lox_segment_configs = [
        PressureSegmentConfig(
            length_ratio=float(s["length_ratio"]), type=s["type"],
            start_pressure_pa=float(s["start_pressure"]),
            end_pressure_pa=float(s["end_pressure"]),
            k=float(s["k"]) if s.get("k") is not None else None,
        )
        for s in lox_seg_dicts
    ]
    fuel_segment_configs = [
        PressureSegmentConfig(
            length_ratio=float(s["length_ratio"]), type=s["type"],
            start_pressure_pa=float(s["start_pressure"]),
            end_pressure_pa=float(s["end_pressure"]),
            k=float(s["k"]) if s.get("k") is not None else None,
        )
        for s in fuel_seg_dicts
    ]
    optimized_config.pressure_curves = PressureCurvesConfig(
        n_points=n_time_points,
        target_burn_time_s=target_burn_time,
        initial_lox_pressure_pa=opt_P_lox_pa,
        initial_fuel_pressure_pa=opt_P_fuel_pa,
        lox_segments=lox_segment_configs,
        fuel_segments=fuel_segment_configs,
    )

    log.info(f"Layer 2 pure blowdown complete. Log: {log_file_path}")
    log.handlers.clear()

    if update_progress:
        update_progress("Layer 2: Pure Blowdown", 0.64, "Optimization complete")

    return optimized_config, time_array, P_lox_opt, P_fuel_opt, summary, success
