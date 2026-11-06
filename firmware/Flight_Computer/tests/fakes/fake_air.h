#ifndef FAKE_AIR_H
#define FAKE_AIR_H

// Models LoRa RF listen windows for sniff-mode tests.
//
// In SetRxDutyCycle, the radio listens for rx_ms then sleeps for sleep_ms,
// repeating autonomously. A packet is received only if its preamble overlaps
// at least one listen window. This is the key constraint: the ground station's
// preamble must be longer than sleep_ms to guarantee delivery; a short
// preamble can be missed entirely if it falls in the sleep window.

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Set the duty cycle; call before fake_air_packet_heard().
void fake_air_configure(uint32_t rx_ms, uint32_t sleep_ms);

// Can the radio hear a packet whose preamble starts at cycle_offset_ms within
// the duty cycle period (0 = start of listen window) and lasts preamble_ms?
// Returns true if any part of the preamble overlaps a listen window.
bool fake_air_packet_heard(uint32_t cycle_offset_ms, uint32_t preamble_ms);

// Average radio current in mA over one duty cycle, given the per-state values.
// rx_ma: current while listening (SX1262 DS p.16: ~4.6 mA at 125 kHz DC-DC)
// sleep_ua: current while sleeping (~1.2 µA warm sleep, DS p.16)
float fake_air_average_current_ma(float rx_ma, float sleep_ua);

#ifdef __cplusplus
}
#endif
#endif
