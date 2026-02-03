#ifndef DAQ_FILTERED_MESSAGES_HPP
#define DAQ_FILTERED_MESSAGES_HPP

#include <cstdint>
#include "../../CommsMessage.hpp"

namespace comms {
namespace messages {
namespace filtered {

// Import CommsMessage from parent namespace
using comms::CommsMessage;

/**
 * @brief Calibrated pressure transducer message
 * 
 * Contains filtered and calibrated pressure readings.
 */
using CalibratedPTMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp
    uint8_t,     // (1) channel_id - sensor channel identifier
    double,      // (2) pressure_pa - Calibrated pressure (Pascals)
    double,      // (3) temperature_c - Temperature (Celsius)
    float,       // (4) calibration_quality - Quality metric (0-1)
    uint8_t      // (5) calibration_valid - Validity flag
>;

/**
 * @brief Calibrated thermocouple message
 * 
 * Contains filtered and calibrated temperature readings.
 */
using CalibratedTCMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp
    uint8_t,     // (1) channel_id - sensor channel identifier
    double,      // (2) temperature_c - Calibrated temperature (Celsius)
    float,       // (3) calibration_quality - Quality metric (0-1)
    uint8_t      // (4) calibration_valid - Validity flag
>;

/**
 * @brief Filtered state message
 * 
 * Contains filtered sensor fusion state (combined from multiple sensors).
 */
using FilteredStateMessage = CommsMessage<
    uint64_t,    // (0) timestamp_ns - monotonic timestamp
    double,      // (1) chamber_pressure_pa - Filtered chamber pressure
    double,      // (2) exhaust_temperature_c - Filtered exhaust temperature
    double,      // (3) fuel_temperature_c - Filtered fuel temperature
    double,      // (4) oxidizer_temperature_c - Filtered oxidizer temperature
    double,      // (5) thrust_n - Estimated thrust (Newtons)
    float        // (6) state_quality - Overall state quality metric
>;

} // namespace filtered
} // namespace messages
using comms::CommsMessage;
} // namespace comms

#endif // DAQ_FILTERED_MESSAGES_HPP

