#include "si5351.h"
#include "esp_check.h"
#include "freertos/FreeRTOS.h"

static const char *TAG = "si5351";
#define ADDR 0x60

static esp_err_t wr(i2c_master_dev_handle_t d, uint8_t reg, const uint8_t *v, size_t n)
{
    uint8_t buf[9];
    buf[0] = reg;
    for (size_t i = 0; i < n; i++) buf[1 + i] = v[i];
    return i2c_master_transmit(d, buf, n + 1, 100);
}

static esp_err_t wr1(i2c_master_dev_handle_t d, uint8_t reg, uint8_t v)
{
    return wr(d, reg, &v, 1);
}

esp_err_t si5351_start_clk0(i2c_master_bus_handle_t bus, uint32_t xtal_hz, int load_pf,
                            uint64_t fout_num, uint64_t fout_den, si5351_plan_t *plan)
{
    ESP_RETURN_ON_FALSE(si5351_plan(xtal_hz, fout_num, fout_den, plan), ESP_ERR_INVALID_ARG,
                        TAG, "no plan for that frequency");
    i2c_device_config_t dc = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = ADDR,
                               .scl_speed_hz = 400000 };
    i2c_master_dev_handle_t d;
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(bus, &dc, &d), TAG, "add");

    // Wait for SYS_INIT to clear (reg 0 bit 7) after power-up.
    uint8_t reg0 = 0, st = 0x80;
    for (int i = 0; i < 100 && (st & 0x80); i++) {
        ESP_RETURN_ON_ERROR(i2c_master_transmit_receive(d, &reg0, 1, &st, 1, 100), TAG, "status");
        if (st & 0x80) vTaskDelay(pdMS_TO_TICKS(1));
    }
    ESP_RETURN_ON_FALSE(!(st & 0x80), ESP_ERR_TIMEOUT, TAG, "SYS_INIT stuck");

    ESP_RETURN_ON_ERROR(wr1(d, 3, 0xFF), TAG, "outputs off");
    for (uint8_t r = 16; r <= 23; r++) ESP_RETURN_ON_ERROR(wr1(d, r, 0x80), TAG, "pdn");
    uint8_t load = load_pf <= 6 ? 0x40 : load_pf <= 8 ? 0x80 : 0xC0;
    ESP_RETURN_ON_ERROR(wr1(d, 183, load | 0x12), TAG, "xtal load");
    ESP_RETURN_ON_ERROR(wr1(d, 149, 0x00), TAG, "spread spectrum off");

    uint8_t b[8];
    si5351_params_t pll = si5351_encode(plan->pll_a, plan->pll_b, plan->pll_c);
    si5351_pack(&pll, 0, b);
    ESP_RETURN_ON_ERROR(wr(d, 26, b, 8), TAG, "PLLA");
    si5351_params_t ms = si5351_encode(plan->ms_div, 0, 1);
    si5351_pack(&ms, plan->r_div_log2, b);
    ESP_RETURN_ON_ERROR(wr(d, 42, b, 8), TAG, "MS0");
    ESP_RETURN_ON_ERROR(wr1(d, 177, 0x20), TAG, "PLLA reset");
    // CLK0: powered up, MS0 integer mode, from PLLA, not inverted, from MS0, 8 mA.
    ESP_RETURN_ON_ERROR(wr1(d, 16, 0x4F), TAG, "CLK0 ctrl");
    ESP_RETURN_ON_ERROR(wr1(d, 3, 0xFE), TAG, "CLK0 on");
    ESP_LOGI(TAG, "CLK0 %.3f Hz (VCO %.3f Hz = %lu x (%lu + %lu/%lu), MS %lu)", plan->out_hz,
             plan->vco_hz, (unsigned long)xtal_hz, (unsigned long)plan->pll_a,
             (unsigned long)plan->pll_b, (unsigned long)plan->pll_c, (unsigned long)plan->ms_div);
    return ESP_OK;
}
