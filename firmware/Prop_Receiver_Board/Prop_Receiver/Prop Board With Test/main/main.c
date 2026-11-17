/*
 * STAR Prop Receiver firmware (ESP-IDF v5.3+)
 *
 *  - Shared SPI2 bus: W5500 Ethernet (mode 0) + DAC80508 (mode 1)
 *  - DAC80508 -> 5x XTR111 current-loop outputs (0..LOOP_MA_MAX, see pins.h)
 *  - OD_CRTL1..5 enable lines (push-pull; board has 10k pull-downs)
 *  - MOTOR_ADC_1..5 feedback on ADC1
 *  - RS-485 (ST3485, half duplex, manual DE//RE control)
 *  - One binary protocol served over UDP (Ethernet) and RS-485
 *  - Failsafe: outputs drop to 0 mA / disabled if commands stop arriving
 *  - USB-C: console/logging + flashing via USB Serial/JTAG
 *
 * UNTESTED ON HARDWARE. Check pins.h (and the board issues in README.md) first.
 */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>
#include <errno.h>
#include <unistd.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/event_groups.h"

#include "esp_log.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_eth.h"
#include "esp_mac.h"
#include "esp_rom_sys.h"
#if __has_include("esp_eth_mac_spi.h")
#include "esp_eth_mac_spi.h"
#endif
#include "nvs_flash.h"
#include "nvs.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/uart.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"

#include "lwip/sockets.h"

#include "pins.h"
#include "prop_core.h"

static const char *TAG = "prop_rx";

/* ===================== Configuration ===================== */
#define NUM_CH              PROP_NUM_CH
#define NODE_ADDR           0x01

#define SPI_HOST            SPI2_HOST
#define ETH_SPI_CLK_HZ      (20 * 1000 * 1000)
#define DAC_SPI_CLK_HZ      (10 * 1000 * 1000)

#define USE_STATIC_IP       0               /* 0 = DHCP */
#define STATIC_IP           ESP_IP4TOADDR(192, 168, 1, 50)
#define STATIC_GW           ESP_IP4TOADDR(192, 168, 1, 1)
#define STATIC_MASK         ESP_IP4TOADDR(255, 255, 255, 0)
#define UDP_PORT            5005

#define RS485_UART          UART_NUM_1
#define RS485_BAUD          115200
#define RS485_GAP_MS        20              /* inter-byte gap that drops a partial frame */


/* ===================== DAC80508 registers ===================== */
/* Checked against TI SLASEL1D, Table 8 (register map) and Table 2 (24-bit frame:
 * bit 23 = R/W, bits 22:20 = 0, bits 19:16 = address, bits 15:0 = data; SDI sampled on SCLK falling edge). */
#define DAC_REG_NOP         0x00
#define DAC_REG_DEVICE_ID   0x01
#define DAC_REG_SYNC        0x02   /* reset 0xFF00: SYNC-EN = 0 -> outputs update immediately */
#define DAC_REG_CONFIG      0x03   /* bit8 REF-PWDWN, bits7:0 DACn-PWDWN (1 = powered down, 1k to GND) */
#define DAC_REG_GAIN        0x04   /* bit10 CLR-4TO7-MSK, bit9 CLR-0TO3-MSK (C variant), bit8 REFDIV-EN, bits7:0 BUFFn-GAIN */
#define DAC_REG_TRIGGER     0x05   /* bits3:0 SOFT-RESET, code 1010 = reset */
#define DAC_REG_DAC0        0x08   /* DACn = 0x08 + n */
#define DAC_READ_FLAG       0x80

#define DAC_SOFT_RESET      0x000A
#define DAC_USED_MASK       ((1u << NUM_CH) - 1)
#define DAC_GAIN_VALUE      ((DAC_HAS_CLR_PIN ? (1u << 10) | (1u << 9) : 0u) |                              (DAC_REF_DIV == 2 ? (1u << 8) : 0u) |                                              (DAC_BUFF_GAIN == 2 ? DAC_USED_MASK : 0u))
#define DAC_CONFIG_VALUE    (0xFFu & ~DAC_USED_MASK)   /* internal ref on, unused channels 5-7 powered down */

#if (DAC_REF_DIV != 1 && DAC_REF_DIV != 2) || (DAC_BUFF_GAIN != 1 && DAC_BUFF_GAIN != 2)
#error "DAC_REF_DIV and DAC_BUFF_GAIN must each be 1 or 2"
#endif
#if DAC_REF_DIV == 1 && DAC_BUFF_GAIN == 1
#error "DIV 1 / GAIN 1 is 'not recommended' by the DAC80508 datasheet (Table 1)"
#endif

/* ===================== Global state ===================== */
static prop_t s_core;                 /* all logic lives in prop_core.c */
static SemaphoreHandle_t s_lock;
static EventGroupHandle_t s_ev;
#define BIT_IP   BIT0

static spi_device_handle_t s_dac;
static adc_oneshot_unit_handle_t s_adc;
static adc_channel_t s_adc_ch[NUM_CH];
static adc_cali_handle_t s_cali[NUM_CH];
static bool s_adc_ok;

static const int OD_PINS[NUM_CH]  = { PIN_OD_CRTL_1, PIN_OD_CRTL_2, PIN_OD_CRTL_3, PIN_OD_CRTL_4, PIN_OD_CRTL_5 };
static const int ADC_PINS[NUM_CH] = { PIN_MOTOR_ADC_1, PIN_MOTOR_ADC_2, PIN_MOTOR_ADC_3, PIN_MOTOR_ADC_4, PIN_MOTOR_ADC_5 };


/* ===================== DAC80508 driver ===================== */
static esp_err_t dac_xfer(uint8_t cmd, uint16_t val, uint16_t *rd)
{
    spi_transaction_t t = { .length = 24, .flags = SPI_TRANS_USE_TXDATA | SPI_TRANS_USE_RXDATA };
    t.tx_data[0] = cmd;
    t.tx_data[1] = (uint8_t)(val >> 8);
    t.tx_data[2] = (uint8_t)(val & 0xFF);
    esp_err_t e = spi_device_polling_transmit(s_dac, &t);
    if (e == ESP_OK && rd) *rd = ((uint16_t)t.rx_data[1] << 8) | t.rx_data[2];
    return e;
}

static esp_err_t dac_write(uint8_t reg, uint16_t val) { return dac_xfer(reg & 0x7F, val, NULL); }

#if !DAC_HAS_CLR_PIN
static esp_err_t dac_read(uint8_t reg, uint16_t *val)
{
    esp_err_t e = dac_xfer(DAC_READ_FLAG | reg, 0, NULL);   /* request   */
    if (e != ESP_OK) return e;
    return dac_xfer(DAC_REG_NOP, 0, val);                    /* clock out */
}
#endif

static esp_err_t dac_init(void)
{
    spi_device_interface_config_t dc = {
        .mode = 1,                       /* CPOL=0, CPHA=1 */
        .clock_speed_hz = DAC_SPI_CLK_HZ,
        .spics_io_num = PIN_DAC_CS,
        .queue_size = 4,
    };
    esp_err_t e = spi_bus_add_device(SPI_HOST, &dc, &s_dac);
    if (e != ESP_OK) return e;

    /* Soft reset -> zero-scale (Z variant), gain 1, no divider. Then GAIN first, so the CLR masks are set
     * before any W5500 traffic on MISO (= CLR pin on the ZC variant) can matter. */
    e = dac_write(DAC_REG_TRIGGER, DAC_SOFT_RESET);
    if (e != ESP_OK) return e;
    vTaskDelay(pdMS_TO_TICKS(5));
    e = dac_write(DAC_REG_GAIN, DAC_GAIN_VALUE);
    if (e == ESP_OK) e = dac_write(DAC_REG_CONFIG, DAC_CONFIG_VALUE);
    for (int i = 0; i < NUM_CH && e == ESP_OK; i++) e = dac_write(DAC_REG_DAC0 + i, 0);
    if (e != ESP_OK) return e;
    ESP_LOGI(TAG, "DAC80508: GAIN=0x%04X CONFIG=0x%04X, full scale %.2f V", (unsigned)DAC_GAIN_VALUE,
             (unsigned)DAC_CONFIG_VALUE, (double)DAC_FULL_SCALE_V);

#if DAC_HAS_CLR_PIN
    ESP_LOGI(TAG, "DAC80508ZC has no SDO: register readback not possible, writes are unverified");
#else
    uint16_t id = 0;
    if (dac_read(DAC_REG_DEVICE_ID, &id) != ESP_OK) return ESP_FAIL;
    ESP_LOGI(TAG, "DAC80508 DEVICE_ID = 0x%04X", id);
    if ((id & 0x0F00) != 0x0800) ESP_LOGW(TAG, "DEVICE_ID channel field is not 8: check SPI wiring, CS pin, 3V3");
#endif
    return ESP_OK;
}

/* ===================== HAL for prop_core ===================== */
static void od_set(int ch, bool enable)
{
    int level = enable ? OD_CRTL_ENABLE_LEVEL : !OD_CRTL_ENABLE_LEVEL;
    gpio_set_level(OD_PINS[ch], level);
}
static int hal_dac_write_code(int ch, uint16_t code) { return dac_write(DAC_REG_DAC0 + ch, code) == ESP_OK ? 0 : -1; }
static void hal_od_set(int ch, bool en) { od_set(ch, en); }
static int64_t hal_now_ms(void) { return esp_timer_get_time() / 1000; }
static void hal_lock(void)   { xSemaphoreTake(s_lock, portMAX_DELAY); }
static void hal_unlock(void) { xSemaphoreGive(s_lock); }
static int cal_save(const float *gain, const float *off);
static const prop_hal_t HAL = {
    .dac_write_code = hal_dac_write_code, .od_set = hal_od_set, .cal_save = cal_save,
    .now_ms = hal_now_ms, .lock = hal_lock, .unlock = hal_unlock,
};

/* ===================== Calibration in NVS ===================== */
typedef struct { float gain[NUM_CH]; float off[NUM_CH]; } cal_blob_t;

static void cal_load(void)
{
    nvs_handle_t h;
    if (nvs_open("prop", NVS_READONLY, &h) != ESP_OK) return;
    cal_blob_t b; size_t n = sizeof b;
    if (nvs_get_blob(h, "cal", &b, &n) == ESP_OK && n == sizeof b) {
        memcpy(s_core.cal_gain, b.gain, sizeof b.gain);
        memcpy(s_core.cal_off, b.off, sizeof b.off);
        ESP_LOGI(TAG, "Loaded calibration from NVS");
    }
    nvs_close(h);
}

/* called by prop_core with the lock already held */
static int cal_save(const float *gain, const float *off)
{
    nvs_handle_t h;
    if (nvs_open("prop", NVS_READWRITE, &h) != ESP_OK) return -1;
    cal_blob_t b;
    memcpy(b.gain, gain, sizeof b.gain);
    memcpy(b.off, off, sizeof b.off);
    esp_err_t e = nvs_set_blob(h, "cal", &b, sizeof b);
    if (e == ESP_OK) e = nvs_commit(h);
    nvs_close(h);
    return e == ESP_OK ? 0 : -1;
}

/* ===================== ADC feedback ===================== */
static esp_err_t adc_setup(void)
{
    adc_oneshot_unit_init_cfg_t uc = { .unit_id = ADC_UNIT_1 };
    esp_err_t e = adc_oneshot_new_unit(&uc, &s_adc);
    if (e != ESP_OK) return e;
    for (int i = 0; i < NUM_CH; i++) {
        adc_unit_t unit;
        e = adc_oneshot_io_to_channel(ADC_PINS[i], &unit, &s_adc_ch[i]);
        if (e != ESP_OK || unit != ADC_UNIT_1) { ESP_LOGE(TAG, "GPIO%d is not on ADC1", ADC_PINS[i]); return ESP_FAIL; }
        adc_oneshot_chan_cfg_t cc = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT };
        e = adc_oneshot_config_channel(s_adc, s_adc_ch[i], &cc);
        if (e != ESP_OK) return e;
        adc_cali_curve_fitting_config_t cf = {
            .unit_id = ADC_UNIT_1, .chan = s_adc_ch[i],
            .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT,
        };
        if (adc_cali_create_scheme_curve_fitting(&cf, &s_cali[i]) != ESP_OK) {
            s_cali[i] = NULL;
            ESP_LOGW(TAG, "ADC ch%d: no eFuse calibration, using linear estimate", i + 1);
        }
    }
    s_adc_ok = true;
    return ESP_OK;
}

static int adc_read_mv(int i)
{
    if (!s_adc_ok) return -1;                         /* reported as 0xFFFF (unavailable) */
    int sum = 0, ok = 0;
    for (int k = 0; k < 16; k++) {
        int raw;
        if (adc_oneshot_read(s_adc, s_adc_ch[i], &raw) == ESP_OK) { sum += raw; ok++; }
    }
    if (!ok) return -1;
    int raw = sum / ok, mv;
    if (s_cali[i]) {
        if (adc_cali_raw_to_voltage(s_cali[i], raw, &mv) != ESP_OK) return -1;
    } else {
        mv = raw * 3100 / 4095;
    }
    return mv;
}

/* ===================== RS-485 ===================== */
static void rs485_init(void)
{
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << PIN_RS485_DE) | (1ULL << PIN_RS485_RE_N),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_set_level(PIN_RS485_DE, 0);
    gpio_set_level(PIN_RS485_RE_N, 0);                /* receive mode */
    ESP_ERROR_CHECK(gpio_config(&io));
    gpio_set_level(PIN_RS485_DE, 0);
    gpio_set_level(PIN_RS485_RE_N, 0);

    uart_config_t uc = {
        .baud_rate = RS485_BAUD, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(RS485_UART, 512, 512, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(RS485_UART, &uc));
    ESP_ERROR_CHECK(uart_set_pin(RS485_UART, PIN_RS485_TX, PIN_RS485_RX,
                                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    /* RO is high-Z while /RE is high; keep the line idle-high */
    gpio_set_pull_mode(PIN_RS485_RX, GPIO_PULLUP_ONLY);
}

static void rs485_send(const uint8_t *d, size_t n)
{
    gpio_set_level(PIN_RS485_RE_N, 1);                /* mute receiver */
    gpio_set_level(PIN_RS485_DE, 1);                  /* drive bus     */
    esp_rom_delay_us(20);
    uart_write_bytes(RS485_UART, (const char *)d, n);
    uart_wait_tx_done(RS485_UART, pdMS_TO_TICKS(100));
    esp_rom_delay_us(50);                             /* last stop bit margin */
    gpio_set_level(PIN_RS485_DE, 0);
    gpio_set_level(PIN_RS485_RE_N, 0);
    uart_flush_input(RS485_UART);
}

static void rs485_reply_cb(const uint8_t *reply, size_t len, void *ctx)
{
    (void)ctx;
    vTaskDelay(pdMS_TO_TICKS(1));
    rs485_send(reply, len);
}

static void rs485_task(void *arg)
{
    (void)arg;
    static prop_stream_t stream;
    uint8_t tmp[64];
    for (;;) {
        int r = uart_read_bytes(RS485_UART, tmp, sizeof tmp, pdMS_TO_TICKS(RS485_GAP_MS));
        if (r <= 0) { prop_stream_gap(&stream); continue; }     /* gap: drop partial frame */
        prop_stream_feed(&s_core, &stream, tmp, (size_t)r, rs485_reply_cb, NULL);
    }
}

/* ===================== Ethernet (W5500) ===================== */
static void eth_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    switch (id) {
    case ETHERNET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "Ethernet link up");
#if USE_STATIC_IP
        xEventGroupSetBits(s_ev, BIT_IP);
#endif
        break;
    case ETHERNET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "Ethernet link down");
        xEventGroupClearBits(s_ev, BIT_IP);
        break;
    case ETHERNET_EVENT_START:  ESP_LOGI(TAG, "Ethernet started"); break;
    case ETHERNET_EVENT_STOP:   ESP_LOGI(TAG, "Ethernet stopped"); break;
    default: break;
    }
}

static void got_ip_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
    ESP_LOGI(TAG, "Got IP " IPSTR "  gw " IPSTR, IP2STR(&ev->ip_info.ip), IP2STR(&ev->ip_info.gw));
    xEventGroupSetBits(s_ev, BIT_IP);
}

static esp_err_t eth_start(void)
{
    esp_err_t e = gpio_install_isr_service(0);
    if (e != ESP_OK && e != ESP_ERR_INVALID_STATE) return e;

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    esp_netif_config_t ncfg = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&ncfg);

    spi_device_interface_config_t devcfg = {
        .mode = 0,
        .clock_speed_hz = ETH_SPI_CLK_HZ,
        .spics_io_num = PIN_ETH_CS,
        .queue_size = 20,
    };
    eth_w5500_config_t w5500_cfg = ETH_W5500_DEFAULT_CONFIG(SPI_HOST, &devcfg);
    w5500_cfg.int_gpio_num = PIN_ETH_INT;

    eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
    phy_cfg.reset_gpio_num = PIN_ETH_RST;

    esp_eth_mac_t *mac = esp_eth_mac_new_w5500(&w5500_cfg, &mac_cfg);
    esp_eth_phy_t *phy = esp_eth_phy_new_w5500(&phy_cfg);
    if (!mac || !phy) { ESP_LOGE(TAG, "W5500 driver creation failed"); return ESP_FAIL; }

    esp_eth_config_t cfg = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth = NULL;
    e = esp_eth_driver_install(&cfg, &eth);
    if (e != ESP_OK) { ESP_LOGE(TAG, "W5500 install failed (%s): check SPI wiring/INT/RST", esp_err_to_name(e)); return e; }

    uint8_t mac_addr[6];
    esp_read_mac(mac_addr, ESP_MAC_ETH);              /* W5500 has no MAC EEPROM */
    ESP_ERROR_CHECK(esp_eth_ioctl(eth, ETH_CMD_S_MAC_ADDR, mac_addr));

    ESP_ERROR_CHECK(esp_netif_attach(netif, esp_eth_new_netif_glue(eth)));
    ESP_ERROR_CHECK(esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, &eth_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, &got_ip_handler, NULL));

#if USE_STATIC_IP
    ESP_ERROR_CHECK(esp_netif_dhcpc_stop(netif));
    esp_netif_ip_info_t ip = { 0 };
    ip.ip.addr = STATIC_IP; ip.gw.addr = STATIC_GW; ip.netmask.addr = STATIC_MASK;
    ESP_ERROR_CHECK(esp_netif_set_ip_info(netif, &ip));
#endif
    return esp_eth_start(eth);
}

static void udp_task(void *arg)
{
    static uint8_t rx[300];
    for (;;) {
        xEventGroupWaitBits(s_ev, BIT_IP, pdFALSE, pdTRUE, portMAX_DELAY);
        int s = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
        if (s < 0) { vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
        struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(UDP_PORT), .sin_addr.s_addr = htonl(INADDR_ANY) };
        struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        if (bind(s, (struct sockaddr *)&a, sizeof a) < 0) { close(s); vTaskDelay(pdMS_TO_TICKS(1000)); continue; }
        ESP_LOGI(TAG, "UDP server listening on port %d", UDP_PORT);

        for (;;) {
            struct sockaddr_in src; socklen_t sl = sizeof src;
            int n = recvfrom(s, rx, sizeof rx, 0, (struct sockaddr *)&src, &sl);
            if (n < 0) {
                if (errno == EAGAIN || errno == EWOULDBLOCK) {
                    if (!(xEventGroupGetBits(s_ev) & BIT_IP)) break;   /* link lost: rebuild socket */
                    continue;
                }
                break;
            }
            uint8_t out[96]; size_t ol = 0;
            if (prop_process_frame(&s_core, rx, (size_t)n, out, sizeof out, &ol) && ol) {
                sendto(s, out, ol, 0, (struct sockaddr *)&src, sl);
            }
        }
        close(s);
    }
}

/* ===================== Monitor / failsafe ===================== */
static void monitor_task(void *arg)
{
    int tick = 0;
    for (;;) {
        int mv[NUM_CH];
        for (int i = 0; i < NUM_CH; i++) mv[i] = adc_read_mv(i);
        prop_set_feedback(&s_core, mv);
        if (prop_failsafe_poll(&s_core)) {
            ESP_LOGW(TAG, "Command timeout (%u ms): failsafe -> outputs off", (unsigned)s_core.timeout_ms);
        }
        if (++tick >= 10) {                           /* 1 Hz log */
            tick = 0;
            hal_lock();
            ESP_LOGI(TAG, "en=0x%02X tgt[%.2f %.2f %.2f %.2f %.2f] fb_mV[%d %d %d %d %d]",
                     s_core.enable_mask,
                     s_core.target_ma[0], s_core.target_ma[1], s_core.target_ma[2], s_core.target_ma[3], s_core.target_ma[4],
                     s_core.fb_mv[0], s_core.fb_mv[1], s_core.fb_mv[2], s_core.fb_mv[3], s_core.fb_mv[4]);
            hal_unlock();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

/* ===================== Init helpers ===================== */
static void od_init_disabled(void)
{
    for (int i = 0; i < NUM_CH; i++) {
        gpio_reset_pin(OD_PINS[i]);
        gpio_set_level(OD_PINS[i], !OD_CRTL_ENABLE_LEVEL);   /* disabled first */
        gpio_set_direction(OD_PINS[i], GPIO_MODE_OUTPUT);    /* R33 10k pull-down = "enabled" until here */
        gpio_set_level(OD_PINS[i], !OD_CRTL_ENABLE_LEVEL);
    }
}

static void spi_bus_setup(void)
{
    spi_bus_config_t bc = {
        .mosi_io_num = PIN_SPI_MOSI, .miso_io_num = PIN_SPI_MISO, .sclk_io_num = PIN_SPI_SCLK,
        .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 4096,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI_HOST, &bc, SPI_DMA_CH_AUTO));
}

/* ===================== app_main ===================== */
void app_main(void)
{
    ESP_LOGI(TAG, "STAR Prop Receiver fw v%d, node addr 0x%02X", PROP_FW_VERSION, NODE_ADDR);

    od_init_disabled();                               /* outputs off before anything else */

    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        e = nvs_flash_init();
    }
    ESP_ERROR_CHECK(e);

    s_lock = xSemaphoreCreateMutex();
    s_ev = xEventGroupCreate();
    prop_init(&s_core, &HAL, NODE_ADDR);
    cal_load();

    spi_bus_setup();

    if (dac_init() != ESP_OK) ESP_LOGE(TAG, "DAC init failed; outputs unavailable");
    if (adc_setup() != ESP_OK) ESP_LOGE(TAG, "ADC init failed");

    rs485_init();
    if (eth_start() != ESP_OK) ESP_LOGE(TAG, "Ethernet failed; RS-485 and USB still active");

    xTaskCreate(rs485_task, "rs485", 4096, NULL, 6, NULL);
    xTaskCreate(udp_task, "udp", 4096, NULL, 5, NULL);
    xTaskCreate(monitor_task, "monitor", 4096, NULL, 4, NULL);
}
