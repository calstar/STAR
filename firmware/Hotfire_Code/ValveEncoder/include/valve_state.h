#pragma once

// Step 2 of the board's job: turn an encoder angle into a valve state.
//
// Pure C++ (no Arduino) so it runs in host unit tests.
//
// The AS5600 reports an absolute angle, 0..4095 counts per turn
// (1 degree = 11.38 counts). It keeps its absolute angle across power
// cycles, so we store the counts at fully CLOSED and fully OPEN once
// (calibration) instead of zeroing at boot. Zeroing at boot would be wrong
// whenever the board powers up with the valve open.
//
//        closed_raw                                  open_raw
//   ---------|<-tol->|.......... MOVING ..........|<-tol->|---------
//    FAULT     CLOSED                                 OPEN      FAULT
//   (beyond the end stops: magnet or coupler slipped)
//
// Works in either rotation direction and across the 4095 -> 0 wrap.

#include <stdint.h>

namespace valve {

enum class State : uint8_t {
    UNKNOWN = 0,  // not calibrated yet
    CLOSED = 1,
    OPEN = 2,
    MOVING = 3,  // between the two end positions
    FAULT = 4,   // sensor problem, or angle outside the valve's travel
};

inline const char* stateName(State s) {
    switch (s) {
        case State::UNKNOWN:
            return "UNKNOWN";
        case State::CLOSED:
            return "CLOSED";
        case State::OPEN:
            return "OPEN";
        case State::MOVING:
            return "MOVING";
        case State::FAULT:
            return "FAULT";
    }
    return "?";
}

constexpr int COUNTS_PER_REV = 4096;

inline uint16_t degToCounts(float deg) {
    float c = deg * (COUNTS_PER_REV / 360.0f);
    return c <= 0.0f ? 0 : static_cast<uint16_t>(c + 0.5f);
}

// Signed shortest difference a - b on the 4096-count circle, in
// [-2048, 2047]. Handles wraparound: wrapDelta(10, 4090) == 16.
inline int wrapDelta(int a, int b) {
    int d = (a - b) % COUNTS_PER_REV;
    if (d < 0)
        d += COUNTS_PER_REV;
    if (d >= COUNTS_PER_REV / 2)
        d -= COUNTS_PER_REV;
    return d;
}

inline int absInt(int x) {
    return x < 0 ? -x : x;
}

struct Calibration {
    uint16_t closed_raw = 0;
    uint16_t open_raw = 0;
    uint16_t tolerance = 57;  // counts; 57 ~= 5 degrees
    bool has_closed = false;
    bool has_open = false;

    // Usable only if both ends are saved and they are far enough apart that
    // the CLOSED and OPEN windows can't overlap.
    bool valid() const {
        return has_closed && has_open &&
               absInt(wrapDelta(open_raw, closed_raw)) > 2 * tolerance;
    }
};

// sensor_ok = the encoder answered and reports a usable magnet.
inline State classify(uint16_t raw, bool sensor_ok, const Calibration& cal) {
    if (!sensor_ok)
        return State::FAULT;
    if (!cal.valid())
        return State::UNKNOWN;

    const int tol = cal.tolerance;
    if (absInt(wrapDelta(raw, cal.closed_raw)) <= tol)
        return State::CLOSED;
    if (absInt(wrapDelta(raw, cal.open_raw)) <= tol)
        return State::OPEN;

    // Position measured from CLOSED, in the direction CLOSED -> OPEN.
    const int travel = wrapDelta(cal.open_raw, cal.closed_raw);
    const int pos = wrapDelta(raw, cal.closed_raw);
    const bool same_dir = (travel > 0) == (pos > 0);
    if (same_dir && absInt(pos) < absInt(travel))
        return State::MOVING;
    return State::FAULT;
}

// 0 at CLOSED, 1000 at OPEN (can go a little outside while in the windows).
// Returns 0 when not calibrated. Handy for logging and the Receiver Board.
inline int travelPermille(uint16_t raw, const Calibration& cal) {
    if (!cal.valid())
        return 0;
    const int travel = wrapDelta(cal.open_raw, cal.closed_raw);
    const int pos = wrapDelta(raw, cal.closed_raw);
    return (pos * 1000) / travel;
}

}  // namespace valve
