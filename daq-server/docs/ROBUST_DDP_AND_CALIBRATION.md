# Robust DDP Controller and IMU Calibration Documentation

## Overview

This document describes the implementation of:
1. Robust DDP Controller (C++ port from Python engine simulation)
2. Enhanced EKF Navigation with magnetometer support
3. IMU Calibration System (accelerometer, gyroscope, magnetometer)

## Robust DDP Controller

### Location
- Header: `diablo_server/lib/include/control/RobustDDPController.hpp`
- Implementation: `diablo_server/lib/src/control/RobustDDPController.cpp`

### Features
- Thrust regulation via pressure control
- Safety filtering for constraint satisfaction
- Warm start for efficient optimization
- Robustness bounds for uncertainty handling

### Usage

```cpp
#include "control/RobustDDPController.hpp"

using namespace fsw::control;

// Initialize controller
RobustDDPController::Config config;
config.N = 20;  // Horizon
config.dt = 0.01;  // Timestep
config.Q_F = 1.0;  // Thrust tracking weight
config.Q_MR = 10.0;  // Mixture ratio weight

RobustDDPController controller;
controller.initialize(config);

// Control loop
while (running) {
    // Get measurements
    RobustDDPController::Measurement meas;
    meas.P_copv = ...;
    meas.P_reg = ...;
    // ... other pressures
    
    // Get navigation state
    RobustDDPController::NavState nav;
    nav.h = altitude;
    nav.vz = vertical_velocity;
    
    // Set command
    RobustDDPController::Command cmd;
    cmd.type = RobustDDPController::CommandType::THRUST_DESIRED;
    cmd.thrust_desired = 5000.0;  // N
    
    // Controller step
    auto [actuation, diagnostics] = controller.step(meas, nav, cmd);
    
    // Apply actuation
    apply_solenoid_duty(actuation.duty_F, actuation.duty_O);
}
```

### State Vector
- P_copv: COPV pressure
- P_reg: Regulator pressure
- P_u_fuel: Fuel upstream pressure
- P_u_ox: Oxidizer upstream pressure
- P_d_fuel: Fuel downstream pressure
- P_d_ox: Oxidizer downstream pressure
- V_u_F: Fuel ullage volume
- V_u_O: Oxidizer ullage volume
- Additional states (3)

### Control Output
- duty_F: Fuel solenoid duty cycle [0-1]
- duty_O: Oxidizer solenoid duty cycle [0-1]

## Enhanced EKF Navigation

### Location
- Header: `diablo_server/lib/include/nav/EKFNavigationEnhanced.hpp`
- Implementation: `diablo_server/lib/include/nav/EKFNavigationEnhanced.hpp` (header-only; no active .cpp source)

### Enhancements
- Magnetometer integration for heading estimation
- Calibrated IMU measurements
- Magnetic declination correction
- Heading estimation from magnetometer + gyro fusion

### Usage

```cpp
#include "nav/EKFNavigationEnhanced.hpp"
#include "calibration/IMUCalibration.hpp"

using namespace fsw::nav;
using namespace fsw::calibration;

// Initialize enhanced EKF
EKFNavigationEnhanced::EnhancedConfig config;
config.use_magnetometer = true;
config.magnetic_declination = 0.1;  // rad
config.magnetometer_noise = 0.01;

EKFNavigationEnhanced ekf;
ekf.initialize(config, initial_state);

// Set IMU calibration
auto imu_calib = std::make_shared<IMUCalibrationSystem>();
ekf.setIMUCalibration(imu_calib);

// Process magnetometer measurement
IMUMeasurement imu_meas;
imu_meas.magnetometer = Eigen::Vector3d(...);
imu_meas.timestamp = now();

// Calibrate IMU reading
auto calibrated_mag = imu_calib->calibrateIMU(accel_raw, gyro_raw, mag_raw);

// Process with EKF
ekf.processMagnetometerMeasurement(imu_meas, calibrated_mag.magnetometer);

// Get heading
double heading = ekf.getHeading();
```

## IMU Calibration System

### Python Calibration Workflow

Calibration is performed using Python scripts (similar to PT calibration), and the resulting parameters are loaded into the C++ runtime system for real-time sensor correction.

For the Python calibration workflow and per-sensor procedures, see [`../tools/calibration/README_IMU.md`](../tools/calibration/README_IMU.md).

### C++ Runtime Application
- Header: `diablo_server/lib/include/calibration/IMUCalibration.hpp`
- Implementation: `diablo_server/lib/src/calibration/IMUCalibration.cpp`

### Usage

**C++ Runtime Application:**

```cpp
#include "calibration/IMUCalibration.hpp"

using namespace fsw::calibration;

// Load calibration parameters from JSON (would need JSON loader)
// For now, create calibration system
IMUCalibrationSystem calib_system;

// Collect calibration data
std::vector<IMUCalibration::RawReading> accel_readings;
std::vector<IMUCalibration::RawReading> gyro_readings;
std::vector<IMUCalibration::RawReading> mag_readings;

// For accelerometer: collect at 6+ static positions
for (int i = 0; i < 6; ++i) {
    IMUCalibration::RawReading reading;
    reading.value = get_accel_reading();
    reading.temperature = get_temperature();
    reading.timestamp = now();
    accel_readings.push_back(reading);
}

// For gyroscope: collect during zero-velocity periods
for (int i = 0; i < 100; ++i) {
    IMUCalibration::RawReading reading;
    reading.value = get_gyro_reading();
    reading.temperature = get_temperature();
    reading.timestamp = now();
    gyro_readings.push_back(reading);
}

// For magnetometer: collect at multiple orientations
Eigen::Vector3d reference_field(1.0, 0.0, 0.0);  // North
for (int i = 0; i < 12; ++i) {
    IMUCalibration::RawReading reading;
    reading.value = get_mag_reading();
    reading.temperature = get_temperature();
    reading.timestamp = now();
    mag_readings.push_back(reading);
}

// Perform calibration
bool success = calib_system.calibrateAll(
    accel_readings,
    gyro_readings,
    mag_readings,
    reference_field
);

// Use calibrated readings
IMUCalibration::RawReading accel_raw, gyro_raw, mag_raw;
// ... populate raw readings ...

auto calibrated = calib_system.calibrateIMU(accel_raw, gyro_raw, mag_raw);

// Use calibrated values
Eigen::Vector3d accel_calibrated = calibrated.accelerometer.value;
Eigen::Vector3d gyro_calibrated = calibrated.gyroscope.value;
Eigen::Vector3d mag_calibrated = calibrated.magnetometer.value;
```

## Integration with SITL

All components integrate with SITL:

1. **Robust DDP Controller**: Receives measurements from SITL, outputs actuation
2. **Enhanced EKF**: Processes simulated sensor data, estimates navigation state
3. **IMU Calibration**: Calibrates simulated IMU sensors before EKF processing

## References

- Engine Simulation Controller: `engine_sim/docs/control/`
- DDP Solver: `engine_sim/docs/control/DDP_SOLVER.md`
- EKF Navigation: `diablo_server/lib/include/nav/EKFNavigation.hpp`
