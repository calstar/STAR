#!/usr/bin/env python3
"""
Magnetometer Calibration Script

Calibrates magnetometer using ellipsoid fitting method.
Requires sensor to be rotated through multiple orientations.

Usage:
    python magnetometer_calibration.py --sensor-id imu_0
"""

import argparse
import numpy as np
import time
from imu_calibration import MagnetometerCalibrator, CalibrationPoint


def collect_magnetometer_readings():
    """Collect magnetometer readings at multiple orientations"""
    print("Magnetometer Calibration")
    print("=" * 50)
    print("Rotate sensor through multiple orientations")
    print("Aim for at least 12 different orientations covering all axes")
    print()

    calibrator = MagnetometerCalibrator("imu_0")

    # Reference magnetic field (normalized, pointing north)
    reference_field = np.array([1.0, 0.0, 0.0])  # North

    num_positions = 12
    print(f"Collecting {num_positions} orientations...")

    for i in range(num_positions):
        input(f"Rotate sensor to orientation {i+1}/{num_positions} and press Enter...")

        # Collect multiple readings and average
        print("Collecting readings (3 seconds)...")
        readings = []
        start_time = time.time()
        while time.time() - start_time < 3.0:
            # In real implementation, read from sensor
            # For now, simulate
            raw = np.array([0.0, 0.0, 0.0])  # Would read from sensor
            readings.append(raw)
            time.sleep(0.1)

        # Average readings
        avg_reading = np.mean(readings, axis=0)

        # Reference is the normalized field direction at this orientation
        # (would need to know sensor orientation relative to magnetic field)
        ref = reference_field  # Simplified

        # Create calibration point
        point = CalibrationPoint(
            raw_value=avg_reading,
            reference_value=ref,
            temperature=25.0,
            timestamp=time.time(),
        )
        calibrator.add_calibration_point(point)

        print(f"  Collected orientation {i+1}: {avg_reading}")

    return calibrator


def main():
    parser = argparse.ArgumentParser(description="Magnetometer Calibration")
    parser.add_argument("--sensor-id", default="imu_0")
    parser.add_argument("--output", default="mag_calibration.json")
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Interactive mode (collect orientations)",
    )
    parser.add_argument(
        "--reference-field",
        type=float,
        nargs=3,
        default=[1.0, 0.0, 0.0],
        help="Reference magnetic field vector",
    )

    args = parser.parse_args()

    if args.interactive:
        calibrator = collect_magnetometer_readings()
    else:
        calibrator = MagnetometerCalibrator(args.sensor_id)
        calibrator.reference_field_magnitude = np.linalg.norm(args.reference_field)
        print("Add calibration points programmatically or use --interactive")
        return

    # Perform calibration
    try:
        params = calibrator.calibrate()
        print("\nCalibration Results:")
        print(f"  Bias (Hard Iron): {params.bias}")
        print(f"  Scale Matrix (Soft Iron):\n{params.scale_matrix}")
        print(f"  Quality: {params.calibration_quality:.3f}")

        # Save calibration
        calibrator.save_calibration(args.output)
        print(f"\nSaved calibration to {args.output}")
    except Exception as e:
        print(f"Calibration failed: {e}")


if __name__ == "__main__":
    main()
