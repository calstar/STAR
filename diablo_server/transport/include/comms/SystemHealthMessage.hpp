#ifndef SYSTEM_HEALTH_MESSAGE_HPP
#define SYSTEM_HEALTH_MESSAGE_HPP

#include <array>
#include <cstdint>

#include "CommsMessage.hpp"

/**
 * @brief System Health Message
 *
 * Contains overall system health status, fault information, and performance metrics
 */
using SystemHealthMessage =
    comms::CommsMessage<double,     // (0) timestamp (s) - timestamp
                        uint8_t,    // (1) system_status - overall system status
                        double,     // (2) system_health (0-1) - overall system health
                        uint32_t,   // (3) active_faults - number of active faults
                        uint32_t,   // (4) total_faults - total number of faults
                        double,     // (5) cpu_usage (%) - CPU usage percentage
                        double,     // (6) memory_usage (%) - memory usage percentage
                        double,     // (7) network_quality (0-1) - network communication quality
                        double,     // (8) control_performance (0-1) - control system performance
                        double,     // (9) navigation_accuracy (m) - navigation accuracy
                        double,     // (10) calibration_quality (0-1) - overall calibration quality
                        uint8_t,    // (11) emergency_status - emergency system status
                        bool,       // (12) safety_systems_ok - safety systems status
                        bool,       // (13) communication_ok - communication systems status
                        uint64_t>;  // (14) time_monotonic (ns) - monotonic timestamp

// Function to set system health measurements
static void set_system_health_measurement(SystemHealthMessage& message, double timestamp,
                                          uint8_t system_status, double system_health,
                                          uint32_t active_faults, uint32_t total_faults,
                                          double cpu_usage, double memory_usage,
                                          double network_quality, double control_performance,
                                          double navigation_accuracy, double calibration_quality,
                                          uint8_t emergency_status, bool safety_systems_ok,
                                          bool communication_ok, uint64_t time_monotonic) {
    message.setField<0>(timestamp);
    message.setField<1>(system_status);
    message.setField<2>(system_health);
    message.setField<3>(active_faults);
    message.setField<4>(total_faults);
    message.setField<5>(cpu_usage);
    message.setField<6>(memory_usage);
    message.setField<7>(network_quality);
    message.setField<8>(control_performance);
    message.setField<9>(navigation_accuracy);
    message.setField<10>(calibration_quality);
    message.setField<11>(emergency_status);
    message.setField<12>(safety_systems_ok);
    message.setField<13>(communication_ok);
    message.setField<14>(time_monotonic);
}

static SystemHealthMessage generateTestMessageSystemHealth() {
    SystemHealthMessage message;
    set_system_health_measurement(message, 0.0, 0, 0.95, 0, 0, 25.0, 45.0, 0.98, 0.92, 0.1, 0.94, 0,
                                  true, true, 0);
    return message;
}

#endif  // SYSTEM_HEALTH_MESSAGE_HPP
