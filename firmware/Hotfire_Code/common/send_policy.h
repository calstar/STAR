#pragma once

#include <stddef.h>
#include <stdint.h>

//-----------------------------------------------------------------------------
// When a sensor board ships the chunks it has queued.
//
// A packet used to go out only once SENSOR_MAX_CHUNKS_BEFORE_SEND chunks were
// queued. That is ~120 ms on a 75 Hz PT board, but an LC board scanning two
// load cells at 20 SPS + SINC4 finishes a chunk every ~0.8 s, so nine of them
// held each reading back 7-12 s. The GUI then saw nothing between bursts and
// blanked the readout as if the board had dropped off, and the server's clock
// sync, which refuses batches older than [time_sync] max_batch_age_s, stamped
// the whole burst at its arrival time.
//
// So a batch also goes out once its OLDEST chunk is max_age_ms old: fast boards
// still fill a packet first, slow boards send every chunk as it completes.
// oldest_ms and now_ms are the board's millis(); unsigned subtraction keeps
// the age right across the 49.7-day wrap.
//-----------------------------------------------------------------------------
inline bool sensorBatchReady(size_t queued, size_t max_chunks,
                             uint32_t oldest_ms, uint32_t now_ms,
                             uint32_t max_age_ms) {
    if (queued == 0)
        return false;
    if (queued >= max_chunks)
        return true;
    return static_cast<uint32_t>(now_ms - oldest_ms) >= max_age_ms;
}
