#ifndef RADIO_FAKE_H
#define RADIO_FAKE_H

#include <stdint.h>

#include "radio.h"

// A pretend radio for tests on a laptop. It defines the same three functions
// as radio.h, but keeps packets in memory. It lives in test/ (not src/) so it
// can never be built into the rocket next to the real driver.
namespace radio_link {
namespace fake {

// Empty the queues and forget everything sent. `chip_present` decides what
// radio_probe() answers; with no chip, radio_send() answers ErrNotFound.
// It also puts radio_send() back to answering Ok.
void reset(bool chip_present = true);

// Make radio_send() give this answer from now on, so a test can check what
// the caller does when a send fails. A failed send is not recorded.
void set_send_result(RadioStatus result);

// Pretend a packet arrived. radio_receive() will hand it out.
// Returns false if the queue is full or `len` is 0.
bool inject(const uint8_t* bytes, uint8_t len);

// Copy the last packet given to radio_send() into `out`.
// Returns how many bytes were copied (0 if nothing was sent).
uint8_t last_sent(uint8_t* out, uint8_t out_cap);

// How many packets radio_send() accepted (answered Ok) since reset().
unsigned sent_count();

}  // namespace fake
}  // namespace radio_link

#endif  // RADIO_FAKE_H
