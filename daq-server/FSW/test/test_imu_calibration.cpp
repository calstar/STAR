#include <iostream>
#include <random>
#include <vector>

#include "../include/calibration/IMUCalibration.hpp"

using namespace fsw::calibration;

int main() {
    std::cout << "=== IMU Calibration Test ===" << std::endl;

    // Create calibration system
    IMUCalibrationSystem calib_system;

    // Generate synthetic calibration data
    std::random_device rd;
    std::mt19937 gen(rd());
    std::normal_distribution<double> noise(0.0, 0.1);

    // Accelerometer calibration data (6 positions)
    std::cout << "Generating accelerometer calibration data..." << std::endl;
    std::vector<IMUCalibration::RawReading> accel_readings;
    Eigen::Vector3d gravity(0.0, 0.0, 9.81);

    // 6 orientations: +X, -X, +Y, -Y, +Z, -Z
    std::vector<Eigen::Vector3d> orientations = {
        Eigen::Vector3d(1.0, 0.0, 0.0), Eigen::Vector3d(-1.0, 0.0, 0.0),
        Eigen::Vector3d(0.0, 1.0, 0.0), Eigen::Vector3d(0.0, -1.0, 0.0),
        Eigen::Vector3d(0.0, 0.0, 1.0), Eigen::Vector3d(0.0, 0.0, -1.0)};

    for (const auto& orient : orientations) {
        IMUCalibration::RawReading reading;
        reading.value = orient * 9.81 + Eigen::Vector3d(noise(gen), noise(gen), noise(gen));
        reading.temperature = 25.0;
        reading.timestamp = std::chrono::steady_clock::now();
        accel_readings.push_back(reading);
    }

    // Gyroscope calibration data (zero velocity)
    std::cout << "Generating gyroscope calibration data..." << std::endl;
    std::vector<IMUCalibration::RawReading> gyro_readings;
    for (int i = 0; i < 100; ++i) {
        IMUCalibration::RawReading reading;
        reading.value = Eigen::Vector3d(noise(gen), noise(gen), noise(gen)) * 0.01;  // Small bias
        reading.temperature = 25.0;
        reading.timestamp = std::chrono::steady_clock::now();
        gyro_readings.push_back(reading);
    }

    // Magnetometer calibration data (multiple orientations)
    std::cout << "Generating magnetometer calibration data..." << std::endl;
    std::vector<IMUCalibration::RawReading> mag_readings;
    Eigen::Vector3d reference_field(1.0, 0.0, 0.0);  // North

    for (int i = 0; i < 12; ++i) {
        double angle = i * M_PI / 6.0;
        Eigen::Vector3d field(std::cos(angle), std::sin(angle), 0.0);

        IMUCalibration::RawReading reading;
        reading.value = field + Eigen::Vector3d(noise(gen), noise(gen), noise(gen)) * 0.01;
        reading.temperature = 25.0;
        reading.timestamp = std::chrono::steady_clock::now();
        mag_readings.push_back(reading);
    }

    // Perform calibration
    std::cout << "\nPerforming calibration..." << std::endl;
    bool success =
        calib_system.calibrateAll(accel_readings, gyro_readings, mag_readings, reference_field);

    if (!success) {
        std::cerr << "❌ Calibration failed" << std::endl;
        return 1;
    }

    // Check calibration status
    auto status = calib_system.getStatus();
    std::cout << "Calibration Status:" << std::endl;
    std::cout << "  Accelerometer: " << static_cast<int>(status.accel) << std::endl;
    std::cout << "  Gyroscope: " << static_cast<int>(status.gyro) << std::endl;
    std::cout << "  Magnetometer: " << static_cast<int>(status.mag) << std::endl;

    // Test calibrated readings
    std::cout << "\nTesting calibrated readings..." << std::endl;
    IMUCalibration::RawReading accel_raw, gyro_raw, mag_raw;
    accel_raw.value = Eigen::Vector3d(0.1, 0.2, 9.8);
    accel_raw.temperature = 25.0;
    accel_raw.timestamp = std::chrono::steady_clock::now();

    gyro_raw.value = Eigen::Vector3d(0.01, 0.02, 0.03);
    gyro_raw.temperature = 25.0;
    gyro_raw.timestamp = std::chrono::steady_clock::now();

    mag_raw.value = Eigen::Vector3d(0.9, 0.1, 0.0);
    mag_raw.temperature = 25.0;
    mag_raw.timestamp = std::chrono::steady_clock::now();

    auto calibrated = calib_system.calibrateIMU(accel_raw, gyro_raw, mag_raw);

    std::cout << "Calibrated Accelerometer: [" << calibrated.accelerometer.value(0) << ", "
              << calibrated.accelerometer.value(1) << ", " << calibrated.accelerometer.value(2)
              << "]" << std::endl;
    std::cout << "Calibrated Gyroscope: [" << calibrated.gyroscope.value(0) << ", "
              << calibrated.gyroscope.value(1) << ", " << calibrated.gyroscope.value(2) << "]"
              << std::endl;
    std::cout << "Calibrated Magnetometer: [" << calibrated.magnetometer.value(0) << ", "
              << calibrated.magnetometer.value(1) << ", " << calibrated.magnetometer.value(2) << "]"
              << std::endl;

    std::cout << "\n✅ IMU Calibration test completed successfully" << std::endl;
    return 0;
}
