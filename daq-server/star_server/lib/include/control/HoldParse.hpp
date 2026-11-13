#pragma once

#include <charconv>
#include <cstdint>
#include <string>

namespace sequencer {

/**
 * Hard ceiling on any client-supplied hold, independent of per-state config.
 *
 * This is not the real limit — each holdable state carries its own, usually far smaller, max. This
 * one exists so a typo or a garbage frame is rejected at the wire before it reaches anything that
 * has to reason about it.
 */
inline constexpr uint32_t kMaxHoldMs = 3600000;  // 1 hour

/**
 * Parse a hold duration off the wire, strictly.
 *
 * Strictly, because the lenient version of this is a hazard: atoi("1e3") returns 1, so a frame
 * asking for a thousand seconds would have quietly run a one-millisecond pulse and the operator
 * would have weighed a mass against a window that never happened. The whole string must be digits.
 *
 * Rejects: empty, non-digits, a leading sign, trailing junk, anything over kMaxHoldMs, and zero —
 * zero is the "no duration supplied" sentinel everywhere else, so it must never arrive as one.
 *
 * @param out written only on success.
 * @return true if `text` is a usable duration.
 */
inline bool parseHoldMs(const std::string& text, uint32_t& out) {
    const size_t b = text.find_first_not_of(" \t\r\n");
    if (b == std::string::npos)
        return false;
    const size_t e = text.find_last_not_of(" \t\r\n");

    const char* first = text.data() + b;
    const char* last = text.data() + e + 1;

    uint64_t v = 0;
    const auto res = std::from_chars(first, last, v);
    if (res.ec != std::errc() || res.ptr != last)
        return false;  // not a number, or only a prefix of one ("1e3", "1000x")
    if (v == 0 || v > kMaxHoldMs)
        return false;

    out = static_cast<uint32_t>(v);
    return true;
}

}  // namespace sequencer
