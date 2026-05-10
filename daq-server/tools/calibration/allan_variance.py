#!/usr/bin/env python3
"""
Allan Variance Analysis for Pressure Transducer Noise Characterization

Paper Section 3: Decomposes measurement noise into fundamental stochastic processes:
- White noise (Q): thermal, quantization
- Flicker noise (B): 1/f, bias instability
- Bias random walk (K): long-term drift
- Rate random walk (R): acceleration of drift

σ²_A(τ) = Q²/(2τ) + 2·ln(2)·B² + K²·τ/6 + R²·τ²/20

Usage:
    from allan_variance import compute_allan_variance, fit_noise_coefficients, measurement_uncertainty
"""

import numpy as np
from typing import Tuple, Optional
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)


@dataclass
class NoiseCoefficients:
    """Noise coefficients from Allan variance fit"""

    Q: float  # White noise (quantization)
    B: float  # Bias instability (flicker)
    K: float  # Bias random walk
    R: float  # Rate random walk
    tau_min: float  # τ at minimum Allan variance
    sigma_min: float  # Minimum Allan deviation


def compute_allan_variance(
    timeseries: np.ndarray,
    tau0: float,
    max_clusters: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Compute Allan variance at multiple averaging times τ = m·τ0.

    Args:
        timeseries: Voltage or ADC time series (1D)
        tau0: Sampling interval (seconds)
        max_clusters: Max cluster size (default: N/4)

    Returns:
        tau_arr: Averaging times [τ0, 2τ0, 4τ0, ...]
        sigma2_arr: Allan variance σ²_A(τ) at each τ
    """
    n = len(timeseries)
    if n < 10:
        return np.array([tau0]), np.array([np.var(timeseries)])

    max_m = max_clusters or max(2, n // 4)
    tau_list = []
    sigma2_list = []

    m = 1
    while m <= max_m and n >= 3 * m:
        # Cluster averages: x̄_i = (1/m) Σ_{k=0}^{m-1} x_{i*m+k}
        num_triplets = (n - 2 * m) // m  # need i, i+m, i+2m
        if num_triplets < 1:
            break

        clusters = np.array(
            [np.mean(timeseries[i * m : (i + 1) * m]) for i in range(num_triplets + 2)]
        )

        # Allan variance: (1/2) · mean of (x̄_{i+2} - 2·x̄_{i+1} + x̄_i)²
        diffs = clusters[2:] - 2 * clusters[1:-1] + clusters[:-2]
        sigma2 = 0.5 * np.mean(diffs**2)
        tau = m * tau0

        tau_list.append(tau)
        sigma2_list.append(sigma2)
        m = 2 * m if m >= 2 else m + 1

    return np.array(tau_list), np.array(sigma2_list)


def fit_noise_coefficients(
    tau_arr: np.ndarray,
    sigma2_arr: np.ndarray,
) -> NoiseCoefficients:
    """
    Fit noise model: σ²_A(τ) = Q²/(2τ) + 2·ln(2)·B² + K²·τ/6 + R²·τ²/20

    Uses least-squares on log-scale for stability.

    Returns:
        NoiseCoefficients(Q, B, K, R, tau_min, sigma_min)
    """
    if len(tau_arr) < 3:
        return NoiseCoefficients(
            Q=1e-3,
            B=1e-4,
            K=1e-5,
            R=1e-6,
            tau_min=tau_arr[0] if len(tau_arr) > 0 else 1.0,
            sigma_min=np.sqrt(sigma2_arr[0]) if len(sigma2_arr) > 0 else 1e-3,
        )

    # Design matrix: [1/τ, 1, τ, τ²]
    X = np.column_stack(
        [
            1.0 / (2 * tau_arr),
            np.full_like(tau_arr, 2 * np.log(2)),
            tau_arr / 6,
            tau_arr**2 / 20,
        ]
    )
    y = sigma2_arr

    try:
        beta, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
        Q = np.sqrt(max(beta[0], 1e-12))
        B = np.sqrt(max(beta[1], 1e-12))
        K = np.sqrt(max(beta[2], 1e-12))
        R = np.sqrt(max(beta[3], 1e-12))
    except np.linalg.LinAlgError:
        Q, B, K, R = 1e-3, 1e-4, 1e-5, 1e-6

    # τ_min ≈ sqrt(3*Q²/K²) for white + random walk
    tau_min = (
        np.sqrt(3 * Q**2 / (K**2 + 1e-20)) if K > 1e-10 else tau_arr[len(tau_arr) // 2]
    )
    tau_min = np.clip(tau_min, tau_arr.min(), tau_arr.max())
    sigma_min = np.sqrt(
        Q**2 / (2 * tau_min)
        + 2 * np.log(2) * B**2
        + K**2 * tau_min / 6
        + R**2 * tau_min**2 / 20
    )

    return NoiseCoefficients(Q=Q, B=B, K=K, R=R, tau_min=tau_min, sigma_min=sigma_min)


def measurement_uncertainty(
    tau: float,
    coeffs: NoiseCoefficients,
    voltage: float = 0.0,
    sigma_base: float = 1e-3,
) -> float:
    """
    Measurement uncertainty σ_meas(v, τ) from paper Section 7.

    σ²_meas = σ²_base + Q²/(2τ) + 2·ln(2)·B² + K²·τ/6 + α_v·v²

    Args:
        tau: Averaging time (seconds)
        coeffs: Noise coefficients from fit_noise_coefficients
        voltage: Optional voltage for heteroscedastic term
        sigma_base: Base noise floor

    Returns:
        σ_meas in same units as input (PSI if voltage→PSI calibrated)
    """
    var = sigma_base**2
    var += coeffs.Q**2 / (2 * tau)
    var += 2 * np.log(2) * coeffs.B**2
    var += coeffs.K**2 * tau / 6
    var += 1e-4 * voltage**2  # α_v · v²
    return np.sqrt(max(var, 1e-12))


def analyze_sensor_noise(
    timeseries: np.ndarray,
    tau0: float = 0.01,
) -> Tuple[NoiseCoefficients, np.ndarray, np.ndarray]:
    """
    Full analysis: compute Allan variance, fit coefficients, return all.

    Args:
        timeseries: Voltage or ADC series
        tau0: Sampling interval (s)

    Returns:
        (coeffs, tau_arr, sigma2_arr)
    """
    tau_arr, sigma2_arr = compute_allan_variance(timeseries, tau0)
    coeffs = fit_noise_coefficients(tau_arr, sigma2_arr)
    return coeffs, tau_arr, sigma2_arr


if __name__ == "__main__":
    # Demo with synthetic noise
    np.random.seed(42)
    n = 10000
    tau0 = 0.01
    t = np.arange(n) * tau0
    # White + random walk
    white = np.random.randn(n) * 0.01
    rw = np.cumsum(np.random.randn(n) * 0.001)
    x = white + rw

    coeffs, tau_arr, sigma2_arr = analyze_sensor_noise(x, tau0)
    print(f"Q={coeffs.Q:.2e} B={coeffs.B:.2e} K={coeffs.K:.2e} R={coeffs.R:.2e}")
    print(f"τ_min={coeffs.tau_min:.3f}s σ_min={coeffs.sigma_min:.2e}")
    sigma_1s = measurement_uncertainty(1.0, coeffs)
    print(f"σ_meas(τ=1s) = {sigma_1s:.2e}")
