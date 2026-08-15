#ifndef HOTFIRE_LOG_H
#define HOTFIRE_LOG_H

#include <Arduino.h>

// ─────────────────────────────────────────────────────────────────────────────
// Two-tier serial logging (shared by all hotfire boards + OTA).
//
//   Tier 1  HF_LOG*      — ALWAYS printed. Low-rate, high-value: boot/identity,
//                          state transitions, config/command summaries, self-test
//                          verdicts, OTA lifecycle, and all errors/warnings.
//
//   Tier 2  HF_VERBOSE*  — printed ONLY when verbose mode is on (g_verbose). High
//                          rate or fine-grained debug: per-packet "Sent:" lines,
//                          per-sample data dumps, raw hex, repeating debug, and
//                          field-by-field breakdowns.
//
// g_verbose is the "verbose mode" gate. It defaults true until SENSOR_CONFIG is
// received, then tracks the packet's enable_serial_printing byte (the server
// controls it per-board). Each board defines `bool g_verbose = true;` once in its
// main .cpp.
// ─────────────────────────────────────────────────────────────────────────────
extern bool g_verbose;

// Variadic so they accept both Serial.print(x) and Serial.print(x, HEX).
// Tier 1 — always
#define HF_LOG(...)      do { Serial.print(__VA_ARGS__); } while (0)
#define HF_LOGLN(...)    do { Serial.println(__VA_ARGS__); } while (0)
#define HF_LOGLN_()      do { Serial.println(); } while (0)
#define HF_LOGF(...)     do { Serial.printf(__VA_ARGS__); } while (0)

// Tier 2 — verbose only
#define HF_VERBOSE(...)   do { if (g_verbose) Serial.print(__VA_ARGS__); } while (0)
#define HF_VERBOSELN(...) do { if (g_verbose) Serial.println(__VA_ARGS__); } while (0)
#define HF_VERBOSELN_()   do { if (g_verbose) Serial.println(); } while (0)
#define HF_VERBOSEF(...)  do { if (g_verbose) Serial.printf(__VA_ARGS__); } while (0)

#endif  // HOTFIRE_LOG_H
