#!/usr/bin/env python3
"""
Accelerometer Calibration Script

Calibrates accelerometer using static position method.
Requires sensor to be placed in 6+ known orientations.

Usage:
    python accelerometer_calibration.py --sensor-id imu_0
"""

import argparse
import numpy as np
import time
from imu_calibration import AccelerometerCalibrator, SensorType, CalibrationPoint


def collect_static_positions():
    """Collect accelerometer readings at static positions"""
    print("Accelerometer Static Position Calibration")
    print("=" * 50)
    print("Place sensor in the following orientations:")
    print("1. +X axis up (gravity in +X)")
    print("2. -X axis up (gravity in -X)")
    print("3. +Y axis up (gravity in +Y)")
    print("4. -Y axis up (gravity in -X)")
    print("5. +Z axis up (gravity in +Z)")
    print("6. -Z axis up (gravity in -Z)")
    print()

    calibrator = AccelerometerCalibrator("imu_0")

    orientations = [
        ("+X", np.array([9.81, 0.0, 0.0])),
        ("-X", np.array([-9.81, 0.0, 0.0])),
        ("+Y", np.array([0.0, 9.81, 0.0])),
        ("-Y", np.array([0.0, -9.81, 0.0])),
        ("+Z", np.array([0.0, 0.0, 9.81])),
        ("-Z", np.array([0.0, 0.0, -9.81])),
    ]

    for i, (name, ref_gravity) in enumerate(orientations, 1):
        input(f"Place sensor in {name} orientation and press Enter...")

        # Collect multiple readings and average
        print("Collecting readings (5 seconds)...")
        readings = []
        start_time = time.time()
        while time.time() - start_time < 5.0:
            # In real implementation, read from sensor
            # For now, simulate
            raw = np.array([0.0, 0.0, 0.0])  # Would read from sensor
            readings.append(raw)
            time.sleep(0.1)

        # Average readings
        avg_reading = np.mean(readings, axis=0)

        # Create calibration point
        point = CalibrationPoint(
            raw_value=avg_reading,
            reference_value=ref_gravity,
            temperature=25.0,
            timestamp=time.time(),
        )
        calibrator.add_calibration_point(point)

        print(f"  Collected {name}: {avg_reading}")

    return calibrator


def main():
    parser = argparse.ArgumentParser(description="Accelerometer Calibration")
    parser.add_argument("--sensor-id", default="imu_0")
    parser.add_argument("--output", default="accel_calibration.json")
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Interactive mode (collect positions)",
    )

    args = parser.parse_args()

    if args.interactive:
        calibrator = collect_static_positions()
    else:
        # Load from file or use existing data
        calibrator = AccelerometerCalibrator(args.sensor_id)
        print("Add calibration points programmatically or use --interactive")
        return

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
