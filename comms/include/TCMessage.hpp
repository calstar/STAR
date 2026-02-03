#ifndef TC_MESSAGE_HPP
#define TC_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Thermocouple Temperature Sensor Message
 *
 * Contains temperature measurements from thermocouple sensors with calibration data
 */
using TCMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                   uint8_t,    // (1) sensor_id - TC sensor identifier
                   double,     // (2) raw_voltage (mV) - raw voltage reading
                   double,     // (3) temperature (°C) - calibrated temperature
                   double,     // (4) temperature_uncertainty (°C) - measurement uncertainty
                   double,     // (5) cold_junction_temp (°C) - cold junction temperature
                   double,     // (6) calibration_quality (0-1) - calibration quality
                   bool,       // (7) calibration_valid - calibration validity
                   uint8_t,    // (8) tc_type - thermocouple type (K, J, T, etc.)
                   double,     // (9) linearity_correction (°C) - linearity correction
                   uint8_t,    // (10) sensor_health - sensor health status
                   double,     // (11) environmental_factor - environmental correction factor
                   uint64_t>;  // (12) time_monotonic (ns) - monotonic timestamp

// Function to set TC sensor measurements
static void set_tc_measurement(TCMessage& message, double timestamp, uint8_t sensor_id,
                               double raw_voltage, double temperature,
                               double temperature_uncertainty, double cold_junction_temp,
                               double calibration_quality, bool calibration_valid, uint8_t tc_type,
                               double linearity_correction, uint8_t sensor_health,
                               double environmental_factor, uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(sensor_id);
    message.setField<2>(raw_voltage);
    message.setField<3>(temperature);
    message.setField<4>(temperature_uncertainty);
    message.setField<5>(cold_junction_temp);
    message.setField<6>(calibration_quality);
    message.setField<7>(calibration_valid);
    message.setField<8>(tc_type);
    message.setField<9>(linearity_correction);
    message.setField<10>(sensor_health);
    message.setField<11>(environmental_factor);
    message.setField<12>(time_monotonic);
}

static TCMessage generateTestMessageTC() {
    TCMessage message;
    set_tc_measurement(message, 0.0, 1, 1.0, 25.0, 0.2, 25.0, 0.97, true, 0, 0.1, 0, 1.0, 0);
    return message;
}

// Specialized TC messages for different locations
using TCExhaustMessage = TCMessage;  // Exhaust gas TC
using TCChamberMessage = TCMessage;  // Chamber gas TC
using TCCoolantMessage = TCMessage;  // Coolant TC

#endif  // TC_MESSAGE_HPP