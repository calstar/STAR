#ifndef ENCODER_MESSAGE_HPP
#define ENCODER_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Encoder Message
 *
 * Contains encoder position and velocity measurements with calibration data
 */
using EncoderMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                   uint8_t,    // (1) encoder_id - encoder identifier
                   uint8_t,    // (2) encoder_type - encoder type (incremental, absolute, etc.)
                   int32_t,    // (3) raw_counts - raw encoder counts
                   double,     // (4) position (0-1) - calibrated position (0-1)
                   double,     // (5) position_uncertainty - position uncertainty
                   double,     // (6) velocity (1/s) - calibrated velocity
                   double,     // (7) velocity_uncertainty - velocity uncertainty
                   double,     // (8) angular_position (rad) - angular position
                   double,     // (9) angular_velocity (rad/s) - angular velocity
                   double,     // (10) calibration_quality (0-1) - calibration quality
                   bool,       // (11) calibration_valid - calibration validity
                   uint8_t,    // (12) encoder_health - encoder health status
                   double,     // (13) drift_detected - drift detection flag
                   uint64_t>;  // (14) time_monotonic (ns) - monotonic timestamp

// Function to set encoder measurements
static void set_encoder_measurement(EncoderMessage& message, double timestamp, uint8_t encoder_id,
                                    uint8_t encoder_type, int32_t raw_counts, double position,
                                    double position_uncertainty, double velocity,
                                    double velocity_uncertainty, double angular_position,
                                    double angular_velocity, double calibration_quality,
                                    bool calibration_valid, uint8_t encoder_health,
                                    double drift_detected, uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(encoder_id);
    message.setField<2>(encoder_type);
    message.setField<3>(raw_counts);
    message.setField<4>(position);
    message.setField<5>(position_uncertainty);
    message.setField<6>(velocity);
    message.setField<7>(velocity_uncertainty);
    message.setField<8>(angular_position);
    message.setField<9>(angular_velocity);
    message.setField<10>(calibration_quality);
    message.setField<11>(calibration_valid);
    message.setField<12>(encoder_health);
    message.setField<13>(drift_detected);
    message.setField<14>(time_monotonic);
}

static EncoderMessage generateTestMessageEncoder() {
    EncoderMessage message;
    set_encoder_measurement(message, 0.0, 1, 0, 0, 0.0, 0.01, 0.0, 0.01, 0.0, 0.0, 0.95, true, 0,
                            0.0, 0);
    return message;
}

// Specialized encoder messages for different valves
using FuelValveEncoderMessage = EncoderMessage;  // Fuel valve encoder
using OxValveEncoderMessage = EncoderMessage;    // Oxidizer valve encoder
using GimbalXEncoderMessage = EncoderMessage;    // Gimbal X encoder
using GimbalYEncoderMessage = EncoderMessage;    // Gimbal Y encoder

#endif  // ENCODER_MESSAGE_HPP
