"""Find minimum-fuel burn time to reach a target apogee for a fixed time-series curve.

For each candidate burn time T we truncate the thrust/mdot curve, load exactly the
propellant required to complete that burn (∫mdot dt), and run flight simulation.
The optimal burn time is the shortest T whose apogee meets the altitude target —
which minimizes fuel mass because fuel_required(T) increases monotonically with T.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

import numpy as np


@dataclass
class BurnTimeEval:
    burn_time_s: float
    lox_required_kg: float
    fuel_required_kg: float
    apogee_m: float
    success: bool
    error: Optional[str] = None


@dataclass
class AltitudeOptimizeResult:
    success: bool
    target_apogee_m: float
    apogee_tolerance_m: float
    optimal_burn_time_s: float
    optimal_lox_kg: float
    optimal_fuel_kg: float
    achieved_apogee_m: float
    apogee_error_m: float
    total_impulse_Ns: float
    simulations_run: int
    infeasible_reason: Optional[str] = None
    evaluations: List[BurnTimeEval] = field(default_factory=list)


def _integrate(times: np.ndarray, values: np.ndarray) -> float:
    if len(times) < 2:
        return 0.0
    if hasattr(np, "trapezoid"):
        return float(np.trapezoid(values, times))
    return float(np.trapz(values, times))


def truncate_time_series(
    times: np.ndarray,
    thrust: np.ndarray,
    mdot_O: np.ndarray,
    mdot_F: np.ndarray,
    burn_time_s: float,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return curve arrays truncated to burn_time_s (interpolated endpoint)."""
    times = np.asarray(times, dtype=float)
    thrust = np.asarray(thrust, dtype=float)
    mdot_O = np.asarray(mdot_O, dtype=float)
    mdot_F = np.asarray(mdot_F, dtype=float)

    if len(times) < 2:
        raise ValueError("Time-series must contain at least two points")

    t0 = float(times[0])
    times = times - t0
    t_end = float(np.clip(burn_time_s, times[0], times[-1]))
    if t_end <= times[0]:
        t_end = float(times[1])

    mask = times <= t_end + 1e-12
    t_out = times[mask]
    thrust_out = thrust[mask]
    mdot_O_out = mdot_O[mask]
    mdot_F_out = mdot_F[mask]

    if t_out[-1] < t_end - 1e-9:
        t_out = np.append(t_out, t_end)
        thrust_out = np.append(thrust_out, np.interp(t_end, times, thrust))
        mdot_O_out = np.append(mdot_O_out, np.interp(t_end, times, mdot_O))
        mdot_F_out = np.append(mdot_F_out, np.interp(t_end, times, mdot_F))

    return t_out, thrust_out, mdot_O_out, mdot_F_out


def required_propellant_at_burn_time(
    times: np.ndarray,
    thrust: np.ndarray,
    mdot_O: np.ndarray,
    mdot_F: np.ndarray,
    burn_time_s: float,
) -> Tuple[float, float, float]:
    """Return (lox_kg, fuel_kg, total_impulse_Ns) for burn truncated to burn_time_s."""
    t_out, thrust_out, mdot_O_out, mdot_F_out = truncate_time_series(
        times, thrust, mdot_O, mdot_F, burn_time_s
    )
    lox_kg = _integrate(t_out, mdot_O_out)
    fuel_kg = _integrate(t_out, mdot_F_out)
    impulse = _integrate(t_out, thrust_out)
    return lox_kg, fuel_kg, impulse


def optimize_minimum_fuel_burn_time(
    *,
    times: np.ndarray,
    thrust: np.ndarray,
    mdot_O: np.ndarray,
    mdot_F: np.ndarray,
    target_apogee_m: float,
    apogee_tolerance_m: float,
    simulate_at_burn_time: Callable[[float], BurnTimeEval],
    min_burn_time_s: Optional[float] = None,
    max_burn_time_s: Optional[float] = None,
    time_resolution_s: float = 0.05,
    max_iterations: int = 24,
) -> AltitudeOptimizeResult:
    """Binary-search the shortest burn time that reaches target_apogee_m."""
    times_norm = np.asarray(times, dtype=float)
    times_norm = times_norm - times_norm[0]
    t_max_curve = float(times_norm[-1])

    t_lo = float(min_burn_time_s) if min_burn_time_s is not None else max(0.05, float(times_norm[1] - times_norm[0]))
    t_hi = float(max_burn_time_s) if max_burn_time_s is not None else t_max_curve
    t_lo = max(t_lo, 0.05)
    t_hi = min(t_hi, t_max_curve)
    if t_lo >= t_hi:
        t_lo = max(0.05, t_hi * 0.1)

    evaluations: List[BurnTimeEval] = []
    sim_count = 0

    def _eval(t: float) -> BurnTimeEval:
        nonlocal sim_count
        sim_count += 1
        result = simulate_at_burn_time(t)
        evaluations.append(result)
        return result

    full_eval = _eval(t_hi)
    if not full_eval.success:
        return AltitudeOptimizeResult(
            success=False,
            target_apogee_m=target_apogee_m,
            apogee_tolerance_m=apogee_tolerance_m,
            optimal_burn_time_s=0.0,
            optimal_lox_kg=0.0,
            optimal_fuel_kg=0.0,
            achieved_apogee_m=0.0,
            apogee_error_m=target_apogee_m,
            total_impulse_Ns=0.0,
            simulations_run=sim_count,
            infeasible_reason=full_eval.error or "Flight simulation failed at maximum burn time",
            evaluations=evaluations,
        )

    target_min = target_apogee_m - apogee_tolerance_m
    if full_eval.apogee_m < target_min:
        lox_full, fuel_full, impulse_full = required_propellant_at_burn_time(
            times, thrust, mdot_O, mdot_F, t_hi
        )
        return AltitudeOptimizeResult(
            success=False,
            target_apogee_m=target_apogee_m,
            apogee_tolerance_m=apogee_tolerance_m,
            optimal_burn_time_s=t_hi,
            optimal_lox_kg=lox_full,
            optimal_fuel_kg=fuel_full,
            achieved_apogee_m=full_eval.apogee_m,
            apogee_error_m=target_apogee_m - full_eval.apogee_m,
            total_impulse_Ns=impulse_full,
            simulations_run=sim_count,
            infeasible_reason=(
                f"Full time-series burn ({t_hi:.2f}s) reaches only {full_eval.apogee_m:.0f} m "
                f"(target {target_apogee_m:.0f} m). Re-run time-series with higher thrust or longer burn."
            ),
            evaluations=evaluations,
        )

    lo_eval = _eval(t_lo)
    if lo_eval.success and lo_eval.apogee_m >= target_min:
        best = lo_eval
    else:
        lo = t_lo
        hi = t_hi
        best = full_eval
        for _ in range(max_iterations):
            if hi - lo <= time_resolution_s:
                break
            mid = 0.5 * (lo + hi)
            mid_eval = _eval(mid)
            if not mid_eval.success:
                lo = mid
                continue
            if mid_eval.apogee_m >= target_min:
                hi = mid
                best = mid_eval
            else:
                lo = mid

        feasible = [
            e for e in evaluations
            if e.success and e.apogee_m >= target_min
        ]
        if feasible:
            best = min(feasible, key=lambda e: e.fuel_required_kg)

    lox_opt, fuel_opt, impulse_opt = required_propellant_at_burn_time(
        times, thrust, mdot_O, mdot_F, best.burn_time_s
    )

    return AltitudeOptimizeResult(
        success=True,
        target_apogee_m=target_apogee_m,
        apogee_tolerance_m=apogee_tolerance_m,
        optimal_burn_time_s=best.burn_time_s,
        optimal_lox_kg=lox_opt,
        optimal_fuel_kg=fuel_opt,
        achieved_apogee_m=best.apogee_m,
        apogee_error_m=best.apogee_m - target_apogee_m,
        total_impulse_Ns=impulse_opt,
        simulations_run=sim_count,
        evaluations=evaluations,
    )
