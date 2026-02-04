#ifndef DAQ_FLIGHT_MESSAGES_HPP
#define DAQ_FLIGHT_MESSAGES_HPP

#include <cstdint>

#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace flight {

/**
 * @brief Navigation state message
 *
 * Contains position, velocity, attitude, and acceleration in NED frame.
 * This will be populated by the navigation subsystem.
 */
using NavigationMessage =
    CommsMessage<uint64_t,  // (0) timestamp_ns - monotonic timestamp
                 double,    // (1) position_ned_x - North position (m)
                 double,    // (2) position_ned_y - East position (m)
                 double,    // (3) position_ned_z - Down position (m, altitude)
                 double,    // (4) velocity_ned_x - North velocity (m/s)
                 double,    // (5) velocity_ned_y - East velocity (m/s)
                 double,    // (6) velocity_ned_z - Down velocity (m/s)
                 double,    // (7) quaternion_w - Attitude quaternion (w component)
                 double,    // (8) quaternion_x - Attitude quaternion (x component)
                 double,    // (9) quaternion_y - Attitude quaternion (y component)
                 double,    // (10) quaternion_z - Attitude quaternion (z component)
                 double,    // (11) acceleration_ned_x - North acceleration (m/s²)
                 double,    // (12) acceleration_ned_y - East acceleration (m/s²)
                 double     // (13) acceleration_ned_z - Down acceleration (m/s²)
                 >;

/**
 * @brief Attitude message
 *
 * Contains orientation in quaternion and Euler angles.
 */
using AttitudeMessage = CommsMessage<uint64_t,  // (0) timestamp_ns - monotonic timestamp
                                     double,    // (1) quaternion_w
                                     double,    // (2) quaternion_x
                                     double,    // (3) quaternion_y
                                     double,    // (4) quaternion_z
                                     double,    // (5) roll_rad - Roll angle (radians)
                                     double,    // (6) pitch_rad - Pitch angle (radians)
                                     double     // (7) yaw_rad - Yaw angle (radians)
                                     >;

}  // namespace flight
}  // namespace messages
using comms::CommsMessage;
}  // namespace comms

#endif  // DAQ_FLIGHT_MESSAGES_HPP
