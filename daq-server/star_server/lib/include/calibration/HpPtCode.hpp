#pragma once

#include <cstdint>

namespace fsw::calibration {

/**
 * A 4-20 mA PT's wire code -> the shunt code the conversions and calibrations work in.
 *
 * The code is full scale at 2^31 against the 2.5 V internal reference, and the loop at
 * 20 mA across 120 Ohm is 2.4 V, so every reading a live loop can produce sits in
 * [0, 2^31). A code at or above 2^31 is the ADC's two's-complement NEGATIVE: the shunt
 * below 0 V, which is what an open or unpowered loop's noise does around zero.
 *
 * It used to be clamped to 2^31-1 instead -- full scale, 20 mA, 5000 psi. On 2026-11-07
 * COPV-PT-R and HPD-PT (PT board 2, connectors 1 and 3, both reading ~0 mA) produced
 * codes like 0xFFFF0FB5 (-61515) a few times a minute; each became a 5000 psi sample,
 * the output EMA turned it into a 1250 psi pulse decaying over ~1 s, and the controller
 * and the plots both received it.
 *
 * A negative code reads as no current: 0, which the conversion reports as 0 psi.
 */
inline uint32_t hp_pt_shunt_code(uint32_t wire) {
    return wire > 0x7FFFFFFFu ? 0u : wire;
}

}  // namespace fsw::calibration
