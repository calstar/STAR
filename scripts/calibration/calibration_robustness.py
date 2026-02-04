#!/usr/bin/env python3
"""
Calibration Robustness Module
Provides mission-critical robustness features for the pressure transducer calibration system.

Features:
- Automatic backup and recovery
- Flight mode vs test mode control
- Comprehensive validation and sanity checks
- Health monitoring and diagnostics
- Anomaly detection and automatic recovery
- Redundancy and fallback mechanisms
"""

import os
import json
import time
import shutil
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass, asdict
from enum import Enum
from collections import deque
import numpy as np

logger = logging.getLogger(__name__)

# ===========================================================================================
# CONFIGURATION MANAGEMENT
# ===========================================================================================


class OperationMode(Enum):
    """System operation modes"""

    TEST = "test"  # Ground testing - consensus enabled, all features active
    CALIBRATION = "calibration"  # Calibration mode - similar to test
    FLIGHT = "flight"  # Flight/mission mode - consensus disabled, independent readings
    SAFE = "safe"  # Safe mode - basic functionality only


@dataclass
class SystemConfig:
    """Mission-critical system configuration"""

    mode: OperationMode = OperationMode.TEST
    consensus_enabled: bool = True
    auto_backup_enabled: bool = True
    backup_interval_seconds: float = 60.0
    max_backup_files: int = 10
    validation_enabled: bool = True
    health_monitoring_enabled: bool = True
    anomaly_detection_enabled: bool = True
    num_sensors: int = 16
    model_order: int = 8  # 9 parameters (0-8)
    max_voltage: float = 10.0
    min_voltage: float = 0.0
    max_pressure: float = 1500.0  # PSI
    min_pressure: float = -50.0  # PSI (allow slight negative for validation)
    max_uncertainty: float = 500.0  # PSI
    consensus_agreement_threshold: float = 0.6
    min_sensors_for_consensus: int = 2
    backup_directory: str = "./calibration_backups"
    log_directory: str = "./calibration_logs"

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization"""
        d = asdict(self)
        d["mode"] = self.mode.value
        return d

    @classmethod
    def from_dict(cls, d: Dict) -> "SystemConfig":
        """Load from dictionary"""
        if "mode" in d and isinstance(d["mode"], str):
            d["mode"] = OperationMode(d["mode"])
        return cls(**d)

    def save(self, filepath: str = "system_config.json"):
        """Save configuration to file"""
        with open(filepath, "w") as f:
            json.dump(self.to_dict(), f, indent=2)
        logger.info(f"System configuration saved to {filepath}")

    @classmethod
    def load(cls, filepath: str = "system_config.json") -> "SystemConfig":
        """Load configuration from file"""
        if not os.path.exists(filepath):
            logger.warning(f"Config file {filepath} not found, using defaults")
            return cls()
        try:
            with open(filepath, "r") as f:
                data = json.load(f)
            config = cls.from_dict(data)
            logger.info(
                f"System configuration loaded from {filepath}: mode={config.mode.value}"
            )
            return config
        except Exception as e:
            logger.error(f"Failed to load config from {filepath}: {e}, using defaults")
            return cls()


# ===========================================================================================
# BACKUP AND RECOVERY SYSTEM
# ===========================================================================================


class BackupManager:
    """Automatic backup and recovery for calibration data"""

    def __init__(self, config: SystemConfig):
        self.config = config
        self.backup_dir = Path(config.backup_directory)
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.last_backup_time = 0.0
        self._backup_lock = threading.Lock()
        logger.info(f"Backup manager initialized: {self.backup_dir}")

    def should_backup(self) -> bool:
        """Check if it's time for automatic backup"""
        if not self.config.auto_backup_enabled:
            return False
        return (
            time.time() - self.last_backup_time
        ) >= self.config.backup_interval_seconds

    def backup_calibration_state(
        self,
        population_prior: Dict,
        pt_states: Dict[int, Dict],
        metadata: Optional[Dict] = None,
    ) -> bool:
        """
        Backup complete calibration state

        Args:
            population_prior: Population prior data (mean, covariance, strength)
            pt_states: Per-PT calibration states
            metadata: Optional metadata (timestamp, mode, etc.)

        Returns:
            True if backup successful
        """
        with self._backup_lock:
            try:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                backup_file = self.backup_dir / f"calibration_backup_{timestamp}.json"

                backup_data = {
                    "timestamp": time.time(),
                    "datetime": timestamp,
                    "mode": self.config.mode.value,
                    "population_prior": population_prior,
                    "pt_states": pt_states,
                    "metadata": metadata or {},
                }

                # Write to temporary file first, then rename (atomic)
                temp_file = backup_file.with_suffix(".tmp")
                with open(temp_file, "w") as f:
                    json.dump(backup_data, f, indent=2, default=self._json_serializer)
                temp_file.rename(backup_file)

                self.last_backup_time = time.time()
                logger.info(f"✅ Calibration backup saved: {backup_file}")

                # Cleanup old backups
                self._cleanup_old_backups()

                return True
            except Exception as e:
                logger.error(f"❌ Backup failed: {e}")
                return False

    def _json_serializer(self, obj):
        """Custom JSON serializer for numpy arrays"""
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        raise TypeError(f"Object of type {type(obj)} is not JSON serializable")

    def _cleanup_old_backups(self):
        """Keep only the most recent N backup files"""
        try:
            backup_files = sorted(self.backup_dir.glob("calibration_backup_*.json"))
            if len(backup_files) > self.config.max_backup_files:
                files_to_delete = backup_files[: -self.config.max_backup_files]
                for f in files_to_delete:
                    f.unlink()
                    logger.info(f"Deleted old backup: {f}")
        except Exception as e:
            logger.error(f"Backup cleanup failed: {e}")

    def list_backups(self) -> List[Tuple[Path, float]]:
        """List available backups with timestamps"""
        backups = []
        for backup_file in sorted(self.backup_dir.glob("calibration_backup_*.json")):
            try:
                with open(backup_file, "r") as f:
                    data = json.load(f)
                timestamp = data.get("timestamp", 0.0)
                backups.append((backup_file, timestamp))
            except:
                continue
        return sorted(backups, key=lambda x: x[1], reverse=True)

    def restore_latest_backup(self) -> Optional[Dict]:
        """Restore from the most recent backup"""
        backups = self.list_backups()
        if not backups:
            logger.warning("No backups available for restore")
            return None

        latest_backup, _ = backups[0]
        return self.restore_from_backup(latest_backup)

    def restore_from_backup(self, backup_file: Path) -> Optional[Dict]:
        """
        Restore calibration state from backup

        Returns:
            Backup data dictionary or None if failed
        """
        try:
            with open(backup_file, "r") as f:
                data = json.load(f)

            # Convert lists back to numpy arrays
            if "population_prior" in data:
                pp = data["population_prior"]
                if "population_mean" in pp and isinstance(pp["population_mean"], list):
                    pp["population_mean"] = np.array(pp["population_mean"])
                if "population_covariance" in pp and isinstance(
                    pp["population_covariance"], list
                ):
                    pp["population_covariance"] = np.array(pp["population_covariance"])

            logger.info(f"✅ Restored calibration from backup: {backup_file}")
            return data
        except Exception as e:
            logger.error(f"❌ Restore failed: {e}")
            return None


# ===========================================================================================
# VALIDATION AND SANITY CHECKS
# ===========================================================================================


class ValidationResult:
    """Result of a validation check"""

    def __init__(self, valid: bool, message: str = "", severity: str = "info"):
        self.valid = valid
        self.message = message
        self.severity = severity  # info, warning, error, critical

    def __bool__(self):
        return self.valid


class CalibrationValidator:
    """Comprehensive validation and sanity checks"""

    def __init__(self, config: SystemConfig):
        self.config = config

    def validate_voltage(self, voltage: float, sensor_id: int) -> ValidationResult:
        """Validate voltage reading"""
        if not self.config.validation_enabled:
            return ValidationResult(True)

        if not np.isfinite(voltage):
            return ValidationResult(
                False, f"PT{sensor_id}: Non-finite voltage {voltage}", "error"
            )

        if voltage < self.config.min_voltage or voltage > self.config.max_voltage:
            return ValidationResult(
                False,
                f"PT{sensor_id}: Voltage {voltage:.3f}V out of range [{self.config.min_voltage}, {self.config.max_voltage}]",
                "warning",
            )

        return ValidationResult(True)

    def validate_pressure(self, pressure: float, sensor_id: int) -> ValidationResult:
        """Validate pressure reading"""
        if not self.config.validation_enabled:
            return ValidationResult(True)

        if not np.isfinite(pressure):
            return ValidationResult(
                False, f"PT{sensor_id}: Non-finite pressure {pressure}", "error"
            )

        if pressure < self.config.min_pressure or pressure > self.config.max_pressure:
            return ValidationResult(
                False,
                f"PT{sensor_id}: Pressure {pressure:.1f} PSI out of range [{self.config.min_pressure}, {self.config.max_pressure}]",
                "warning",
            )

        return ValidationResult(True)

    def validate_uncertainty(
        self, uncertainty: float, sensor_id: int
    ) -> ValidationResult:
        """Validate uncertainty value"""
        if not self.config.validation_enabled:
            return ValidationResult(True)

        if not np.isfinite(uncertainty) or uncertainty < 0:
            return ValidationResult(
                False, f"PT{sensor_id}: Invalid uncertainty {uncertainty}", "error"
            )

        if uncertainty > self.config.max_uncertainty:
            return ValidationResult(
                False,
                f"PT{sensor_id}: Uncertainty {uncertainty:.1f} PSI exceeds maximum {self.config.max_uncertainty}",
                "warning",
            )

        return ValidationResult(True)

    def validate_calibration_coefficients(
        self, coefficients: np.ndarray, sensor_id: int
    ) -> ValidationResult:
        """Validate calibration coefficients"""
        if not self.config.validation_enabled:
            return ValidationResult(True)

        if coefficients is None:
            return ValidationResult(
                False, f"PT{sensor_id}: Coefficients are None", "error"
            )

        expected_size = self.config.model_order + 1
        if len(coefficients) != expected_size:
            return ValidationResult(
                False,
                f"PT{sensor_id}: Expected {expected_size} coefficients, got {len(coefficients)}",
                "critical",
            )

        if not np.all(np.isfinite(coefficients)):
            return ValidationResult(
                False, f"PT{sensor_id}: Non-finite coefficients", "error"
            )

        # Sanity check: linear coefficient (slope) should be reasonable
        # For 0-5V, 0-1000 PSI transducer: slope ~ 200 PSI/V
        linear_coeff = coefficients[1] if len(coefficients) > 1 else 0
        if abs(linear_coeff) > 1000.0:  # Sanity check
            return ValidationResult(
                False,
                f"PT{sensor_id}: Linear coefficient {linear_coeff:.1f} seems unreasonable",
                "warning",
            )

        return ValidationResult(True)

    def validate_covariance_matrix(
        self, covariance: np.ndarray, sensor_id: int
    ) -> ValidationResult:
        """Validate covariance matrix"""
        if not self.config.validation_enabled:
            return ValidationResult(True)

        if covariance is None:
            return ValidationResult(
                False, f"PT{sensor_id}: Covariance is None", "error"
            )

        expected_shape = (self.config.model_order + 1, self.config.model_order + 1)
        if covariance.shape != expected_shape:
            return ValidationResult(
                False,
                f"PT{sensor_id}: Expected covariance shape {expected_shape}, got {covariance.shape}",
                "critical",
            )

        if not np.all(np.isfinite(covariance)):
            return ValidationResult(
                False, f"PT{sensor_id}: Non-finite covariance", "error"
            )

        # Check positive definiteness (all eigenvalues > 0)
        try:
            eigenvalues = np.linalg.eigvalsh(covariance)
            if np.any(eigenvalues <= 0):
                return ValidationResult(
                    False,
                    f"PT{sensor_id}: Covariance not positive definite (min eigenvalue: {np.min(eigenvalues)})",
                    "error",
                )
        except np.linalg.LinAlgError:
            return ValidationResult(
                False, f"PT{sensor_id}: Covariance matrix computation failed", "error"
            )

        return ValidationResult(True)

    def validate_consensus_state(
        self, consensus_pressure: float, agreement_score: float, num_sensors: int
    ) -> ValidationResult:
        """Validate consensus state"""
        if not self.config.validation_enabled:
            return ValidationResult(True)

        if not np.isfinite(consensus_pressure):
            return ValidationResult(False, "Consensus pressure is non-finite", "error")

        if not (0 <= agreement_score <= 1):
            return ValidationResult(
                False, f"Agreement score {agreement_score} out of [0,1]", "warning"
            )

        if num_sensors < self.config.min_sensors_for_consensus:
            return ValidationResult(
                False,
                f"Only {num_sensors} sensors participating, need {self.config.min_sensors_for_consensus}",
                "warning",
            )

        if agreement_score < self.config.consensus_agreement_threshold:
            return ValidationResult(
                False,
                f"Agreement score {agreement_score:.3f} below threshold {self.config.consensus_agreement_threshold}",
                "warning",
            )

        return ValidationResult(True)


# ===========================================================================================
# HEALTH MONITORING AND DIAGNOSTICS
# ===========================================================================================


@dataclass
class HealthMetrics:
    """System health metrics"""

    timestamp: float
    mode: OperationMode
    active_sensors: int
    calibrated_sensors: int
    consensus_confidence: float
    average_uncertainty: float
    max_uncertainty: float
    drift_detected_count: int
    validation_errors: int
    backup_status: str
    uptime_seconds: float


class HealthMonitor:
    """Real-time health monitoring and diagnostics"""

    def __init__(self, config: SystemConfig):
        self.config = config
        self.start_time = time.time()
        self.metrics_history: List[HealthMetrics] = []
        self.validation_errors = 0
        self.warning_count = 0
        self.error_count = 0
        self._metrics_lock = threading.Lock()

        # Create log directory
        log_dir = Path(config.log_directory)
        log_dir.mkdir(parents=True, exist_ok=True)

        # Setup file logging
        log_file = log_dir / f"health_log_{datetime.now().strftime('%Y%m%d')}.log"
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(logging.INFO)
        formatter = logging.Formatter(
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

        logger.info(f"Health monitor initialized: {log_file}")

    def record_metrics(self, metrics: HealthMetrics):
        """Record health metrics"""
        with self._metrics_lock:
            self.metrics_history.append(metrics)
            # Keep only last 1000 metrics
            if len(self.metrics_history) > 1000:
                self.metrics_history = self.metrics_history[-1000:]

    def get_current_status(self) -> Dict[str, Any]:
        """Get current system status"""
        with self._metrics_lock:
            if not self.metrics_history:
                return {"status": "no_data"}

            latest = self.metrics_history[-1]
            return {
                "status": "healthy" if self.is_healthy() else "degraded",
                "mode": latest.mode.value,
                "active_sensors": latest.active_sensors,
                "calibrated_sensors": latest.calibrated_sensors,
                "consensus_confidence": latest.consensus_confidence,
                "average_uncertainty": latest.average_uncertainty,
                "max_uncertainty": latest.max_uncertainty,
                "drift_detected": latest.drift_detected_count,
                "validation_errors": self.validation_errors,
                "warnings": self.warning_count,
                "errors": self.error_count,
                "uptime_seconds": time.time() - self.start_time,
            }

    def is_healthy(self) -> bool:
        """Check if system is healthy"""
        if not self.metrics_history:
            return False

        latest = self.metrics_history[-1]

        # Critical checks
        if latest.calibrated_sensors == 0:
            return False

        if latest.mode == OperationMode.FLIGHT and latest.consensus_confidence < 0.5:
            logger.warning("Low consensus confidence in flight mode")
            return False

        if latest.max_uncertainty > self.config.max_uncertainty:
            logger.warning(
                f"Maximum uncertainty {latest.max_uncertainty} exceeds limit"
            )
            return False

        if self.error_count > 10:  # More than 10 errors
            logger.error("Too many errors detected")
            return False

        return True

    def log_validation_error(self, result: ValidationResult):
        """Log validation error"""
        self.validation_errors += 1
        if result.severity == "warning":
            self.warning_count += 1
            logger.warning(result.message)
        elif result.severity in ("error", "critical"):
            self.error_count += 1
            logger.error(result.message)

    def get_diagnostics_report(self) -> str:
        """Generate comprehensive diagnostics report"""
        status = self.get_current_status()

        report = [
            "=" * 80,
            "CALIBRATION SYSTEM DIAGNOSTICS REPORT",
            "=" * 80,
            f"Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"Mode: {status['mode']}",
            f"Status: {status['status'].upper()}",
            f"Uptime: {status['uptime_seconds']:.1f} seconds",
            "",
            "SENSORS:",
            f"  Active: {status['active_sensors']}/{self.config.num_sensors}",
            f"  Calibrated: {status['calibrated_sensors']}/{self.config.num_sensors}",
            "",
            "CALIBRATION QUALITY:",
            f"  Average Uncertainty: {status['average_uncertainty']:.2f} PSI",
            f"  Maximum Uncertainty: {status['max_uncertainty']:.2f} PSI",
            f"  Consensus Confidence: {status['consensus_confidence']:.3f}",
            "",
            "ERRORS AND WARNINGS:",
            f"  Validation Errors: {status['validation_errors']}",
            f"  Warnings: {status['warnings']}",
            f"  Errors: {status['errors']}",
            f"  Drift Detected: {status['drift_detected']} sensors",
            "",
            "=" * 80,
        ]

        return "\n".join(report)


# ===========================================================================================
# ANOMALY DETECTION
# ===========================================================================================


class AnomalyDetector:
    """Detect anomalies in calibration and sensor readings"""

    def __init__(self, config: SystemConfig):
        self.config = config
        self.voltage_history: Dict[int, deque] = {
            i: deque(maxlen=100) for i in range(config.num_sensors)
        }
        self.pressure_history: Dict[int, deque] = {
            i: deque(maxlen=100) for i in range(config.num_sensors)
        }
        self.anomaly_counts: Dict[int, int] = {i: 0 for i in range(config.num_sensors)}

    def detect_voltage_anomaly(self, sensor_id: int, voltage: float) -> bool:
        """Detect voltage anomaly using statistical methods"""
        if sensor_id not in self.voltage_history:
            return False

        history = self.voltage_history[sensor_id]
        history.append(voltage)

        if len(history) < 10:  # Need some history
            return False

        # Simple outlier detection: > 3 sigma from mean
        mean = np.mean(history)
        std = np.std(history)

        if std < 1e-6:  # No variation
            return False

        z_score = abs((voltage - mean) / std)
        if z_score > 3.0:
            self.anomaly_counts[sensor_id] += 1
            logger.warning(
                f"PT{sensor_id} voltage anomaly: {voltage:.3f}V (z-score: {z_score:.2f})"
            )
            return True

        return False

    def detect_pressure_anomaly(self, sensor_id: int, pressure: float) -> bool:
        """Detect pressure anomaly"""
        if sensor_id not in self.pressure_history:
            return False

        history = self.pressure_history[sensor_id]
        history.append(pressure)

        if len(history) < 10:
            return False

        # Check for rapid changes (rate limit)
        if len(history) >= 2:
            rate_of_change = abs(pressure - history[-2])
            if rate_of_change > 100.0:  # > 100 PSI change in one sample
                logger.warning(
                    f"PT{sensor_id} rapid pressure change: {rate_of_change:.1f} PSI/sample"
                )
                return True

        return False

    def get_anomaly_report(self) -> Dict[int, int]:
        """Get anomaly counts per sensor"""
        return self.anomaly_counts.copy()


# ===========================================================================================
# MAIN ROBUSTNESS MANAGER
# ===========================================================================================


class RobustnessManager:
    """
    Main robustness manager integrating all features.

    Usage:
        config = SystemConfig.load()
        manager = RobustnessManager(config)

        # Check if backup needed
        if manager.backup_manager.should_backup():
            manager.backup_calibration_state(...)

        # Validate readings
        result = manager.validator.validate_voltage(voltage, sensor_id)
        if not result:
            manager.health_monitor.log_validation_error(result)

        # Get diagnostics
        print(manager.health_monitor.get_diagnostics_report())
    """

    def __init__(self, config: Optional[SystemConfig] = None):
        self.config = config or SystemConfig.load()
        self.config.save()  # Save for future reference

        self.backup_manager = BackupManager(self.config)
        self.validator = CalibrationValidator(self.config)
        self.health_monitor = HealthMonitor(self.config)
        self.anomaly_detector = AnomalyDetector(self.config)

        logger.info(
            f"🛡️  Robustness Manager initialized: mode={self.config.mode.value}, "
            f"consensus={self.config.consensus_enabled}, validation={self.config.validation_enabled}"
        )

    def set_mode(self, mode: OperationMode):
        """Change operation mode"""
        old_mode = self.config.mode
        self.config.mode = mode

        # Update consensus based on mode
        if mode == OperationMode.FLIGHT:
            self.config.consensus_enabled = False
            logger.warning(
                "⚠️  FLIGHT MODE: Consensus disabled, measurements are independent"
            )
        elif mode in (OperationMode.TEST, OperationMode.CALIBRATION):
            self.config.consensus_enabled = True
            logger.info(f"✅ {mode.value.upper()} MODE: Consensus enabled")

        self.config.save()
        logger.info(f"Mode changed: {old_mode.value} → {mode.value}")

    def emergency_backup(self, data: Dict) -> bool:
        """Emergency backup (ignore interval)"""
        return self.backup_manager.backup_calibration_state(
            population_prior=data.get("population_prior", {}),
            pt_states=data.get("pt_states", {}),
            metadata={"emergency": True},
        )

    def auto_recover(self) -> Optional[Dict]:
        """Automatic recovery from latest backup"""
        logger.warning("🚨 Attempting automatic recovery...")
        data = self.backup_manager.restore_latest_backup()
        if data:
            logger.info("✅ Recovery successful")
        else:
            logger.error("❌ Recovery failed")
        return data


if __name__ == "__main__":
    # Demo usage
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
    )

    # Create configuration
    config = SystemConfig()
    config.mode = OperationMode.TEST
    config.save()

    # Create manager
    manager = RobustnessManager(config)

    # Simulate some validations
    v_result = manager.validator.validate_voltage(2.5, 0)
    print(f"Voltage validation: {v_result.valid} - {v_result.message}")

    p_result = manager.validator.validate_pressure(500.0, 0)
    print(f"Pressure validation: {p_result.valid} - {p_result.message}")

    # Generate diagnostics
    print("\n" + manager.health_monitor.get_diagnostics_report())

    # Change to flight mode
    manager.set_mode(OperationMode.FLIGHT)
    print(f"\nConsensus enabled: {manager.config.consensus_enabled}")
