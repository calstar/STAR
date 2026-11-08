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
#include "usb_frame.h"
#include "usbd_cdc_if.h"

enum { HELLO = 0x01, GET_STATUS = 0x02, SET_STREAM = 0x03 };
enum { ACK = 0x7F, INFO = 0x81, VALUE = 0x83, SAMPLE = 0xB0 };
enum { OK = 0, BAD_FRAME = 1, BAD_VALUE = 3, NOT_IMPLEMENTED = 8 };
#define MAX_RATE_HZ 200U

static StreamBufferHandle_t rx;
static volatile uint16_t rate_hz;
static uint8_t mask;
static uint8_t in[USB_FRAME_MAX];
static uint16_t in_len;
static bool in_overflow;

/* may_drop: give up at once if the endpoint is busy (SAMPLEs). */
static bool send(uint8_t type, uint8_t seq, const uint8_t* p, uint16_t n,
                 bool may_drop) {
    static uint8_t tx[USB_FRAME_WIRE_MAX];
    for (int waited = 0; !usb_tx_ready(); ++waited) {
        if (may_drop || waited >= 50 || !usb_terminal_open()) {
            return false;
        }
        osDelay(1);
    }
    size_t len = usb_frame_encode(type, seq, p, n, tx);
    return len > 0 && CDC_Transmit_HS(tx, (uint16_t)len) == USBD_OK;
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

/* f: a decoded frame, len: its payload length. */
static void handle(const uint8_t* f, size_t len) {
    uint8_t type = f[0], seq = f[1];
    const uint8_t* p = f + 2;
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
    int len = in_overflow ? -1 : usb_frame_decode(in, in_len);
    if (len >= 0) { /* a bad frame is dropped silently; the host retries */
        handle(in, (size_t)len);
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
