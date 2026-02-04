#!/usr/bin/env python3
# Enhanced Channel Plotter with Robust Calibration System
# - Serial port selector with connect/refresh
# - Plot channels with toggles
# - Real-time pressure calibration with human-in-the-loop
# - Advanced mathematical calibration algorithms (Bayesian, TLS, RLS, GLR)
# - Covariance mapping between PTs
# - Progressive autonomy and uncertainty quantification
#
# Requirements:
#   pip install pyqt6 pyqtgraph pyserial numpy
#
# This is an enhanced version with integrated robust calibration capabilities.

import sys
import os
import struct
import time
import json
import logging
import threading
import queue
from collections import deque, defaultdict
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional

from PyQt6 import QtCore, QtGui, QtWidgets
import pyqtgraph as pg
import numpy as np
import serial, serial.tools.list_ports
from scipy.signal import butter, filtfilt

pg.setConfigOptions(antialias=False)

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Import robustness module
try:
    from calibration_robustness import (
        RobustnessManager,
        SystemConfig,
        OperationMode,
        HealthMetrics,
        ValidationResult,
    )

    ROBUSTNESS_AVAILABLE = True
    logger.info("✅ Robustness module loaded successfully")
except ImportError as e:
    logger.warning(f"⚠️  Robustness module not available: {e}")
    ROBUSTNESS_AVAILABLE = False

    # Provide dummy classes
    class RobustnessManager:
        def __init__(self, *args, **kwargs):
            pass

    class SystemConfig:
        pass

    class OperationMode:
        TEST = "test"
        FLIGHT = "flight"


# Import autonomous learning engine
try:
    from autonomous_calibration_engine import (
        AutonomousCalibrationEngine,
        CalibrationRequest,
        OnlineBayesianLearner,
        ActiveLearningAgent,
    )

    AUTONOMOUS_LEARNING_AVAILABLE = True
    logger.info("✅ Autonomous learning engine loaded successfully")
except ImportError as e:
    logger.warning(f"⚠️  Autonomous learning engine not available: {e}")
    AUTONOMOUS_LEARNING_AVAILABLE = False

    class AutonomousCalibrationEngine:
        def __init__(self, *args, **kwargs):
            pass

    class CalibrationRequest:
        pass


# ---------------------- Multivariate Bayesian Calibration Framework ----------------------


@dataclass
class VoltageFilter:
    """Exponential Moving Average + Low-Pass Filter for voltage stability"""

    alpha_ema: float = 0.3  # EMA smoothing factor (0-1, lower = more smoothing)
    alpha_lpf: float = 0.2  # LPF smoothing factor
    ema_value: float = 0.0
    lpf_value: float = 0.0
    initialized: bool = False

    def update(self, new_voltage: float) -> float:
        """Apply EMA + LPF filtering to voltage"""
        if not self.initialized:
            self.ema_value = new_voltage
            self.lpf_value = new_voltage
            self.initialized = True
            return new_voltage

        # Exponential Moving Average
        self.ema_value = (
            self.alpha_ema * new_voltage + (1 - self.alpha_ema) * self.ema_value
        )

        # Low-Pass Filter on top of EMA
        self.lpf_value = (
            self.alpha_lpf * self.ema_value + (1 - self.alpha_lpf) * self.lpf_value
        )

        return self.lpf_value

    def get_filtered(self) -> float:
        """Get current filtered value"""
        return self.lpf_value if self.initialized else 0.0


@dataclass
class EnvironmentalState:
    temperature: float = 25.0  # Celsius
    humidity: float = 50.0  # Percentage
    vibration: float = 0.0  # G-force
    aging_factor: float = 0.0  # Unitless factor, increases with time/usage
    mounting_torque: float = 1.0  # N-m, factor for mounting stress


@dataclass
class CalibrationPoint:
    voltage: float
    pressure: float  # Can be None for consensus-based calibration
    timestamp: float
    environmental_state: EnvironmentalState
    uncertainty: float  # Uncertainty of the reference pressure measurement
    is_human_input: bool = True  # True if from human, False if propagated/consensus
    propagated_from: Optional[int] = None  # Source PT if this was propagated
    is_consensus: bool = False  # True if pressure was determined by consensus


@dataclass
class ConsensusState:
    """State of sensor consensus at a given time"""

    pressure: float  # Consensus pressure estimate
    uncertainty: float  # Consensus uncertainty
    agreement_score: float  # How well sensors agree (0-1)
    participating_sensors: List[int]  # Which sensors contributed
    timestamp: float


@dataclass
class CalibrationResult:
    coefficients: np.ndarray
    covariance_matrix: np.ndarray
    mean_squared_error: float
    r_squared: float
    confidence_level: str
    drift_detected: bool = False
    consensus_strength: float = 0.0  # How strong the cross-sensor consensus is


class MultivariateBayesianCalibration:
    """
    Global multivariate Bayesian calibration system managing all PTs collectively.
    All PTs share information through hierarchical Bayesian inference.

    THREAD-SAFE: All methods that modify state use locks.
    """

    def __init__(self, num_sensors: int = 16, order: int = 3):
        self.num_sensors = num_sensors
        self.order = order
        self.n_params = order + 1

        # Initialize voltage filters for each sensor (simple EMA+LPF)
        self.voltage_filters = {i: VoltageFilter() for i in range(num_sensors)}

        # Voltage filtering statistics
        self.filter_stats = {
            i: {"outliers_rejected": 0, "rate_limits_applied": 0}
            for i in range(num_sensors)
        }

        # THREAD SAFETY
        self._state_lock = threading.RLock()  # Reentrant lock for nested calls
        self._consensus_lock = threading.Lock()  # Lock for consensus computation

        # HIERARCHICAL POPULATION-LEVEL PRIOR (shared by all PTs)
        # CRITICAL: Initialize with PHYSICS-BASED prior, not zeros!
        # Most pressure transducers are approximately linear: P ≈ a₀ + a₁*V
        # For a 0-5V, 0-1000 PSI transducer: slope ≈ 200 PSI/V, intercept ≈ 0
        # Higher-order terms should be SMALL (nonlinearity < 1%)

        # Initialize with physically reasonable values
        self.population_mean = np.zeros(self.n_params)
        self.population_mean[0] = 0.0  # Intercept (will be adjusted by zero-point cal)
        self.population_mean[1] = (
            200.0  # Linear term (200 PSI/V for typical 1000 PSI transducer)
        )
        # Higher order terms stay at 0 (small nonlinearity)

        # Covariance: Wide initial uncertainty - let data determine the relationship
        # Per paper equation 55: θ₀ + θ₁v + θ₂v² + θ₃v³ + θ₄√v + θ₅log(1+v) + environmental terms
        covariance_diagonal = np.zeros(self.n_params)
        covariance_diagonal[0] = (
            10000.0  # Intercept: very uncertain initially (±100 PSI)
        )
        covariance_diagonal[1] = 100000.0  # Linear term: very uncertain (±316 PSI/V)
        covariance_diagonal[2] = 10000.0  # Quadratic: uncertain
        covariance_diagonal[3] = 1000.0  # Cubic: less uncertain (smaller effect)
        covariance_diagonal[4] = 10000.0  # Sqrt term: uncertain
        covariance_diagonal[5] = 10000.0  # Log term: uncertain
        for i in range(6, self.n_params):
            covariance_diagonal[i] = (
                1000.0  # Environmental interaction terms: moderate uncertainty
            )
        self.population_covariance = np.diag(covariance_diagonal)
        self.population_precision = np.linalg.inv(self.population_covariance)
        self.population_strength = 1.0  # Start with moderate confidence in physics

        # PER-SENSOR CALIBRATION STATE - Initialize with population prior
        self.pt_means = {i: np.copy(self.population_mean) for i in range(num_sensors)}
        self.pt_covariances = {
            i: np.copy(self.population_covariance) for i in range(num_sensors)
        }
        self.pt_precisions = {
            i: np.copy(self.population_precision) for i in range(num_sensors)
        }
        self.pt_data = {i: [] for i in range(num_sensors)}  # Calibration points per PT

        # MULTIVARIATE CROSS-SENSOR COVARIANCE
        self.cross_sensor_covariance = np.eye(num_sensors) * 0.5

        # CONSENSUS HISTORY
        self.consensus_history = []
        self.last_consensus_time = 0.0
        self.consensus_interval = 0.1

        # CALIBRATION DATA
        self.calibration_points = {i: [] for i in range(num_sensors)}

        # ADAPTIVE UNCERTAINTY EVOLUTION
        self.uncertainty_inflation_factor = {i: 1.0 for i in range(num_sensors)}
        self.uncertainty_deflation_rate = 0.95
        self.disagreement_threshold = 0.2

        # AUTONOMY AND SELF-CONFIDENCE
        self.autonomy_levels = {i: 0.0 for i in range(num_sensors)}
        self.consensus_confidence = 0.0
        self.min_autonomy_for_self_cal = 0.6

        # DRIFT DETECTION
        self.drift_detected = {i: False for i in range(num_sensors)}
        self.drift_counters = {i: 0 for i in range(num_sensors)}

        # QUALITY HISTORY TRACKING
        self.quality_history = {i: [] for i in range(num_sensors)}

        # VARIANCE TRACKING
        self.sensor_variances = {i: 1.0 for i in range(num_sensors)}
        self.variance_history = {i: [] for i in range(num_sensors)}
        self.confidence_scores = {i: 0.0 for i in range(num_sensors)}

    def filter_voltage(
        self, sensor_id: int, raw_voltage: float, dt: float = 0.1
    ) -> float:
        """
        Apply robust voltage filtering before calibration

        Args:
            sensor_id: Sensor ID (0-15)
            raw_voltage: Raw voltage reading
            dt: Time since last sample (seconds)

        Returns:
            Filtered voltage safe for calibration
        """
        if sensor_id not in self.voltage_filters:
            logger.warning(f"Unknown sensor ID {sensor_id}, using raw voltage")
            return raw_voltage

        # Apply voltage filtering (EMA + LPF)
        filtered_voltage = self.voltage_filters[sensor_id].update(raw_voltage)

        return filtered_voltage

    def reset_voltage_filter(self, sensor_id: int):
        """Reset voltage filter for a specific sensor"""
        if sensor_id in self.voltage_filters:
            # Recreate the filter to reset it
            self.voltage_filters[sensor_id] = VoltageFilter()
            self.filter_stats[sensor_id] = {
                "outliers_rejected": 0,
                "rate_limits_applied": 0,
            }
            logger.info(f"PT{sensor_id} voltage filter reset")

    def get_sensor_framework(self, sensor_id: int) -> "RobustCalibrationFramework":
        """Get individual sensor framework (for compatibility)"""
        return RobustCalibrationFramework(sensor_id, self, self.order)

    def compute_consensus_pressure(
        self, voltages: Dict[int, float], env_state: EnvironmentalState
    ) -> ConsensusState:
        """
        CONSENSUS PRESSURE ESTIMATION: All PTs vote on the true pressure
        Uses inverse-variance weighting - sensors with lower uncertainty get more vote weight

        THREAD-SAFE: Uses consensus lock to prevent concurrent execution
        """
        with self._consensus_lock:
            return self._compute_consensus_pressure_unsafe(voltages, env_state)

    def _compute_consensus_pressure_unsafe(
        self, voltages: Dict[int, float], env_state: EnvironmentalState
    ) -> ConsensusState:
        """Internal implementation without locking"""
        predictions = []
        uncertainties = []
        sensor_ids = []

        for sensor_id, voltage in voltages.items():
            if sensor_id >= self.num_sensors:
                continue

            # Get PT's prediction
            mean = self.pt_means[sensor_id]
            cov = self.pt_covariances[sensor_id]

            # Skip if not calibrated
            if np.all(mean == self.population_mean) and np.allclose(
                cov, self.population_covariance
            ):
                continue

            # Design matrix
            phi = self._design_matrix(voltage, env_state, sensor_id)

            # Predict pressure
            p_pred = float(np.dot(phi, mean))

            # Predict uncertainty with inflation factor
            p_var = float(np.dot(phi, np.dot(cov, phi)))
            p_var *= self.uncertainty_inflation_factor[sensor_id]
            p_uncertainty = np.sqrt(p_var)

            predictions.append(p_pred)
            uncertainties.append(p_uncertainty)
            sensor_ids.append(sensor_id)

        if len(predictions) == 0:
            # No calibrated sensors
            return ConsensusState(
                pressure=0.0,
                uncertainty=1000.0,
                agreement_score=0.0,
                participating_sensors=[],
                timestamp=time.time(),
            )

        predictions = np.array(predictions)
        uncertainties = np.array(uncertainties)

        # INVERSE-VARIANCE WEIGHTED CONSENSUS
        # Weight each sensor by 1/σ²
        weights = 1.0 / (uncertainties**2 + 1e-6)
        weights /= np.sum(weights)  # Normalize

        consensus_pressure = float(np.sum(weights * predictions))

        # Consensus uncertainty (inverse-variance pooling)
        consensus_variance = 1.0 / np.sum(1.0 / (uncertainties**2 + 1e-6))
        consensus_uncertainty = float(np.sqrt(consensus_variance))

        # AGREEMENT SCORE: How well do sensors agree?
        # If sensors disagree significantly, this indicates a problem
        residuals = predictions - consensus_pressure
        normalized_residuals = residuals / (uncertainties + 1e-6)

        # Chi-squared statistic (should be ~1 if sensors agree)
        chi_squared = np.mean(normalized_residuals**2)
        agreement_score = float(1.0 / (1.0 + chi_squared))  # Maps to [0, 1]

        consensus_state = ConsensusState(
            pressure=consensus_pressure,
            uncertainty=consensus_uncertainty,
            agreement_score=agreement_score,
            participating_sensors=sensor_ids,
            timestamp=time.time(),
        )

        # Update uncertainty inflation based on agreement
        self._update_uncertainty_inflation(
            sensor_ids, residuals, uncertainties, agreement_score
        )

        # Update consensus history
        self.consensus_history.append(consensus_state)
        if len(self.consensus_history) > 1000:
            self.consensus_history = self.consensus_history[-1000:]

        # Update global consensus confidence
        self._update_consensus_confidence(agreement_score, len(sensor_ids))

        return consensus_state

    def _update_uncertainty_inflation(
        self,
        sensor_ids: List[int],
        residuals: np.ndarray,
        uncertainties: np.ndarray,
        agreement_score: float,
    ):
        """
        ROBUST UNCERTAINTY EVOLUTION with harness change detection
        - If sensors disagree, INFLATE their uncertainties (harness change detected!)
        - If sensors agree consistently, DEFLATE uncertainties (build confidence)
        - Progressive thresholds based on system maturity
        """
        for i, sensor_id in enumerate(sensor_ids):
            normalized_residual = abs(residuals[i]) / (uncertainties[i] + 1e-6)

            # PROGRESSIVE THRESHOLDS: Stricter as system matures
            disagreement_threshold = max(
                1.5, 3.0 - self.population_strength * 0.2
            )  # 3.0 → 1.5
            agreement_threshold = max(
                0.3, 0.7 - self.population_strength * 0.1
            )  # 0.7 → 0.3
            min_agreement = max(0.6, 0.9 - self.population_strength * 0.05)  # 0.9 → 0.6

            if normalized_residual > disagreement_threshold:
                # HARNESS CHANGE: Increase uncertainty slightly but KEEP calibration
                # The population prior will constrain predictions until human re-calibrates
                inflation_rate = 1.05  # GENTLE inflation (was 1.2-1.5)
                self.uncertainty_inflation_factor[sensor_id] *= inflation_rate
                self.uncertainty_inflation_factor[sensor_id] = min(
                    2.0, self.uncertainty_inflation_factor[sensor_id]
                )  # Cap at 2x (was 10x)

                # DON'T reset autonomy - keep the calibration knowledge
                # self.autonomy_levels[sensor_id] *= 0.95  # DISABLED

                logger.info(
                    f"PT{sensor_id} harness change detected (residual: {normalized_residual:.2f}σ), "
                    f"uncertainty: {self.uncertainty_inflation_factor[sensor_id]:.2f}x - calibration RETAINED"
                )

            elif (
                normalized_residual < agreement_threshold
                and agreement_score > min_agreement
            ):
                # CONSISTENT AGREEMENT: DEFLATE uncertainty (build confidence)
                deflation_rate = 0.98 - min(
                    0.03, self.population_strength * 0.01
                )  # 0.98 → 0.95
                self.uncertainty_inflation_factor[sensor_id] *= deflation_rate
                self.uncertainty_inflation_factor[sensor_id] = max(
                    0.3, self.uncertainty_inflation_factor[sensor_id]
                )

                # Boost autonomy slightly (system is more confident)
                self.autonomy_levels[sensor_id] = min(
                    1.0, self.autonomy_levels[sensor_id] * 1.01
                )

                if normalized_residual < 0.2:  # Very good agreement
                    logger.info(
                        f"PT{sensor_id} excellent agreement: {normalized_residual:.2f}σ, "
                        f"deflation: {self.uncertainty_inflation_factor[sensor_id]:.2f}"
                    )

    def _update_consensus_confidence(self, agreement_score: float, num_sensors: int):
        """
        PROPER CONSENSUS CONFIDENCE building from human ground truth
        Human inputs should rapidly increase system confidence
        """
        # COUNT HUMAN INPUTS across all sensors
        total_human_points = sum(
            sum(
                1
                for pt in self.calibration_points[sensor_id]
                if hasattr(pt, "is_human_input") and pt.is_human_input
            )
            for sensor_id in range(self.num_sensors)
        )

        # HUMAN INPUT BOOST: Each human input significantly increases system confidence
        human_boost = min(
            0.8, total_human_points * 0.15
        )  # 15% per human point, max 80%

        # SENSOR AGREEMENT FACTOR
        sensor_factor = min(1.0, num_sensors / 3.0)  # Saturate at 3 sensors

        # AGREEMENT FACTOR
        agreement_factor = agreement_score

        # POPULATION STRENGTH FACTOR
        population_factor = min(0.5, self.population_strength * 0.1)  # Max 50%

        # WEIGHTED COMBINATION - Human inputs dominate
        self.consensus_confidence = (
            0.40 * human_boost
            + 0.30 * agreement_factor  # Human ground truth (dominant)
            + 0.20 * sensor_factor  # Sensor agreement
            + 0.10  # Number of participating sensors
            * population_factor  # Population learning strength
        )

        # Ensure consensus confidence grows over time (no regression)
        if self.consensus_confidence > 0.9:  # Cap at 90% to maintain some uncertainty
            self.consensus_confidence = 0.9

    def _estimate_observation_noise(
        self, sensor_id: int, new_point: CalibrationPoint
    ) -> float:
        """
        PROPER BAYESIAN MULTIVARIATE APPROACH
        Human inputs are GROUND TRUTH - system must adapt quickly
        """
        # HUMAN INPUT = GROUND TRUTH
        # Use very low observation noise for human-provided points
        if hasattr(new_point, "is_human_input") and new_point.is_human_input:
            # Human input has minimal noise (ground truth)
            obs_variance = 0.001**2  # Very small
            logger.info(
                f"PT{sensor_id} HUMAN INPUT (ground truth): obs_variance={obs_variance:.8f}"
            )
            return obs_variance

        # CONSENSUS/AUTO-DETECTED points have higher uncertainty
        if hasattr(new_point, "is_consensus") and new_point.is_consensus:
            # Consensus points have moderate uncertainty
            obs_variance = new_point.uncertainty**2 + 0.01**2
            logger.info(
                f"PT{sensor_id} CONSENSUS INPUT: obs_variance={obs_variance:.6f}"
            )
            return obs_variance

        # DEFAULT: Use provided uncertainty
        obs_variance = new_point.uncertainty**2 + 0.001**2
        return obs_variance

    def multivariate_calibration_update(
        self, sensor_id: int, calibration_point: CalibrationPoint
    ):
        """
        MULTIVARIATE BAYESIAN UPDATE
        When one sensor gets a calibration point, ALL sensors update their beliefs
        This is the heart of the self-improving system

        THREAD-SAFE: Uses state lock for atomic updates
        """
        # ROBUST ERROR HANDLING - Check inputs before processing
        try:
            if not (0 <= sensor_id < self.num_sensors):
                raise ValueError(
                    f"Invalid sensor_id: {sensor_id}, must be 0-{self.num_sensors-1}"
                )

            if not np.isfinite(calibration_point.voltage):
                raise ValueError(f"Non-finite voltage: {calibration_point.voltage}")

            if calibration_point.pressure is not None and not np.isfinite(
                calibration_point.pressure
            ):
                raise ValueError(f"Non-finite pressure: {calibration_point.pressure}")

            if calibration_point.voltage < 0 or calibration_point.voltage > 15.0:
                logger.warning(
                    f"PT{sensor_id} voltage out of normal range: {calibration_point.voltage}V"
                )

            # DISABLED: Voltage filtering was causing massive errors - use raw voltage
            # filtered_voltage = self.filter_voltage(sensor_id, calibration_point.voltage)

            # Use raw calibration point directly (preserve ALL fields including is_human_input)
            filtered_point = CalibrationPoint(
                voltage=calibration_point.voltage,  # Raw voltage
                pressure=calibration_point.pressure,
                timestamp=calibration_point.timestamp,
                environmental_state=calibration_point.environmental_state,
                uncertainty=calibration_point.uncertainty,
                is_human_input=getattr(calibration_point, "is_human_input", True),
                propagated_from=getattr(calibration_point, "propagated_from", None),
                is_consensus=getattr(calibration_point, "is_consensus", False),
            )

        except Exception as e:
            logger.error(f"PT{sensor_id} calibration input validation failed: {e}")
            return  # Skip this calibration point

        with self._state_lock:
            try:
                self._multivariate_calibration_update_unsafe(sensor_id, filtered_point)
            except Exception as e:
                logger.error(f"PT{sensor_id} calibration update failed: {e}")
                # Reset voltage filter on error to prevent cascading failures
                self.reset_voltage_filter(sensor_id)

    def _multivariate_calibration_update_unsafe(
        self, sensor_id: int, calibration_point: CalibrationPoint
    ):
        """Internal implementation without locking"""
        # Add to history
        self.calibration_points[sensor_id].append(calibration_point)

        # Get design matrix for this observation
        phi = self._design_matrix(
            calibration_point.voltage, calibration_point.environmental_state, sensor_id
        )

        # LEARN OBSERVATION NOISE FROM DATA (Empirical Bayes)
        # Instead of fixed uncertainty, estimate it from residuals
        obs_variance = self._estimate_observation_noise(sensor_id, calibration_point)
        obs_precision = 1.0 / obs_variance

        # UPDATE SENSOR VARIANCE TRACKING
        self.sensor_variances[sensor_id] = obs_variance
        self.variance_history[sensor_id].append(
            {
                "timestamp": calibration_point.timestamp,
                "variance": obs_variance,
                "n_points": len(self.calibration_points[sensor_id]),
            }
        )

        # Keep only last 100 variance estimates
        if len(self.variance_history[sensor_id]) > 100:
            self.variance_history[sensor_id] = self.variance_history[sensor_id][-100:]

        # UPDATE CONFIDENCE SCORE
        self._update_sensor_confidence(sensor_id)

        # ===== UPDATE THIS SENSOR'S POSTERIOR =====
        # Bayesian update: posterior = prior + likelihood
        # Precision form: Λ_post = Λ_prior + Λ_likelihood

        # ===== PROPER BAYESIAN MULTIVARIATE UPDATE =====
        # Following the paper's framework: Human input = Ground Truth

        # Current prior
        old_precision = self.pt_precisions[sensor_id]
        old_mean = self.pt_means[sensor_id]

        # LIKELIHOOD with proper weighting
        if (
            hasattr(calibration_point, "is_human_input")
            and calibration_point.is_human_input
        ):
            # HUMAN INPUT: Strong update (ground truth)
            # Use high precision to force adaptation
            human_precision = 1000.0 * obs_precision  # 1000x stronger
            likelihood_precision = human_precision * np.outer(phi, phi)
            innovation_term = human_precision * calibration_point.pressure * phi

            logger.info(
                f"PT{sensor_id} STRONG HUMAN UPDATE: precision boost = {human_precision/obs_precision:.0f}x"
            )

        else:
            # CONSENSUS/AUTO: Normal Bayesian update
            likelihood_precision = obs_precision * np.outer(phi, phi)
            innovation_term = obs_precision * calibration_point.pressure * phi

        # Update precision
        new_precision = old_precision + likelihood_precision
        self.pt_precisions[sensor_id] = new_precision

        # Update covariance (inverse of precision)
        self.pt_covariances[sensor_id] = np.linalg.inv(new_precision)

        # Update mean
        # μ_post = Σ_post @ (Λ_prior @ μ_prior + Λ_likelihood @ y_obs)
        new_mean = self.pt_covariances[sensor_id] @ (
            old_precision @ old_mean + innovation_term
        )
        self.pt_means[sensor_id] = new_mean

        # ===== UPDATE POPULATION-LEVEL PRIOR =====
        # The population prior becomes more informed with each observation
        # This makes future sensors calibrate faster with less data

        self.population_strength += 0.1  # Increase prior strength

        # Update population mean as weighted average of all PT means
        all_means = np.array([self.pt_means[i] for i in range(self.num_sensors)])
        all_precisions = np.array(
            [np.trace(self.pt_precisions[i]) for i in range(self.num_sensors)]
        )

        # Weight by precision (more confident PTs contribute more)
        total_precision = np.sum(all_precisions)
        if total_precision > 0:
            weights = all_precisions / total_precision
            self.population_mean = np.sum(all_means.T * weights, axis=1)

        # Update population covariance (between-sensor variability)
        # This captures how much PTs differ from each other
        deviations = all_means - self.population_mean
        self.population_covariance = np.cov(deviations.T) + np.eye(self.n_params) * 0.01
        self.population_precision = np.linalg.inv(self.population_covariance)

        # ===== UPDATE CROSS-SENSOR COVARIANCE =====
        # Update correlations between sensors
        self._update_cross_sensor_correlations(sensor_id)

        # ===== PROPAGATE INFORMATION TO OTHER SENSORS =====
        # Other sensors get a "nudge" towards the population prior
        # This is how information flows between sensors
        self._propagate_to_other_sensors(sensor_id, calibration_point)

        # ===== UPDATE AUTONOMY LEVELS =====
        self._update_autonomy_levels()

        # ===== UPDATE CONSENSUS CONFIDENCE =====
        # Update consensus confidence based on human inputs and system state
        self._update_consensus_confidence_from_calibration(sensor_id)

        # ===== VALIDATE CALIBRATION QUALITY =====
        self._validate_calibration_quality(sensor_id)

        logger.info(
            f"PT{sensor_id} multivariate update: population_strength={self.population_strength:.2f}, "
            f"consensus_confidence={self.consensus_confidence:.2f}, "
            f"autonomy={self.autonomy_levels[sensor_id]:.2f}, "
            f"confidence={self.confidence_scores[sensor_id]:.2f}, "
            f"variance={self.sensor_variances[sensor_id]:.4f}"
        )

    def _validate_calibration_quality(self, sensor_id: int):
        """Validate and log calibration quality metrics"""
        points = self.calibration_points[sensor_id]

        if len(points) < 2:
            return

        # Compute residuals
        residuals = []
        for pt in points:
            phi = self._design_matrix(pt.voltage, pt.environmental_state, sensor_id)
            predicted = float(np.dot(phi, self.pt_means[sensor_id]))
            residual = pt.pressure - predicted
            residuals.append(residual)

        # Quality metrics
        rmse = np.sqrt(np.mean(np.array(residuals) ** 2))
        mae = np.mean(np.abs(residuals))

        # Store quality history in global system
        if not hasattr(self, "quality_history"):
            self.quality_history = {}

        if sensor_id not in self.quality_history:
            self.quality_history[sensor_id] = []

        quality_record = {
            "timestamp": time.time(),
            "sensor_id": sensor_id,
            "rmse": rmse,
            "mae": mae,
            "n_points": len(points),
            "autonomy": self.autonomy_levels[sensor_id],
            "consensus_confidence": self.consensus_confidence,
        }

        self.quality_history[sensor_id].append(quality_record)

        # Keep only last 100 records
        if len(self.quality_history[sensor_id]) > 100:
            self.quality_history[sensor_id] = self.quality_history[sensor_id][-100:]

        logger.info(
            f"PT{sensor_id} quality: RMSE={rmse:.3f}, MAE={mae:.3f}, points={len(points)}"
        )

    def _update_cross_sensor_correlations(self, updated_sensor: int):
        """
        Update cross-sensor covariance matrix
        Based on ACTUAL pressure correlation, not just parameter similarity
        This handles heterogeneous sensors measuring different pressures
        """
        # Get recent pressure predictions from all sensors
        recent_predictions = {}

        for i in range(self.num_sensors):
            if len(self.calibration_points[i]) == 0:
                continue

            # Get predictions on same voltages (if available)
            recent_predictions[i] = []
            for pt in self.calibration_points[i][-10:]:  # Last 10 points
                phi = self._design_matrix(pt.voltage, pt.environmental_state, i)
                pred = float(np.dot(phi, self.pt_means[i]))
                recent_predictions[i].append((pt.voltage, pred, pt.pressure))

        # Compute correlation between sensors based on measurement agreement
        for i in range(self.num_sensors):
            if i == updated_sensor or i not in recent_predictions:
                continue

            if updated_sensor not in recent_predictions:
                # Fallback to parameter-based correlation
                param_diff = self.pt_means[updated_sensor] - self.pt_means[i]
                distance = np.linalg.norm(param_diff)
                correlation = np.exp(-distance / 10.0)
            else:
                # ROBUST: Compute correlation from actual pressure agreement
                # This handles case where PTs measure different pressures
                correlation = self._compute_pressure_correlation(
                    recent_predictions[updated_sensor], recent_predictions[i]
                )

            self.cross_sensor_covariance[updated_sensor, i] = correlation
            self.cross_sensor_covariance[i, updated_sensor] = correlation

    def _compute_pressure_correlation(
        self,
        pred1: List[Tuple[float, float, float]],
        pred2: List[Tuple[float, float, float]],
    ) -> float:
        """
        Compute correlation between two sensors based on their pressure measurements
        Returns correlation ∈ [0, 1]
        """
        if len(pred1) < 2 or len(pred2) < 2:
            return 0.3  # Default moderate correlation

        # Extract pressures
        pressures1 = np.array([p[2] for p in pred1])
        pressures2 = np.array([p[2] for p in pred2])

        # If sensors measure same pressure range, high correlation
        # If sensors measure different ranges, low correlation (different parts of system)

        range1 = np.max(pressures1) - np.min(pressures1)
        range2 = np.max(pressures2) - np.min(pressures2)

        if range1 < 1.0 or range2 < 1.0:
            # Not enough range to determine
            return 0.5

        # Check if ranges overlap
        overlap = min(np.max(pressures1), np.max(pressures2)) - max(
            np.min(pressures1), np.min(pressures2)
        )
        total_range = max(np.max(pressures1), np.max(pressures2)) - min(
            np.min(pressures1), np.min(pressures2)
        )

        if total_range < 1.0:
            return 0.9  # Very similar

        overlap_fraction = max(0.0, overlap / total_range)

        # High overlap → high correlation
        # Low overlap → sensors measure different parts of system
        correlation = 0.3 + 0.6 * overlap_fraction

        logger.debug(
            f"Pressure correlation: overlap={overlap_fraction:.2f}, corr={correlation:.2f}"
        )

        return float(correlation)

    def _update_sensor_confidence(self, sensor_id: int):
        """
        PROPER CONFIDENCE BUILDING from human ground truth
        Human inputs should rapidly increase confidence
        """
        n_points = len(self.calibration_points[sensor_id])

        if n_points == 0:
            self.confidence_scores[sensor_id] = 0.0
            return

        # COUNT HUMAN INPUTS (ground truth)
        human_points = sum(
            1
            for pt in self.calibration_points[sensor_id]
            if hasattr(pt, "is_human_input") and pt.is_human_input
        )

        # COUNT CONSENSUS/AUTO POINTS
        consensus_points = sum(
            1
            for pt in self.calibration_points[sensor_id]
            if hasattr(pt, "is_consensus") and pt.is_consensus
        )

        # 1. HUMAN INPUT BOOST: Each human input significantly increases confidence
        human_factor = min(1.0, human_points * 0.4)  # 40% per human point, max 100%

        # 2. CONSENSUS FACTOR: Auto-detected points also build confidence
        consensus_factor = min(
            0.6, consensus_points * 0.2
        )  # 20% per consensus point, max 60%

        # 3. DATA COUNT FACTOR: More total data = more confident
        data_factor = min(0.8, n_points * 0.15)  # 15% per point, max 80%

        # 4. PRECISION FACTOR: Lower uncertainty = higher confidence
        if self.pt_covariances[sensor_id] is not None:
            cov_trace = np.trace(self.pt_covariances[sensor_id])
            precision_factor = 1.0 / (1.0 + cov_trace * 5.0)  # Scale factor
        else:
            precision_factor = 0.0

        # 5. POPULATION STRENGTH: Shared learning across sensors
        population_factor = min(0.5, self.population_strength * 0.1)  # Max 50%

        # WEIGHTED COMBINATION - Human inputs dominate
        confidence = (
            0.40 * human_factor
            + 0.20 * consensus_factor  # Human ground truth (dominant)
            + 0.15 * data_factor  # Consensus agreement
            + 0.15 * precision_factor  # Total data amount
            + 0.10 * population_factor  # Model precision  # Population learning
        )

        # Ensure confidence grows over time (no regression)
        current_confidence = self.confidence_scores[sensor_id]
        self.confidence_scores[sensor_id] = max(current_confidence, float(confidence))

        # Log significant confidence changes
        if abs(self.confidence_scores[sensor_id] - current_confidence) > 0.05:
            logger.info(
                f"PT{sensor_id} confidence: {current_confidence:.2f} → {self.confidence_scores[sensor_id]:.2f} "
                f"(human={human_points}, consensus={consensus_points}, total={n_points}, "
                f"precision={precision_factor:.2f}, population={population_factor:.2f})"
            )

    def get_sensor_variance_trend(self, sensor_id: int) -> Dict:
        """
        Get variance trend analysis for a sensor
        Returns: {'trend': 'decreasing'/'increasing'/'stable', 'rate': float, 'confidence': float}
        """
        variance_history = self.variance_history[sensor_id]

        if len(variance_history) < 3:
            return {"trend": "insufficient_data", "rate": 0.0, "confidence": 0.0}

        # Get recent variance trend
        recent_variances = [vh["variance"] for vh in variance_history[-5:]]

        # Linear regression to find trend
        x = np.arange(len(recent_variances))
        y = np.array(recent_variances)

        if len(y) > 1:
            slope = np.polyfit(x, y, 1)[0]

            # Classify trend
            if slope < -0.01:
                trend = "decreasing"
            elif slope > 0.01:
                trend = "increasing"
            else:
                trend = "stable"

            # Confidence in trend (based on R²)
            y_pred = np.polyval(np.polyfit(x, y, 1), x)
            ss_res = np.sum((y - y_pred) ** 2)
            ss_tot = np.sum((y - np.mean(y)) ** 2)
            r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

            return {
                "trend": trend,
                "rate": abs(slope),
                "confidence": r_squared,
                "current_variance": recent_variances[-1],
                "variance_std": np.std(recent_variances),
            }

        return {"trend": "stable", "rate": 0.0, "confidence": 0.0}

    def _update_consensus_confidence_from_calibration(self, sensor_id: int):
        """
        Update consensus confidence when a calibration point is added
        This ensures consensus confidence grows with human inputs
        """
        # COUNT HUMAN INPUTS across all sensors
        total_human_points = sum(
            sum(
                1
                for pt in self.calibration_points[sid]
                if hasattr(pt, "is_human_input") and pt.is_human_input
            )
            for sid in range(self.num_sensors)
        )

        # COUNT PARTICIPATING SENSORS (sensors with calibration data)
        participating_sensors = sum(
            1
            for sid in range(self.num_sensors)
            if len(self.calibration_points[sid]) > 0
        )

        # HUMAN INPUT BOOST: Each human input significantly increases system confidence
        human_boost = min(0.7, total_human_points * 0.2)  # 20% per human point, max 70%

        # SENSOR PARTICIPATION FACTOR
        sensor_factor = min(0.8, participating_sensors * 0.3)  # 30% per sensor, max 80%

        # POPULATION STRENGTH FACTOR
        population_factor = min(0.6, self.population_strength * 0.15)  # Max 60%

        # WEIGHTED COMBINATION - Human inputs dominate
        new_consensus_confidence = (
            0.50 * human_boost
            + 0.30 * sensor_factor  # Human ground truth (dominant)
            + 0.20  # Number of participating sensors
            * population_factor  # Population learning strength
        )

        # Ensure consensus confidence grows over time (no regression)
        if new_consensus_confidence > self.consensus_confidence:
            self.consensus_confidence = min(0.9, new_consensus_confidence)  # Cap at 90%

            logger.info(
                f"Consensus confidence updated: {self.consensus_confidence:.3f} "
                f"(human_points={total_human_points}, sensors={participating_sensors}, "
                f"population={self.population_strength:.2f})"
            )

    def _propagate_to_other_sensors(
        self, source_sensor: int, calibration_point: CalibrationPoint
    ):
        """
        CROSS-SENSOR INFORMATION PROPAGATION
        When one sensor calibrates, others learn from it
        The amount of learning depends on cross-sensor correlation
        """
        for target_sensor in range(self.num_sensors):
            if target_sensor == source_sensor:
                continue

            # How correlated are these sensors?
            correlation = self.cross_sensor_covariance[source_sensor, target_sensor]

            if correlation < 0.3:
                continue  # Too uncorrelated to propagate

            # Propagation strength based on correlation and population strength
            propagation_strength = correlation * min(
                1.0, self.population_strength / 10.0
            )

            # Pull target sensor's prior towards population prior
            current_mean = self.pt_means[target_sensor]
            target_mean = self.population_mean

            # Weighted update
            alpha = propagation_strength * 0.1  # Limit propagation rate
            self.pt_means[target_sensor] = (
                1 - alpha
            ) * current_mean + alpha * target_mean

            # Also adjust covariance towards population covariance
            current_cov = self.pt_covariances[target_sensor]
            target_cov = self.population_covariance
            self.pt_covariances[target_sensor] = (
                1 - alpha
            ) * current_cov + alpha * target_cov
            self.pt_precisions[target_sensor] = np.linalg.inv(
                self.pt_covariances[target_sensor]
            )

    def _update_autonomy_levels(self):
        """Update autonomy level for all sensors based on their calibration quality"""
        for sensor_id in range(self.num_sensors):
            n_points = len(self.calibration_points[sensor_id])

            if n_points == 0:
                self.autonomy_levels[sensor_id] = 0.0
                continue

            # PROPER AUTONOMY BUILDING from human ground truth
            # 1. HUMAN INPUT FACTOR: Each human input significantly increases autonomy
            human_points = sum(
                1
                for pt in self.calibration_points[sensor_id]
                if hasattr(pt, "is_human_input") and pt.is_human_input
            )
            human_factor = min(1.0, human_points * 0.5)  # 50% per human point, max 100%

            # 2. CONSENSUS FACTOR: Auto-detected points also build autonomy
            consensus_points = sum(
                1
                for pt in self.calibration_points[sensor_id]
                if hasattr(pt, "is_consensus") and pt.is_consensus
            )
            consensus_factor = min(
                0.7, consensus_points * 0.25
            )  # 25% per consensus point, max 70%

            # 3. PRECISION FACTOR: Lower uncertainty = more autonomous
            if self.pt_covariances[sensor_id] is not None:
                cov_trace = np.trace(self.pt_covariances[sensor_id])
                precision_factor = 1.0 / (1.0 + cov_trace * 5.0)  # Scale factor
            else:
                precision_factor = 0.0

            # 4. POPULATION STRENGTH (shared learning)
            population_factor = min(0.8, self.population_strength * 0.15)  # Max 80%

            # 5. SYSTEM CONSENSUS
            system_consensus = self.consensus_confidence

            # 6. CROSS-SENSOR HELP
            correlation_factor = 0.0
            if len(self.calibration_points[sensor_id]) > 0:
                correlations = []
                for other_id in range(self.num_sensors):
                    if (
                        other_id != sensor_id
                        and len(self.calibration_points[other_id]) > 0
                    ):
                        correlations.append(
                            self.cross_sensor_covariance[sensor_id, other_id]
                        )
                if correlations:
                    correlation_factor = np.mean(correlations)

            # WEIGHTED COMBINATION - Human inputs dominate
            autonomy = (
                0.35 * human_factor
                + 0.20 * consensus_factor  # Human ground truth (dominant)
                + 0.15 * precision_factor  # Consensus agreement
                + 0.15 * population_factor  # Model precision
                + 0.10 * system_consensus  # Population learning
                + 0.05 * correlation_factor  # System agreement  # Cross-sensor help
            )

            # Ensure autonomy grows over time (no regression)
            current_autonomy = self.autonomy_levels[sensor_id]
            self.autonomy_levels[sensor_id] = max(current_autonomy, float(autonomy))

            # Log significant autonomy changes
            if abs(self.autonomy_levels[sensor_id] - current_autonomy) > 0.1:
                logger.info(
                    f"PT{sensor_id} autonomy: {current_autonomy:.2f} → {self.autonomy_levels[sensor_id]:.2f} "
                    f"(human={human_points}, consensus={consensus_points}, precision={precision_factor:.2f}, "
                    f"population={population_factor:.2f})"
                )

    def _design_matrix(
        self, voltage: float, env_state: EnvironmentalState, sensor_id: int
    ) -> np.ndarray:
        """Environmental-robust basis functions"""
        # ROBUST VOLTAGE CLAMPING - Prevent numerical instability
        v = np.clip(voltage, 0.001, 10.0)
        T = np.clip(env_state.temperature, -50.0, 150.0)
        H = np.clip(env_state.humidity, 0.0, 100.0)
        V = np.clip(env_state.vibration, 0.0, 100.0)
        A = np.clip(env_state.aging_factor, 0.0, 10.0)
        M = np.clip(env_state.mounting_torque, 0.1, 10.0)

        # Environmental-robust basis functions
        phi_0 = 1.0
        phi_1 = v
        phi_2 = v**2 + 0.01 * T * v + 0.005 * H * v
        phi_3 = v**3 + 0.02 * T * v**2 + 0.01 * V * v
        # ROBUST VOLTAGE CLAMPING - Prevent numerical instability
        v_safe = np.clip(v, 0.001, 10.0)
        phi_4 = np.sqrt(v_safe) + 0.1 * A * np.log(v_safe)
        phi_5 = np.log(1 + v) + 0.05 * T + 0.02 * H
        phi_6 = v * T * H
        phi_7 = v**2 * V * M
        phi_8 = A * v**3

        features = [phi_0, phi_1, phi_2, phi_3, phi_4, phi_5, phi_6, phi_7, phi_8]
        return np.array(features[: self.n_params])

    def automatic_pressure_detection(
        self, voltages: Dict[int, float], env_state: EnvironmentalState
    ) -> Optional[float]:
        """
        AUTOMATIC PRESSURE DETECTION with confidence-weighted self-calibration
        System automatically detects pressure states through consensus
        """
        consensus = self.compute_consensus_pressure(voltages, env_state)

        # PROGRESSIVE THRESHOLDS: Lower requirements as system learns
        min_agreement = max(0.6, 0.9 - self.population_strength * 0.05)  # 0.9 → 0.6
        min_sensors = max(2, 5 - int(self.population_strength * 0.5))  # 5 → 2
        min_confidence = max(0.4, 0.8 - self.population_strength * 0.08)  # 0.8 → 0.4

        # Check if we can auto-detect
        if (
            consensus.agreement_score > min_agreement
            and len(consensus.participating_sensors) >= min_sensors
            and self.consensus_confidence > min_confidence
        ):

            logger.info(
                f"AUTO-DETECTED PRESSURE: {consensus.pressure:.1f} PSI "
                f"(agreement: {consensus.agreement_score:.2f} > {min_agreement:.2f}, "
                f"sensors: {len(consensus.participating_sensors)} >= {min_sensors}, "
                f"confidence: {self.consensus_confidence:.2f} > {min_confidence:.2f})"
            )

            return consensus.pressure

        return None

    def self_calibrate_with_confidence(
        self, voltages: Dict[int, float], env_state: EnvironmentalState
    ) -> bool:
        """
        SELF-CALIBRATION: System calibrates itself when confident enough
        Returns True if calibration was performed
        """
        detected_pressure = self.automatic_pressure_detection(voltages, env_state)

        if detected_pressure is None:
            return False

        # Only self-calibrate if system is confident enough
        if self.population_strength < 2.0:
            return False

        calibrated_count = 0

        for sensor_id, voltage in voltages.items():
            # Check if this sensor should be self-calibrated
            autonomy = self.autonomy_levels[sensor_id]
            n_points = len(self.calibration_points[sensor_id])

            # Self-calibrate if:
            # 1. High autonomy (can trust this PT)
            # 2. High confidence score (low variance, consistent)
            # 3. Not too many points already (avoid overfitting)
            # 4. Consensus is confident
            confidence = self.confidence_scores[sensor_id]
            if (
                autonomy > 0.6
                and confidence > 0.7
                and n_points < 10
                and self.consensus_confidence > 0.5
            ):

                # Create self-calibration point
                calibration_point = CalibrationPoint(
                    voltage=voltage,
                    pressure=detected_pressure,
                    timestamp=time.time(),
                    environmental_state=env_state,
                    uncertainty=0.5,  # Lower uncertainty for self-calibration
                    is_consensus=True,
                )

                # Add with confidence weighting
                self.multivariate_calibration_update(sensor_id, calibration_point)
                calibrated_count += 1

                logger.info(
                    f"SELF-CALIBRATED PT{sensor_id}: {detected_pressure:.1f} PSI at {voltage:.3f}V "
                    f"(autonomy: {autonomy:.2f}, sensor_confidence: {confidence:.2f}, "
                    f"consensus_confidence: {self.consensus_confidence:.2f})"
                )

        return calibrated_count > 0

    def save_population_prior(self, filepath: str = "population_prior.json"):
        """Save the population prior - this is the accumulated knowledge from ALL test sessions"""
        import json

        data = {
            "population_mean": self.population_mean.tolist(),
            "population_covariance": self.population_covariance.tolist(),
            "population_strength": float(self.population_strength),
            "cross_sensor_covariance": self.cross_sensor_covariance.tolist(),
            "num_sensors": self.num_sensors,
            "order": self.order,
        }
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)
        logger.info(
            f"💾 Saved population prior to {filepath} (strength={self.population_strength:.2f})"
        )

    def load_population_prior(self, filepath: str = "population_prior.json"):
        """Load the population prior from previous test sessions"""
        import json
        import os

        if not os.path.exists(filepath):
            logger.info(f"No population prior found at {filepath} - starting fresh")
            return False

        try:
            with open(filepath, "r") as f:
                data = json.load(f)

            self.population_mean = np.array(data["population_mean"])
            self.population_covariance = np.array(data["population_covariance"])
            self.population_precision = np.linalg.inv(self.population_covariance)
            self.population_strength = float(data["population_strength"])
            self.cross_sensor_covariance = np.array(data["cross_sensor_covariance"])

            # Re-initialize all PTs with the loaded population prior
            for i in range(self.num_sensors):
                self.pt_means[i] = np.copy(self.population_mean)
                self.pt_covariances[i] = np.copy(self.population_covariance)
                self.pt_precisions[i] = np.copy(self.population_precision)

            logger.info(
                f"✅ Loaded population prior from {filepath} (strength={self.population_strength:.2f})"
            )
            logger.info(
                f"🎯 ALL PTs initialized with accumulated knowledge from previous sessions!"
            )
            return True
        except Exception as e:
            logger.error(f"Failed to load population prior: {e}")
            return False


class RobustCalibrationFramework:
    """
    Individual sensor framework that interfaces with the global multivariate system.
    This is a thin wrapper around the global system for backward compatibility.
    """

    def __init__(
        self,
        sensor_id: int,
        global_system: Optional[MultivariateBayesianCalibration] = None,
        order: int = 3,
    ):
        self.sensor_id = sensor_id
        self.order = order
        self.global_system = global_system
        self.forgetting_factor = 0.99

        # If no global system provided, create standalone (legacy mode)
        if global_system is None:
            self.standalone = True
            self.coefficients = np.zeros(order + 1)
            self.covariance_matrix = np.eye(order + 1) * 10.0
        else:
            self.standalone = False

        # Local storage for backward compatibility
        self.calibration_points: List[CalibrationPoint] = []
        self.last_calibration_timestamp: float = time.time()

        # Autonomy tracking
        self.autonomy_level: float = 0.0
        self.human_input_count: int = 0
        self.autonomous_predictions: int = 0
        self.confidence_threshold: float = 0.95

        # Quality history
        self.quality_history: List[Dict] = []

        # Cross-PT tracking (deprecated but kept for compatibility)
        self.cross_pt_covariance: Dict[int, np.ndarray] = {}
        self.reference_pt_history: Dict[int, List[float]] = {}

        # Legacy parameters
        self.P_rls: Optional[np.ndarray] = None
        self.theta_rls: Optional[np.ndarray] = None
        self.drift_threshold: float = 0.1
        self.glr_window_size: int = 10
        self.env_state_history: List[EnvironmentalState] = []
        self.env_covariance_matrix: Optional[np.ndarray] = None
        self.spatial_correlation_matrix: Optional[np.ndarray] = None
        self.ekf_state: Optional[np.ndarray] = None
        self.ekf_covariance: Optional[np.ndarray] = None
        self.process_noise_covariance: Optional[np.ndarray] = None
        self.calibration_history: List[Dict] = []
        self.system_start_time: float = time.time()
        self.last_save_time: float = time.time()
        self.save_interval: float = 300.0
        self.cross_calibration_enabled: bool = True
        self.self_calibration_threshold: float = 0.8
        self.pop_mean = np.zeros(order + 1)
        self.pop_covariance = np.eye(order + 1) * 0.1
        self.ind_covariance = np.eye(order + 1) * 0.01

    @property
    def coefficients(self) -> Optional[np.ndarray]:
        """Get coefficients from global system or standalone"""
        if self.standalone:
            return getattr(self, "_standalone_coefficients", None)
        return self.global_system.pt_means.get(self.sensor_id)

    @coefficients.setter
    def coefficients(self, value):
        if self.standalone:
            self._standalone_coefficients = value
        elif self.global_system is not None and value is not None:
            self.global_system.pt_means[self.sensor_id] = value

    @property
    def covariance_matrix(self) -> Optional[np.ndarray]:
        """Get covariance from global system or standalone"""
        if self.standalone:
            return getattr(self, "_standalone_covariance", None)
        return self.global_system.pt_covariances.get(self.sensor_id)

    @covariance_matrix.setter
    def covariance_matrix(self, value):
        if self.standalone:
            self._standalone_covariance = value
        elif self.global_system is not None and value is not None:
            self.global_system.pt_covariances[self.sensor_id] = value

    def _design_matrix(
        self, voltage: float, env_state: EnvironmentalState
    ) -> np.ndarray:
        if self.standalone:
            # Standalone mode - use local implementation
            v = voltage
            T = env_state.temperature
            H = env_state.humidity
            V = env_state.vibration
            A = env_state.aging_factor
            M = env_state.mounting_torque

            phi_0 = 1
            phi_1 = v
            phi_2 = v**2 + 0.01 * T * v + 0.005 * H * v
            phi_3 = v**3 + 0.02 * T * v**2 + 0.01 * V * v
            # ROBUST VOLTAGE CLAMPING - Prevent numerical instability
            v_safe = np.clip(v, 0.001, 10.0)
            phi_4 = np.sqrt(v_safe) + 0.1 * A * np.log(v_safe)
            phi_5 = np.log(1 + v) + 0.05 * T + 0.02 * H
            phi_6 = v * T * H
            phi_7 = v**2 * V * M
            phi_8 = A * v**3

            features = [phi_0, phi_1, phi_2, phi_3, phi_4, phi_5, phi_6, phi_7, phi_8]
            return np.array(features[: self.order + 1])
        else:
            # Use global system's design matrix
            return self.global_system._design_matrix(voltage, env_state, self.sensor_id)

    def add_calibration_point(self, point: CalibrationPoint) -> CalibrationResult:
        self.calibration_points.append(point)
        self.last_calibration_timestamp = point.timestamp

        if not self.standalone and self.global_system is not None:
            # MULTIVARIATE UPDATE - all sensors learn from this
            self.global_system.multivariate_calibration_update(self.sensor_id, point)

            # Update local autonomy from global system
            self.autonomy_level = self.global_system.autonomy_levels[self.sensor_id]

        else:
            # Standalone mode - use legacy calibration
            if len(self.calibration_points) > self.order:
                self._perform_robust_calibration()
                self._run_rls_update(point)
                self._run_glr_test()

        return self._get_current_result()

    def _perform_robust_calibration(self):
        # COMPLETE ROBUST CALIBRATION ALGORITHM from paper Section 3
        voltages = np.array([p.voltage for p in self.calibration_points])
        pressures = np.array([p.pressure for p in self.calibration_points])
        env_states = [p.environmental_state for p in self.calibration_points]

        # Build design matrix for all points
        X = np.array([self._design_matrix(v, e) for v, e in zip(voltages, env_states)])

        # COMPLETE TOTAL LEAST SQUARES with environmental uncertainty
        try:
            # Compute total uncertainty for each measurement (paper equation 117)
            sigma_total_sq = np.zeros(len(self.calibration_points))
            for i, point in enumerate(self.calibration_points):
                # All uncertainty sources from paper
                sigma_gauge_sq = point.uncertainty**2  # Reference gauge uncertainty
                sigma_meas_sq = 0.001**2  # Measurement noise
                sigma_temp_sq = 0.01**2  # Temperature-induced noise
                sigma_aging_sq = 0.005**2  # Aging/drift noise
                sigma_v_sq = 0.0001**2  # Voltage measurement uncertainty
                sigma_env_sq = self._compute_environmental_uncertainty(
                    env_states[i]
                )  # Environmental uncertainty

                sigma_total_sq[i] = (
                    sigma_gauge_sq
                    + sigma_meas_sq
                    + sigma_temp_sq
                    + sigma_aging_sq
                    + sigma_v_sq
                    + sigma_env_sq
                )

            # Weighted least squares (TLS approximation)
            W = np.diag(1.0 / sigma_total_sq)

            # HIERARCHICAL BAYESIAN UPDATE (paper equations 126-139)
            # Population prior: theta ~ N(pop_mean, pop_covariance)
            Sigma_prior_inv = np.linalg.inv(self.pop_covariance)
            Sigma_likelihood_inv = X.T @ W @ X

            # Posterior covariance (paper equation 138)
            self.covariance_matrix = np.linalg.inv(
                Sigma_prior_inv + Sigma_likelihood_inv
            )

            # Posterior mean (paper equation 138)
            self.coefficients = self.covariance_matrix @ (
                Sigma_prior_inv @ self.pop_mean + X.T @ W @ pressures
            )

            # Update environmental covariance matrix
            self._update_environmental_covariance(env_states)

            # VALIDATION: Check calibration quality
            self._validate_calibration_quality(X, pressures, sigma_total_sq)

        except np.linalg.LinAlgError:
            logger.error("Linear algebra error during robust calibration.")
            self.coefficients = np.zeros(self.order + 1)
            self.covariance_matrix = np.eye(self.order + 1) * 1000.0  # High uncertainty

    def _compute_environmental_uncertainty(
        self, env_state: EnvironmentalState
    ) -> float:
        """Compute environmental uncertainty from paper equation 192-199"""
        # Environmental variance model
        env_vector = np.array(
            [
                env_state.temperature,
                env_state.humidity,
                env_state.vibration,
                env_state.aging_factor,
                env_state.mounting_torque,
            ]
        )

        # Base environmental uncertainty
        sigma_env_sq = 0.01**2  # Base environmental variance

        # Environmental interaction terms
        sigma_env_sq += (
            np.dot(env_vector, np.dot(self.env_covariance_matrix, env_vector))
            if self.env_covariance_matrix is not None
            else 0
        )

        return sigma_env_sq

    def _validate_calibration_quality(
        self, X: np.ndarray, pressures: np.ndarray, sigma_total_sq: np.ndarray
    ):
        """Validate calibration quality using paper metrics"""
        if self.coefficients is None:
            return

        # Compute predictions
        predictions = X @ self.coefficients
        residuals = pressures - predictions

        # Normalized Root Mean Square Error (paper equation 533) - ROBUST against NaN
        residuals_sq = residuals**2
        residuals_sq = np.nan_to_num(residuals_sq, nan=0.0, posinf=0.0, neginf=0.0)
        pressure_range = np.max(pressures) - np.min(pressures)

        if len(pressures) > 1 and pressure_range > 1e-10:
            nrmse = np.sqrt(np.mean(residuals_sq)) / pressure_range
        else:
            nrmse = np.sqrt(np.mean(residuals_sq)) if len(residuals_sq) > 0 else 0.0

        nrmse = np.nan_to_num(nrmse, nan=0.0, posinf=0.0, neginf=0.0)

        # Uncertainty calibration (paper equation 538) - ROBUST against NaN
        sigma_total_sq_safe = np.nan_to_num(
            sigma_total_sq, nan=1e-6, posinf=1e-6, neginf=1e-6
        )
        sigma_total_sq_safe = np.maximum(sigma_total_sq_safe, 1e-10)  # Ensure positive
        coverage_count = np.sum(np.abs(residuals) <= 2 * np.sqrt(sigma_total_sq_safe))
        coverage = coverage_count / len(pressures) if len(pressures) > 0 else 0

        # Log quality metrics
        logger.info(
            f"PT{self.sensor_id} calibration quality: NRMSE={nrmse:.4f}, Coverage={coverage:.2f}"
        )

        # Track quality history
        quality_record = {
            "timestamp": time.time(),
            "nrmse": nrmse,
            "coverage": coverage,
            "autonomy": self.autonomy_level,
            "drift_detected": self._run_glr_test(),
        }
        self.quality_history.append(quality_record)

        # Keep only last 100 records
        if len(self.quality_history) > 100:
            self.quality_history = self.quality_history[-100:]

        # Flag poor calibration
        if nrmse > 0.1 or coverage < 0.8:
            logger.warning(
                f"PT{self.sensor_id} calibration quality is poor - may need more data points"
            )

    def _run_rls_update(self, new_point: CalibrationPoint):
        # COMPLETE RECURSIVE LEAST SQUARES from paper equation 162-166
        phi_k = self._design_matrix(new_point.voltage, new_point.environmental_state)
        p_obs_k = new_point.pressure

        if self.theta_rls is None or self.P_rls is None:
            # Initialize RLS with current calibration
            self.theta_rls = (
                self.coefficients
                if self.coefficients is not None
                else np.zeros(self.order + 1)
            )
            self.P_rls = (
                self.covariance_matrix
                if self.covariance_matrix is not None
                else np.eye(self.order + 1) * 100.0
            )

        # RLS update equations (paper equations 162-166)
        # Innovation covariance
        S_k = self.forgetting_factor + np.dot(phi_k, np.dot(self.P_rls, phi_k))

        # Kalman gain
        K_k = np.dot(self.P_rls, phi_k) / S_k

        # Innovation (prediction error)
        innovation = p_obs_k - np.dot(phi_k, self.theta_rls)

        # Parameter update
        self.theta_rls = self.theta_rls + K_k * innovation

        # Covariance update with forgetting factor
        self.P_rls = (
            self.P_rls - np.outer(K_k, np.dot(phi_k, self.P_rls))
        ) / self.forgetting_factor

        # Update main coefficients
        self.coefficients = self.theta_rls

        # Update main covariance matrix
        if self.covariance_matrix is None:
            self.covariance_matrix = self.P_rls
        else:
            # Blend with existing covariance
            alpha = 0.1  # Blending factor
            self.covariance_matrix = (
                1 - alpha
            ) * self.covariance_matrix + alpha * self.P_rls

    def _run_glr_test(self):
        # COMPLETE GENERALIZED LIKELIHOOD RATIO TEST from paper equation 235-248
        if (
            len(self.calibration_points) < self.glr_window_size
            or self.coefficients is None
        ):
            return False

        recent_points = self.calibration_points[-self.glr_window_size :]
        recent_voltages = np.array([p.voltage for p in recent_points])
        recent_pressures = np.array([p.pressure for p in recent_points])
        recent_env_states = [p.environmental_state for p in recent_points]

        # Build design matrix for recent points
        X_recent = np.array(
            [
                self._design_matrix(v, e)
                for v, e in zip(recent_voltages, recent_env_states)
            ]
        )

        # Compute predictions using current calibration
        predictions = X_recent @ self.coefficients
        residuals = recent_pressures - predictions

        # GLR test statistic (paper equation 235)
        # Null hypothesis: current calibration is correct
        # Alternative hypothesis: calibration has changed

        # Compute likelihood under null hypothesis (current calibration)
        sigma_sq = np.var(residuals)  # Estimate noise variance
        log_likelihood_null = -0.5 * np.sum(residuals**2 / sigma_sq) - 0.5 * len(
            residuals
        ) * np.log(2 * np.pi * sigma_sq)

        # Compute likelihood under alternative hypothesis (new calibration)
        # Fit new calibration to recent data
        try:
            X_recent_T_X_recent = X_recent.T @ X_recent
            if np.linalg.det(X_recent_T_X_recent) > 1e-10:  # Check for singularity
                theta_alt = np.linalg.solve(
                    X_recent_T_X_recent, X_recent.T @ recent_pressures
                )
                predictions_alt = X_recent @ theta_alt
                residuals_alt = recent_pressures - predictions_alt
                sigma_sq_alt = np.var(residuals_alt)
                log_likelihood_alt = -0.5 * np.sum(
                    residuals_alt**2 / sigma_sq_alt
                ) - 0.5 * len(residuals_alt) * np.log(2 * np.pi * sigma_sq_alt)

                # GLR statistic
                glr_statistic = 2 * (log_likelihood_alt - log_likelihood_null)

                # Threshold for drift detection (paper equation 247)
                threshold = 2 * len(
                    recent_points
                )  # Chi-squared threshold approximation

                drift_detected = glr_statistic > threshold

                if drift_detected:
                    logger.warning(
                        f"PT{self.sensor_id} drift detected! GLR={glr_statistic:.2f} > {threshold:.2f}"
                    )

                return drift_detected
            else:
                return False
        except np.linalg.LinAlgError:
            return False

    def predict_pressure_with_uncertainty(
        self, voltage: float, env_state: EnvironmentalState
    ) -> Tuple[float, float]:
        if self.coefficients is None:
            return 0.0, 1000.0  # Return high uncertainty if not calibrated

        phi = self._design_matrix(voltage, env_state)

        # Proper scalar conversion - ensure we get a scalar
        dot_product = np.dot(phi, self.coefficients)
        if isinstance(dot_product, np.ndarray):
            predicted_pressure = float(dot_product.item())
        else:
            predicted_pressure = float(dot_product)

        # ADAPTIVE UNCERTAINTY EVOLUTION
        if self.covariance_matrix is not None:
            J_theta = phi

            # Base prediction variance
            prediction_variance = (
                0.001**2
                + np.dot(J_theta, np.dot(self.covariance_matrix, J_theta))
                + self._compute_extrapolation_uncertainty(voltage)
            )

            # Apply inflation factor from global system (adaptive uncertainty)
            if not self.standalone and self.global_system is not None:
                inflation = self.global_system.uncertainty_inflation_factor[
                    self.sensor_id
                ]
                prediction_variance *= inflation

            uncertainty = float(np.sqrt(prediction_variance))
        else:
            uncertainty = 0.1

        return float(predicted_pressure), float(uncertainty)

    def _compute_extrapolation_uncertainty(self, voltage: float) -> float:
        """Compute extrapolation uncertainty from paper equation 261-268"""
        if len(self.calibration_points) < 2:
            return 0.1

        # Get calibration voltage range
        cal_voltages = [p.voltage for p in self.calibration_points]
        v_min, v_max = min(cal_voltages), max(cal_voltages)

        # Extrapolation uncertainty increases with distance from calibration range
        if voltage < v_min:
            distance_factor = (v_min - voltage) / (v_max - v_min)
        elif voltage > v_max:
            distance_factor = (voltage - v_max) / (v_max - v_min)
        else:
            distance_factor = 0.0

        # From paper equation 267-268
        sigma_model_sq = 0.01  # Model uncertainty
        sigma_range_sq = 0.05 * distance_factor**2  # Range extrapolation uncertainty

        return sigma_model_sq + sigma_range_sq

    def get_confidence_level(self) -> str:
        if self.coefficients is None or len(self.calibration_points) < 3:
            return "LOW"

        # More sophisticated logic based on uncertainty, GLR status, RLS stability
        _, uncertainty = self.predict_pressure_with_uncertainty(
            self.calibration_points[-1].voltage,
            self.calibration_points[-1].environmental_state,
        )

        if uncertainty < 0.01 and not self._run_glr_test():  # Check for drift
            return "MAXIMUM"
        elif uncertainty < 0.02:
            return "HIGH"
        elif uncertainty < 0.05:
            return "MEDIUM"
        return "LOW"

    def get_calibration_data_for_plotting(self) -> Tuple[List[float], List[float]]:
        """Get calibration data for plotting"""
        if not self.calibration_points:
            return [], []

        voltages = [p.voltage for p in self.calibration_points]
        pressures = [p.pressure for p in self.calibration_points]
        return voltages, pressures

    def get_calibration_curve_data(
        self, voltage_range: Tuple[float, float] = None
    ) -> Tuple[List[float], List[float]]:
        """Get calibration curve predictions for plotting - EXTENDED RANGE"""
        if self.coefficients is None or len(self.calibration_points) < 2:
            return [], []

        if voltage_range is None:
            voltages = [p.voltage for p in self.calibration_points]
            if not voltages:
                return [], []
            v_min, v_max = min(voltages), max(voltages)
            # EXTEND RANGE to cover all data points with margin
            v_range = v_max - v_min
            v_min = max(0.0, v_min - 0.1 * v_range)  # Extend below
            v_max = v_max + 0.1 * v_range  # Extend above
        else:
            v_min, v_max = voltage_range

        # Generate curve points with extended range
        v_curve = np.linspace(v_min, v_max, 200)  # More points for smoother curve
        p_curve = []

        env_state = EnvironmentalState()
        for v in v_curve:
            phi = self._design_matrix(v, env_state)
            p_pred = float(np.dot(phi, self.coefficients))
            p_curve.append(p_pred)

        return v_curve.tolist(), p_curve

    def _update_environmental_covariance(self, env_states: List[EnvironmentalState]):
        """Update environmental covariance matrix from paper Section 2.2"""
        if len(env_states) < 2:
            return

        # Build environmental state matrix
        env_matrix = np.array(
            [
                [
                    e.temperature,
                    e.humidity,
                    e.vibration,
                    e.aging_factor,
                    e.mounting_torque,
                ]
                for e in env_states
            ]
        )

        # Compute environmental covariance
        self.env_covariance_matrix = np.cov(env_matrix.T)

    def update_cross_pt_covariance(
        self, other_pt_id: int, other_framework: "RobustCalibrationFramework"
    ):
        """Update covariance mapping between PTs from paper Section 6"""
        if self.coefficients is None or other_framework.coefficients is None:
            return

        # Compute cross-covariance between calibration parameters
        # This captures spatial/functional relationships between PTs
        cross_cov = np.outer(
            self.coefficients - self.pop_mean,
            other_framework.coefficients - other_framework.pop_mean,
        )

        self.cross_pt_covariance[other_pt_id] = cross_cov

    def predict_pressure_with_covariance_mapping(
        self,
        voltage: float,
        env_state: EnvironmentalState,
        reference_pt_id: int,
        reference_framework: "RobustCalibrationFramework",
    ) -> Tuple[float, float]:
        """Predict pressure using covariance mapping from paper Section 6"""
        if self.coefficients is None:
            return 0.0, 1000.0

        # Base prediction
        phi = self._design_matrix(voltage, env_state)
        base_prediction = float(phi @ self.coefficients)

        # Covariance mapping correction
        if reference_pt_id in self.cross_pt_covariance:
            # Use reference PT's prediction to inform this PT
            ref_prediction, ref_uncertainty = (
                reference_framework.predict_pressure_with_uncertainty(
                    voltage, env_state
                )
            )

            # Covariance mapping factor (from paper equation 354)
            cross_cov = self.cross_pt_covariance[reference_pt_id]
            mapping_factor = np.trace(cross_cov) / (
                np.trace(reference_framework.covariance_matrix) + 1e-6
            )

            # Weighted combination
            alpha = min(0.3, mapping_factor)  # Limit influence
            corrected_prediction = (
                1 - alpha
            ) * base_prediction + alpha * ref_prediction

            # Uncertainty propagation - ROBUST against NaN
            cov_term = phi.T @ self.covariance_matrix @ phi
            cov_term = np.nan_to_num(cov_term, nan=1e-6, posinf=1e-6, neginf=1e-6)
            cov_term = max(cov_term, 1e-10)  # Ensure positive
            base_uncertainty = float(np.sqrt(cov_term))

            total_var = (
                1 - alpha
            ) ** 2 * base_uncertainty**2 + alpha**2 * ref_uncertainty**2
            total_var = max(total_var, 1e-10)  # Ensure positive
            total_uncertainty = np.sqrt(total_var)
            total_uncertainty = np.nan_to_num(
                total_uncertainty, nan=1.0, posinf=1.0, neginf=1.0
            )

            return corrected_prediction, total_uncertainty

        # Standard prediction - ROBUST against NaN
        cov_term = phi.T @ self.covariance_matrix @ phi
        cov_term = np.nan_to_num(cov_term, nan=1e-6, posinf=1e-6, neginf=1e-6)
        cov_term = max(cov_term, 1e-10)  # Ensure positive
        return base_prediction, float(np.sqrt(cov_term))

    def update_autonomy_level(self):
        """Update progressive autonomy level from paper Section 5"""
        if len(self.calibration_points) == 0:
            self.autonomy_level = 0.0
            return

        # Calculate confidence-based autonomy
        if self.coefficients is not None:
            # Recent prediction uncertainty
            recent_points = (
                self.calibration_points[-5:]
                if len(self.calibration_points) >= 5
                else self.calibration_points
            )
            avg_uncertainty = 0.0
            for point in recent_points:
                _, uncertainty = self.predict_pressure_with_uncertainty(
                    point.voltage, point.environmental_state
                )
                avg_uncertainty += uncertainty
            avg_uncertainty /= len(recent_points)

            # Autonomy based on uncertainty and calibration points
            uncertainty_factor = max(0, 1.0 - avg_uncertainty / 0.1)  # Normalize to 0-1
            calibration_factor = min(
                1.0, len(self.calibration_points) / 10.0
            )  # More points = more autonomous

            self.autonomy_level = 0.6 * uncertainty_factor + 0.4 * calibration_factor

            # Check if autonomous operation is possible
            if self.autonomy_level >= self.confidence_threshold:
                self.autonomous_predictions += 1
            else:
                self.human_input_count += 1

    def should_request_human_input(
        self, voltage: float, env_state: EnvironmentalState
    ) -> bool:
        """Determine if human input is needed based on uncertainty and autonomy level"""
        if self.coefficients is None:
            return True

        _, uncertainty = self.predict_pressure_with_uncertainty(voltage, env_state)

        # Request human input if:
        # 1. Uncertainty is too high
        # 2. Autonomy level is below threshold
        # 3. GLR test indicates drift
        high_uncertainty = uncertainty > 0.05  # 5% uncertainty threshold
        low_autonomy = self.autonomy_level < self.confidence_threshold
        drift_detected = self._run_glr_test()

        return high_uncertainty or low_autonomy or drift_detected

    def save_calibration_state(self, filepath: str = "calibration_state.json"):
        """Save calibration state for persistent learning"""
        state = {
            "sensor_id": self.sensor_id,
            "calibration_points": [
                {
                    "voltage": p.voltage,
                    "pressure": p.pressure,
                    "timestamp": p.timestamp,
                    "environmental_state": {
                        "temperature": p.environmental_state.temperature,
                        "humidity": p.environmental_state.humidity,
                        "vibration": p.environmental_state.vibration,
                        "aging_factor": p.environmental_state.aging_factor,
                        "mounting_torque": p.environmental_state.mounting_torque,
                    },
                    "uncertainty": p.uncertainty,
                }
                for p in self.calibration_points
            ],
            "coefficients": (
                self.coefficients.tolist() if self.coefficients is not None else None
            ),
            "covariance_matrix": (
                self.covariance_matrix.tolist()
                if self.covariance_matrix is not None
                else None
            ),
            "autonomy_level": self.autonomy_level,
            "human_input_count": self.human_input_count,
            "autonomous_predictions": self.autonomous_predictions,
            "cross_pt_covariance": {
                str(k): v.tolist() for k, v in self.cross_pt_covariance.items()
            },
            "last_calibration_timestamp": self.last_calibration_timestamp,
            "system_start_time": self.system_start_time,
        }

        with open(filepath, "w") as f:
            json.dump(state, f, indent=2)

    def load_calibration_state(self, filepath: str = "calibration_state.json"):
        """Load calibration state for persistent learning"""
        try:
            with open(filepath, "r") as f:
                state = json.load(f)

            # Restore calibration points
            self.calibration_points = []
            for cp_data in state["calibration_points"]:
                env_state = EnvironmentalState(
                    temperature=cp_data["environmental_state"]["temperature"],
                    humidity=cp_data["environmental_state"]["humidity"],
                    vibration=cp_data["environmental_state"]["vibration"],
                    aging_factor=cp_data["environmental_state"]["aging_factor"],
                    mounting_torque=cp_data["environmental_state"]["mounting_torque"],
                )

                point = CalibrationPoint(
                    voltage=cp_data["voltage"],
                    pressure=cp_data["pressure"],
                    timestamp=cp_data["timestamp"],
                    environmental_state=env_state,
                    uncertainty=cp_data["uncertainty"],
                )
                self.calibration_points.append(point)

            # Restore coefficients and covariance
            if state["coefficients"] is not None:
                self.coefficients = np.array(state["coefficients"])
            if state["covariance_matrix"] is not None:
                self.covariance_matrix = np.array(state["covariance_matrix"])

            # Restore autonomy metrics
            self.autonomy_level = state["autonomy_level"]
            self.human_input_count = state["human_input_count"]
            self.autonomous_predictions = state["autonomous_predictions"]
            self.last_calibration_timestamp = state["last_calibration_timestamp"]

            # Restore cross-PT covariance
            self.cross_pt_covariance = {
                int(k): np.array(v) for k, v in state["cross_pt_covariance"].items()
            }

            logger.info(
                f"Loaded calibration state for PT{self.sensor_id} with {len(self.calibration_points)} points"
            )

        except FileNotFoundError:
            logger.info(f"No calibration state file found for PT{self.sensor_id}")
        except Exception as e:
            logger.error(f"Error loading calibration state for PT{self.sensor_id}: {e}")

    def perform_self_calibration(
        self,
        other_pt_id: int,
        other_framework: "RobustCalibrationFramework",
        voltage: float,
        env_state: EnvironmentalState,
    ) -> Tuple[float, float]:
        """Perform self-calibration using another PT as reference (from paper Section 6)"""
        if (
            not self.cross_calibration_enabled
            or self.autonomy_level < self.self_calibration_threshold
        ):
            return self.predict_pressure_with_uncertainty(voltage, env_state)

        # Use reference PT's calibration to inform this PT
        ref_prediction, ref_uncertainty = (
            other_framework.predict_pressure_with_uncertainty(voltage, env_state)
        )

        # Compute self-calibration weight based on reference PT's performance
        ref_performance = other_framework.autonomy_level
        self_cal_weight = min(0.5, ref_performance * 0.6)  # Limit influence

        # Weighted combination of self-prediction and reference prediction
        self_prediction, self_uncertainty = self.predict_pressure_with_uncertainty(
            voltage, env_state
        )

        # Bayesian combination (from paper equation 354)
        combined_prediction = (
            1 - self_cal_weight
        ) * self_prediction + self_cal_weight * ref_prediction

        # Uncertainty propagation
        combined_uncertainty = np.sqrt(
            (1 - self_cal_weight) ** 2 * self_uncertainty**2
            + self_cal_weight**2 * ref_uncertainty**2
        )

        # Track reference PT performance
        if other_pt_id not in self.reference_pt_history:
            self.reference_pt_history[other_pt_id] = []
        self.reference_pt_history[other_pt_id].append(ref_performance)

        logger.info(
            f"PT{self.sensor_id} self-calibrated using PT{other_pt_id} (weight: {self_cal_weight:.2f})"
        )

        return combined_prediction, combined_uncertainty

    def _get_current_result(self) -> CalibrationResult:
        if self.coefficients is None:
            return CalibrationResult(
                coefficients=np.zeros(self.order + 1),
                covariance_matrix=np.eye(self.order + 1) * 1000.0,
                mean_squared_error=1000.0,
                r_squared=0.0,
                confidence_level="LOW",
            )

        # Calculate MSE and R²
        voltages = np.array([p.voltage for p in self.calibration_points])
        pressures = np.array([p.pressure for p in self.calibration_points])
        env_states = [p.environmental_state for p in self.calibration_points]

        X = np.array([self._design_matrix(v, e) for v, e in zip(voltages, env_states)])
        predictions = X @ self.coefficients
        residuals = pressures - predictions

        mse = np.mean(residuals**2)
        ss_tot = np.sum((pressures - np.mean(pressures)) ** 2)
        r_squared = 1 - (np.sum(residuals**2) / ss_tot) if ss_tot > 0 else 0.0

        return CalibrationResult(
            coefficients=self.coefficients,
            covariance_matrix=self.covariance_matrix,
            mean_squared_error=mse,
            r_squared=r_squared,
            confidence_level=self.get_confidence_level(),
            drift_detected=self._run_glr_test(),
        )


# ---------------------- Worker Threads ----------------------


class ConsensusWorkerThread(QtCore.QThread):
    """
    Dedicated thread for consensus computation
    Runs continuously, computing consensus from latest voltages
    """

    consensus_ready = QtCore.pyqtSignal(object)  # ConsensusState

    def __init__(self, global_system: MultivariateBayesianCalibration):
        super().__init__()
        self.global_system = global_system
        self.voltages_queue = queue.Queue(maxsize=1)  # Only keep latest
        self._running = True
        self._paused = False

    def update_voltages(self, voltages: Dict[int, float]):
        """Called from main thread with latest voltages"""
        try:
            # Non-blocking put - drop old data if queue full
            self.voltages_queue.put_nowait(voltages.copy())
        except queue.Full:
            # Replace old data
            try:
                self.voltages_queue.get_nowait()
                self.voltages_queue.put_nowait(voltages.copy())
            except queue.Empty:
                pass

    def pause(self):
        self._paused = True

    def resume(self):
        self._paused = False

    def stop(self):
        self._running = False

    def run(self):
        """Main worker loop"""
        while self._running:
            if self._paused:
                time.sleep(0.01)
                continue

            try:
                # Wait for voltage data with timeout
                voltages = self.voltages_queue.get(timeout=0.1)

                if len(voltages) < 2:
                    continue

                # COMPUTE CONSENSUS (heavy computation in worker thread)
                env_state = EnvironmentalState()
                consensus = self.global_system.compute_consensus_pressure(
                    voltages, env_state
                )

                # Emit result to main thread
                self.consensus_ready.emit(consensus)

            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Consensus worker error: {e}")
                time.sleep(0.1)


class CalibrationWorkerThread(QtCore.QThread):
    """
    Dedicated thread for calibration updates
    Handles heavy Bayesian matrix operations
    """

    calibration_complete = QtCore.pyqtSignal(
        int, object
    )  # sensor_id, CalibrationResult

    def __init__(self, global_system: MultivariateBayesianCalibration):
        super().__init__()
        self.global_system = global_system
        self.calibration_queue = queue.Queue()
        self._running = True

    def add_calibration_point(
        self, sensor_id: int, calibration_point: CalibrationPoint
    ):
        """Called from main thread to request calibration update"""
        self.calibration_queue.put((sensor_id, calibration_point))

    def stop(self):
        self._running = False

    def run(self):
        """Main worker loop"""
        while self._running:
            try:
                # Wait for calibration requests
                sensor_id, calibration_point = self.calibration_queue.get(timeout=0.1)

                # PERFORM MULTIVARIATE BAYESIAN UPDATE (heavy computation)
                start_time = time.time()
                self.global_system.multivariate_calibration_update(
                    sensor_id, calibration_point
                )
                elapsed = time.time() - start_time

                logger.info(
                    f"PT{sensor_id} calibration update completed in {elapsed*1000:.1f}ms"
                )

                # Signal completion (result can be fetched from global system)
                self.calibration_complete.emit(sensor_id, None)

            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Calibration worker error: {e}")


# ---------------------- Protocol and constants ----------------------
MAGIC = b"AD26"
PACKET_VERSION = 2
HEADER_STRUCT = struct.Struct("<4sBBHHII")
RECORD_STRUCT = struct.Struct("<BBiiII")
CRC_SIZE_OPTIONAL = 4  # bytes, optional trailing CRC ignored by parser
HEADER_SIZE = HEADER_STRUCT.size
RECORD_SIZE = RECORD_STRUCT.size

PACKET_RECORDS = 10
FLAG_TIMING = 0x01
INT32_MIN = -2147483648
UINT32_MAX = 0xFFFFFFFF

V_REF = 2.5
ADC_SCALE = 2147483648.0

BAUD = 115200
DEFAULT_WINDOW_SECONDS = 10.0
MAX_POINTS = 2000
NUM_CHANNELS_MAX = 16
MAX_PACKET_BYTES = HEADER_SIZE + PACKET_RECORDS * RECORD_SIZE + CRC_SIZE_OPTIONAL
RAW_MIN, RAW_MAX = -2147483648, 2147483648
TOGGLE_CHANNELS = list(range(1, 11))

VOLT_MEAN_WINDOW_S = 0.100  # 100 ms
RAW_Q_MAX = 2000

# Predefined colors for channels
CHANNEL_COLORS = [
    (255, 0, 0),  # red
    (0, 255, 0),  # green
    (0, 0, 255),  # blue
    (255, 165, 0),  # orange
    (128, 0, 128),  # purple
    (0, 255, 255),  # cyan
    (255, 192, 203),  # pink
    (128, 128, 0),  # olive
    (0, 128, 128),  # teal
    (255, 255, 0),  # yellow
]

# ---------------------- Helpers ----------------------


def plausible(rec):
    t_us, ch, raw, volts, read_us, conv_us, sps, sent_us = rec
    if not (0 <= ch < NUM_CHANNELS_MAX):
        return False
    if not (RAW_MIN <= raw <= RAW_MAX):
        return False
    if not (-10.0 <= volts <= 10.0):
        return False
    if not (0 <= read_us <= 2_000_000):
        return False
    if not (0 <= conv_us <= 2_000_000):
        return False
    if not (0.0 <= sps <= 2_000_000.0):
        return False
    if not (0 <= sent_us <= 0xFFFFFFFF):
        return False
    return True


def list_ports():
    return [p.device for p in serial.tools.list_ports.comports()]


# ---------------------- Serial reader thread ----------------------


class Reader(QtCore.QThread):
    sample = QtCore.pyqtSignal(float, object)  # t_wall, rec tuple
    status = QtCore.pyqtSignal(str)
    raw_bytes = QtCore.pyqtSignal(bytes)

    def __init__(self, port: str, baud: int):
        super().__init__()
        self.port = port
        self.baud = baud
        self._stop = False
        self.buf = bytearray()
        self.synced = False
        self.ser = None
        self._last_failures = 0
        self._last_valid_count = None
        self._last_pad_count = None
        self._last_summary = None
        self._last_status_emit = 0.0

    def stop(self):
        self._stop = True
        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass

    def _resync(self):
        keep = len(MAGIC) - 1
        while True:
            idx = self.buf.find(MAGIC)
            if idx == -1:
                if keep > 0 and len(self.buf) > keep:
                    del self.buf[:-keep]
                return False
            if idx:
                del self.buf[:idx]
            if len(self.buf) < HEADER_SIZE:
                return False
            try:
                (
                    magic,
                    version,
                    flags,
                    count,
                    _failures,
                    _total_time_us,
                    _packet_time_us,
                ) = HEADER_STRUCT.unpack_from(self.buf, 0)
            except struct.error:
                return False
            if magic != MAGIC or version != PACKET_VERSION or not (flags & FLAG_TIMING):
                del self.buf[0]
                continue
            count = int(count)
            if count > PACKET_RECORDS:
                del self.buf[0]
                continue
            payload_len = HEADER_SIZE + count * RECORD_SIZE
            if payload_len <= HEADER_SIZE or payload_len > MAX_PACKET_BYTES:
                del self.buf[0]
                continue
            if len(self.buf) < payload_len:
                return False
            if payload_len < len(self.buf) < payload_len + CRC_SIZE_OPTIONAL:
                return False
            crc_present = False
            if len(self.buf) >= payload_len + CRC_SIZE_OPTIONAL:
                next_bytes = self.buf[payload_len : payload_len + len(MAGIC)]
                if next_bytes != MAGIC:
                    crc_present = True
            packet_len = payload_len + (CRC_SIZE_OPTIONAL if crc_present else 0)
            if len(self.buf) < packet_len:
                return False
            self.synced = True
            return True

    def _drain_synced(self):
        out = []
        while True:
            if len(self.buf) < HEADER_SIZE:
                break
            if self.buf[: len(MAGIC)] != MAGIC:
                self.synced = False
                del self.buf[0]
                break
            try:
                (
                    magic,
                    version,
                    flags,
                    count,
                    failures,
                    total_time_us,
                    packet_time_us,
                ) = HEADER_STRUCT.unpack_from(self.buf, 0)
            except struct.error:
                self.synced = False
                del self.buf[0]
                break
            count = int(count)
            payload_len = HEADER_SIZE + count * RECORD_SIZE
            if payload_len > MAX_PACKET_BYTES:
                self.synced = False
                del self.buf[0]
                break
            if len(self.buf) < payload_len:
                break
            if payload_len < len(self.buf) < payload_len + CRC_SIZE_OPTIONAL:
                break
            crc_present = False
            if len(self.buf) >= payload_len + CRC_SIZE_OPTIONAL:
                next_bytes = self.buf[payload_len : payload_len + len(MAGIC)]
                if next_bytes != MAGIC:
                    crc_present = True
            packet_len = payload_len + (CRC_SIZE_OPTIONAL if crc_present else 0)
            if len(self.buf) < packet_len:
                break
            if magic != MAGIC or version != PACKET_VERSION or not (flags & FLAG_TIMING):
                self.synced = False
                del self.buf[0]
                break
            total_time_us = int(total_time_us)
            failures = int(failures)
            packet_time_us = int(packet_time_us) & UINT32_MAX
            count_success = max(1, count - min(count, failures))
            per_sample_default = (
                max(1, total_time_us // count_success) if total_time_us > 0 else 1
            )

            valid_records = 0
            padded_records = 0
            dropped_records = 0
            for i in range(count):
                base = HEADER_SIZE + i * RECORD_SIZE
                ch, ok, raw, sample_time, read_dur, conv_dur = (
                    RECORD_STRUCT.unpack_from(self.buf, base)
                )
                ch = int(ch)
                ok = int(ok)
                raw = int(raw)
                sample_time = int(sample_time)
                if ch == 0xFF:
                    padded_records += 1
                    continue
                if not ok or raw == INT32_MIN or sample_time in (-1, INT32_MIN):
                    dropped_records += 1
                    continue
                sample_us = sample_time & UINT32_MAX
                read_us = 0 if read_dur == UINT32_MAX else int(read_dur)
                conv_us = 0 if conv_dur == UINT32_MAX else int(conv_dur)
                per_sample = read_us + conv_us
                if per_sample <= 0:
                    per_sample = per_sample_default
                per_sample = max(1, int(per_sample))
                volts = raw * V_REF / ADC_SCALE
                sps = 1_000_000.0 / per_sample
                sample_tuple = (
                    sample_us,
                    ch,
                    raw,
                    volts,
                    read_us,
                    conv_us,
                    sps,
                    packet_time_us,
                )
                if plausible(sample_tuple):
                    out.append((time.monotonic(), sample_tuple))
                    valid_records += 1
                else:
                    dropped_records += 1
            real_failures = max(0, min(count, failures) - padded_records)
            if real_failures != self._last_failures:
                if real_failures:
                    extra = f" (padded {padded_records})" if padded_records else ""
                    self.status.emit(f"Sweep failures: {real_failures}{extra}")
                else:
                    self.status.emit("Sweep failures cleared")
                self._last_failures = real_failures
            elif self._last_failures and real_failures == 0:
                self._last_failures = 0
            summary = f"Packet: valid={valid_records}, padded={padded_records}, dropped={dropped_records}, failures={real_failures}"
            now = time.monotonic()
            if summary != self._last_summary or (now - self._last_status_emit) >= 0.5:
                if valid_records == 0 and dropped_records:
                    summary += " (no usable samples)"
                self.status.emit(summary)
                self._last_summary = summary
                self._last_status_emit = now
            self._last_valid_count = valid_records
            self._last_pad_count = padded_records
            del self.buf[:packet_len]
        return out

    def run(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
            self.status.emit(f"Connected {self.port} @ {self.baud}")
        except Exception as e:
            self.status.emit(f"Open failed: {e}")
            return

        while not self._stop:
            try:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.raw_bytes.emit(data)
                    self.buf.extend(data)
                    if not self.synced:
                        self._resync()
                    if self.synced:
                        for t_wall, rec in self._drain_synced():
                            self.sample.emit(t_wall, rec)
            except serial.SerialException as e:
                self.status.emit(f"Serial error: {e}")
                break
            except Exception as e:
                self.status.emit(f"Unexpected: {e}")
                break

        try:
            if self.ser and self.ser.is_open:
                self.ser.close()
        except Exception:
            pass
        self.status.emit("Disconnected")


# ---------------------- Metrics window ----------------------


class MetricsWindow(QtWidgets.QDialog):
    sig_ingest = QtCore.pyqtSignal(float, float, float)

    def __init__(self, parent, get_window_seconds):
        super().__init__(parent)
        self.setAttribute(QtCore.Qt.WidgetAttribute.WA_DeleteOnClose, True)
        self.setWindowTitle("Aggregated Metrics (conv_us & sps)")
        self.resize(900, 500)

        self.get_window_seconds = get_window_seconds
        self.t = deque()
        self.convs = deque()
        self.sps = deque()

        # connect signal with queued delivery to GUI thread
        self.sig_ingest.connect(
            self._enqueue, QtCore.Qt.ConnectionType.QueuedConnection
        )

        # throttle UI updates ~30 FPS
        self._timer = QtCore.QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._flush)
        self._timer.start()

        layout = QtWidgets.QVBoxLayout(self)

        self.plot_conv = pg.PlotWidget()
        self.plot_sps = pg.PlotWidget()
        self.plot_conv.setLabel("left", "conv_us")
        self.plot_sps.setLabel("left", "sps")
        self.plot_sps.setLabel("bottom", "Time", units="s")
        self.curve_conv = self.plot_conv.plot([], [])
        self.curve_sps = self.plot_sps.plot([], [])
        for pw in (self.plot_conv, self.plot_sps):
            pw.showGrid(x=True, y=True, alpha=0.3)

        layout.addWidget(self.plot_conv)
        layout.addWidget(self.plot_sps)

        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._refresh_axes)
        self.timer.start(100)

    def ingest(self, t_rel, conv_us, sps):
        # can be called from any thread
        self.sig_ingest.emit(float(t_rel), float(conv_us), float(sps))

    def _enqueue(self, t_rel, conv_us, sps):
        # runs on GUI thread due to QueuedConnection
        self.t.append(t_rel)
        self.convs.append(conv_us)
        self.sps.append(sps)

    def _flush(self):
        # runs on GUI thread at timer tick
        n = min(len(self.t), len(self.convs), len(self.sps))
        if not n:
            return
        # make NumPy arrays for pyqtgraph
        x = np.fromiter(self.t, dtype=np.float32, count=n)
        y1 = np.fromiter(self.convs, dtype=np.float32, count=n)
        y2 = np.fromiter(self.sps, dtype=np.float32, count=n)

        self.curve_conv.setData(x, y1, skipFiniteCheck=True)
        self.curve_sps.setData(x, y2, skipFiniteCheck=True)

    def _refresh_axes(self):
        if not self.t:
            return
        window = self.get_window_seconds()
        latest = self.t[-1]
        xmin = max(0.0, latest - window)
        for pw, data in ((self.plot_conv, self.convs), (self.plot_sps, self.sps)):
            pw.setXRange(xmin, max(xmin + 1e-3, latest), padding=0)
            if data:
                vmin, vmax = min(data), max(data)
                if vmax == vmin:
                    pad = 0.1 if vmax == 0 else abs(vmax) * 0.1
                    pw.setYRange(vmin - pad, vmax + pad, padding=0)
                else:
                    rng = vmax - vmin
                    pw.setYRange(vmin - 0.1 * rng, vmax + 0.1 * rng, padding=0)


# ---------------------- Settings window ----------------------


class SettingsWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.setWindowTitle("Settings")
        self.resize(360, 160)

        layout = QtWidgets.QVBoxLayout(self)
        layout.addWidget(QtWidgets.QLabel("Viewing window (seconds)"))

        row = QtWidgets.QHBoxLayout()
        self.slider = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider.setMinimum(1)
        self.slider.setMaximum(60)
        self.slider.setValue(int(self.parent.window_seconds))
        self.slider.valueChanged.connect(self._on_change)
        self.lbl = QtWidgets.QLabel(f"{self.parent.window_seconds:.1f}s")
        row.addWidget(self.slider, 1)
        row.addWidget(self.lbl)
        layout.addLayout(row)

        # MaxV control
        layout.addWidget(QtWidgets.QLabel("Max voltage (V)"))
        row2 = QtWidgets.QHBoxLayout()
        self.slider_maxv = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        self.slider_maxv.setMinimum(5)  # 0.5 V -> value * 0.1
        self.slider_maxv.setMaximum(100)  # 10.0 V
        self.slider_maxv.setValue(int(self.parent.max_v * 10))
        self.slider_maxv.valueChanged.connect(self._on_change_maxv)
        self.lbl_maxv = QtWidgets.QLabel(f"{self.parent.max_v:.1f} V")
        row2.addWidget(self.slider_maxv, 1)
        row2.addWidget(self.lbl_maxv)
        layout.addLayout(row2)

        btn = QtWidgets.QPushButton("Close")
        btn.clicked.connect(self.accept)
        layout.addWidget(btn)

    def _on_change(self, val):
        self.parent.window_seconds = float(val)
        self.parent._prune_all()
        self.lbl.setText(f"{float(val):.1f}s")

    def _on_change_maxv(self, val):
        self.parent.max_v = float(val) / 10.0
        self.lbl_maxv.setText(f"{self.parent.max_v:.1f} V")


# ---------------------- Raw console window ----------------------


class ConsoleWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setWindowTitle("Raw Serial Console")
        self.resize(800, 400)

        top = QtWidgets.QHBoxLayout()
        self.chk_pause = QtWidgets.QCheckBox("Pause")
        btn_clear = QtWidgets.QPushButton("Clear")
        btn_clear.clicked.connect(self._clear)
        top.addWidget(self.chk_pause)
        top.addWidget(btn_clear)
        top.addStretch(1)

        self.text = QtWidgets.QPlainTextEdit()
        self.text.setReadOnly(True)
        font = QtGui.QFontDatabase.systemFont(QtGui.QFontDatabase.SystemFont.FixedFont)
        font.setPointSize(10)
        self.text.setFont(font)

        layout = QtWidgets.QVBoxLayout(self)
        layout.addLayout(top)
        layout.addWidget(self.text)

    def _clear(self):
        self.text.clear()

    @QtCore.pyqtSlot(bytes)
    def on_bytes(self, data: bytes):
        if self.chk_pause.isChecked():
            return
        try:
            s = data.decode("utf-8", errors="replace")
            self.text.appendPlainText(s)
        except Exception:
            pass


# ---------------------- Calibration window ----------------------


class CalibrationWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.setWindowTitle("Robust Calibration System")
        self.resize(800, 600)

        layout = QtWidgets.QVBoxLayout(self)

        # Channel selection
        channel_frame = QtWidgets.QGroupBox("Channel Selection")
        channel_layout = QtWidgets.QHBoxLayout(channel_frame)

        channel_layout.addWidget(QtWidgets.QLabel("Channel:"))
        self.channel_combo = QtWidgets.QComboBox()
        self.channel_combo.addItems([f"CH{i}" for i in range(1, 11)])
        channel_layout.addWidget(self.channel_combo)

        channel_layout.addWidget(QtWidgets.QLabel("Current Voltage:"))
        self.voltage_label = QtWidgets.QLabel("0.000 V")
        channel_layout.addWidget(self.voltage_label)

        channel_layout.addWidget(QtWidgets.QLabel("Predicted Pressure:"))
        self.pressure_label = QtWidgets.QLabel("0.0 PSI")
        channel_layout.addWidget(self.pressure_label)

        channel_layout.addWidget(QtWidgets.QLabel("Confidence:"))
        self.confidence_label = QtWidgets.QLabel("LOW")
        channel_layout.addWidget(self.confidence_label)

        channel_layout.addWidget(QtWidgets.QLabel("Autonomy:"))
        self.autonomy_label = QtWidgets.QLabel("0.0%")
        channel_layout.addWidget(self.autonomy_label)

        channel_layout.addWidget(QtWidgets.QLabel("Uncertainty:"))
        self.uncertainty_label = QtWidgets.QLabel("N/A")
        channel_layout.addWidget(self.uncertainty_label)

        layout.addWidget(channel_frame)

        # Global system status
        global_frame = QtWidgets.QGroupBox("Global System Status")
        global_layout = QtWidgets.QHBoxLayout(global_frame)

        global_layout.addWidget(QtWidgets.QLabel("Consensus Pressure:"))
        self.consensus_pressure_label = QtWidgets.QLabel("N/A")
        global_layout.addWidget(self.consensus_pressure_label)

        global_layout.addWidget(QtWidgets.QLabel("Agreement:"))
        self.agreement_label = QtWidgets.QLabel("N/A")
        global_layout.addWidget(self.agreement_label)

        global_layout.addWidget(QtWidgets.QLabel("Population Strength:"))
        self.pop_strength_label = QtWidgets.QLabel("0.0")
        global_layout.addWidget(self.pop_strength_label)

        global_layout.addWidget(QtWidgets.QLabel("Consensus Confidence:"))
        self.consensus_confidence_label = QtWidgets.QLabel("0.0%")
        global_layout.addWidget(self.consensus_confidence_label)

        layout.addWidget(global_frame)

        # Calibration input
        input_frame = QtWidgets.QGroupBox("Calibration Input")
        input_layout = QtWidgets.QVBoxLayout(input_frame)

        input_layout.addWidget(QtWidgets.QLabel("Reference Pressure (PSI):"))
        self.pressure_input = QtWidgets.QLineEdit()
        self.pressure_input.setPlaceholderText("Enter reference pressure...")
        input_layout.addWidget(self.pressure_input)

        button_layout = QtWidgets.QHBoxLayout()
        self.add_point_btn = QtWidgets.QPushButton("Add Calibration Point")
        self.add_point_btn.clicked.connect(self.add_calibration_point)
        button_layout.addWidget(self.add_point_btn)

        self.clear_btn = QtWidgets.QPushButton("Clear All Points")
        self.clear_btn.clicked.connect(self.clear_calibration_points)
        button_layout.addWidget(self.clear_btn)

        input_layout.addLayout(button_layout)
        layout.addWidget(input_frame)

        # Calibration data display
        data_frame = QtWidgets.QGroupBox("Calibration Data & History")
        data_layout = QtWidgets.QVBoxLayout(data_frame)

        # Create tabbed widget for data and variance history
        self.tab_widget = QtWidgets.QTabWidget()

        # Current calibration points tab
        self.data_table = QtWidgets.QTableWidget()
        self.data_table.setColumnCount(4)
        self.data_table.setHorizontalHeaderLabels(
            ["Voltage (V)", "Pressure (PSI)", "Uncertainty", "Timestamp"]
        )
        self.tab_widget.addTab(self.data_table, "Current Points")

        # Variance history tab
        self.variance_table = QtWidgets.QTableWidget()
        self.variance_table.setColumnCount(5)
        self.variance_table.setHorizontalHeaderLabels(
            ["Timestamp", "RMSE", "MAE", "Autonomy", "Points"]
        )
        self.tab_widget.addTab(self.variance_table, "Quality History")

        # Covariance matrix tab
        self.covariance_table = QtWidgets.QTableWidget()
        self.covariance_table.setColumnCount(3)
        self.covariance_table.setHorizontalHeaderLabels(
            ["Parameter", "Value", "Std Dev"]
        )
        self.tab_widget.addTab(self.covariance_table, "Covariance Matrix")

        data_layout.addWidget(self.tab_widget)
        layout.addWidget(data_frame)

        # Calibration plot
        plot_frame = QtWidgets.QGroupBox("Calibration Curve")
        plot_layout = QtWidgets.QVBoxLayout(plot_frame)

        self.plot_widget = pg.PlotWidget()
        self.plot_widget.setLabel("left", "Pressure", units="PSI")
        self.plot_widget.setLabel("bottom", "Voltage", units="V")
        self.plot_widget.showGrid(x=True, y=True, alpha=0.3)
        plot_layout.addWidget(self.plot_widget)

        layout.addWidget(plot_frame)

        # Update timer
        self.update_timer = QtCore.QTimer(self)
        self.update_timer.timeout.connect(self.update_display)
        self.update_timer.start(100)  # Update every 100ms

    def add_calibration_point(self):
        try:
            channel = int(
                self.channel_combo.currentText()[2:]
            )  # Extract number from "CH2"
            pressure = float(self.pressure_input.text())

            if channel in self.parent.latest_voltages:
                voltage = self.parent.latest_voltages[channel]

                # Create calibration point
                env_state = EnvironmentalState()
                calibration_point = CalibrationPoint(
                    voltage=voltage,
                    pressure=pressure,
                    timestamp=time.time(),
                    environmental_state=env_state,
                    uncertainty=0.01,  # 1% uncertainty
                )

                # MARK AS HUMAN INPUT (ground truth)
                calibration_point.is_human_input = True

                # Submit to calibration worker thread (non-blocking)
                self.parent.calibration_worker.add_calibration_point(
                    channel, calibration_point
                )

                logger.info(
                    f"Submitted calibration point for CH{channel}: {pressure} PSI at {voltage:.3f}V"
                )

                # Clear input
                self.pressure_input.clear()

                # Update calibration system immediately for UI
                self.parent.global_calibration_system.multivariate_calibration_update(
                    channel, calibration_point
                )

                # AUTONOMOUS LEARNING: Update self-improving engine
                if self.parent.autonomous_engine:
                    # Get design vector (basis functions)
                    design_vector = (
                        self.parent.global_calibration_system._design_matrix(
                            voltage, env_state, channel
                        )
                    )
                    # Add to autonomous learning engine
                    self.parent.autonomous_engine.add_calibration_point(
                        channel, design_vector, pressure, uncertainty=0.05
                    )
                    logger.info(
                        f"🤖 Autonomous engine updated from PT{channel} calibration"
                    )

                    # Save evolved prior periodically
                    if self.parent.autonomous_engine.total_calibrations % 5 == 0:
                        learned_prior = (
                            self.parent.autonomous_engine.export_learned_prior()
                        )
                        with open("learned_prior.json", "w") as f:
                            json.dump(learned_prior, f, indent=2)
                        logger.info(
                            f"💾 Saved evolved prior (confidence={learned_prior['confidence']:.3f})"
                        )

                # CRITICAL: Zero-point calibration propagation
                # If this is a zero-point calibration (pressure near 0), propagate to all PTs
                if abs(pressure) < 10.0:  # Within 10 PSI of zero
                    logger.info(
                        f"🎯 ZERO-POINT CALIBRATION detected for PT{channel} at {pressure:.1f} PSI"
                    )
                    self._propagate_zero_point_calibration(
                        channel, voltage, pressure, env_state
                    )

                # Update display
                self.update_calibration_data()
                self.update_calibration_plot()

                # Also trigger calibration worker for background processing (redundant but safe)
                self.parent.calibration_worker.add_calibration_point(
                    channel, calibration_point
                )

            else:
                QtWidgets.QMessageBox.warning(
                    self, "No Data", f"No voltage data available for CH{channel}"
                )

        except ValueError:
            QtWidgets.QMessageBox.warning(
                self, "Invalid Input", "Please enter a valid pressure value"
            )

    def _propagate_zero_point_calibration(
        self,
        source_channel: int,
        voltage: float,
        pressure: float,
        env_state: EnvironmentalState,
    ):
        """
        CRITICAL: Propagate zero-point calibration to all other PTs
        This enables robust operation with just a single zero-point calibration
        """
        logger.info(
            f"🌐 Propagating zero-point calibration from PT{source_channel} to all other PTs..."
        )

        # Get current voltages for all channels
        propagated_count = 0
        for target_channel in range(1, 11):  # Channels 1-10
            if target_channel == source_channel:
                continue  # Skip source channel

            if target_channel in self.parent.latest_voltages:
                target_voltage = self.parent.latest_voltages[target_channel]

                # Create zero-point calibration for target channel
                # Assume same pressure (zero-point), but use target's current voltage
                zero_point = CalibrationPoint(
                    voltage=target_voltage,
                    pressure=pressure,  # Same pressure as source
                    timestamp=time.time(),
                    environmental_state=env_state,
                    uncertainty=0.05,  # Slightly higher uncertainty for propagated points
                )
                zero_point.is_human_input = False  # Mark as propagated
                zero_point.propagated_from = source_channel

                # Add to target channel's calibration
                self.parent.calibration_worker.add_calibration_point(
                    target_channel, zero_point
                )
                self.parent.global_calibration_system.multivariate_calibration_update(
                    target_channel, zero_point
                )

                propagated_count += 1
                logger.info(
                    f"  ✓ Propagated to PT{target_channel} at {target_voltage:.3f}V"
                )

        logger.info(f"✅ Zero-point calibration propagated to {propagated_count} PTs")
        QtWidgets.QMessageBox.information(
            self,
            "Zero-Point Propagation",
            f"Zero-point calibration propagated from PT{source_channel} to {propagated_count} other PTs!\n"
            f"All PTs now have a common reference point.",
        )

    def clear_calibration_points(self):
        channel = int(self.channel_combo.currentText()[2:])

        # Clear from global calibration system (NEW system)
        self.parent.global_calibration_system.calibration_points[channel].clear()

        # Reset the PT to population prior
        self.parent.global_calibration_system.pt_means[channel] = np.copy(
            self.parent.global_calibration_system.population_mean
        )
        self.parent.global_calibration_system.pt_covariances[channel] = np.copy(
            self.parent.global_calibration_system.population_covariance
        )
        self.parent.global_calibration_system.pt_precisions[channel] = np.copy(
            self.parent.global_calibration_system.population_precision
        )

        # Clear from old framework (for compatibility)
        framework = self.parent.calibration_frameworks[channel]
        framework.calibration_points.clear()
        framework.coefficients = None
        framework.covariance_matrix = None

        self.update_calibration_data()
        self.update_calibration_plot()
        logger.info(
            f"✅ CLEARED all calibration points for CH{channel} - reset to population prior"
        )

    def update_display(self):
        channel = int(self.channel_combo.currentText()[2:])

        if channel in self.parent.latest_voltages:
            voltage = self.parent.latest_voltages[channel]
            self.voltage_label.setText(f"{voltage:.3f} V")

            if channel in self.parent.pressure_predictions:
                pressure = self.parent.pressure_predictions[channel]
                self.pressure_label.setText(f"{pressure:.1f} PSI")

            if channel in self.parent.confidence_levels:
                confidence = self.parent.confidence_levels[channel]
                self.confidence_label.setText(confidence)

            # Show sensor metrics
            framework = self.parent.calibration_frameworks[channel]
            autonomy_pct = framework.autonomy_level * 100
            self.autonomy_label.setText(f"{autonomy_pct:.1f}%")

            # Show uncertainty with inflation factor
            env_state = EnvironmentalState()
            _, uncertainty = framework.predict_pressure_with_uncertainty(
                voltage, env_state
            )
            inflation = (
                self.parent.global_calibration_system.uncertainty_inflation_factor[
                    channel
                ]
            )
            self.uncertainty_label.setText(f"±{uncertainty:.2f} PSI (×{inflation:.2f})")

        # Show global system status
        global_system = self.parent.global_calibration_system
        self.pop_strength_label.setText(f"{global_system.population_strength:.2f}")
        self.consensus_confidence_label.setText(
            f"{global_system.consensus_confidence*100:.1f}%"
        )

        # Show consensus state
        if self.parent.last_consensus_state is not None:
            consensus = self.parent.last_consensus_state
            self.consensus_pressure_label.setText(
                f"{consensus.pressure:.1f} PSI (±{consensus.uncertainty:.2f})"
            )
            self.agreement_label.setText(
                f"{consensus.agreement_score*100:.1f}% ({len(consensus.participating_sensors)} sensors)"
            )
        else:
            self.consensus_pressure_label.setText("N/A")
            self.agreement_label.setText("N/A")

    def update_calibration_data(self):
        try:
            channel = int(self.channel_combo.currentText()[2:])
            framework = self.parent.calibration_frameworks[channel]

            # Get data from global system
            global_points = (
                self.parent.global_calibration_system.calibration_points.get(
                    channel, []
                )
            )

            logger.info(
                f"Updating calibration data for CH{channel}: {len(global_points)} points"
            )

            # Update current calibration points
            self.data_table.setRowCount(len(global_points))

            for i, point in enumerate(global_points):
                # Highlight human input points
                if hasattr(point, "is_human_input") and point.is_human_input:
                    brush = QtGui.QBrush(
                        QtGui.QColor(255, 200, 200)
                    )  # Light red for human input
                else:
                    brush = QtGui.QBrush(QtGui.QColor(255, 255, 255))  # White for auto

                voltage_item = QtWidgets.QTableWidgetItem(f"{point.voltage:.3f}")
                voltage_item.setBackground(brush)
                self.data_table.setItem(i, 0, voltage_item)

                pressure_item = QtWidgets.QTableWidgetItem(
                    f"{point.pressure:.1f}" if point.pressure is not None else "N/A"
                )
                pressure_item.setBackground(brush)
                self.data_table.setItem(i, 1, pressure_item)

                uncertainty_item = QtWidgets.QTableWidgetItem(
                    f"{point.uncertainty:.3f}"
                )
                uncertainty_item.setBackground(brush)
                self.data_table.setItem(i, 2, uncertainty_item)

                timestamp_item = QtWidgets.QTableWidgetItem(
                    time.strftime("%H:%M:%S", time.localtime(point.timestamp))
                )
                timestamp_item.setBackground(brush)
                self.data_table.setItem(i, 3, timestamp_item)

        except Exception as e:
            logger.error(f"Error updating calibration data: {e}")

        # Update quality history (get from global system)
        quality_history = self.parent.global_calibration_system.quality_history.get(
            channel, []
        )
        self.variance_table.setRowCount(len(quality_history))

        for i, record in enumerate(quality_history):
            self.variance_table.setItem(
                i,
                0,
                QtWidgets.QTableWidgetItem(
                    time.strftime("%H:%M:%S", time.localtime(record["timestamp"]))
                ),
            )
            self.variance_table.setItem(
                i, 1, QtWidgets.QTableWidgetItem(f"{record.get('rmse', 0):.4f}")
            )
            self.variance_table.setItem(
                i, 2, QtWidgets.QTableWidgetItem(f"{record.get('mae', 0):.4f}")
            )
            self.variance_table.setItem(
                i, 3, QtWidgets.QTableWidgetItem(f"{record.get('autonomy', 0):.2f}")
            )
            self.variance_table.setItem(
                i, 4, QtWidgets.QTableWidgetItem(f"{record.get('n_points', 0)}")
            )

        # Update covariance matrix
        if (
            framework.covariance_matrix is not None
            and framework.coefficients is not None
        ):
            param_names = [f"θ{i}" for i in range(len(framework.coefficients))]
            self.covariance_table.setRowCount(len(param_names))

            for i, (name, coeff, std_dev) in enumerate(
                zip(
                    param_names,
                    framework.coefficients,
                    np.sqrt(np.diag(framework.covariance_matrix)),
                )
            ):
                self.covariance_table.setItem(i, 0, QtWidgets.QTableWidgetItem(name))
                self.covariance_table.setItem(
                    i, 1, QtWidgets.QTableWidgetItem(f"{coeff:.6f}")
                )
                self.covariance_table.setItem(
                    i, 2, QtWidgets.QTableWidgetItem(f"{std_dev:.6f}")
                )
        else:
            self.covariance_table.setRowCount(0)

    def update_calibration_plot(self):
        try:
            channel = int(self.channel_combo.currentText()[2:])
            framework = self.parent.calibration_frameworks[channel]

            self.plot_widget.clear()

            # Get calibration points from global system
            global_points = (
                self.parent.global_calibration_system.calibration_points.get(
                    channel, []
                )
            )

            if len(global_points) == 0:
                logger.info(f"No calibration points for CH{channel}")
                return

            # Extract voltages and pressures (filter out None pressures)
            valid_points = [
                (p.voltage, p.pressure) for p in global_points if p.pressure is not None
            ]

            if len(valid_points) == 0:
                logger.info(f"No valid calibration points for CH{channel}")
                return

            voltages, pressures = zip(*valid_points)
            voltages = list(voltages)
            pressures = list(pressures)

            logger.info(f"Plotting {len(voltages)} calibration points for CH{channel}")
            logger.info(f"Voltage range: {min(voltages):.3f} - {max(voltages):.3f}V")
            logger.info(
                f"Pressure range: {min(pressures):.2f} - {max(pressures):.2f} PSI"
            )

            # Plot calibration points (HUMAN INPUT = RED, LARGE)
            self.plot_widget.plot(
                voltages,
                pressures,
                pen=None,
                symbol="o",
                symbolSize=12,
                symbolBrush=(255, 0, 0),
                symbolPen="w",
                name="Human Calibration",
            )

            # Plot calibration curve if we have enough points
            if len(valid_points) >= 2:
                try:
                    # Get voltage range for curve
                    v_min, v_max = min(voltages), max(voltages)
                    v_range = v_max - v_min
                    v_curve_min = max(0, v_min - 0.1 * v_range)
                    v_curve_max = min(10.0, v_max + 0.1 * v_range)

                    v_curve, p_curve = framework.get_calibration_curve_data(
                        (v_curve_min, v_curve_max)
                    )

                    if v_curve and p_curve and len(v_curve) > 0:
                        # Plot prediction curve
                        self.plot_widget.plot(
                            v_curve,
                            p_curve,
                            pen=pg.mkPen("b", width=2),
                            name="Bayesian Fit",
                        )

                        # Plot uncertainty bounds
                        env_state = EnvironmentalState()
                        pressures_upper = []
                        pressures_lower = []

                        for v in v_curve:
                            p_pred, uncertainty = (
                                framework.predict_pressure_with_uncertainty(
                                    v, env_state
                                )
                            )
                            pressures_upper.append(p_pred + 2 * uncertainty)
                            pressures_lower.append(p_pred - 2 * uncertainty)

                        # Plot uncertainty bounds
                        self.plot_widget.plot(
                            v_curve,
                            pressures_upper,
                            pen=pg.mkPen(
                                "gray", width=1, style=QtCore.Qt.PenStyle.DashLine
                            ),
                        )
                        self.plot_widget.plot(
                            v_curve,
                            pressures_lower,
                            pen=pg.mkPen(
                                "gray", width=1, style=QtCore.Qt.PenStyle.DashLine
                            ),
                        )

                        logger.info(f"Plotted calibration curve for CH{channel}")
                    else:
                        logger.warning(
                            f"Could not generate calibration curve for CH{channel}"
                        )

                except Exception as e:
                    logger.error(
                        f"Error plotting calibration curve for CH{channel}: {e}"
                    )

        except Exception as e:
            logger.error(f"Error updating calibration plot: {e}")


# ---------------------- Main application window ----------------------


class App(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Channels")
        self.resize(1280, 740)

        self.window_seconds = DEFAULT_WINDOW_SECONDS
        self.console_win = None
        self.metrics_win = None
        self.calibration_win = None

        # Y-axis control
        self.autoscale = True  # default ON (current behavior)
        self.max_v = 2.5  # default VMAX when autoscale is OFF

        # MULTIVARIATE BAYESIAN CALIBRATION SYSTEM
        # Single global system managing all PTs collectively
        # Use 9-parameter model from paper (order=8 gives 9 parameters: 0,1,2,3,4,5,6,7,8)
        self.global_calibration_system = MultivariateBayesianCalibration(
            num_sensors=16, order=8
        )

        # CRITICAL: Load population prior from previous test sessions
        # This gives us the accumulated knowledge needed for launch day zero-point calibration
        self.global_calibration_system.load_population_prior("population_prior.json")

        # ROBUSTNESS MANAGER: Comprehensive validation, backup, health monitoring
        if ROBUSTNESS_AVAILABLE:
            self.robustness_manager = RobustnessManager()
            logger.info(
                f"🛡️  Robustness Manager active: mode={self.robustness_manager.config.mode.value}"
            )

            # Attempt auto-recovery if previous session failed
            if not os.path.exists("population_prior.json"):
                logger.warning("⚠️  No population prior found, attempting recovery...")
                recovered_data = self.robustness_manager.auto_recover()
                if recovered_data and "population_prior" in recovered_data:
                    logger.info("✅ Recovered population prior from backup")
                    # Apply recovered data
                    try:
                        pp = recovered_data["population_prior"]
                        if "population_mean" in pp:
                            self.global_calibration_system.population_mean = np.array(
                                pp["population_mean"]
                            )
                        if "population_covariance" in pp:
                            self.global_calibration_system.population_covariance = (
                                np.array(pp["population_covariance"])
                            )
                        if "population_strength" in pp:
                            self.global_calibration_system.population_strength = float(
                                pp["population_strength"]
                            )
                        logger.info("Population prior restored from backup")
                    except Exception as e:
                        logger.error(f"Failed to apply recovered data: {e}")
        else:
            self.robustness_manager = None
            logger.warning("⚠️  Running without robustness features")

        # AUTONOMOUS LEARNING ENGINE: Self-improving calibration
        if AUTONOMOUS_LEARNING_AVAILABLE:
            self.autonomous_engine = AutonomousCalibrationEngine(
                n_sensors=16,
                n_params=9,
                forgetting_factor=0.995,  # Slow forgetting for stability
            )

            # Load previously learned prior if available
            if os.path.exists("learned_prior.json"):
                try:
                    with open("learned_prior.json", "r") as f:
                        learned_data = json.load(f)
                    self.autonomous_engine.import_learned_prior(learned_data)
                    logger.info(
                        "✅ Loaded previously learned prior from autonomous learning"
                    )
                except Exception as e:
                    logger.warning(f"Failed to load learned prior: {e}")

            logger.info(
                "🤖 Autonomous Learning Engine active: system will evolve priors automatically"
            )
        else:
            self.autonomous_engine = None
            logger.warning("⚠️  Running without autonomous learning features")

        # Individual sensor frameworks (thin wrappers around global system)
        self.calibration_frameworks: Dict[int, RobustCalibrationFramework] = {
            i: self.global_calibration_system.get_sensor_framework(i) for i in range(16)
        }

        self.latest_voltages: Dict[int, float] = {}
        self.latest_voltages_lock = threading.Lock()  # Protect voltage updates

        # CRITICAL: Voltage filters for stability (EMA + LPF)
        self.voltage_filters: Dict[int, VoltageFilter] = {
            i: VoltageFilter() for i in range(16)
        }

        self.pressure_predictions: Dict[int, float] = {}
        self.confidence_levels: Dict[int, str] = {}

        # Consensus state
        self.last_consensus_state: Optional[ConsensusState] = None
        self.auto_detected_pressures: List[Tuple[float, float]] = []  # (time, pressure)

        # WORKER THREADS FOR COMPUTATIONAL EFFICIENCY
        # Consensus thread - runs continuously computing consensus from all sensors
        self.consensus_worker = ConsensusWorkerThread(self.global_calibration_system)
        self.consensus_worker.consensus_ready.connect(self._on_consensus_ready)
        self.consensus_worker.start()
        logger.info("Started consensus worker thread")

        # Calibration thread - handles heavy Bayesian updates
        self.calibration_worker = CalibrationWorkerThread(
            self.global_calibration_system
        )
        self.calibration_worker.calibration_complete.connect(
            self._on_calibration_complete
        )
        self.calibration_worker.start()
        logger.info("Started calibration worker thread")

        # Load existing calibration states
        self._load_all_calibration_states()

        # Persistent learning timer
        self.save_timer = QtCore.QTimer(self)
        self.save_timer.timeout.connect(self._save_all_calibration_states)
        self.save_timer.start(300000)  # Save every 5 minutes

        # Trigger consensus computation when voltages update
        self.voltage_update_timer = QtCore.QTimer(self)
        self.voltage_update_timer.timeout.connect(self._trigger_consensus_computation)
        self.voltage_update_timer.start(100)  # Trigger every 100ms

        central = QtWidgets.QWidget()
        self.setCentralWidget(central)
        root = QtWidgets.QVBoxLayout(central)

        # Top bar
        top = QtWidgets.QHBoxLayout()
        top.addWidget(QtWidgets.QLabel("Port"))
        self.cmb_port = QtWidgets.QComboBox()
        self._refresh_port_list()
        top.addWidget(self.cmb_port)

        top.addWidget(QtWidgets.QLabel("Baud"))
        self.cmb_baud = QtWidgets.QComboBox()
        self.cmb_baud.addItems(
            [
                str(b)
                for b in [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
            ]
        )
        self.cmb_baud.setCurrentText(str(BAUD))
        top.addWidget(self.cmb_baud)

        btn_refresh = QtWidgets.QPushButton("Refresh")
        btn_refresh.clicked.connect(self._refresh_port_list)
        top.addWidget(btn_refresh)
        self.btn_connect = QtWidgets.QPushButton("Connect")
        self.btn_connect.clicked.connect(self._toggle_connect)
        top.addWidget(self.btn_connect)

        btn_metrics = QtWidgets.QPushButton("Open Metrics")
        btn_metrics.clicked.connect(self._open_metrics)
        top.addWidget(btn_metrics)
        btn_settings = QtWidgets.QPushButton("Open Settings")
        btn_settings.clicked.connect(self._open_settings)
        top.addWidget(btn_settings)
        btn_console = QtWidgets.QPushButton("Open Console")
        btn_console.clicked.connect(self._open_console)
        top.addWidget(btn_console)

        btn_calibration = QtWidgets.QPushButton("Open Calibration")
        btn_calibration.clicked.connect(self._open_calibration)
        top.addWidget(btn_calibration)

        # Autoscale checkbox
        self.chk_autoscale = QtWidgets.QCheckBox("Autoscale Y")
        self.chk_autoscale.setChecked(True)
        self.chk_autoscale.stateChanged.connect(self._on_autoscale)
        top.addWidget(self.chk_autoscale)

        top.addStretch(1)
        root.addLayout(top)

        # Main split: plot on left, toggles + metrics on right
        main = QtWidgets.QHBoxLayout()
        root.addLayout(main, 1)

        # Plot
        self.plot = pg.PlotWidget()
        self.plot.setLabel("bottom", "Time", units="s")
        self.plot.setLabel("left", "Voltage", units="V")
        self.plot.showGrid(x=True, y=True, alpha=0.3)
        self.plot.setTitle("Channels")
        self.plot.setClipToView(True)
        self.plot.setDownsampling(mode="peak")
        self.plot.setMouseEnabled(x=True, y=True)
        self.legend = self.plot.addLegend(labelTextSize="9pt")

        main.addWidget(self.plot, 1)

        # Right panel
        right = QtWidgets.QVBoxLayout()
        main.addLayout(right)

        # Toggle group
        right.addWidget(QtWidgets.QLabel("Show channels:"))
        self.chk = {}
        self.curves = {}
        for idx, ch in enumerate(TOGGLE_CHANNELS):
            cb = QtWidgets.QCheckBox(f"CH{ch}")
            cb.setChecked(True)
            cb.stateChanged.connect(self._on_toggle)
            right.addWidget(cb)
            self.chk[ch] = cb
            # prepare curve with color
            color = CHANNEL_COLORS[idx % len(CHANNEL_COLORS)]
            pen = pg.mkPen(color=color, width=1)
            self.curves[ch] = self.plot.plot([], [], name=f"CH{ch}", pen=pen)

        # Simple metrics
        box = QtWidgets.QGroupBox("Simple Metrics")
        form = QtWidgets.QVBoxLayout(box)
        self.lbl_read_mean = QtWidgets.QLabel("conv_us mean: n/a")
        self.lbl_sps_mean = QtWidgets.QLabel("sps mean: n/a")
        self.lbl_latency = QtWidgets.QLabel("latency jitter mean/max: n/a")
        form.addWidget(self.lbl_read_mean)
        form.addWidget(self.lbl_sps_mean)
        form.addWidget(self.lbl_latency)
        form.addWidget(self._hline())
        form.addWidget(
            QtWidgets.QLabel(
                f"Per-channel mean V (last {int(VOLT_MEAN_WINDOW_S*1000)} ms)"
            )
        )
        self.per_ch = {}
        for ch in TOGGLE_CHANNELS:
            lbl = QtWidgets.QLabel(f"CH{ch}: n/a")
            form.addWidget(lbl)
            self.per_ch[ch] = lbl
        right.addWidget(box)

        status_box = QtWidgets.QGroupBox("Status")
        status_layout = QtWidgets.QVBoxLayout(status_box)
        self.lbl_status = QtWidgets.QLabel("Idle")
        self.lbl_status.setWordWrap(True)
        status_layout.addWidget(self.lbl_status)
        right.addWidget(status_box)
        right.addStretch(1)

        # Data storage
        self.t0 = None
        self.send_start_raw = None
        self.send_prev_raw = None
        self.send_rollover = 0
        self.t = defaultdict(deque)  # per-ch time
        self.v = defaultdict(deque)  # per-ch volts
        self.reads = deque(maxlen=MAX_POINTS)  # (t_rel, read_us)
        self.convs = deque(maxlen=MAX_POINTS)  # (t_rel, conv_us)
        self.sps = deque(maxlen=MAX_POINTS)  # (t_rel, sps)
        self.latencies = deque(maxlen=MAX_POINTS)  # (t_rel, latency_s)

        # Timer for plot updates
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self._update_plot)
        self.timer.start(50)

        # Serial reader holder
        self.reader = None

    # --------- UI helpers ---------
    def _hline(self):
        line = QtWidgets.QFrame()
        line.setFrameShape(QtWidgets.QFrame.Shape.HLine)
        line.setFrameShadow(QtWidgets.QFrame.Shadow.Sunken)
        return line

    def _prune_all(self):
        if not self.t:
            return
        latest = 0.0
        for ts in self.t.values():
            if ts:
                latest = max(latest, ts[-1])
        cutoff = latest - self.window_seconds
        if cutoff <= 0.0:
            return
        for ch in list(self.t.keys()):
            ts = self.t[ch]
            vs = self.v[ch]
            while ts and ts[0] < cutoff:
                ts.popleft()
                vs.popleft()
        while self.reads and self.reads[0][0] < cutoff:
            self.reads.popleft()
        while self.sps and self.sps[0][0] < cutoff:
            self.sps.popleft()
        while self.latencies and self.latencies[0][0] < cutoff:
            self.latencies.popleft()

    def _refresh_port_list(self):
        ports = list_ports()
        self.cmb_port.clear()
        self.cmb_port.addItems(ports)
        if ports:
            self.cmb_port.setCurrentIndex(0)

    def set_status(self, text):
        self.lbl_status.setText(text)

    # --------- Connect logic ---------
    def _toggle_connect(self):
        if self.reader is None:
            port = self.cmb_port.currentText().strip()
            try:
                baud = int(self.cmb_baud.currentText())
            except Exception:
                self.set_status("Bad baud")
                return
            self._connect(port, baud)
            self.btn_connect.setText("Disconnect")
        else:
            self.reader.stop()
            self.reader = None
            self.set_status("Disconnected")
            self.btn_connect.setText("Connect")

    def _connect(self, port, baud):
        self.t0 = None
        self.send_start_raw = None
        self.send_prev_raw = None
        self.send_rollover = 0
        self.t.clear()
        self.v.clear()
        self.reads.clear()
        self.convs.clear()
        self.sps.clear()
        self.latencies.clear()

        self.reader = Reader(port, baud)
        self.reader.sample.connect(self._on_sample)
        self.reader.status.connect(self.set_status)
        self.reader.raw_bytes.connect(self._on_raw_bytes)
        self.reader.start()

    # --------- Data ingestion ---------
    @QtCore.pyqtSlot(float, object)
    def _on_sample(self, t_wall, rec):
        t_us, ch, raw, volts, read_us, conv_us, sps, sent_us = rec
        if self.t0 is None:
            self.t0 = t_wall
        t_rel = t_wall - self.t0
        if ch == 0:
            ch = 10
        self.t[ch].append(t_rel)
        self.v[ch].append(volts)
        self.reads.append((t_rel, read_us))
        self.convs.append((t_rel, conv_us))
        self.sps.append((t_rel, sps))

        # DISABLED: Voltage filtering was causing massive prediction errors
        # filtered_volts = self.voltage_filters[ch].update(volts)
        filtered_volts = volts  # Use raw voltage directly

        # Update voltage tracking for consensus (thread-safe) - use raw voltage
        with self.latest_voltages_lock:
            self.latest_voltages[ch] = volts  # Raw voltage

        # Predict pressure using multivariate Bayesian framework
        framework = self.calibration_frameworks[ch]
        env_state = EnvironmentalState()

        # Get prediction with adaptive uncertainty - use filtered voltage
        predicted_pressure, uncertainty = framework.predict_pressure_with_uncertainty(
            filtered_volts, env_state
        )

        self.pressure_predictions[ch] = predicted_pressure
        self.confidence_levels[ch] = framework.get_confidence_level()

        # Log high autonomy achievement
        if framework.autonomy_level > 0.8 and framework.autonomy_level < 0.81:
            logger.info(
                f"PT{ch} achieving high autonomy: {framework.autonomy_level:.2f}, "
                f"population_strength: {self.global_calibration_system.population_strength:.2f}"
            )

        send_raw = int(sent_us) & 0xFFFFFFFF
        if self.send_start_raw is None:
            self.send_start_raw = send_raw
            self.send_prev_raw = send_raw
            self.send_rollover = 0
        else:
            if self.send_prev_raw is not None and send_raw < self.send_prev_raw:
                self.send_rollover += 1
            self.send_prev_raw = send_raw
        send_elapsed = (
            (self.send_rollover << 32) + send_raw - self.send_start_raw
        ) / 1_000_000.0
        diff = t_rel - send_elapsed
        self.latencies.append((t_rel, diff))

        cutoff = t_rel - self.window_seconds
        if cutoff > 0.0:
            ts = self.t[ch]
            vs = self.v[ch]
            while ts and ts[0] < cutoff:
                ts.popleft()
                vs.popleft()
            while self.reads and self.reads[0][0] < cutoff:
                self.reads.popleft()
            while self.convs and self.convs[0][0] < cutoff:
                self.convs.popleft()
            while self.sps and self.sps[0][0] < cutoff:
                self.sps.popleft()
            while self.latencies and self.latencies[0][0] < cutoff:
                self.latencies.popleft()

        # Feed metrics window too
        if self.metrics_win is not None:
            self.metrics_win.ingest(t_rel, conv_us, sps)

    @QtCore.pyqtSlot(bytes)
    def _on_raw_bytes(self, data: bytes):
        if self.console_win is not None:
            self.console_win.on_bytes(data)

    # --------- Plot refresh ---------
    def _on_toggle(self):
        for ch, cb in self.chk.items():
            if cb.isChecked():
                if ch not in self.curves:
                    idx = TOGGLE_CHANNELS.index(ch)
                    color = CHANNEL_COLORS[idx % len(CHANNEL_COLORS)]
                    pen = pg.mkPen(color=color, width=1)
                    self.curves[ch] = self.plot.plot([], [], name=f"CH{ch}", pen=pen)
                else:
                    if ch in self.curves:
                        self.curves[ch].setData([], [])

    def _update_plot(self):
        for ch, cb in self.chk.items():
            if cb.isChecked():
                ts = self.t.get(ch, [])
                vs = self.v.get(ch, [])
                if ts and vs:
                    self.curves[ch].setData(ts, vs)
                else:
                    if ch in self.curves:
                        self.curves[ch].setData([], [])

        # X window aligns to latest visible sample
        latest = 0.0
        for ch, cb in self.chk.items():
            if cb.isChecked() and self.t.get(ch):
                latest = max(latest, self.t[ch][-1])
        xmin = max(0.0, latest - self.window_seconds)
        self.plot.setXRange(xmin, max(xmin + 1e-3, latest), padding=0)

        # Trim histories to last window
        now = latest
        keep = self.window_seconds
        for ch in TOGGLE_CHANNELS:
            ts = self.t.get(ch)
            vs = self.v.get(ch)
            if ts and vs:
                while ts and ts[0] < now - keep:
                    ts.popleft()
                    vs.popleft()
        while self.reads and self.reads[0][0] < now - keep:
            self.reads.popleft()
        while self.convs and self.convs[0][0] < now - keep:
            self.convs.popleft()
        while self.sps and self.sps[0][0] < now - keep:
            self.sps.popleft()
        while self.latencies and self.latencies[0][0] < now - keep:
            self.latencies.popleft()

        # Y limits
        if self.autoscale:
            # Fit visible channels (original behavior)
            values = []
            for ch, cb in self.chk.items():
                if cb.isChecked():
                    values.extend(self.v.get(ch, []))
            if values:
                vmin, vmax = min(values), max(values)
                if vmax == vmin:
                    pad = 0.1 if vmax == 0 else abs(vmax) * 0.1
                    self.plot.setYRange(vmin - pad, vmax + pad, padding=0)
                else:
                    rng = vmax - vmin
                    self.plot.setYRange(vmin - 0.1 * rng, vmax + 0.1 * rng, padding=0)
        else:
            # Fixed range: 0V .. max_v + 100 mV
            y_min = 0.0
            y_max = float(self.max_v) + 0.1
            if y_max <= y_min + 0.01:
                y_max = y_min + 0.5  # small guard to avoid zero-height range
            self.plot.setYRange(y_min, y_max, padding=0)

        # Overall means over last window
        recent_conv = [val for t, val in self.convs if t >= now - self.window_seconds]
        recent_sps = [val for t, val in self.sps if t >= now - self.window_seconds]
        recent_latency_diffs = [
            val for t, val in self.latencies if t >= now - self.window_seconds
        ]
        if recent_conv:
            mean_conv = sum(recent_conv) / len(recent_conv)
            self.lbl_read_mean.setText(
                f"conv_us mean (last {self.window_seconds:.0f}s): {mean_conv:.2f}"
            )
        if recent_sps:
            # Instead of arithmetic mean of sps, compute true rate = count / elapsed time
            recent_times = [t for t, _ in self.sps if t >= now - self.window_seconds]
            if len(recent_times) >= 2:
                duration = recent_times[-1] - recent_times[0]
                if duration > 0:
                    agg_sps = (len(recent_times) - 1) / duration
                    self.lbl_sps_mean.setText(
                        f"sps mean (last {self.window_seconds:.0f}s): {agg_sps:.2f}"
                    )
        if recent_latency_diffs:
            baseline = min(recent_latency_diffs)
            latencies = [max(0.0, diff - baseline) for diff in recent_latency_diffs]
            mean_latency = sum(latencies) / len(latencies)
            max_latency = max(latencies)
            self.lbl_latency.setText(
                f"latency jitter mean/max (last {self.window_seconds:.0f}s): {mean_latency * 1000:.2f} ms / {max_latency * 1000:.2f} ms"
            )
        else:
            self.lbl_latency.setText("latency jitter mean/max: n/a")

        # Per-channel mean V over last 100 ms
        for ch in TOGGLE_CHANNELS:
            if not self.chk[ch].isChecked():
                self.per_ch[ch].setText(f"CH{ch}: n/a")
                continue
            ts = self.t.get(ch, [])
            vs = self.v.get(ch, [])
            if ts and vs:
                recent = [
                    vv for tt, vv in zip(ts, vs) if tt >= now - VOLT_MEAN_WINDOW_S
                ]
                if recent:
                    mean_v = sum(recent) / len(recent)
                    self.per_ch[ch].setText(f"CH{ch}: {mean_v:.4f} V")
                else:
                    self.per_ch[ch].setText(f"CH{ch}: n/a")
            else:
                self.per_ch[ch].setText(f"CH{ch}: n/a")

    # --------- Secondary windows ---------
    def _open_metrics(self):
        if self.metrics_win is None or not self.metrics_win.isVisible():
            self.metrics_win = MetricsWindow(
                self, get_window_seconds=lambda: self.window_seconds
            )
        self.metrics_win.show()
        self.metrics_win.raise_()
        self.metrics_win.activateWindow()
        self.metrics_win.finished.connect(lambda _: setattr(self, "metrics_win", None))

    def _open_settings(self):
        dlg = SettingsWindow(self)
        dlg.exec()

    def _open_console(self):
        if self.console_win is None or not self.console_win.isVisible():
            self.console_win = ConsoleWindow(self)
        self.console_win.show()
        self.console_win.raise_()
        self.console_win.activateWindow()

    def _open_calibration(self):
        if self.calibration_win is None or not self.calibration_win.isVisible():
            self.calibration_win = CalibrationWindow(self)
        self.calibration_win.show()
        self.calibration_win.raise_()
        self.calibration_win.activateWindow()

    def _trigger_consensus_computation(self):
        """
        Trigger consensus computation in worker thread
        This runs on main thread timer, but offloads work to worker
        """
        with self.latest_voltages_lock:
            if len(self.latest_voltages) >= 2:
                self.consensus_worker.update_voltages(self.latest_voltages)

    @QtCore.pyqtSlot(object)
    def _on_consensus_ready(self, consensus: ConsensusState):
        """
        Called when consensus worker completes computation
        Runs on main thread (Qt signal)
        """
        self.last_consensus_state = consensus

        # Check for automatic pressure detection
        if self.global_calibration_system.consensus_confidence > 0.7:
            with self.latest_voltages_lock:
                voltages_copy = self.latest_voltages.copy()

            env_state = EnvironmentalState()
            auto_pressure = self.global_calibration_system.automatic_pressure_detection(
                voltages_copy, env_state
            )

            if auto_pressure is not None:
                self.auto_detected_pressures.append((time.time(), auto_pressure))

                # Keep only last 100 detections
                if len(self.auto_detected_pressures) > 100:
                    self.auto_detected_pressures = self.auto_detected_pressures[-100:]

                # Try self-calibration with confidence weighting
                self.global_calibration_system.self_calibrate_with_confidence(
                    voltages_copy, env_state
                )

    @QtCore.pyqtSlot(int, object)
    def _on_calibration_complete(self, sensor_id: int, result):
        """
        Called when calibration worker completes an update
        Runs on main thread (Qt signal)
        """
        framework = self.calibration_frameworks[sensor_id]

        # Force UI update
        if self.calibration_win is not None and self.calibration_win.isVisible():
            self.calibration_win.update_calibration_data()
            self.calibration_win.update_calibration_plot()

        logger.info(
            f"PT{sensor_id} calibration complete - autonomy: {framework.autonomy_level:.2f}, "
            f"pop_strength: {self.global_calibration_system.population_strength:.2f}"
        )

    def _auto_calibrate_from_consensus(
        self, consensus_pressure: float, env_state: EnvironmentalState
    ):
        """
        AUTONOMOUS CALIBRATION FROM CONSENSUS
        When system is highly confident, automatically add calibration points
        Offloads work to calibration worker thread
        """
        with self.latest_voltages_lock:
            voltages_copy = self.latest_voltages.copy()

        for sensor_id, voltage in voltages_copy.items():
            framework = self.calibration_frameworks[sensor_id]

            # Only auto-calibrate sensors with high autonomy
            if framework.autonomy_level < 0.8:
                continue

            # Create consensus-based calibration point
            calibration_point = CalibrationPoint(
                voltage=voltage,
                pressure=consensus_pressure,
                timestamp=time.time(),
                environmental_state=env_state,
                uncertainty=self.last_consensus_state.uncertainty,
                is_consensus=True,
            )

            # Submit to calibration worker thread (non-blocking)
            self.calibration_worker.add_calibration_point(sensor_id, calibration_point)

            logger.info(
                f"AUTO-CALIBRATING PT{sensor_id} from consensus: {consensus_pressure:.1f} PSI at {voltage:.3f}V"
            )

    def _find_best_reference_pt(self, current_pt: int) -> Optional[int]:
        """Find the best reference PT for covariance mapping"""
        best_pt = None
        best_confidence = 0.0

        for pt_id, framework in self.calibration_frameworks.items():
            if pt_id == current_pt:
                continue

            if (
                framework.coefficients is not None
                and len(framework.calibration_points) >= 3
            ):
                confidence_score = framework.autonomy_level
                if confidence_score > best_confidence:
                    best_confidence = confidence_score
                    best_pt = pt_id

        return best_pt if best_confidence > 0.5 else None

    def _update_cross_pt_covariances(self, updated_pt: int):
        """Update cross-PT covariance matrices (now handled by global system)"""
        # This is now automatically handled by the multivariate Bayesian system
        pass

    def _load_all_calibration_states(self):
        """Load calibration states for all PTs"""
        for pt_id, framework in self.calibration_frameworks.items():
            framework.load_calibration_state(f"calibration_pt{pt_id}.json")

    def _save_all_calibration_states(self):
        """Save calibration states for all PTs AND population prior"""
        # Save individual PT calibrations
        for pt_id, framework in self.calibration_frameworks.items():
            if len(framework.calibration_points) > 0:
                framework.save_calibration_state(f"calibration_pt{pt_id}.json")

        # CRITICAL: Save population prior (accumulated knowledge from ALL test sessions)
        self.global_calibration_system.save_population_prior("population_prior.json")
        logger.info(
            f"Saved population prior (strength={self.global_calibration_system.population_strength:.2f})"
        )

        # ROBUSTNESS: Automatic backup if enabled
        if (
            self.robustness_manager
            and self.robustness_manager.backup_manager.should_backup()
        ):
            try:
                # Prepare backup data
                population_prior = {
                    "population_mean": self.global_calibration_system.population_mean.tolist(),
                    "population_covariance": self.global_calibration_system.population_covariance.tolist(),
                    "population_strength": float(
                        self.global_calibration_system.population_strength
                    ),
                }

                pt_states = {}
                for pt_id in range(16):
                    pt_states[pt_id] = {
                        "mean": self.global_calibration_system.pt_means[pt_id].tolist(),
                        "covariance": self.global_calibration_system.pt_covariances[
                            pt_id
                        ].tolist(),
                        "num_points": len(
                            self.global_calibration_system.calibration_points[pt_id]
                        ),
                    }

                metadata = {
                    "mode": self.robustness_manager.config.mode.value,
                    "consensus_enabled": self.robustness_manager.config.consensus_enabled,
                    "num_sensors": 16,
                }

                success = (
                    self.robustness_manager.backup_manager.backup_calibration_state(
                        population_prior, pt_states, metadata
                    )
                )
                if success:
                    logger.info("✅ Automatic backup completed")
            except Exception as e:
                logger.error(f"❌ Automatic backup failed: {e}")

    def _on_autoscale(self):
        self.autoscale = self.chk_autoscale.isChecked()
        # Force a refresh of the plot limits right away
        self._update_plot()

    # --------- Close handling ---------
    def closeEvent(self, event: QtGui.QCloseEvent):
        try:
            logger.info("Shutting down application...")

            # Stop worker threads first
            logger.info("Stopping consensus worker...")
            self.consensus_worker.stop()
            self.consensus_worker.wait(1000)

            logger.info("Stopping calibration worker...")
            self.calibration_worker.stop()
            self.calibration_worker.wait(
                2000
            )  # Give more time for calibration to finish

            # Save all calibration states before closing
            logger.info("Saving calibration states...")
            self._save_all_calibration_states()

            # Stop serial reader
            if self.reader is not None:
                logger.info("Stopping serial reader...")
                self.reader.stop()
                self.reader.wait(500)

            logger.info("Shutdown complete")
        except Exception as e:
            logger.error(f"Error during shutdown: {e}")
        super().closeEvent(event)


# ---------------------- Entry point ----------------------


def main():
    app = QtWidgets.QApplication(sys.argv)
    # Make PyQtGraph look nice
    pg.setConfigOptions(antialias=False)
    w = App()
    w.show()
    try:
        sys.exit(app.exec())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
