#include "usb_link.h"

#include <stdbool.h>
#include <string.h>

#include "FreeRTOS.h"
#include "cmsis_os2.h"
#include "gnss_task.h"
#include "gui_map.h"
#include "main.h"
#include "records.h"
#include "sensors_task.h"
#include "stream_buffer.h"
#include "usbd_cdc_if.h"

enum { HELLO = 0x01, GET_STATUS = 0x02, SET_STREAM = 0x03 };
enum { ACK = 0x7F, INFO = 0x81, VALUE = 0x83, SAMPLE = 0xB0 };
enum { OK = 0, BAD_FRAME = 1, BAD_VALUE = 3, NOT_IMPLEMENTED = 8 };
#define MAX_FRAME 1024U /* decoded: type, seq, payload, crc */
#define MAX_RATE_HZ 200U

static StreamBufferHandle_t rx;
static volatile uint16_t rate_hz;
static uint8_t mask;
static uint8_t in[MAX_FRAME];
static uint16_t in_len;
static bool in_overflow;

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

/* The same COBS as the GUI's protocol.rs. Returns the encoded length. */
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

/* In place (d may be s). Returns the decoded length, 0 if malformed. */
static size_t cobs_decode(const uint8_t* s, size_t n, uint8_t* d) {
    size_t i = 0, o = 0;
    while (i < n) {
        uint8_t code = s[i++];
        if (code == 0 || i + code - 1U > n) {
            return 0;
        }
        for (uint8_t k = 1; k < code; ++k) {
            d[o++] = s[i++];
        }
        if (code < 0xFF && i < n) {
            d[o++] = 0;
        }
    }
    return o;
}

/* may_drop: give up at once if the endpoint is busy (SAMPLEs). */
static bool send(uint8_t type, uint8_t seq, const uint8_t* p, uint16_t n,
                 bool may_drop) {
    static uint8_t raw[MAX_FRAME];
    static uint8_t tx[MAX_FRAME + MAX_FRAME / 254U + 2U];
    if (n + 4U > sizeof raw) {
        return false;
    }
    for (int waited = 0; !usb_tx_ready(); ++waited) {
        if (may_drop || waited >= 50 || !usb_terminal_open()) {
            return false;
        }
        osDelay(1);
    }
    raw[0] = type;
    raw[1] = seq;
    memcpy(raw + 2, p, n);
    uint16_t crc = crc16(raw, n + 2U);
    raw[n + 2U] = (uint8_t)crc;
    raw[n + 3U] = (uint8_t)(crc >> 8);
    size_t len = cobs_encode(raw, n + 4U, tx);
    tx[len++] = 0;
    return CDC_Transmit_HS(tx, (uint16_t)len) == USBD_OK;
}

static void ack(uint8_t for_type, uint8_t seq, uint8_t result,
                uint16_t detail) {
    const uint8_t p[4] = {for_type, result, (uint8_t)detail,
                          (uint8_t)(detail >> 8)};
    (void)send(ACK, seq, p, sizeof p, false);
}

static void put32(uint8_t* p, uint32_t v) {
    memcpy(p, &v, 4); /* little-endian */
}

static void send_info(uint8_t seq) {
    /* protocol 1, config v1 of 42 B, uptime, UID, fw_git, build time 0 */
    uint8_t p[40] = {1, 1, 42, 0};
    put32(p + 4, osKernelGetTickCount());
    put32(p + 8, HAL_GetUIDw0());
    put32(p + 12, HAL_GetUIDw1());
    put32(p + 16, HAL_GetUIDw2());
    memcpy(p + 20, "usb-link", 8);
    (void)send(INFO, seq, p, sizeof p, false);
}

static void send_values(void) {
    uint8_t p[GUI_VALUE_MAX];
    gui_map_read();
    for (uint8_t i = 0; i < gui_map_count(); ++i) {
        (void)send(VALUE, 0, p, gui_map_value(i, p), false);
    }
}

static void handle(const uint8_t* f, size_t n) {
    if (n < 4 || crc16(f, n - 2) != (uint16_t)(f[n - 2] | f[n - 1] << 8)) {
        return; /* dropped silently; the host retries */
    }
    uint8_t type = f[0], seq = f[1];
    const uint8_t* p = f + 2;
    size_t len = n - 4;
    switch (type) {
        case HELLO:
            send_info(seq);
            break;
        case GET_STATUS:
            send_values();
            ack(type, seq, OK, 0);
            break;
        case SET_STREAM: {
            uint16_t rate = len == 3 ? (uint16_t)(p[0] | p[1] << 8) : 0;
            if (len != 3) {
                ack(type, seq, BAD_FRAME, 0);
            } else if (rate > MAX_RATE_HZ) {
                ack(type, seq, BAD_VALUE, rate);
            } else {
                mask = p[2];
                rate_hz = rate;
                ack(type, seq, OK, 0);
            }
            break;
        }
        default:
            ack(type, seq, NOT_IMPLEMENTED, 0);
            break;
    }
}

static void feed(uint8_t c) {
    if (c != 0) {
        if (in_len < sizeof in) {
            in[in_len++] = c;
        } else {
            in_overflow = true;
        }
        return;
    }
    size_t n = in_overflow ? 0 : cobs_decode(in, in_len, in);
    if (n > 0) {
        handle(in, n);
    }
    in_len = 0;
    in_overflow = false;
}

/* Sent only when the sensor has produced a new one since the last. */
static void sample(uint8_t bit, uint8_t type, uint32_t count, const void* rec,
                   size_t size) {
    static uint32_t seen[4];
    uint8_t p[1 + sizeof(rec_gnss_t)];
    if (!(mask & (1U << bit)) || count == seen[bit] || size >= sizeof p) {
        return;
    }
    seen[bit] = count;
    p[0] = type;
    memcpy(p + 1, rec, size);
    (void)send(SAMPLE, 0, p, (uint16_t)(size + 1U), true);
}

static void send_samples(void) {
    static sensors_core_t s;
    sensors_task_snapshot(&s);
    const gnss_core_t* g = gnss_task_core();
    sample(0, REC_IMU, s.imu.samples, &s.imu_latest, sizeof s.imu_latest);
    sample(1, REC_HIGHG, s.highg.samples, &s.highg_latest,
           sizeof s.highg_latest);
    sample(2, REC_BARO, s.baro.samples, &s.baro_latest, sizeof s.baro_latest);
    sample(3, REC_GNSS, g->fixes, &g->latest, sizeof g->latest);
}

void usb_link_rx(const uint8_t* bytes, uint32_t len) {
    if (rx != NULL) {
        BaseType_t woke = pdFALSE;
        (void)xStreamBufferSendFromISR(rx, bytes, len, &woke);
        portYIELD_FROM_ISR(woke);
    }
}

uint16_t usb_link_rate_hz(void) {
    return rate_hz;
}

void usb_link_run(void) {
    rx = xStreamBufferCreate(1024, 1);
    uint32_t next_values = 0, next_sample = 0;
    for (;;) {
        uint8_t b[64];
        size_t n = xStreamBufferReceive(rx, b, sizeof b, pdMS_TO_TICKS(2));
        for (size_t i = 0; i < n; ++i) {
            feed(b[i]);
        }
        if (!usb_terminal_open()) {
            rate_hz = 0; /* the next program to open the port asks again */
            continue;
        }
        uint32_t now = osKernelGetTickCount();
        if ((int32_t)(now - next_values) >= 0) {
            send_values();
            next_values = now + 1000U;
        }
        if (rate_hz > 0 && (int32_t)(now - next_sample) >= 0) {
            send_samples();
            next_sample = now + 1000U / rate_hz;
        }
    }
}
