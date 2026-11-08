/*
 * The firmware's USB frame code (src/app/usb_frame.c), for tests/usb_frame.rs.
 *
 *   usb_frame_io encode       one frame per line, hex, 0x00 included
 *   usb_frame_io decode HEX   "type seq payload-hex", or "bad"
 */
#include <stdio.h>
#include <string.h>

#include "usb_frame.h"

static void print_hex(const uint8_t* b, size_t n) {
    for (size_t i = 0; i < n; ++i) printf("%02x", b[i]);
}

static void encode(uint8_t type, const uint8_t* p, uint16_t n) {
    static uint8_t out[USB_FRAME_WIRE_MAX];
    size_t len = usb_frame_encode(type, 7, p, n, out);
    print_hex(out, len);
    printf("\n");
}

int main(int argc, char** argv) {
    static uint8_t p[600];
    if (argc == 2 && strcmp(argv[1], "encode") == 0) {
        uint16_t n = usb_frame_value(p, 200, 1, 3, 0, 1, "state", "", "SELF_TEST,IDLE");
        encode(0x83, p, n);
        for (int i = 0; i < 600; ++i) p[i] = (uint8_t)(i % 7); /* zeros */
        encode(0xB0, p, 600);
        memset(p, 0xAB, 300); /* a run longer than one COBS block */
        encode(0xB0, p, 300);
        encode(0x7F, p, 0);
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "decode") == 0) {
        static uint8_t buf[USB_FRAME_WIRE_MAX];
        size_t n = strlen(argv[2]) / 2;
        for (size_t i = 0; i < n; ++i) sscanf(argv[2] + 2 * i, "%2hhx", &buf[i]);
        int len = usb_frame_decode(buf, n);
        if (len < 0) {
            printf("bad\n");
        } else {
            printf("%u %u ", buf[0], buf[1]);
            print_hex(buf + 2, (size_t)len);
            printf("\n");
        }
        return 0;
    }
    return 2;
}
