#ifndef STAR_ISM330_MLC_GLUE_SKETCH_H
#define STAR_ISM330_MLC_GLUE_SKETCH_H

/*
 * Call-site sketch — copy into the board bring-up / sensors init path.
 *
 * After ism330_init, load the pad/idle MLC program and leave the IMU awake
 * if Idle will use INT2/PD1 as a Stop wake source.
 *
 *   board-ready: ism330_mlc_load + INT2 routing + EXTI1 route + no power-down
 *   needs MEMS Studio: replace mlc_pad.ucf body with a real tree export before
 *                      trusting MLC0_SRC class codes on silicon
 *
 * Hint only — never pyro / launch / apogee.
 */

#include "dev_ism330dhcx.h"
#include "dev_ism330dhcx_mlc.h"
#include "idle_mlc.h"
#include "mlc_pad_writes.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Example: call once after SPI3 / board_devbus is ready. */
static inline int ism330_mlc_pad_idle_bringup(const dev_bus_t* bus) {
    int err = ism330_init(bus);
    if (err != DEV_OK) {
        return err;
    }
    err = ism330_mlc_load(bus, mlc_pad_writes, mlc_pad_writes_len);
    if (err != DEV_OK) {
        return err;
    }
    /* Intentionally do not power down when MLC Idle wake is enabled. */
    (void)idle_mlc_maybe_power_down_imu(bus);
    return DEV_OK;
}

#ifdef __cplusplus
}
#endif
#endif
