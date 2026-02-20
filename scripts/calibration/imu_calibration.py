#!/usr/bin/env python3
"""
IMU Sensor Calibration System

Calibrates accelerometers, gyroscopes, and magnetometers using:
- Static position calibration for accelerometers
- Zero-velocity calibration for gyroscopes
- Ellipsoid fitting for magnetometers

Similar to PT calibration pattern from external FSW.
"""

import numpy as np
import json
import csv
import time
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass, asdict
from pathlib import Path
from enum import Enum
import logging

logger = logging.getLogger(__name__)


class SensorType(Enum):
    ACCELEROMETER = "accelerometer"
    GYROSCOPE = "gyroscope"
    MAGNETOMETER = "magnetometer"


@dataclass
class CalibrationPoint:
    """Single calibration data point"""

    raw_value: np.ndarray  # Raw sensor reading [3x1]
    reference_value: np.ndarray  # Reference/true value [3x1]
    temperature: float  # Temperature [°C]
    timestamp: float
    uncertainty: float = 0.01


@dataclass
class CalibrationParams:
    """Calibration parameters"""

    bias: np.ndarray  # Bias vector [3x1]
    scale_matrix: np.ndarray  # Scale factor matrix [3x3]
    misalignment: np.ndarray  # Misalignment matrix [3x3]
    temperature_coeff: float = 0.0
    reference_temperature: float = 25.0

    # Quality metrics
    bias_uncertainty: float = 0.0
    scale_uncertainty: float = 0.0
    calibration_quality: float = 0.0

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization"""
        return {
            "bias": self.bias.tolist(),
            "scale_matrix": self.scale_matrix.tolist(),
            "misalignment": self.misalignment.tolist(),
            "temperature_coeff": self.temperature_coeff,
            "reference_temperature": self.reference_temperature,
            "bias_uncertainty": self.bias_uncertainty,
            "scale_uncertainty": self.scale_uncertainty,
            "calibration_quality": self.calibration_quality,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "CalibrationParams":
        """Create from dictionary"""
        return cls(
            bias=np.array(data["bias"]),
            scale_matrix=np.array(data["scale_matrix"]),
            misalignment=np.array(data["misalignment"]),
            temperature_coeff=data.get("temperature_coeff", 0.0),
            reference_temperature=data.get("reference_temperature", 25.0),
            bias_uncertainty=data.get("bias_uncertainty", 0.0),
            scale_uncertainty=data.get("scale_uncertainty", 0.0),
            calibration_quality=data.get("calibration_quality", 0.0),
        )


class IMUCalibrator:
    """Base IMU sensor calibrator"""

    def __init__(self, sensor_type: SensorType, sensor_id: str):
        self.sensor_type = sensor_type
        self.sensor_id = sensor_id
        self.calibration_points: List[CalibrationPoint] = []
        self.params: Optional[CalibrationParams] = None

    def add_calibration_point(self, point: CalibrationPoint):
        """Add calibration data point"""
        self.calibration_points.append(point)

    def calibrate(self) -> CalibrationParams:
        """Perform calibration"""
        raise NotImplementedError

    def apply_calibration(
        self, raw_value: np.ndarray, temperature: float = 25.0
    ) -> np.ndarray:
        """Apply calibration to raw reading"""
        if self.params is None:
            raise ValueError("Calibration not performed")

        # Temperature compensation
        temp_scale = 1.0
        if abs(self.params.temperature_coeff) > 1e-6:
            temp_diff = temperature - self.params.reference_temperature
            temp_scale = 1.0 + self.params.temperature_coeff * temp_diff

        # Apply calibration: calibrated = scale_matrix * (raw - bias) * temp_scale
        corrected = raw_value - self.params.bias
        corrected *= temp_scale
        calibrated = self.params.scale_matrix @ corrected

        return calibrated

    def save_calibration(self, filepath: str):
        """Save calibration parameters to JSON file"""
        if self.params is None:
            raise ValueError("No calibration parameters to save")

        data = {
            "sensor_type": self.sensor_type.value,
            "sensor_id": self.sensor_id,
            "calibration_params": self.params.to_dict(),
            "num_points": len(self.calibration_points),
        }

        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)

        logger.info(f"Saved calibration to {filepath}")

    def load_calibration(self, filepath: str):
        """Load calibration parameters from JSON file"""
        with open(filepath, "r") as f:
            data = json.load(f)

        self.params = CalibrationParams.from_dict(data["calibration_params"])
        logger.info(f"Loaded calibration from {filepath}")


class AccelerometerCalibrator(IMUCalibrator):
    """Accelerometer calibrator using static position method"""

    def __init__(self, sensor_id: str):
        super().__init__(SensorType.ACCELEROMETER, sensor_id)
        self.gravity = 9.81  # m/s²

    def calibrate(self) -> CalibrationParams:
        """Calibrate accelerometer using static positions"""
        if len(self.calibration_points) < 6:
            raise ValueError("Need at least 6 positions for accelerometer calibration")

        # Estimate bias as mean of all readings
        # (assuming gravity cancels out over all orientations)
        bias = np.mean([p.raw_value for p in self.calibration_points], axis=0)

        # Estimate scale matrix using least squares
        # For each point: reference = scale_matrix * (raw - bias)
        A = []
        b = []

        for point in self.calibration_points:
            corrected = point.raw_value - bias
            # Build linear system for scale matrix
            for i in range(3):
                row = np.zeros(9)
                for j in range(3):
                    row[i * 3 + j] = corrected[j]
                A.append(row)
                b.append(point.reference_value[i])

        A = np.array(A)
        b = np.array(b)

        # Solve least squares
        scale_vec = np.linalg.lstsq(A, b, rcond=None)[0]

        # Reshape to 3x3 matrix
        scale_matrix = scale_vec.reshape(3, 3)

        # Compute quality metrics
        residuals = []
        for point in self.calibration_points:
            calibrated = self.apply_calibration(point.raw_value, point.temperature)
            error = np.linalg.norm(calibrated - point.reference_value)
            residuals.append(error)

        avg_error = np.mean(residuals)
        quality = 1.0 / (1.0 + avg_error)

        self.params = CalibrationParams(
            bias=bias,
            scale_matrix=scale_matrix,
            misalignment=np.eye(3),  # Included in scale_matrix
            calibration_quality=quality,
            bias_uncertainty=np.std(
                [p.raw_value for p in self.calibration_points], axis=0
            ).mean(),
        )

        return self.params


class GyroscopeCalibrator(IMUCalibrator):
    """Gyroscope calibrator using zero-velocity method"""

    def __init__(self, sensor_id: str):
        super().__init__(SensorType.GYROSCOPE, sensor_id)

    def calibrate(self) -> CalibrationParams:
        """Calibrate gyroscope using zero-velocity periods"""
        if len(self.calibration_points) < 10:
            raise ValueError("Need at least 10 zero-velocity readings")

        # Estimate bias as mean (should be zero during stationary periods)
        bias = np.mean([p.raw_value for p in self.calibration_points], axis=0)

        # Estimate scale factors from variance
        # Higher variance indicates lower scale factor confidence
        variances = np.var([p.raw_value for p in self.calibration_points], axis=0)

        # Scale matrix: identity with scale factors inversely related to variance
        scale_matrix = np.eye(3)
        # For now, assume unity scale (would need rotation calibration for full scale)

        # Compute quality
        residuals = []
        for point in self.calibration_points:
            calibrated = self.apply_calibration(point.raw_value, point.temperature)
            error = np.linalg.norm(calibrated - point.reference_value)
            residuals.append(error)

        avg_error = np.mean(residuals)
        quality = 1.0 / (1.0 + avg_error)

        self.params = CalibrationParams(
            bias=bias,
            scale_matrix=scale_matrix,
            misalignment=np.eye(3),
            calibration_quality=quality,
            bias_uncertainty=np.std(
                [p.raw_value for p in self.calibration_points], axis=0
            ).mean(),
        )

        return self.params


class MagnetometerCalibrator(IMUCalibrator):
    """Magnetometer calibrator using ellipsoid fitting"""

    def __init__(self, sensor_id: str):
        super().__init__(SensorType.MAGNETOMETER, sensor_id)
        self.reference_field_magnitude = 1.0  # Normalized

    def calibrate(self) -> CalibrationParams:
        """Calibrate magnetometer using ellipsoid fitting"""
        if len(self.calibration_points) < 6:
            raise ValueError(
                "Need at least 6 orientations for magnetometer calibration"
            )

        # Hard iron correction: bias is center of ellipsoid
        # Estimate as mean of all readings
        bias = np.mean([p.raw_value for p in self.calibration_points], axis=0)

        # Soft iron correction: scale and misalignment
        # For now, use simplified approach
        # Full ellipsoid fitting would solve for 9 parameters

        # Compute scale factors from variance in each axis
        corrected_readings = [p.raw_value - bias for p in self.calibration_points]
        variances = np.var(corrected_readings, axis=0)

        # Normalize to reference field magnitude
        mean_magnitude = np.mean([np.linalg.norm(cr) for cr in corrected_readings])
        if mean_magnitude > 0:
            scale_factor = self.reference_field_magnitude / mean_magnitude
        else:
            scale_factor = 1.0

        scale_matrix = np.eye(3) * scale_factor

        # Compute quality
        residuals = []
        for point in self.calibration_points:
            calibrated = self.apply_calibration(point.raw_value, point.temperature)
            error = np.linalg.norm(calibrated - point.reference_value)
            residuals.append(error)

        avg_error = np.mean(residuals)
        quality = 1.0 / (1.0 + avg_error)

        self.params = CalibrationParams(
            bias=bias,
            scale_matrix=scale_matrix,
            misalignment=np.eye(3),
            calibration_quality=quality,
            bias_uncertainty=np.std(
                [p.raw_value for p in self.calibration_points], axis=0
            ).mean(),
        )

        return self.params


class IMUCalibrationSystem:
    """Complete IMU calibration system"""

    def __init__(self):
        self.accel_calibrator: Optional[AccelerometerCalibrator] = None
        self.gyro_calibrator: Optional[GyroscopeCalibrator] = None
        self.mag_calibrator: Optional[MagnetometerCalibrator] = None

    def create_calibrator(
        self, sensor_type: SensorType, sensor_id: str
    ) -> IMUCalibrator:
        """Create calibrator for sensor type"""
        if sensor_type == SensorType.ACCELEROMETER:
            self.accel_calibrator = AccelerometerCalibrator(sensor_id)
            return self.accel_calibrator
        elif sensor_type == SensorType.GYROSCOPE:
            self.gyro_calibrator = GyroscopeCalibrator(sensor_id)
            return self.gyro_calibrator
        elif sensor_type == SensorType.MAGNETOMETER:
            self.mag_calibrator = MagnetometerCalibrator(sensor_id)
            return self.mag_calibrator
        else:
            raise ValueError(f"Unknown sensor type: {sensor_type}")

    def calibrate_all(self) -> Dict[str, CalibrationParams]:
        """Calibrate all sensors"""
        results = {}

        if self.accel_calibrator and len(self.accel_calibrator.calibration_points) >= 6:
            results["accelerometer"] = self.accel_calibrator.calibrate()

        if self.gyro_calibrator and len(self.gyro_calibrator.calibration_points) >= 10:
            results["gyroscope"] = self.gyro_calibrator.calibrate()

        if self.mag_calibrator and len(self.mag_calibrator.calibration_points) >= 6:
            results["magnetometer"] = self.mag_calibrator.calibrate()

        return results

    def save_all_calibrations(self, base_path: str):
        """Save all calibrations"""
        if self.accel_calibrator and self.accel_calibrator.params:
            self.accel_calibrator.save_calibration(f"{base_path}_accel.json")

        if self.gyro_calibrator and self.gyro_calibrator.params:
            self.gyro_calibrator.save_calibration(f"{base_path}_gyro.json")

        if self.mag_calibrator and self.mag_calibrator.params:
            self.mag_calibrator.save_calibration(f"{base_path}_mag.json")


def main():
    """Example usage"""
    import argparse

    parser = argparse.ArgumentParser(description="IMU Calibration System")
    parser.add_argument(
        "--sensor-type", choices=["accel", "gyro", "mag"], required=True
    )
    parser.add_argument("--sensor-id", default="imu_0")
    parser.add_argument("--data-file", help="CSV file with calibration data")
    parser.add_argument("--output", help="Output calibration file")

    args = parser.parse_args()

    # Create calibrator
    calib_system = IMUCalibrationSystem()

    if args.sensor_type == "accel":
        calibrator = calib_system.create_calibrator(
            SensorType.ACCELEROMETER, args.sensor_id
        )
    elif args.sensor_type == "gyro":
        calibrator = calib_system.create_calibrator(
            SensorType.GYROSCOPE, args.sensor_id
        )
    else:
        calibrator = calib_system.create_calibrator(
            SensorType.MAGNETOMETER, args.sensor_id
        )

    # Load data from CSV or use interactive mode
    if args.data_file:
        # Load from CSV
        # Format: raw_x, raw_y, raw_z, ref_x, ref_y, ref_z, temperature
        with open(args.data_file, "r") as f:
            reader = csv.reader(f)
            for row in reader:
                raw = np.array([float(row[0]), float(row[1]), float(row[2])])
                ref = np.array([float(row[3]), float(row[4]), float(row[5])])
                temp = float(row[6]) if len(row) > 6 else 25.0

                point = CalibrationPoint(
                    raw_value=raw,
                    reference_value=ref,
                    temperature=temp,
                    timestamp=time.time(),
                )
                calibrator.add_calibration_point(point)
    else:
        print("Interactive calibration mode")
        print("Enter calibration points (or 'done' to finish):")
        # Interactive input would go here

    # Perform calibration
    try:
        params = calibrator.calibrate()
        print(f"Calibration successful!")
        print(f"  Bias: {params.bias}")
        print(f"  Quality: {params.calibration_quality:.3f}")

        if args.output:
            calibrator.save_calibration(args.output)
    except Exception as e:
        print(f"Calibration failed: {e}")


if __name__ == "__main__":
    main()



