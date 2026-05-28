"""Layer 2: Pressure Curve Optimization

This layer optimizes fuel and oxidizer pressure curves to input into the time series solver.
The pressure curves are 200-point arrays broken into N segments (1-20).

Each segment has:
- Segment length (in terms of points/200)
- Region type: linear OR blowdown
- Start pressure (matches previous region's end pressure)
- End pressure
- k-variable for blowdown profile between those 2 points

Pressure curves are always decreasing.
"""

from __future__ import annotations

from typing import Dict, Any, Optional, Tuple, Callable, List
import numpy as np
import copy
import logging
import time
from datetime import datetime
from pathlib import Path
import pandas as pd
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend
import matplotlib.pyplot as plt

from engine.pipeline.config_schemas import PintleEngineConfig, PressureCurvesConfig, PressureSegmentConfig
from engine.core.runner import PintleEngineRunner
from copv.copv_solve_both import size_or_check_copv_for_polytropic_N2

# Path to N2 compressibility lookup table for COPV solver
# Use absolute path from the project root
# layer2_pressure.py -> layers/ -> optimizer/ -> engine/ -> project_root/
N2_Z_LOOKUP_CSV = Path(__file__).resolve().parent.parent.parent.parent / "copv" / "n2_Z_lookup.csv"


def generate_pressure_curve_from_segments(
    segments: List[Dict[str, Any]],
    n_points: int = 200,
) -> np.ndarray:
    """
    Generate a 200-point pressure curve from segments.
    
    Each segment specifies:
    - length_ratio: fraction of total points (0-1)
    - type: 'linear' or 'blowdown'
    - start_pressure: pressure at start [Pa]
    - end_pressure: pressure at end [Pa] (must be <= start_pressure)
    - k: blowdown parameter (only for blowdown type)
    
    Args:
        segments: List of segment dicts
        n_points: Total number of points (default 200)
    
    Returns:
        pressure_array: Array of pressures [Pa] of length n_points
    """
    if not segments:
        # Default constant pressure
        return np.full(n_points, 5e6)  # 5 MPa default
    
    pressure_array = np.zeros(n_points, dtype=float)
    
    # Calculate cumulative point indices for each segment
    point_idx = 0
    for i, seg in enumerate(segments):
        # Robustly interpret the segment parameters. If any are non-finite, fall
        # back to safe defaults so that a bad segment description cannot crash
        # the optimizer; upstream logic should already treat such cases as low
        # quality via the objective.
        raw_lr = seg.get("length_ratio", 1.0 / max(len(segments), 1))
        try:
            length_ratio = float(raw_lr)
        except (TypeError, ValueError):
            length_ratio = 1.0 / max(len(segments), 1)
        # Clamp and repair non-finite values.
        if not np.isfinite(length_ratio):
            length_ratio = 1.0 / max(len(segments), 1)
        length_ratio = float(np.clip(length_ratio, 0.01, 1.0))
        seg_type = seg.get("type", "linear")
        P_start = float(seg["start_pressure"])
        P_end = float(seg["end_pressure"])
        k = float(seg.get("k", 0.3))  # Blowdown parameter
        # Guard against any non-finite pressures or k slipping through.
        if not np.isfinite(P_start) or not np.isfinite(P_end):
            # If either endpoint is invalid, skip this segment entirely.
            continue
        if not np.isfinite(k):
            k = 0.3
        
        # Ensure end <= start (decreasing pressure)
        if P_end > P_start:
            P_end = P_start * 0.95  # Force decrease
        
        # Calculate number of points for this segment
        if i == len(segments) - 1:
            # Last segment takes remaining points
            n_seg_points = n_points - point_idx
        else:
            # Ensure the product is finite before casting to int.
            n_seg_float = length_ratio * float(n_points)
            if not np.isfinite(n_seg_float):
                # If this ever happens, just give the segment a single point so
                # that the optimizer receives a very "flat" and low-quality
                # pressure curve instead of crashing.
                n_seg_float = 1.0
            n_seg_points = int(round(n_seg_float))
            n_seg_points = max(1, min(n_seg_points, n_points - point_idx))
        
        if n_seg_points <= 0:
            continue
        
        # Generate local indices for this segment
        seg_indices = np.arange(point_idx, point_idx + n_seg_points)
        if len(seg_indices) == 0:
            continue
        
        # Normalized position within segment (0 to 1)
        if n_seg_points > 1:
            t_norm = np.linspace(0.0, 1.0, n_seg_points)
        else:
            t_norm = np.array([0.0])
        
        if seg_type == "linear":
            # Linear interpolation: P(t) = P_start + (P_end - P_start) * t
            pressure_array[seg_indices] = P_start + (P_end - P_start) * t_norm
        elif seg_type == "blowdown":
            # Blowdown profile: P(t) = P_end + (P_start - P_end) * exp(-k * t)
            # k controls the decay rate
            pressure_array[seg_indices] = P_end + (P_start - P_end) * np.exp(-k * t_norm)
        else:
            # Default to linear
            pressure_array[seg_indices] = P_start + (P_end - P_start) * t_norm
        
        point_idx += n_seg_points
        if point_idx >= n_points:
            break
    
    # Fill any remaining points with last value
    if point_idx < n_points:
        if point_idx > 0:
            pressure_array[point_idx:] = pressure_array[point_idx - 1]
        else:
            pressure_array[:] = segments[-1]["end_pressure"] if segments else 5e6
    
    return pressure_array


def segments_from_optimizer_vars_pressure(
    x_segments: np.ndarray,
    n_segments: int,
    initial_pressure_pa: float,
    min_pressure_pa: float = 1e6,  # 1 MPa minimum
) -> List[Dict[str, Any]]:
    """
    Convert optimizer variables to segment list for pressure curves.
    
    For each segment, optimizer provides:
    - length_ratio (0-1, fraction of total 200 points)
    - end_pressure_ratio (0-1, ratio relative to initial pressure)
    - k (0-2, blowdown parameter)
    
    Start pressure is automatically set to match previous segment's end pressure.
    First segment starts at initial_pressure_pa.
    
    Args:
        x_segments: Array of optimizer variables for segments
        n_segments: Number of segments (1-20)
        initial_pressure_pa: Initial pressure from Layer 1 [Pa]
        min_pressure_pa: Minimum pressure [Pa]
    
    Returns:
        List of segment dicts
    """
    segments = []
    vars_per_segment = 3  # length_ratio, end_pressure_ratio, k
    
    # Ensure n_segments doesn't exceed available array size
    max_available_segments = len(x_segments) // vars_per_segment
    n_segments = min(n_segments, max_available_segments)
    if n_segments < 1:
        n_segments = 1
    
    # Normalize length ratios so they sum to 1.0
    length_ratios = []
    for i in range(n_segments):
        idx_base = i * vars_per_segment
        if idx_base >= len(x_segments):
            break
        length_ratio = float(np.clip(x_segments[idx_base], 0.01, 1.0))
        length_ratios.append(length_ratio)
    
    # Normalize so sum = 1.0
    total_ratio = sum(length_ratios) if length_ratios else 1.0
    if total_ratio > 0:
        length_ratios = [lr / total_ratio for lr in length_ratios]
    
    # Build segments
    prev_end_pressure = initial_pressure_pa  # First segment starts at initial pressure from Layer 1
    
    for i in range(n_segments):
        idx_base = i * vars_per_segment
        if idx_base + 2 >= len(x_segments):
            break
        
        length_ratio = length_ratios[i] if i < len(length_ratios) else 1.0 / n_segments
        
        # All segments are modeled as blowdown; k can make them effectively linear when small.
        seg_type = "blowdown"
        
        # End pressure ratio (relative to initial pressure, but must be <= start)
        end_ratio_raw = float(np.clip(x_segments[idx_base + 1], 0.1, 1.0))
        # Ensure end <= start (decreasing)
        start_ratio = prev_end_pressure / initial_pressure_pa
        end_ratio = min(end_ratio_raw, start_ratio * 0.99)  # Slight margin
        end_pressure = initial_pressure_pa * end_ratio
        end_pressure = max(min_pressure_pa, min(end_pressure, prev_end_pressure))
        
        # k parameter for blowdown
        k = float(np.clip(x_segments[idx_base + 2] if len(x_segments) > idx_base + 2 else 0.3, 0.1, 2.0))
        
        seg = {
            "length_ratio": length_ratio,
            "type": seg_type,
            "start_pressure": prev_end_pressure,
            "end_pressure": end_pressure,
            "k": k,
        }
        
        segments.append(seg)
        prev_end_pressure = end_pressure  # Next segment starts where this one ends
    
    return segments


def calculate_required_impulse_from_mass(
    target_apogee_m: float,
    rocket_dry_mass_kg: float,
    total_propellant_mass_kg: float,
    target_burn_time_s: float,
    g: float = 9.80665,
) -> float:
    """
    Calculate minimum required total impulse to reach target apogee.
    
    Uses actual propellant mass consumed to calculate initial mass.
    Uses energy conservation with approximations for gravity and drag losses.
    
    Args:
        target_apogee_m: Target apogee altitude [m]
        rocket_dry_mass_kg: Rocket dry mass (no propellant) [kg]
            Should include: airframe + engine + lox_tank_structure + fuel_tank_structure + copv_structure
        total_propellant_mass_kg: Total propellant mass consumed [kg]
            Should be: LOX propellant + fuel propellant (from integrating mdot_O and mdot_F)
        target_burn_time_s: Target burn time [s]
        g: Gravitational acceleration [m/s²]
    
    Returns:
        Required total impulse [N·s]
    """
    # Calculate initial mass from actual propellant consumption
    # rocket_dry_mass_kg = airframe + engine + all tank structures (no propellant)
    # total_propellant_mass_kg = LOX propellant + fuel propellant consumed during burn
    initial_mass = rocket_dry_mass_kg + total_propellant_mass_kg
    
    # Minimum delta-v for vertical launch (energy conservation)
    # v_burnout^2 / 2 = g * h_apogee (ignoring losses)
    min_delta_v = np.sqrt(2.0 * g * target_apogee_m)
    
    # Account for losses:
    # - Gravity loss: ~g * t_burn (velocity lost to gravity during burn)
    # - Drag loss: ~10-20% of ideal delta-v (depends on rocket, simplified here)
    gravity_loss = g * target_burn_time_s * 0.5  # Average over burn
    drag_loss_factor = 1.15  # 15% drag loss approximation
    total_delta_v = min_delta_v * drag_loss_factor + gravity_loss
    
    # Required impulse = delta_v * initial_mass
    required_impulse = total_delta_v * initial_mass
    
    return required_impulse


# When 95% of impulse lands before the end of this window, apply only a *soft* nudge (see layer2_objective).
LAYER2_BURN_TIME_SOFT_SCALE = 3.0

# Soft incentive to use as much of the target burn time as possible.
# Penalty = ((target - effective) / target)^2 * SCALE.  Quadratic so short burns
# feel it strongly (e.g. 50% utilisation → 25% × 15 = 3.75) while burns close to
# target are barely nudged (e.g. 90% utilisation → 1% × 15 = 0.15).
LAYER2_BURN_DURATION_SCALE = 30.0


def effective_burn_time_for_layer2_objective(
    time_hist: np.ndarray,
    mdot_O_hist: np.ndarray,
    mdot_F_hist: np.ndarray,
    target_burn_time: float,
) -> float:
    """
    Duration bound for Layer 2 burn-time and required-impulse helpers: min(target, physical flow end).

    If the schedule or tank model stops meaningful flow before ``target_burn_time`` (e.g. target
    15 s but only ~10 s of propellant flow), we should not treat the remaining window as time the
    optimizer could have used for impulse—avoids over-penalizing those cases.
    """
    from scipy.integrate import cumulative_trapezoid

    time_hist = np.asarray(time_hist, dtype=float)
    mdot_O_hist = np.asarray(mdot_O_hist, dtype=float)
    mdot_F_hist = np.asarray(mdot_F_hist, dtype=float)
    n = min(time_hist.size, mdot_O_hist.size, mdot_F_hist.size)
    if n < 2:
        return float(target_burn_time)
    time_hist = time_hist[:n]
    mdot_tot = mdot_O_hist[:n] + mdot_F_hist[:n]
    cum = cumulative_trapezoid(mdot_tot, time_hist, initial=0.0)
    total = float(cum[-1])
    if total <= 1e-12 or not np.isfinite(total):
        return float(target_burn_time)
    frac = cum / total
    idx = int(np.searchsorted(frac, 0.999, side="right"))
    if idx >= n:
        idx = n - 1
    t_mass = float(time_hist[idx])
    peak = float(np.nanmax(mdot_tot))
    if np.isfinite(peak) and peak > 0:
        thresh = max(peak * 1e-3, 1e-9)
        active = np.where(mdot_tot > thresh)[0]
        t_mdot = float(time_hist[int(active[-1])]) if active.size else t_mass
    else:
        t_mdot = t_mass
    t_phys = min(t_mass, t_mdot)
    return float(min(target_burn_time, max(0.0, t_phys)))


def active_burn_prefix_len(
    time_hist: np.ndarray,
    mdot_O_hist: np.ndarray,
    mdot_F_hist: np.ndarray,
    target_burn_time: float,
    thrust_hist: Optional[np.ndarray] = None,
) -> int:
    """
    Return a prefix length representing the active burn region.

    Layer 2 can include a post-burnout tail where mdot/thrust/MR are forced to 0.
    For objective checks and summary averages we must ignore that tail.

    We assume burnout is one-way (active then off) and return the last index (inclusive)
    where the burn is still "meaningfully" active within the effective burn window.

    IMPORTANT: Some masking paths zero thrust/MR after burnout but do not fully zero mdot.
    If `thrust_hist` is provided, we use it in addition to mdot to detect burnout robustly.
    """
    time_hist = np.asarray(time_hist, dtype=float)
    mdot_O_hist = np.asarray(mdot_O_hist, dtype=float)
    mdot_F_hist = np.asarray(mdot_F_hist, dtype=float)
    thrust_arr = None if thrust_hist is None else np.asarray(thrust_hist, dtype=float)
    n = min(
        time_hist.size,
        mdot_O_hist.size,
        mdot_F_hist.size,
        (thrust_arr.size if thrust_arr is not None else time_hist.size),
    )
    if n < 2:
        return int(n)

    time_hist = time_hist[:n]
    mdot_tot = mdot_O_hist[:n] + mdot_F_hist[:n]
    eff = effective_burn_time_for_layer2_objective(time_hist, mdot_O_hist[:n], mdot_F_hist[:n], target_burn_time)

    peak_mdot = float(np.nanmax(mdot_tot)) if mdot_tot.size else 0.0
    mdot_thresh = max(peak_mdot * 1e-3, 1e-9) if np.isfinite(peak_mdot) and peak_mdot > 0 else 0.0
    mdot_ok = mdot_tot > mdot_thresh if mdot_thresh > 0 else np.ones_like(time_hist, dtype=bool)

    if thrust_arr is not None:
        thrust_arr = thrust_arr[:n]
        peak_thrust = float(np.nanmax(thrust_arr)) if thrust_arr.size else 0.0
        # If thrust is meaningful, treat thrust as the authoritative "burning" signal.
        if np.isfinite(peak_thrust) and peak_thrust > 0:
            thrust_thresh = max(peak_thrust * 1e-3, 1.0)
            thrust_ok = thrust_arr > thrust_thresh
            active_mask = (time_hist <= eff + 1e-9) & thrust_ok
        else:
            # Fallback: thrust not usable; use mdot only.
            active_mask = (time_hist <= eff + 1e-9) & mdot_ok
    else:
        active_mask = (time_hist <= eff + 1e-9) & mdot_ok

    active = np.where(active_mask)[0]

    if active.size == 0:
        return int(min(n, 2))
    return int(active[-1] + 1)


def _delta_p_injector_pair_from_diagnostic(diag: Any) -> Tuple[Optional[float], Optional[float]]:
    """Extract LOX / fuel injector ΔP [Pa] from a per-time-step diagnostics dict."""
    if not isinstance(diag, dict) or diag.get("error"):
        return None, None
    inj = diag.get("injector_pressure")
    if isinstance(inj, dict) and ("delta_p_injector_O" in inj or "delta_p_injector_F" in inj):
        dp_o = inj.get("delta_p_injector_O")
        dp_f = inj.get("delta_p_injector_F")
    else:
        dp_o = diag.get("delta_p_injector_O")
        dp_f = diag.get("delta_p_injector_F")
    out_o: Optional[float] = None
    out_f: Optional[float] = None
    if dp_o is not None and np.isfinite(dp_o):
        out_o = float(dp_o)
    if dp_f is not None and np.isfinite(dp_f):
        out_f = float(dp_f)
    return out_o, out_f


def injector_dp_ratio_penalty_from_results(
    results_layer2: Dict[str, Any],
    available_n: int,
    min_delta_p_over_pc: float = 0.15,
    max_delta_p_over_pc: Optional[float] = 0.50,
    scale: float = 400.0,
) -> float:
    """
    Penalize ΔP_inj / Pc outside an acceptable band (per time step, both streams).

    For each stream, ratio r = ΔP_inj / Pc. Violation is distance outside
    [min_delta_p_over_pc, max_delta_p_over_pc] (lower shortfall + upper excess).
    Per time step we take the worse of LOX and fuel, then average over steps.

    Typical guidance: keep injection drop large enough for atomization (~15–25% of Pc)
    but not so large that tank pressure is wasted; upper bound is tunable.

    If max_delta_p_over_pc is None, only the lower bound is enforced (legacy one-sided).
    """
    if available_n < 1 or "Pc" not in results_layer2:
        return 0.0
    lo = float(min_delta_p_over_pc)
    hi = float(max_delta_p_over_pc) if max_delta_p_over_pc is not None else None
    if hi is not None and hi < lo:
        hi = lo

    Pc_hist = np.atleast_1d(results_layer2["Pc"])[:available_n]
    diagnostics = results_layer2.get("diagnostics", [])
    if not isinstance(diagnostics, list):
        return 0.0

    violations: List[float] = []
    for i in range(available_n):
        Pc = float(Pc_hist[i])
        if not np.isfinite(Pc) or Pc <= 0:
            continue
        diag = diagnostics[i] if i < len(diagnostics) else {}
        dp_o, dp_f = _delta_p_injector_pair_from_diagnostic(diag)
        if dp_o is None or dp_f is None:
            continue
        r_o = dp_o / Pc
        r_f = dp_f / Pc

        def _band_violation(r: float) -> float:
            v = max(0.0, lo - r)
            if hi is not None:
                v += max(0.0, r - hi)
            return v

        v_o = _band_violation(r_o)
        v_f = _band_violation(r_f)
        violations.append(max(v_o, v_f))

    if not violations:
        return 0.0
    return float(np.mean(violations)) * scale


# Fixed segment configuration for Layer 2 optimization
# We use a shared-segment parameterization:
#   - Shared length ratios across LOX and fuel
#   - LOX end pressures and k are optimized directly
#   - Fuel end pressures are derived from LOX end pressures and a bounded
#     LOX/Fuel pressure-ratio factor per segment, keeping segment-end
#     pressure ratios within ±25% of the initial ratio.
N_SEGMENTS = 8
VARS_PER_SEGMENT = 5  # length_ratio, lox_end_pressure_ratio, lox_k, fuel_ratio_factor, fuel_k


def run_layer2a_minimum_pressures(
    optimized_config: PintleEngineConfig,
    initial_lox_pressure_pa: float,
    initial_fuel_pressure_pa: float,
    peak_thrust: float,
    target_apogee_m: float,
    rocket_dry_mass_kg: float,
    max_lox_tank_capacity_kg: float,
    max_fuel_tank_capacity_kg: float,
    target_burn_time: float,
    n_time_points: int = 100,
    update_progress: Optional[Callable] = None,
    log_status: Optional[Callable] = None,
    min_pressure_pa: float = 1e6,
    optimal_of_ratio: Optional[float] = None,
    min_stability_margin: Optional[float] = None,
) -> Tuple[float, float, Dict[str, Any], bool]:
    """
    Layer 2a: Find minimum allowable LOX and fuel tank pressures.

    This helper layer searches for the lowest *flat* tank pressures (same value
    over the full burn) that still satisfy the key constraints:
      - Required impulse to reach target apogee
      - Tank capacity limits
      - Stability margin
      - O/F ratio tolerance

    The LOX/Fuel tank pressure ratio is kept fixed to the initial ratio from
    Layer 1 by scaling both tanks by a common factor.

    Returns:
        Tuple of (min_lox_pressure_pa, min_fuel_pressure_pa, summary, success)
    """
    from scipy.integrate import cumulative_trapezoid

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Ensure output/logs directory exists
    output_logs_dir = Path(__file__).resolve().parents[3] / "output" / "logs"
    output_logs_dir.mkdir(parents=True, exist_ok=True)
    log_file_path = output_logs_dir / f"layer2a_min_pressure_{timestamp}.log"

    layer2a_logger = logging.getLogger("layer2a_min_pressure")
    layer2a_logger.setLevel(logging.INFO)
    layer2a_logger.handlers.clear()

    file_handler = logging.FileHandler(log_file_path, mode="w", encoding="utf-8")
    file_handler.setLevel(logging.INFO)
    file_formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
    file_handler.setFormatter(file_formatter)
    layer2a_logger.addHandler(file_handler)
    layer2a_logger.propagate = False

    layer2a_logger.info("=" * 70)
    layer2a_logger.info("Layer 2a: Minimum Tank Pressure Search")
    layer2a_logger.info("=" * 70)
    layer2a_logger.info(f"Log file: {log_file_path}")
    layer2a_logger.info(
        f"Initial LOX pressure: {initial_lox_pressure_pa/1e6:.2f} MPa "
        f"({initial_lox_pressure_pa/6894.76:.1f} psi)"
    )
    layer2a_logger.info(
        f"Initial Fuel pressure: {initial_fuel_pressure_pa/1e6:.2f} MPa "
        f"({initial_fuel_pressure_pa/6894.76:.1f} psi)"
    )
    layer2a_logger.info(f"Target burn time: {target_burn_time:.2f} s")
    layer2a_logger.info(f"Time points (Layer 2a): {n_time_points}")
    layer2a_logger.info("")

    # Disable ablative and graphite for this layer
    config_layer2a = copy.deepcopy(optimized_config)
    if hasattr(config_layer2a, "ablative_cooling") and config_layer2a.ablative_cooling:
        config_layer2a.ablative_cooling.enabled = False
    if hasattr(config_layer2a, "graphite_insert") and config_layer2a.graphite_insert:
        config_layer2a.graphite_insert.enabled = False

    runner_layer2a = PintleEngineRunner(config_layer2a)
    time_array = np.linspace(0.0, target_burn_time, n_time_points)

    initial_ratio = initial_lox_pressure_pa / max(initial_fuel_pressure_pa, 1e-9)

    def _evaluate_scale(scale: float) -> Tuple[bool, Dict[str, Any]]:
        """Return (passes_constraints, metrics) for a given common pressure scale."""
        P_lox = np.full(n_time_points, initial_lox_pressure_pa * scale)
        P_fuel = np.full(n_time_points, initial_fuel_pressure_pa * scale)

        # Enforce absolute minimum clamp
        P_lox = np.maximum(P_lox, min_pressure_pa)
        P_fuel = np.maximum(P_fuel, min_pressure_pa)

        try:
            results = runner_layer2a.evaluate_arrays_with_time(
                time_array,
                P_lox,
                P_fuel,
                track_ablative_geometry=False,
                use_coupled_solver=False,
            )
        except Exception as e:
            msg = f"Time-series solver failed at scale={scale:.3f}: {repr(e)}"
            layer2a_logger.error(msg)
            if log_status:
                log_status("Layer 2a Error", msg)
            return False, {}

        thrust_hist = np.atleast_1d(results.get("F", np.full(n_time_points, peak_thrust)))
        thrust_hist = thrust_hist[: n_time_points]
        time_hist = time_array[: thrust_hist.shape[0]]
        if thrust_hist.shape[0] < 2:
            return False, {}

        mdot_O_hist = np.atleast_1d(results.get("mdot_O", np.zeros_like(time_hist)))
        mdot_F_hist = np.atleast_1d(results.get("mdot_F", np.zeros_like(time_hist)))
        mdot_O_hist = mdot_O_hist[: time_hist.shape[0]]
        mdot_F_hist = mdot_F_hist[: time_hist.shape[0]]

        total_lox_mass = float(np.trapezoid(mdot_O_hist, time_hist))
        total_fuel_mass = float(np.trapezoid(mdot_F_hist, time_hist))
        total_propellant_mass = total_lox_mass + total_fuel_mass

        effective_burn_time = effective_burn_time_for_layer2_objective(
            time_hist, mdot_O_hist, mdot_F_hist, target_burn_time
        )
        required_impulse = calculate_required_impulse_from_mass(
            target_apogee_m,
            rocket_dry_mass_kg,
            total_propellant_mass,
            effective_burn_time,
        )
        total_impulse = float(np.trapezoid(thrust_hist, time_hist))

        # Constraint 1: Impulse
        passes_impulse = total_impulse >= required_impulse

        # Constraint 2: Tank capacities
        passes_lox_capacity = total_lox_mass <= max_lox_tank_capacity_kg * 1.001
        passes_fuel_capacity = total_fuel_mass <= max_fuel_tank_capacity_kg * 1.001

        # Constraint 3: Stability
        chugging_margins = results.get("chugging_stability_margin", None)
        if chugging_margins is not None:
            min_chugging = float(np.min(np.atleast_1d(chugging_margins)))
        else:
            min_chugging = 1.0

        if min_stability_margin is not None:
            passes_stability = min_chugging >= min_stability_margin
        else:
            passes_stability = min_chugging >= 0.7

        # Constraint 4: O/F ratio
        if optimal_of_ratio is not None:
            MR_hist = np.atleast_1d(results.get("MR", np.full_like(time_hist, optimal_of_ratio)))
            MR_hist = MR_hist[: time_hist.shape[0]]
            # Pointwise relative error
            MR_errors = np.abs(MR_hist - optimal_of_ratio) / max(optimal_of_ratio, 1e-9)
            # Check maximum deviation (must be within 20% at all points)
            max_MR_error = float(np.max(MR_errors))
            passes_of = max_MR_error <= 0.20
        else:
            raise ValueError("optimal_of_ratio must be provided")

        passes = passes_impulse and passes_lox_capacity and passes_fuel_capacity and passes_stability and passes_of

        metrics = {
            "scale": scale,
            "P_lox_flat_pa": float(P_lox[0]),
            "P_fuel_flat_pa": float(P_fuel[0]),
            "total_impulse": total_impulse,
            "required_impulse": required_impulse,
            "total_lox_mass": total_lox_mass,
            "total_fuel_mass": total_fuel_mass,
            "min_chugging": min_chugging,
            "initial_ratio": initial_ratio,
        }
        return passes, metrics

    # Search bounds: keep above absolute minimum and below initial pressures.
    scale_high = 1.0
    # Ensure neither tank drops below min_pressure_pa
    scale_low_lox = min_pressure_pa / max(initial_lox_pressure_pa, 1e-9)
    scale_low_fuel = min_pressure_pa / max(initial_fuel_pressure_pa, 1e-9)
    scale_low = max(scale_low_lox, scale_low_fuel)
    scale_low = min(scale_low, scale_high)

    # First check if even the initial pressures meet constraints
    passes_high, high_metrics = _evaluate_scale(scale_high)
    if not passes_high:
        layer2a_logger.warning(
            "Initial pressures do not satisfy constraints; using initial pressures as minima."
        )
        summary = {
            "min_lox_pressure_pa": float(initial_lox_pressure_pa),
            "min_fuel_pressure_pa": float(initial_fuel_pressure_pa),
            "scale": 1.0,
            "success": False,
        }
        layer2a_logger.handlers.clear()
        return initial_lox_pressure_pa, initial_fuel_pressure_pa, summary, False

    # If the lowest feasible scale also passes, we can use that directly.
    passes_low, low_metrics = _evaluate_scale(scale_low)
    if passes_low:
        min_lox = low_metrics["P_lox_flat_pa"]
        min_fuel = low_metrics["P_fuel_flat_pa"]
        summary = {
            "min_lox_pressure_pa": min_lox,
            "min_fuel_pressure_pa": min_fuel,
            "scale": scale_low,
            "success": True,
        }
        layer2a_logger.handlers.clear()
        return min_lox, min_fuel, summary, True

    # Otherwise, binary search between scale_low and 1.0
    left = scale_low
    right = scale_high
    best_scale = scale_high
    best_metrics = high_metrics

    for _ in range(10):
        mid = 0.5 * (left + right)
        passes_mid, mid_metrics = _evaluate_scale(mid)
        if passes_mid:
            best_scale = mid
            best_metrics = mid_metrics
            right = mid
        else:
            left = mid

    min_lox = best_metrics["P_lox_flat_pa"]
    min_fuel = best_metrics["P_fuel_flat_pa"]

    summary = {
        "min_lox_pressure_pa": min_lox,
        "min_fuel_pressure_pa": min_fuel,
        "scale": best_scale,
        "success": True,
    }

    # Clean up logger handlers
    layer2a_logger.handlers.clear()

    return min_lox, min_fuel, summary, True


def run_layer2_pressure(
    optimized_config: PintleEngineConfig,
    initial_lox_pressure_pa: float,
    initial_fuel_pressure_pa: float,
    peak_thrust: float,  # Initial/peak thrust target
    target_apogee_m: float,  # Target apogee for impulse calculation
    rocket_dry_mass_kg: float,  # Rocket dry mass (no propellant) = airframe + engine + lox_tank_structure + fuel_tank_structure + copv_structure
    max_lox_tank_capacity_kg: float,  # Maximum LOX tank capacity [kg]
    max_fuel_tank_capacity_kg: float,  # Maximum fuel tank capacity [kg]
    target_burn_time: float,
    n_time_points: int = 200,
    update_progress: Optional[Callable] = None,
    log_status: Optional[Callable] = None,
    min_pressure_pa: float = 1e6,  # Legacy absolute minimum clamp (~150 psi)
    optimal_of_ratio: Optional[float] = None,  # Target O/F ratio for validation
    min_stability_margin: Optional[float] = None,  # Minimum stability margin
    max_iterations: int = 20,  # Maximum optimization iterations (reduced from 30 for faster convergence)
    max_evaluations: Optional[int] = None,  # Maximum function evaluations (None = unlimited)
    save_evaluation_plots: bool = False,  # Save PNG plots of each evaluation's pressure curves
    min_lox_pressure_floor_pa: Optional[float] = None,
    min_fuel_pressure_floor_pa: Optional[float] = None,
    min_pressure_slope_psi_per_sec: float = -25.0,  # Minimum pressure decrease rate [psi/s] (negative = decreasing)
    objective_callback: Optional[Callable[[int, float, float], None]] = None,  # Optional hook for streaming objective history
    pressure_curve_callback: Optional[Callable[[np.ndarray, np.ndarray, np.ndarray, Optional[np.ndarray], Optional[np.ndarray]], None]] = None,  # Optional hook for streaming best pressure curves (time, P_lox, P_fuel, copv_pressure, copv_time)
    stop_event: Optional[Any] = None,  # threading.Event for stop signal
    de_maxiter: int = 5,  # Reduced from 10 for faster execution
    de_popsize: int = 2,  # Reduced from 5 for faster execution
    de_n_time_points: int = 25,  # Reduced from 50 for faster execution
    use_controller_simulation: bool = False,  # Toggle for robust DDP controller feasibility penalty
    controller_config: Optional[Any] = None,  # ControllerConfig instance if available
    disable_impulse_requirement: bool = False,  # Skip impulse-vs-apogee penalty (avoids short-burn incentive)
) -> Tuple[PintleEngineConfig, np.ndarray, np.ndarray, np.ndarray, Dict[str, Any], bool]:
    """
    Run Layer 2: Pressure Curve Optimization.
    
    Optimizes fuel and oxidizer pressure curves (200-point arrays) for time series solver.
    - Uses a fixed number of segments per tank (N_SEGMENTS)
    - Each segment can be linear or blowdown with parameters:
        - length_ratio, type, end_pressure_ratio, k
    - First performs a global search (differential_evolution), then local polish (L-BFGS-B)
    
    Returns:
        Tuple of (optimized_config, time_array, P_tank_O_array, P_tank_F_array, summary, success)
    """
    from scipy.optimize import minimize as scipy_minimize, differential_evolution
    from scipy.integrate import cumulative_trapezoid
    
    # Resolve per-tank minimum pressure floors.
    # If not provided, fall back to the legacy shared min_pressure_pa.
    if min_lox_pressure_floor_pa is None:
        min_lox_pressure_floor_pa = float(min_pressure_pa)
    if min_fuel_pressure_floor_pa is None:
        min_fuel_pressure_floor_pa = float(min_pressure_pa)

    # Set up Layer 2 logging
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Ensure output/logs directory exists
    output_logs_dir = Path(__file__).resolve().parents[3] / "output" / "logs"
    output_logs_dir.mkdir(parents=True, exist_ok=True)
    log_file_path = output_logs_dir / f"layer2_pressure_{timestamp}.log"
    
    # Create logger for Layer 2
    layer2_logger = logging.getLogger('layer2_pressure')
    layer2_logger.setLevel(logging.INFO)
    

    layer2_logger.handlers.clear()
    
    # File handler
    file_handler = logging.FileHandler(log_file_path, mode='w', encoding='utf-8')
    file_handler.setLevel(logging.INFO)
    file_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    file_handler.setFormatter(file_formatter)
    layer2_logger.addHandler(file_handler)
    
    # Prevent propagation to root logger
    layer2_logger.propagate = False
    
    layer2_logger.info("="*70)
    layer2_logger.info("Layer 2: Pressure Curve Optimization")
    layer2_logger.info("="*70)
    layer2_logger.info(f"Log file: {log_file_path}")
    layer2_logger.info(f"Initial LOX pressure: {initial_lox_pressure_pa/1e6:.2f} MPa ({initial_lox_pressure_pa/6894.76:.1f} psi)")
    layer2_logger.info(f"Initial Fuel pressure: {initial_fuel_pressure_pa/1e6:.2f} MPa ({initial_fuel_pressure_pa/6894.76:.1f} psi)")
    layer2_logger.info(f"Peak thrust target: {peak_thrust:.1f} N")
    layer2_logger.info(f"Target apogee: {target_apogee_m:.0f} m")
    layer2_logger.info(f"Rocket dry mass: {rocket_dry_mass_kg:.2f} kg")
    layer2_logger.info(f"Target burn time: {target_burn_time:.2f} s")
    layer2_logger.info(f"Time points: {n_time_points}")
    layer2_logger.info(f"DE parameters: maxiter={de_maxiter}, popsize={de_popsize}, n_time_points={de_n_time_points}")
    layer2_logger.info(f"Minimum pressure slope: {min_pressure_slope_psi_per_sec:.1f} psi/s")
    if optimal_of_ratio is not None:
        layer2_logger.info(f"Target O/F ratio: {optimal_of_ratio:.2f}")
    if min_stability_margin is not None:
        layer2_logger.info(f"Min stability margin: {min_stability_margin:.3f}")
    if disable_impulse_requirement:
        layer2_logger.info("Impulse requirement: DISABLED (impulse penalty zeroed)")
    layer2_logger.info("")
    
    # Set up evaluation plot file if requested
    evaluation_plot_file = None
    if save_evaluation_plots:
        evaluation_plot_file = Path(f"layer2_evaluation_plot_{timestamp}.png")
        layer2_logger.info(f"Saving evaluation plots to: {evaluation_plot_file}")
    
    # Generate time arrays (Layer 1 doesn't provide this)
    # - Full-resolution array for local optimization and final evaluation
    # - Coarser array for the global DE search to speed up evaluations
    time_array = np.linspace(0.0, target_burn_time, n_time_points)
    n_time_points_de = min(de_n_time_points, n_time_points)
    time_array_de = np.linspace(0.0, target_burn_time, n_time_points_de)
    
    def save_evaluation_plot(
        eval_num: int,
        time_arr: np.ndarray,
        P_lox: np.ndarray,
        P_fuel: np.ndarray,
        objective: Optional[float] = None,
        n_seg_lox: Optional[int] = None,
        n_seg_fuel: Optional[int] = None,
    ):
        """Save a plot of the pressure curves for this evaluation (overwrites previous plot)."""
        if evaluation_plot_file is None:
            return
        
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 8))
        
        # Plot 1: Pressure in PSI
        ax1.plot(time_arr, P_lox / 6894.76, 'b-', linewidth=2, label='LOX Tank')
        ax1.plot(time_arr, P_fuel / 6894.76, 'r-', linewidth=2, label='Fuel Tank')
        ax1.set_xlabel('Time [s]')
        ax1.set_ylabel('Tank Pressure [psi]')
        ax1.set_title(f'Evaluation #{eval_num} Pressure Curves')
        ax1.grid(True, alpha=0.3)
        ax1.legend()
        
        # Plot 2: Pressure in MPa
        ax2.plot(time_arr, P_lox / 1e6, 'b-', linewidth=2, label='LOX Tank')
        ax2.plot(time_arr, P_fuel / 1e6, 'r-', linewidth=2, label='Fuel Tank')
        ax2.set_xlabel('Time [s]')
        ax2.set_ylabel('Tank Pressure [MPa]')
        
        # Add info text
        info_text = f"Eval #{eval_num}"
        if n_seg_lox is not None:
            info_text += f" | LOX: {n_seg_lox} seg"
        if n_seg_fuel is not None:
            info_text += f" | Fuel: {n_seg_fuel} seg"
        if objective is not None:
            info_text += f"\nObjective: {objective:.6f}"
        
        ax2.text(0.02, 0.98, info_text, transform=ax2.transAxes,
                verticalalignment='top', bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5),
                fontsize=9, family='monospace')
        
        ax2.grid(True, alpha=0.3)
        ax2.legend()
        
        plt.tight_layout()
        
        # Save plot (overwrites previous)
        plt.savefig(evaluation_plot_file, dpi=100, bbox_inches='tight')
        plt.close(fig)  # Close to free memory
    
    # Disable ablative and graphite for this layer
    config_layer2 = copy.deepcopy(optimized_config)
    if hasattr(config_layer2, 'ablative_cooling') and config_layer2.ablative_cooling:
        config_layer2.ablative_cooling.enabled = False
    if hasattr(config_layer2, 'graphite_insert') and config_layer2.graphite_insert:
        config_layer2.graphite_insert.enabled = False

    # Create a single PintleEngineRunner instance for this layer and reuse it
    runner_layer2 = PintleEngineRunner(config_layer2)
    
    # Calculate initial chamber pressure to establish stability floor
    try:
        res_init = runner_layer2.evaluate(
             initial_lox_pressure_pa, 
             initial_fuel_pressure_pa, 
             silent=True
        )
        Pc_initial_ref = res_init.get("Pc", 0.0)
    except Exception:
        Pc_initial_ref = 0.0
        
    # Enforce stability constraint (75% of initial Pc) on pressure generation
    safe_pressure_floor = 0.75 * Pc_initial_ref
    
    # Update floors if the stability requirement is stricter (higher) than the default
    local_min_lox_floor = max(min_lox_pressure_floor_pa, safe_pressure_floor)
    local_min_fuel_floor = max(min_fuel_pressure_floor_pa, safe_pressure_floor)
    
    layer2_logger.info(f"Stability Constraint: Pc_initial={Pc_initial_ref/1e6:.2f} MPa, Min Safe Pressure={safe_pressure_floor/1e6:.2f} MPa")
    if local_min_lox_floor > min_lox_pressure_floor_pa:
         layer2_logger.info(f"  -> Adjusted LOX floor to {local_min_lox_floor/1e6:.2f} MPa")
    if local_min_fuel_floor > min_fuel_pressure_floor_pa:
         layer2_logger.info(f"  -> Adjusted Fuel floor to {local_min_fuel_floor/1e6:.2f} MPa")
    
    # Optimization variables:
    # Shared-segment parameterization with fixed N_SEGMENTS segments:
    #   - Shared length ratios across LOX and fuel
    #   - LOX end pressures and k are optimized directly
    #   - Fuel end pressures are derived from LOX end pressures and a bounded
    #     LOX/Fuel pressure-ratio factor per segment, keeping segment-end
    #     pressure ratios within ±25% of the initial ratio.
    #
    # x_layer2 format (per segment, in order):
    #   - length_ratio          (0-1, shared LOX/Fuel segment length)
    #   - lox_end_pressure_ratio (0-1, relative to initial LOX tank pressure)
    #   - lox_k                 (0-2, LOX blowdown parameter)
    #   - fuel_ratio_factor     (~0.75-1.25, multiplies initial LOX/Fuel ratio)
    #   - fuel_k                (0-2, fuel blowdown parameter)

    def build_x0_compact() -> np.ndarray:
        x: list[float] = []
        initial_ratio = initial_lox_pressure_pa / max(initial_fuel_pressure_pa, 1e-9)
        # Initialize segments with shared lengths, gently decaying LOX pressure,
        # and fuel following the initial LOX/Fuel ratio (ratio_factor ~= 1.0).
        for i in range(N_SEGMENTS):
            length_ratio = 1.0 / N_SEGMENTS
            lox_end_ratio = 0.9 - 0.3 * (i / max(N_SEGMENTS - 1, 1))  # monotone decreasing guess
            lox_k = 0.3
            fuel_ratio_factor = 1.0  # start near initial pressure ratio
            fuel_k = 0.3
            x.extend([length_ratio, lox_end_ratio, lox_k, fuel_ratio_factor, fuel_k])
        return np.array(x, dtype=float)

    x0 = build_x0_compact()

    # Bounds for compact vector (per segment)
    # Bounds for compact vector (per segment)
    bounds: list[tuple[float, float]] = []
    
    # Calculate minimum LOX pressure ratio to respect stability constraint
    # We want P_lox_end >= safe_pressure_floor
    # implies ratio >= safe_pressure_floor / initial_lox
    min_lox_ratio_bound = 0.1
    if initial_lox_pressure_pa > 0:
        min_lox_ratio_bound = max(0.1, safe_pressure_floor / initial_lox_pressure_pa)
    
    # Clamp to ensure it doesn't exceed 1.0 (though that would mean impossible constraint)
    min_lox_ratio_bound = min(min_lox_ratio_bound, 0.99)

    for _ in range(N_SEGMENTS):
        bounds.append((0.01, 1.0))   # length_ratio (shared LOX/Fuel)
        bounds.append((min_lox_ratio_bound, 1.0))    # lox_end_pressure_ratio (constrained)
        bounds.append((0.1, 2.0))    # lox_k
        bounds.append((0.75, 1.25))  # fuel_ratio_factor (keeps segment-end ratios within ±25%)
        bounds.append((0.1, 2.0))    # fuel_k
    
    # Track optimization progress
    layer2_state = {
        "iter": 0,
        "max_iter": max_iterations,
        "best_obj": float("inf"),
        "best_x": None,  # Track the X vector corresponding to best_obj
        "last_obj": None,
        "prev_obj": None,  # Track previous objective for rate of change
        "eval_count": 0,
        "start_time": time.time(),
        "converged": False,  # Track if we've effectively converged
        "no_improvement_count": 0,  # Count iterations without significant improvement
        "small_change_count": 0,  # Count iterations with very small rate of change
        "identical_obj_count": 0,  # Count consecutive evaluations with identical objective
        "last_identical_obj": None,  # Track the objective value that's repeating
        "de_candidates": [],  # Store candidates found during DE for re-scoring
    }
    
    def layer2_callback(xk):
        # Determine which optimizer phase we're in ("DE" or "local").
        # NOTE: SciPy callbacks only receive xk, so we persist phase in layer2_state.
        phase = layer2_state.get("phase", "local")

        # Check if stop was requested
        if stop_event is not None and stop_event.is_set():
            layer2_state["converged"] = True
            layer2_state["stopped_by_user"] = True
            if not layer2_state.get("stop_logged", False):
                layer2_logger.info("⚠ Stop requested by user during local optimization")
                layer2_state["stop_logged"] = True
                for handler in layer2_logger.handlers:
                    handler.flush()
            return True  # Signal optimizer to stop
        
        layer2_state["iter"] += 1
        frac = min(layer2_state["iter"] / max(layer2_state["max_iter"], 1), 1.0)
        progress_pct = int(frac * 100)
        elapsed = time.time() - layer2_state["start_time"]
        
        # Check for convergence based on rate of change (regardless of absolute objective value)
        if layer2_state["last_obj"] is not None and layer2_state["prev_obj"] is not None:
            # Calculate relative rate of change
            current_obj = layer2_state["last_obj"]
            prev_obj = layer2_state["prev_obj"]
            
            # Check for EXACT identical values (common when stuck in flat region)
            if abs(current_obj - prev_obj) < 1e-10:
                # Exact match or extremely close (within numerical precision)
                if layer2_state["last_identical_obj"] is not None:
                    if abs(current_obj - layer2_state["last_identical_obj"]) < 1e-10:
                        layer2_state["identical_obj_count"] += 1
                    else:
                        # Different identical value - reset counter
                        layer2_state["identical_obj_count"] = 1
                        layer2_state["last_identical_obj"] = current_obj
                else:
                    layer2_state["identical_obj_count"] = 1
                    layer2_state["last_identical_obj"] = current_obj
                
                # If we've had 5+ consecutive identical evaluations, we're stuck
                if layer2_state["identical_obj_count"] >= 5:
                    layer2_state["converged"] = True
                    layer2_logger.info(
                        f"✓ Early convergence detected: objective is identical across "
                        f"{layer2_state['identical_obj_count']} consecutive evaluations "
                        f"(obj={current_obj:.6f}). Optimizer appears stuck in flat region."
                    )
            else:
                # Not identical - reset identical counter
                layer2_state["identical_obj_count"] = 0
                layer2_state["last_identical_obj"] = None
            
            # Relative change: |current - previous| / max(|current|, |previous|, small_epsilon)
            abs_change = abs(current_obj - prev_obj)
            max_magnitude = max(abs(current_obj), abs(prev_obj), 1e-9)
            relative_change = abs_change / max_magnitude
            
            # If relative change is very small (< 0.1% or < 1e-4 absolute), count it
            if relative_change < 1e-3 or abs_change < 1e-4:
                layer2_state["small_change_count"] += 1
            else:
                layer2_state["small_change_count"] = 0  # Reset if we see meaningful change
            
            # If we've had 3+ consecutive iterations with very small rate of change, we've converged
            # Only apply this aggressive check during DE. Local optimizer needs to probe close points.
            if phase == "DE" and layer2_state["small_change_count"] >= 3 and not layer2_state["converged"]:
                layer2_state["converged"] = True
                layer2_logger.info(
                    f"✓ Early convergence detected: objective rate of change is negligible "
                    f"(relative change < 0.1% for {layer2_state['small_change_count']} iterations). "
                    f"Best objective: {layer2_state['best_obj']:.6f}, "
                    f"Current: {current_obj:.6f}, Change: {abs_change:.2e} ({relative_change*100:.4f}%)"
                )
        
        # Also check for convergence: if objective is very low and hasn't improved much (legacy check)
        if layer2_state["last_obj"] is not None and not layer2_state["converged"]:
            # If objective is already very good (< 0.1), check if we've converged
            if layer2_state["best_obj"] < 2.0:
                # Check if improvement in last iteration was negligible
                if layer2_state["last_obj"] is not None and layer2_state["best_obj"] is not None:
                    improvement = layer2_state["best_obj"] - layer2_state["last_obj"]
                    if improvement < 1e-5:  # Very small improvement
                        layer2_state["no_improvement_count"] += 1
                    else:
                        layer2_state["no_improvement_count"] = 0
                    
                    # If we've had 3+ iterations with no significant improvement and objective is already very low
                    if layer2_state["no_improvement_count"] >= 3 and layer2_state["best_obj"] < 2.0:
                        layer2_state["converged"] = True
                        layer2_logger.info(
                            f"✓ Early convergence detected: objective {layer2_state['best_obj']:.6f} "
                            f"has not improved significantly in {layer2_state['no_improvement_count']} iterations"
                        )
        
        # Log progress
        if layer2_state["last_obj"] is not None:
            layer2_logger.info(f"[{progress_pct}%] Iteration {layer2_state['iter']}/{layer2_state['max_iter']} "
                            f"({elapsed:.1f}s elapsed) - "
                            f"Objective: {layer2_state['last_obj']:.6f} (Best: {layer2_state['best_obj']:.6f})")
        else:
            layer2_logger.info(f"[{progress_pct}%] Iteration {layer2_state['iter']}/{layer2_state['max_iter']} "
                            f"({elapsed:.1f}s elapsed)")
        
        # Flush log to ensure it's written immediately
        for handler in layer2_logger.handlers:
            handler.flush()
        
        # Call external progress callback if provided
        if update_progress:
            progress = 0.60 + 0.04 * frac
            update_progress(
                "Layer 2: Pressure Curve Optimization",
                progress,
                f"Layer 2 optimization {layer2_state['iter']}/{layer2_state['max_iter']} ({progress_pct}%)",
            )
    
    def decode_segments_from_x(
        x_layer2: np.ndarray,
        n_segments: int,
        initial_lox_p: float,
        initial_fuel_p: float,
        min_lox_p: float,
        min_fuel_p: float,
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Decode the compact optimization vector into LOX and fuel segment lists.
        
        - Shared length ratios across LOX and fuel
        - LOX end pressures and k are optimized directly
        - Fuel end pressures are derived from LOX end pressures and a bounded
          LOX/Fuel pressure-ratio factor per segment, keeping segment-end
          pressure ratios within ±25% of the initial ratio.
        """
        segments_lox: List[Dict[str, Any]] = []
        segments_fuel: List[Dict[str, Any]] = []
        
        # Ensure we don't request more segments than available in x
        max_segments = len(x_layer2) // VARS_PER_SEGMENT
        n_segments = min(n_segments, max_segments)
        if n_segments < 1:
            n_segments = 1
        
        # Normalize shared length ratios
        raw_lengths: List[float] = []
        for i in range(n_segments):
            base = i * VARS_PER_SEGMENT
            if base >= len(x_layer2):
                break
            lr_raw = float(x_layer2[base])
            if not np.isfinite(lr_raw):
                # Non-finite length variables are treated as a neutral default.
                # This keeps the decode step numerically robust; the associated
                # candidate will still be scored poorly in the objective.
                lr_raw = 1.0
            lr = float(np.clip(lr_raw, 0.01, 1.0))
            raw_lengths.append(lr)
        
        total_lr = float(sum(raw_lengths)) if raw_lengths else 1.0
        # Guard against numerical edge cases (e.g., all zeros or non-finite sum).
        if not np.isfinite(total_lr) or total_lr <= 0:
            total_lr = 1.0
        length_ratios = [lr / total_lr for lr in raw_lengths] if raw_lengths else [1.0]
        
        # Build LOX and fuel segments
        prev_lox_end = initial_lox_p
        prev_fuel_end = initial_fuel_p
        initial_ratio = initial_lox_p / max(initial_fuel_p, 1e-9)
        
        for i in range(n_segments):
            base = i * VARS_PER_SEGMENT
            if base + 4 >= len(x_layer2):
                break
            
            length_ratio = length_ratios[i] if i < len(length_ratios) else 1.0 / n_segments
            
            # Calculate segment time duration for slope enforcement
            segment_time_duration = length_ratio * target_burn_time  # seconds
            
            # LOX end pressure ratio and k
            lox_end_ratio_raw = float(np.clip(x_layer2[base + 1], 0.1, 1.0))
            start_ratio_lox = prev_lox_end / max(initial_lox_p, 1e-9)
            
            # Enforce minimum slope constraint (time-based)
            # Calculate minimum pressure drop based on time and slope requirement
            # min_pressure_slope_psi_per_sec is negative (pressure decreasing), so we use abs()
            min_pressure_drop_pa = abs(min_pressure_slope_psi_per_sec) * 6894.76 * segment_time_duration
            
            # Calculate maximum allowed end pressure (start - minimum drop)
            max_allowed_end_pressure_lox = prev_lox_end - min_pressure_drop_pa
            
            # Convert to ratio relative to initial pressure
            max_allowed_end_ratio_lox = max_allowed_end_pressure_lox / max(initial_lox_p, 1e-9)
            
            # Enforce both the optimizer's choice and the minimum slope
            # Also keep the old 0.99 constraint as an upper bound (less restrictive fallback)
            lox_end_ratio = min(lox_end_ratio_raw, start_ratio_lox * 0.99, max_allowed_end_ratio_lox)
            
            lox_end_p = initial_lox_p * lox_end_ratio
            # Ensure monotonic decrease and enforce LOX minimum floor.
            lox_end_p = max(min_lox_p, min(lox_end_p, prev_lox_end))
            lox_k = float(np.clip(x_layer2[base + 2], 0.1, 2.0))
            
            # Fuel ratio factor (keeps segment-end ratio within ±25% of initial)
            fuel_ratio_factor = float(np.clip(x_layer2[base + 3], 0.75, 1.25))
            seg_ratio = initial_ratio * fuel_ratio_factor
            fuel_end_p = lox_end_p / max(seg_ratio, 1e-9)
            
            # Apply same minimum slope constraint to fuel
            max_allowed_end_pressure_fuel = prev_fuel_end - min_pressure_drop_pa
            # Ensure fuel end pressure respects both the ratio-based calculation and minimum slope
            fuel_end_p = min(fuel_end_p, max_allowed_end_pressure_fuel)
            
            # Ensure monotonic decrease and enforce fuel minimum floor.
            fuel_end_p = max(min_fuel_p, min(fuel_end_p, prev_fuel_end))
            fuel_k = float(np.clip(x_layer2[base + 4], 0.1, 2.0))

            
            seg_lox = {
                "length_ratio": length_ratio,
                "type": "blowdown",
                "start_pressure": prev_lox_end,
                "end_pressure": lox_end_p,
                "k": lox_k,
            }
            seg_fuel = {
                "length_ratio": length_ratio,
                "type": "blowdown",
                "start_pressure": prev_fuel_end,
                "end_pressure": fuel_end_p,
                "k": fuel_k,
            }
            segments_lox.append(seg_lox)
            segments_fuel.append(seg_fuel)
            prev_lox_end = lox_end_p
            prev_fuel_end = fuel_end_p
        
        return segments_lox, segments_fuel

    def layer2_objective(
        x_layer2,
        time_eval_override: Optional[np.ndarray] = None,
        n_points: Optional[int] = None,
        phase: str = "local",
    ):
        """Optimize pressure curves after initial point. Initial pressures are fixed from Layer 1.
        
        Args:
            x_layer2: Optimization variable vector.
            time_eval_override: Optional time array to use for this evaluation
                (e.g., coarse grid for DE). If None, uses the full-resolution
                `time_array` defined above.
            n_points: Optional number of time points. If None, uses the global
                `n_time_points` defined above.
            phase: Short label for logging (e.g., "DE" or "local").
        """
        # Persist phase for any external callbacks (SciPy callback only gets xk).
        layer2_state["phase"] = phase

        # Check if stop was requested before starting evaluation
        if stop_event is not None and stop_event.is_set():
            # User requested stop - return best objective found so far to signal convergence
            best_obj = layer2_state.get("best_obj", 1e6)
            layer2_state["converged"] = True
            layer2_state["stopped_by_user"] = True
            if not layer2_state.get("stop_logged", False):
                layer2_logger.info("⚠ Stop requested by user - halting optimization")
                layer2_state["stop_logged"] = True
                for handler in layer2_logger.handlers:
                    handler.flush()
            return float(best_obj) if np.isfinite(best_obj) else 1e6
        
        eval_start_time = time.time()
        layer2_state["eval_count"] += 1
        eval_num = layer2_state["eval_count"]

        def finish_evaluation(final_obj: float) -> float:
            """Helper to finalize evaluation: update state, call callbacks, and return value."""
            # Save previous values before updating
            prev_obj = layer2_state.get("prev_obj")
            last_obj = layer2_state.get("last_obj")
            
            # Update best objective if this is an improvement
            # (Note: failed evaluations with 1e6 usually won't be improvements, but we check anyway)
            improvement = None
            if final_obj < layer2_state["best_obj"]:
                improvement = layer2_state["best_obj"] - final_obj
                layer2_state["best_obj"] = final_obj
                # Save the X vector if it's an improvement (and finite)
                # Note: x_layer2 comes from the outer scope
                if np.all(np.isfinite(np.asarray(x_layer2, dtype=float))):
                    layer2_state["best_x"] = np.array(x_layer2, copy=True)
                
                # Reset convergence counters if we made significant progress
                if improvement > 1e-5:
                    layer2_state["no_improvement_count"] = 0
                    layer2_state["small_change_count"] = 0
                    layer2_state["identical_obj_count"] = 0
                    layer2_state["last_identical_obj"] = None
            
            # Update last objective for logging/progress tracking
            layer2_state["prev_obj"] = last_obj
            layer2_state["last_obj"] = final_obj
            
            # Check for convergence (works for both DE and local phases)
            # This check happens after updating state so we can compare current vs previous
            if not layer2_state.get("converged", False) and last_obj is not None:
                current_obj = final_obj
                
                # Check for EXACT identical values (common when stuck in flat region)
                if abs(current_obj - last_obj) < 1e-10:
                    if layer2_state["last_identical_obj"] is not None:
                        if abs(current_obj - layer2_state["last_identical_obj"]) < 1e-10:
                            layer2_state["identical_obj_count"] += 1
                        else:
                            layer2_state["identical_obj_count"] = 1
                            layer2_state["last_identical_obj"] = current_obj
                    else:
                        layer2_state["identical_obj_count"] = 1
                        layer2_state["last_identical_obj"] = current_obj
                    
                    # If we've had 5+ consecutive identical evaluations, we're stuck
                    if layer2_state["identical_obj_count"] >= 5:
                        layer2_state["converged"] = True
                        layer2_logger.info(
                            f"✓ Early convergence detected [{phase}]: objective is identical across "
                            f"{layer2_state['identical_obj_count']} consecutive evaluations "
                            f"(obj={current_obj:.6f}). Optimizer appears stuck in flat region."
                        )
                        for handler in layer2_logger.handlers:
                            handler.flush()
                else:
                    # Not identical - reset identical counter
                    layer2_state["identical_obj_count"] = 0
                    layer2_state["last_identical_obj"] = None
                
                # Relative change: |current - previous| / max(|current|, |previous|, small_epsilon)
                abs_change = abs(current_obj - last_obj)
                max_magnitude = max(abs(current_obj), abs(last_obj), 1e-9)
                relative_change = abs_change / max_magnitude
                
                # If relative change is very small (< 0.1% or < 1e-4 absolute), count it
                if relative_change < 1e-3 or abs_change < 1e-4:
                    layer2_state["small_change_count"] += 1
                else:
                    layer2_state["small_change_count"] = 0  # Reset if we see meaningful change
                
                # If we've had 3+ consecutive iterations with very small rate of change, we've converged
                if layer2_state["small_change_count"] >= 3:
                    layer2_state["converged"] = True
                    layer2_logger.info(
                        f"✓ Early convergence detected [{phase}]: objective rate of change is negligible "
                        f"(relative change < 0.1% for {layer2_state['small_change_count']} iterations). "
                        f"Best objective: {layer2_state['best_obj']:.6f}, "
                        f"Current: {current_obj:.6f}, Change: {abs_change:.2e} ({relative_change*100:.4f}%)"
                    )
                    for handler in layer2_logger.handlers:
                        handler.flush()
                
                # Also check for convergence: if objective is very low and hasn't improved much
                # Only apply this aggressive check during DE (Global Search).
                # Local optimization (L-BFGS-B) needs to probe worse points for gradient estimation,
                # so we shouldn't kill it just because it hasn't improved in 3 evaluations.
                if phase == "DE" and layer2_state["best_obj"] < 2.0:
                    # Check if best hasn't improved relative to previous best
                    if improvement is None or improvement < 1e-5:  # Very small or no improvement
                        layer2_state["no_improvement_count"] += 1
                    else:
                        layer2_state["no_improvement_count"] = 0
                    
                    # If we've had 3+ iterations with no significant improvement and objective is already very low
                    if layer2_state["no_improvement_count"] >= 3:
                        layer2_state["converged"] = True
                        layer2_logger.info(
                            f"✓ Early convergence detected [{phase}]: objective {layer2_state['best_obj']:.6f} "
                            f"has not improved significantly in {layer2_state['no_improvement_count']} iterations"
                        )
                        for handler in layer2_logger.handlers:
                            handler.flush()
            
            # Check if we've already converged (from callback or objective function) - log if this happens
            if layer2_state.get("converged", False):
                # This evaluation happened after convergence was detected
                # The optimizer should stop soon, but we'll let it finish this evaluation
                pass
            
            # Capture candidates during Global Search (DE) phase for Top-K re-scoring
            if phase == "DE" and np.isfinite(final_obj) and final_obj < 1e5:
                # Store copy of x to avoid mutation issues
                if np.all(np.isfinite(np.asarray(x_layer2, dtype=float))):
                    layer2_state.setdefault("de_candidates", []).append((float(final_obj), np.array(x_layer2, copy=True)))
            
            # Update stream of objective history
            if objective_callback is not None:
                try:
                    objective_callback(
                        int(layer2_state["eval_count"]),
                        float(final_obj),
                        float(layer2_state["best_obj"]),
                    )
                except Exception:
                    # Never let UI/consumer callback break the optimizer loop
                    pass
            
            return float(final_obj)

        # Ensure the optimization vector is finite. If any component is NaN or
        # Inf, treat this candidate as invalid and return a large penalty so
        # the optimizer moves away from this region instead of propagating
        # non-finite values into the segment decode / pressure generation.
        x_layer2 = np.asarray(x_layer2, dtype=float)
        if not np.all(np.isfinite(x_layer2)):
            layer2_logger.warning(
                f"  → Evaluation #{eval_num} [{phase}] received non-finite x_layer2; "
                "returning large penalty objective."
            )
            for handler in layer2_logger.handlers:
                handler.flush()
            return finish_evaluation(1e6)
        
        # Early return if we've already converged (rate of change is negligible)
        # This helps the optimizer stop faster by returning a constant value
        # Works for both DE and local phases
        if layer2_state.get("converged", False):
            best_obj = layer2_state.get("best_obj", 1e6)
            if np.isfinite(best_obj):
                # Return the best objective we've seen - this constant value will
                # trigger the tolerance-based stopping in L-BFGS-B (for local phase)
                # For DE, returning constant values helps it recognize convergence
                return finish_evaluation(float(best_obj))
        
        # Select resolution for this objective call
        if n_points is None:
            n_points = n_time_points
        if time_eval_override is None:
            time_eval = time_array.copy()
        else:
            time_eval = time_eval_override.copy()
        
        try:
            # Log every evaluation (important for long-running evaluations)
            layer2_logger.info(
                f"  → Evaluation #{eval_num} [{phase}]: {N_SEGMENTS} shared segments (LOX/Fuel, {n_points} pts)"
            )
            for handler in layer2_logger.handlers:
                handler.flush()
            
            # Decode shared parameterization into LOX and fuel segments
            lox_segments, fuel_segments = decode_segments_from_x(
                x_layer2,
                N_SEGMENTS,
                initial_lox_pressure_pa,
                initial_fuel_pressure_pa,
                local_min_lox_floor,
                local_min_fuel_floor,
            )
            
            # Generate pressure curves at the chosen resolution (already floored to minima)
            P_tank_O_array = generate_pressure_curve_from_segments(lox_segments, n_points)
            P_tank_F_array = generate_pressure_curve_from_segments(fuel_segments, n_points)
            
            # Ensure first point is exactly the initial pressure (fixed from Layer 1)
            P_tank_O_array[0] = initial_lox_pressure_pa
            P_tank_F_array[0] = initial_fuel_pressure_pa
            
            # Hard constraint for global search: reject pressure curves where LOX/Fuel
            # pressure ratio deviates too far from the initial ratio during the
            # physically relevant part of the burn (well above the min-pressure clamp).
            # This keeps differential_evolution from wasting evaluations on clearly
            # infeasible LOX/Fuel pressure relationships while ignoring tail-end
            # artifacts when both tanks are clamped near min_pressure_pa.
            initial_pressure_ratio = initial_lox_pressure_pa / max(initial_fuel_pressure_pa, 1e-9)
            active_min_floor = min(local_min_lox_floor, local_min_fuel_floor)
            active_mask = (P_tank_O_array > 1.1 * active_min_floor) & (P_tank_F_array > 1.1 * active_min_floor)
            if np.any(active_mask):
                pressure_ratio_array = P_tank_O_array[active_mask] / np.maximum(P_tank_F_array[active_mask], 1e-9)
                ratio_error_array = np.abs(pressure_ratio_array - initial_pressure_ratio) / max(
                    initial_pressure_ratio, 1e-9
                )
                if np.any(ratio_error_array > 0.25):
                    max_error = float(np.max(ratio_error_array))
                    max_excess = float(np.max(ratio_error_array - 0.25))
                    # Large objective value so DE moves away from this region, but keep it finite
                    # so the optimizer remains numerically well-behaved.
                    hard_ratio_penalty = 5e4 + max_excess * 1e4
                    layer2_logger.info(
                        f"    Skipping time series solve for eval #{eval_num}: "
                        f"pressure ratio error {max_error:.3f} (> 0.25 allowed) in active burn window"
                    )
                    for handler in layer2_logger.handlers:
                        handler.flush()
                    return finish_evaluation(hard_ratio_penalty)
            
            # Save plot if requested (before running expensive solver)
            if save_evaluation_plots:
                save_evaluation_plot(
                    eval_num=eval_num,
                    time_arr=time_eval,
                    P_lox=P_tank_O_array,
                    P_fuel=P_tank_F_array,
                    n_seg_lox=N_SEGMENTS,
                    n_seg_fuel=N_SEGMENTS,
                )
            
            # Run time series evaluation (ablative/graphite disabled in config)
            layer2_logger.info(f"    Running time series solver ({n_points} points)...")
            for handler in layer2_logger.handlers:
                handler.flush()
            
            ts_start = time.time()
            results_layer2 = runner_layer2.evaluate_arrays_with_time(
                time_eval,
                P_tank_O_array,
                P_tank_F_array,
                track_ablative_geometry=False,  # Disable ablative tracking
                use_coupled_solver=False,  # Use simpler solver
            )
            ts_time = time.time() - ts_start
            layer2_logger.info(f"    Time series solver completed in {ts_time:.2f}s")
            for handler in layer2_logger.handlers:
                handler.flush()
            
            # Get thrust history
            thrust_hist = np.atleast_1d(results_layer2.get("F", np.full(n_points, peak_thrust)))
            available_n = min(thrust_hist.shape[0], n_points)
            if available_n < 1:
                layer2_logger.warning(f"    No valid time points in results for eval #{eval_num}; returning large penalty.")
                for handler in layer2_logger.handlers:
                    handler.flush()
                return finish_evaluation(1e6)
            
            thrust_hist = thrust_hist[:available_n]
            time_hist = time_eval[:available_n]
            
            # CRITICAL: Validate that results are not mostly NaN/invalid
            # Check if too many time steps failed (more than 50% NaN is unacceptable)
            finite_thrust_mask = np.isfinite(thrust_hist)
            finite_thrust_count = np.sum(finite_thrust_mask)
            finite_thrust_ratio = finite_thrust_count / available_n if available_n > 0 else 0.0
            
            if finite_thrust_ratio < 0.5:
                # More than 50% of time steps failed - reject this solution
                layer2_logger.warning(
                    f"    Too many failed time steps for eval #{eval_num}: "
                    f"only {finite_thrust_count}/{available_n} ({finite_thrust_ratio*100:.1f}%) have valid thrust. "
                    f"Returning large penalty."
                )
                for handler in layer2_logger.handlers:
                    handler.flush()
                return finish_evaluation(1e6)
            
            # Check if critical metrics (thrust, OF) are valid
            # If average thrust is NaN or zero, reject
            valid_thrust_values = thrust_hist[finite_thrust_mask]
            if len(valid_thrust_values) == 0:
                layer2_logger.warning(
                    f"    No valid thrust values for eval #{eval_num}; returning large penalty."
                )
                for handler in layer2_logger.handlers:
                    handler.flush()
                return finish_evaluation(1e6)
            
            avg_thrust = float(np.mean(valid_thrust_values))
            if not np.isfinite(avg_thrust) or avg_thrust <= 0:
                layer2_logger.warning(
                    f"    Invalid average thrust ({avg_thrust}) for eval #{eval_num}; returning large penalty."
                )
                for handler in layer2_logger.handlers:
                    handler.flush()
                return finish_evaluation(1e6)
            
            # Extract MR history here; we validate it after we detect burnout / active burn prefix.
            # This avoids rejecting otherwise-good solutions just because the post-burnout tail is zero-masked.
            MR_hist = np.atleast_1d(
                results_layer2.get("MR", np.full(available_n, optimal_of_ratio if optimal_of_ratio else 2.3))
            )[:available_n]
            
            # Now safely replace NaN values with defaults for remaining calculations
            # (but we've already validated that we have enough valid data)
            thrust_hist = np.nan_to_num(
                thrust_hist,
                nan=0.0,
                posinf=1e6,
                neginf=-1e6,
            )
            
            # Note: Initial pressures are fixed from Layer 1 and assumed to produce peak_thrust
            # We do not optimize or check initial thrust - it's already correct from Layer 1
            
            # Calculate actual propellant mass consumed by integrating mass flow rates
            mdot_O_hist = np.atleast_1d(results_layer2.get("mdot_O", np.zeros(available_n)))
            mdot_F_hist = np.atleast_1d(results_layer2.get("mdot_F", np.zeros(available_n)))
            mdot_O_hist = mdot_O_hist[:available_n]
            mdot_F_hist = mdot_F_hist[:available_n]
            # Clamp non-finite mass-flow values; NaNs here would otherwise
            # propagate into impulse / capacity penalties and stall the search.
            mdot_O_hist = np.nan_to_num(
                mdot_O_hist,
                nan=0.0,
                posinf=0.0,
                neginf=0.0,
            )
            mdot_F_hist = np.nan_to_num(
                mdot_F_hist,
                nan=0.0,
                posinf=0.0,
                neginf=0.0,
            )

            # Detect and trim post-burnout tail so averages/validity don't include forced zeros.
            active_n = active_burn_prefix_len(time_hist, mdot_O_hist, mdot_F_hist, target_burn_time, thrust_hist=thrust_hist)
            active_n = max(2, min(active_n, available_n))
            thrust_hist = thrust_hist[:active_n]
            time_hist = time_hist[:active_n]
            mdot_O_hist = mdot_O_hist[:active_n]
            mdot_F_hist = mdot_F_hist[:active_n]
            MR_hist = MR_hist[:active_n]
            available_n = active_n

            finite_MR_mask = np.isfinite(MR_hist) & (MR_hist > 0) & (MR_hist < 100)
            finite_MR_count = int(np.sum(finite_MR_mask))
            if finite_MR_count < max(1.0, available_n * 0.5):
                layer2_logger.warning(
                    f"    Too many invalid OF ratios for eval #{eval_num} after trimming burnout tail: "
                    f"only {finite_MR_count}/{available_n} ({finite_MR_count/max(available_n,1)*100:.1f}%) are valid. "
                    f"Returning large penalty."
                )
                for handler in layer2_logger.handlers:
                    handler.flush()
                return finish_evaluation(1e6)
            
            # Integrate mass flow rates to get total propellant consumed
            total_lox_mass = float(np.trapezoid(mdot_O_hist, time_hist))  # kg
            total_fuel_mass = float(np.trapezoid(mdot_F_hist, time_hist))  # kg
            total_propellant_mass = total_lox_mass + total_fuel_mass
            
            # Required impulse uses the physical burn cap so we do not demand extra Δv for
            # gravity losses over time the vehicle cannot still be burning.
            effective_burn_time = effective_burn_time_for_layer2_objective(
                time_hist, mdot_O_hist, mdot_F_hist, target_burn_time
            )
            required_impulse = calculate_required_impulse_from_mass(
                target_apogee_m,
                rocket_dry_mass_kg,
                total_propellant_mass,
                effective_burn_time,
            )
            
            # Check 1: Total impulse must be >= required impulse
            total_impulse = float(np.trapezoid(thrust_hist, time_hist))  # N·s
            if disable_impulse_requirement:
                impulse_penalty = 0.0
            else:
                impulse_deficit = max(0, required_impulse - total_impulse)
                impulse_penalty = (impulse_deficit / max(required_impulse, 1e-9)) * 20.0
            
            # Soft nudge only when 95% of impulse is delivered *before* the end of the effective
            # burn window (min of target and propellant-limited end). No extra penalty for "slack"
            # after flow has already stopped.
            burn_time_penalty = 0.0
            if total_impulse > 0:
                # Cumulative impulse over time
                cumulative_impulse = cumulative_trapezoid(thrust_hist, time_hist, initial=0.0)
                impulse_95 = 0.95 * total_impulse
                idx_95 = np.searchsorted(cumulative_impulse, impulse_95, side="right")
                if idx_95 >= len(time_hist):
                    idx_95 = len(time_hist) - 1
                t95 = float(time_hist[idx_95])
                if t95 + 1e-9 < effective_burn_time:
                    burn_completion_slack = max(0.0, effective_burn_time - t95)
                    burn_time_penalty = (
                        burn_completion_slack / max(effective_burn_time, 1e-9)
                    ) * LAYER2_BURN_TIME_SOFT_SCALE

            # Soft incentive: prefer burns that use the full target burn time.
            # Measured against target_burn_time (not effective), so the optimizer
            # cannot avoid this by collapsing the burn window early.
            burn_duration_penalty = 0.0
            if target_burn_time > 0:
                utilisation = min(effective_burn_time / target_burn_time, 1.0)
                shortfall = 1.0 - utilisation  # 0 = perfect, 1 = instant burnout
                burn_duration_penalty = shortfall * shortfall * LAYER2_BURN_DURATION_SCALE

            # Check 2: Propellant mass must not exceed tank capacity
            lox_capacity_exceeded = max(0, total_lox_mass - max_lox_tank_capacity_kg)
            fuel_capacity_exceeded = max(0, total_fuel_mass - max_fuel_tank_capacity_kg)
            capacity_penalty = 0.0
            if lox_capacity_exceeded > 0:
                capacity_penalty += (lox_capacity_exceeded / max(max_lox_tank_capacity_kg, 1e-9)) * 300.0
            if fuel_capacity_exceeded > 0:
                capacity_penalty += (fuel_capacity_exceeded / max(max_fuel_tank_capacity_kg, 1e-9)) * 300.0
            
            # Check 3: Stability (must pass minimum threshold)
            stability_scores = results_layer2.get("stability_score", None)
            if stability_scores is not None:
                stability_scores = np.nan_to_num(
                    np.atleast_1d(stability_scores),
                    nan=0.0,
                    posinf=0.0,
                    neginf=0.0,
                )
                stability_scores = stability_scores[:available_n]
                min_stability = float(np.min(stability_scores))
            else:
                chugging = results_layer2.get("chugging_stability_margin", np.array([1.0]))
                chugging = np.nan_to_num(
                    np.atleast_1d(chugging),
                    nan=0.0,
                    posinf=0.0,
                    neginf=0.0,
                )
                chugging = chugging[:available_n]
                min_stability = max(0.0, min(1.0, (float(np.min(chugging)) - 0.3) * 1.5))
            
            stability_penalty = 0.0
            if min_stability_margin is not None:
                # Check against minimum stability margin
                chugging_margins = results_layer2.get("chugging_stability_margin", np.array([1.0]))
                chugging_margins = np.nan_to_num(
                    np.atleast_1d(chugging_margins),
                    nan=0.0,
                    posinf=0.0,
                    neginf=0.0,
                )
                chugging_margins = chugging_margins[:available_n]
                min_chugging = float(np.min(chugging_margins))
                if min_chugging < min_stability_margin:
                    stability_penalty = (min_stability_margin - min_chugging) * 50.0
            else:
                # Default: penalty if stability score < 0.7
                stability_penalty = max(0, 0.7 - min_stability) * 10.0
            
            # Check 4: O/F ratio (if specified)
            # Note: MR_hist was already extracted and validated above
            of_penalty = 0.0
            if optimal_of_ratio is not None:
                # Use only valid MR values for calculation
                valid_MR_values = MR_hist[finite_MR_mask]
                if len(valid_MR_values) > 0:
                    # Calculate pointwise relative deviation
                    # We want to check O/F along the curve, not just average
                    deviations = np.abs(valid_MR_values - optimal_of_ratio) / max(optimal_of_ratio, 1e-9)
                    
                    # 5% Deadband logic
                    # Inside deadband (<= 0.05): small penalty
                    # Outside deadband (> 0.05): steeper penalty
                    deadband = 0.05
                    
                    # Calculate per-point penalty
                    # If dev <= deadband: penalty = dev * 1.0 (light guidance)
                    # If dev > deadband: penalty = deadband * 1.0 + (dev - deadband) * 20.0 (strong enforcement)
                    pointwise_penalties = np.where(
                        deviations <= deadband,
                        deviations * 1.0,
                        deadband * 1.0 + (deviations - deadband) * 20.0
                    )
                    
                    # Compute mean and max penalties
                    mean_penalty = np.mean(pointwise_penalties)
                    max_penalty = np.max(pointwise_penalties)
                    
                    # Weighted combination: 40% mean, 60% max
                    # This balance ensures overall stability while penalizing spikes
                    combined_penalty = 0.4 * mean_penalty + 0.6 * max_penalty
                    
                    # Scale factor to match other objective terms magnitude
                    of_penalty = combined_penalty * 50.0 
                else:
                    # No valid MR values - large penalty
                    of_penalty = 100.0
            
            # Check 5: Chamber Pressure Stability
            # We want to ensure Pc doesn't drift more than 25% from initial value
            pc_penalty = 0.0
            if "Pc" in results_layer2:
                Pc_hist = np.atleast_1d(results_layer2["Pc"])
                Pc_hist = Pc_hist[:available_n]
                # Filter for valid Pc values
                valid_Pc_mask = np.isfinite(Pc_hist) & (Pc_hist > 0)
                valid_Pc = Pc_hist[valid_Pc_mask]
                
                if len(valid_Pc) > 0:
                    # Use the first valid point as the initial/reference pressure
                    # (Layer 1 fixes the initial state, so t=0 should be correct)
                    Pc_initial = valid_Pc[0]
                    
                    if Pc_initial > 0:
                        # Calculate relative deviation
                        deviations = np.abs(valid_Pc - Pc_initial) / Pc_initial
                        
                        # Threshold is 25% (0.25)
                        # We only penalize points that exceed this threshold
                        excess_deviations = np.maximum(0.0, deviations - 0.25)
                        
                        if np.any(excess_deviations > 0):
                            # Strong penalty for violations
                            # Scaling: 10% excess drift -> 0.1 * 1000 = 100 penalty points
                            # This is significant but allows for smooth gradient
                            pc_penalty = float(np.mean(excess_deviations)) * 1000.0
                else:
                    # No valid Pc values - should be caught by thrust check, but just in case
                    pc_penalty = 100.0

            # Check 5b: Injector ΔP/Pc band (per time step, both streams)
            injector_dp_penalty = injector_dp_ratio_penalty_from_results(
                results_layer2,
                available_n,
                min_delta_p_over_pc=0.15,
                max_delta_p_over_pc=0.50,
                scale=400.0,
            )
            
            # Check 6: COPV Initial Pressure Optimization
            # Run COPV solver to determine minimum required initial pressure (P0_Pa)
            # Lower P0 is better (lighter tank, lower cost), so we add a penalty term
            copv_penalty = 0.0
            copv_results = None
            try:
                # Create DataFrame for COPV solver
                # Convert pressures from Pa to psi for COPV solver
                P_tank_O_psi = P_tank_O_array / 6894.76
                P_tank_F_psi = P_tank_F_array / 6894.76
                
                df_copv = pd.DataFrame({
                    "time": time_eval,
                    "mdot_O (kg/s)": mdot_O_hist,
                    "mdot_F (kg/s)": mdot_F_hist,
                    "P_tank_O (psi)": P_tank_O_psi,
                    "P_tank_F (psi)": P_tank_F_psi,
                })
                
                
                # Extract COPV volume from config
                # The COPV solver needs the volume in m³
                copv_volume_m3 = None
                if hasattr(config_layer2, "press_tank") and hasattr(config_layer2.press_tank, "free_volume_L"):
                    # Convert from liters to m³
                    copv_volume_m3 = float(config_layer2.press_tank.free_volume_L) / 1000.0
                elif hasattr(config_layer2, "press_tank") and hasattr(config_layer2.press_tank, "press_volume"):
                    copv_volume_m3 = float(config_layer2.press_tank.press_volume)
                elif hasattr(config_layer2, "press_tank") and hasattr(config_layer2.press_tank, "volume_m3"):
                    copv_volume_m3 = float(config_layer2.press_tank.volume_m3)
                
                if copv_volume_m3 is None or copv_volume_m3 <= 0:
                    # No valid COPV volume - skip COPV penalty
                    copv_penalty = 0.0
                    layer2_logger.warning(f"    COPV volume not found in config, skipping COPV penalty")
                else:
                    # Call COPV solver with explicit volume to find required P0
                    copv_results = size_or_check_copv_for_polytropic_N2(
                        df_copv,
                        config_layer2,
                        n=1.2,  # polytropic exponent
                        T0_K=300.0,  # initial COPV temperature
                        Tp_K=293.0,  # default propellant gas temp
                        use_real_gas=True,  # use Z lookup table
                        n2_Z_csv=str(N2_Z_LOOKUP_CSV),
                        pressurant_R=296.8,  # gas constant for N2
                        branch_temperatures_K={
                            "oxidizer": 250.0,  # oxidizer gas temp
                            "fuel": 293.0,      # fuel gas temp
                        },
                        copv_volume_m3=copv_volume_m3,
                        copv_P0_Pa=None,  # Solve for P0
                    )
                    
                    # Extract initial pressure requirement
                    P0_Pa = copv_results.get("P0_Pa", 30e6)  # Default to 30 MPa if missing
                    
                    # Penalty: normalize by reference pressure (30 MPa) and apply weight
                    # This encourages lower COPV pressures while balancing other objectives
                    reference_pressure = 30e6  # 30 MPa reference
                    copv_penalty = (P0_Pa / reference_pressure) * 10.0
                    
                    layer2_logger.info(f"    COPV: P0={P0_Pa/1e6:.2f} MPa ({P0_Pa/6894.76:.0f} psi), penalty={copv_penalty:.2f}")
                
            except Exception as e:
                # COPV solver failed - apply large penalty to discourage this solution
                copv_penalty = 1000.0
                layer2_logger.warning(f"    COPV solver failed for eval #{eval_num}: {type(e).__name__}: {str(e)}")
                # Log full traceback for FileNotFoundError to see what file is missing
                if isinstance(e, FileNotFoundError):
                    import traceback
                    layer2_logger.warning(f"    Full traceback:\n{traceback.format_exc()}")
                layer2_logger.warning(f"    Applying large COPV penalty: {copv_penalty:.2f}")
            
            # Check 7: Robust DDP Controller Simulation (Optional)
            controller_penalty = 0.0
            if use_controller_simulation and finite_thrust_ratio >= 0.5:
                # Add controller tracking penalty
                try:
                    from engine.control.robust_ddp.controller import RobustDDPController
                    from engine.control.robust_ddp.data_models import ControllerConfig, Measurement, NavState, Command, CommandType
                    from engine.control.robust_ddp.dynamics import step, DynamicsParams
                    
                    cfg = controller_config if controller_config else ControllerConfig()
                    dyn_params = DynamicsParams.from_config(cfg)
                    ctrl = RobustDDPController(cfg, optimized_config)
                    
                    # Simulation settings
                    sim_dt = cfg.dt
                    num_steps = int(target_burn_time / sim_dt)
                    if num_steps <= 0:
                        num_steps = 1
                    
                    # Initial state for simulation
                    x_sim = np.array([
                        30e6,                      # P_copv (Pa)
                        24e6,                      # P_reg (Pa)
                        initial_fuel_pressure_pa,  # P_u_F (Pa)
                        initial_lox_pressure_pa,   # P_u_O (Pa)
                        initial_fuel_pressure_pa * 0.95, # P_d_F (Pa)
                        initial_lox_pressure_pa * 0.95,  # P_d_O (Pa)
                        0.01,                      # V_u_F (m^3)
                        0.01,                      # V_u_O (m^3)
                    ])
                    
                    nav = NavState(h=0.0, vz=0.0, theta=0.0, mass_estimate=100.0)
                    total_controller_cost = 0.0
                    
                    import scipy.interpolate
                    # Create interpolation functions for reference targets from layer2 candidate
                    f_ref_interp = scipy.interpolate.interp1d(time_hist, thrust_hist, bounds_error=False, fill_value=(thrust_hist[0], thrust_hist[-1]))
                    mr_ref_interp = scipy.interpolate.interp1d(time_hist, MR_hist, bounds_error=False, fill_value=(MR_hist[0], MR_hist[-1]))
                    
                    max_obj_min = 0.0
                    
                    for k_sim in range(num_steps):
                        t_sim = k_sim * sim_dt
                        # Current references
                        curr_f_ref = float(f_ref_interp(t_sim))
                        curr_mr_ref = float(mr_ref_interp(t_sim))
                        
                        cmd = Command(
                            command_type=CommandType.THRUST_DESIRED,
                            thrust_desired=curr_f_ref,
                        )
                        # We could also pass mr_ref but the controller might use its fixed target inside command. 
                        # Assuming the controller uses cmd.thrust_desired
                        
                        meas = Measurement(
                            P_copv=x_sim[0],
                            P_reg=x_sim[1],
                            P_u_fuel=x_sim[2],
                            P_u_ox=x_sim[3],
                            P_d_fuel=x_sim[4],
                            P_d_ox=x_sim[5]
                        )
                        
                        actuation_cmd, diagnostics = ctrl.step(meas, nav, cmd)
                        
                        # Extract the DDP objective cost or tracking error
                        # Diagnostics returns 'cost' or 'objective' if implemented
                        step_cost = float(diagnostics.get("cost", 0.0))
                        total_controller_cost += step_cost
                        
                        # Track the "max of the min" (max cost step = worst tracking point)
                        if step_cost > max_obj_min:
                            max_obj_min = step_cost
                            
                        # Step forward
                        u_act = np.array([actuation_cmd.duty_F, actuation_cmd.duty_O])
                        
                        # Simple mass flow estimate for dynamics
                        try:
                            eng_est = ctrl.engine_wrapper.estimate_from_pressures(x_sim[4], x_sim[5])
                            sim_mdot_F = eng_est.mdot_F if np.isfinite(eng_est.mdot_F) else 0.0
                            sim_mdot_O = eng_est.mdot_O if np.isfinite(eng_est.mdot_O) else 0.0
                        except Exception:
                            sim_mdot_F = 0.0
                            sim_mdot_O = 0.0
                            
                        x_sim = step(x_sim, u_act, sim_dt, dyn_params, sim_mdot_F, sim_mdot_O)
                    
                    # Add penalty proportional to the worst-case (max) step cost across the trajectory
                    controller_penalty = max_obj_min * 10.0 + (total_controller_cost / max(num_steps, 1)) * 5.0
                    
                    if np.isfinite(controller_penalty):
                        layer2_logger.info(f"    Controller penalty: {controller_penalty:.2f} (max step cost: {max_obj_min:.2f})")
                    else:
                        controller_penalty = 1000.0  # Safe clamp
                    
                except Exception as e:
                    layer2_logger.warning(f"    Controller simulation failed for eval #{eval_num}: {type(e).__name__}: {str(e)}")
                    controller_penalty = 1000.0
            
            # Objective: minimize penalties (no initial thrust penalty - it's fixed from Layer 1)
            components = [
                impulse_penalty,
                burn_time_penalty,
                burn_duration_penalty,
                capacity_penalty,
                stability_penalty,
                of_penalty,
                pc_penalty,
                injector_dp_penalty,
                copv_penalty,
                controller_penalty,
            ]
            if not all(np.isfinite(c) for c in components):
                # If any penalty component is non-finite, treat this evaluation
                # as invalid and return a large penalty. This prevents NaNs from
                # leaking back into the optimizer and corrupting x_layer2.
                layer2_logger.warning(
                    f"    Non-finite penalty components in eval #{eval_num}; "
                    "returning large penalty objective."
                )
                for handler in layer2_logger.handlers:
                    handler.flush()
                return finish_evaluation(1e6)

            obj = sum(components)
            
            eval_time = time.time() - eval_start_time
            
            # Update plot with objective value if plots are being saved
            if save_evaluation_plots and phase == "local":
                # Re-save plot with objective value
                save_evaluation_plot(
                    eval_num=eval_num,
                    time_arr=time_eval,
                    P_lox=P_tank_O_array,
                    P_fuel=P_tank_F_array,
                    objective=obj,
                    n_seg_lox=N_SEGMENTS,
                    n_seg_fuel=N_SEGMENTS,
                )
            
            # Update best objective and corresponding X vector
            prev_best = layer2_state["best_obj"]
            # Note: finish_evaluation will update best_obj/best_x if strictly better
            # But we need to handle specific logging and resetting counters here first
            
            if obj < layer2_state["best_obj"]:
                improvement = prev_best - obj
                # Reset counters if we made significant progress
                if improvement > 1e-5:
                    layer2_state["no_improvement_count"] = 0
                    layer2_state["small_change_count"] = 0  # Reset rate-of-change counter too
                layer2_logger.info(
                    f"    ✓ New best objective: {obj:.6f} "
                    f"(penalties: impulse={impulse_penalty:.2f}, burn_time={burn_time_penalty:.2f}, "
                    f"burn_dur={burn_duration_penalty:.2f}, "
                    f"capacity={capacity_penalty:.2f}, stability={stability_penalty:.2f}, "
                    f"O/F={of_penalty:.2f}, Pc_stab={pc_penalty:.2f}, COPV={copv_penalty:.2f}) "
                    f"- Evaluation took {eval_time:.2f}s"
                )
                
                # Store COPV results for the best solution
                if copv_results is not None:
                    layer2_state["best_copv_results"] = copv_results
                
                # Stream best pressure curves to UI if callback provided
                if pressure_curve_callback is not None:
                    try:
                        # Extract COPV data from current evaluation's copv_results
                        copv_pressure_trace = None
                        copv_time_trace = None
                        if copv_results is not None:
                            copv_pressure_trace = copv_results.get("PH_trace_Pa", None)
                            copv_time_trace = copv_results.get("time_s", None)
                            if copv_pressure_trace is not None:
                                copv_pressure_trace = np.asarray(copv_pressure_trace).copy()
                            if copv_time_trace is not None:
                                copv_time_trace = np.asarray(copv_time_trace).copy()
                        
                        pressure_curve_callback(
                            time_eval.copy(),
                            P_tank_O_array.copy(),
                            P_tank_F_array.copy(),
                            copv_pressure_trace,
                            copv_time_trace,
                        )
                    except Exception:
                        # Never let UI callback break the optimizer
                        pass

            else:
                layer2_logger.info(
                    f"    Objective: {obj:.6f} (best: {layer2_state['best_obj']:.6f}) - "
                    f"Evaluation took {eval_time:.2f}s"
                )
            
            # Flush log
            for handler in layer2_logger.handlers:
                handler.flush()
            
            return finish_evaluation(obj)
        except Exception as e:
            eval_time = time.time() - eval_start_time
            error_msg = f"Exception in objective evaluation #{eval_num} (took {eval_time:.2f}s): {repr(e)}"
            layer2_logger.error(error_msg)
            import traceback
            layer2_logger.error(traceback.format_exc())
            for handler in layer2_logger.handlers:
                handler.flush()
            if log_status:
                log_status("Layer 2 Pressure Error", error_msg)
            return finish_evaluation(1e6)
    
    # Wrapper for coarse global-search objective (DE) using fewer time points
    def layer2_objective_de(x_layer2: np.ndarray) -> float:
        return layer2_objective(
            x_layer2,
            time_eval_override=time_array_de,
            n_points=n_time_points_de,
            phase="DE",
        )
    
    # Wrapper for full-resolution local-search objective
    def layer2_objective_local(x_layer2: np.ndarray) -> float:
        return layer2_objective(
            x_layer2,
            time_eval_override=None,
            n_points=None,
            phase="local",
        )
    
    # Optimize
    success = False
    P_tank_O_optimized = None
    P_tank_F_optimized = None
    summary = {}
    n_segments_used = N_SEGMENTS  # Fixed number of segments per tank
    lox_segments = None  # Track segments for saving to config
    fuel_segments = None
    
    layer2_logger.info("Starting optimization...")
    layer2_logger.info(f"Using fixed {N_SEGMENTS} segments per tank for LOX and fuel")
    layer2_logger.info(f"Max local iterations: {layer2_state['max_iter']}")
    layer2_logger.info("")
    
    try:
        # Global search with differential evolution (coarse time grid, n_time_points_de)
        # Increased parameters for better global search capability
        layer2_logger.info("Running Global Search (DE) with popsize=5, maxiter=10...")
        
        # Callback for DE to detect convergence
        def de_callback(intermediate_result):
            """Callback for differential_evolution to detect and log convergence."""
            # Check if stop was requested
            if stop_event is not None and stop_event.is_set():
                layer2_state["converged"] = True
                layer2_state["stopped_by_user"] = True
                if not layer2_state.get("stop_logged", False):
                    layer2_logger.info("⚠ Stop requested by user during DE optimization")
                    layer2_state["stop_logged"] = True
                    for handler in layer2_logger.handlers:
                        handler.flush()
                return True
            
            # Track improvement for early stopping
            current_obj = layer2_state.get("best_obj", float("inf"))
            prev_best = layer2_state.get("de_prev_best", float("inf"))
            
            # Calculate improvement from previous generation
            improvement = prev_best - current_obj
            layer2_state["de_prev_best"] = current_obj
            
            # Count no-improvement generations
            if improvement < 1.0:  # Less than 1.0 improvement
                layer2_state["de_no_improve_count"] = layer2_state.get("de_no_improve_count", 0) + 1
            else:
                layer2_state["de_no_improve_count"] = 0
            
            # Early stop if 5 consecutive generations with < 1.0 improvement
            if layer2_state.get("de_no_improve_count", 0) >= 5:
                if not layer2_state.get("de_convergence_logged", False):
                    layer2_logger.info(
                        f"✓ DE converged early: 5 generations with < 1.0 improvement. "
                        f"Best objective: {current_obj:.6f}"
                    )
                    layer2_state["de_convergence_logged"] = True
                    for handler in layer2_logger.handlers:
                        handler.flush()
                return True  # Stop DE
            
            if layer2_state.get("converged", False):
                # Convergence detected in objective function - stop DE
                if not layer2_state.get("de_convergence_logged", False):
                    layer2_logger.info(
                        f"✓ DE stopping early: convergence detected (best_obj={layer2_state['best_obj']:.6f})."
                    )
                    layer2_state["de_convergence_logged"] = True
                    for handler in layer2_logger.handlers:
                        handler.flush()
                return True
            return False
        
        de_result = differential_evolution(
            layer2_objective_de,
            bounds,
            maxiter=de_maxiter,
            popsize=de_popsize,
            polish=False,
            tol=0.01,       # Population convergence tolerance
            atol=0.5,       # Absolute tolerance for objective improvement (early stopping)
            callback=de_callback,
        )
        layer2_logger.info(
            "Global search (differential_evolution) finished with objective %.6f",
            de_result.fun,
        )
        if layer2_state.get("converged", False):
            layer2_logger.info(
                "✓ DE converged early, but proceeding to local optimization (L-BFGS-B) "
                "for fine-grid polish regardless."
            )
        for handler in layer2_logger.handlers:
            handler.flush()

        # Re-scoring Top K candidates
        # 1. Collect all valid candidates found during DE
        candidates = layer2_state.get("de_candidates", [])
        
        # 2. Add the final DE result if not already included
        if hasattr(de_result, "x"):
             candidates.append((de_result.fun, de_result.x))
        
        # 3. Sort by objective (ascending)
        # Filter out duplicates (simple check based on obj)
        candidates.sort(key=lambda x: x[0])
        
        # 4. Take top K unique-ish candidates
        top_k_count = 5
        top_candidates = []
        seen_objs = set()
        for obj, x in candidates:
             if len(top_candidates) >= top_k_count:
                 break
             # Rounded obj for duplicate detection
             obj_key = round(obj, 6)
             if obj_key not in seen_objs and obj < 1e5:
                 seen_objs.add(obj_key)
                 top_candidates.append((obj, x))
        
        if not top_candidates and layer2_state["best_x"] is not None:
             top_candidates.append((layer2_state["best_obj"], layer2_state["best_x"]))
        
        # Reset convergence flag so that re-scoring evaluations are actually performed
        # (otherwise layer2_objective returns constant best_obj immediately)
        layer2_state["converged"] = False
        
        layer2_logger.info(f"Re-scoring top {len(top_candidates)} candidates on fine grid...")
        
        best_rescored_obj = float("inf")
        best_rescored_x = None
        
        for i, (old_obj, cand_x) in enumerate(top_candidates):
            # Evaluate on fine grid (local)
            # This implicitly updates layer2_state["best_obj"] if it finds a new global best
            new_obj = layer2_objective_local(cand_x)
            layer2_logger.info(f"  Candidate #{i+1}: DE_obj={old_obj:.6f} -> Fine_obj={new_obj:.6f}")
            
            if new_obj < best_rescored_obj:
                best_rescored_obj = new_obj
                best_rescored_x = cand_x
        
        if best_rescored_x is not None:
            local_start_x = best_rescored_x
            layer2_logger.info(f"Selected best re-scored candidate (obj={best_rescored_obj:.6f}) as starting point for local optimization")
        elif layer2_state["best_x"] is not None:
             local_start_x = layer2_state["best_x"]
             layer2_logger.info("Re-scoring failed to find valid candidates, using overall best x")
        else:
             local_start_x = de_result.x # Fallback
        
        for handler in layer2_logger.handlers:
            handler.flush()

        # Re-evaluate the chosen start point on the FINE grid to establish a valid baseline.
        # This prevents comparing "apples to oranges" (coarse DE vs fine local).
        layer2_logger.info("Re-evaluating best DE solution on fine grid to establish baseline...")
        baseline_obj = layer2_objective_local(local_start_x)

        # Force reset internal state to this fine-grid baseline
        layer2_state["best_obj"] = baseline_obj
        layer2_state["best_x"] = np.array(local_start_x, copy=True)
        layer2_state["last_obj"] = baseline_obj
        layer2_state["prev_obj"] = None
        # Reset convergence tracking for local optimization phase
        # (Even if DE converged early, we still run local optimization for fine-grid polish)
        layer2_state["converged"] = False
        layer2_state["no_improvement_count"] = 0
        layer2_state["small_change_count"] = 0
        layer2_state["identical_obj_count"] = 0
        layer2_state["last_identical_obj"] = None

        layer2_logger.info(f"Fine-grid baseline objective: {baseline_obj:.6f}")
        layer2_logger.info("Proceeding to local optimization (L-BFGS-B) for fine-grid polish...")
        for handler in layer2_logger.handlers:
            handler.flush()

        # Local polish with L-BFGS-B (full time grid, n_time_points)
        # Use tighter tolerances to stop earlier when converged
        # Also reduce max iterations if DE already found a good solution
        effective_max_iter = max_iterations
        if baseline_obj < 1.0:  # If we have a good solution (on the fine grid)
            effective_max_iter = min(max_iterations, 15)  # Use fewer iterations
            layer2_logger.info(
                f"Baseline is good (obj={baseline_obj:.6f}), "
                f"limiting local search to {effective_max_iter} iterations"
            )
        
        result_layer2 = scipy_minimize(
            layer2_objective_local,
            local_start_x,  # Use the best X vector found during DE
            method="L-BFGS-B",
            bounds=bounds,
            options={
                "maxiter": effective_max_iter,
                "ftol": 1e-6,  # Function tolerance - stop when function change is small
                "gtol": 1e-5,  # Gradient tolerance - stop when gradient is small
                "maxfun": effective_max_iter * 3,  # Limit function evaluations to prevent infinite loops
            },
            callback=layer2_callback,
        )
        
        layer2_logger.info("")
        layer2_logger.info("Optimization completed")
        layer2_logger.info(f"Success: {result_layer2.success}")
        layer2_logger.info(f"Final objective value: {result_layer2.fun:.6f}")
        layer2_logger.info(f"Iterations: {result_layer2.nit if hasattr(result_layer2, 'nit') else 'N/A'}")
        layer2_logger.info(f"Function evaluations: {result_layer2.nfev if hasattr(result_layer2, 'nfev') else 'N/A'}")
        layer2_logger.info("")
        
        if result_layer2.success or result_layer2.fun < 1e5:
            success = True
            layer2_logger.info("✓ Optimization converged successfully")
            
            # Extract optimized segments
            layer2_logger.info(f"Optimized solution uses {N_SEGMENTS} LOX segments and {N_SEGMENTS} fuel segments")
            
            # CRITICAL FIX: Use the best X vector found across all optimization phases
            # (DE + local), not just the local optimizer's final X vector.
            # The local optimizer may not improve upon its starting point, so
            # result_layer2.x could be worse than the best found during DE.
            best_x_overall = layer2_state['best_x'] if layer2_state['best_x'] is not None else result_layer2.x
            best_obj_overall = layer2_state['best_obj']
            
            # Log which solution we're using for final results
            if layer2_state['best_x'] is not None and best_obj_overall < result_layer2.fun:
                layer2_logger.info(
                    f"Using best solution found during optimization (obj={best_obj_overall:.6f}) "
                    f"instead of local optimizer's final solution (obj={result_layer2.fun:.6f})"
                )
            else:
                layer2_logger.info(f"Using local optimizer's final solution (obj={result_layer2.fun:.6f})")
            
            lox_segments, fuel_segments = decode_segments_from_x(
                best_x_overall,  # Use best X found during entire optimization
                N_SEGMENTS,
                initial_lox_pressure_pa,
                initial_fuel_pressure_pa,
                min_lox_pressure_floor_pa,
                min_fuel_pressure_floor_pa,
            )
            
            # Generate optimized pressure curves
            P_tank_O_optimized = generate_pressure_curve_from_segments(lox_segments, n_time_points)
            P_tank_F_optimized = generate_pressure_curve_from_segments(fuel_segments, n_time_points)
            
            if update_progress:
                update_progress(
                    "Layer 2: Pressure Curve Optimization",
                    0.64,
                    f"Optimized: {N_SEGMENTS} LOX segments, {N_SEGMENTS} fuel segments"
                )
        else:
            layer2_logger.warning("⚠ Optimization did not converge, using initial guess")
            if update_progress:
                update_progress(
                    "Layer 2: Pressure Curve Optimization",
                    0.64,
                    f"⚠️ Optimization did not converge, using initial guess"
                )
                # Use initial guess with shared parameterization
                lox_segments, fuel_segments = decode_segments_from_x(
                    x0,
                    N_SEGMENTS,
                initial_lox_pressure_pa,
                initial_fuel_pressure_pa,
                min_lox_pressure_floor_pa,
                min_fuel_pressure_floor_pa,
                )
            P_tank_O_optimized = generate_pressure_curve_from_segments(lox_segments, n_time_points)
            P_tank_F_optimized = generate_pressure_curve_from_segments(fuel_segments, n_time_points)
    
    except Exception as e:
        error_msg = f"Exception in optimization: {repr(e)}"
        layer2_logger.error(error_msg)
        import traceback
        layer2_logger.error(traceback.format_exc())
        if log_status:
            log_status("Layer 2 Pressure Error", error_msg)
        if update_progress:
            update_progress(
                "Layer 2: Pressure Curve Optimization",
                0.64,
                f"⚠️ Optimization failed: {e}, using initial guess"
            )
        # Fallback to simple linear pressure decay
        P_tank_O_optimized = np.linspace(initial_lox_pressure_pa, initial_lox_pressure_pa * 0.7, n_time_points)
        P_tank_F_optimized = np.linspace(initial_fuel_pressure_pa, initial_fuel_pressure_pa * 0.7, n_time_points)
        layer2_logger.warning("Using fallback linear pressure decay")
        # Create fallback segments for config
        lox_segments = [{
            "length_ratio": 1.0,
            "type": "linear",
            "start_pressure": initial_lox_pressure_pa,
            "end_pressure": initial_lox_pressure_pa * 0.7,
            "k": None,
        }]
        fuel_segments = [{
            "length_ratio": 1.0,
            "type": "linear",
            "start_pressure": initial_fuel_pressure_pa,
            "end_pressure": initial_fuel_pressure_pa * 0.7,
            "k": None,
        }]
    
    # Build summary
    layer2_logger.info("")
    layer2_logger.info("Calculating final results...")
    results_final = None  # Initialize to ensure it's in scope
    thrust_final = None  # Initialize for thrust curve data
    # Initialize variables for summary (in case calculation fails)
    total_impulse_actual = 0.0
    initial_thrust_actual = 0.0
    total_lox_mass_final = 0.0
    total_fuel_mass_final = 0.0
    total_propellant_mass = 0.0
    required_impulse_final = 0.0
    if P_tank_O_optimized is not None and P_tank_F_optimized is not None:
        # Calculate final total impulse and propellant consumption for summary
        try:
            results_final = runner_layer2.evaluate_arrays_with_time(
                time_array,
                P_tank_O_optimized,
                P_tank_F_optimized,
                track_ablative_geometry=False,
                use_coupled_solver=False,
            )
            thrust_final = np.atleast_1d(results_final.get("F", [peak_thrust]))
            mdot_O_final = np.atleast_1d(results_final.get("mdot_O", np.zeros(n_time_points)))
            mdot_F_final = np.atleast_1d(results_final.get("mdot_F", np.zeros(n_time_points)))
            
            total_impulse_actual = float(np.trapezoid(thrust_final, time_array))
            initial_thrust_actual = float(thrust_final[0])
            
            # Calculate actual propellant mass consumed
            total_lox_mass_final = float(np.trapezoid(mdot_O_final, time_array))
            total_fuel_mass_final = float(np.trapezoid(mdot_F_final, time_array))
            total_propellant_mass = total_lox_mass_final + total_fuel_mass_final
            
            n_fin = min(
                len(time_array),
                len(np.atleast_1d(mdot_O_final)),
                len(np.atleast_1d(mdot_F_final)),
            )
            eff_burn_final = effective_burn_time_for_layer2_objective(
                time_array[:n_fin],
                np.atleast_1d(mdot_O_final)[:n_fin],
                np.atleast_1d(mdot_F_final)[:n_fin],
                target_burn_time,
            )
            required_impulse_final = calculate_required_impulse_from_mass(
                target_apogee_m,
                rocket_dry_mass_kg,
                total_propellant_mass,
                eff_burn_final,
            )
            
            # Log final results
            layer2_logger.info("")
            layer2_logger.info("="*70)
            layer2_logger.info("Final Results Summary")
            layer2_logger.info("="*70)
            layer2_logger.info(f"Initial thrust: {initial_thrust_actual:.1f} N (target: {peak_thrust:.1f} N)")
            layer2_logger.info(f"Total impulse: {total_impulse_actual/1000:.1f} kN·s")
            layer2_logger.info(f"Required impulse: {required_impulse_final/1000:.1f} kN·s")
            layer2_logger.info(f"Impulse ratio: {total_impulse_actual/max(required_impulse_final, 1e-9)*100:.1f}%")
            layer2_logger.info(f"LOX consumed: {total_lox_mass_final:.3f} kg ({total_lox_mass_final/max(max_lox_tank_capacity_kg, 1e-9)*100:.1f}% of capacity)")
            layer2_logger.info(f"Fuel consumed: {total_fuel_mass_final:.3f} kg ({total_fuel_mass_final/max(max_fuel_tank_capacity_kg, 1e-9)*100:.1f}% of capacity)")
            layer2_logger.info(f"Total propellant: {total_propellant_mass:.3f} kg")
            layer2_logger.info(f"LOX end pressure: {P_tank_O_optimized[-1]/6894.76:.1f} psi ({P_tank_O_optimized[-1]/1e6:.2f} MPa)")
            layer2_logger.info(f"Fuel end pressure: {P_tank_F_optimized[-1]/6894.76:.1f} psi ({P_tank_F_optimized[-1]/1e6:.2f} MPa)")
            layer2_logger.info("="*70)
        except Exception as e:
            layer2_logger.error(f"Error calculating final results: {repr(e)}")
            total_impulse_actual = 0.0
            initial_thrust_actual = 0.0
            total_lox_mass_final = 0.0
            total_fuel_mass_final = 0.0
            total_propellant_mass = 0.0
            required_impulse_final = 0.0
        
        # Calculate average O/F ratio and min stability from final results
        avg_of_ratio = None
        min_stability_margin_val = None
        if results_final is not None:  # Only calculate if results_final was successfully computed
            try:
                n_fin = min(len(time_array), len(mdot_O_final), len(mdot_F_final))
                active_n_final = active_burn_prefix_len(
                    time_array[:n_fin],
                    np.atleast_1d(mdot_O_final)[:n_fin],
                    np.atleast_1d(mdot_F_final)[:n_fin],
                    target_burn_time,
                    thrust_hist=np.atleast_1d(thrust_final)[:n_fin],
                )
                # Prefer a burn mask based on thrust being meaningfully > 0.
                # This avoids averaging in post-burnout zero-masked MR/stability even if mdot stays nonzero.
                thrust_arr = np.atleast_1d(thrust_final)[:n_fin].astype(float)
                peak_thrust = float(np.nanmax(thrust_arr)) if thrust_arr.size else 0.0
                if np.isfinite(peak_thrust) and peak_thrust > 0:
                    thrust_thresh = max(peak_thrust * 1e-3, 1.0)
                    burn_mask = thrust_arr > thrust_thresh
                else:
                    burn_mask = np.ones_like(thrust_arr, dtype=bool)
                if active_n_final > 0:
                    burn_mask = burn_mask[:active_n_final]

                MR_hist = np.atleast_1d(results_final.get("MR", []))
                if len(MR_hist) > 0:
                    MR_hist = MR_hist[:n_fin].astype(float)
                    if active_n_final > 0:
                        MR_hist = MR_hist[:active_n_final]
                    valid_MR = MR_hist[burn_mask & np.isfinite(MR_hist) & (MR_hist > 0)]
                    if len(valid_MR) > 0:
                        avg_of_ratio = float(np.mean(valid_MR))
                
                # Extract chugging_stability_margin from results
                # evaluate_arrays_with_time now includes comprehensive stability analysis (all 3 types)
                chugging_margins = results_final.get("chugging_stability_margin", None)
                if chugging_margins is not None:
                    chugging_margins = np.atleast_1d(chugging_margins)[:n_fin].astype(float)
                    if active_n_final > 0:
                        chugging_margins = chugging_margins[:active_n_final]
                    valid_margins = chugging_margins[burn_mask & np.isfinite(chugging_margins) & (chugging_margins > 0)]
                    if len(valid_margins) > 0:
                        min_stability_margin_val = float(np.min(valid_margins))
                        layer2_logger.info(f"Extracted min stability margin (comprehensive): {min_stability_margin_val:.3f} from {len(valid_margins)} time points")
                        layer2_logger.info(f"  (Accounts for chugging, acoustic, and feed system stability)")
                    else:
                        layer2_logger.warning("Stability margins found but all values are invalid (NaN/Inf)")
                else:
                    layer2_logger.warning("chugging_stability_margin not found in results - stability analysis may have failed")
            except Exception as e:
                layer2_logger.warning(f"Error extracting stability/O/F from final results: {repr(e)}")
                pass  # Use None if calculation fails
        
        # Calculate COPV requirements for final optimized pressure curves
        copv_P0_Pa = None
        copv_pressure_trace_Pa = None
        copv_time_s = None
        if results_final is not None and mdot_O_final is not None and mdot_F_final is not None:
            try:
                # Create DataFrame for COPV solver with final results
                P_tank_O_psi_final = P_tank_O_optimized / 6894.76
                P_tank_F_psi_final = P_tank_F_optimized / 6894.76
                
                df_copv_final = pd.DataFrame({
                    "time": time_array,
                    "mdot_O (kg/s)": mdot_O_final,
                    "mdot_F (kg/s)": mdot_F_final,
                    "P_tank_O (psi)": P_tank_O_psi_final,
                    "P_tank_F (psi)": P_tank_F_psi_final,
                })
                
                
                # Extract COPV volume from config
                copv_volume_m3_final = None
                if hasattr(config_layer2, "press_tank") and hasattr(config_layer2.press_tank, "free_volume_L"):
                    # Convert from liters to m³
                    copv_volume_m3_final = float(config_layer2.press_tank.free_volume_L) / 1000.0
                elif hasattr(config_layer2, "press_tank") and hasattr(config_layer2.press_tank, "press_volume"):
                    copv_volume_m3_final = float(config_layer2.press_tank.press_volume)
                elif hasattr(config_layer2, "press_tank") and hasattr(config_layer2.press_tank, "volume_m3"):
                    copv_volume_m3_final = float(config_layer2.press_tank.volume_m3)
                
                if copv_volume_m3_final is None or copv_volume_m3_final <= 0:
                    layer2_logger.warning("COPV volume not found in config, skipping final COPV calculation")
                    copv_P0_Pa = None
                    copv_pressure_trace_Pa = None
                    copv_time_s = None
                else:
                    # Call COPV solver to get final pressure requirements
                    copv_results_final = size_or_check_copv_for_polytropic_N2(
                        df_copv_final,
                        config_layer2,
                        n=1.2,  # polytropic exponent
                        T0_K=300.0,  # initial COPV temperature
                        Tp_K=293.0,  # default propellant gas temp
                        use_real_gas=True,  # use Z lookup table
                        n2_Z_csv=str(N2_Z_LOOKUP_CSV),
                        pressurant_R=296.8,  # gas constant for N2
                        branch_temperatures_K={
                            "oxidizer": 250.0,  # oxidizer gas temp
                            "fuel": 293.0,      # fuel gas temp
                        },
                        copv_volume_m3=copv_volume_m3_final,
                        copv_P0_Pa=None,  # Solve for P0
                    )
                    
                    # Extract COPV results
                    copv_P0_Pa = float(copv_results_final.get("P0_Pa", 0.0))
                    copv_pressure_trace_Pa = copv_results_final.get("PH_trace_Pa", np.array([]))
                    copv_time_s = copv_results_final.get("time_s", np.array([]))
                    
                    # Log COPV results
                    layer2_logger.info("")
                    layer2_logger.info("COPV Pressurization Requirements:")
                    layer2_logger.info(f"  Initial pressure (P0): {copv_P0_Pa/1e6:.2f} MPa ({copv_P0_Pa/6894.76:.0f} psi)")
                    if len(copv_pressure_trace_Pa) > 0:
                        copv_final_pressure = copv_pressure_trace_Pa[-1]
                        layer2_logger.info(f"  Final pressure: {copv_final_pressure/1e6:.2f} MPa ({copv_final_pressure/6894.76:.0f} psi)")
                        layer2_logger.info(f"  Pressure drop: {(copv_P0_Pa - copv_final_pressure)/1e6:.2f} MPa")
                
            except Exception as e:
                layer2_logger.warning(f"Error calculating COPV requirements for final results: {repr(e)}")
                copv_P0_Pa = None
                copv_pressure_trace_Pa = None
                copv_time_s = None
        
        # Prepare thrust curve data for frontend (time series without ablation/oxidation)
        thrust_curve_time = None
        thrust_curve_values = None
        of_curve_values = None
        pc_curve_values = None
        mdot_O_curve_values = None
        mdot_F_curve_values = None
        mdot_total_curve_values = None
        delta_p_inj_O_values = None
        delta_p_inj_F_values = None
        if results_final is not None and thrust_final is not None and len(thrust_final) > 0:
            # Use the time array and thrust data from final evaluation
            # Ensure arrays are converted to lists for JSON serialization
            thrust_curve_time = time_array[:len(thrust_final)].tolist() if hasattr(time_array, 'tolist') else list(time_array[:len(thrust_final)])
            thrust_curve_values = thrust_final.tolist() if hasattr(thrust_final, 'tolist') else list(thrust_final)
            
            # Extract O/F ratio (MR - mixture ratio) data
            MR_final = np.atleast_1d(results_final.get("MR", np.zeros(len(thrust_final))))
            if len(MR_final) > 0:
                of_curve_values = MR_final.tolist() if hasattr(MR_final, 'tolist') else list(MR_final)

            # Extract chamber pressure curve (Pc) for frontend plotting
            Pc_final = np.atleast_1d(results_final.get("Pc", np.zeros(len(thrust_final))))
            if len(Pc_final) > 0:
                pc_curve_values = Pc_final.tolist() if hasattr(Pc_final, "tolist") else list(Pc_final)
            
            mdot_O_final_curve = np.atleast_1d(results_final.get("mdot_O", np.zeros(len(thrust_final))))
            mdot_F_final_curve = np.atleast_1d(results_final.get("mdot_F", np.zeros(len(thrust_final))))
            mdot_total_final_curve = np.atleast_1d(results_final.get("mdot_total", np.zeros(len(thrust_final))))
            if len(mdot_O_final_curve) > 0:
                mdot_O_curve_values = (
                    mdot_O_final_curve.tolist()
                    if hasattr(mdot_O_final_curve, "tolist")
                    else list(mdot_O_final_curve)
                )
            if len(mdot_F_final_curve) > 0:
                mdot_F_curve_values = (
                    mdot_F_final_curve.tolist()
                    if hasattr(mdot_F_final_curve, "tolist")
                    else list(mdot_F_final_curve)
                )
            if len(mdot_total_final_curve) > 0:
                mdot_total_curve_values = (
                    mdot_total_final_curve.tolist()
                    if hasattr(mdot_total_final_curve, "tolist")
                    else list(mdot_total_final_curve)
                )

            # Extract injector pressure drops from diagnostics
            diagnostics_list = results_final.get("diagnostics", [])
            layer2_logger.info(f"Extracting injector pressure drops: diagnostics_list length={len(diagnostics_list)}, thrust_final length={len(thrust_final)}")
            if len(diagnostics_list) > 0:
                # Debug: log first diagnostic structure
                if len(diagnostics_list) > 0 and isinstance(diagnostics_list[0], dict):
                    first_diag = diagnostics_list[0]
                    layer2_logger.info(f"First diagnostic keys: {list(first_diag.keys())[:10]}...")  # Log first 10 keys
                    if "injector_pressure" in first_diag:
                        layer2_logger.info(f"injector_pressure keys: {list(first_diag['injector_pressure'].keys()) if isinstance(first_diag['injector_pressure'], dict) else 'not a dict'}")
                    if "delta_p_injector_O" in first_diag:
                        layer2_logger.info(f"Found delta_p_injector_O directly: {first_diag['delta_p_injector_O']}")
                delta_p_inj_O_list = []
                delta_p_inj_F_list = []
                # Convert from Pa to PSI (1 PSI = 6894.76 Pa)
                PSI_TO_PA = 6894.76
                
                # Ensure we process the same number of points as thrust data
                n_points = len(thrust_final)
                for i in range(n_points):
                    if i < len(diagnostics_list):
                        diag = diagnostics_list[i]
                        if isinstance(diag, dict):
                            # Try nested injector_pressure structure first
                            injector_pressure = diag.get("injector_pressure")
                            if isinstance(injector_pressure, dict) and "delta_p_injector_O" in injector_pressure:
                                delta_p_O = injector_pressure.get("delta_p_injector_O")
                                delta_p_F = injector_pressure.get("delta_p_injector_F")
                            else:
                                # Fallback to direct access in diagnostics dict
                                delta_p_O = diag.get("delta_p_injector_O")
                                delta_p_F = diag.get("delta_p_injector_F")
                            
                            # Convert from Pa to PSI
                            if delta_p_O is not None and np.isfinite(delta_p_O):
                                delta_p_inj_O_list.append(float(delta_p_O / PSI_TO_PA))
                            else:
                                delta_p_inj_O_list.append(0.0)
                            
                            if delta_p_F is not None and np.isfinite(delta_p_F):
                                delta_p_inj_F_list.append(float(delta_p_F / PSI_TO_PA))
                            else:
                                delta_p_inj_F_list.append(0.0)
                        else:
                            delta_p_inj_O_list.append(0.0)
                            delta_p_inj_F_list.append(0.0)
                    else:
                        # Pad with zeros if diagnostics list is shorter
                        delta_p_inj_O_list.append(0.0)
                        delta_p_inj_F_list.append(0.0)
                
                if len(delta_p_inj_O_list) > 0:
                    # Check if we actually got non-zero values
                    non_zero_O = sum(1 for v in delta_p_inj_O_list if abs(v) > 1e-6)
                    non_zero_F = sum(1 for v in delta_p_inj_F_list if abs(v) > 1e-6)
                    layer2_logger.info(f"Injector pressure drops extracted: {non_zero_O}/{len(delta_p_inj_O_list)} non-zero LOX values, {non_zero_F}/{len(delta_p_inj_F_list)} non-zero Fuel values")
                    
                    if non_zero_O > 0 or non_zero_F > 0:
                        delta_p_inj_O_values = delta_p_inj_O_list
                        delta_p_inj_F_values = delta_p_inj_F_list
                        
                        # Log sample values for debugging
                        sample_idx = min(5, len(delta_p_inj_O_list) - 1)
                        layer2_logger.info(f"Sample injector pressure drops: LOX={delta_p_inj_O_list[sample_idx]:.2f} psi, Fuel={delta_p_inj_F_list[sample_idx]:.2f} psi (at index {sample_idx})")
                    else:
                        layer2_logger.warning("All injector pressure drops are zero - diagnostics may not contain injector data")
                        delta_p_inj_O_values = None
                        delta_p_inj_F_values = None
            else:
                layer2_logger.warning("No diagnostics found in results_final - cannot extract injector pressure drops")
        
        # ---- fill level curves (fraction of physical max capacity) ----
        lox_fill_fraction_curve = None
        fuel_fill_fraction_curve = None
        lox_mass_remaining_curve_kg = None
        fuel_mass_remaining_curve_kg = None
        try:
            if (
                mdot_O_curve_values is not None
                and mdot_F_curve_values is not None
                and thrust_curve_time is not None
                and max_lox_tank_capacity_kg > 0
                and max_fuel_tank_capacity_kg > 0
            ):
                t = np.asarray(thrust_curve_time, dtype=float)
                mdot_O = np.asarray(mdot_O_curve_values, dtype=float)
                mdot_F = np.asarray(mdot_F_curve_values, dtype=float)
                n_fill = int(min(t.size, mdot_O.size, mdot_F.size))
                if n_fill > 1:
                    t = t[:n_fill]
                    mdot_O = mdot_O[:n_fill]
                    mdot_F = mdot_F[:n_fill]
                    dt = np.diff(t)
                    dt = np.nan_to_num(dt, nan=0.0, posinf=0.0, neginf=0.0)
                    dt = np.maximum(dt, 0.0)
                    # Trapezoid cumulative integral without SciPy dependency here.
                    lox_consumed = np.concatenate(
                        ([0.0], np.cumsum(0.5 * (mdot_O[1:] + mdot_O[:-1]) * dt))
                    )
                    fuel_consumed = np.concatenate(
                        ([0.0], np.cumsum(0.5 * (mdot_F[1:] + mdot_F[:-1]) * dt))
                    )
                    lox_remaining = np.clip(float(max_lox_tank_capacity_kg) - lox_consumed, 0.0, float(max_lox_tank_capacity_kg))
                    fuel_remaining = np.clip(float(max_fuel_tank_capacity_kg) - fuel_consumed, 0.0, float(max_fuel_tank_capacity_kg))
                    lox_mass_remaining_curve_kg = lox_remaining.tolist()
                    fuel_mass_remaining_curve_kg = fuel_remaining.tolist()
                    lox_fill_fraction_curve = (lox_remaining / float(max_lox_tank_capacity_kg)).tolist()
                    fuel_fill_fraction_curve = (fuel_remaining / float(max_fuel_tank_capacity_kg)).tolist()
        except Exception:
            # Non-critical: keep fill curves unset if any unexpected shape issues occur.
            lox_fill_fraction_curve = None
            fuel_fill_fraction_curve = None
            lox_mass_remaining_curve_kg = None
            fuel_mass_remaining_curve_kg = None

        summary = {
            "lox_segments": n_segments_used,
            "fuel_segments": n_segments_used,
            "initial_lox_pressure_pa": initial_lox_pressure_pa,
            "initial_fuel_pressure_pa": initial_fuel_pressure_pa,
            "lox_start_pressure_pa": float(P_tank_O_optimized[0]),
            "lox_end_pressure_pa": float(P_tank_O_optimized[-1]),
            "fuel_start_pressure_pa": float(P_tank_F_optimized[0]),
            "fuel_end_pressure_pa": float(P_tank_F_optimized[-1]),
            "target_burn_time": target_burn_time,
            "n_time_points": n_time_points,
            "peak_thrust": peak_thrust,
            "initial_thrust_actual": initial_thrust_actual,
            # Frontend-compatible field names
            "total_impulse_Ns": total_impulse_actual,  # Frontend expects this name
            "required_impulse_Ns": required_impulse_final,  # Frontend expects this name
            "lox_mass_kg": total_lox_mass_final,  # Frontend expects this name
            "fuel_mass_kg": total_fuel_mass_final,  # Frontend expects this name
            "burn_time_s": target_burn_time,  # Frontend expects this
            "avg_of_ratio": avg_of_ratio,  # Frontend expects this
            "min_stability_margin": min_stability_margin_val,  # Frontend expects this
            "is_success": success,  # Frontend expects this
            # Thrust curve data for frontend plotting (time series without ablation/oxidation)
            "thrust_curve_time": thrust_curve_time,
            "thrust_curve_values": thrust_curve_values,
            # O/F ratio (mixture ratio) curve data for frontend plotting
            "of_curve_values": of_curve_values,
            # Chamber pressure curve data for frontend plotting (Pa)
            "pc_curve_values": pc_curve_values,
            # Mass flow curves for frontend plotting (kg/s)
            "mdot_O_curve_values": mdot_O_curve_values,
            "mdot_F_curve_values": mdot_F_curve_values,
            "mdot_total_curve_values": mdot_total_curve_values,
            # Tank fill level curves (% of physical max capacity, 0-1). For regulated Layer 2
            # we approximate remaining propellant as (capacity - ∫mdot dt).
            "lox_fill_fraction_curve": lox_fill_fraction_curve,
            "fuel_fill_fraction_curve": fuel_fill_fraction_curve,
            "lox_mass_remaining_curve_kg": lox_mass_remaining_curve_kg,
            "fuel_mass_remaining_curve_kg": fuel_mass_remaining_curve_kg,
            # Injector pressure drops (LOX and Fuel) for frontend plotting
            "delta_p_inj_O_psi": delta_p_inj_O_values,
            "delta_p_inj_F_psi": delta_p_inj_F_values,
            # Keep original names for backward compatibility
            "total_lox_mass_kg": total_lox_mass_final,
            "total_fuel_mass_kg": total_fuel_mass_final,
            "total_propellant_mass_kg": total_propellant_mass,
            "max_lox_tank_capacity_kg": max_lox_tank_capacity_kg,
            "max_fuel_tank_capacity_kg": max_fuel_tank_capacity_kg,
            "lox_capacity_ratio": total_lox_mass_final / max(max_lox_tank_capacity_kg, 1e-9),
            "fuel_capacity_ratio": total_fuel_mass_final / max(max_fuel_tank_capacity_kg, 1e-9),
            "required_impulse": required_impulse_final,
            "total_impulse_actual": total_impulse_actual,
            "impulse_ratio": total_impulse_actual / max(required_impulse_final, 1e-9),
            # COPV pressurization data
            "copv_P0_Pa": float(copv_P0_Pa) if copv_P0_Pa is not None else None,
            "copv_pressure_trace_Pa": copv_pressure_trace_Pa.tolist() if copv_pressure_trace_Pa is not None and hasattr(copv_pressure_trace_Pa, 'tolist') else None,
            "copv_time_s": copv_time_s.tolist() if copv_time_s is not None and hasattr(copv_time_s, 'tolist') else None,
        }
    
    layer2_logger.info("")
    layer2_logger.info(f"Layer 2 optimization complete. Log saved to: {log_file_path}")
    
    # Save optimized pressure curve segments to config
    if lox_segments is not None and fuel_segments is not None:
        try:
            # Convert segment dicts to PressureSegmentConfig objects
            lox_segment_configs = [
                PressureSegmentConfig(
                    length_ratio=float(seg["length_ratio"]),
                    type=seg["type"],
                    start_pressure_pa=float(seg["start_pressure"]),
                    end_pressure_pa=float(seg["end_pressure"]),
                    k=float(seg.get("k")) if seg.get("k") is not None else None,
                )
                for seg in lox_segments
            ]
            fuel_segment_configs = [
                PressureSegmentConfig(
                    length_ratio=float(seg["length_ratio"]),
                    type=seg["type"],
                    start_pressure_pa=float(seg["start_pressure"]),
                    end_pressure_pa=float(seg["end_pressure"]),
                    k=float(seg.get("k")) if seg.get("k") is not None else None,
                )
                for seg in fuel_segments
            ]
            
            # Create PressureCurvesConfig and assign to optimized_config
            pressure_curves_config = PressureCurvesConfig(
                n_points=n_time_points,
                target_burn_time_s=target_burn_time,
                initial_lox_pressure_pa=initial_lox_pressure_pa,
                initial_fuel_pressure_pa=initial_fuel_pressure_pa,
                lox_segments=lox_segment_configs,
                fuel_segments=fuel_segment_configs,
            )
            
            # Update the config with pressure curves
            # Direct assignment works with Pydantic v2 models
            optimized_config.pressure_curves = pressure_curves_config
            
            layer2_logger.info(f"Saved {len(lox_segment_configs)} LOX segments and {len(fuel_segment_configs)} fuel segments to config")
        except Exception as e:
            layer2_logger.warning(f"Failed to save pressure curves to config: {repr(e)}")
            # Don't fail the entire optimization if config saving fails

    # Persist initial pressures and propellant masses to tank configs so the
    # downloaded YAML carries the full operating point.
    try:
        psi_factor = 1.0 / 6894.76
        if optimized_config.lox_tank is not None:
            optimized_config.lox_tank.initial_pressure_psi = float(P_tank_O_optimized[0]) * psi_factor
            if total_lox_mass_final > 0:
                optimized_config.lox_tank.mass = float(total_lox_mass_final)
        if optimized_config.fuel_tank is not None:
            optimized_config.fuel_tank.initial_pressure_psi = float(P_tank_F_optimized[0]) * psi_factor
            if total_fuel_mass_final > 0:
                optimized_config.fuel_tank.mass = float(total_fuel_mass_final)
    except Exception as e:
        layer2_logger.warning(f"Failed to persist tank fields to config: {repr(e)}")

    # Clean up handler to prevent file handle issues
    layer2_logger.handlers.clear()
    
    return optimized_config, time_array, P_tank_O_optimized, P_tank_F_optimized, summary, success

