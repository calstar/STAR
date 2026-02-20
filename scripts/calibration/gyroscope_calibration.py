#!/usr/bin/env python3
"""
Gyroscope Calibration Script

Calibrates gyroscope using zero-velocity method.
Requires sensor to be stationary for extended period.

Usage:
    python gyroscope_calibration.py --sensor-id imu_0 --duration 60
"""

import argparse
import numpy as np
import time
from imu_calibration import GyroscopeCalibrator, CalibrationPoint


def collect_zero_velocity_readings(duration: float = 60.0):
    """Collect gyroscope readings during zero-velocity period"""
    print("Gyroscope Zero-Velocity Calibration")
    print("=" * 50)
    print(f"Keep sensor stationary for {duration} seconds...")
    print("Collecting readings...")

    calibrator = GyroscopeCalibrator("imu_0")

    readings = []
    start_time = time.time()
    sample_rate = 10.0  # Hz

    while time.time() - start_time < duration:
        # In real implementation, read from sensor
        # For now, simulate with small bias
        raw = np.array([0.01, -0.02, 0.015]) + np.random.normal(0, 0.001, 3)
        readings.append(raw)
        time.sleep(1.0 / sample_rate)

    # Create calibration points (reference is zero)
    zero_ref = np.array([0.0, 0.0, 0.0])

    for raw in readings:
        point = CalibrationPoint(
            raw_value=raw,
            reference_value=zero_ref,
            temperature=25.0,
            timestamp=time.time(),
        )
        calibrator.add_calibration_point(point)

    print(f"Collected {len(readings)} readings")
    return calibrator


def main():
    parser = argparse.ArgumentParser(description="Gyroscope Calibration")
    parser.add_argument("--sensor-id", default="imu_0")
    parser.add_argument(
        "--duration", type=float, default=60.0, help="Collection duration in seconds"
    )
    parser.add_argument("--output", default="gyro_calibration.json")

    args = parser.parse_args()

    calibrator = collect_zero_velocity_readings(args.duration)

    # Perform calibration
    try:
        params = calibrator.calibrate()
        print("\nCalibration Results:")
        print(f"  Bias: {params.bias}")
        print(f"  Scale Matrix:\n{params.scale_matrix}")
        print(f"  Quality: {params.calibration_quality:.3f}")

        # Save calibration
        calibrator.save_calibration(args.output)
        print(f"\nSaved calibration to {args.output}")
    except Exception as e:
        print(f"Calibration failed: {e}")


if __name__ == "__main__":
    main()



