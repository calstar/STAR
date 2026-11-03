#pragma once

// Saves the valve's CLOSED / OPEN encoder positions in the ESP32's flash
// (NVS, via Arduino Preferences) so they survive power cycles and reflashing.
// Set them from the USB console: turn the valve fully closed, type `c`;
// fully open, type `o`. See printHelp() in main.cpp.

#include "valve_state.h"

namespace calibration {

void load(valve::Calibration& cal, float default_tolerance_deg);
bool save(const valve::Calibration& cal);
void clear();

}  // namespace calibration
