#pragma once

#include <Arduino.h>
#include <SPIMemory.h>

#include "flight_state.h"

bool flightLogInit(SPIFlash &flash, uint32_t capacityBytes);

bool sensorsShouldLog();

void logFlightStateTransition(FlightState from, FlightState to, uint32_t t_ms, uint8_t reason);

void logMcp3201(uint16_t raw, float psi, uint32_t t_ms);
void logLis3dh(float ax_g, float ay_g, float az_g, uint32_t t_ms);
void logLps28dfw(float hpa, float temp_c, float alt_m, uint32_t t_ms);
void logIsm330(float ax, float ay, float az, float gx, float gy, float gz, uint32_t t_ms);

void flightLogService();
