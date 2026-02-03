#ifndef NAVIGATION_MESSAGE_HPP
#define NAVIGATION_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Navigation Message
 *
 * Contains navigation state from EKF with position, velocity, attitude, and engine state
 */
using NavigationMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                   double,     // (1) position_x (m) - X position
                   double,     // (2) position_y (m) - Y position
                   double,     // (3) position_z (m) - Z position
                   double,     // (4) velocity_x (m/s) - X velocity
                   double,     // (5) velocity_y (m/s) - Y velocity
                   double,     // (6) velocity_z (m/s) - Z velocity
                   double,     // (7) attitude_qw - quaternion W component
                   double,     // (8) attitude_qx - quaternion X component
                   double,     // (9) attitude_qy - quaternion Y component
                   double,     // (10) attitude_qz - quaternion Z component
                   double,     // (11) angular_velocity_x (rad/s) - X angular velocity
                   double,     // (12) angular_velocity_y (rad/s) - Y angular velocity
                   double,     // (13) angular_velocity_z (rad/s) - Z angular velocity
                   double,     // (14) acceleration_x (m/s²) - X acceleration
                   double,     // (15) acceleration_y (m/s²) - Y acceleration
                   double,     // (16) acceleration_z (m/s²) - Z acceleration
                   double,     // (17) engine_thrust (N) - engine thrust
                   double,     // (18) engine_mass (kg) - vehicle mass
                   double,     // (19) navigation_quality (0-1) - navigation quality
                   uint8_t,    // (20) navigation_mode - navigation mode
                   bool,       // (21) navigation_valid - navigation validity
                   uint64_t>;  // (22) time_monotonic (ns) - monotonic timestamp

// Function to set navigation measurements
static void set_navigation_measurement(
    NavigationMessage& message, double timestamp, double position_x, double position_y,
    double position_z, double velocity_x, double velocity_y, double velocity_z, double attitude_qw,
    double attitude_qx, double attitude_qy, double attitude_qz, double angular_velocity_x,
    double angular_velocity_y, double angular_velocity_z, double acceleration_x,
    double acceleration_y, double acceleration_z, double engine_thrust, double engine_mass,
    double navigation_quality, uint8_t navigation_mode, bool navigation_valid,
    uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(position_x);
    message.setField<2>(position_y);
    message.setField<3>(position_z);
    message.setField<4>(velocity_x);
    message.setField<5>(velocity_y);
    message.setField<6>(velocity_z);
    message.setField<7>(attitude_qw);
    message.setField<8>(attitude_qx);
    message.setField<9>(attitude_qy);
    message.setField<10>(attitude_qz);
    message.setField<11>(angular_velocity_x);
    message.setField<12>(angular_velocity_y);
    message.setField<13>(angular_velocity_z);
    message.setField<14>(acceleration_x);
    message.setField<15>(acceleration_y);
    message.setField<16>(acceleration_z);
    message.setField<17>(engine_thrust);
    message.setField<18>(engine_mass);
    message.setField<19>(navigation_quality);
    message.setField<20>(navigation_mode);
    message.setField<21>(navigation_valid);
    message.setField<22>(time_monotonic);
}

static NavigationMessage generateTestMessageNavigation() {
    NavigationMessage message;
    set_navigation_measurement(message, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
                               0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1000.0, 0.95, 0, true, 0);
    return message;
}

#endif  // NAVIGATION_MESSAGE_HPP
