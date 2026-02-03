#!/usr/bin/env python3
"""
Liquid Engine Sensor Calibration Sequence
Implements automated calibration procedures for all sensors
"""

import sys
import time
import json
import argparse
import numpy as np
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from pathlib import Path
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@dataclass
class CalibrationPoint:
    """Represents a single calibration data point"""
    input_value: float
    reference_value: float
    timestamp: float
    environmental_conditions: Dict[str, float]
    uncertainty: float

@dataclass
class CalibrationResult:
    """Represents calibration results for a sensor"""
    sensor_id: str
    sensor_type: str
    calibration_points: List[CalibrationPoint]
    parameters: Dict[str, float]
    covariance_matrix: List[List[float]]
    quality_metrics: Dict[str, float]
    calibration_time: float

class SensorCalibrator:
    """Base class for sensor calibration"""
    
    def __init__(self, sensor_id: str, sensor_type: str):
        self.sensor_id = sensor_id
        self.sensor_type = sensor_type
        self.calibration_points: List[CalibrationPoint] = []
        
    def add_calibration_point(self, input_value: float, reference_value: float, 
                            environmental_conditions: Dict[str, float], 
                            uncertainty: float = 0.01):
        """Add a calibration data point"""
        point = CalibrationPoint(
            input_value=input_value,
            reference_value=reference_value,
            timestamp=time.time(),
            environmental_conditions=environmental_conditions,
            uncertainty=uncertainty
        )
        self.calibration_points.append(point)
        
    def perform_calibration(self) -> CalibrationResult:
        """Perform calibration and return results"""
        raise NotImplementedError
        
    def validate_calibration(self) -> bool:
        """Validate calibration quality"""
        raise NotImplementedError

class PressureTransducerCalibrator(SensorCalibrator):
    """Calibrator for pressure transducers"""
    
    def __init__(self, sensor_id: str):
        super().__init__(sensor_id, "pressure_transducer")
        self.pressure_range = (0.0, 15e6)  # Pa
        self.voltage_range = (0.0, 5.0)    # V
        
    def perform_calibration(self) -> CalibrationResult:
        """Perform pressure transducer calibration using Bayesian regression"""
        if len(self.calibration_points) < 5:
            raise ValueError("Insufficient calibration points")
            
        # Extract data
        voltages = np.array([p.input_value for p in self.calibration_points])
        pressures = np.array([p.reference_value for p in self.calibration_points])
        uncertainties = np.array([p.uncertainty for p in self.calibration_points])
        
        # Perform Bayesian regression (simplified implementation)
        # In practice, this would implement the full Bayesian framework from the paper
        
        # Linear fit: P = a + b*V + c*V^2 + environmental_terms
        n_points = len(voltages)
        
        # Design matrix for linear + quadratic + environmental terms
        A = np.column_stack([
            np.ones(n_points),  # Constant term
            voltages,           # Linear term
            voltages**2,        # Quadratic term
            voltages**3,        # Cubic term
            np.sqrt(voltages),  # Square root term
            np.log(1 + voltages) # Log term
        ])
        
        # Add environmental terms
        for point in self.calibration_points:
            env_terms = []
            for key, value in point.environmental_conditions.items():
                if key == 'temperature':
                    env_terms.extend([value, value**2, value * point.input_value])
            A = np.column_stack([A, np.array(env_terms)])
        
        # Weight matrix (inverse of uncertainties)
        W = np.diag(1.0 / (uncertainties**2 + 1e-6))
        
        # Bayesian regression: θ = (A^T W A + Σ₀⁻¹)⁻¹ (A^T W b + Σ₀⁻¹ μ₀)
        # Simplified version without priors
        try:
            cov_matrix = np.linalg.inv(A.T @ W @ A)
            parameters = cov_matrix @ (A.T @ W @ pressures)
        except np.linalg.LinAlgError:
            logger.warning("Singular matrix, using regularized solution")
            regularization = 1e-6 * np.eye(A.shape[1])
            cov_matrix = np.linalg.inv(A.T @ W @ A + regularization)
            parameters = cov_matrix @ (A.T @ W @ pressures)
        
        # Calculate quality metrics
        predicted_pressures = A @ parameters
        residuals = pressures - predicted_pressures
        rmse = np.sqrt(np.mean(residuals**2))
        nrmse = rmse / (np.max(pressures) - np.min(pressures))
        
        # Calculate coverage (95% confidence interval)
        confidence_intervals = 1.96 * np.sqrt(np.diag(A @ cov_matrix @ A.T))
        coverage_count = np.sum(np.abs(residuals) <= confidence_intervals)
        coverage_95 = coverage_count / n_points
        
        # Extrapolation confidence
        voltage_range = np.max(voltages) - np.min(voltages)
        extrapolation_confidence = min(1.0, 0.9 * np.exp(-voltage_range / 2.0))
        
        quality_metrics = {
            'rmse': float(rmse),
            'nrmse': float(nrmse),
            'coverage_95': float(coverage_95),
            'extrapolation_confidence': float(extrapolation_confidence),
            'condition_number': float(np.linalg.cond(A.T @ W @ A)),
            'num_points': len(self.calibration_points)
        }
        
        return CalibrationResult(
            sensor_id=self.sensor_id,
            sensor_type=self.sensor_type,
            calibration_points=self.calibration_points.copy(),
            parameters={
                'a0': float(parameters[0]),
                'a1': float(parameters[1]),
                'a2': float(parameters[2]),
                'a3': float(parameters[3]),
                'a4': float(parameters[4]),
                'a5': float(parameters[5])
            },
            covariance_matrix=cov_matrix.tolist(),
            quality_metrics=quality_metrics,
            calibration_time=time.time()
        )

class RTDCalibrator(SensorCalibrator):
    """Calibrator for RTD temperature sensors"""
    
    def __init__(self, sensor_id: str):
        super().__init__(sensor_id, "rtd_temperature")
        self.temperature_range = (-50.0, 500.0)  # °C
        self.resistance_range = (80.0, 200.0)    # Ohm
        
    def perform_calibration(self) -> CalibrationResult:
        """Perform RTD calibration"""
        if len(self.calibration_points) < 3:
            raise ValueError("Insufficient calibration points")
            
        # Extract data
        resistances = np.array([p.input_value for p in self.calibration_points])
        temperatures = np.array([p.reference_value for p in self.calibration_points])
        
        # Callendar-Van Dusen equation: R(T) = R0(1 + AT + BT² + C(T-100)T³)
        # Simplified linear fit for demonstration
        A_matrix = np.column_stack([np.ones(len(resistances)), resistances, resistances**2])
        
        try:
            parameters = np.linalg.lstsq(A_matrix, temperatures, rcond=None)[0]
            residuals = temperatures - (A_matrix @ parameters)
            rmse = np.sqrt(np.mean(residuals**2))
        except np.linalg.LinAlgError:
            logger.error("Failed to solve RTD calibration")
            raise
            
        return CalibrationResult(
            sensor_id=self.sensor_id,
            sensor_type=self.sensor_type,
            calibration_points=self.calibration_points.copy(),
            parameters={
                'R0': float(parameters[0]),
                'alpha': float(parameters[1]),
                'beta': float(parameters[2])
            },
            covariance_matrix=[[0.01, 0, 0], [0, 0.01, 0], [0, 0, 0.01]],  # Simplified
            quality_metrics={
                'rmse': float(rmse),
                'nrmse': float(rmse / (np.max(temperatures) - np.min(temperatures))),
                'num_points': len(self.calibration_points)
            },
            calibration_time=time.time()
        )

class CalibrationSequence:
    """Manages the complete calibration sequence"""
    
    def __init__(self, config_file: str):
        self.config_file = config_file
        self.calibrators: Dict[str, SensorCalibrator] = {}
        self.results: Dict[str, CalibrationResult] = {}
        
    def load_config(self):
        """Load calibration configuration"""
        # In practice, this would load from TOML config
        logger.info(f"Loading configuration from {self.config_file}")
        
    def add_sensor(self, sensor_id: str, sensor_type: str):
        """Add a sensor to the calibration sequence"""
        if sensor_type == "pressure_transducer":
            calibrator = PressureTransducerCalibrator(sensor_id)
        elif sensor_type == "rtd_temperature":
            calibrator = RTDCalibrator(sensor_id)
        else:
            raise ValueError(f"Unsupported sensor type: {sensor_type}")
            
        self.calibrators[sensor_id] = calibrator
        logger.info(f"Added {sensor_type} sensor: {sensor_id}")
        
    def run_pressure_transducer_calibration(self, sensor_id: str, 
                                          pressure_points: List[float],
                                          voltage_readings: List[float],
                                          environmental_conditions: Dict[str, float]):
        """Run pressure transducer calibration"""
        if sensor_id not in self.calibrators:
            self.add_sensor(sensor_id, "pressure_transducer")
            
        calibrator = self.calibrators[sensor_id]
        
        logger.info(f"Starting pressure transducer calibration for {sensor_id}")
        
        # Add calibration points
        for pressure, voltage in zip(pressure_points, voltage_readings):
            calibrator.add_calibration_point(
                input_value=voltage,
                reference_value=pressure,
                environmental_conditions=environmental_conditions,
                uncertainty=0.01  # 1% uncertainty
            )
            logger.info(f"Added calibration point: {voltage:.3f}V -> {pressure:.0f}Pa")
            
        # Perform calibration
        result = calibrator.perform_calibration()
        self.results[sensor_id] = result
        
        logger.info(f"Calibration complete for {sensor_id}")
        logger.info(f"Quality metrics: RMSE={result.quality_metrics['rmse']:.2f} Pa, "
                   f"NRMSE={result.quality_metrics['nrmse']:.4f}")
        
        return result
        
    def run_rtd_calibration(self, sensor_id: str,
                          temperature_points: List[float],
                          resistance_readings: List[float]):
        """Run RTD calibration"""
        if sensor_id not in self.calibrators:
            self.add_sensor(sensor_id, "rtd_temperature")
            
        calibrator = self.calibrators[sensor_id]
        
        logger.info(f"Starting RTD calibration for {sensor_id}")
        
        # Add calibration points
        for temperature, resistance in zip(temperature_points, resistance_readings):
            calibrator.add_calibration_point(
                input_value=resistance,
                reference_value=temperature,
                environmental_conditions={'temperature': 25.0},
                uncertainty=0.1  # 0.1°C uncertainty
            )
            logger.info(f"Added calibration point: {resistance:.2f}Ω -> {temperature:.1f}°C")
            
        # Perform calibration
        result = calibrator.perform_calibration()
        self.results[sensor_id] = result
        
        logger.info(f"Calibration complete for {sensor_id}")
        logger.info(f"Quality metrics: RMSE={result.quality_metrics['rmse']:.2f} °C")
        
        return result
        
    def save_results(self, output_dir: str):
        """Save calibration results to files"""
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        
        for sensor_id, result in self.results.items():
            filename = output_path / f"{sensor_id}_calibration.json"
            
            # Convert to JSON-serializable format
            result_dict = {
                'sensor_id': result.sensor_id,
                'sensor_type': result.sensor_type,
                'calibration_time': result.calibration_time,
                'parameters': result.parameters,
                'covariance_matrix': result.covariance_matrix,
                'quality_metrics': result.quality_metrics,
                'calibration_points': [
                    {
                        'input_value': p.input_value,
                        'reference_value': p.reference_value,
                        'timestamp': p.timestamp,
                        'environmental_conditions': p.environmental_conditions,
                        'uncertainty': p.uncertainty
                    }
                    for p in result.calibration_points
                ]
            }
            
            with open(filename, 'w') as f:
                json.dump(result_dict, f, indent=2)
                
            logger.info(f"Saved calibration results to {filename}")
            
    def generate_report(self) -> str:
        """Generate calibration report"""
        report = []
        report.append("=" * 60)
        report.append("LIQUID ENGINE SENSOR CALIBRATION REPORT")
        report.append("=" * 60)
        report.append(f"Calibration Date: {time.strftime('%Y-%m-%d %H:%M:%S')}")
        report.append(f"Total Sensors Calibrated: {len(self.results)}")
        report.append("")
        
        for sensor_id, result in self.results.items():
            report.append(f"Sensor ID: {sensor_id}")
            report.append(f"Type: {result.sensor_type}")
            report.append(f"Calibration Points: {result.quality_metrics['num_points']}")
            report.append(f"RMSE: {result.quality_metrics['rmse']:.4f}")
            if 'nrmse' in result.quality_metrics:
                report.append(f"NRMSE: {result.quality_metrics['nrmse']:.4f}")
            if 'coverage_95' in result.quality_metrics:
                report.append(f"95% Coverage: {result.quality_metrics['coverage_95']:.2%}")
            report.append("")
            
        return "\n".join(report)

def main():
    parser = argparse.ArgumentParser(description="Liquid Engine Sensor Calibration")
    parser.add_argument("--config", default="config_engine.toml", help="Configuration file")
    parser.add_argument("--output-dir", default="calibrations", help="Output directory")
    parser.add_argument("--sensor", help="Specific sensor to calibrate")
    parser.add_argument("--interactive", action="store_true", help="Interactive calibration mode")
    
    args = parser.parse_args()
    
    # Initialize calibration sequence
    sequence = CalibrationSequence(args.config)
    sequence.load_config()
    
    if args.interactive:
        # Interactive calibration mode
        print("Interactive Calibration Mode")
        print("=" * 40)
        
        # Example pressure transducer calibration
        sensor_id = input("Enter sensor ID: ")
        sensor_type = input("Enter sensor type (pressure_transducer/rtd_temperature): ")
        
        if sensor_type == "pressure_transducer":
            print("\nPressure Transducer Calibration")
            print("Enter calibration points (voltage, pressure)")
            print("Enter 'done' when finished")
            
            voltage_readings = []
            pressure_points = []
            
            while True:
                entry = input("Voltage (V), Pressure (Pa): ")
                if entry.lower() == 'done':
                    break
                try:
                    voltage, pressure = map(float, entry.split(','))
                    voltage_readings.append(voltage)
                    pressure_points.append(pressure)
                except ValueError:
                    print("Invalid input. Use format: voltage, pressure")
                    
            environmental_conditions = {'temperature': 25.0, 'humidity': 50.0}
            sequence.run_pressure_transducer_calibration(
                sensor_id, pressure_points, voltage_readings, environmental_conditions
            )
            
    else:
        # Automated calibration with example data
        logger.info("Running automated calibration sequence")
        
        # Example pressure transducer calibration
        pressure_points = [0.0, 2e6, 5e6, 8e6, 10e6, 12e6, 15e6]  # Pa
        voltage_readings = [0.5, 1.2, 2.1, 2.8, 3.2, 3.6, 4.2]   # V
        environmental_conditions = {'temperature': 25.0, 'humidity': 50.0}
        
        sequence.run_pressure_transducer_calibration(
            "PT_CHAMBER", pressure_points, voltage_readings, environmental_conditions
        )
        
        # Example RTD calibration
        temperature_points = [0.0, 25.0, 50.0, 100.0, 150.0, 200.0]  # °C
        resistance_readings = [100.0, 109.7, 119.4, 138.5, 157.3, 175.8]  # Ohm
        
        sequence.run_rtd_calibration(
            "RTD_CHAMBER_WALL", temperature_points, resistance_readings
        )
    
    # Save results and generate report
    sequence.save_results(args.output_dir)
    report = sequence.generate_report()
    print(report)
    
    # Save report to file
    with open(Path(args.output_dir) / "calibration_report.txt", 'w') as f:
        f.write(report)
        
    logger.info("Calibration sequence complete")

if __name__ == "__main__":
    main()
