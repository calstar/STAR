#include <string.h>
#include "ecp5_cfg.h"

#define OP_READ_ID      0xE0
#define OP_ISC_ENABLE   0xC6
#define OP_ISC_ERASE    0x0E
#define OP_RESET_CRC    0x3B
#define OP_BURST        0x7A
#define OP_ISC_DISABLE  0x26
#define OP_READ_STATUS  0x3C
#define ST_DONE         (1u << 8)
#define ST_FAIL         (1u << 13)
#define CHUNK           1024

uint32_t ecp5_crc32(uint32_t crc, const uint8_t *p, size_t n)
{
    crc = ~crc;
    while (n--) {
        crc ^= *p++;
        for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1));
    }
    return ~crc;
}

static uint32_t le32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

bool ecp5_image_parse(const uint8_t h[ECP5_IMG_HDR], size_t part_size, ecp5_image_t *img)
{
    if (memcmp(h, "DVBTFPGA", 8) != 0 || le32(h + 8) != 1) return false;
    img->length = le32(h + 12);
    img->crc32 = le32(h + 16);
    img->idcode = le32(h + 20);
    return img->length > 0 && img->length <= part_size - ECP5_IMG_HDR;
}

esp_err_t ecp5_image_verify(const ecp5_hal_t *h, const ecp5_image_t *img)
{
    uint8_t buf[CHUNK];
    uint32_t crc = 0;
    for (size_t off = 0; off < img->length; off += CHUNK) {
        size_t n = img->length - off < CHUNK ? img->length - off : CHUNK;
        esp_err_t e = h->read(h->ctx, ECP5_IMG_HDR + off, buf, n);
        if (e != ESP_OK) return e;
        crc = ecp5_crc32(crc, buf, n);
    }
    return crc == img->crc32 ? ESP_OK : ESP_ERR_INVALID_CRC;
}

// One command frame: opcode, 3 operand bytes, then nrx bytes read back.
static esp_err_t cmd(const ecp5_hal_t *h, uint8_t op, uint8_t operand0, uint8_t *rx, size_t nrx)
{
    uint8_t tx[8] = {op, operand0, 0, 0, 0, 0, 0, 0}, in[8] = {0};
    h->set_cs(h->ctx, true);
    esp_err_t e = h->spi(h->ctx, tx, in, 4 + nrx);
    h->set_cs(h->ctx, false);
    if (e == ESP_OK && rx) memcpy(rx, in + 4, nrx);
    return e;
}

static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]; }

static bool wait_pin(const ecp5_hal_t *h, bool (*get)(void *), uint32_t timeout_us)
{
    for (uint32_t t = 0; t <= timeout_us; t += 100) {
        if (get(h->ctx)) return true;
        h->delay_us(h->ctx, 100);
    }
    return false;
}

static void program_pulse(const ecp5_hal_t *h)
{
    h->set_programn(h->ctx, false);
    h->delay_us(h->ctx, 1000);
    h->set_programn(h->ctx, true);
}

esp_err_t ecp5_load_sspi(const ecp5_hal_t *h, const ecp5_image_t *img, uint32_t *idcode, uint32_t *status)
{
    esp_err_t e;
    uint8_t r[4];
    h->set_cfg_sspi(h->ctx, true);
    program_pulse(h);
    if (!wait_pin(h, h->get_initn, 50000)) return ESP_ERR_TIMEOUT;
    if ((e = cmd(h, OP_READ_ID, 0, r, 4)) != ESP_OK) return e;
    *idcode = be32(r);
    if (*idcode != img->idcode) return ESP_ERR_INVALID_VERSION;
    if ((e = cmd(h, OP_ISC_ENABLE, 0, NULL, 0)) != ESP_OK) return e;
    h->delay_us(h->ctx, 1000);
    if ((e = cmd(h, OP_ISC_ERASE, 0x01, NULL, 0)) != ESP_OK) return e;
    h->delay_us(h->ctx, 10000);
    if ((e = cmd(h, OP_RESET_CRC, 0, NULL, 0)) != ESP_OK) return e;

    uint8_t buf[CHUNK];
    const uint8_t burst[4] = {OP_BURST, 0, 0, 0};
    h->set_cs(h->ctx, true);
    e = h->spi(h->ctx, burst, NULL, 4);
    for (size_t off = 0; e == ESP_OK && off < img->length; off += CHUNK) {
        size_t n = img->length - off < CHUNK ? img->length - off : CHUNK;
        e = h->read(h->ctx, ECP5_IMG_HDR + off, buf, n);
        if (e == ESP_OK) e = h->spi(h->ctx, buf, NULL, n);
    }
    h->set_cs(h->ctx, false);
    if (e != ESP_OK) return e;

    if ((e = cmd(h, OP_ISC_DISABLE, 0, NULL, 0)) != ESP_OK) return e;
    const uint8_t nop[4] = {0xFF, 0xFF, 0xFF, 0xFF};
    h->set_cs(h->ctx, true);
    h->spi(h->ctx, nop, NULL, 4);
    h->set_cs(h->ctx, false);
    bool done = wait_pin(h, h->get_done, 100000);
    if ((e = cmd(h, OP_READ_STATUS, 0, r, 4)) != ESP_OK) return e;
    *status = be32(r);
    if (!done || !(*status & ST_DONE) || (*status & ST_FAIL)) return ESP_FAIL;
    return ESP_OK;
}

esp_err_t ecp5_boot_flash(const ecp5_hal_t *h)
{
    h->set_cs(h->ctx, false);
    h->set_cfg_sspi(h->ctx, false);         // straps: master SPI from the W25Q32
    program_pulse(h);
    return wait_pin(h, h->get_done, 2000000) ? ESP_OK : ESP_ERR_TIMEOUT;
}

esp_err_t ecp5_configure(const ecp5_hal_t *h, size_t part_size, ecp5_result_t *res)
{
    memset(res, 0, sizeof *res);
    uint8_t hdr[ECP5_IMG_HDR];
    ecp5_image_t img;
    esp_err_t e = h->read(h->ctx, 0, hdr, sizeof hdr);
    if (e == ESP_OK && !ecp5_image_parse(hdr, part_size, &img)) e = ESP_ERR_NOT_FOUND;
    if (e == ESP_OK) e = ecp5_image_verify(h, &img);
    if (e == ESP_OK) e = ecp5_load_sspi(h, &img, &res->idcode, &res->status);
    res->sspi_err = e;
    // CFG is only sampled when configuration starts: release it to the straps
    // now, so any later reset (PROGRAMN, power) boots from the W25Q32.
    h->set_cfg_sspi(h->ctx, false);
    if (e == ESP_OK) {
        res->via = ECP5_VIA_SSPI;
        return ESP_OK;
    }
    e = ecp5_boot_flash(h);
    res->via = e == ESP_OK ? ECP5_VIA_FLASH : ECP5_VIA_NONE;
    return e;
}
