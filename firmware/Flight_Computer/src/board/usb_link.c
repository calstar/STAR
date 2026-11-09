#include "usb_link.h"

#include <stdbool.h>
#include <string.h>

#include "FreeRTOS.h"
#include "board_config.h"
#include "cmsis_os2.h"
#include "emmc_stm32.h"
#include "gnss_task.h"
#include "gui_map.h"
#include "main.h"
#include "mode.h"
#include "radio_task.h"
#include "records.h"
#include "sensors_task.h"
#include "stream_buffer.h"
#include "usb_frame.h"
#include "usbd_cdc_if.h"

enum { HELLO = 0x01, GET_STATUS = 0x02, SET_STREAM = 0x03 };
enum { CONFIG_GET = 0x10, CONFIG_SET, CONFIG_SAVE, CONFIG_REVERT };
enum { RADIO_ARM = 0x40, RADIO_UNARM = 0x41, RADIO_RX = 0xB2 };
enum { LOG_INFO = 0x20, LOG_SESSIONS, LOG_READ, LOG_ABORT };
enum { LOG_INFO_REPLY = 0xA0, SESSIONS = 0xA1, LOG_BLOCK = 0xA2 };
#define SESSIONS_PER_FRAME 24U
enum { ACK = 0x7F, INFO = 0x81, VALUE = 0x83, CONFIG = 0x90, SAMPLE = 0xB0 };
enum { OK = 0, BAD_FRAME = 1, BAD_VALUE = 3, WRONG_STATE = 4 };
enum { BUSY = 5, FLASH_ERROR = 6, STORAGE_ERROR = 7, NOT_IMPLEMENTED = 8 };
enum { RADIO_ERROR = 10 };
#define MAX_RATE_HZ 200U

static StreamBufferHandle_t rx;

/* One received radio frame, as RADIO_RX sends it. */
typedef struct {
    uint8_t type, len;
    uint16_t seq;
    int16_t rssi_x2, snr_x4;
    uint8_t payload[248]; /* frame.h kFrameMaxPayload */
} heard_t;
static osMessageQueueId_t heard;

/* The LOG_READ in progress (one at a time): blocks [next, end). */
static struct {
    bool active;
    uint8_t seq;
    uint32_t next, end;
} reading;
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
    /* protocol 1, config version and size, uptime, UID, fw_git, build 0 */
    uint8_t p[40] = {1, FC_CONFIG_VERSION, FC_CONFIG_SIZE, 0};
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

static void send_config(uint8_t slot, uint8_t seq, const fc_config_t* c) {
    uint8_t p[1 + FC_CONFIG_SIZE] = {slot};
    fc_config_pack(c, p + 1);
    (void)send(CONFIG, seq, p, sizeof p, false);
}

/* Settings change only in SELF_TEST and IDLE (PROTOCOL.md §5). */
static bool configurable(void) {
    flight_state_t s = app_state();
    return s == FLIGHT_SELF_TEST || s == FLIGHT_IDLE;
}

static void handle_config(uint8_t type, uint8_t seq, const uint8_t* p,
                          size_t len) {
    fc_config_t c;
    if (type == CONFIG_GET) {
        if (len != 1 || p[0] > 2) {
            ack(type, seq, BAD_FRAME, 0);
        } else if (p[0] == 1 && !board_config_saved(&c)) {
            ack(type, seq, FLASH_ERROR, 0);
        } else {
            c = p[0] == 0   ? board_config_get()
                : p[0] == 2 ? fc_config_defaults()
                            : c;
            send_config(p[0], seq, &c);
        }
        return;
    }
    if (!configurable()) {
        ack(type, seq, WRONG_STATE, app_state());
        return;
    }
    uint8_t bad;
    switch (type) {
        case CONFIG_SET:
            if (!fc_config_unpack(p, len, &c)) {
                ack(type, seq, BAD_FRAME, 0);
            } else if ((bad = fc_config_check(&c)) != 0) {
                ack(type, seq, BAD_VALUE, bad);
            } else {
                board_config_set(&c);
                ack(type, seq, OK, 0);
            }
            break;
        case CONFIG_SAVE: /* erasing stalls the CPU: Idle only */
            ack(type, seq,
                board_config_save(app_state() == FLIGHT_IDLE) ? OK
                                                              : FLASH_ERROR,
                0);
            break;
        default: /* CONFIG_REVERT */
            if (!board_config_saved(&c)) {
                c = fc_config_defaults();
            }
            board_config_set(&c);
            ack(type, seq, OK, 0);
            break;
    }
}

static void put_u32(uint8_t* p, uint32_t v) {
    memcpy(p, &v, 4); /* little-endian */
}

static uint32_t get_u32(const uint8_t* p) {
    uint32_t v;
    memcpy(&v, p, 4);
    return v;
}

/* The flight log, read back (PROTOCOL.md section 6). Not while recording:
 * the reads run in the writer task, between its chunk writes. */
static void handle_log(uint8_t type, uint8_t seq, const uint8_t* p,
                       size_t len) {
    if (type == LOG_ABORT) {
        if (reading.active) {
            reading.active = false;
            ack(LOG_READ, reading.seq, OK, 1); /* the read ends: aborted */
        }
        ack(type, seq, OK, 0);
        return;
    }
    if (!configurable()) {
        ack(type, seq, WRONG_STATE, app_state());
        return;
    }
    if (reading.active) {
        ack(type, seq, BUSY, 0);
        return;
    }
    if (emmc_stm32_open() != EMMC_OK) {
        ack(type, seq, STORAGE_ERROR, 0);
        return;
    }
    const emmc_log_t* log = emmc_stm32_log();
    static emmc_log_session_t list[SESSIONS_PER_FRAME];
    uint32_t n = 0, total = 0;
    if (type == LOG_INFO) {
        /* disk u8, epoch, data start, capacity, blocks used, sessions u32 */
        uint8_t r[21] = {(uint8_t)log->disk};
        if (emmc_stm32_sessions(0, list, 0, &n, &total) != EMMC_OK) {
            ack(type, seq, STORAGE_ERROR, 0);
            return;
        }
        put_u32(r + 1, log->epoch);
        put_u32(r + 5, log->config.data_start_lba);
        put_u32(r + 9, log->capacity);
        put_u32(r + 13, emmc_log_used(log));
        put_u32(r + 17, total);
        (void)send(LOG_INFO_REPLY, seq, r, sizeof r, false);
    } else if (type == LOG_SESSIONS) {
        if (len != 2) {
            ack(type, seq, BAD_FRAME, 0);
            return;
        }
        uint16_t start = (uint16_t)(p[0] | p[1] << 8);
        if (emmc_stm32_sessions(start, list, SESSIONS_PER_FRAME, &n, &total) !=
            EMMC_OK) {
            ack(type, seq, STORAGE_ERROR, 0);
            return;
        }
        /* total u16, n u8, n x {session, first block, blocks, duration ms,
         * utc start (0: GNSS time not decoded yet)} u32 */
        static uint8_t r[3 + SESSIONS_PER_FRAME * 20U];
        r[0] = (uint8_t)total;
        r[1] = (uint8_t)(total >> 8);
        r[2] = (uint8_t)n;
        for (uint32_t i = 0; i < n; ++i) {
            uint8_t* e = r + 3 + 20U * i;
            put_u32(e, list[i].session);
            put_u32(e + 4, list[i].first_block);
            put_u32(e + 8, list[i].blocks);
            put_u32(e + 12, list[i].duration_ms);
            put_u32(e + 16, 0);
        }
        (void)send(SESSIONS, seq, r, (uint16_t)(3U + 20U * n), false);
    } else { /* LOG_READ: blocks go out from the loop, one per pass */
        if (len != 8) {
            ack(type, seq, BAD_FRAME, 0);
            return;
        }
        uint32_t first = get_u32(p), count = get_u32(p + 4);
        uint32_t used = emmc_log_used(log);
        reading.seq = seq;
        reading.next = first < used ? first : used;
        reading.end = count < used - reading.next ? reading.next + count : used;
        reading.active = true;
    }
}

/* One block of the LOG_READ in progress; the ACK after the last. */
static void read_step(void) {
    static uint8_t p[4 + EMMC_BLOCK_SIZE];
    if (!reading.active) {
        return;
    }
    if (reading.next >= reading.end) {
        reading.active = false;
        ack(LOG_READ, reading.seq, OK, 0);
        return;
    }
    put_u32(p, reading.next);
    if (emmc_stm32_read(reading.next, p + 4) != EMMC_OK) {
        reading.active = false;
        ack(LOG_READ, reading.seq, STORAGE_ERROR, 0);
        return;
    }
    if (send(LOG_BLOCK, reading.seq, p, sizeof p, false)) {
        reading.next++;
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
        case CONFIG_GET:
        case CONFIG_SET:
        case CONFIG_SAVE:
        case CONFIG_REVERT:
            handle_config(type, seq, p, len);
            break;
        case LOG_INFO:
        case LOG_SESSIONS:
        case LOG_READ:
        case LOG_ABORT:
            handle_log(type, seq, p, len);
            break;
        case RADIO_ARM:
        case RADIO_UNARM:
            if (board_config_boot_role() != FC_ROLE_RECEIVER) {
                ack(type, seq, WRONG_STATE, 0xFF); /* a rocket sends none */
            } else {
                radio_send_result_t r =
                    radio_task_ground_command(type == RADIO_ARM);
                ack(type, seq, r == RADIO_SEND_OK ? OK : RADIO_ERROR, r);
            }
            break;
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

void usb_link_radio_rx(uint8_t type, uint16_t seq, const uint8_t* payload,
                       uint8_t len, int16_t rssi_x2, int16_t snr_x4) {
    static heard_t h; /* radio task only: one at a time */
    if (!heard || len > sizeof h.payload) {
        return;
    }
    h.type = type;
    h.len = len;
    h.seq = seq;
    h.rssi_x2 = rssi_x2;
    h.snr_x4 = snr_x4;
    memcpy(h.payload, payload, len);
    (void)osMessageQueuePut(heard, &h, 0, 0); /* full: dropped */
}

/* type u8, seq u16, rssi_x2 i16, snr_x4 i16, len u8, payload */
static void send_heard(void) {
    static heard_t h;
    static uint8_t p[8 + sizeof h.payload];
    while (heard && osMessageQueueGet(heard, &h, NULL, 0) == osOK) {
        p[0] = h.type;
        memcpy(p + 1, &h.seq, 2);
        memcpy(p + 3, &h.rssi_x2, 2);
        memcpy(p + 5, &h.snr_x4, 2);
        p[7] = h.len;
        memcpy(p + 8, h.payload, h.len);
        (void)send(RADIO_RX, 0, p, (uint16_t)(8U + h.len), false);
    }
}

uint16_t usb_link_rate_hz(void) {
    return rate_hz;
}

void usb_link_run(void) {
    rx = xStreamBufferCreate(1024, 1);
    heard = osMessageQueueNew(6, sizeof(heard_t), NULL);
    uint32_t next_values = 0, next_sample = 0;
    for (;;) {
        uint8_t b[64];
        size_t n = xStreamBufferReceive(rx, b, sizeof b, pdMS_TO_TICKS(2));
        for (size_t i = 0; i < n; ++i) {
            feed(b[i]);
        }
        if (!usb_terminal_open()) {
            rate_hz = 0; /* the next program to open the port asks again */
            reading.active = false;
            continue;
        }
        send_heard(); /* receiver role: what the radio heard */
        read_step();  /* a LOG_READ: one block per pass */
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
