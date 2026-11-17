/*
 * prop_core: hardware-independent logic of the STAR Prop Receiver.
 * Pure C, no ESP-IDF includes, so it builds and is tested on a laptop.
 * main.c supplies a prop_hal_t that talks to the real DAC / GPIO / NVS.
 */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "pins.h"          /* macros only (electrical constants) */

#define PROP_NUM_CH          5
#define PROP_SOF             0xA5
#define PROP_ADDR_BROADCAST  0xFF
#define PROP_FW_VERSION      1
#define PROP_DEFAULT_TIMEOUT_MS 2000

enum {
    PROP_CMD_PING        = 0x01,
    PROP_CMD_SET_MA      = 0x02,   /* ch u8, mA f32 */
    PROP_CMD_SET_ALL_MA  = 0x03,   /* 5 x f32 */
    PROP_CMD_SET_ENABLE  = 0x04,   /* mask u8 */
    PROP_CMD_GET_STATUS  = 0x05,
    PROP_CMD_ESTOP       = 0x06,
    PROP_CMD_SET_CAL     = 0x07,   /* ch u8, gain f32, offset_mA f32 */
    PROP_CMD_SET_TIMEOUT = 0x08,   /* ms u16 */
};
enum { PROP_ST_OK = 0, PROP_ST_BAD_CMD = 1, PROP_ST_BAD_LEN = 2, PROP_ST_BAD_ARG = 3, PROP_ST_HW = 4 };

typedef struct {
    int      (*dac_write_code)(int ch, uint16_t code);   /* 0 = ok */
    void     (*od_set)(int ch, bool enable);
    int      (*cal_save)(const float *gain, const float *off);  /* 0 = ok */
    int64_t  (*now_ms)(void);
    void     (*lock)(void);      /* may be NULL */
    void     (*unlock)(void);    /* may be NULL */
} prop_hal_t;

typedef struct {
    const prop_hal_t *hal;
    uint8_t  node_addr;
    float    target_ma[PROP_NUM_CH];
    float    cal_gain[PROP_NUM_CH];
    float    cal_off[PROP_NUM_CH];
    uint8_t  enable_mask;
    uint32_t timeout_ms;
    int64_t  last_cmd_ms;
    int      fb_mv[PROP_NUM_CH];
    float    fb_ma[PROP_NUM_CH];
} prop_t;

typedef struct { uint8_t buf[300]; size_t n; } prop_stream_t;
typedef void (*prop_reply_cb)(const uint8_t *reply, size_t len, void *ctx);

void     prop_init(prop_t *p, const prop_hal_t *hal, uint8_t node_addr);
uint16_t prop_crc16(const uint8_t *d, size_t n);
uint16_t prop_ma_to_code(const prop_t *p, int ch, float ma);
size_t   prop_build_frame(uint8_t addr, uint8_t cmd, const uint8_t *payload, uint8_t len, uint8_t *out);

/* Returns false if the frame is invalid (bad SOF/length/CRC).
 * On true, *olen = reply length (0 = no reply: other address or broadcast). */
bool     prop_process_frame(prop_t *p, const uint8_t *f, size_t flen,
                            uint8_t *out, size_t out_max, size_t *olen);

/* Returns true if the failsafe tripped on this call. */
bool     prop_failsafe_poll(prop_t *p);
void     prop_set_feedback(prop_t *p, const int mv[PROP_NUM_CH]);

/* Byte-stream framing for RS-485 (handles garbage, partial frames, back-to-back frames). */
void     prop_stream_feed(prop_t *p, prop_stream_t *s, const uint8_t *d, size_t n,
                          prop_reply_cb cb, void *ctx);
void     prop_stream_gap(prop_stream_t *s);   /* inter-byte gap: drop partial frame */
