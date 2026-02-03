#ifndef FLOW_METER_MESSAGE_HPP
#define FLOW_METER_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Flow Meter Message
 *
 * Contains mass flow rate measurements from flow meters with calibration data
 */
using FlowMeterMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                   uint8_t,    // (1) sensor_id - flow meter identifier
                   double,     // (2) raw_frequency (Hz) - raw frequency reading
                   double,     // (3) mass_flow_rate (kg/s) - calibrated mass flow rate
                   double,     // (4) flow_uncertainty (kg/s) - measurement uncertainty
                   double,     // (5) volume_flow_rate (m³/s) - volume flow rate
                   double,     // (6) density (kg/m³) - fluid density
                   double,     // (7) temperature (°C) - fluid temperature
                   double,     // (8) pressure (Pa) - fluid pressure
                   double,     // (9) calibration_quality (0-1) - calibration quality
                   bool,       // (10) calibration_valid - calibration validity
                   uint8_t,    // (11) fluid_type - fluid type (fuel, oxidizer, coolant)
                   uint8_t,    // (12) sensor_health - sensor health status
                   double,     // (13) environmental_factor - environmental correction factor
                   uint64_t>;  // (14) time_monotonic (ns) - monotonic timestamp

// Function to set flow meter measurements
static void set_flow_meter_measurement(FlowMeterMessage& message, double timestamp,
                                       uint8_t sensor_id, double raw_frequency,
                                       double mass_flow_rate, double flow_uncertainty,
                                       double volume_flow_rate, double density, double temperature,
                                       double pressure, double calibration_quality,
                                       bool calibration_valid, uint8_t fluid_type,
                                       uint8_t sensor_health, double environmental_factor,
                                       uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(sensor_id);
    message.setField<2>(raw_frequency);
    message.setField<3>(mass_flow_rate);
    message.setField<4>(flow_uncertainty);
    message.setField<5>(volume_flow_rate);
    message.setField<6>(density);
    message.setField<7>(temperature);
    message.setField<8>(pressure);
    message.setField<9>(calibration_quality);
    message.setField<10>(calibration_valid);
    message.setField<11>(fluid_type);
    message.setField<12>(sensor_health);
    message.setField<13>(environmental_factor);
    message.setField<14>(time_monotonic);
}

static FlowMeterMessage generateTestMessageFlowMeter() {
    FlowMeterMessage message;
    set_flow_meter_measurement(message, 0.0, 1, 1000.0, 0.0, 0.01, 0.0, 800.0, 25.0, 101325.0, 0.95,
                               true, 0, 0, 1.0, 0);
    return message;
}

// Specialized flow meter messages for different fluids
using FuelFlowMeterMessage = FlowMeterMessage;     // Fuel flow meter
using OxFlowMeterMessage = FlowMeterMessage;       // Oxidizer flow meter
using CoolantFlowMeterMessage = FlowMeterMessage;  // Coolant flow meter

#endif  // FLOW_METER_MESSAGE_HPP
