#ifndef BAROMETER_MESSAGE_HPP
#define BAROMETER_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief Barometer sensor message
 * Measures atmospheric pressure and derived altitude
 */
using BarometerMessage = comms::CommsMessage<double,     // (0) time_bar (s) - timestamp
                                        double,     // (1) pressure (Pa) - atmospheric pressure
                                        double,     // (2) altitude (m) - derived altitude
                                        double,     // (3) temperature (C) - temperature reading
                                        uint64_t>;  // (4) time_monotonic (ns) - monotonic timestamp

// Function to set barometer measurements
static void set_barometer_measurement(BarometerMessage& message, double time_bar, double pressure,
                                      double altitude, double temperature,
                                      uint64_t time_monotonic) {
    message.setField<0>(time_bar);
    message.setField<1>(pressure);
    message.setField<2>(altitude);
    message.setField<3>(temperature);
    message.setField<4>(time_monotonic);
}

static BarometerMessage generateTestMessageBarometer() {
    BarometerMessage message;
    set_barometer_measurement(message, 0.0, 101325.0, 0.0, 25.0, 0);
    return message;
}

#endif  // BAROMETER_MESSAGE_HPP
