// Rocket video transmitter, ESP32-P4: bring-up and the transport stream.
//
// 1. Si5351A CLK0 = 192/7 MHz (27.428571 MHz) for the FPGA and the DAC.
// 2. FPGA link up (ID check).
// 3. Setup bus: lock the ADRF6755 into SPI mode first (it powers up in I2C
//    mode on the same SCLK/SDIO lines), then the AD9116: reset, two's
//    complement, retimer.
// 4. ADRF6755: PLL to the carrier with the RF off (TXDIS high, modulator
//    powered down), wait for LDET.
// 5. Modulator configured (2K, QPSK 1/2, guard 1/8), TS primed, tx on;
//    then the ADRF6755's modulator on and TXDIS low: RF out.
// 6. TS: for now null packets only (the RF signal is real DVB-T, with no
//    services in it); the H.264 encoder and the muxer come next.
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2c_master.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "fpga_link.h"
#include "dvbt_regs.h"
#include "si5351.h"
#include "ad9116.h"
#include "adrf6755.h"
#include "driver/gpio.h"
#include "esp_timer.h"

static const char *TAG = "dvbt";

static void dac_reset(void *ctx, bool high)
{
    (void)ctx;
    fpga_reg_write(DVBT_REG_GPIO, high ? 1 : 0);
}

static void null_packet(uint8_t *p)
{
    memset(p, 0xFF, TS_PACKET);
    p[0] = 0x47; p[1] = 0x1F; p[2] = 0xFF; p[3] = 0x10;
}

void app_main(void)
{
    i2c_master_bus_config_t ic = {
        .i2c_port = -1, .sda_io_num = CONFIG_DVBT_I2C_SDA, .scl_io_num = CONFIG_DVBT_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c;
    ESP_ERROR_CHECK(i2c_new_master_bus(&ic, &i2c));
    si5351_plan_t plan;
    ESP_ERROR_CHECK(si5351_start_clk0(i2c, CONFIG_DVBT_SI5351_XTAL_HZ, CONFIG_DVBT_SI5351_LOAD_PF,
                                      192000000ull, 7, &plan));
    vTaskDelay(pdMS_TO_TICKS(10));          // FPGA PLL lock + its 2^10-clock reset

    fpga_link_config_t fc = {
        .spi_host = SPI2_HOST, .pin_sck = CONFIG_DVBT_FPGA_SCK, .pin_mosi = CONFIG_DVBT_FPGA_MOSI,
        .pin_miso = CONFIG_DVBT_FPGA_MISO, .pin_cs = CONFIG_DVBT_FPGA_CS,
        .pin_dreq = CONFIG_DVBT_FPGA_DREQ, .clock_hz = CONFIG_DVBT_FPGA_SPI_HZ,
    };
    ESP_ERROR_CHECK(fpga_link_init(&fc));
    ESP_LOGI(TAG, "FPGA up");

    // RF stays off until the end: TXDIS high.
    gpio_config_t txdis = { .pin_bit_mask = 1ULL << CONFIG_DVBT_ADRF_TXDIS, .mode = GPIO_MODE_OUTPUT };
    ESP_ERROR_CHECK(gpio_config(&txdis));
    gpio_set_level(CONFIG_DVBT_ADRF_TXDIS, 1);
    gpio_config_t ldet = { .pin_bit_mask = 1ULL << CONFIG_DVBT_ADRF_LDET, .mode = GPIO_MODE_INPUT };
    ESP_ERROR_CHECK(gpio_config(&ldet));

    spi_bus_if_t setup;
    fpga_setup_bus(&setup, 4);              // 27.43 MHz / 10 = 2.7 MHz SCLK
    adrf6755_t mod = { .bus = &setup, .dev = 1 };
    ESP_ERROR_CHECK(adrf6755_lock_spi(&mod));
    ad9116_t dac = { .bus = &setup, .dev = 0, .set_reset = dac_reset };
    uint8_t ver = 0;
    ESP_ERROR_CHECK(ad9116_init(&dac, true, &ver));
    ESP_LOGI(TAG, "AD9116 version %02x, retimer locked", ver);

    adrf6755_plan_t lo;
    if (!adrf6755_plan(CONFIG_DVBT_ADRF_REFIN_HZ, (uint64_t)CONFIG_DVBT_LO_KHZ * 1000, &lo)) {
        ESP_LOGE(TAG, "no ADRF6755 plan for %d kHz from %d Hz", CONFIG_DVBT_LO_KHZ, CONFIG_DVBT_ADRF_REFIN_HZ);
        abort();
    }
    ESP_ERROR_CHECK(adrf6755_init(&mod, &lo, CONFIG_DVBT_ADRF_ATTEN_DB));
    int64_t t0 = esp_timer_get_time();
    while (!gpio_get_level(CONFIG_DVBT_ADRF_LDET)) {
        if (esp_timer_get_time() - t0 > 10000) {
            ESP_LOGE(TAG, "ADRF6755 PLL did not lock (LDET low after 10 ms)");
            abort();
        }
    }
    ESP_LOGI(TAG, "ADRF6755 locked: LO %.1f Hz (PFD %lu, INT %u, FRAC %lu, RFDIV %u)", lo.lo_hz,
             (unsigned long)lo.pfd_hz, lo.intg, (unsigned long)lo.frac, lo.rfdiv);

    uint32_t ctrl = DVBT_CTRL_MOD(0) | DVBT_CTRL_RATE(0) | DVBT_CTRL_GUARD(2);   // two's complement
    ESP_ERROR_CHECK(fpga_reg_write(DVBT_REG_CTRL, ctrl));
    ESP_ERROR_CHECK(fpga_reg_write(DVBT_REG_STATUS, 0x8000000Fu));              // clear flags

    static uint8_t pkts[2 * TS_PACKET];
    null_packet(pkts);
    null_packet(pkts + TS_PACKET);
    // Prime the TS FIFO while tx_en is low: send until the status byte says
    // DREQ has fallen (it is sampled at the start of each frame, so this
    // overshoots by at most the packet in flight -- DREQ leaves room for 2).
    uint8_t sb = DVBT_SB_DREQ;
    while (sb & DVBT_SB_DREQ)
        ESP_ERROR_CHECK(fpga_ts_send(pkts, 1, 100, &sb));
    ESP_ERROR_CHECK(fpga_reg_write(DVBT_REG_CTRL, ctrl | DVBT_CTRL_TX_EN));
    ESP_ERROR_CHECK(adrf6755_modulator_on(&mod, true));     // only after lock (step 34)
    gpio_set_level(CONFIG_DVBT_ADRF_TXDIS, 0);
    ESP_LOGI(TAG, "transmitting at %.3f MHz", lo.lo_hz / 1e6);

    for (uint32_t n = 0;; n++) {
        ESP_ERROR_CHECK(fpga_ts_send(pkts, 2, 1000, &sb));
        if ((n & 0x3FFF) == 0) {
            uint32_t st = 0;
            fpga_reg_read(DVBT_REG_STATUS, &st);
            ESP_LOGI(TAG, "status %08lx, %lu nulls inserted", (unsigned long)st,
                     (unsigned long)DVBT_ST_NULLS(st));
        }
    }
}
