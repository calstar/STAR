"""Feed tank/manifold pressure vs time — regime selection and the dome-regulated curve (Phys §6.2).

Regimes: ``blowdown`` (passive ullage expansion), ``dome_regulated`` (regulated setpoint + EOB
droop), ``active`` (legacy free-form segmented curve — needs closed-loop pressure control).
"""

from __future__ import annotations

from typing import Any, Optional, Tuple
import numpy as np

_PA_PER_PSI = 6894.757
_DRIFT_PSI_PER_1000_PSI_INLET = 0.010  # Aqua 1092 supply-pressure effect [Phys §6.1]


VALID_FEED_PRESSURE_MODELS = ("blowdown", "dome_regulated", "active")


def get_feed_pressure_model(config: Any) -> str:
    """Return the Layer-2 feed-pressure regime: ``blowdown``, ``dome_regulated`` or ``active``.

    Missing or unrecognised values resolve to ``active`` — the legacy free-form segment search —
    so configs that never declared a regime keep the behaviour they have today. This is
    deliberately NOT the schema default: ``DesignRequirementsConfig.feed_pressure_model`` defaults
    to ``dome_regulated``; this fallback only applies when design requirements are absent entirely
    (or carry a value the schema never validated, e.g. a mock in tests).
    """
    dr = getattr(config, "design_requirements", None)
    if dr is None:
        return "active"
    model = getattr(dr, "feed_pressure_model", None)
    if model is None:
        return "active"
    normalized = str(model).strip().lower()
    return normalized if normalized in VALID_FEED_PRESSURE_MODELS else "active"


def generate_dome_regulated_pressure_curve(
    P_set_pa: float,
    *,
    burn_time_s: float,
    n_points: int = 200,
    P_inlet_0_pa: Optional[float] = None,
    P_inlet_end_pa: Optional[float] = None,
    ripple_pa: Optional[float] = None,
    lockup_inlet_pa: Optional[float] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Eq. (6.2): regulated setpoint + slow inlet drift + bounded ripple; EOB droop at lockup.

    Returns (time_s, P_tank_pa).
    """
    n_points = max(2, int(n_points))
    t = np.linspace(0.0, max(burn_time_s, 1e-6), n_points)
    P_set = float(P_set_pa)
    if P_inlet_0_pa is None:
        P_inlet_0_pa = P_set * 1.15
    if P_inlet_end_pa is None:
        P_inlet_end_pa = P_inlet_0_pa * 0.75
    if ripple_pa is None:
        ripple_pa = 14.0 * _PA_PER_PSI  # assumed ±14 psi (T6)
    P_in = P_inlet_0_pa + (P_inlet_end_pa - P_inlet_0_pa) * (t / t[-1])
    # Supply-pressure effect: outlet rises ~0.010 Pa per Pa of inlet drop (the psi/psi ratio is unitless,
    # so this works directly in Pa). [Phys §6.1, ref 16]
    drift = _DRIFT_PSI_PER_1000_PSI_INLET * (P_inlet_0_pa - P_in)
    # Illustrative bounded ripple (not a measured spectrum)
    ripple = ripple_pa * 0.5 * (np.sin(2 * np.pi * 3.0 * t / t[-1]) + 0.3 * np.sin(2 * np.pi * 7.0 * t / t[-1]))
    P = P_set + drift + ripple
    if lockup_inlet_pa is not None and np.isfinite(lockup_inlet_pa):
        droop_mask = P_in < lockup_inlet_pa
        if np.any(droop_mask):
            frac = np.clip((lockup_inlet_pa - P_in) / max(lockup_inlet_pa, 1.0), 0.0, 1.0)
            P = P - frac * 0.08 * P_set * droop_mask
    return t, P


def generate_blowdown_reference_curve(
    P_set_pa: float,
    *,
    burn_time_s: float,
    n_points: int = 40,
    decay_fraction: float = 0.35,
) -> Tuple[np.ndarray, np.ndarray]:
    """Legacy monotonic blowdown reference for contrast plots (viz #6)."""
    n_points = max(2, int(n_points))
    t = np.linspace(0.0, max(burn_time_s, 1e-6), n_points)
    P = P_set_pa * (1.0 - decay_fraction * t / t[-1])
    return t, P


def dome_regulated_tank_pair(
    initial_lox_pa: float,
    initial_fuel_pa: float,
    burn_time_s: float,
    n_points: int = 200,
    *,
    copv_initial_pa: Optional[float] = None,
    copv_end_pa: Optional[float] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Generate LOX and fuel regulated manifold curves for Layer 2 / time solver."""
    if copv_initial_pa is None:
        copv_initial_pa = max(initial_lox_pa, initial_fuel_pa) * 1.2
    if copv_end_pa is None:
        copv_end_pa = copv_initial_pa * 0.7
    t, P_O = generate_dome_regulated_pressure_curve(
        initial_lox_pa, burn_time_s=burn_time_s, n_points=n_points,
        P_inlet_0_pa=copv_initial_pa, P_inlet_end_pa=copv_end_pa,
    )
    _, P_F = generate_dome_regulated_pressure_curve(
        initial_fuel_pa, burn_time_s=burn_time_s, n_points=n_points,
        P_inlet_0_pa=copv_initial_pa, P_inlet_end_pa=copv_end_pa,
    )
    P_O[0] = initial_lox_pa
    P_F[0] = initial_fuel_pa
    return t, P_O, P_F
