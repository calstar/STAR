#include "i2c_bus_esp.h"
#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_rom_sys.h"

static const char *TAG = "i2c_bus_esp";
#define MAX_DEV 4

typedef struct {
    i2c_master_bus_handle_t bus;
    struct { uint8_t addr; i2c_master_dev_handle_t h; } dev[MAX_DEV];
    int n;
} ctx_t;
static ctx_t s_ctx;

static esp_err_t dev(ctx_t *c, uint8_t addr, i2c_master_dev_handle_t *h)
{
    for (int i = 0; i < c->n; i++)
        if (c->dev[i].addr == addr) { *h = c->dev[i].h; return ESP_OK; }
    ESP_RETURN_ON_FALSE(c->n < MAX_DEV, ESP_ERR_NO_MEM, TAG, "too many devices");
    i2c_device_config_t dc = { .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addr,
                               .scl_speed_hz = 400000 };
    ESP_RETURN_ON_ERROR(i2c_master_bus_add_device(c->bus, &dc, h), TAG, "add %02x", addr);
    c->dev[c->n].addr = addr;
    c->dev[c->n++].h = *h;
    return ESP_OK;
}

static esp_err_t wr(void *vc, uint8_t addr, const uint8_t *buf, size_t n)
{
    i2c_master_dev_handle_t h;
    ESP_RETURN_ON_ERROR(dev(vc, addr, &h), TAG, "dev");
    return i2c_master_transmit(h, buf, n, 100);
}

static esp_err_t wr_rd(void *vc, uint8_t addr, const uint8_t *w, size_t nw, uint8_t *r, size_t nr)
{
    i2c_master_dev_handle_t h;
    ESP_RETURN_ON_ERROR(dev(vc, addr, &h), TAG, "dev");
    return i2c_master_transmit_receive(h, w, nw, r, nr, 100);
}

static void delay_us(void *vc, uint32_t us) { (void)vc; esp_rom_delay_us(us); }

esp_err_t i2c_bus_esp_init(int pin_sda, int pin_scl, i2c_bus_if_t *bus)
{
    i2c_master_bus_config_t ic = {
        .i2c_port = -1, .sda_io_num = pin_sda, .scl_io_num = pin_scl,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&ic, &s_ctx.bus), TAG, "bus");
    bus->write = wr;
    bus->write_read = wr_rd;
    bus->delay_us = delay_us;
    bus->ctx = &s_ctx;
    return ESP_OK;
}
