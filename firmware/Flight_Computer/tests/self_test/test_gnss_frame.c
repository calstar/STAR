#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gnss_frame.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

/* Feed bytes; return how many valid frames of each kind completed. */
typedef struct {
    unsigned nmea, ubx;
} counts_t;

static counts_t feed(gnss_frame_parser_t* p, const uint8_t* bytes, size_t n) {
    counts_t c = {0, 0};
    for (size_t i = 0; i < n; ++i) {
        gnss_frame_kind_t k = gnss_frame_feed(p, bytes[i]);
        if (k == GNSS_FRAME_NMEA)
            c.nmea++;
        if (k == GNSS_FRAME_UBX)
            c.ubx++;
    }
    return c;
}

static counts_t feed_str(gnss_frame_parser_t* p, const char* s) {
    return feed(p, (const uint8_t*)s, strlen(s));
}

/* Vectors computed outside this code: the GGA example's published checksum is
 * 47; TXT and UBX checksums were computed independently in Python. */
static const char gga[] =
    "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47\r\n";
static const char txt[] = "$GNTXT,01,01,02,u-blox AG - www.u-blox.com*4E\r\n";
static const uint8_t ack[] = {0xB5, 0x62, 0x05, 0x01, 0x02,
                              0x00, 0x06, 0x8A, 0x98, 0xC1};

static void test_valid_frames(void) {
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    counts_t c = feed_str(&p, gga);
    CHECK(c.nmea == 1 && c.ubx == 0);
    c = feed_str(&p, txt);
    CHECK(c.nmea == 1);
    c = feed(&p, ack, sizeof(ack));
    CHECK(c.ubx == 1 && c.nmea == 0);
    CHECK(p.rejected == 0);
}

static void test_lowercase_checksum(void) {
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    CHECK(feed_str(&p, "$GNTXT,01,01,02,u-blox AG - www.u-blox.com*4e").nmea ==
          1);
}

static void test_wrong_nmea_checksum(void) {
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    char bad[sizeof(gga)];
    memcpy(bad, gga, sizeof(gga));
    bad[strlen(bad) - 3] = '8'; /* *47 -> *48 */
    CHECK(feed_str(&p, bad).nmea == 0);
    CHECK(p.rejected == 1);
    /* one flipped body byte also fails */
    memcpy(bad, gga, sizeof(gga));
    bad[10] = '6';
    CHECK(feed_str(&p, bad).nmea == 0);
}

static void test_corrupt_ubx(void) {
    for (size_t i = 2; i < sizeof(ack); ++i) {
        gnss_frame_parser_t p;
        gnss_frame_init(&p);
        uint8_t bad[sizeof(ack)];
        memcpy(bad, ack, sizeof(ack));
        bad[i] ^= 0x01;
        counts_t c = feed(&p, bad, sizeof(bad));
        CHECK(c.ubx == 0);
    }
}

static void test_noise_then_frame(void) {
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    /* line noise (incl. NUL), a stray UBX sync byte and a half sentence */
    static const uint8_t noise[] = {0xFF, 0x00, 'g', 'a', 'r', 0xB5, 'z',
                                    '$',  'G',  'P', 'G', 'G', 'A',  ','};
    CHECK(feed(&p, noise, sizeof(noise)).nmea == 0);
    CHECK(feed_str(&p, gga).nmea == 1); /* '$' restarts the cut sentence */
    CHECK(p.rejected == 1);
}

static void test_overlong_and_binary_nmea(void) {
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    char longline[200] = "$";
    memset(longline + 1, 'A', 150);
    strcat(longline, "*00");
    CHECK(feed_str(&p, longline).nmea == 0);
    /* *57 is the right XOR including the 0x01, so only the "printable
     * characters only" rule can reject it. */
    CHECK(feed_str(&p, "$GP\x01GGA*57").nmea == 0);
    CHECK(feed_str(&p, "$GPGGA*56").nmea == 1); /* same frame, no 0x01 */
}

static void test_ubx_length_limit(void) {
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    /* declared payload 0xFFFF is refused right after the length bytes */
    const uint8_t big[] = {0xB5, 0x62, 0x01, 0x07, 0xFF, 0xFF};
    CHECK(feed(&p, big, sizeof(big)).ubx == 0);
    CHECK(p.rejected == 1);
    CHECK(feed(&p, ack, sizeof(ack)).ubx == 1);
}

int main(void) {
    test_valid_frames();
    test_lowercase_checksum();
    test_wrong_nmea_checksum();
    test_corrupt_ubx();
    test_noise_then_frame();
    test_overlong_and_binary_nmea();
    test_ubx_length_limit();
    puts("gnss_frame: all tests passed");
    return 0;
}
