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
#include <optional>
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

/** Calibrated table for one AIN: table_id + 0x10, e.g. {0x26, 0x13} for slot 1 AIN3. */
std::array<uint8_t, 2> calibrated_table_id(uint8_t slot, uint8_t ain);

/** Calibrated entity name, e.g. "T71_Cal.AIN3" (ESP32: "PT1_Cal.CH3"). */
std::string calibrated_entity_name(uint8_t slot, uint8_t ain);

/** The T7's internal temperature sensor, streamed for thermocouple cold-junction compensation
 *  whenever a board has a TC channel. Published raw like any AIN (no calibrated table). */
constexpr uint8_t kCjcAin = 14;

/** LJM and device error codes the session acts on (labjack/ljm_constants, LJM errorcodes). */
namespace ljm_code {
constexpr int kStreamNotInitialized = 1225;    ///< LJME_STREAM_NOT_INITIALIZED (LJM, this handle)
constexpr int kStreamNotRunning = 1303;        ///< LJME_STREAM_NOT_RUNNING
constexpr int kSynchronizationTimeout = 1306;  ///< LJME_SYNCHRONIZATION_TIMEOUT (no stream data)
constexpr int kStreamIsActive = 2605;  ///< device: "can not be performed while stream is running"
constexpr int kDeviceStreamNotRunning = 2620;  ///< device: "Stream was already disabled"
}  // namespace ljm_code

/** True for every way a stop can answer "there was no stream to stop". */
bool is_stream_not_running(int code);

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
    /** Command-response reads; only valid while no stream is running. */
    virtual std::vector<double> read_names(const std::vector<std::string>& names) = 0;
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
    std::vector<std::string> scan_names;  ///< "AIN1", ... in config order, then AIN14 for CJC
    std::vector<uint8_t> ains;            ///< same order as scan_names
    /** The configured channel behind each scan entry; nullopt for AIN14 (CJC). */
    std::vector<std::optional<config::T7Channel>> channels;
    int cjc_index = -1;  ///< position of AIN14 in the scan, or -1 when there is no TC
};
StreamPlan plan_stream(const config::T7Board& board);

/** One published value. */
struct Sample {
    uint8_t ain = 0;
    float volts = 0.0f;
    uint64_t timestamp_ns = 0;
    uint32_t sample_ms = 0;  ///< ms since stream start (wraps at 2^32)
};

/** One scan's thermocouple cold-junction temperature (the T7's terminals), in °C. */
struct ColdJunction {
    float temp_c = 0.0f;
    uint64_t timestamp_ns = 0;
    uint32_t sample_ms = 0;
};

/** A decoded LJM_eStreamRead block. */
struct Block {
    std::vector<Sample> samples;
    uint64_t scans = 0;            ///< scans in the block, including lost ones
    uint64_t skipped_samples = 0;  ///< values that were kDummyValue (auto-recovery), not published
    /** One per scan with a readable AIN14, on a board with a TC; empty otherwise. */
    std::vector<ColdJunction> cold_junction;
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

    /** Opens the device, checks its serial number if the config gives one, writes the setup,
     *  takes the cold-junction reference (TC boards) and starts the stream. Returns the actual
     *  scan rate. */
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
    /** start() found a stream already running on the device (left by a bridge that was killed,
     *  a server torn down mid-run, or Kipling) and stopped it before configuring. */
    bool stopped_leftover_stream() const {
        return stopped_leftover_;
    }
    /** The device's serial number, read by start(); 0 before then. */
    int64_t serial() const {
        return serial_;
    }
    /** AIN14 offset taken at start (K); see t7::cjc_device_offset_k. NaN without a TC. */
    double cjc_device_offset_k() const {
        return cjc_device_offset_k_;
    }

private:
    config::T7Board board_;
    std::unique_ptr<T7Device> device_;
    time::BoardClockSync clock_sync_;
    Clock clock_;
    StreamPlan plan_;
    double actual_rate_hz_ = 0.0;
    int64_t serial_ = 0;
    bool stopped_leftover_ = false;
    uint64_t next_scan_ = 0;
    std::vector<double> buffer_;
    bool open_ = false;
    double cjc_device_offset_k_;
};

/**
 * The stand-in T7 itself, as distinct from a connection to it.
 *
 * A real T7 keeps streaming after the process that started the stream dies, and keeps every
 * register it was written; the next process to open it finds both (synnaxlabs/synnax#4142 saw
 * every stream start fail with STREAM_IS_ACTIVE until the leftover stream was stopped). So the
 * stream and the registers live here, not in a FakeT7Device handle: a handle destroyed without a
 * stop — a killed bridge — leaves the unit streaming.
 *
 * With a state_path the unit is a file, re-read before and written after every operation, so
 * separate t7_bridge processes (`--fake-state`) see one device: `kill -9` the bridge and the next
 * one finds the stream still running. Without one it lives as long as the object.
 */
class FakeT7Unit {
public:
    explicit FakeT7Unit(std::string state_path = "");

    bool streaming = false;
    uint64_t stream_id = 0;  ///< bumped by every stream start; a handle reads only its own stream
    std::vector<std::string> scan_names;  ///< the running (or last) stream's scan list
    std::vector<std::pair<std::string, double>> registers;  ///< last value written per name
    uint64_t starts = 0, stops = 0;

    double reg(const std::string& name, double fallback = 0.0) const;
    void set_reg(const std::string& name, double value);
    /** Power off and on: no stream, registers back to defaults. */
    void power_cycle();

    void load();  ///< from state_path; no-op without one or when the file is absent
    void save() const;

private:
    std::string path_;
};

/**
 * A connection to a stand-in T7, for tests and for running the bridge with no hardware
 * (`t7_bridge --fake`).
 *
 * By default each AIN reads a slow sine offset by its AIN number, so the GUI shows distinct
 * lines; Options::signal replaces that. AIN14 (the internal temperature sensor) reads 25 C and
 * TEMPERATURE_DEVICE_K agrees with it. Every call is recorded so a test can check what the
 * session asked of the device. Device state (stream, registers) is the shared FakeT7Unit's.
 *
 * Modelled on LJM and the T7 firmware: a stream start, a configuration write or a
 * command-response read while the unit streams fails with STREAM_IS_ACTIVE (2605); a stop with
 * no stream answers STREAM_NOT_RUNNING (1303); writing STREAM_ENABLE = 0 stops the stream from
 * any handle; reading a stream another handle stopped times out (1306).
 */
class FakeT7Device : public T7Device {
public:
    struct Options {
        bool realtime = false;  ///< sleep each read as long as the scans would take
        int64_t serial = 470000000;
        double rate_cap_hz = 0.0;       ///< >0: the "device" rounds the scan rate down to this
        uint64_t dummy_scan_every = 0;  ///< >0: every Nth scan comes back as kDummyValue
        int fail_read_after = -1;       ///< >=0: throw on the read after this many succeed
        /** Volts on `ain` at `t` seconds into the stream; empty = the default sine. Not
         *  consulted for AIN14, which always follows device_temp_k. */
        std::function<double(int ain, double t)> signal;
        double device_temp_k = 298.15;  ///< what TEMPERATURE_DEVICE_K (and AIN14) report
        /** The device this handle talks to; null = a fresh unit of its own. */
        std::shared_ptr<FakeT7Unit> unit;
        /** LJM answers eStreamStop locally (1225) on a handle that did not start the stream,
         *  without telling the device. Synnax found a new handle's stop does reach a T7; this
         *  models the LJM where it would not, so the session's fallback is exercised. */
        bool stop_only_own_stream = false;
        /** !=0: every stream stop fails with this code (e.g. the link dropped). */
        int fail_stop_code = 0;
    };
    FakeT7Device() : FakeT7Device(Options{}) {
    }
    explicit FakeT7Device(Options o);

    void open(const std::string& ip) override;
    int64_t serial_number() override;
    void write_names(const std::vector<std::string>& names,
                     const std::vector<double>& values) override;
    std::vector<double> read_names(const std::vector<std::string>& names) override;
    double stream_start(const std::vector<std::string>& scan_names, int scans_per_read,
                        double scan_rate_hz) override;
    Backlog stream_read(std::vector<double>& data) override;
    void stream_stop() override;
    void close() override;

    // Recorded for tests.
    std::string opened_ip;
    std::vector<std::pair<std::string, double>> writes;
    std::vector<std::string> scan_names;
    std::vector<std::string> reads;  ///< every name read_names() was asked for
    bool streaming = false;          ///< this handle's own stream is running
    bool closed = false;
    int stop_calls = 0;

    FakeT7Unit& unit() {
        return *opt_.unit;
    }

    /** Volts on `ain` at `t`: Options::signal, else the default described above. */
    double volts(int ain, double t) const;

private:
    Options opt_;
    int scans_per_read_ = 0;
    double rate_ = 0.0;
    uint64_t scan_ = 0;
    int reads_ = 0;
    uint64_t my_stream_ = 0;  ///< unit stream_id this handle started; 0 = none
    bool owns_stream() const {
        return my_stream_ != 0 && opt_.unit->streaming && opt_.unit->stream_id == my_stream_;
    }
};

}  // namespace t7
}  // namespace fsw
