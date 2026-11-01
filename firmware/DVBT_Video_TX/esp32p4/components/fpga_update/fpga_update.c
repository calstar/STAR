#include <string.h>
#include "fpga_update.h"

enum { S_HUNT, S_HDR, S_DATA };
static const uint8_t MAGIC[8] = { 'D', 'V', 'B', 'T', 'F', 'P', 'G', 'A' };

void fpga_update_init(fpga_update_t *u)
{
    u->hn = u->off = 0;
    u->state = S_HUNT;
}

static fu_status_t fail(fpga_update_t *u, const char *why, const char **msg)
{
    if (msg) *msg = why;
    fpga_update_init(u);
    return FU_ERROR;
}

fu_status_t fpga_update_feed(fpga_update_t *u, const uint8_t *p, size_t n, const char **msg)
{
    if (msg) *msg = "";
    while (n) {
        if (u->state == S_HUNT) {
            // Match the magic byte by byte; on a mismatch restart (the magic
            // has no repeated prefix, so no back-tracking is needed).
            uint8_t c = *p++;
            n--;
            if (c == MAGIC[u->hn]) u->hdr[u->hn++] = c;
            else u->hn = (c == MAGIC[0]) ? (u->hdr[0] = c, 1) : 0;
            if (u->hn == sizeof MAGIC) u->state = S_HDR;
        } else if (u->state == S_HDR) {
            size_t k = ECP5_IMG_HDR - u->hn < n ? ECP5_IMG_HDR - u->hn : n;
            memcpy(u->hdr + u->hn, p, k);
            u->hn += k; p += k; n -= k;
            if (u->hn == ECP5_IMG_HDR) {
                if (!ecp5_image_parse(u->hdr, u->part_size, &u->img))
                    return fail(u, "bad header (version, or larger than the partition)", msg);
                if (u->img.idcode != ECP5_ID_LFE5U_25F)
                    return fail(u, "image is for another FPGA (idcode)", msg);
                if (u->erase(u->ctx, ECP5_IMG_HDR + u->img.length) != ESP_OK)
                    return fail(u, "erase failed", msg);
                if (u->write(u->ctx, 0, u->hdr, ECP5_IMG_HDR) != ESP_OK)
                    return fail(u, "write failed", msg);
                u->off = 0;
                u->crc = 0;
                u->state = S_DATA;
            }
        } else {
            size_t k = u->img.length - u->off < n ? u->img.length - u->off : n;
            if (u->write(u->ctx, ECP5_IMG_HDR + u->off, p, k) != ESP_OK)
                return fail(u, "write failed", msg);
            u->crc = ecp5_crc32(u->crc, p, k);
            u->off += k; p += k; n -= k;
            if (u->off == u->img.length) {
                bool ok = u->crc == u->img.crc32;
                fpga_update_init(u);
                if (!ok) return fail(u, "CRC mismatch: data damaged in transfer", msg);
                return FU_DONE;
            }
        }
    }
    return u->state == S_DATA || u->state == S_HDR ? FU_BUSY : FU_IDLE;
}
