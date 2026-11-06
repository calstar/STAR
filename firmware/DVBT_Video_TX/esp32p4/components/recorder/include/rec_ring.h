// Single-producer, single-consumer byte ring for whole TS packets: the TS
// loop pushes what it sends, the SD task drains it. A push that does not
// fit is dropped whole (and counted), so the card never stalls the link.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *buf;
    size_t size;
    size_t w, r;            // free-running byte counts (atomic)
    uint32_t dropped;       // packets
} rec_ring_t;

void rec_ring_init(rec_ring_t *q, uint8_t *buf, size_t size);
bool rec_ring_push(rec_ring_t *q, const uint8_t *p, size_t n);
// Contiguous readable bytes at *p (0 if empty); rec_ring_pop frees them.
size_t rec_ring_peek(rec_ring_t *q, const uint8_t **p);
void rec_ring_pop(rec_ring_t *q, size_t n);
size_t rec_ring_used(const rec_ring_t *q);
