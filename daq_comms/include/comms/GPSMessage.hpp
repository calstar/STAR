#ifndef GPS_MESSAGE_HPP
#define GPS_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief GPS Position message
 */
using GPSPositionMessage =
    comms::CommsMessage<uint64_t,  // (0) time_monotonic (ns) - monotonic timestamp
                        uint32_t,  // (1) time_gps (ms) - GPS time
                        uint32_t,  // (2) status - GPS status
                        double,    // (3) latitude (deg) - latitude
                        double,    // (4) longitude (deg) - longitude
                        double,    // (5) altitude (m) - altitude
                        float,     // (6) horizontal_accuracy (m) - horizontal accuracy
                        float,     // (7) vertical_accuracy (m) - vertical accuracy
                        uint8_t>;  // (8) satellites_used - number of satellites

/**
 * @brief GPS Velocity message
 */
using GPSVelocityMessage =
    comms::CommsMessage<uint64_t,  // (0) time_monotonic (ns) - monotonic timestamp
                        uint32_t,  // (1) time_gps (s) - GPS time
                        float,     // (2) velocity_x (m/s) - x velocity
                        float,     // (3) velocity_y (m/s) - y velocity
                        float,     // (4) velocity_z (m/s) - z velocity
                        float>;    // (5) speed_accuracy (m/s) - speed accuracy

// Function to set GPS position measurements
static void set_gps_position_measurement(GPSPositionMessage& message, uint32_t time_gps,
                                         uint32_t status, double latitude, double longitude,
                                         double altitude, float horizontal_accuracy,
                                         float vertical_accuracy, uint8_t satellites_used,
                                         uint64_t time_monotonic) {
    message.setField<0>(time_monotonic);
    message.setField<1>(time_gps);
    message.setField<2>(status);
    message.setField<3>(latitude);
    message.setField<4>(longitude);
    message.setField<5>(altitude);
    message.setField<6>(horizontal_accuracy);
    message.setField<7>(vertical_accuracy);
    message.setField<8>(satellites_used);
}

// Function to set GPS velocity measurements
static void set_gps_velocity_measurement(GPSVelocityMessage& message, uint32_t time_gps,
                                         float velocity_x, float velocity_y, float velocity_z,
                                         float speed_accuracy, uint64_t time_monotonic) {
    message.setField<0>(time_monotonic);
    message.setField<1>(time_gps);
    message.setField<2>(velocity_x);
    message.setField<3>(velocity_y);
    message.setField<4>(velocity_z);
    message.setField<5>(speed_accuracy);
}

static GPSPositionMessage generateTestMessageGPSPosition() {
    GPSPositionMessage message;
    set_gps_position_measurement(message, 123456789, 1, 37.7749, -122.4194, 10.0, 2.5, 3.0, 8, 0);
    return message;
}

static GPSVelocityMessage generateTestMessageGPSVelocity() {
    GPSVelocityMessage message;
    set_gps_velocity_measurement(message, 123456789, 1.0, 0.5, 0.0, 0.5, 0);
    return message;
}

#endif  // GPS_MESSAGE_HPP
