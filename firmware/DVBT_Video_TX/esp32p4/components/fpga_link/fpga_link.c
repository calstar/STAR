#include "fpga_link.h"
#include "fpga_proto.h"

esp_err_t fpga_reg_write(const fpga_link_t *l, unsigned addr, uint32_t val)
{
    size_t n = fpga_frame_write(l->tx, addr, val);
    return l->frame(l->ctx, l->tx, l->rx, n);
}

esp_err_t fpga_reg_read(const fpga_link_t *l, unsigned addr, uint32_t *val)
{
    size_t n = fpga_frame_read(l->tx, addr);
    esp_err_t e = l->frame(l->ctx, l->tx, l->rx, n);
    if (e == ESP_OK) *val = fpga_parse_read(l->rx);
    return e;
}

esp_err_t fpga_link_check(const fpga_link_t *l, uint32_t *id)
{
    uint32_t v = 0;
    esp_err_t e = fpga_reg_read(l, DVBT_REG_ID, &v);
    if (id) *id = v;
    if (e != ESP_OK) return e;
    return v == DVBT_ID ? ESP_OK : ESP_ERR_INVALID_VERSION;
}

esp_err_t fpga_ts_send(const fpga_link_t *l, const uint8_t *pkts, size_t n, uint32_t timeout_ms,
                       uint8_t *status)
{
    while (n) {
        if (!l->wait_dreq(l->ctx, timeout_ms)) return ESP_ERR_TIMEOUT;
        size_t k = n >= 2 ? 2 : 1;
        esp_err_t e = l->frame(l->ctx, l->tx, l->rx, fpga_frame_ts(l->tx, pkts, k));
        if (e != ESP_OK) return e;
        if (status) *status = l->rx[0];
        pkts += k * TS_PACKET;
        n -= k;
    }
    return ESP_OK;
}
