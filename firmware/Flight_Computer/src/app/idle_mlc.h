#ifndef STAR_IDLE_MLC_H
#define STAR_IDLE_MLC_H

/*
 * Idle ↔ ISM330DHCX MLC wake policy (portable, host-testable).
 *
 * When MLC Idle wake is enabled, INT2/PD1 must be able to fire while the MCU
 * is in Stop. That requires the IMU accel (+ MLC) to stay out of power-down.
 *
 * Safety: MLC is hint-only. Never arm/fire pyro or drive launch/apogee from
 * MLC0_SRC / INT2.
 */

#include <stdbool.h>

#include "dev_bus.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Compile-time default: ship with MLC Idle wake on for the pad/idle drop.
 * Board bring-up can override with -DSTAR_MLC_IDLE_WAKE=0 to keep the old
 * ~3 µA IMU power-down Idle policy. */
#ifndef STAR_MLC_IDLE_WAKE
#define STAR_MLC_IDLE_WAKE 1
#endif

bool idle_mlc_wake_enabled(void);

/* True only when MLC Idle wake is OFF — then ism330_power_down is allowed. */
bool idle_mlc_imu_power_down_allowed(void);

/*
 * Call instead of bare ism330_power_down() from Idle / sensors teardown.
 * When wake is enabled: no-op, returns DEV_OK (IMU stays configured for MLC).
 * When wake is disabled: forwards to ism330_power_down(bus).
 */
int idle_mlc_maybe_power_down_imu(const dev_bus_t* bus);

#ifdef __cplusplus
}
#endif
#endif
