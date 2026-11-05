#include "gnss_frame.h"

#include <string.h>

enum {
    IDLE = 0,
    NMEA_BODY,
    NMEA_HEX_HI,
    NMEA_HEX_LO,
    UBX_SYNC2,
    UBX_CLASS,
    UBX_ID,
    UBX_LEN_LO,
    UBX_LEN_HI,
    UBX_PAYLOAD,
    UBX_CK_A,
    UBX_CK_B
};

static int hex_value(uint8_t c) {
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    return -1;
}

static void fletcher(gnss_frame_parser_t* p, uint8_t byte) {
    p->ck_a = (uint8_t)(p->ck_a + byte);
    p->ck_b = (uint8_t)(p->ck_b + p->ck_a);
}

void gnss_frame_init(gnss_frame_parser_t* parser) {
    memset(parser, 0, sizeof(*parser));
}

static void reject(gnss_frame_parser_t* p) {
    p->rejected++;
    p->state = IDLE;
}

/* Begin a frame if this byte is a start marker; otherwise go idle. */
static void start(gnss_frame_parser_t* p, uint8_t byte) {
    if (byte == '$') {
        p->state = NMEA_BODY;
        p->xor_sum = 0;
        p->count = 0;
    } else if (byte == 0xB5) {
        p->state = UBX_SYNC2;
    } else {
        p->state = IDLE;
    }
}

gnss_frame_kind_t gnss_frame_feed(gnss_frame_parser_t* p, uint8_t byte) {
    switch (p->state) {
        case IDLE:
            start(p, byte);
            return GNSS_FRAME_NONE;

        case NMEA_BODY:
            if (byte == '*') {
                p->state = NMEA_HEX_HI;
            } else if (byte == '$') {
                reject(p); /* a new sentence cut this one short */
                start(p, byte);
            } else if (byte < 0x20 || byte > 0x7E ||
                       ++p->count > GNSS_FRAME_NMEA_MAX_BODY) {
                reject(p);
            } else {
                p->xor_sum ^= byte;
            }
            return GNSS_FRAME_NONE;

        case NMEA_HEX_HI: {
            int v = hex_value(byte);
            if (v < 0) {
                reject(p);
                return GNSS_FRAME_NONE;
            }
            p->hex_hi = (uint8_t)v;
            p->state = NMEA_HEX_LO;
            return GNSS_FRAME_NONE;
        }

        case NMEA_HEX_LO: {
            int v = hex_value(byte);
            if (v < 0 || (uint8_t)((p->hex_hi << 4) | v) != p->xor_sum) {
                reject(p);
                return GNSS_FRAME_NONE;
            }
            p->state = IDLE;
            return GNSS_FRAME_NMEA;
        }

        case UBX_SYNC2:
            if (byte == 0x62) {
                p->state = UBX_CLASS;
                p->ck_a = p->ck_b = 0;
            } else {
                start(p, byte);
            }
            return GNSS_FRAME_NONE;

        case UBX_CLASS:
            fletcher(p, byte);
            p->state = UBX_ID;
            return GNSS_FRAME_NONE;

        case UBX_ID:
            fletcher(p, byte);
            p->state = UBX_LEN_LO;
            return GNSS_FRAME_NONE;

        case UBX_LEN_LO:
            fletcher(p, byte);
            p->length = byte;
            p->state = UBX_LEN_HI;
            return GNSS_FRAME_NONE;

        case UBX_LEN_HI:
            fletcher(p, byte);
            p->length = (uint16_t)(p->length | (uint16_t)(byte << 8));
            if (p->length > GNSS_FRAME_UBX_MAX_PAYLOAD) {
                reject(p);
                return GNSS_FRAME_NONE;
            }
            p->count = 0;
            p->state = p->length ? UBX_PAYLOAD : UBX_CK_A;
            return GNSS_FRAME_NONE;

        case UBX_PAYLOAD:
            fletcher(p, byte);
            if (++p->count == p->length)
                p->state = UBX_CK_A;
            return GNSS_FRAME_NONE;

        case UBX_CK_A:
            if (byte != p->ck_a) {
                reject(p);
                return GNSS_FRAME_NONE;
            }
            p->state = UBX_CK_B;
            return GNSS_FRAME_NONE;

        case UBX_CK_B:
            if (byte != p->ck_b) {
                reject(p);
                return GNSS_FRAME_NONE;
            }
            p->state = IDLE;
            return GNSS_FRAME_UBX;

        default:
            p->state = IDLE;
            return GNSS_FRAME_NONE;
    }
}
