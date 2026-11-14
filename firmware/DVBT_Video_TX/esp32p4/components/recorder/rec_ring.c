#include <string.h>
#include "rec_ring.h"

void rec_ring_init(rec_ring_t *q, uint8_t *buf, size_t size)
{
    q->buf = buf;
    q->size = size;
    q->w = q->r = 0;
    q->dropped = 0;
}

size_t rec_ring_used(const rec_ring_t *q)
{
    return __atomic_load_n(&q->w, __ATOMIC_ACQUIRE) - __atomic_load_n(&q->r, __ATOMIC_ACQUIRE);
}

bool rec_ring_push(rec_ring_t *q, const uint8_t *p, size_t n)
{
    size_t w = q->w, r = __atomic_load_n(&q->r, __ATOMIC_ACQUIRE);
    if (q->size - (w - r) < n) {
        q->dropped += (uint32_t)((n + 187) / 188);
        return false;
    }
    size_t o = w % q->size, k = q->size - o < n ? q->size - o : n;
    memcpy(q->buf + o, p, k);
    memcpy(q->buf, p + k, n - k);
    __atomic_store_n(&q->w, w + n, __ATOMIC_RELEASE);
    return true;
}

size_t rec_ring_peek(rec_ring_t *q, const uint8_t **p)
{
    size_t r = q->r, w = __atomic_load_n(&q->w, __ATOMIC_ACQUIRE);
    size_t o = r % q->size, n = w - r;
    if (n > q->size - o) n = q->size - o;
    *p = q->buf + o;
    return n;
}

void rec_ring_pop(rec_ring_t *q, size_t n)
{
    __atomic_store_n(&q->r, q->r + n, __ATOMIC_RELEASE);
}
