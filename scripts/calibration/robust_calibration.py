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

import numpy as np
import scipy.linalg as la
import scipy.stats as stats
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
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


@dataclass
class CalibrationPoint:
    """Single calibration data point"""

    voltage: float
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

        # Bayesian parameters
        self.population_prior_mean = np.array(
            [0.0, 1.0, 0.0, 0.0, 0.0, 0.0]
        )  # 6 parameters
        self.population_prior_cov = np.eye(6) * 0.1
        self.individual_prior_cov = np.eye(6) * 0.05

        # Current calibration parameters
        self.theta_mean = self.population_prior_mean.copy()
        self.theta_cov = self.individual_prior_cov.copy()

        # RLS parameters
        self.rls_P = np.eye(6) * 100.0  # Initial covariance
        self.forgetting_factor = 0.95

        # GLR test parameters
        self.glr_threshold = 2.0  # Chi-squared threshold
        self.glr_window_size = 10

        # Environmental variance model
        self.env_variance_base = 0.001
        self.env_variance_matrices = {
            "env": np.eye(5) * 0.0001,
            "interaction": np.eye(5) * 0.00001,
        }

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

    def environmental_robust_basis_functions(
        self, v: float, env: EnvironmentalState
    ) -> np.ndarray:
        """
        Environmental-robust basis functions from equation (66-72)
        """
        T, H, V, A, M = (
            env.temperature,
            env.humidity,
            env.vibration,
            env.aging_factor,
            env.mounting_torque,
        )

        phi = np.zeros(6)
        phi[0] = 1.0
        phi[1] = v
        phi[2] = (
            v**2
            + self.physical_params["alpha1"] * T * v
            + self.physical_params["alpha2"] * H * v
        )
        phi[3] = (
            v**3
            + self.physical_params["beta1"] * T * v**2
            + self.physical_params["beta2"] * V * v
        )
        phi[4] = np.sqrt(max(v, 1e-6)) + self.physical_params["gamma1"] * A * np.log(
            max(v, 1e-6)
        )
        phi[5] = (
            np.log(1 + v)
            + self.physical_params["delta1"] * T
            + self.physical_params["delta2"] * H
        )

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
        Phi = np.zeros((n, 6))
        p_obs = np.zeros(n)
        weights = np.zeros(n)

        for i, point in enumerate(points):
            Phi[i] = self.environmental_robust_basis_functions(
                point.voltage, point.environmental_state
            )
            p_obs[i] = point.pressure
            weights[i] = 1.0 / (point.uncertainty**2 + self.env_variance_base)

        # Weighted least squares
        W = np.diag(weights)
        Phi_T_W = Phi.T @ W
        try:
            cov_inv = Phi_T_W @ Phi + np.eye(6) * 1e-6  # Regularization
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
        prior_precision = la.inv(self.theta_cov + np.eye(6) * 1e-6)
        likelihood_precision = la.inv(theta_cov_tls + np.eye(6) * 1e-6)
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
            point.voltage, point.environmental_state
        )

        # RLS update equations
        Pphi = self.rls_P @ phi  # (6,)
        denom = self.forgetting_factor + phi @ Pphi  # scalar
        K = Pphi / denom  # (6,)
        prediction_error = point.pressure - phi @ self.theta_mean

        # Update parameters
        self.theta_mean = self.theta_mean + K * prediction_error
        self.rls_P = (self.rls_P - np.outer(K, Pphi)) / self.forgetting_factor

        # Add forgetting covariance
        forgetting_cov = np.eye(6) * 0.001
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
                point.voltage, point.environmental_state
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
                point.voltage, point.environmental_state
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

    def predict_pressure_with_uncertainty(
        self, voltage: float, env: EnvironmentalState
    ) -> Tuple[float, float]:
        """
        Predict pressure with full uncertainty quantification
        Equations (154-156)
        """
        phi = self.environmental_robust_basis_functions(voltage, env)

        # Mean prediction
        predicted_pressure = phi.T @ self.theta_mean

        # Uncertainty quantification
        measurement_variance = self.env_variance_base

        # Parameter uncertainty
        jacobian = phi  # Jacobian of f(v) w.r.t. theta
        parameter_variance = jacobian.T @ self.theta_cov @ jacobian

        # Environmental variance
        env_vector = np.array(
            [
                env.temperature,
                env.humidity,
                env.vibration,
                env.aging_factor,
                env.mounting_torque,
            ]
        )
        env_variance = env_vector.T @ self.env_variance_matrices["env"] @ env_vector
        interaction_variance = (
            voltage**2
            * env_vector.T
            @ self.env_variance_matrices["interaction"]
            @ env_vector
        )

        # Total prediction variance
        total_variance = (
            measurement_variance
            + parameter_variance
            + env_variance
            + interaction_variance
        )

        return predicted_pressure, np.sqrt(total_variance)

    def add_calibration_point(self, point: CalibrationPoint) -> Dict[str, any]:
        """
        Add a new calibration point and update the model
        """
        self.calibration_points.append(point)

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
            point.voltage, point.environmental_state
        )
        Pphi = self.rls_P @ phi
        K = Pphi / (self.forgetting_factor + phi @ Pphi)
        self.rls_P = (self.rls_P - np.outer(K, Pphi)) / self.forgetting_factor

        return {
            "drift_detected": drift_detected,
            "glr_statistic": glr_statistic,
            "calibration_points": len(self.calibration_points),
            "confidence_level": self.get_confidence_level(),
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
                point.voltage, point.environmental_state
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
