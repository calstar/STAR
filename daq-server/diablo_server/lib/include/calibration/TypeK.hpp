#pragma once

// Type K thermocouple curve, shared by calibration_service (ESP32 TC boards) and t7_bridge.
//
// One set of numbers, used both ways. type_k_c_from_mv() is the NIST ITS-90 type K inverse that
// calibration_service has always applied (moved here unchanged). type_k_mv_from_c(), needed for
// cold-junction compensation, is that same function solved for millivolts rather than a second
// polynomial, so the two directions cannot disagree with each other.

namespace fsw {
namespace calibration {

/** Lowest and highest EMF the inverse covers (mV): -250 C to 1372 C. */
constexpr double kTypeKMinMv = -6.404;
constexpr double kTypeKMaxMv = 69.553;

/** Temperature (C) for a type K EMF in mV, referenced to 0 C. NaN outside the curve. */
double type_k_c_from_mv(double mv);

/** EMF (mV, referenced to 0 C) a type K produces at `c`. NaN outside the curve. */
double type_k_mv_from_c(double c);

}  // namespace calibration
}  // namespace fsw
