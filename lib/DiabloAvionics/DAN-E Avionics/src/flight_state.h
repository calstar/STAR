#pragma once

#include <Arduino.h>

enum class FlightState : uint8_t {
	Idle = 0,
	Launch = 1,
	Active = 2,
	Venting = 3,
};

void flightStateInit();
FlightState flightStateGet();
void flightStateTick();

/** Idle → Launch (call from main when LIS3 launch ISR fires). */
void flightStateOnLaunchDetect();

/** Launch → Active when apogee algorithm confirms (only valid from Launch). */
void flightStateOnApogee();

/** Active → Venting when Active timer expires. */
void flightStateOnActiveTimeout();

void applyActuatorOutputs();
void runNoseConeControlLoop();
