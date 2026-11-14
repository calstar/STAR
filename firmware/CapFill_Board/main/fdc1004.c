#include "fdc1004.h"

#include <math.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "fdc1004";

// Register map (FDC1004 datasheet, SNOSCY5)
#define REG_MEAS_MSB(n)   (0x00 + 2 * (n))   // n = 0..3
#define REG_MEAS_LSB(n)   (0x01 + 2 * (n))
#define REG_CONF_MEAS(n)  (0x08 + (n))
#define REG_FDC_CONF      0x0C
#define REG_MANUF_ID      0xFE
#define REG_DEVICE_ID     0xFF

#define MANUF_ID_TI       0x5449
#define DEVICE_ID_FDC1004 0x1004

#define FDC_CONF_RST      (1u << 15)
#define FDC_CONF_REPEAT   (1u << 8)
#define FDC_CONF_MEAS_ALL (0xFu << 4)        // bit7 = MEAS1 ... bit4 = MEAS4
#define FDC_CONF_DONE(n)  (1u << (3 - (n)))  // bit3 = DONE1 ... bit0 = DONE4

#define CHB_CAPDAC        0x4                // CHB = CAPDAC -> single-ended measurement
#define CAPDAC_PF_PER_LSB 3.125f
#define CAPDAC_MAX        31
#define MEAS_FULL_SCALE   15.0f              // +/-15 pF input range
#define RECENTER_PF       10.0f              // re-range CAPDAC beyond this

#define I2C_TIMEOUT_MS    50

static esp_err_t write_reg(fdc1004_t *fdc, uint8_t reg, uint16_t val)
{
    uint8_t buf[3] = { reg, (uint8_t)(val >> 8), (uint8_t)(val & 0xFF) };
    return i2c_master_transmit(fdc->dev, buf, sizeof(buf), I2C_TIMEOUT_MS);
}

static esp_err_t read_reg(fdc1004_t *fdc, uint8_t reg, uint16_t *val)
{
    uint8_t rx[2];
    esp_err_t err = i2c_master_transmit_receive(fdc->dev, &reg, 1, rx, 2, I2C_TIMEOUT_MS);
    if (err == ESP_OK) {
        *val = ((uint16_t)rx[0] << 8) | rx[1];
    }
    return err;
}

static esp_err_t write_conf_meas(fdc1004_t *fdc, int ch)
{
    // [15:13] CHA = CINx, [12:10] CHB = CAPDAC, [9:5] CAPDAC value
    uint16_t v = ((uint16_t)ch << 13) | (CHB_CAPDAC << 10) | ((uint16_t)(fdc->capdac[ch] & 0x1F) << 5);
    return write_reg(fdc, REG_CONF_MEAS(ch), v);
}

static esp_err_t start_repeat(fdc1004_t *fdc)
{
    uint16_t v = ((uint16_t)fdc->rate << 10) | FDC_CONF_REPEAT | FDC_CONF_MEAS_ALL;
    return write_reg(fdc, REG_FDC_CONF, v);
}

esp_err_t fdc1004_init(fdc1004_t *fdc, i2c_master_bus_handle_t bus, uint8_t addr, fdc1004_rate_t rate)
{
    *fdc = (fdc1004_t){ .rate = rate };

    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = 400000,
    };
    esp_err_t err = i2c_master_bus_add_device(bus, &cfg, &fdc->dev);
    if (err != ESP_OK) return err;

    uint16_t manuf = 0, dev = 0;
    if ((err = read_reg(fdc, REG_MANUF_ID, &manuf)) != ESP_OK) {
        ESP_LOGE(TAG, "no response at 0x%02X (%s)", addr, esp_err_to_name(err));
        return err;
    }
    read_reg(fdc, REG_DEVICE_ID, &dev);
    if (manuf != MANUF_ID_TI || dev != DEVICE_ID_FDC1004) {
        ESP_LOGE(TAG, "unexpected IDs: manuf=0x%04X dev=0x%04X", manuf, dev);
        return ESP_ERR_NOT_FOUND;
    }

    // Soft reset, then wait for the RST bit to self-clear.
    if ((err = write_reg(fdc, REG_FDC_CONF, FDC_CONF_RST)) != ESP_OK) return err;
    for (int i = 0; i < 20; i++) {
        uint16_t c = FDC_CONF_RST;
        vTaskDelay(pdMS_TO_TICKS(5));
        if (read_reg(fdc, REG_FDC_CONF, &c) == ESP_OK && !(c & FDC_CONF_RST)) break;
    }

    for (int ch = 0; ch < FDC1004_NUM_CH; ch++) {
        if ((err = write_conf_meas(fdc, ch)) != ESP_OK) return err;
    }
    if ((err = start_repeat(fdc)) != ESP_OK) return err;

    ESP_LOGI(TAG, "FDC1004 ready, 4 channels, rate code %d", rate);
    return ESP_OK;
}

// Shift CAPDAC so the measured part sits near 0 pF, keeping the reading inside +/-15 pF.
static bool rerange(fdc1004_t *fdc, int ch, float meas_pf)
{
    if (fabsf(meas_pf) < RECENTER_PF) return false;
    int steps = (int)lroundf(meas_pf / CAPDAC_PF_PER_LSB);
    int next = fdc->capdac[ch] + steps;
    if (next < 0) next = 0;
    if (next > CAPDAC_MAX) next = CAPDAC_MAX;
    if (next == fdc->capdac[ch]) return false;   // pinned at a limit
    fdc->capdac[ch] = (uint8_t)next;
    fdc->settle[ch] = 2;  // drop the in-flight sample taken with the old offset
    return true;
}

esp_err_t fdc1004_poll(fdc1004_t *fdc, fdc1004_sample_t out[FDC1004_NUM_CH])
{
    uint16_t conf;
    esp_err_t err = read_reg(fdc, REG_FDC_CONF, &conf);
    if (err != ESP_OK) return err;

    bool changed = false;
    for (int ch = 0; ch < FDC1004_NUM_CH; ch++) {
        out[ch] = (fdc1004_sample_t){ .capdac = fdc->capdac[ch] };
        if (!(conf & FDC_CONF_DONE(ch))) continue;

        uint16_t msb, lsb;
        if ((err = read_reg(fdc, REG_MEAS_MSB(ch), &msb)) != ESP_OK) return err;
        if ((err = read_reg(fdc, REG_MEAS_LSB(ch), &lsb)) != ESP_OK) return err;

        if (fdc->settle[ch] > 0) {
            fdc->settle[ch]--;
            continue;
        }

        // 24-bit two's complement: MSB[15:0] + LSB[15:8]
        uint32_t u = (((uint32_t)msb << 16) | lsb) >> 8;
        int32_t raw = (u & 0x800000) ? (int32_t)(u | 0xFF000000u) : (int32_t)u;
        float meas_pf = (float)raw / 524288.0f;           // 2^19 counts per pF

        out[ch].fresh = true;
        out[ch].saturated = (raw >= 0x7FFFFF || raw <= -0x800000);
        out[ch].pf = meas_pf + fdc->capdac[ch] * CAPDAC_PF_PER_LSB;
        // 3.125 pF per CAPDAC step * 2^19 counts/pF = 1,638,400 counts per step.
        // Max ~110 pF * 2^19 = ~5.8e7, well inside int32.
        out[ch].counts = raw + (int32_t)fdc->capdac[ch] * 1638400;

        if (rerange(fdc, ch, meas_pf)) {
            if ((err = write_conf_meas(fdc, ch)) != ESP_OK) return err;
            changed = true;
        }
    }

    if (changed) {
        // Re-issue FDC_CONF so the sequencer picks up the new CAPDAC values cleanly.
        err = start_repeat(fdc);
    }
    return err;
}
