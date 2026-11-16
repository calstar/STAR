// Rocket video transmitter, ESP32-P4: binds the application (components/
// tx_app: bring-up, the transport stream, the health watchdog) to the P4's
// drivers, then runs the camera, the SD recorder and the USB FPGA updater
// around it. The sequence itself is documented in tx_app.h; the end-to-end
// test (test/e2e) runs that same code against the FPGA's RTL.
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/uart.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "esp_cpu.h"
#include "spi_bitbang.h"
#include "tx_app.h"
#include "fpga_link_esp.h"
#include "spi_bus_esp.h"
#include "i2c_bus_esp.h"
#include "ecp5_cfg.h"
#if CONFIG_DVBT_VIDEO && DVBT_HAVE_VIDEO
#include "video_src.h"
#endif
#if CONFIG_DVBT_SD_RECORD
#include "recorder.h"
#endif
#if CONFIG_DVBT_SD_FORMAT
#define SD_FORMAT true
#else
#define SD_FORMAT false
#endif
#if CONFIG_DVBT_USB_FPGA_UPDATE
#include "fpga_update.h"
#endif

static const char *TAG = "dvbt";
static tx_app_t s_app;
static SemaphoreHandle_t s_mux_lock;

static const int PINS[] = {
    [TX_PIN_TXDIS] = CONFIG_DVBT_ADRF_TXDIS,
    [TX_PIN_DAC_RESET] = CONFIG_DVBT_DAC_RESET,
    [TX_PIN_LDET] = CONFIG_DVBT_ADRF_LDET,
    [TX_PIN_PA_EN] = CONFIG_DVBT_PA_EN,
    [TX_PIN_RF_PWR] = CONFIG_DVBT_RF_PWR,
    [TX_PIN_ARM] = CONFIG_DVBT_ARM,
};

static void gpio_set(void *ctx, tx_pin_t p, bool v) { gpio_set_level(PINS[p], v); }
static bool gpio_get(void *ctx, tx_pin_t p) { return gpio_get_level(PINS[p]); }

// The RF chain's outputs, all on chips powered by 5V_RF: driven (at their
// safe levels first) only while it is up, inputs with no pulls otherwise.
static const struct { int pin; bool level; } RF_OUT[] = {
    { CONFIG_DVBT_ADRF_TXDIS, 1 }, { CONFIG_DVBT_PA_EN, 0 }, { CONFIG_DVBT_ADRF_CS, 1 },
    { CONFIG_DVBT_ADRF_CLK, 0 }, { CONFIG_DVBT_ADRF_SDI, 0 },
};

static void rf_pins(void *ctx, bool drive)
{
    for (size_t i = 0; i < sizeof RF_OUT / sizeof RF_OUT[0]; i++) {
        if (drive) gpio_set_level(RF_OUT[i].pin, RF_OUT[i].level);
        gpio_set_direction(RF_OUT[i].pin, drive ? GPIO_MODE_OUTPUT : GPIO_MODE_INPUT);
    }
}

// The ADRF6755's own SPI lines, bit-banged (spi_bitbang.h).
static const int BB_PIN[] = { [SPI_BB_CLK] = CONFIG_DVBT_ADRF_CLK, [SPI_BB_SDI] = CONFIG_DVBT_ADRF_SDI,
                              [SPI_BB_CS] = CONFIG_DVBT_ADRF_CS };
static void bb_set(void *ctx, spi_bb_pin_t p, bool v) { gpio_set_level(BB_PIN[p], v); }
static bool bb_sdo(void *ctx) { return gpio_get_level(CONFIG_DVBT_ADRF_SDO); }
static void bb_half(void *ctx)
{
    uint32_t t0 = esp_cpu_get_cycle_count();
    uint32_t n = CONFIG_DVBT_ADRF_HALF_NS * CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ / 1000;
    while (esp_cpu_get_cycle_count() - t0 < n) {}
}
static const spi_bitbang_t BB = { .set = bb_set, .get_sdo = bb_sdo, .half = bb_half };
static int64_t now_us(void *ctx) { return esp_timer_get_time(); }

static void delay_us(void *ctx, uint32_t us)
{
    if (us >= 2000) vTaskDelay(pdMS_TO_TICKS((us + 999) / 1000));
    else esp_rom_delay_us(us);
}

// tx_app logs from the TS task. A console write can block (the USB
// Serial/JTAG console with no host attached waits for its timeout), and a
// TS task blocked for more than the FPGA FIFO's depth makes the FPGA insert
// null packets. So the callback only queues the line; a low-priority task
// prints it, and lines are dropped (counted) when the queue is full.
typedef struct { char lvl; char m[120]; } log_line_t;
static QueueHandle_t s_logq;
static volatile uint32_t s_log_dropped;

static void log_task(void *arg)
{
    log_line_t l;
    for (;;) {
        if (xQueueReceive(s_logq, &l, portMAX_DELAY) != pdTRUE) continue;
        if (l.lvl == 'E') ESP_LOGE(TAG, "%s", l.m);
        else if (l.lvl == 'W') ESP_LOGW(TAG, "%s", l.m);
        else ESP_LOGI(TAG, "%s", l.m);
    }
}

static void log_cb(void *ctx, char lvl, const char *m)
{
    log_line_t l = { .lvl = lvl };
    strlcpy(l.m, m, sizeof l.m);
    if (!s_logq || xQueueSend(s_logq, &l, 0) != pdTRUE) s_log_dropped++;
}

// The flight computer's UART (protocol in fc_link.h). Reads never block;
// writes go to the driver's TX buffer.
static size_t fc_read(void *ctx, uint8_t *buf, size_t max)
{
    int n = uart_read_bytes(CONFIG_DVBT_FC_UART, buf, max, 0);
    return n > 0 ? (size_t)n : 0;
}

static void fc_write(void *ctx, const char *line) { uart_write_bytes(CONFIG_DVBT_FC_UART, line, strlen(line)); }

static void mux_lock(void *ctx, bool take)
{
    if (take) xSemaphoreTake(s_mux_lock, portMAX_DELAY);
    else xSemaphoreGive(s_mux_lock);
}

static const ecp5_esp_config_t CFG_PORT = {
    .spi_host = SPI2_HOST, .pin_cclk = CONFIG_DVBT_CFG_CCLK, .pin_mosi = CONFIG_DVBT_CFG_MOSI,
    .pin_miso = CONFIG_DVBT_CFG_MISO, .pin_sn = CONFIG_DVBT_CFG_SN,
    .pin_programn = CONFIG_DVBT_CFG_PROGRAMN, .pin_initn = CONFIG_DVBT_CFG_INITN,
    .pin_done = CONFIG_DVBT_CFG_DONE, .pin_cfg0 = CONFIG_DVBT_CFG_CFG0,
    .pin_cfg1 = CONFIG_DVBT_CFG_CFG1, .cfg_sspi = CONFIG_DVBT_CFG_SSPI_CODE,
    .clock_hz = CONFIG_DVBT_CFG_SPI_HZ, .partition = "fpga",
};
static const fpga_link_esp_config_t LINK = {
    .spi_host = SPI2_HOST, .pin_sck = CONFIG_DVBT_FPGA_SCK, .pin_mosi = CONFIG_DVBT_FPGA_MOSI,
    .pin_miso = CONFIG_DVBT_FPGA_MISO, .pin_cs = CONFIG_DVBT_FPGA_CS,
    .pin_dreq = CONFIG_DVBT_FPGA_DREQ, .clock_hz = CONFIG_DVBT_FPGA_SPI_HZ,
};
#if CONFIG_DVBT_SD_RECORD
static void on_sent(void *ctx, const uint8_t *pkts, size_t n) { recorder_push(pkts, n); }
#define ON_SENT on_sent
#else
#define ON_SENT NULL
#endif
static ecp5_hal_t s_ecp5;
static fpga_link_t s_link;

// SPI2 serves the configuration port during a load and the stream link after.
static esp_err_t fpga_port(void *ctx, bool open)
{
    size_t part = 0;
    if (open) {
        fpga_link_esp_deinit();
        return ecp5_esp_open(&CFG_PORT, &s_ecp5, &part);
    }
    ecp5_esp_close();
    return fpga_link_esp_init(&LINK, &s_link);
}

#if CONFIG_DVBT_VIDEO && DVBT_HAVE_VIDEO
static void on_frame(const uint8_t *au, size_t n, bool key, int64_t capture_us, void *arg)
{
    tx_put_frame(&s_app, au, n, key, capture_us);
}
#endif

#if CONFIG_DVBT_USB_FPGA_UPDATE
static void before_update(void)
{
    // Flash writes stall the CPU caches: stop transmitting cleanly first.
    xSemaphoreTake(s_mux_lock, portMAX_DELAY);
    tx_rf_hold(&s_app);
    ESP_LOGW(TAG, "FPGA update: RF off; restarting when it is written");
}
#endif

void app_main(void)
{
    s_mux_lock = xSemaphoreCreateMutex();
    s_logq = xQueueCreate(32, sizeof(log_line_t));
    xTaskCreate(log_task, "log", 3072, NULL, 1, NULL);
    gpio_set_level(CONFIG_DVBT_DAC_RESET, 0);
    gpio_config_t out = { .pin_bit_mask = 1ULL << CONFIG_DVBT_DAC_RESET, .mode = GPIO_MODE_OUTPUT };
    ESP_ERROR_CHECK(gpio_config(&out));
    // Inputs, no pulls: the sense lines, and the RF chain's outputs until 5V_RF
    // is up (PA_EN's board pull-down holds the PA off meanwhile).
    uint64_t in_mask = (1ULL << CONFIG_DVBT_ADRF_LDET) | (1ULL << CONFIG_DVBT_RF_PWR) | (1ULL << CONFIG_DVBT_ARM) |
                       (1ULL << CONFIG_DVBT_ADRF_SDO);
    for (size_t i = 0; i < sizeof RF_OUT / sizeof RF_OUT[0]; i++) in_mask |= 1ULL << RF_OUT[i].pin;
    gpio_config_t in = { .pin_bit_mask = in_mask, .mode = GPIO_MODE_INPUT };
    ESP_ERROR_CHECK(gpio_config(&in));
#if CONFIG_DVBT_LED >= 0
    gpio_set_level(CONFIG_DVBT_LED, 0);
    gpio_config_t led = { .pin_bit_mask = 1ULL << CONFIG_DVBT_LED, .mode = GPIO_MODE_OUTPUT };
    ESP_ERROR_CHECK(gpio_config(&led));
#endif

    uart_config_t uc = { .baud_rate = CONFIG_DVBT_FC_BAUD, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE,
                         .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT };
    ESP_ERROR_CHECK(uart_driver_install(CONFIG_DVBT_FC_UART, 512, 1024, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(CONFIG_DVBT_FC_UART, &uc));
    ESP_ERROR_CHECK(uart_set_pin(CONFIG_DVBT_FC_UART, CONFIG_DVBT_FC_TX, CONFIG_DVBT_FC_RX, UART_PIN_NO_CHANGE,
                                 UART_PIN_NO_CHANGE));

    static i2c_bus_if_t i2c;
    ESP_ERROR_CHECK(i2c_bus_esp_init(CONFIG_DVBT_I2C_SDA, CONFIG_DVBT_I2C_SCL, &i2c));
    static spi_bus_if_t dac_bus, lo_bus;
    spi_bus_esp_config_t sc = {         // 3-wire: the AD9116 answers on SDIO
        .spi_host = SPI3_HOST, .pin_sclk = CONFIG_DVBT_DAC_SCLK, .pin_sdio = CONFIG_DVBT_DAC_SDIO,
        .pin_miso = -1, .pin_cs = { CONFIG_DVBT_DAC_CS }, .n_dev = 1, .clock_hz = CONFIG_DVBT_DAC_SPI_HZ,
    };
    ESP_ERROR_CHECK(spi_bus_esp_init(&sc, &dac_bus));
    spi_bitbang_bus(&BB, &lo_bus);
    size_t part = 0;
    ESP_ERROR_CHECK(ecp5_esp_open(&CFG_PORT, &s_ecp5, &part));   // for the partition size
    ecp5_esp_close();

    static tx_board_t board;
    board = (tx_board_t){
        .i2c = &i2c, .ecp5 = &s_ecp5, .fpga_part_size = part, .fpga_port = fpga_port,
        .link = &s_link, .dac_bus = &dac_bus, .lo_bus = &lo_bus, .rf_pins = rf_pins, .gpio_set = gpio_set, .gpio_get = gpio_get,
        .now_us = now_us, .delay_us = delay_us, .log = log_cb, .mux_lock = mux_lock,
        .on_sent = ON_SENT, .fc_read = fc_read, .fc_write = fc_write,
    };
    tx_config_t cfg = {
        .xtal_hz = CONFIG_DVBT_SI5351_XTAL_HZ, .xtal_load_pf = CONFIG_DVBT_SI5351_LOAD_PF,
        .refin_hz = CONFIG_DVBT_ADRF_REFIN_HZ, .refin_tol_ppm = CONFIG_DVBT_ADRF_REFIN_TOL_PPM, .lo_hz = (uint64_t)CONFIG_DVBT_LO_KHZ * 1000,
        .lo_min_hz = (uint64_t)CONFIG_DVBT_LO_MIN_KHZ * 1000, .lo_max_hz = (uint64_t)CONFIG_DVBT_LO_MAX_KHZ * 1000,
        .atten_db = CONFIG_DVBT_ADRF_ATTEN_DB,
        .tcxo_start_us = CONFIG_DVBT_TCXO_START_US, .arm_ms = CONFIG_DVBT_ARM_MS,
#if !CONFIG_DVBT_ARM_GATES_RF
        .rf_without_arm = true,
#endif
        .bw_mhz = 6, .mod = 0, .rate = 0, .guard = 2,        // QPSK 1/2, guard 1/8
        .provider = "STAR", .service = CONFIG_DVBT_CALLSIGN,
        .video_delay_ms = CONFIG_DVBT_VIDEO_DELAY_MS,
        .mux_buf_size = 256 * 1024, .health_ms = CONFIG_DVBT_HEALTH_MS,
        .dc_i = CONFIG_DVBT_CAL_DC_I, .dc_q = CONFIG_DVBT_CAL_DC_Q,
        .gain_i = CONFIG_DVBT_CAL_GAIN_I, .gain_q = CONFIG_DVBT_CAL_GAIN_Q, .phase = CONFIG_DVBT_CAL_PHASE,
    };
    cfg.mux_buf = heap_caps_malloc(cfg.mux_buf_size, MALLOC_CAP_SPIRAM);
    ESP_ERROR_CHECK(cfg.mux_buf ? ESP_OK : ESP_ERR_NO_MEM);
    esp_err_t e = tx_bringup(&s_app, &board, &cfg);
    if (e != ESP_OK) {
        // RF stays off. Keep the USB updater alive so a bad FPGA image can be replaced.
        ESP_LOGE(TAG, "bring-up failed (0x%x): RF off", e);
    }

#if CONFIG_DVBT_USB_FPGA_UPDATE
    if (fpga_update_usb_start("fpga", before_update) != ESP_OK)
        ESP_LOGW(TAG, "USB FPGA updater not started");
#endif
    if (e != ESP_OK) {
        for (uint32_t n = 0;; n++) {    // fast blink: bring-up failed
#if CONFIG_DVBT_LED >= 0
            gpio_set_level(CONFIG_DVBT_LED, n & 1);
#endif
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
#if CONFIG_DVBT_SD_RECORD
    recorder_config_t rc = { .pin_clk = CONFIG_DVBT_SD_CLK, .pin_cmd = CONFIG_DVBT_SD_CMD,
                             .pin_d0 = CONFIG_DVBT_SD_D0, .pin_d1 = CONFIG_DVBT_SD_D0 + 1,
                             .pin_d2 = CONFIG_DVBT_SD_D0 + 2, .pin_d3 = CONFIG_DVBT_SD_D0 + 3,
                             .width = CONFIG_DVBT_SD_WIDTH,
                             .format = SD_FORMAT, .ring_bytes = 1024 * 1024 };
    if (recorder_start(&rc) != ESP_OK) ESP_LOGW(TAG, "SD NAND not mounted: not recording");
#endif
#if CONFIG_DVBT_VIDEO && DVBT_HAVE_VIDEO
#if CONFIG_DVBT_CAM_EN >= 0
    // The OV5647 module's own 24 MHz oscillator clocks it (the board's
    // optional clock from GPIO53 is not fitted).
    gpio_set_level(CONFIG_DVBT_CAM_EN, 1);
    gpio_config_t cam = { .pin_bit_mask = 1ULL << CONFIG_DVBT_CAM_EN, .mode = GPIO_MODE_OUTPUT };
    ESP_ERROR_CHECK(gpio_config(&cam));
    vTaskDelay(pdMS_TO_TICKS(20));
#endif
    video_src_config_t vc = {
        .sccb_port = 1, .sccb_scl = CONFIG_DVBT_CAM_SCCB_SCL, .sccb_sda = CONFIG_DVBT_CAM_SCCB_SDA,
        .reset_pin = CONFIG_DVBT_CAM_RESET, .pwdn_pin = CONFIG_DVBT_CAM_PWDN,
        .width = CONFIG_DVBT_VIDEO_WIDTH, .height = CONFIG_DVBT_VIDEO_HEIGHT,
        .bitrate = CONFIG_DVBT_VIDEO_KBPS * 1000, .gop = CONFIG_DVBT_VIDEO_GOP,
        .min_qp = 20, .max_qp = 45, .cb = on_frame,
    };
    if (video_src_start(&vc) != ESP_OK)
        ESP_LOGE(TAG, "no camera: transmitting the service without video");
#endif

    for (uint32_t n = 0;; n++) {
        tx_pump(&s_app);
#if CONFIG_DVBT_LED >= 0
        // On air: steady. Otherwise a slow blink (stream up, RF off).
        if ((n & 0x3FF) == 0)
            gpio_set_level(CONFIG_DVBT_LED, s_app.on_air || ((esp_timer_get_time() >> 19) & 1));
#endif
        if ((n & 0x1FFF) == 0) {                // through the queue: never blocks this task
            char m[120];
            snprintf(m, sizeof m, "rf %d%s, faults %03lx, recoveries %lu, nulls %llu, frames %llu (dropped %llu), backlog %u B, log drops %lu",
                     (int)s_app.rf, s_app.armed ? " armed" : "", (unsigned long)s_app.faults, (unsigned long)s_app.recoveries, s_app.nulls, s_app.frames,
                     s_app.frames_dropped, (unsigned)ts_mux_backlog(&s_app.mux), (unsigned long)s_log_dropped);
            log_cb(NULL, 'I', m);
        }
    }
}
