#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gnss_frame.h"
#include "ubx.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

/* Expected frames from an independent Python encoder (struct.pack + the
 * Fletcher checksum), keys from the Interface Description UBX-21035062. */
static const uint8_t kBaud[] = {0xB5, 0x62, 0x06, 0x8A, 0x0C, 0x00, 0x00,
                                0x01, 0x00, 0x00, 0x01, 0x00, 0x52, 0x40,
                                0x00, 0xC2, 0x01, 0x00, 0xF3, 0xA5};
static const uint8_t kConfig[] = {
    0xB5, 0x62, 0x06, 0x8A, 0x19, 0x00, 0x00, 0x01, 0x00, 0x00, 0x02,
    0x00, 0x74, 0x10, 0x00, 0x07, 0x00, 0x91, 0x20, 0x01, 0x01, 0x00,
    0x21, 0x30, 0x64, 0x00, 0x21, 0x00, 0x11, 0x20, 0x08, 0xF9, 0x01};

/* NAV-PVT: 2026-11-05 14:30:15, 3D fix, 11 SV, lon -122.2585 lat 37.8719,
 * hMSL 120.5 m, vel N/E/D 1500 / -250 / -98765 mm/s, pDOP 1.35. */
static const uint8_t kPvt[] = {
    0xB5, 0x62, 0x01, 0x07, 0x5C, 0x00, 0x15, 0xCD, 0x5B, 0x07, 0xEA, 0x07,
    0x0B, 0x05, 0x0E, 0x1E, 0x0F, 0x37, 0x19, 0x00, 0x00, 0x00, 0x0C, 0xFE,
    0xFF, 0xFF, 0x03, 0x01, 0x00, 0x0B, 0x58, 0xD5, 0x20, 0xB7, 0x18, 0xCB,
    0x92, 0x16, 0xF0, 0x49, 0x02, 0x00, 0xB4, 0xD6, 0x01, 0x00, 0x08, 0x07,
    0x00, 0x00, 0xC4, 0x09, 0x00, 0x00, 0xDC, 0x05, 0x00, 0x00, 0x06, 0xFF,
    0xFF, 0xFF, 0x33, 0x7E, 0xFE, 0xFF, 0xF0, 0x05, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x2C, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x87, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xB7, 0xE9};

static void test_valset_baud(void) {
    const ubx_item_t items[] = {{UBX_KEY_UART1_BAUDRATE, 4, 115200}};
    uint8_t out[64];
    size_t n = ubx_valset(out, sizeof(out), items, 1);
    CHECK(n == sizeof(kBaud));
    CHECK(memcmp(out, kBaud, n) == 0);
}

static void test_valset_configuration(void) {
    const ubx_item_t items[] = {
        {UBX_KEY_UART1OUTPROT_NMEA, 1, 0},
        {UBX_KEY_MSGOUT_NAV_PVT_UART1, 1, 1},
        {UBX_KEY_RATE_MEAS, 2, 100},
        {UBX_KEY_NAVSPG_DYNMODEL, 1, UBX_DYNMODEL_AIR4},
    };
    uint8_t out[64];
    size_t n = ubx_valset(out, sizeof(out), items, 4);
    CHECK(n == sizeof(kConfig));
    CHECK(memcmp(out, kConfig, n) == 0);
    CHECK(ubx_valset(out, 10, items, 4) == 0); /* does not fit */
    const ubx_item_t bad[] = {{1, 3, 0}};      /* no 3-byte keys */
    CHECK(ubx_valset(out, sizeof(out), bad, 1) == 0);
}

static void test_nav_pvt_through_the_frame_parser(void) {
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    gnss_frame_kind_t k = GNSS_FRAME_NONE;
    for (size_t i = 0; i < sizeof(kPvt); ++i) {
        k = gnss_frame_feed(&p, kPvt[i]);
        CHECK(i == sizeof(kPvt) - 1 || k == GNSS_FRAME_NONE);
    }
    CHECK(k == GNSS_FRAME_UBX);
    CHECK(p.ubx_class == UBX_CLASS_NAV && p.ubx_id == UBX_ID_NAV_PVT);
    CHECK(p.ubx_len == UBX_NAV_PVT_LEN);
    ubx_pvt_t pvt;
    CHECK(ubx_parse_nav_pvt(p.ubx_payload, p.ubx_len, &pvt));
    CHECK(pvt.itow_ms == 123456789U && pvt.year == 2026 && pvt.month == 11);
    CHECK(pvt.day == 5 && pvt.hour == 14 && pvt.min == 30 && pvt.sec == 15);
    CHECK(pvt.fix_type == 3 && pvt.flags == 1 && pvt.num_sv == 11);
    CHECK(pvt.lon_e7 == -1222585000 && pvt.lat_e7 == 378719000);
    CHECK(pvt.height_mm == 150000 && pvt.hmsl_mm == 120500);
    CHECK(pvt.hacc_mm == 1800 && pvt.vacc_mm == 2500);
    CHECK(pvt.vel_n_mms == 1500 && pvt.vel_e_mms == -250);
    CHECK(pvt.vel_d_mms == -98765 && pvt.sacc_mms == 300);
    CHECK(pvt.pdop_e2 == 135);
    CHECK(!ubx_parse_nav_pvt(p.ubx_payload, 91, &pvt)); /* wrong length */
}

static void test_frame_roundtrip_through_parser(void) {
    const uint8_t ack[2] = {UBX_CLASS_CFG, UBX_ID_CFG_VALSET};
    uint8_t out[16];
    size_t n =
        ubx_frame(out, sizeof(out), UBX_CLASS_ACK, UBX_ID_ACK_ACK, ack, 2);
    CHECK(n == 10);
    gnss_frame_parser_t p;
    gnss_frame_init(&p);
    gnss_frame_kind_t k = GNSS_FRAME_NONE;
    for (size_t i = 0; i < n; ++i)
        k = gnss_frame_feed(&p, out[i]);
    CHECK(k == GNSS_FRAME_UBX && p.ubx_class == UBX_CLASS_ACK);
    CHECK(p.ubx_payload[0] == UBX_CLASS_CFG && p.ubx_payload[1] == 0x8A);
}

int main(void) {
    test_valset_baud();
    test_valset_configuration();
    test_nav_pvt_through_the_frame_parser();
    test_frame_roundtrip_through_parser();
    puts("ubx: all tests passed");
    return 0;
}
