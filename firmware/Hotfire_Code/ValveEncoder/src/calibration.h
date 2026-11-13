#pragma once

// CLOSED / OPEN positions in NVS, so they survive reboots and reflashing.

#include "valve_state.h"

namespace calibration {

void load(valve::Calibration& cal, float default_tolerance_deg);
bool save(const valve::Calibration& cal);
void clear();

}  // namespace calibration
