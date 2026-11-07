#ifndef STAR_GNSS_FRAME_H
#define STAR_GNSS_FRAME_H

/*
 * Byte-at-a-time validator for what a u-blox M10 sends on its UART:
 *
 *   NMEA  $<body>*<HH>      HH = XOR of every body byte (between $ and *)
 *   UBX   B5 62 <class> <id> <len16 LE> <payload> <CK_A> <CK_B>
 *         CK = 8-bit Fletcher over class..payload
 *
 * Portable (no HAL): the board feeds it UART bytes, the host tests feed it
 * strings. It only proves a well-formed frame arrived, not a position fix.
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    GNSS_FRAME_NONE = 0, /* no complete valid frame ended at this byte */
    GNSS_FRAME_NMEA,
    GNSS_FRAME_UBX
} gnss_frame_kind_t;

#define GNSS_FRAME_NMEA_MAX_BODY 96U /* NMEA 0183 says 82 incl. $ and CRLF */
#define GNSS_FRAME_UBX_MAX_PAYLOAD 1024U
/* NAV-PVT is 92; NAV-SAT is 8 + 12 per satellite, so 488 holds 40. */
#define GNSS_FRAME_UBX_CAPTURE 488U

typedef struct {
    uint8_t state;
    uint8_t xor_sum;
    uint8_t ck_a;
    uint8_t ck_b;
    uint8_t hex_hi;
    uint16_t count;
    uint16_t length;
    uint32_t rejected; /* frames that started but failed a check */
    /* Last UBX frame: valid when gnss_frame_feed() returns GNSS_FRAME_UBX.
     * Payloads longer than GNSS_FRAME_UBX_CAPTURE keep only the first bytes
     * (ubx_len says the real length). */
    uint8_t ubx_class, ubx_id;
    uint16_t ubx_len;
    uint8_t ubx_payload[GNSS_FRAME_UBX_CAPTURE];
} gnss_frame_parser_t;

void gnss_frame_init(gnss_frame_parser_t* parser);
gnss_frame_kind_t gnss_frame_feed(gnss_frame_parser_t* parser, uint8_t byte);

#ifdef __cplusplus
}
#endif
#endif
