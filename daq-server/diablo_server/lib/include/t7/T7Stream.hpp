#pragma once

// LabJack T7 streaming, minus the LabJack library.
//
// Everything t7_bridge does that can be checked without hardware lives here: what gets written to
// the device before a stream, how a block from LJM_eStreamRead is unpacked, how its scans are
// timestamped, and which Elodin table each AIN lands in. The device is reached only through the
// T7Device interface, which has two implementations: LjmT7Device (services/t7_bridge, needs
// libLabJackM) and FakeT7Device (here, for tests and `t7_bridge --fake`).

#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "config/T7Config.hpp"
#include "time/BoardClockSync.hpp"

namespace fsw {
namespace t7 {

/** Elodin table-id high byte for T7 analog inputs (0x20-0x25 are the ESP32 sensor types). */
constexpr uint8_t kTypeHi = 0x26;

/** What LJM writes into a scan lost to stream auto-recovery (LJM_DUMMY_VALUE). */
constexpr double kDummyValue = -9999.0;

/** Table id for one AIN: {0x26, (slot-1)*0x20 + ain}, the same layout as the ESP32 boards. The
 *  calibrated counterpart, when there is one, takes +0x10 as theirs does. */
std::array<uint8_t, 2> table_id(uint8_t slot, uint8_t ain);

/** Elodin entity name for one AIN, e.g. "T71.AIN3". */
std::string entity_name(uint8_t slot, uint8_t ain);

/** A device failure. `code` is the LJM error code where there is one, else 0. */
class T7Error : public std::runtime_error {
public:
    T7Error(const std::string& what, int code = 0) : std::runtime_error(what), code_(code) {
    }
    int code() const {
        return code_;
    }

private:
    int code_;
};

/** The device seam. Every call may throw T7Error. */
class T7Device {
public:
    virtual ~T7Device() = default;
    virtual void open(const std::string& ip) = 0;
    virtual int64_t serial_number() = 0;
    virtual void write_names(const std::vector<std::string>& names,
                             const std::vector<double>& values) = 0;
    /** Starts the stream; returns the scan rate the device will actually run at. */
    virtual double stream_start(const std::vector<std::string>& scan_names, int scans_per_read,
                                double scan_rate_hz) = 0;
    struct Backlog {
        int device_scans = 0;  ///< scans still in the T7's buffer
        int ljm_scans = 0;     ///< scans still in LJM's buffer
    };
    /** Fills `data` with scans_per_read scans, channels interleaved. Blocks until they arrive. */
    virtual Backlog stream_read(std::vector<double>& data) = 0;
    virtual void stream_stop() = 0;
    virtual void close() = 0;
};

/** What to write before streaming and what to stream, derived from a board's config. */
struct StreamPlan {
    std::vector<std::string> setup_names;
    std::vector<double> setup_values;
    std::vector<std::string> scan_names;  ///< "AIN1", ... in config order
    std::vector<uint8_t> ains;            ///< same order as scan_names
};
StreamPlan plan_stream(const config::T7Board& board);

/** One published value. */
struct Sample {
    uint8_t ain = 0;
    float volts = 0.0f;
    uint64_t timestamp_ns = 0;
    uint32_t sample_ms = 0;  ///< ms since stream start (wraps at 2^32)
};

/** A decoded LJM_eStreamRead block. */
struct Block {
    std::vector<Sample> samples;
    uint64_t scans = 0;            ///< scans in the block, including lost ones
    uint64_t skipped_samples = 0;  ///< values that were kDummyValue (auto-recovery), not published
    T7Device::Backlog backlog;
};

/**
 * One T7's stream: open, configure, start, then read blocks until something throws.
 *
 * Timestamps. The T7 scans on its own crystal at a fixed rate, so scan k happened at
 * k / actual_rate seconds after the stream started. That device time goes through the same
 * BoardClockSync the ESP32 boards use, keyed by the board's config section, which estimates the
 * device-to-host offset from when blocks arrive (arrival can only be late, never early). The newest
 * scan of each block is anchored that way and the others are placed back from it at the exact
 * scan period. In [time_sync] mode = "arrival" the anchor is simply the arrival time.
 */
class T7Session {
public:
    using Clock = std::function<uint64_t()>;  ///< epoch ns

    T7Session(config::T7Board board, std::unique_ptr<T7Device> device,
              const time::TimeSyncConfig& time_sync, Clock clock);

    /** Opens the device, checks its serial number if the config gives one, writes the setup and
     *  starts the stream. Returns the actual scan rate. */
    double start();

    /** Reads and decodes one block. */
    Block read();

    /** Stops the stream and closes the device; never throws. */
    void stop() noexcept;

    const config::T7Board& board() const {
        return board_;
    }
    const StreamPlan& plan() const {
        return plan_;
    }
    double actual_rate_hz() const {
        return actual_rate_hz_;
    }

private:
    config::T7Board board_;
    std::unique_ptr<T7Device> device_;
    time::BoardClockSync clock_sync_;
    Clock clock_;
    StreamPlan plan_;
    double actual_rate_hz_ = 0.0;
    uint64_t next_scan_ = 0;
    std::vector<double> buffer_;
    bool open_ = false;
};

/**
 * A stand-in T7 for tests and for running the bridge with no hardware (`t7_bridge --fake`).
 *
 * Each AIN reads a slow sine offset by its AIN number, so the GUI shows distinct lines. Every
 * call is recorded so a test can check what the session asked of the device.
 */
class FakeT7Device : public T7Device {
public:
    struct Options {
        bool realtime = false;  ///< sleep each read as long as the scans would take
        int64_t serial = 470000000;
        double rate_cap_hz = 0.0;       ///< >0: the "device" rounds the scan rate down to this
        uint64_t dummy_scan_every = 0;  ///< >0: every Nth scan comes back as kDummyValue
        int fail_read_after = -1;       ///< >=0: throw on the read after this many succeed
    };
    FakeT7Device() = default;
    explicit FakeT7Device(Options o) : opt_(o) {
    }

    void open(const std::string& ip) override;
    int64_t serial_number() override;
    void write_names(const std::vector<std::string>& names,
                     const std::vector<double>& values) override;
    double stream_start(const std::vector<std::string>& scan_names, int scans_per_read,
                        double scan_rate_hz) override;
    Backlog stream_read(std::vector<double>& data) override;
    void stream_stop() override;
    void close() override;

    // Recorded for tests.
    std::string opened_ip;
    std::vector<std::pair<std::string, double>> writes;
    std::vector<std::string> scan_names;
    bool streaming = false;
    bool closed = false;

private:
    Options opt_;
    int scans_per_read_ = 0;
    double rate_ = 0.0;
    uint64_t scan_ = 0;
    int reads_ = 0;
};

}  // namespace t7
}  // namespace fsw
