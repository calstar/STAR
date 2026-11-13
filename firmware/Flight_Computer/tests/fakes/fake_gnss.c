#include "fake_gnss.h"

#include <string.h>

static void queue(fake_gnss_t* f, const uint8_t* b, size_t n) {
    if (f->pending_len + n <= sizeof(f->pending)) {
        memcpy(f->pending + f->pending_len, b, n);
        f->pending_len += n;
    }
}

static void ack(fake_gnss_t* f, bool ok) {
    const uint8_t acked[2] = {UBX_CLASS_CFG, UBX_ID_CFG_VALSET};
    uint8_t frame[16];
    size_t n = ubx_frame(frame, sizeof(frame), UBX_CLASS_ACK,
                         ok ? UBX_ID_ACK_ACK : UBX_ID_ACK_NAK, acked, 2);
    queue(f, frame, n);
    ok ? f->acks++ : f->naks++;
}

/* Value size from the key ID, bits 30..28 (Interface Description p.124). */
static int value_size(uint32_t key) {
    switch ((key >> 28) & 7U) {
        case 1:
        case 2:
            return 1;
        case 3:
            return 2;
        case 4:
            return 4;
        case 5:
            return 8;
        default:
            return -1;
    }
}

static void on_valset(fake_gnss_t* f, const uint8_t* p, uint16_t len) {
    f->valsets++;
    if (len < 4 || p[0] != 0 || !(p[1] & 1U)) { /* version 0, RAM layer */
        ack(f, false);
        return;
    }
    uint32_t new_baud = 0;
    bool config = false;
    for (uint16_t o = 4; o + 4 <= len;) {
        uint32_t key = (uint32_t)p[o] | (uint32_t)p[o + 1] << 8 |
                       (uint32_t)p[o + 2] << 16 | (uint32_t)p[o + 3] << 24;
        int size = value_size(key);
        if (size < 0 || o + 4 + size > len) {
            ack(f, false);
            return;
        }
        uint32_t v = 0;
        for (int k = 0; k < size && k < 4; ++k)
            v |= (uint32_t)p[o + 4 + k] << (8 * k);
        switch (key) {
            case UBX_KEY_UART1_BAUDRATE:
                new_baud = v;
                break;
            case UBX_KEY_UART1OUTPROT_NMEA:
                f->nmea_on = v != 0;
                config = true;
                break;
            case UBX_KEY_MSGOUT_NAV_PVT_UART1:
                f->pvt_on = v != 0;
                config = true;
                break;
            case UBX_KEY_RATE_MEAS:
                f->rate_ms = (uint16_t)v;
                config = true;
                break;
            case UBX_KEY_NAVSPG_DYNMODEL:
                f->dynmodel = (uint8_t)v;
                config = true;
                break;
            default:
                ack(f, false);
                return; /* unknown key: NAK, nothing applied */
        }
        o = (uint16_t)(o + 4 + size);
    }
    if (new_baud) {
        f->module_baud = new_baud; /* takes effect at once */
        f->baud_changes++;
    }
    if (config) {
        if (f->nak_next) {
            f->nak_next = false;
            ack(f, false);
            return;
        }
        ack(f, true);
    }
}

static void module_rx(void* ctx, const uint8_t* bytes, uint16_t len) {
    fake_gnss_t* f = ctx;
    if (f->mute)
        return;
    if (f->uart_baud != f->module_baud) {
        f->garbled_rx++;
        return;
    }
    for (uint16_t i = 0; i < len; ++i) {
        if (gnss_frame_feed(&f->rx, bytes[i]) == GNSS_FRAME_UBX &&
            f->rx.ubx_class == UBX_CLASS_CFG &&
            f->rx.ubx_id == UBX_ID_CFG_VALSET) {
            on_valset(f, f->rx.ubx_payload, f->rx.ubx_len);
        }
    }
}

static void set_baud(void* ctx, uint32_t baud) {
    ((fake_gnss_t*)ctx)->uart_baud = baud;
}

void fake_gnss_init(fake_gnss_t* f, uint32_t baud, fake_gnss_truth_t truth) {
    memset(f, 0, sizeof(*f));
    f->module_baud = baud;
    f->nmea_on = true;
    f->rate_ms = 1000;
    f->truth = truth;
    f->next_nmea_us = 300000;
    gnss_frame_init(&f->rx);
}

void fake_gnss_power_cycle(fake_gnss_t* f, uint32_t now_us) {
    fake_gnss_truth_t truth = f->truth;
    uint32_t uart = f->uart_baud;
    fake_gnss_init(f, 9600, truth);
    f->uart_baud = uart;
    f->next_nmea_us = now_us + 300000;
}

gnss_io_t fake_gnss_io(fake_gnss_t* f) {
    gnss_io_t io = {module_rx, set_baud, f};
    return io;
}

static void pvt(fake_gnss_t* f, uint32_t t) {
    ubx_pvt_t v;
    memset(&v, 0, sizeof(v));
    if (f->truth)
        f->truth(t, &v);
    uint8_t p[UBX_NAV_PVT_LEN] = {0};
    /* Interface Description 3.15.11 offsets, written independently. */
#define PUT32(o, x)                    \
    do {                               \
        uint32_t y = (uint32_t)(x);    \
        p[o] = (uint8_t)y;             \
        p[o + 1] = (uint8_t)(y >> 8);  \
        p[o + 2] = (uint8_t)(y >> 16); \
        p[o + 3] = (uint8_t)(y >> 24); \
    } while (0)
    PUT32(0, v.itow_ms);
    p[20] = v.fix_type;
    p[21] = v.flags;
    p[23] = v.num_sv;
    PUT32(24, v.lon_e7);
    PUT32(28, v.lat_e7);
    PUT32(36, v.hmsl_mm);
    PUT32(40, v.hacc_mm);
    PUT32(44, v.vacc_mm);
    PUT32(48, v.vel_n_mms);
    PUT32(52, v.vel_e_mms);
    PUT32(56, v.vel_d_mms);
    p[76] = (uint8_t)v.pdop_e2;
    p[77] = (uint8_t)(v.pdop_e2 >> 8);
#undef PUT32
    uint8_t frame[UBX_NAV_PVT_LEN + 8];
    size_t n = ubx_frame(frame, sizeof(frame), UBX_CLASS_NAV, UBX_ID_NAV_PVT, p,
                         UBX_NAV_PVT_LEN);
    queue(f, frame, n);
}

size_t fake_gnss_emit(fake_gnss_t* f, uint32_t now_us, uint8_t* out,
                      size_t cap) {
    if (!f->mute) {
        if (f->nmea_on && (int32_t)(now_us - f->next_nmea_us) >= 0) {
            static const char gga[] =
                "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,"
                "*47\r\n";
            queue(f, (const uint8_t*)gga, sizeof(gga) - 1);
            f->next_nmea_us += 1000000U;
        }
        if (f->pvt_on && (int32_t)(now_us - f->next_pvt_us) >= 0) {
            pvt(f, now_us);
            f->next_pvt_us = now_us + f->rate_ms * 1000U;
        }
    }
    size_t n = f->pending_len < cap ? f->pending_len : cap;
    if (f->uart_baud == f->module_baud) {
        memcpy(out, f->pending, n);
    } else {
        memset(out, 0xF0, n); /* wrong baud: the UART sees garbage */
    }
    memmove(f->pending, f->pending + n, f->pending_len - n);
    f->pending_len -= n;
    return n;
}
