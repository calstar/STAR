#!/usr/bin/env python3
"""
Comprehensive Test Suite for Robustness System
Tests all validation, backup, health monitoring, and anomaly detection features.
"""

import sys
import os
import time
import numpy as np
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

try:
    from calibration_robustness import (
        RobustnessManager,
        SystemConfig,
        OperationMode,
        BackupManager,
        CalibrationValidator,
        HealthMonitor,
        AnomalyDetector,
        HealthMetrics,
    )
except ImportError as e:
    logger.error(f"Cannot import robustness module: {e}")
    sys.exit(1)


def test_config_management():
    """Test configuration management"""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 1: Configuration Management")
    logger.info("=" * 80)

    # Create and save config
    config = SystemConfig()
    config.mode = OperationMode.TEST
    config.consensus_enabled = True
    config.save("test_config.json")
    logger.info("✓ Config saved")

    # Load config
    loaded_config = SystemConfig.load("test_config.json")
    assert loaded_config.mode == OperationMode.TEST
    assert loaded_config.consensus_enabled == True
    logger.info("✓ Config loaded correctly")

    # Cleanup
    Path("test_config.json").unlink()
    logger.info("✅ Configuration management test PASSED")


def test_backup_and_recovery():
    """Test backup and recovery system"""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 2: Backup and Recovery")
    logger.info("=" * 80)

    config = SystemConfig()
    config.backup_directory = "./test_backups"
    backup_manager = BackupManager(config)

    # Create test data (9 parameters for order=8)
    population_prior = {
        "population_mean": np.zeros(9).tolist(),
        "population_covariance": np.diag([100.0] * 9).tolist(),
        "population_strength": 5.0,
    }

    pt_states = {
        0: {"mean": [0] * 9, "covariance": np.eye(9).tolist()},
        1: {"mean": [0] * 9, "covariance": np.eye(9).tolist()},
    }

    metadata = {"test": True, "timestamp": time.time()}

    # Backup
    success = backup_manager.backup_calibration_state(
        population_prior, pt_states, metadata
    )
    assert success, "Backup failed"
    logger.info("✓ Backup created")

    # List backups
    backups = backup_manager.list_backups()
    assert len(backups) > 0, "No backups found"
    logger.info(f"✓ Found {len(backups)} backup(s)")

    # Restore
    restored = backup_manager.restore_latest_backup()
    assert restored is not None, "Restore failed"
    assert "population_prior" in restored
    assert "pt_states" in restored
    logger.info("✓ Backup restored")

    # Verify data integrity
    assert restored["population_prior"]["population_strength"] == 5.0
    logger.info("✓ Data integrity verified")

    # Cleanup
    import shutil

    shutil.rmtree("./test_backups")
    logger.info("✅ Backup and recovery test PASSED")


def test_validation():
    """Test validation system"""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 3: Validation System")
    logger.info("=" * 80)

    config = SystemConfig()
    validator = CalibrationValidator(config)

    # Test voltage validation
    result = validator.validate_voltage(2.5, 0)
    assert result.valid, "Valid voltage rejected"
    logger.info("✓ Valid voltage accepted")

    result = validator.validate_voltage(15.0, 0)
    assert not result.valid, "Invalid voltage accepted"
    logger.info("✓ Invalid voltage rejected")

    result = validator.validate_voltage(np.nan, 0)
    assert not result.valid, "NaN voltage accepted"
    logger.info("✓ NaN voltage rejected")

    # Test pressure validation
    result = validator.validate_pressure(500.0, 0)
    assert result.valid, "Valid pressure rejected"
    logger.info("✓ Valid pressure accepted")

    result = validator.validate_pressure(2000.0, 0)
    assert not result.valid, "Invalid pressure accepted"
    logger.info("✓ Invalid pressure rejected")

    # Test coefficients validation (9 parameters for order=8)
    coeffs = np.array([0, 200, 0, 0, 0, 0, 0, 0, 0])
    result = validator.validate_calibration_coefficients(coeffs, 0)
    assert result.valid, "Valid coefficients rejected"
    logger.info("✓ Valid coefficients accepted")

    coeffs_bad = np.array([0, 5000, 0, 0, 0, 0, 0, 0, 0])  # Unreasonable slope
    result = validator.validate_calibration_coefficients(coeffs_bad, 0)
    assert not result.valid, "Invalid coefficients accepted"
    logger.info("✓ Invalid coefficients rejected")

    # Test covariance validation (9x9 for order=8)
    cov = np.eye(9) * 100
    result = validator.validate_covariance_matrix(cov, 0)
    assert result.valid, "Valid covariance rejected"
    logger.info("✓ Valid covariance accepted")

    cov_bad = np.diag([1, 1, 1, -1, 1, 1, 1, 1, 1])  # Not positive definite
    result = validator.validate_covariance_matrix(cov_bad, 0)
    assert not result.valid, "Invalid covariance accepted"
    logger.info("✓ Invalid covariance rejected")

    logger.info("✅ Validation system test PASSED")


def test_health_monitoring():
    """Test health monitoring system"""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 4: Health Monitoring")
    logger.info("=" * 80)

    config = SystemConfig()
    config.log_directory = "./test_logs"
    health_monitor = HealthMonitor(config)

    # Record some metrics
    for i in range(5):
        metrics = HealthMetrics(
            timestamp=time.time(),
            mode=OperationMode.TEST,
            active_sensors=16,
            calibrated_sensors=10 + i,
            consensus_confidence=0.8 + i * 0.02,
            average_uncertainty=5.0 - i * 0.5,
            max_uncertainty=10.0 - i,
            drift_detected_count=0,
            validation_errors=0,
            backup_status="OK",
            uptime_seconds=i * 10.0,
        )
        health_monitor.record_metrics(metrics)
        time.sleep(0.1)

    logger.info("✓ Metrics recorded")

    # Get status
    status = health_monitor.get_current_status()
    assert status["status"] in ("healthy", "degraded"), "Invalid status"
    assert status["calibrated_sensors"] > 0, "No calibrated sensors"
    logger.info(f"✓ System status: {status['status']}")

    # Generate diagnostics
    report = health_monitor.get_diagnostics_report()
    assert len(report) > 0, "Empty diagnostics report"
    logger.info("✓ Diagnostics report generated")
    print("\n" + report)

    # Cleanup
    import shutil

    if Path("./test_logs").exists():
        shutil.rmtree("./test_logs")
    logger.info("✅ Health monitoring test PASSED")


def test_anomaly_detection():
    """Test anomaly detection system"""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 5: Anomaly Detection")
    logger.info("=" * 80)

    config = SystemConfig()
    anomaly_detector = AnomalyDetector(config)

    # Feed normal data
    for i in range(20):
        voltage = 2.5 + np.random.normal(0, 0.01)
        anomaly = anomaly_detector.detect_voltage_anomaly(0, voltage)
        assert not anomaly, "Normal data flagged as anomaly"
    logger.info("✓ Normal data accepted")

    # Feed anomalous data
    anomaly = anomaly_detector.detect_voltage_anomaly(0, 8.0)  # Outlier
    assert anomaly, "Anomaly not detected"
    logger.info("✓ Voltage anomaly detected")

    # Test pressure anomaly
    for i in range(20):
        pressure = 500.0 + np.random.normal(0, 1.0)
        anomaly_detector.detect_pressure_anomaly(0, pressure)

    # Rapid change
    anomaly = anomaly_detector.detect_pressure_anomaly(0, 700.0)  # +200 PSI jump
    assert anomaly, "Pressure anomaly not detected"
    logger.info("✓ Pressure anomaly detected")

    # Get report
    report = anomaly_detector.get_anomaly_report()
    assert 0 in report, "Anomaly report missing sensor"
    logger.info(f"✓ Anomaly counts: {report}")

    logger.info("✅ Anomaly detection test PASSED")


def test_mode_switching():
    """Test mode switching"""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 6: Mode Switching")
    logger.info("=" * 80)

    manager = RobustnessManager()

    # Test mode
    manager.set_mode(OperationMode.TEST)
    assert manager.config.mode == OperationMode.TEST
    assert manager.config.consensus_enabled == True
    logger.info("✓ TEST mode configured correctly")

    # Flight mode
    manager.set_mode(OperationMode.FLIGHT)
    assert manager.config.mode == OperationMode.FLIGHT
    assert manager.config.consensus_enabled == False
    logger.info("✓ FLIGHT mode configured correctly (consensus DISABLED)")

    # Calibration mode
    manager.set_mode(OperationMode.CALIBRATION)
    assert manager.config.mode == OperationMode.CALIBRATION
    assert manager.config.consensus_enabled == True
    logger.info("✓ CALIBRATION mode configured correctly")

    # Safe mode
    manager.set_mode(OperationMode.SAFE)
    assert manager.config.mode == OperationMode.SAFE
    logger.info("✓ SAFE mode configured correctly")

    # Cleanup
    Path("system_config.json").unlink(missing_ok=True)
    logger.info("✅ Mode switching test PASSED")


def test_integrated_robustness_manager():
    """Test integrated robustness manager"""
    logger.info("\n" + "=" * 80)
    logger.info("TEST 7: Integrated Robustness Manager")
    logger.info("=" * 80)

    manager = RobustnessManager()

    # Validate some data
    v_result = manager.validator.validate_voltage(2.5, 0)
    assert v_result.valid
    logger.info("✓ Validation works")

    # Check health monitoring
    status = manager.health_monitor.get_current_status()
    logger.info(f"✓ Health monitoring works: {status}")

    # Test anomaly detection
    anomaly = manager.anomaly_detector.detect_voltage_anomaly(0, 2.5)
    logger.info(f"✓ Anomaly detection works: anomaly={anomaly}")

    # Test mode control
    manager.set_mode(OperationMode.TEST)
    assert manager.config.consensus_enabled == True
    manager.set_mode(OperationMode.FLIGHT)
    assert manager.config.consensus_enabled == False
    logger.info("✓ Mode control works")

    # Cleanup
    Path("system_config.json").unlink(missing_ok=True)
    logger.info("✅ Integrated robustness manager test PASSED")


def run_all_tests():
    """Run all tests"""
    print("\n" + "=" * 80)
    print("ROBUSTNESS SYSTEM COMPREHENSIVE TEST SUITE")
    print("=" * 80)

    tests = [
        ("Configuration Management", test_config_management),
        ("Backup and Recovery", test_backup_and_recovery),
        ("Validation System", test_validation),
        ("Health Monitoring", test_health_monitoring),
        ("Anomaly Detection", test_anomaly_detection),
        ("Mode Switching", test_mode_switching),
        ("Integrated Manager", test_integrated_robustness_manager),
    ]

    passed = 0
    failed = 0

    for name, test_func in tests:
        try:
            test_func()
            passed += 1
        except Exception as e:
            logger.error(f"❌ {name} test FAILED: {e}")
            import traceback

            traceback.print_exc()
            failed += 1

    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    print(f"Total tests: {len(tests)}")
    print(f"Passed: {passed} ✅")
    print(f"Failed: {failed} ❌")
    print(f"Success rate: {passed/len(tests)*100:.0f}%")
    print("=" * 80 + "\n")

    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
