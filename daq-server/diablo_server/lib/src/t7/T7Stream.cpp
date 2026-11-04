#include "t7/T7Stream.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <thread>

#include "t7/T7Convert.hpp"

namespace fsw {
namespace t7 {

std::array<uint8_t, 2> table_id(uint8_t slot, uint8_t ain) {
    return {kTypeHi, static_cast<uint8_t>((slot - 1) * 0x20 + ain)};
}

std::string entity_name(uint8_t slot, uint8_t ain) {
    return "T7" + std::to_string(slot) + ".AIN" + std::to_string(ain);
}

std::array<uint8_t, 2> calibrated_table_id(uint8_t slot, uint8_t ain) {
    return {kTypeHi, static_cast<uint8_t>((slot - 1) * 0x20 + 0x10 + ain)};
}

std::string calibrated_entity_name(uint8_t slot, uint8_t ain) {
    return "T7" + std::to_string(slot) + "_Cal.AIN" + std::to_string(ain);
}

StreamPlan plan_stream(const config::T7Board& board) {
    StreamPlan p;
    auto set = [&](const std::string& name, double value) {
        p.setup_names.push_back(name);
        p.setup_values.push_back(value);
    };
    // Stream timing: start immediately on the internal clock. Stream takes its resolution and
    // settling from these two registers, NOT from AIN#_RESOLUTION_INDEX / AIN#_SETTLING_US,
    // which only apply to command-response reads.
    set("STREAM_TRIGGER_INDEX", 0);
    set("STREAM_CLOCK_SOURCE", 0);
    set("STREAM_RESOLUTION_INDEX", board.resolution_index);
    set("STREAM_SETTLING_US", board.settling_us);
    for (const auto& c : board.channels) {
        const std::string ain = "AIN" + std::to_string(c.ain);
        set(ain + "_RANGE", c.range_v);
        set(ain + "_NEGATIVE_CH", c.negative_ch());
        // An extended feature left on by a previous user (Kipling, an old script) changes what a
        // command-response read of this input means; clear it so the device state is ours.
        set(ain + "_EF_INDEX", 0);
        p.scan_names.push_back(ain);
        p.ains.push_back(static_cast<uint8_t>(c.ain));
        p.channels.emplace_back(c);
    }
    // A thermocouple reads the difference between its hot end and the terminals, so the terminal
    // temperature rides along in every scan: AIN14, the internal sensor. Last, so the first scan
    // entry stays a configured AIN (auto-recovery marks gaps in the first channel).
    const bool has_tc =
        std::any_of(board.channels.begin(), board.channels.end(), [](const config::T7Channel& c) {
            return c.kind == "TC";
        });
    if (has_tc) {
        const std::string ain = "AIN" + std::to_string(kCjcAin);
        set(ain + "_RANGE", 10.0);
        set(ain + "_NEGATIVE_CH", 199);
        set(ain + "_EF_INDEX", 0);
        p.cjc_index = static_cast<int>(p.scan_names.size());
        p.scan_names.push_back(ain);
        p.ains.push_back(kCjcAin);
        p.channels.emplace_back(std::nullopt);
    }
    return p;
}

T7Session::T7Session(config::T7Board board, std::unique_ptr<T7Device> device,
                     const time::TimeSyncConfig& time_sync, Clock clock)
    : board_(std::move(board)),
      device_(std::move(device)),
      clock_sync_(time_sync),
      clock_(std::move(clock)),
      plan_(plan_stream(board_)),
      cjc_device_offset_k_(std::numeric_limits<double>::quiet_NaN()) {
}

double T7Session::start() {
    device_->open(board_.ip);
    open_ = true;
    // Always read it: the bridge logs it, so bring-up can tell which unit answered at that IP.
    serial_ = device_->serial_number();
    if (board_.serial != 0 && serial_ != board_.serial)
        throw T7Error("[" + board_.section + "] the T7 at " + board_.ip + " has serial " +
                      std::to_string(serial_) + ", config says " + std::to_string(board_.serial));
    // A stream left running by a crashed bridge (or Kipling) rejects the setup writes.
    try {
        device_->stream_stop();
    } catch (const T7Error&) {
        // "stream not running" is the normal case.
    }
    device_->write_names(plan_.setup_names, plan_.setup_values);
    if (plan_.cjc_index >= 0) {
        // The device's own calibrated temperature beside the raw AIN14 it comes from pins this
        // unit's offset; only the nominal slope is then trusted, over the few K it drifts.
        // Command-response, so it has to happen before the stream takes the analog inputs.
        const auto v = device_->read_names({"TEMPERATURE_DEVICE_K", "AIN14"});
        if (v.size() != 2 || !(v[0] > 200.0 && v[0] < 400.0))
            throw T7Error("[" + board_.section + "] implausible TEMPERATURE_DEVICE_K " +
                          (v.empty() ? std::string("(none)") : std::to_string(v[0])));
        cjc_device_offset_k_ = t7::cjc_device_offset_k(v[0], v[1]);
    }
    const int spr = board_.effective_scans_per_read();
    actual_rate_hz_ = device_->stream_start(plan_.scan_names, spr, board_.scan_rate_hz);
    if (!(actual_rate_hz_ > 0.0))
        throw T7Error("[" + board_.section + "] device reported a scan rate of " +
                      std::to_string(actual_rate_hz_));
    buffer_.assign(static_cast<size_t>(spr) * plan_.ains.size(), 0.0);
    next_scan_ = 0;
    return actual_rate_hz_;
}

Block T7Session::read() {
    Block b;
    b.backlog = device_->stream_read(buffer_);
    const uint64_t arrival_ns = clock_();
    const size_t n = plan_.ains.size();
    const uint64_t scans = buffer_.size() / n;
    b.scans = scans;
    if (scans == 0)
        return b;

    // Device time of scan k, in ns since the first scan.
    const double period_ns = 1e9 / actual_rate_hz_;
    auto device_ns = [&](uint64_t k) {
        return static_cast<uint64_t>(std::llround(static_cast<double>(k) * period_ns));
    };
    auto device_ms = [&](uint64_t k) {
        return static_cast<uint32_t>(device_ns(k) / 1000000ULL);
    };

    const uint64_t first = next_scan_;
    const uint64_t last = first + scans - 1;
    // Anchor the newest scan through the clock sync; it works in whole board ms, so add back the
    // sub-millisecond part, but never past the arrival time (a scan cannot postdate its delivery).
    const uint64_t last_ns = device_ns(last);
    const uint64_t sub_ms = last_ns % 1000000ULL;
    uint64_t anchor =
        clock_sync_.stamp_packet(board_.section, arrival_ns, {device_ms(last)}).front() + sub_ms;
    anchor = std::min(anchor, arrival_ns);

    b.samples.reserve(buffer_.size());
    for (uint64_t s = 0; s < scans; ++s) {
        const uint64_t k = first + s;
        const uint64_t back = last_ns - device_ns(k);
        const uint64_t ts = anchor > back ? anchor - back : 0;
        // This scan's cold junction, if the board has thermocouples. Only the bridge can work it
        // out (the offset is taken from the device at stream start), so it is published as its
        // own table for calibration_service, which turns TC volts into temperature.
        if (plan_.cjc_index >= 0) {
            const double v14 = buffer_[s * n + static_cast<size_t>(plan_.cjc_index)];
            if (v14 != kDummyValue)
                b.cold_junction.push_back(
                    {static_cast<float>(cjc_temp_c(v14, cjc_device_offset_k_, board_.cjc_offset_k)),
                     ts, device_ms(k)});
        }
        for (size_t c = 0; c < n; ++c) {
            const double v = buffer_[s * n + c];
            if (v == kDummyValue) {
                ++b.skipped_samples;
                continue;
            }
            b.samples.push_back(Sample{plan_.ains[c], static_cast<float>(v), ts, device_ms(k)});
        }
    }
    next_scan_ = last + 1;
    return b;
}

void T7Session::stop() noexcept {
    if (!open_)
        return;
    try {
        device_->stream_stop();
    } catch (...) {
    }
    try {
        device_->close();
    } catch (...) {
    }
    open_ = false;
}

// ── FakeT7Device ─────────────────────────────────────────────────────────────────────────────

void FakeT7Device::open(const std::string& ip) {
    opened_ip = ip;
    closed = false;
}

int64_t FakeT7Device::serial_number() {
    return opt_.serial;
}

void FakeT7Device::write_names(const std::vector<std::string>& names,
                               const std::vector<double>& values) {
    if (streaming)
        throw T7Error("fake T7: configuration written while streaming", 2605);
    for (size_t i = 0; i < names.size(); ++i)
        writes.emplace_back(names[i], values.at(i));
}

std::vector<double> FakeT7Device::read_names(const std::vector<std::string>& names) {
    if (streaming)
        throw T7Error("fake T7: command-response AIN read while streaming", 2605);
    std::vector<double> out;
    for (const auto& n : names) {
        reads.push_back(n);
        if (n == "TEMPERATURE_DEVICE_K")
            out.push_back(opt_.device_temp_k);
        else if (n.rfind("AIN", 0) == 0)
            out.push_back(volts(std::stoi(n.substr(3)), 0.0));
        else
            throw T7Error("fake T7: no register " + n, 1294);
    }
    return out;
}

double FakeT7Device::volts(int ain, double t) const {
    if (ain == kCjcAin)  // the internal sensor at device_temp_k, on LabJack's nominal line
        return (opt_.device_temp_k - 465.129215) / kAin14SlopeKPerV;
    if (opt_.signal)
        return opt_.signal(ain, t);
    return 0.1 * ain + 0.05 * std::sin(2.0 * M_PI * 0.2 * t);
}

double FakeT7Device::stream_start(const std::vector<std::string>& names, int scans_per_read,
                                  double scan_rate_hz) {
    if (streaming)
        throw T7Error("fake T7: stream already running", 2605);
    scan_names = names;
    scans_per_read_ = scans_per_read;
    rate_ = opt_.rate_cap_hz > 0.0 ? std::min(scan_rate_hz, opt_.rate_cap_hz) : scan_rate_hz;
    scan_ = 0;
    streaming = true;
    return rate_;
}

T7Device::Backlog FakeT7Device::stream_read(std::vector<double>& data) {
    if (!streaming)
        throw T7Error("fake T7: read with no stream running", 1225);
    if (opt_.fail_read_after >= 0 && reads_ >= opt_.fail_read_after)
        throw T7Error("fake T7: link lost", 1306);
    ++reads_;
    if (opt_.realtime)
        std::this_thread::sleep_for(std::chrono::duration<double>(scans_per_read_ / rate_));
    const size_t n = scan_names.size();
    data.resize(static_cast<size_t>(scans_per_read_) * n);
    for (int s = 0; s < scans_per_read_; ++s, ++scan_) {
        const bool lost = opt_.dummy_scan_every > 0 && (scan_ + 1) % opt_.dummy_scan_every == 0;
        const double t = static_cast<double>(scan_) / rate_;
        for (size_t c = 0; c < n; ++c) {
            const int ain = std::stoi(scan_names[c].substr(3));
            data[s * n + c] = lost ? kDummyValue : volts(ain, t);
        }
    }
    return {};
}

void FakeT7Device::stream_stop() {
    if (!streaming)
        throw T7Error("fake T7: stream not running", 1225);
    streaming = false;
}

void FakeT7Device::close() {
    streaming = false;
    closed = true;
}

}  // namespace t7
}  // namespace fsw
