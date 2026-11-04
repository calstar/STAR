#pragma once

// T7 volts -> engineering units: psi for a PT, kg for a load cell, C for a type K thermocouple.
// The same units, and the same Elodin field names, as the ESP32 boards' calibrated tables, so the
// GUI can treat a T7 channel as one more PT / LC / TC.
//
// Every function returns NaN when it cannot produce a number (a missing parameter, a reading off
// the end of a thermocouple curve); the caller publishes nothing rather than a plausible zero.

#include "config/T7Config.hpp"

namespace fsw {
namespace t7 {

/**
 * The T7's internal temperature sensor reads on AIN14 at about -92.379 K/V, nominal (LabJack's
 * T7 calibration defaults, labjack/labjack_kipling t7_calibration_operations.js "Temp Slope";
 * each unit varies by up to ~1%). The offset is taken per unit at stream start instead of from the
 * nominal 465.129 K: t7_bridge reads the device's own calibrated TEMPERATURE_DEVICE_K beside AIN14
 * and solves for it, so the nominal slope only has to hold over the few kelvin the box drifts.
 */
constexpr double kAin14SlopeKPerV = -92.379;

/** AIN14 offset (K) that makes slope*ain14_v land on the device's own temperature reading. */
double cjc_device_offset_k(double device_temp_k, double ain14_v);

/** Cold-junction temperature (C) from a streamed AIN14 reading. */
double cjc_temp_c(double ain14_v, double device_offset_k, double cjc_offset_k);

/** PT: linear between the signal's zero and full-scale outputs. */
double pt_psi(double volts, const config::T7Channel& ch);

/** LC: a bridge's output is sensitivity x excitation at rated load. */
double lc_kg(double volts, const config::T7Channel& ch);

/** Type K thermocouple: the measured EMF plus the EMF the cold junction subtracts. */
double tc_c(double volts, double cold_junction_c);

/** RTD on an LJTick-Resistance: the divider's output volts -> the RTD's ohms. NaN outside
 *  (0, vref_v), where the divider cannot be inverted (open or shorted RTD). */
double rtd_ohms(double volts, const config::T7Channel& ch);

/** RTD: ohms -> C on the IEC 60751 curve (full Callendar-Van Dusen, C term below 0 C). */
double rtd_c(double volts, const config::T7Channel& ch);

/** The Elodin field a calibrated channel of this kind publishes ("pressure_psi", ...), or ""
 *  for a kind with no calibrated table (VOLTAGE). Same names as the ESP32 boards' tables. */
const char* calibrated_field(const std::string& kind);

}  // namespace t7
}  // namespace fsw
