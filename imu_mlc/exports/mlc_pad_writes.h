/* Converted from imu_mlc/exports/mlc_pad.ucf — feature-threshold bring-up
 * Bit masks: MD2 INT2_EMB_FUNC=0x02; MLC_ODR 26Hz=0x10; MLC_INIT=0x10.
 * Bring-up only until MEMS Studio emits a full still/handled/vibration .ucf.
 * Do not invent flight-event trees. */
#ifndef STAR_MLC_PAD_WRITES_H
#define STAR_MLC_PAD_WRITES_H

#include <stddef.h>

#include "dev_ism330dhcx_mlc.h"

static const ism330_mlc_write_t mlc_pad_writes[] = {
    {ISM330_MLC_OP_WRITE, 0x01, 0x80},
    {ISM330_MLC_OP_WRITE, 0x05, 0x10},
    {ISM330_MLC_OP_WRITE, 0x60, 0x10},
    {ISM330_MLC_OP_WRITE, 0x67, 0x10},
    {ISM330_MLC_OP_WAIT_MS, 0x00, 10},
    {ISM330_MLC_OP_WRITE, 0x11, 0x01},
    {ISM330_MLC_OP_WRITE, 0x01, 0x00},
    {ISM330_MLC_OP_WRITE, 0x5F, 0x02},
};

static const size_t mlc_pad_writes_len =
    sizeof(mlc_pad_writes) / sizeof(mlc_pad_writes[0]);

#endif
