// Simulated FDC1004 behind the ESP-IDF i2c_master API, per TI SNOSCY5C register map.
// Repeat mode: one channel completes per FDC_CONF poll (round robin), like 100 S/s with 10 ms polls.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "driver/i2c_master.h"
#include "fdc1004.h"

double g_true_pf[4];
uint16_t g_dev_id = 0x1004;
static uint16_t regs[256];
static int next_ch;
static double noise(void) { return ((rand() % 2001) - 1000) / 1000.0 * 0.002; }   // +/-2 fF

static void measure(int ch)
{
    uint16_t conf = regs[0x08 + ch];
    int capdac = (conf >> 5) & 0x1F;
    double m = g_true_pf[ch] + noise() - capdac * 3.125;
    double c = round(m * 524288.0);
    if (c > 8388607) c = 8388607;
    if (c < -8388608) c = -8388608;
    int32_t v = (int32_t)c;
    uint32_t u = (uint32_t)v & 0xFFFFFF;
    regs[2 * ch] = (uint16_t)(u >> 8);
    regs[2 * ch + 1] = (uint16_t)((u & 0xFF) << 8);
    regs[0x0C] |= (1u << (3 - ch));          // DONE_x
}

esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t b, const i2c_device_config_t *c, i2c_master_dev_handle_t *d)
{ *d = (i2c_master_dev_handle_t)0x1; regs[0xFE] = 0x5449; regs[0xFF] = g_dev_id; return c->device_address == 0x50 ? ESP_OK : ESP_FAIL; }
esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t d) { return ESP_OK; }

esp_err_t i2c_master_transmit(i2c_master_dev_handle_t d, const uint8_t *b, size_t n, int t)
{
    if (n != 3) return ESP_FAIL;
    uint16_t v = (b[0 + 1] << 8) | b[2];
    if (b[0] == 0x0C) {
        if (v & 0x8000) { memset(regs, 0, 0x0D * 2); regs[0x0C] = 0; return ESP_OK; }   // reset (self-clears)
        regs[0x0C] = v & 0x0FF0;
    } else regs[b[0]] = v;
    return ESP_OK;
}

esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t d, const uint8_t *w, size_t wn, uint8_t *r, size_t rn, int t)
{
    uint8_t a = w[0];
    if (a == 0x0C && (regs[0x0C] & 0x0100) && (regs[0x0C] & 0x00F0)) { measure(next_ch); next_ch = (next_ch + 1) % 4; }
    uint16_t v = regs[a];
    r[0] = v >> 8; r[1] = v & 0xFF;
    if (a <= 7 && (a & 1)) regs[0x0C] &= ~(1u << (3 - a / 2));   // DONE clears after LSB read
    return ESP_OK;
}
