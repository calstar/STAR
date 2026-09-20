#include "calibration/LcZeroStore.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <nlohmann/json.hpp>

namespace fsw {
namespace calibration {

namespace {

double unix_now_ms() {
    return std::chrono::duration<double, std::milli>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

/** A reference value this close to zero is an operator's "0", not a coincidence. */
constexpr double kZeroRefEps = 1e-9;

/** Bisection budget. A double's mantissa runs out long before this; the cap is only here so a
 *  pathological curve cannot spin. */
constexpr int kBisectIters = 200;

/** FNV-1a over a double's raw bits, folding a non-finite value to a fixed sentinel so a blown-up
 *  basis still fingerprints deterministically rather than hashing whichever NaN payload arrived. */
void fnv_mix_double(uint64_t& h, double v) {
    uint64_t bits;
    if (std::isfinite(v))
        std::memcpy(&bits, &v, sizeof(bits));
    else
        bits = 0xDEADBEEFDEADBEEFull;
    for (size_t i = 0; i < sizeof(bits); ++i) {
        h ^= static_cast<uint64_t>((bits >> (i * 8)) & 0xFF);
        h *= 1099511628211ull;
    }
}

}  // namespace

ZeroBasis physics_zero_basis() {
    ZeroBasis b;
    b.ok = true;
    b.cal_zero_adc = 0.0;
    b.domain_min = -2147483648.0;
    b.domain_max = 2147483647.0;
    b.how = "physics";
    return b;
}

ZeroBasis zero_basis_from_points(const std::vector<std::pair<double, double>>& points,
                                 const std::function<double(double)>& curve) {
    ZeroBasis b;
    if (points.empty())
        return b;  // no points, no curve, nothing to anchor to

    double lo = std::numeric_limits<double>::infinity();
    double hi = -std::numeric_limits<double>::infinity();
    double zero_sum = 0.0;
    size_t zero_n = 0;
    for (const auto& [adc, ref] : points) {
        if (!std::isfinite(adc) || !std::isfinite(ref))
            continue;
        lo = std::min(lo, adc);
        hi = std::max(hi, adc);
        if (std::fabs(ref) < kZeroRefEps) {
            zero_sum += adc;
            ++zero_n;
        }
    }
    if (!std::isfinite(lo) || !std::isfinite(hi))
        return b;

    b.domain_min = lo;
    b.domain_max = hi;

    // 1. The operator's own empty-scale capture. A measurement beats a root every time: it is
    //    where the cell actually sat with nothing on it, rather than where a least-squares cubic
    //    happens to cross zero.
    if (zero_n > 0) {
        b.cal_zero_adc = zero_sum / static_cast<double>(zero_n);
        b.how = "point";
        b.ok = std::isfinite(b.cal_zero_adc);
        return b;
    }

    // 2. Bisect, but only inside the span the fit was actually constrained over. Outside it a
    //    cubic's roots are an artefact of the extrapolation, not a property of the cell.
    if (!curve)
        return b;
    const double span = hi - lo;
    if (!(span > 0.0))
        return b;  // one distinct code: no bracket to search, and no curve worth trusting
    double left = lo - kDomainMargin * span;
    double right = hi + kDomainMargin * span;
    double f_left = curve(left);
    double f_right = curve(right);
    if (!std::isfinite(f_left) || !std::isfinite(f_right))
        return b;
    if ((f_left > 0.0 && f_right > 0.0) || (f_left < 0.0 && f_right < 0.0))
        return b;  // no sign change: this calibration never spanned 0 kg

    for (int i = 0; i < kBisectIters; ++i) {
        const double mid = 0.5 * (left + right);
        if (!(mid > left && mid < right))
            break;  // the interval is down to adjacent doubles
        const double f_mid = curve(mid);
        if (!std::isfinite(f_mid))
            return b;
        if (f_mid == 0.0) {
            left = right = mid;
            break;
        }
        if ((f_mid > 0.0) == (f_left > 0.0)) {
            left = mid;
            f_left = f_mid;
        } else {
            right = mid;
            f_right = f_mid;
        }
    }
    b.cal_zero_adc = 0.5 * (left + right);
    b.how = "bisect";
    b.ok = std::isfinite(b.cal_zero_adc);
    return b;
}

LcZeroStore::LcZeroStore(std::string file_path) : file_path_(std::move(file_path)) {
}

uint64_t LcZeroStore::fingerprint(const ZeroBasis& basis) {
    if (!basis.ok)
        return 0;
    uint64_t h = 1469598103934665603ull;
    fnv_mix_double(h, basis.cal_zero_adc);
    fnv_mix_double(h, basis.domain_min);
    fnv_mix_double(h, basis.domain_max);
    return h;
}

bool LcZeroStore::recompute_locked(LcZero& z, const ZeroBasis& basis) {
    if (!basis.ok)
        return false;
    const double shift = z.adc_at_zero - basis.cal_zero_adc;
    if (!std::isfinite(shift))
        return false;
    z.cal_zero_adc = basis.cal_zero_adc;
    z.shift_codes = shift;
    z.domain_min = basis.domain_min;
    z.domain_max = basis.domain_max;
    z.basis_fp = fingerprint(basis);
    return true;
}

bool LcZeroStore::set(uint16_t uid, const std::string& entity, double adc_at_zero,
                      const ZeroBasis& basis) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!std::isfinite(adc_at_zero))
        return false;

    LcZero z;
    z.uid = uid;
    z.entity = entity;
    z.adc_at_zero = adc_at_zero;
    z.set_at_ms = unix_now_ms();
    if (!recompute_locked(z, basis)) {
        // Nothing is recorded. See the header: a zero that cannot be substantiated would shift
        // every sample on the channel, which is worse than having no zero at all.
        std::cout << "[LcZero] uid " << static_cast<int>(uid)
                  << ": no usable 0 kg anchor in the calibration (basis=" << basis.how
                  << ") — zero not recorded" << std::endl;
        return false;
    }
    zeros_[uid] = z;
    return true;
}

void LcZeroStore::clear(uint16_t uid) {
    std::lock_guard<std::mutex> lock(mutex_);
    zeros_.erase(uid);
}

void LcZeroStore::clear_all() {
    std::lock_guard<std::mutex> lock(mutex_);
    zeros_.clear();
}

double LcZeroStore::shift_for(uint16_t uid) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = zeros_.find(uid);
    return it == zeros_.end() ? 0.0 : it->second.shift_codes;
}

void LcZeroStore::recompute(uint16_t uid, const ZeroBasis& basis) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!curves_trusted_)
        return;
    auto it = zeros_.find(uid);
    if (it == zeros_.end())
        return;
    LcZero probe = it->second;
    if (recompute_locked(probe, basis))
        it->second = probe;
    // else: keep the last good shift. Deriving against a calibration we could not read would
    // replace a usable number with a confident wrong one.
}

void LcZeroStore::recompute_all(const BasisFn& basis_for) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!curves_trusted_ || !basis_for)
        return;
    for (auto& [uid, z] : zeros_) {
        LcZero probe = z;
        if (recompute_locked(probe, basis_for(uid)))
            z = probe;
    }
}

size_t LcZeroStore::recompute_stale(const BasisFn& basis_for) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!curves_trusted_ || !basis_for)
        return 0;
    size_t stale = 0;
    for (auto& [uid, z] : zeros_) {
        const ZeroBasis basis = basis_for(uid);
        if (fingerprint(basis) == z.basis_fp)
            continue;
        ++stale;
        LcZero probe = z;
        if (recompute_locked(probe, basis))
            z = probe;
    }
    return stale;
}

void LcZeroStore::set_curves_trusted(bool trusted) {
    std::lock_guard<std::mutex> lock(mutex_);
    curves_trusted_ = trusted;
}

bool LcZeroStore::curves_trusted() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return curves_trusted_;
}

const LcZero* LcZeroStore::zero_for(uint16_t uid) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = zeros_.find(uid);
    return it == zeros_.end() ? nullptr : &it->second;
}

std::vector<uint16_t> LcZeroStore::uids() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<uint16_t> out;
    out.reserve(zeros_.size());
    for (const auto& [uid, z] : zeros_)
        out.push_back(uid);
    return out;
}

size_t LcZeroStore::size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return zeros_.size();
}

bool LcZeroStore::load_failed() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return load_failed_;
}

std::string LcZeroStore::serialize() const {
    nlohmann::json root;
    root["version"] = 1;
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& [uid, z] : zeros_) {
        nlohmann::json zj;
        zj["uid"] = z.uid;
        zj["entity"] = z.entity;
        zj["adc_at_zero"] = z.adc_at_zero;
        zj["cal_zero_adc"] = z.cal_zero_adc;
        zj["shift_codes"] = z.shift_codes;
        zj["domain_min"] = z.domain_min;
        zj["domain_max"] = z.domain_max;
        zj["set_at_ms"] = z.set_at_ms;
        zj["basis_fp"] = z.basis_fp;
        arr.push_back(zj);
    }
    root["zeros"] = arr;
    return root.dump(2);
}

bool LcZeroStore::save() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (load_failed_) {
        // Same rule as LcTareStore and CubicCalibrationStore: a file we could not read is a file
        // we must not replace, because this store is empty precisely because the read failed.
        return false;
    }
    try {
        std::filesystem::path p(file_path_);
        if (p.has_parent_path())
            std::filesystem::create_directories(p.parent_path());
        const std::string tmp = file_path_ + ".tmp";
        {
            std::ofstream f(tmp, std::ios::trunc);
            if (!f.is_open())
                return false;
            f << serialize();
            f.flush();
            if (!f.good())
                return false;
        }
        std::filesystem::rename(tmp, file_path_);  // atomic replace on same filesystem
        return true;
    } catch (...) {
        return false;
    }
}

size_t LcZeroStore::load() {
    std::lock_guard<std::mutex> lock(mutex_);
    zeros_.clear();

    std::ifstream f(file_path_);
    if (!f.is_open()) {
        // No file is the normal state on a stand that has never been zeroed. Unlike the tare
        // file, nothing removes this one at session start — see the header.
        load_failed_ = false;
        return 0;
    }
    std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());

    nlohmann::json root;
    try {
        root = nlohmann::json::parse(content);
    } catch (...) {
        load_failed_ = true;
        std::cout << "[LcZero] " << file_path_ << " could not be parsed — refusing to overwrite it"
                  << std::endl;
        return 0;
    }
    if (!root.contains("zeros") || !root["zeros"].is_array()) {
        load_failed_ = true;
        std::cout << "[LcZero] " << file_path_ << " has no zeros array — refusing to overwrite it"
                  << std::endl;
        return 0;
    }
    load_failed_ = false;

    size_t loaded = 0;
    for (const auto& zj : root["zeros"]) {
        if (!zj.is_object())
            continue;
        LcZero z;
        z.uid = static_cast<uint16_t>(zj.value("uid", 0));
        if (z.uid == 0)
            continue;
        z.entity = zj.value("entity", std::string());
        z.adc_at_zero = zj.value("adc_at_zero", 0.0);
        z.cal_zero_adc = zj.value("cal_zero_adc", 0.0);
        z.shift_codes = zj.value("shift_codes", 0.0);
        z.domain_min = zj.value("domain_min", 0.0);
        z.domain_max = zj.value("domain_max", 0.0);
        z.set_at_ms = zj.value("set_at_ms", 0.0);
        z.basis_fp = zj.value("basis_fp", static_cast<uint64_t>(0));
        if (!std::isfinite(z.adc_at_zero) || !std::isfinite(z.shift_codes))
            continue;
        zeros_[z.uid] = z;
        ++loaded;
    }
    return loaded;
}

}  // namespace calibration
}  // namespace fsw
