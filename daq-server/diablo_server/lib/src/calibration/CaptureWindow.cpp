#include "calibration/CaptureWindow.hpp"

#include <algorithm>
#include <cmath>

namespace fsw {
namespace calibration {

namespace {

constexpr uint64_t NS_PER_MS = 1000000ULL;

/** Saturating difference — clocks are unsigned and callers may pass a `now` that predates
 *  a sample (a reordered packet, or a test driving times by hand). Wrapping here would
 *  turn "41 ms old" into "584 million years old" and reject a healthy capture. */
uint64_t ms_between(uint64_t later_ns, uint64_t earlier_ns) {
    return later_ns > earlier_ns ? (later_ns - earlier_ns) / NS_PER_MS : 0;
}

double mean_of(const std::vector<double>& v, size_t from, size_t to) {
    double sum = 0.0;
    for (size_t i = from; i < to; i++)
        sum += v[i];
    return sum / static_cast<double>(to - from);
}

}  // namespace

void CaptureWindow::push(uint16_t uid, int32_t adc, uint64_t ts_ns, uint64_t rx_ns) {
    auto& ring = rings_[uid];
    ring.push_back(AdcSample{ts_ns, rx_ns, adc});

    // Evict by span first: that is what makes one ring serve a 10 Hz actuator and a
    // 250 Hz transducer without either being sized for the other.
    const uint64_t span_limit_ns = kRingSpanMs * NS_PER_MS;
    while (ring.size() > 1 && ring.back().ts_ns > ring.front().ts_ns &&
           ring.back().ts_ns - ring.front().ts_ns > span_limit_ns) {
        ring.pop_front();
    }
    // Then by count, so a fast board cannot grow it without bound.
    while (ring.size() > kRingMax)
        ring.pop_front();
}

CaptureResult CaptureWindow::capture(uint16_t uid, uint64_t now_rx_ns) const {
    CaptureResult r;

    auto it = rings_.find(uid);
    if (it == rings_.end() || it->second.empty()) {
        r.reason = kReasonNoSamples;
        return r;
    }
    const std::deque<AdcSample>& ring = it->second;
    const AdcSample& newest = ring.back();

    // Liveness, on OUR clock. A sensor that stopped publishing still "has" samples; that
    // is exactly how a capture on a dead channel used to succeed and record a stale code.
    r.age_ms = ms_between(now_rx_ns, newest.rx_ns);
    if (r.age_ms > kMaxSampleAgeMs) {
        r.reason = kReasonStale;
        return r;
    }

    // Membership, anchored on the newest SAMPLE time rather than on now, so a constant
    // board-to-host epoch offset cancels instead of emptying the window.
    const uint64_t window_ns = kCaptureWindowMs * NS_PER_MS;
    const uint64_t floor_ns = newest.ts_ns > window_ns ? newest.ts_ns - window_ns : 0;

    std::vector<double> vals;
    vals.reserve(ring.size());
    uint64_t oldest_ts = newest.ts_ns;
    for (const AdcSample& s : ring) {
        if (s.ts_ns < floor_ns)
            continue;
        vals.push_back(static_cast<double>(s.adc));
        oldest_ts = std::min(oldest_ts, s.ts_ns);
    }

    r.n = vals.size();
    r.span_ms = ms_between(newest.ts_ns, oldest_ts);

    if (r.n < kMinCaptureSamples) {
        r.reason = kReasonTooFew;
        return r;
    }

    r.adc_avg = mean_of(vals, 0, vals.size());
    const auto mm = std::minmax_element(vals.begin(), vals.end());
    r.spread = *mm.second - *mm.first;

    // Settling: a step or ramp inside the window shows up as a difference between the
    // two half-means that plain noise cannot produce. Normalising by the window's own
    // noise is what lets one threshold cover every sensor type on the rig.
    const size_t half = vals.size() / 2;
    const double m1 = mean_of(vals, 0, half);
    const double m2 = mean_of(vals, half, vals.size());
    r.drift = std::fabs(m2 - m1);

    // Pool the noise WITHIN each half, never across the whole window. Measuring scatter
    // about the window mean would fold the step itself into the denominator: a 50,000-count
    // jump makes sd ~25,000 and drags z down to ~3.7, so the larger the step the better it
    // hides. Residuals about each half's own mean leave only the noise, and z rises with the
    // step as it should. (This is the two-sample pooled standard error.)
    double ss = 0.0;
    for (size_t i = 0; i < half; i++)
        ss += (vals[i] - m1) * (vals[i] - m1);
    for (size_t i = half; i < vals.size(); i++)
        ss += (vals[i] - m2) * (vals[i] - m2);
    const size_t n1 = half, n2 = vals.size() - half;
    const double dof = static_cast<double>(n1 + n2) - 2.0;
    const double sd_pooled = dof > 0.0 ? std::sqrt(ss / dof) : 0.0;
    // Floor at one ADC count: a perfectly quiet signal (the simulator, or a stuck channel)
    // has sd 0, and dividing by it would call any drift infinitely significant.
    const double se = std::max(
        sd_pooled * std::sqrt(1.0 / static_cast<double>(n1) + 1.0 / static_cast<double>(n2)), 1.0);
    r.drift_z = r.drift / se;
    r.settled = r.drift_z <= kSettleZ;

    r.ok = true;
    r.reason = kReasonOk;
    return r;
}

void CaptureWindow::clear() {
    rings_.clear();
}

void CaptureWindow::clear(uint16_t uid) {
    rings_.erase(uid);
}

std::vector<uint16_t> CaptureWindow::uids() const {
    std::vector<uint16_t> out;
    out.reserve(rings_.size());
    for (const auto& [uid, ring] : rings_) {
        if (!ring.empty())
            out.push_back(uid);
    }
    std::sort(out.begin(), out.end());
    return out;
}

size_t CaptureWindow::size(uint16_t uid) const {
    auto it = rings_.find(uid);
    return it == rings_.end() ? 0 : it->second.size();
}

}  // namespace calibration
}  // namespace fsw
