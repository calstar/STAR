// Small H.264 Annex-B helpers (pure, host-tested).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// True if the access unit holds an IDR slice (NAL type 5): a key frame.
bool h264_au_is_idr(const uint8_t *au, size_t n);
