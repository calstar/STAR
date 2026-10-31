#ifndef RADIO_FAKE_H
#define RADIO_FAKE_H

#include <stdint.h>

#include "radio.h"

// A pretend radio for tests on a laptop. It defines the same three functions
// as radio.h, but keeps packets in memory. It lives in test/ (not src/) so it
// can never be built into the rocket next to the real driver.
namespace radio_link {
namespace fake {

// Empty the queues. `chip_present` decides what radio_probe() answers.
void reset(bool chip_present = true);

// Pretend a packet arrived. radio_receive() will hand it out.
// Returns false if the queue is full or `len` is 0.
bool inject(const uint8_t* bytes, uint8_t len);

// Copy the last packet given to radio_send() into `out`.
// Returns how many bytes were copied (0 if nothing was sent).
uint8_t last_sent(uint8_t* out, uint8_t out_cap);

}  // namespace fake
}  // namespace radio_link

#endif  // RADIO_FAKE_H
