#ifndef COMMS_MESSAGES_HPP
#define COMMS_MESSAGES_HPP

/**
 * @brief Central message header for all communication messages
 *
 * Messages are organized by domain:
 * - sensor: Raw sensor data (PT, TC, RTD, LC)
 * - flight: Navigation and attitude data
 * - control: Actuator commands and control state
 * - filtered: Calibrated and filtered sensor data
 */

// Sensor messages
#include "sensor/SensorMessages.hpp"

// Flight messages
#include "flight/FlightMessages.hpp"

// Control messages
#include "control/ControlMessages.hpp"

// Filtered messages
#include "filtered/FilteredMessages.hpp"

namespace comms {
namespace messages {

// Convenience aliases in main messages namespace
using sensor::RawLCMessage;
using sensor::RawPTMessage;
using sensor::RawRTDMessage;
using sensor::RawTCMessage;

using flight::AttitudeMessage;
using flight::NavigationMessage;

using control::ActuatorCommandMessage;
using control::ControlStateMessage;

using filtered::CalibratedPTMessage;
using filtered::CalibratedTCMessage;
using filtered::FilteredStateMessage;

}  // namespace messages
}  // namespace comms

#endif  // COMMS_MESSAGES_HPP
