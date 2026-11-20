#ifndef RTD_MESSAGE_HPP
#define RTD_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief RTD Temperature Sensor Message
 *
 * Contains temperature measurements from RTD sensors with calibration data
 */
using RTDMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                        uint8_t,    // (1) sensor_id - RTD sensor identifier
                        double,     // (2) raw_resistance (Ohm) - raw resistance reading
                        double,     // (3) temperature (°C) - calibrated temperature
                        double,     // (4) temperature_uncertainty (°C) - measurement uncertainty
                        double,     // (5) reference_temperature (°C) - reference temperature
                        double,     // (6) calibration_quality (0-1) - calibration quality
                        bool,       // (7) calibration_valid - calibration validity
                        uint8_t,    // (8) rtd_type - RTD type (PT100, PT1000, etc.)
                        double,     // (9) self_heating_correction (°C) - self-heating correction
                        uint8_t,    // (10) sensor_health - sensor health status
                        double,     // (11) environmental_factor - environmental correction factor
                        uint64_t>;  // (12) time_monotonic (ns) - monotonic timestamp

// Function to set RTD sensor measurements
static void set_rtd_measurement(RTDMessage& message, double timestamp, uint8_t sensor_id,
                                double raw_resistance, double temperature,
                                double temperature_uncertainty, double reference_temperature,
                                double calibration_quality, bool calibration_valid,
                                uint8_t rtd_type, double self_heating_correction,
                                uint8_t sensor_health, double environmental_factor,
                                uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(sensor_id);
    message.setField<2>(raw_resistance);
    message.setField<3>(temperature);
    message.setField<4>(temperature_uncertainty);
    message.setField<5>(reference_temperature);
    message.setField<6>(calibration_quality);
    message.setField<7>(calibration_valid);
    message.setField<8>(rtd_type);
    message.setField<9>(self_heating_correction);
    message.setField<10>(sensor_health);
    message.setField<11>(environmental_factor);
    message.setField<12>(time_monotonic);
}

static RTDMessage generateTestMessageRTD() {
    RTDMessage message;
    set_rtd_measurement(message, 0.0, 1, 109.7, 25.0, 0.1, 25.0, 0.98, true, 0, 0.05, 0, 1.0, 0);
    return message;
}

// Specialized RTD messages for different locations
using RTDChamberWallMessage = RTDMessage;  // Chamber wall RTD
using RTDFuelTempMessage = RTDMessage;     // Fuel temperature RTD
using RTDOxTempMessage = RTDMessage;       // Oxidizer temperature RTD
using RTDCoolantTempMessage = RTDMessage;  // Coolant temperature RTD

#endif  // RTD_MESSAGE_HPP
