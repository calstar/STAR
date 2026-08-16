#ifndef HOTFIRE_LOG_H
#define HOTFIRE_LOG_H

#include <Arduino.h>

// ─────────────────────────────────────────────────────────────────────────────
// Two-tier serial logging + optional server streaming (shared by all hotfire
// boards + OTA).
//
//   Tier 1  HF_LOG*      — high-value, low-rate: boot/identity, state
//   transitions,
//                          config/command summaries, self-test verdicts, OTA
//                          lifecycle, errors/warnings.
//   Tier 2  HF_VERBOSE*  — high-rate/debug detail: per-packet "Sent:" lines,
//                          per-sample dumps, raw hex, repeating debug, field
//                          dumps.
//
// Each macro fans out to two sinks, each independently gated:
//   • USB serial — Tier 1 always; Tier 2 only when g_verbose.
//   • Network buffer (g_logbuf) — Tier 1 when g_log_stream_level >= 1;
//                                 Tier 2 when g_log_stream_level >= 2.
//     A ~1 Hz flush (in each board's loop) sends the buffer to the server as a
//     LOGS packet (type 15).
//
// Both gates come from the config packet's `enable_serial_printing` byte
// (mode):
//   0: USB Tier1        stream off
//   1: USB Tier1+Tier2  stream off
//   2: USB Tier1        stream Tier1
//   3: USB Tier1+Tier2  stream Tier1+Tier2
//   => g_verbose = (mode & 1);  g_log_stream_level = (mode >= 2) ? (mode - 1) :
//   0;
//
// Each board defines `bool g_verbose = true;` once in its main .cpp. g_logbuf
// and g_log_stream_level are inline (header-defined) — no per-board
// boilerplate.
// ─────────────────────────────────────────────────────────────────────────────

extern bool g_verbose;

#ifndef LOG_BUF_SIZE
#define LOG_BUF_SIZE \
    1024  // capped to one packet: a 1 Hz flush is always one UDP datagram
#endif

// Fixed-size log accumulator. Being a Print subclass, g_logbuf.print(x) accepts
// every type the macros use (strings, ints, IPAddress, "..., HEX"), just like
// Serial. Overflow drops the excess and raises the TRUNCATED flag.
class LogBuffer : public Print {
public:
    size_t write(uint8_t c) override {
        if (len_ < LOG_BUF_SIZE) {
            buf_[len_++] = static_cast<char>(c);
            return 1;
        }
        truncated_ = true;
        return 0;
    }
    size_t write(const uint8_t* data, size_t size) override {
        size_t n = 0;
        while (n < size && len_ < LOG_BUF_SIZE)
            buf_[len_++] = static_cast<char>(data[n++]);
        if (n < size)
            truncated_ = true;
        return n;
    }
    const uint8_t* data() const {
        return reinterpret_cast<const uint8_t*>(buf_);
    }
    uint16_t length() const {
        return static_cast<uint16_t>(len_);
    }
    bool empty() const {
        return len_ == 0;
    }
    bool nearFull() const {
        return len_ >= (LOG_BUF_SIZE * 4) / 5;
    }  // 80%
    uint8_t flags() const {
        return truncated_ ? 0x01 : 0x00;
    }  // bit0 = TRUNCATED
    void clear() {
        len_ = 0;
        truncated_ = false;
    }

private:
    char buf_[LOG_BUF_SIZE];
    size_t len_ = 0;
    bool truncated_ = false;
};

inline LogBuffer g_logbuf;
inline uint8_t g_log_stream_level =
    1;  // default: stream Tier 1 once Ethernet is up

// Variadic so they accept both print(x) and print(x, HEX).
// Tier 1 — USB always; stream when level >= 1.
#define HF_LOG(...)                      \
    do {                                 \
        Serial.print(__VA_ARGS__);       \
        if (g_log_stream_level >= 1)     \
            g_logbuf.print(__VA_ARGS__); \
    } while (0)
#define HF_LOGLN(...)                      \
    do {                                   \
        Serial.println(__VA_ARGS__);       \
        if (g_log_stream_level >= 1)       \
            g_logbuf.println(__VA_ARGS__); \
    } while (0)
#define HF_LOGLN_()                  \
    do {                             \
        Serial.println();            \
        if (g_log_stream_level >= 1) \
            g_logbuf.println();      \
    } while (0)
#define HF_LOGF(...)                      \
    do {                                  \
        Serial.printf(__VA_ARGS__);       \
        if (g_log_stream_level >= 1)      \
            g_logbuf.printf(__VA_ARGS__); \
    } while (0)

// Tier 2 — USB only when g_verbose; stream when level >= 2.
#define HF_VERBOSE(...)                  \
    do {                                 \
        if (g_verbose)                   \
            Serial.print(__VA_ARGS__);   \
        if (g_log_stream_level >= 2)     \
            g_logbuf.print(__VA_ARGS__); \
    } while (0)
#define HF_VERBOSELN(...)                  \
    do {                                   \
        if (g_verbose)                     \
            Serial.println(__VA_ARGS__);   \
        if (g_log_stream_level >= 2)       \
            g_logbuf.println(__VA_ARGS__); \
    } while (0)
#define HF_VERBOSELN_()              \
    do {                             \
        if (g_verbose)               \
            Serial.println();        \
        if (g_log_stream_level >= 2) \
            g_logbuf.println();      \
    } while (0)
#define HF_VERBOSEF(...)                  \
    do {                                  \
        if (g_verbose)                    \
            Serial.printf(__VA_ARGS__);   \
        if (g_log_stream_level >= 2)      \
            g_logbuf.printf(__VA_ARGS__); \
    } while (0)

#endif  // HOTFIRE_LOG_H
