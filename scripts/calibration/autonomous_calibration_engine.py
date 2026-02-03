#!/usr/bin/env python3
"""
Autonomous Calibration Engine
Advanced self-learning calibration system that evolves priors based on system behavior.

Key Features:
- Online learning with recursive Bayesian updates
- Temporal evolution modeling with forgetting factors
- Active learning: System requests calibration when needed
- Drift detection and automatic adaptation
- Empirical Bayes for continuous prior improvement
- Confidence-based autonomous decision making
- Transfer learning across sensors and sessions
"""

import numpy as np
import logging
from typing import Dict, List, Tuple, Optional, Callable
from dataclasses import dataclass, field
from collections import deque
import time
from scipy.stats import chi2, norm
from scipy.linalg import cho_factor, cho_solve

logger = logging.getLogger(__name__)

# ===========================================================================================
# TEMPORAL EVOLUTION AND ADAPTATION
# ===========================================================================================

@dataclass
class TemporalState:
    """State of system evolution over time"""
    timestamp: float
    parameters: np.ndarray  # Current parameter estimate
    covariance: np.ndarray  # Current uncertainty
    confidence: float  # System confidence in current state
    drift_rate: float  # Estimated rate of parameter drift
    quality_score: float  # Quality of recent predictions
    
@dataclass
class CalibrationRequest:
    """Autonomous calibration request from the system"""
    sensor_id: int
    voltage: float
    reason: str  # Why calibration is needed
    urgency: float  # 0-1, how urgent
    suggested_pressure_range: Tuple[float, float]  # Expected pressure range
    confidence: float  # Current prediction confidence

class AdaptivePriorEvolution:
    """
    Evolves population prior based on ongoing system performance.
    Uses empirical Bayes to continuously improve prior from all sensors.
    """
    
    def __init__(self, n_params: int, forgetting_factor: float = 0.995):
        self.n_params = n_params
        self.forgetting_factor = forgetting_factor  # Decay old information
        
        # Initialize with weakly informative prior
        self.prior_mean = np.zeros(n_params)
        self.prior_mean[1] = 200.0  # Linear term
        self.prior_covariance = np.diag([10000.0, 100000.0] + [10000.0] * (n_params - 2))
        
        # Empirical Bayes statistics
        self.sensor_posteriors: Dict[int, Tuple[np.ndarray, np.ndarray]] = {}
        self.update_count = 0
        self.effective_sample_size = 1.0  # Starts low, grows with data
        
        # Temporal evolution
        self.history: deque = deque(maxlen=100)
        self.drift_detector = DriftDetector(n_params)
        
        logger.info(f"Adaptive prior evolution initialized: n_params={n_params}, λ={forgetting_factor}")
    
    def update_from_sensor(self, sensor_id: int, posterior_mean: np.ndarray, 
                           posterior_cov: np.ndarray, quality: float):
        """
        Update population prior from individual sensor posterior.
        Uses empirical Bayes: prior is the mean of all sensor posteriors.
        """
        # Apply forgetting factor to existing data
        self.effective_sample_size *= self.forgetting_factor
        self.effective_sample_size += quality  # Add new sample weighted by quality
        
        # Store sensor posterior
        self.sensor_posteriors[sensor_id] = (posterior_mean.copy(), posterior_cov.copy())
        
        # Empirical Bayes update: Pool all sensor posteriors
        if len(self.sensor_posteriors) >= 2:
            self._empirical_bayes_update()
        
        self.update_count += 1
        
        # Record history
        self.history.append(TemporalState(
            timestamp=time.time(),
            parameters=self.prior_mean.copy(),
            covariance=self.prior_covariance.copy(),
            confidence=self._compute_confidence(),
            drift_rate=self.drift_detector.estimate_drift_rate(),
            quality_score=quality
        ))
        
        if self.update_count % 10 == 0:
            logger.info(f"Prior evolution: {len(self.sensor_posteriors)} sensors, "
                       f"ESS={self.effective_sample_size:.1f}, "
                       f"confidence={self._compute_confidence():.3f}")
    
    def _empirical_bayes_update(self):
        """
        Empirical Bayes: Estimate population prior from sensor posteriors.
        
        Model: θⱼ ~ N(μ_pop, Σ_pop)  (sensors drawn from population)
        
        Estimate μ_pop = mean(θⱼ) and Σ_pop = var(θⱼ) + mean(Σⱼ)
        """
        posteriors = list(self.sensor_posteriors.values())
        means = np.array([m for m, _ in posteriors])
        covs = np.array([c for _, c in posteriors])
        
        # Between-sensor variance (how much sensors differ)
        between_var = np.cov(means.T)
        
        # Within-sensor variance (average uncertainty)
        within_var = np.mean(covs, axis=0)
        
        # Total population variance
        # Shrink towards diagonal for numerical stability
        pop_var = between_var + within_var
        pop_var = 0.8 * pop_var + 0.2 * np.diag(np.diag(pop_var))
        
        # Population mean (weighted by inverse variance)
        weights = []
        for _, cov in posteriors:
            try:
                # Weight by precision (inverse covariance)
                prec = np.linalg.inv(cov + 1e-6 * np.eye(self.n_params))
                weights.append(np.trace(prec))
            except:
                weights.append(1.0)
        
        weights = np.array(weights)
        weights /= np.sum(weights)
        
        pop_mean = np.sum(means.T * weights, axis=1)
        
        # Apply forgetting: blend old prior with new estimate
        blend = 1.0 / (1.0 + self.effective_sample_size)
        self.prior_mean = (1 - blend) * self.prior_mean + blend * pop_mean
        self.prior_covariance = (1 - blend) * self.prior_covariance + blend * pop_var
        
        # Regularization for numerical stability
        self.prior_covariance += 1e-6 * np.eye(self.n_params)
        
        logger.debug(f"Empirical Bayes update: blend={blend:.3f}, "
                    f"mean_shift={np.linalg.norm(pop_mean - self.prior_mean):.2e}")
    
    def _compute_confidence(self) -> float:
        """Compute confidence in current prior"""
        # Confidence grows with effective sample size and decreases with uncertainty
        ess_factor = np.tanh(self.effective_sample_size / 10.0)  # Saturates at ~10 samples
        
        # Uncertainty factor: lower variance = higher confidence
        try:
            trace = np.trace(self.prior_covariance)
            uncertainty_factor = 1.0 / (1.0 + trace / 1e6)
        except:
            uncertainty_factor = 0.1
        
        confidence = 0.7 * ess_factor + 0.3 * uncertainty_factor
        return float(np.clip(confidence, 0, 1))
    
    def get_prior(self) -> Tuple[np.ndarray, np.ndarray, float]:
        """Get current prior (mean, covariance, confidence)"""
        return self.prior_mean.copy(), self.prior_covariance.copy(), self._compute_confidence()
    
    def predict_future_drift(self, time_horizon: float) -> Tuple[np.ndarray, np.ndarray]:
        """
        Predict how parameters will drift over time horizon.
        
        Returns: (predicted_mean, predicted_covariance)
        """
        drift_rate = self.drift_detector.estimate_drift_rate()
        
        # Drift increases uncertainty
        drift_variance = (drift_rate * time_horizon) ** 2 * np.eye(self.n_params)
        
        # Mean stays the same (unbiased drift), covariance increases
        predicted_mean = self.prior_mean.copy()
        predicted_cov = self.prior_covariance + drift_variance
        
        return predicted_mean, predicted_cov

class DriftDetector:
    """Detect and quantify parameter drift over time"""
    
    def __init__(self, n_params: int, window_size: int = 50):
        self.n_params = n_params
        self.window_size = window_size
        self.parameter_history: deque = deque(maxlen=window_size)
        self.timestamp_history: deque = deque(maxlen=window_size)
        
    def add_observation(self, parameters: np.ndarray, timestamp: float):
        """Add parameter observation"""
        self.parameter_history.append(parameters.copy())
        self.timestamp_history.append(timestamp)
    
    def estimate_drift_rate(self) -> float:
        """
        Estimate rate of parameter drift (norm of change per second).
        
        Returns: drift_rate in parameter units per second
        """
        if len(self.parameter_history) < 2:
            return 0.0
        
        params = np.array(list(self.parameter_history))
        times = np.array(list(self.timestamp_history))
        
        # Compute rate of change via finite differences
        dparams = np.diff(params, axis=0)
        dtimes = np.diff(times)
        
        # Avoid division by zero
        dtimes = np.maximum(dtimes, 1e-6)
        
        # Rate of change (per second)
        rates = np.linalg.norm(dparams, axis=1) / dtimes
        
        # Robust estimate: median rate
        drift_rate = float(np.median(rates))
        
        return drift_rate
    
    def detect_abrupt_change(self, threshold: float = 3.0) -> bool:
        """Detect abrupt parameter change (e.g., harness swap)"""
        if len(self.parameter_history) < 10:
            return False
        
        params = np.array(list(self.parameter_history))
        
        # Recent mean vs historical mean
        recent_mean = np.mean(params[-5:], axis=0)
        historical_mean = np.mean(params[:-5], axis=0)
        
        # Difference normalized by standard deviation
        std = np.std(params, axis=0) + 1e-6
        normalized_diff = np.linalg.norm((recent_mean - historical_mean) / std)
        
        return normalized_diff > threshold

# ===========================================================================================
# ACTIVE LEARNING: SYSTEM REQUESTS CALIBRATION
# ===========================================================================================

class ActiveLearningAgent:
    """
    Intelligent agent that decides when and where calibration is needed.
    Uses uncertainty sampling and query-by-committee strategies.
    """
    
    def __init__(self, n_sensors: int, n_params: int):
        self.n_sensors = n_sensors
        self.n_params = n_params
        
        # Track when each sensor was last calibrated
        self.last_calibration_time: Dict[int, float] = {}
        
        # Track prediction errors
        self.error_history: Dict[int, deque] = {i: deque(maxlen=50) for i in range(n_sensors)}
        
        # Calibration budget: How many calibrations can we request
        self.calibration_budget = 10  # Per hour
        self.last_budget_reset = time.time()
        self.requests_this_hour = 0
        
        logger.info(f"Active learning agent initialized: {n_sensors} sensors")
    
    def should_request_calibration(self, sensor_id: int, 
                                   prediction: float,
                                   uncertainty: float,
                                   voltage: float) -> Optional[CalibrationRequest]:
        """
        Decide if calibration should be requested for this sensor.
        
        Returns: CalibrationRequest if calibration needed, None otherwise
        """
        # Reset budget hourly
        if time.time() - self.last_budget_reset > 3600:
            self.requests_this_hour = 0
            self.last_budget_reset = time.time()
        
        # Check if budget exhausted
        if self.requests_this_hour >= self.calibration_budget:
            return None
        
        reasons = []
        urgency = 0.0
        
        # Reason 1: High uncertainty
        if uncertainty > 50.0:  # PSI
            reasons.append(f"high uncertainty ({uncertainty:.1f} PSI)")
            urgency = max(urgency, uncertainty / 100.0)
        
        # Reason 2: Extrapolation (voltage outside calibrated range)
        # This would need to be passed in, for now use heuristic
        if voltage < 0.5 or voltage > 9.5:
            reasons.append(f"extreme voltage ({voltage:.2f}V)")
            urgency = max(urgency, 0.8)
        
        # Reason 3: Long time since last calibration
        if sensor_id in self.last_calibration_time:
            time_since = time.time() - self.last_calibration_time[sensor_id]
            if time_since > 3600:  # 1 hour
                reasons.append(f"stale calibration ({time_since/3600:.1f}h)")
                urgency = max(urgency, min(0.5, time_since / 7200))
        else:
            reasons.append("never calibrated")
            urgency = max(urgency, 0.9)
        
        # Reason 4: Consistent prediction errors
        if len(self.error_history[sensor_id]) > 10:
            errors = list(self.error_history[sensor_id])
            mean_error = np.mean(np.abs(errors))
            if mean_error > 20.0:  # PSI
                reasons.append(f"high error rate ({mean_error:.1f} PSI)")
                urgency = max(urgency, min(0.7, mean_error / 50.0))
        
        # Make request if urgency is high enough
        if urgency > 0.5 and reasons:
            self.requests_this_hour += 1
            
            # Suggest pressure range based on prediction
            suggested_range = (
                max(0, prediction - 2 * uncertainty),
                prediction + 2 * uncertainty
            )
            
            return CalibrationRequest(
                sensor_id=sensor_id,
                voltage=voltage,
                reason="; ".join(reasons),
                urgency=float(urgency),
                suggested_pressure_range=suggested_range,
                confidence=1.0 - urgency
            )
        
        return None
    
    def record_calibration(self, sensor_id: int):
        """Record that sensor was calibrated"""
        self.last_calibration_time[sensor_id] = time.time()
    
    def record_prediction_error(self, sensor_id: int, error: float):
        """Record prediction error for learning"""
        if sensor_id < self.n_sensors:
            self.error_history[sensor_id].append(error)

# ===========================================================================================
# INTELLIGENT ONLINE LEARNING
# ===========================================================================================

class OnlineBayesianLearner:
    """
    Online Bayesian learning with recursive updates.
    Continuously improves calibration as new data arrives.
    """
    
    def __init__(self, sensor_id: int, prior_mean: np.ndarray, prior_cov: np.ndarray):
        self.sensor_id = sensor_id
        self.posterior_mean = prior_mean.copy()
        self.posterior_cov = prior_cov.copy()
        
        # Cholesky factorization for efficient updates
        try:
            self.chol_factor = cho_factor(prior_cov, lower=True)
        except:
            self.chol_factor = None
        
        # Track data for quality assessment
        self.n_observations = 0
        self.residual_history: deque = deque(maxlen=100)
        
    def recursive_update(self, design_vector: np.ndarray, 
                        observation: float,
                        observation_variance: float) -> Tuple[np.ndarray, np.ndarray]:
        """
        Recursive Bayesian update (Kalman filter form).
        
        Much more efficient than recomputing from scratch.
        
        Args:
            design_vector: φ(v, e) - basis functions
            observation: Measured pressure
            observation_variance: σ² - measurement uncertainty
        
        Returns: (updated_mean, updated_covariance)
        """
        # Innovation (prediction error)
        prediction = np.dot(design_vector, self.posterior_mean)
        innovation = observation - prediction
        
        # Innovation variance
        S = np.dot(design_vector, np.dot(self.posterior_cov, design_vector)) + observation_variance
        S = max(S, 1e-6)  # Numerical stability
        
        # Kalman gain
        K = np.dot(self.posterior_cov, design_vector) / S
        
        # Update
        self.posterior_mean = self.posterior_mean + K * innovation
        
        # Joseph form for numerical stability
        I_KH = np.eye(len(self.posterior_mean)) - np.outer(K, design_vector)
        self.posterior_cov = (
            np.dot(I_KH, np.dot(self.posterior_cov, I_KH.T)) +
            observation_variance * np.outer(K, K)
        )
        
        # Symmetrize
        self.posterior_cov = 0.5 * (self.posterior_cov + self.posterior_cov.T)
        
        # Record
        self.n_observations += 1
        self.residual_history.append(innovation / np.sqrt(S))  # Normalized residual
        
        # Update Cholesky factorization if possible
        try:
            self.chol_factor = cho_factor(self.posterior_cov, lower=True)
        except:
            self.chol_factor = None
        
        return self.posterior_mean.copy(), self.posterior_cov.copy()
    
    def predict_with_uncertainty(self, design_vector: np.ndarray) -> Tuple[float, float]:
        """Fast prediction with uncertainty"""
        mean = float(np.dot(design_vector, self.posterior_mean))
        variance = float(np.dot(design_vector, np.dot(self.posterior_cov, design_vector)))
        uncertainty = np.sqrt(max(variance, 0))
        return mean, uncertainty
    
    def compute_quality_score(self) -> float:
        """
        Compute calibration quality score (0-1).
        Based on normalized residuals and sample size.
        """
        if self.n_observations == 0:
            return 0.0
        
        # Sample size factor
        sample_factor = np.tanh(self.n_observations / 10.0)
        
        # Residual factor: Good calibration has residuals ~ N(0,1)
        if len(self.residual_history) > 0:
            residuals = np.array(list(self.residual_history))
            # Chi-squared test: sum of squared normalized residuals
            chi2_stat = np.sum(residuals ** 2)
            expected_chi2 = len(residuals)
            residual_factor = np.exp(-abs(chi2_stat - expected_chi2) / (2 * expected_chi2))
        else:
            residual_factor = 0.5
        
        quality = 0.6 * sample_factor + 0.4 * residual_factor
        return float(np.clip(quality, 0, 1))

# ===========================================================================================
# AUTONOMOUS CALIBRATION ENGINE
# ===========================================================================================

class AutonomousCalibrationEngine:
    """
    Main autonomous calibration engine integrating all components.
    
    Features:
    - Learns and evolves priors from all sensors
    - Requests calibration when needed
    - Adapts to drift and changes
    - Provides confidence-aware predictions
    """
    
    def __init__(self, n_sensors: int = 16, n_params: int = 9, forgetting_factor: float = 0.995):
        self.n_sensors = n_sensors
        self.n_params = n_params
        
        # Adaptive prior evolution
        self.prior_evolution = AdaptivePriorEvolution(n_params, forgetting_factor)
        
        # Active learning agent
        self.active_learner = ActiveLearningAgent(n_sensors, n_params)
        
        # Online learners for each sensor
        prior_mean, prior_cov, _ = self.prior_evolution.get_prior()
        self.online_learners: Dict[int, OnlineBayesianLearner] = {
            i: OnlineBayesianLearner(i, prior_mean, prior_cov) for i in range(n_sensors)
        }
        
        # Statistics
        self.total_calibrations = 0
        self.autonomous_requests = 0
        self.start_time = time.time()
        
        logger.info(f"🤖 Autonomous Calibration Engine initialized: "
                   f"{n_sensors} sensors, {n_params} parameters")
    
    def add_calibration_point(self, sensor_id: int, 
                              design_vector: np.ndarray,
                              pressure: float,
                              uncertainty: float = 0.05):
        """
        Add calibration point and update system.
        
        This is called when user provides a pressure reading.
        The system learns from this and improves its prior.
        """
        if sensor_id not in self.online_learners:
            logger.error(f"Invalid sensor_id: {sensor_id}")
            return
        
        # Online update for this sensor
        learner = self.online_learners[sensor_id]
        posterior_mean, posterior_cov = learner.recursive_update(
            design_vector, pressure, uncertainty ** 2
        )
        
        # Quality of this sensor's calibration
        quality = learner.compute_quality_score()
        
        # Update population prior from this sensor's posterior
        self.prior_evolution.update_from_sensor(
            sensor_id, posterior_mean, posterior_cov, quality
        )
        
        # Record calibration for active learning
        self.active_learner.record_calibration(sensor_id)
        
        self.total_calibrations += 1
        
        # Propagate improved prior to all sensors
        self._propagate_prior_to_sensors()
        
        logger.info(f"✅ PT{sensor_id} calibration added: quality={quality:.3f}, "
                   f"total_cal={self.total_calibrations}")
    
    def _propagate_prior_to_sensors(self):
        """
        Propagate improved population prior to all sensors.
        Each sensor blends global prior with its own data.
        """
        prior_mean, prior_cov, prior_confidence = self.prior_evolution.get_prior()
        
        for sensor_id, learner in self.online_learners.items():
            if learner.n_observations == 0:
                # No data: use pure prior
                learner.posterior_mean = prior_mean.copy()
                learner.posterior_cov = prior_cov.copy()
            else:
                # Has data: blend prior with posterior
                # More observations → less influence from prior
                blend = 1.0 / (1.0 + learner.n_observations / 5.0)
                learner.posterior_mean = (
                    (1 - blend) * learner.posterior_mean +
                    blend * prior_mean
                )
                # Covariance doesn't blend (stays as computed)
    
    def predict(self, sensor_id: int, design_vector: np.ndarray) -> Tuple[float, float, Optional[CalibrationRequest]]:
        """
        Predict pressure with uncertainty and possibly request calibration.
        
        Returns: (pressure, uncertainty, calibration_request)
        """
        if sensor_id not in self.online_learners:
            return 0.0, 1000.0, None
        
        learner = self.online_learners[sensor_id]
        pressure, uncertainty = learner.predict_with_uncertainty(design_vector)
        
        # Check if calibration should be requested
        voltage = design_vector[1]  # Assume linear term is voltage
        calibration_request = self.active_learner.should_request_calibration(
            sensor_id, pressure, uncertainty, voltage
        )
        
        return pressure, uncertainty, calibration_request
    
    def get_system_status(self) -> Dict:
        """Get comprehensive system status"""
        _, _, prior_confidence = self.prior_evolution.get_prior()
        
        # Sensor qualities
        sensor_qualities = {
            i: learner.compute_quality_score()
            for i, learner in self.online_learners.items()
        }
        
        avg_quality = np.mean(list(sensor_qualities.values()))
        
        # Drift info
        drift_rate = self.prior_evolution.drift_detector.estimate_drift_rate()
        
        uptime = time.time() - self.start_time
        
        return {
            'uptime_seconds': uptime,
            'total_calibrations': self.total_calibrations,
            'autonomous_requests': self.autonomous_requests,
            'prior_confidence': prior_confidence,
            'average_sensor_quality': avg_quality,
            'drift_rate': drift_rate,
            'effective_sample_size': self.prior_evolution.effective_sample_size,
            'sensor_qualities': sensor_qualities
        }
    
    def export_learned_prior(self) -> Dict:
        """Export learned prior for saving"""
        prior_mean, prior_cov, confidence = self.prior_evolution.get_prior()
        return {
            'prior_mean': prior_mean.tolist(),
            'prior_covariance': prior_cov.tolist(),
            'confidence': float(confidence),
            'effective_sample_size': float(self.prior_evolution.effective_sample_size),
            'update_count': self.prior_evolution.update_count
        }
    
    def import_learned_prior(self, data: Dict):
        """Import previously learned prior"""
        try:
            self.prior_evolution.prior_mean = np.array(data['prior_mean'])
            self.prior_evolution.prior_covariance = np.array(data['prior_covariance'])
            self.prior_evolution.effective_sample_size = float(data.get('effective_sample_size', 1.0))
            self.prior_evolution.update_count = int(data.get('update_count', 0))
            logger.info(f"✅ Imported learned prior: ESS={self.prior_evolution.effective_sample_size:.1f}")
        except Exception as e:
            logger.error(f"Failed to import learned prior: {e}")


if __name__ == "__main__":
    # Demo usage
    logging.basicConfig(level=logging.INFO, format='%(levelname)s - %(message)s')
    
    # Create engine
    engine = AutonomousCalibrationEngine(n_sensors=16, n_params=9)
    
    # Simulate calibration points
    for i in range(5):
        sensor_id = i % 16
        voltage = 2.5 + i * 0.5
        design_vector = np.array([1, voltage] + [0] * 7)  # Simplified
        pressure = 200 * voltage + np.random.normal(0, 1)
        
        engine.add_calibration_point(sensor_id, design_vector, pressure)
    
    # Make predictions
    for sensor_id in range(3):
        voltage = 3.0
        design_vector = np.array([1, voltage] + [0] * 7)
        p, u, req = engine.predict(sensor_id, design_vector)
        print(f"\nPT{sensor_id}: {p:.1f} ± {u:.1f} PSI")
        if req:
            print(f"  📝 Calibration requested: {req.reason} (urgency: {req.urgency:.2f})")
    
    # System status
    status = engine.get_system_status()
    print(f"\nSystem Status:")
    print(f"  Prior confidence: {status['prior_confidence']:.3f}")
    print(f"  Average quality: {status['average_sensor_quality']:.3f}")
    print(f"  Drift rate: {status['drift_rate']:.2e}")

