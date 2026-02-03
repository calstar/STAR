#ifndef IMU_MESSAGE_HPP
#define IMU_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief IMU (Inertial Measurement Unit) sensor message
 * Contains accelerometer and gyroscope data
 */
using IMUMessage = comms::CommsMessage<double,     // (0) time_imu (s) - timestamp
                                  double,     // (1) accel_x (m/s^2) - x-axis acceleration
                                  double,     // (2) accel_y (m/s^2) - y-axis acceleration
                                  double,     // (3) accel_z (m/s^2) - z-axis acceleration
                                  double,     // (4) gyro_x (rad/s) - x-axis angular velocity
                                  double,     // (5) gyro_y (rad/s) - y-axis angular velocity
                                  double,     // (6) gyro_z (rad/s) - z-axis angular velocity
                                  uint64_t>;  // (7) time_monotonic (ns) - monotonic timestamp

// Function to set IMU measurements
static void set_imu_measurement(IMUMessage& message, double time_imu,
                                const std::array<double, 3>& accelerometer,
                                const std::array<double, 3>& gyroscope, uint64_t time_monotonic) {
    message.setField<0>(time_imu);
    message.setField<1>(accelerometer[0]);
    message.setField<2>(accelerometer[1]);
    message.setField<3>(accelerometer[2]);
    message.setField<4>(gyroscope[0]);
    message.setField<5>(gyroscope[1]);
    message.setField<6>(gyroscope[2]);
    message.setField<7>(time_monotonic);
}

static IMUMessage generateTestMessageIMU() {
    IMUMessage message;
    std::array<double, 3> accel = {0.0, 0.0, 9.81};  // Gravity
    std::array<double, 3> gyro = {0.0, 0.0, 0.0};    // No rotation
    set_imu_measurement(message, 0.0, accel, gyro, 0);
    return message;
}

#endif  // IMU_MESSAGE_HPP
