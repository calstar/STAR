#ifndef RADIO_H
#define RADIO_H

#include <stddef.h>
#include <stdint.h>

namespace radio_link {

// The answers a radio function can give.
enum class RadioStatus : uint8_t {
    Ok = 0,       // it worked
    ErrNotFound,  // the radio chip did not answer
    ErrTooLong,   // a packet was bigger than the space we gave it
    NoData,       // nothing has arrived yet (this is not a failure)
};

// Check the radio chip is there and answering (for example by reading one of
// its status registers). Call this once at boot.
// Returns Ok if it answers, ErrNotFound if it does not.
RadioStatus radio_probe();

// Check whether a packet has arrived, without waiting. The caller provides a
// box (`buf`) that holds up to `max_len` bytes.
//   - A packet is waiting: it is copied into `buf`, `len` is set to its size,
//     and the answer is Ok.
//   - Nothing is waiting: the answer is NoData and `len` is left alone.
//   - The waiting packet is bigger than `max_len`: it is thrown away and the
//     answer is ErrTooLong.
RadioStatus radio_receive(uint8_t* buf, uint8_t max_len, uint8_t& len);

// Send one packet: `len` bytes (1 to 255) starting at `bytes`.
// The rocket only receives for now, so the real driver may do nothing here and
// still answer Ok.
RadioStatus radio_send(const uint8_t* bytes, uint8_t len);

}  // namespace radio_link

#endif  // RADIO_H
