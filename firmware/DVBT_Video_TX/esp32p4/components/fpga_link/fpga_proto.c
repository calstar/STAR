#include <string.h>
#include "fpga_proto.h"
#include "dvbt_regs.h"

static void be32(uint8_t *p, uint32_t v)
{
    p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
}

size_t fpga_frame_write(uint8_t *buf, unsigned addr, uint32_t val)
{
    buf[0] = DVBT_CMD_WRITE(addr);
    be32(buf + 1, val);
    return 5;
}

size_t fpga_frame_read(uint8_t *buf, unsigned addr)
{
    memset(buf, 0, 6);
    buf[0] = DVBT_CMD_READ(addr);
    return 6;
}

size_t fpga_frame_ts(uint8_t *buf, const uint8_t *pkts, size_t n)
{
    buf[0] = DVBT_CMD_TS;
    memcpy(buf + 1, pkts, n * TS_PACKET);
    return 1 + n * TS_PACKET;
}

uint32_t fpga_parse_read(const uint8_t *rx)
{
    return ((uint32_t)rx[2] << 24) | ((uint32_t)rx[3] << 16) | ((uint32_t)rx[4] << 8) | rx[5];
}
