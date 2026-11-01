// The FPGA's register map and SPI frame format, as defined in
// gateware/rtl/dvbt_host.v (the source of truth; test/host checks that the
// ID below matches it).
#pragma once
#include <stdint.h>

#define DVBT_ID             0xD7B70002u

#define DVBT_CMD_TS         0x00u           // then whole 188-byte packets
#define DVBT_CMD_WRITE(a)   (0x80u | ((a) & 0x0Fu))   // then 4 bytes, MSB first
#define DVBT_CMD_READ(a)    (0x40u | ((a) & 0x0Fu))   // then 1 dummy, 4 bytes back

enum dvbt_reg {
    DVBT_REG_CTRL    = 0,
    DVBT_REG_GAIN    = 1,
    DVBT_REG_PHASE   = 2,
    DVBT_REG_DCOFF   = 3,
    DVBT_REG_SPIDATA = 4,
    DVBT_REG_SPICFG  = 5,
    DVBT_REG_STATUS  = 6,
    DVBT_REG_ID      = 7,
    DVBT_REG_GPIO    = 8,
};

// CTRL
#define DVBT_CTRL_TX_EN         (1u << 0)
#define DVBT_CTRL_MOD(m)        (((m) & 3u) << 1)    // 0 QPSK, 1 16QAM, 2 64QAM
#define DVBT_CTRL_RATE(r)       (((r) & 7u) << 3)    // 0 1/2, 1 2/3, 2 3/4, 3 5/6, 4 7/8
#define DVBT_CTRL_GUARD(g)      (((g) & 3u) << 6)    // 0 1/32, 1 1/16, 2 1/8, 3 1/4
#define DVBT_CTRL_DAC_UNSIGNED  (1u << 8)
#define DVBT_CTRL_DAC_Q_HIGH    (1u << 9)

// SPICFG
#define DVBT_SPICFG(nbits, dev, three_wire, wr_bits, div) \
    ((((uint32_t)(nbits) - 1u) & 0x1Fu) | (((uint32_t)(dev) & 1u) << 8) | \
     (((uint32_t)(three_wire) & 1u) << 9) | (((uint32_t)(wr_bits) & 0x3Fu) << 10) | \
     (((uint32_t)(div) & 0xFFu) << 16))
#define DVBT_SPICFG_BUSY        (1u << 31)

// STATUS
#define DVBT_ST_UNDERFLOW       (1u << 0)
#define DVBT_ST_ALIGN           (1u << 1)
#define DVBT_ST_TS_BAD          (1u << 2)
#define DVBT_ST_TS_OVERFLOW     (1u << 3)
#define DVBT_ST_NULLS(v)        ((v) >> 16)
#define DVBT_ST_CLEAR_NULLS     (1u << 31)

// Status byte on MISO during every command byte
#define DVBT_SB_DREQ            0x80u
#define DVBT_SB_TX_EN           0x40u
#define DVBT_SB_UNDERFLOW       0x20u
#define DVBT_SB_ALIGN           0x10u
#define DVBT_SB_TS_BAD          0x08u
#define DVBT_SB_TS_OVERFLOW     0x04u
#define DVBT_SB_SPI_BUSY        0x02u

#define TS_PACKET               188
