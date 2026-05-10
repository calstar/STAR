from __future__ import annotations

from typing import Tuple

import numpy as np


def generate_pressure_profile(
    profile_type: str,
    start_value: float,
    end_value: float,
    duration: float,
    n_steps: int,
    **params,
) -> Tuple[np.ndarray, np.ndarray]:
    """Generate a pressure profile over time using analytic functions.

    Parameters
    ----------
    profile_type : str
        One of "linear", "exponential", or "power".
    start_value : float
        Initial pressure value (arbitrary units – caller handles unit conversion).
    end_value : float
        Final pressure value at t = duration.
    duration : float
        Total time span in seconds.
    n_steps : int
        Number of discrete samples (>= 2).
    params : dict
        Additional shape parameters. Supported keys:
            - decay_constant (exponential): positive float controlling curvature (default 3.0)
            - power (power): exponent > 0 (default 2.0)

    Returns
    -------
    times : np.ndarray
        Array of monotonically increasing time values in seconds (size n_steps).
    values : np.ndarray
        Pressure values corresponding to `times` (same units as inputs).
    """

    if n_steps < 2:
        raise ValueError("n_steps must be at least 2 for time-series generation")

    duration = max(float(duration), 1e-6)
    times = np.linspace(0.0, duration, n_steps)
    x = times / duration  # Normalized progress 0 → 1

    profile_type_lower = profile_type.lower().strip()

    if profile_type_lower == "linear":
        factor = x
    elif profile_type_lower == "exponential":
        decay_constant = float(params.get("decay_constant", 3.0))
        decay_constant = max(decay_constant, 1e-6)
        numerator = 1.0 - np.exp(-decay_constant * x)
        denominator = 1.0 - np.exp(-decay_constant)
        if denominator <= 1e-9:
            factor = x  # Nearly linear
        else:
            factor = numerator / denominator
    elif profile_type_lower == "power":
        power = max(float(params.get("power", 2.0)), 1e-6)
        factor = x ** power
    else:
        raise ValueError(f"Unsupported profile type '{profile_type}'.")

    values = start_value + (end_value - start_value) * factor
    return times, values
