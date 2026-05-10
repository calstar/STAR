#include "flight_state.h"

#include "apogee.h"
#include "config.h"
#include "flight_log.h"
#include "pins.h"

static FlightState s_state = FlightState::Idle;
static uint32_t s_activeEnterMs = 0;

static void driveAllSolenoids(bool high) {
	const int pins[] = {
		PIN_DRIVE_1, PIN_DRIVE_2, PIN_DRIVE_3,
		PIN_DRIVE_4, PIN_DRIVE_5, PIN_DRIVE_6,
	};
	for (int p : pins)
		digitalWrite(p, high ? HIGH : LOW);
}

void flightStateInit() {
	const int pins[] = {
		PIN_DRIVE_1, PIN_DRIVE_2, PIN_DRIVE_3,
		PIN_DRIVE_4, PIN_DRIVE_5, PIN_DRIVE_6,
	};
	for (int p : pins) {
		pinMode(p, OUTPUT);
		digitalWrite(p, LOW);
	}
}

FlightState flightStateGet() {
	return s_state;
}

static void transitionTo(FlightState to, uint8_t reason) {
	FlightState from = s_state;
	if (from == to)
		return;
	s_state = to;
	logFlightStateTransition(from, to, millis(), reason);
}

void flightStateOnLaunchDetect() {
	if (s_state != FlightState::Idle)
		return;
	apogeeReset();
	transitionTo(FlightState::Launch, 1);
}

void flightStateOnApogee() {
	if (s_state != FlightState::Launch)
		return;
	apogeeReset();
	transitionTo(FlightState::Active, 2);
	s_activeEnterMs = millis();
}

void flightStateOnActiveTimeout() {
	if (s_state != FlightState::Active)
		return;
	transitionTo(FlightState::Venting, 3);
}

void flightStateTick() {
	if (s_state != FlightState::Active)
		return;
	if (millis() - s_activeEnterMs >= ACTIVE_DURATION_MS)
		flightStateOnActiveTimeout();
}

void runNoseConeControlLoop() {
	// Stub: selective thruster control — all valves stay LOW until implemented.
}

void applyActuatorOutputs() {
	switch (s_state) {
	case FlightState::Idle:
	case FlightState::Launch:
		driveAllSolenoids(false);
		break;
	case FlightState::Active:
		runNoseConeControlLoop();
		driveAllSolenoids(false);
		break;
	case FlightState::Venting:
		driveAllSolenoids(true);
		break;
	}
}
