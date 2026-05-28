"""
Shared engine time-series evaluation used by the Time Series API and Layer 2 pure blowdown.

Keeps a single branching rule: same as ``compute_timeseries_results`` in
``backend/routers/timeseries.py`` — ablative geometry tracking uses the fully-coupled
time-varying path; otherwise per-point ``evaluate_arrays`` (``evaluate()`` per step).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import numpy as np

from engine.core.runner import PintleEngineRunner


def eval_runner_timeseries_like_api(
    runner: PintleEngineRunner,
    times: np.ndarray,
    P_tank_O_pa: np.ndarray,
    P_tank_F_pa: np.ndarray,
) -> Dict[str, Any]:
    """
    Evaluate engine over a pressure history using the same logic as Time Series Analysis.

    Parameters
    ----------
    runner
        Configured ``PintleEngineRunner`` (same config semantics as the loaded API runner).
    times
        Time nodes [s], same length as pressure arrays.
    P_tank_O_pa, P_tank_F_pa
        Tank pressures [Pa] at each time.
    """
    times = np.asarray(times, dtype=float)
    P_tank_O_pa = np.asarray(P_tank_O_pa, dtype=float)
    P_tank_F_pa = np.asarray(P_tank_F_pa, dtype=float)

    ablative_cfg = runner.config.ablative_cooling
    use_time_varying = (
        ablative_cfg is not None
        and ablative_cfg.enabled
        and getattr(ablative_cfg, "track_geometry_evolution", False)
        and len(times) >= 2
    )

    if use_time_varying:
        return runner.evaluate_arrays_with_time(
            times,
            P_tank_O_pa,
            P_tank_F_pa,
            use_coupled_solver=True,
        )
    return runner.evaluate_arrays(P_tank_O_pa, P_tank_F_pa)


def apply_propellant_depletion_mask_to_runner_results(
    results: Dict[str, Any],
    times: np.ndarray,
    lox_mass_kg: Optional[np.ndarray],
    fuel_mass_kg: Optional[np.ndarray],
) -> None:
    """
    Zero performance metrics at steps where LOX or fuel mass is depleted, in-place.

    Depleted means mass <= 1e-4 kg, matching ``compute_timeseries_results`` flameout masking.
    """
    times = np.asarray(times, dtype=float)
    n = len(times)

    def _to_float_array(arr: np.ndarray) -> np.ndarray:
        try:
            return np.asarray(arr, dtype=float)
        except Exception:
            return np.zeros(n)

    mask: Optional[np.ndarray] = None

    if lox_mass_kg is not None and len(lox_mass_kg) == len(times):
        lox_m = _to_float_array(np.asarray(lox_mass_kg))
        mask = lox_m <= 1e-4

    if fuel_mass_kg is not None and len(fuel_mass_kg) == len(times):
        fuel_m = _to_float_array(np.asarray(fuel_mass_kg))
        mask_f = fuel_m <= 1e-4
        mask = mask_f if mask is None else (mask | mask_f)

    if mask is None or not np.any(mask):
        return

    keys_float = [
        "Pc",
        "F",
        "Isp",
        "MR",
        "mdot_O",
        "mdot_F",
        "mdot_total",
        "cstar_actual",
        "gamma",
        "stability_score",
        "chugging_stability_margin",
        "v_exit",
        "P_exit",
        "cstar_ideal",
        "eta_cstar",
    ]
    for key in keys_float:
        if key not in results:
            continue
        arr = np.asarray(results[key], dtype=float)
        if arr.shape[0] != n:
            continue
        arr = arr.copy()
        arr[mask] = 0.0
        results[key] = arr
