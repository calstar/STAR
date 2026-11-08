#include "usb_frame.h"

#include <string.h>

static uint16_t crc16(const uint8_t* d, size_t n) { /* CCITT-FALSE */
    uint16_t c = 0xFFFF;
    while (n--) {
        c ^= (uint16_t)(*d++ << 8);
        for (int i = 0; i < 8; ++i) {
            c = (c & 0x8000U) ? (uint16_t)((c << 1) ^ 0x1021U)
                              : (uint16_t)(c << 1);
        }
    }
    return c;
}

/* The same COBS as the GUI's protocol.rs. */
static size_t cobs_encode(const uint8_t* s, size_t n, uint8_t* d) {
    size_t code_at = 0, o = 1;
    uint8_t code = 1;
    for (size_t i = 0; i < n; ++i) {
        if (s[i] != 0) {
            d[o++] = s[i];
            ++code;
        }
        if (s[i] == 0 || code == 0xFF) {
            d[code_at] = code;
            code_at = o++;
            code = 1;
        }
    }
    d[code_at] = code;
    return o;
}

size_t usb_frame_encode(uint8_t type, uint8_t seq, const uint8_t* payload,
                        uint16_t len, uint8_t* out) {
    static uint8_t raw[USB_FRAME_MAX];
    if (len + 4U > sizeof raw) {
        return 0;
    }
    raw[0] = type;
    raw[1] = seq;
    memcpy(raw + 2, payload, len);
    uint16_t crc = crc16(raw, len + 2U);
    raw[len + 2U] = (uint8_t)crc;
    raw[len + 3U] = (uint8_t)(crc >> 8);
    size_t n = cobs_encode(raw, len + 4U, out);
    out[n++] = 0;
    return n;
}

int usb_frame_decode(uint8_t* buf, size_t n) {
    size_t i = 0, o = 0;
    while (i < n) {
        uint8_t code = buf[i++];
        if (code == 0 || i + code - 1U > n) {
            return -1;
        }
        for (uint8_t k = 1; k < code; ++k) {
            buf[o++] = buf[i++];
        }
        if (code < 0xFF && i < n) {
            buf[o++] = 0;
        }
    }
    if (o < 4 ||
        crc16(buf, o - 2) != (uint16_t)(buf[o - 2] | buf[o - 1] << 8)) {
        return -1;
    }
    return (int)(o - 4);
}

static uint16_t put_str(uint8_t* out, uint16_t at, uint16_t max,
                        const char* s) {
    size_t n = strlen(s) + 1U; /* with its NUL */
    if (at == 0 || at + n > max) {
        return 0;
    }
    memcpy(out + at, s, n);
    return (uint16_t)(at + n);
}

uint16_t usb_frame_value(uint8_t* out, uint16_t max, uint8_t index,
                         uint8_t count, uint8_t type, uint32_t value,
                         const char* name, const char* unit,
                         const char* labels) {
    if (max < 7) {
        return 0;
    }
    out[0] = index;
    out[1] = count;
    out[2] = type;
    memcpy(out + 3, &value, 4); /* little-endian */
    uint16_t n = put_str(out, 7, max, name);
    n = put_str(out, n, max, unit);
    return put_str(out, n, max, labels);
}
