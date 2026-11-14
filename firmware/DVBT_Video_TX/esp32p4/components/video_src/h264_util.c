#include "h264_util.h"

bool h264_au_is_idr(const uint8_t *p, size_t n)
{
    for (size_t i = 0; i + 3 < n; i++) {
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1) {
            if ((p[i + 3] & 0x1F) == 5) return true;
            i += 2;
        }
    }
    return false;
}
