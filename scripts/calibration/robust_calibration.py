#!/usr/bin/env python3
"""
Robust Calibration Framework for Pressure Transducers
Based on the mathematical framework from PressureTransducerCalibrationFramework.tex

Implements:
- Bayesian regression with hierarchical priors
- Total Least Squares (TLS) for robust calibration
- Recursive Least Squares (RLS) with forgetting
- Generalized Likelihood Ratio (GLR) testing for drift detection
- Environmental-robust calibration maps
- Extended Kalman Filter integration for bias correction
"""

import time
import numpy as np
import scipy.linalg as la
import scipy.stats as stats
from typing import Dict, List, Tuple, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from allan_variance import NoiseCoefficients
from dataclasses import dataclass
from collections import deque
import logging

logger = logging.getLogger(__name__)


@dataclass
class EnvironmentalState:
    """Environmental state vector: [T, H, V, A, M]"""

    temperature: float = 25.0  # °C
    humidity: float = 50.0  # %
    vibration: float = 0.0  # g
    aging_factor: float = 1.0  # dimensionless
    mounting_torque: float = 1.0  # dimensionless


class GaussMarkovBiasModel:
    """
    Paper Section 4: Stochastic bias db/dt = -b/τ_b + w_b.
    3-state bias: τ_fast=1s, τ_medium=100s, τ_slow=10⁴s.
    Discrete: b_{k+1} = Φ_b b_k + w_b.
    """

    def __init__(
        self,
        tau_fast: float = 1.0,
        tau_medium: float = 100.0,
        tau_slow: float = 1e4,
        process_noise: float = 1e-4,
    ):
        self.tau = np.array([tau_fast, tau_medium, tau_slow])
        self.b = np.zeros(3)
        self.P_b = np.eye(3) * 0.01  # bias covariance
        self.process_noise = process_noise
        self._last_t = 0.0
        self.h = np.ones(3)  # observation: pressure += h'b

    def propagate(self, dt: float) -> None:
        """b_{k+1} = Φ_b b_k, P_{k+1} = Φ_b P Φ_b' + Q."""
        phi_b = np.diag(np.exp(-dt / self.tau))
        q = self.process_noise * (1 - np.exp(-2 * dt / self.tau))
        Q = np.diag(q)
        self.b = phi_b @ self.b
        self.P_b = phi_b @ self.P_b @ phi_b.T + Q

    def update(self, residual: float, sigma_meas: float, dt: float) -> None:
        """Innovation update: residual = y_obs - (φ'θ + h'b)."""
        self.propagate(dt)
        S = float(self.h @ self.P_b @ self.h + sigma_meas**2)
        K = self.P_b @ self.h / max(S, 1e-12)
        self.b = self.b + K * residual
        self.P_b = (np.eye(3) - np.outer(K, self.h)) @ self.P_b

    def bias_contribution(self) -> float:
        """h'b for pressure prediction."""
        return float(self.h @ self.b)

    def bias_variance(self) -> float:
        """h' Σ_b h for uncertainty."""
        return float(self.h @ self.P_b @ self.h)


@dataclass
class CalibrationPoint:
    """Single calibration data point"""

    adc_code: float  # Raw ADC code (signed 32-bit, not voltage)
    pressure: float
    timestamp: float
    environmental_state: EnvironmentalState
    uncertainty: float = 0.01  # Default 1% uncertainty


class RobustCalibrationFramework:
    """
    Mathematically robust calibration framework implementing the paper's algorithms
    """

    def __init__(self, sensor_id: int):
        self.sensor_id = sensor_id

        # Calibration data
        self.calibration_points: List[CalibrationPoint] = []

        # Bayesian parameters — 9-parameter basis (paper φ₀–φ₈)
        self.n_params = 9
        self.population_prior_mean = np.array(
            [0.0, 200.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        )  # θ₀ offset, θ₁ linear (PSI/V), rest env terms
        self.population_prior_cov = np.eye(9) * 0.1
        self.individual_prior_cov = np.eye(9) * 0.05

        # Current calibration parameters
        self.theta_mean = self.population_prior_mean.copy()
        self.theta_cov = self.individual_prior_cov.copy()

        # RLS parameters
        self.rls_P = np.eye(9) * 100.0  # Initial covariance
        self.forgetting_factor = 0.95

        # GLR test parameters
        self.glr_threshold = 2.0  # Chi-squared threshold
        self.glr_window_size = 10

        # Environmental variance model (paper Section 7)
        self.env_variance_base = 1e-3  # σ²_base
        self.alpha_v = 1e-4  # voltage-dependent noise
        self.alpha_extrap = 100.0  # extrapolation penalty (PSI²)
        self.env_variance_matrices = {
            "env": np.eye(5) * 0.0001,
            "interaction": np.eye(5) * 0.00001,
        }

        # Autonomy score (paper Section 8): α = 0.4·α_cal + 0.3·α_unc + 0.2·α_agree + 0.1·α_quality
        self.recent_residuals: deque = deque(maxlen=10)  # for α_agree
        self.recent_uncertainties: deque = deque(maxlen=10)  # for α_unc
        self.calibration_points_max = (
            50  # cap to prevent unbounded growth over long sessions
        )
        self.sigma_ref = 10.0  # PSI reference for α_unc

        # Physical calibration map parameters
        self.physical_params = {
            "alpha1": 0.001,
            "alpha2": 0.0001,
            "beta1": 0.0001,
            "beta2": 0.00001,
            "gamma1": 0.0001,
            "delta1": 0.001,
            "delta2": 0.0001,
        }

        # Gauss-Markov bias (paper Section 4)
        self.bias_model = GaussMarkovBiasModel()
        self._last_pred_t = time.time()
        self._last_bias_update_t = time.time()

        # Inflation/deflation (paper Section 7): σ_adj = σ * inflation_factor
        self.inflation_factor = 1.0

        # Optional Allan variance: when set, use for σ²_meas
        self._noise_coeffs: Optional["NoiseCoefficients"] = None
        self._allan_tau0 = 0.01

    def set_theta_from_polynomial(
        self,
        poly_coeffs: List[float],
        adc_norm_min: float,
        adc_norm_scale: float,
    ) -> None:
        """
        Initialize theta from polynomial calibration P = c0 + c1*x + c2*x^2 + c3*x^3
        where x = (adc - adc_norm_min) / adc_norm_scale.
        Gives robust calibration the correct slope so ZERO ALL + CAPTURE match polynomial accuracy.
        """
        if len(poly_coeffs) < 2 or adc_norm_scale <= 0:
            return
        c0, c1 = float(poly_coeffs[0]), float(poly_coeffs[1])
        # Robust: P = theta[0] + theta[1]*adc_norm, adc_norm = adc/1e9
        # Polynomial slope dP/d(adc) = c1/scale. So theta[1]/1e9 = c1/scale → theta[1] = c1*1e9/scale
        theta1 = c1 * 1e9 / adc_norm_scale
        # At adc=adc_norm_min, x=0, P=c0. So theta[0] + theta[1]*min/1e9 = c0
        theta0 = c0 - theta1 * adc_norm_min / 1e9
        self.theta_mean = np.array([theta0, theta1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        self.population_prior_mean = self.theta_mean.copy()
        logger.info(
            f"Sensor {self.sensor_id}: prior from polynomial θ₀={theta0:.2f} θ₁={theta1:.0f}"
        )

    def environmental_robust_basis_functions(
        self, adc_code: float, env: EnvironmentalState
    ) -> np.ndarray:
        """
        Environmental-robust basis functions from equation (66-72)
        Works directly on ADC codes (not voltage).
        """
        T, H, V, A, M = (
            env.temperature,
            env.humidity,
            env.vibration,
            env.aging_factor,
            env.mounting_torque,
        )

        # Normalize ADC code (v ≈ adc*2.5/2^31); use adc_norm ~ [-1,1] for stability
        adc_norm = adc_code / 1e9
        v = max(adc_norm, 1e-6)  # clamp for log/sqrt

        # Paper: 9-parameter environmental-robust basis (φ₀–φ₈)
        phi = np.zeros(9)
        phi[0] = 1.0
        phi[1] = adc_norm
        phi[2] = (
            adc_norm**2
            + self.physical_params["alpha1"] * T * adc_norm
            + self.physical_params["alpha2"] * H * adc_norm
        )
        phi[3] = (
            adc_norm**3
            + self.physical_params["beta1"] * T * adc_norm**2
            + self.physical_params["beta2"] * V * adc_norm
        )
        phi[4] = np.sqrt(v) + self.physical_params["gamma1"] * A * np.log(v)
        phi[5] = (
            np.log(1 + adc_norm)
            + self.physical_params["delta1"] * T
            + self.physical_params["delta2"] * H
        )
        phi[6] = adc_norm * T * H  # temp-humidity interaction
        phi[7] = adc_norm**2 * V * M  # vibration-mounting interaction
        phi[8] = A * adc_norm**3  # aging-nonlinearity coupling

        return phi

    def total_least_squares_calibration(
        self, points: List[CalibrationPoint]
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Total Least Squares calibration accounting for errors in both voltage and pressure
        Equation (112-118)
        """
        if len(points) < 3:
            return self.theta_mean, self.theta_cov

        n = len(points)
        Phi = np.zeros((n, 9))
        p_obs = np.zeros(n)
        weights = np.zeros(n)

        for i, point in enumerate(points):
            Phi[i] = self.environmental_robust_basis_functions(
                point.adc_code, point.environmental_state
            )
            p_obs[i] = point.pressure
            weights[i] = 1.0 / (point.uncertainty**2 + self.env_variance_base)

        # Weighted least squares
        W = np.diag(weights)
        Phi_T_W = Phi.T @ W
        try:
            cov_inv = Phi_T_W @ Phi + np.eye(9) * 1e-6  # Regularization
            theta_mean = la.solve(cov_inv, Phi_T_W @ p_obs)
            theta_cov = la.inv(cov_inv)
        except la.LinAlgError:
            logger.warning(
                f"TLS calibration failed for sensor {self.sensor_id}, using previous parameters"
            )
            return self.theta_mean, self.theta_cov

        return theta_mean, theta_cov

    def bayesian_update(
        self, new_points: List[CalibrationPoint]
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Bayesian update with hierarchical priors
        Equations (126-149)
        """
        if not new_points:
            return self.theta_mean, self.theta_cov

        # Compute likelihood parameters
        theta_mean_tls, theta_cov_tls = self.total_least_squares_calibration(new_points)

        # Hierarchical Bayesian update
        # Prior: N(theta_mean, theta_cov)
        # Likelihood: N(theta_mean_tls, theta_cov_tls)

        # Posterior precision matrix
        prior_precision = la.inv(self.theta_cov + np.eye(9) * 1e-6)
        likelihood_precision = la.inv(theta_cov_tls + np.eye(9) * 1e-6)
        posterior_precision = prior_precision + likelihood_precision

        # Posterior mean
        posterior_cov = la.inv(posterior_precision)
        posterior_mean = posterior_cov @ (
            prior_precision @ self.theta_mean + likelihood_precision @ theta_mean_tls
        )

        return posterior_mean, posterior_cov

    def recursive_least_squares_update(
        self, point: CalibrationPoint
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Recursive Least Squares with forgetting factor
        Equations (162-166)
        """
        phi = self.environmental_robust_basis_functions(
            point.adc_code, point.environmental_state
        )

        # RLS update equations
        Pphi = self.rls_P @ phi  # (9,)
        denom = self.forgetting_factor + phi @ Pphi  # scalar
        K = Pphi / denom  # (6,)
        prediction_error = point.pressure - phi @ self.theta_mean

        # Update parameters
        self.theta_mean = self.theta_mean + K * prediction_error
        self.rls_P = (self.rls_P - np.outer(K, Pphi)) / self.forgetting_factor

        # Add forgetting covariance
        forgetting_cov = np.eye(9) * 0.001
        self.theta_cov = self.rls_P + forgetting_cov

        return self.theta_mean, self.theta_cov

    def generalized_likelihood_ratio_test(
        self, new_points: List[CalibrationPoint]
    ) -> Tuple[float, bool]:
        """
        GLR test for drift detection
        Equations (235-248)
        """
        if len(new_points) < self.glr_window_size:
            return 0.0, False

        # Use recent points for GLR test
        recent_points = new_points[-self.glr_window_size :]

        # Compute likelihood under current model
        log_likelihood_current = 0.0
        for point in recent_points:
            phi = self.environmental_robust_basis_functions(
                point.adc_code, point.environmental_state
            )
            predicted_pressure = phi.T @ self.theta_mean
            residual = point.pressure - predicted_pressure
            variance = point.uncertainty**2 + self.env_variance_base
            log_likelihood_current += -0.5 * (
                residual**2 / variance + np.log(2 * np.pi * variance)
            )

        # Compute likelihood under unconstrained model (TLS fit to recent data)
        theta_tls, _ = self.total_least_squares_calibration(recent_points)
        log_likelihood_unconstrained = 0.0
        for point in recent_points:
            phi = self.environmental_robust_basis_functions(
                point.adc_code, point.environmental_state
            )
            predicted_pressure = phi.T @ theta_tls
            residual = point.pressure - predicted_pressure
            variance = point.uncertainty**2 + self.env_variance_base
            log_likelihood_unconstrained += -0.5 * (
                residual**2 / variance + np.log(2 * np.pi * variance)
            )

        # GLR statistic
        glr_statistic = 2 * (log_likelihood_unconstrained - log_likelihood_current)

        # Drift detected if GLR exceeds threshold
        drift_detected = glr_statistic > self.glr_threshold

        return glr_statistic, drift_detected

    def _extrapolation_variance(self, adc_code: float) -> float:
        """Paper Section 7: σ²_extrap when adc outside calibrated range."""
        if not self.calibration_points:
            return 0.0
        adcs = np.array([p.adc_code for p in self.calibration_points])
        v_min, v_max = adcs.min(), adcs.max()
        delta_v = max(v_max - v_min, 1e6)
        # Cap exp(2*d) to avoid overflow (~709); use 100 for reasonable extrap penalty
        exp_cap = 100.0
        if adc_code < v_min:
            d = (v_min - adc_code) / delta_v
            exp_val = np.exp(min(2 * d, exp_cap))
            return self.alpha_extrap * d**2 * exp_val
        if adc_code > v_max:
            d = (adc_code - v_max) / delta_v
            exp_val = np.exp(min(2 * d, exp_cap))
            return self.alpha_extrap * d**2 * exp_val
        return 0.0

    def set_noise_coeffs(self, coeffs: "NoiseCoefficients", tau0: float = 0.01) -> None:
        """Use Allan variance NoiseCoefficients for σ²_meas (paper Section 3→7)."""
        self._noise_coeffs = coeffs
        self._allan_tau0 = tau0

    def _measurement_variance(self, adc_code: float, tau: float = 0.1) -> float:
        """σ²_meas: Allan-derived if available, else env_variance_base + α_v·v²."""
        adc_norm = adc_code / 1e9
        if self._noise_coeffs is not None:
            from allan_variance import measurement_uncertainty

            sigma = measurement_uncertainty(
                tau,
                self._noise_coeffs,
                voltage=adc_norm * 2.5,
                sigma_base=np.sqrt(self.env_variance_base),
            )
            return sigma**2
        return self.env_variance_base + self.alpha_v * (adc_norm**2)

    def predict_pressure_with_uncertainty(
        self, adc_code: float, env: EnvironmentalState
    ) -> Tuple[float, float]:
        """
        Predict pressure with full uncertainty quantification (paper Section 7).
        σ²_pred = σ²_meas + φ'Σφ + σ²_extrap + h'Σ_b h + env + interaction
        Mean: ŷ = φ'θ + h'b (Gauss-Markov bias).
        """
        now = time.time()
        dt = min(
            max(now - self._last_pred_t, 0.001), 10.0
        )  # cap for first call / long gaps
        self._last_pred_t = now

        phi = self.environmental_robust_basis_functions(adc_code, env)

        # Mean: φ'θ + h'b (paper Section 4)
        predicted_pressure = float(phi.T @ self.theta_mean)
        self.bias_model.propagate(dt)
        predicted_pressure += self.bias_model.bias_contribution()

        # 1. Measurement variance (Allan or heteroscedastic)
        measurement_variance = self._measurement_variance(adc_code)

        # 2. Parameter uncertainty
        parameter_variance = float(phi.T @ self.theta_cov @ phi)

        # 3. Extrapolation uncertainty
        extrap_variance = self._extrapolation_variance(adc_code)

        # 4. Bias uncertainty (paper Section 4)
        bias_variance = self.bias_model.bias_variance()

        # 5. Environmental variance
        adc_norm = adc_code / 1e9
        env_vector = np.array(
            [
                env.temperature,
                env.humidity,
                env.vibration,
                env.aging_factor,
                env.mounting_torque,
            ]
        )
        env_variance = float(
            env_vector.T @ self.env_variance_matrices["env"] @ env_vector
        )
        interaction_variance = float(
            adc_norm**2
            * env_vector.T
            @ self.env_variance_matrices["interaction"]
            @ env_vector
        )

        total_variance = (
            measurement_variance
            + parameter_variance
            + extrap_variance
            + bias_variance
            + env_variance
            + interaction_variance
        )
        sigma = np.sqrt(max(total_variance, 1e-12)) * self.inflation_factor
        self.recent_uncertainties.append(sigma)
        return predicted_pressure, sigma

    def add_calibration_point(self, point: CalibrationPoint) -> Dict[str, any]:
        """
        Add a new calibration point and update the model
        """
        self.calibration_points.append(point)
        if len(self.calibration_points) > self.calibration_points_max:
            self.calibration_points = self.calibration_points[
                -self.calibration_points_max :
            ]
        phi = self.environmental_robust_basis_functions(
            point.adc_code, point.environmental_state
        )
        pred_before = (
            float(phi.T @ self.theta_mean) + self.bias_model.bias_contribution()
        )
        residual = point.pressure - pred_before
        dt = point.timestamp - self._last_bias_update_t
        self._last_bias_update_t = point.timestamp
        sigma_meas = max(point.uncertainty, 1e-4)
        self.bias_model.update(residual, sigma_meas, min(max(dt, 0.001), 10.0))

        # Single zero-point (ZERO ALL): force prediction = 0 at this ADC.
        # Prior theta[1]=200 gives pressure ≈ 200*adc_norm, which is ~-30 at vacuum ADC.
        # One RLS step does not fully correct; set theta[0] to cancel the rest.
        if len(self.calibration_points) == 1 and abs(point.pressure) < 1e-6:
            contrib_rest = float(phi[1:].T @ self.theta_mean[1:])
            self.theta_mean[0] = -contrib_rest
            self.bias_model.b = np.zeros(3)
            self.bias_model.P_b = np.eye(3) * 0.01
            return {
                "drift_detected": False,
                "glr_statistic": 0.0,
                "calibration_points": 1,
                "confidence_level": self.get_confidence_level(),
            }

        # Check for drift using GLR test
        glr_statistic, drift_detected = self.generalized_likelihood_ratio_test(
            self.calibration_points
        )

        if drift_detected:
            logger.info(
                f"Sensor {self.sensor_id}: Drift detected (GLR={glr_statistic:.3f}), recalibrating"
            )
            # Full Bayesian recalibration
            self.theta_mean, self.theta_cov = self.bayesian_update(
                self.calibration_points
            )
        else:
            # RLS update
            self.theta_mean, self.theta_cov = self.recursive_least_squares_update(point)

        # Update RLS covariance matrix
        phi = self.environmental_robust_basis_functions(
            point.adc_code, point.environmental_state
        )
        Pphi = self.rls_P @ phi
        K = Pphi / (self.forgetting_factor + phi @ Pphi)
        self.rls_P = (self.rls_P - np.outer(K, Pphi)) / self.forgetting_factor

        # Record residual for autonomy α_agree
        pred = phi.T @ self.theta_mean
        self.recent_residuals.append(point.pressure - pred)

        return {
            "drift_detected": drift_detected,
            "glr_statistic": glr_statistic,
            "calibration_points": len(self.calibration_points),
            "confidence_level": self.get_confidence_level(),
        }

    def get_autonomy_score(self) -> Tuple[float, Dict[str, float]]:
        """
        Paper Section 8: α = 0.4·α_cal + 0.3·α_unc + 0.2·α_agree + 0.1·α_quality
        Returns (α, {α_cal, α_unc, α_agree, α_quality})
        """
        n = len(self.calibration_points)
        alpha_cal = min(1.0, n / 5.0)

        sigma = (
            np.mean(self.recent_uncertainties) if self.recent_uncertainties else 100.0
        )
        alpha_unc = float(np.exp(-(sigma**2) / (self.sigma_ref**2 + 1e-12)))

        if self.recent_residuals and self.recent_uncertainties:
            res = np.array(list(self.recent_residuals))
            sigs = np.array(list(self.recent_uncertainties))
            n = min(len(res), len(sigs))
            if n > 0:
                sigs = np.where(sigs[:n] > 1e-6, sigs[:n], 1.0)
                alpha_agree = float(np.mean(np.abs(res[:n]) < 2 * sigs))
            else:
                alpha_agree = 0.5
        else:
            alpha_agree = 0.5

        summary = self.get_calibration_summary()
        rmse = summary.get("rmse", 10.0)
        p_range = 1.0
        if self.calibration_points:
            pressures = np.array([p.pressure for p in self.calibration_points])
            p_range = max(np.ptp(pressures), 1.0)
        nrmse = rmse / p_range
        alpha_quality = float(1.0 - min(nrmse, 1.0))

        alpha = (
            0.4 * alpha_cal + 0.3 * alpha_unc + 0.2 * alpha_agree + 0.1 * alpha_quality
        )
        return float(np.clip(alpha, 0, 1)), {
            "alpha_cal": alpha_cal,
            "alpha_unc": alpha_unc,
            "alpha_agree": alpha_agree,
            "alpha_quality": alpha_quality,
        }

    def get_confidence_level(self) -> str:
        """
        Determine confidence level based on calibration quality
        """
        n_points = len(self.calibration_points)

        if n_points < 3:
            return "LOW"
        elif n_points < 10:
            return "MEDIUM"
        elif n_points < 20:
            return "HIGH"
        else:
            return "MAXIMUM"

    def get_calibration_summary(self) -> Dict[str, any]:
        """
        Get comprehensive calibration summary
        """
        if not self.calibration_points:
            return {
                "sensor_id": self.sensor_id,
                "status": "UNCALIBRATED",
                "confidence_level": "LOW",
                "calibration_points": 0,
                "parameters": self.theta_mean.tolist(),
                "uncertainty": np.sqrt(np.diag(self.theta_cov)).tolist(),
            }

        # Compute calibration quality metrics
        residuals = []
        for point in self.calibration_points:
            phi = self.environmental_robust_basis_functions(
                point.adc_code, point.environmental_state
            )
            predicted = phi.T @ self.theta_mean
            residuals.append(abs(point.pressure - predicted))

        rmse = np.sqrt(np.mean(np.array(residuals) ** 2))
        max_residual = np.max(residuals)

        return {
            "sensor_id": self.sensor_id,
            "status": "CALIBRATED",
            "confidence_level": self.get_confidence_level(),
            "calibration_points": len(self.calibration_points),
            "rmse": rmse,
            "max_residual": max_residual,
            "parameters": self.theta_mean.tolist(),
            "uncertainty": np.sqrt(np.diag(self.theta_cov)).tolist(),
            "forgetting_factor": self.forgetting_factor,
            "glr_threshold": self.glr_threshold,
        }
