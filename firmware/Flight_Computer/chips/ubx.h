#ifndef STAR_UBX_H
#define STAR_UBX_H

/*
 * u-blox UBX protocol pieces for the MAX-M10S (MD1). Interface Description
 * "u-blox M10 SPG 5.10", UBX-21035062 R02:
 *   frame      B5 62 class id len16 payload CK_A CK_B, 8-bit Fletcher over
 *              class..payload
 *   VALSET     0x06 0x8A: version 0, layers, 2 reserved, key/value pairs
 *              (3.10.5.1, p.55); this code writes the RAM layer only, so the
 *              configuration is re-sent on every power-up
 *   ACK        0x05 0x01 ACK / 0x05 0x00 NAK, payload = acked class, id
 *   NAV-PVT    0x01 0x07, 92 bytes (3.15.11, p.95)
 * Keys used (Section 6, p.136-154): CFG-UART1-BAUDRATE 0x40520001 U4,
 * CFG-UART1OUTPROT-NMEA 0x10740002 L, CFG-MSGOUT-UBX_NAV_PVT_UART1
 * 0x20910007 U1, CFG-RATE-MEAS 0x30210001 U2 (ms), CFG-NAVSPG-DYNMODEL
 * 0x20110021 E1 (AIR4 = 8, "airborne <4g", Table 23 p.141).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define UBX_CLASS_NAV 0x01U
#define UBX_CLASS_ACK 0x05U
#define UBX_CLASS_CFG 0x06U
#define UBX_ID_NAV_PVT 0x07U
#define UBX_ID_ACK_ACK 0x01U
#define UBX_ID_ACK_NAK 0x00U
#define UBX_ID_CFG_VALSET 0x8AU
#define UBX_NAV_PVT_LEN 92U

#define UBX_KEY_UART1_BAUDRATE 0x40520001UL
#define UBX_KEY_UART1OUTPROT_NMEA 0x10740002UL
#define UBX_KEY_MSGOUT_NAV_PVT_UART1 0x20910007UL
#define UBX_KEY_RATE_MEAS 0x30210001UL
#define UBX_KEY_NAVSPG_DYNMODEL 0x20110021UL
#define UBX_DYNMODEL_AIR4 8U

typedef struct {
    uint32_t key;
    uint8_t size; /* 1, 2 or 4 bytes (L/U1/E1, U2, U4) */
    uint32_t value;
} ubx_item_t;

/* Whole frame into out; returns its length, 0 if it does not fit. */
size_t ubx_frame(uint8_t* out, size_t cap, uint8_t cls, uint8_t id,
                 const uint8_t* payload, uint16_t len);

/* UBX-CFG-VALSET to the RAM layer; returns frame length, 0 on error. */
size_t ubx_valset(uint8_t* out, size_t cap, const ubx_item_t* items,
                  size_t count);

typedef struct {
    uint32_t itow_ms;
    uint16_t year;
    uint8_t month, day, hour, min, sec, valid;
    uint8_t fix_type; /* 0 none, 2 2D, 3 3D */
    uint8_t flags;    /* bit 0 gnssFixOK */
    uint8_t num_sv;
    int32_t lon_e7, lat_e7; /* 1e-7 deg */
    int32_t height_mm, hmsl_mm;
    uint32_t hacc_mm, vacc_mm;
    int32_t vel_n_mms, vel_e_mms, vel_d_mms;
    uint32_t sacc_mms;
    uint16_t pdop_e2;
} ubx_pvt_t;

/* Decode a NAV-PVT payload (exactly 92 bytes). */
bool ubx_parse_nav_pvt(const uint8_t* payload, uint16_t len, ubx_pvt_t* out);

#ifdef __cplusplus
}
#endif
#endif
