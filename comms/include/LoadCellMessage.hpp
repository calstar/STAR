#ifndef LOAD_CELL_MESSAGE_HPP
#define LOAD_CELL_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Load Cell Message
 *
 * Contains thrust measurements from load cells with calibration data
 */
using LoadCellMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                   uint8_t,    // (1) sensor_id - load cell identifier
                   double,     // (2) raw_voltage (V) - raw voltage reading
                   double,     // (3) force (N) - calibrated force measurement
                   double,     // (4) force_uncertainty (N) - measurement uncertainty
                   double,     // (5) thrust (N) - thrust measurement
                   double,     // (6) thrust_uncertainty (N) - thrust uncertainty
                   double,     // (7) calibration_quality (0-1) - calibration quality
                   bool,       // (8) calibration_valid - calibration validity
                   double,     // (9) temperature (°C) - sensor temperature
                   double,     // (10) drift_correction (N) - drift correction
                   uint8_t,    // (11) sensor_health - sensor health status
                   double,     // (12) environmental_factor - environmental correction factor
                   uint64_t>;  // (13) time_monotonic (ns) - monotonic timestamp

// Function to set load cell measurements
static void set_load_cell_measurement(LoadCellMessage& message, double timestamp, uint8_t sensor_id,
                                      double raw_voltage, double force, double force_uncertainty,
                                      double thrust, double thrust_uncertainty,
                                      double calibration_quality, bool calibration_valid,
                                      double temperature, double drift_correction,
                                      uint8_t sensor_health, double environmental_factor,
                                      uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(sensor_id);
    message.setField<2>(raw_voltage);
    message.setField<3>(force);
    message.setField<4>(force_uncertainty);
    message.setField<5>(thrust);
    message.setField<6>(thrust_uncertainty);
    message.setField<7>(calibration_quality);
    message.setField<8>(calibration_valid);
    message.setField<9>(temperature);
    message.setField<10>(drift_correction);
    message.setField<11>(sensor_health);
    message.setField<12>(environmental_factor);
    message.setField<13>(time_monotonic);
}

static LoadCellMessage generateTestMessageLoadCell() {
    LoadCellMessage message;
    set_load_cell_measurement(message, 0.0, 1, 2.5, 0.0, 10.0, 0.0, 10.0, 0.95, true, 25.0, 0.0, 0,
                              1.0, 0);
    return message;
}

// Specialized load cell messages for different locations
using ThrustLoadCellMessage = LoadCellMessage;  // Main thrust load cell
using GimbalLoadCellMessage = LoadCellMessage;  // Gimbal load cell

#endif  // LOAD_CELL_MESSAGE_HPP
