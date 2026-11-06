#include <stdio.h>
#include <string.h>
#include "fc_link.h"

uint8_t fc_csum(const char *s, size_t n)
{
    uint8_t x = 0;
    while (n--) x ^= (uint8_t)*s++;
    return x;
}

size_t fc_format(char *out, size_t max, const char *body)
{
    int k = snprintf(out, max, "$%s*%02X\r\n", body, fc_csum(body, strlen(body)));
    return k > 0 && (size_t)k < max ? (size_t)k : 0;
}

static int hexv(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

// Unsigned decimal field: digits only, up to max. Advances *p past it.
static bool num(const char **p, const char *end, uint32_t max, uint32_t *v)
{
    const char *s = *p;
    uint64_t x = 0;
    if (s == end || *s < '0' || *s > '9') return false;
    while (s < end && *s >= '0' && *s <= '9') {
        x = x * 10 + (uint64_t)(*s++ - '0');
        if (x > max) return false;
    }
    *p = s;
    *v = (uint32_t)x;
    return true;
}

static void parse(const char *line, size_t n, fc_cmd_t *cmd)
{
    memset(cmd, 0, sizeof *cmd);
    cmd->kind = FC_BAD_SYNTAX;
    const char *star = memchr(line, '*', n);
    if (!star || line + n - star != 3) { cmd->kind = FC_BAD_CSUM; return; }
    int h = hexv(star[1]), l = hexv(star[2]);
    if (h < 0 || l < 0 || (uint8_t)(h << 4 | l) != fc_csum(line, (size_t)(star - line))) {
        cmd->kind = FC_BAD_CSUM;
        return;
    }
    const char *p = line, *end = star;
    if (end - p == 3 && !memcmp(p, "CH?", 3)) { cmd->kind = FC_QUERY; return; }
    if (end - p < 4 || memcmp(p, "HOP,", 4)) return;
    p += 4;
    uint32_t seq, khz;
    if (!num(&p, end, 65535, &seq) || p == end || *p++ != ',') return;
    if (!num(&p, end, 99999999, &khz) || p != end) return;
    cmd->kind = FC_HOP;
    cmd->seq = (uint16_t)seq;
    cmd->khz = khz;
}

bool fc_rx_byte(fc_rx_t *r, uint8_t c, fc_cmd_t *cmd)
{
    if (c == '$') {                       // a new line starts here, whatever came before
        r->in_line = true;
        r->n = 0;
        r->overflow = false;
        return false;
    }
    if (!r->in_line) return false;
    if (c == '\r') return false;
    if (c == '\n') {
        r->in_line = false;
        if (r->overflow) { memset(cmd, 0, sizeof *cmd); cmd->kind = FC_BAD_SYNTAX; return true; }
        parse(r->buf, r->n, cmd);
        return true;
    }
    if (r->n < sizeof r->buf) r->buf[r->n++] = (char)c;
    else r->overflow = true;
    return false;
}
