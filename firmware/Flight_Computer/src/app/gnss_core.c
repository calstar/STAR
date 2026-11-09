#include "gnss_core.h"

#include <string.h>

static const uint32_t kBauds[] = {9600U, 38400U, GNSS_RUN_BAUD};
#define BAUD_COUNT (sizeof(kBauds) / sizeof(kBauds[0]))

static void open_at(gnss_core_t* c, uint32_t baud) {
    c->baud = baud;
    c->io.set_baud(c->io.ctx, baud);
    gnss_frame_init(&c->parser); /* bytes in flight belong to the old rate */
}

static void detect(gnss_core_t* c, uint32_t now_us) {
    c->state = GNSS_DETECT;
    c->deadline_us = now_us + GNSS_LISTEN_US;
    open_at(c, kBauds[c->candidate]);
}

static void send_config(gnss_core_t* c, uint32_t now_us) {
    const ubx_item_t items[] = {
        {UBX_KEY_UART1OUTPROT_NMEA, 1, 0},
        {UBX_KEY_MSGOUT_NAV_PVT_UART1, 1, 1},
        {UBX_KEY_RATE_MEAS, 2, c->rate_ms ? c->rate_ms : GNSS_RATE_MS},
        {UBX_KEY_NAVSPG_DYNMODEL, 1,
         c->rate_ms ? c->dyn_model : UBX_DYNMODEL_AIR4},
    };
    uint8_t frame[64];
    size_t n = ubx_valset(frame, sizeof(frame), items,
                          sizeof(items) / sizeof(items[0]));
    c->io.send(c->io.ctx, frame, (uint16_t)n);
    c->deadline_us = now_us + GNSS_ACK_US;
}

static void configure(gnss_core_t* c, uint32_t now_us) {
    if (c->baud != GNSS_RUN_BAUD) {
        const ubx_item_t baud = {UBX_KEY_UART1_BAUDRATE, 4, GNSS_RUN_BAUD};
        uint8_t frame[32];
        size_t n = ubx_valset(frame, sizeof(frame), &baud, 1);
        c->io.send(c->io.ctx, frame, (uint16_t)n); /* switches on receipt */
        open_at(c, GNSS_RUN_BAUD);
    }
    c->state = GNSS_CONFIG;
    c->tries = 1;
    send_config(c, now_us);
}

static void restart(gnss_core_t* c, uint32_t now_us) {
    c->resets++;
    c->candidate = 0;
    detect(c, now_us);
}

void gnss_core_init(gnss_core_t* c, uint32_t now_us) {
    c->state = GNSS_DETECT;
    c->candidate = 0;
    c->pps_us = 0;
    detect(c, now_us);
}

void gnss_core_set_pps(gnss_core_t* c, uint32_t edge_us) {
    c->pps_us = edge_us;
}

static void on_pvt(gnss_core_t* c, uint32_t now_us) {
    ubx_pvt_t pvt;
    if (!ubx_parse_nav_pvt(c->parser.ubx_payload, c->parser.ubx_len, &pvt)) {
        return;
    }
    rec_gnss_t r;
    r.t_us = now_us;
    r.pps_us = c->pps_us;
    r.itow_ms = pvt.itow_ms;
    r.lat_e7 = pvt.lat_e7;
    r.lon_e7 = pvt.lon_e7;
    r.hmsl_mm = pvt.hmsl_mm;
    r.vel_n_mms = pvt.vel_n_mms;
    r.vel_e_mms = pvt.vel_e_mms;
    r.vel_d_mms = pvt.vel_d_mms;
    r.hacc_mm = pvt.hacc_mm;
    r.vacc_mm = pvt.vacc_mm;
    r.pdop_e2 = pvt.pdop_e2;
    r.fix_type = pvt.fix_type;
    r.num_sv = pvt.num_sv;
    r.flags = pvt.flags;
    c->latest = r;
    c->fixes++;
    c->deadline_us = now_us + GNSS_SILENCE_US;
    if (c->sink.record) {
        c->sink.record(c->sink.ctx, REC_GNSS, &r, sizeof(r));
    }
}

static void on_frame(gnss_core_t* c, gnss_frame_kind_t kind, uint32_t now_us) {
    gnss_frame_parser_t* p = &c->parser;
    switch (c->state) {
        case GNSS_DETECT:
            c->detected_baud = c->baud;
            configure(c, now_us);
            break;
        case GNSS_CONFIG:
            if (kind == GNSS_FRAME_UBX && p->ubx_class == UBX_CLASS_ACK &&
                p->ubx_len == 2 && p->ubx_payload[0] == UBX_CLASS_CFG &&
                p->ubx_payload[1] == UBX_ID_CFG_VALSET) {
                if (p->ubx_id == UBX_ID_ACK_ACK) {
                    c->configs++;
                    c->state = GNSS_RUN;
                    c->deadline_us = now_us + GNSS_SILENCE_US;
                } else {
                    c->naks++;
                    restart(c, now_us);
                }
            }
            break;
        case GNSS_RUN:
            if (kind != GNSS_FRAME_UBX) {
                break;
            }
            if (p->ubx_class == UBX_CLASS_NAV && p->ubx_id == UBX_ID_NAV_PVT) {
                on_pvt(c, now_us);
            } else if (p->ubx_class == UBX_CLASS_MON &&
                       p->ubx_id == UBX_ID_MON_RF) {
                if (ubx_parse_mon_rf(p->ubx_payload, p->ubx_len, &c->rf)) {
                    c->rf_reports++;
                }
            } else if (p->ubx_class == UBX_CLASS_NAV &&
                       p->ubx_id == UBX_ID_NAV_SAT) {
                /* only the captured prefix of a long list is in hand */
                uint16_t got = p->ubx_len < GNSS_FRAME_UBX_CAPTURE
                                   ? p->ubx_len
                                   : (uint16_t)GNSS_FRAME_UBX_CAPTURE;
                if (ubx_sat_summary(p->ubx_payload, got, &c->sats)) {
                    c->sat_reports++;
                }
            }
            break;
    }
}

void gnss_core_feed(gnss_core_t* c, const uint8_t* bytes, size_t n,
                    uint32_t now_us) {
    for (size_t i = 0; i < n; ++i) {
        gnss_frame_kind_t kind = gnss_frame_feed(&c->parser, bytes[i]);
        if (kind != GNSS_FRAME_NONE) {
            on_frame(c, kind, now_us);
        }
    }
}

void gnss_core_poll(gnss_core_t* c, uint32_t now_us) {
    if ((int32_t)(now_us - c->deadline_us) < 0) {
        return;
    }
    switch (c->state) {
        case GNSS_DETECT: /* nothing heard at this baud: try the next */
            c->candidate = (uint8_t)((c->candidate + 1U) % BAUD_COUNT);
            detect(c, now_us);
            break;
        case GNSS_CONFIG:
            if (c->tries++ < GNSS_CONFIG_TRIES) {
                send_config(c, now_us);
            } else {
                restart(c, now_us);
            }
            break;
        case GNSS_RUN: /* fixes stopped */
            restart(c, now_us);
            break;
    }
}

bool gnss_core_request_status(gnss_core_t* c) {
    if (c->state != GNSS_RUN) {
        return false;
    }
    uint8_t frame[8];
    size_t n = ubx_poll(frame, sizeof(frame), UBX_CLASS_MON, UBX_ID_MON_RF);
    c->io.send(c->io.ctx, frame, (uint16_t)n);
    n = ubx_poll(frame, sizeof(frame), UBX_CLASS_NAV, UBX_ID_NAV_SAT);
    c->io.send(c->io.ctx, frame, (uint16_t)n);
    return true;
}

uint32_t gnss_core_wait_us(const gnss_core_t* c, uint32_t now_us) {
    int32_t d = (int32_t)(c->deadline_us - now_us);
    return d > 0 ? (uint32_t)d : 0U;
}
