#include "calibration/LcTareStore.hpp"

#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <nlohmann/json.hpp>

namespace fsw {
namespace calibration {

namespace {

double unix_now_ms() {
    return std::chrono::duration<double, std::milli>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

/** Probe codes spanning the signed 32-bit ADC range the LC boards report. Fixed forever: they
 *  only have to be the SAME codes across two fingerprints, never meaningful loads. */
constexpr double kProbes[] = {-1.0e9, -1.0e6, 0.0, 1.0e6, 1.0e9};

}  // namespace

std::string lc_tare_entity(uint8_t board_id, uint8_t connector) {
    const int m = static_cast<int>(board_id) % 10;
    const int slot = (m == 0 ? 10 : m);
    return "LC" + std::to_string(slot) + "_Cal.CH" + std::to_string(static_cast<int>(connector));
}

LcTareStore::LcTareStore(std::string file_path) : file_path_(std::move(file_path)) {
}

uint64_t LcTareStore::fingerprint(const Evaluator& eval) {
    if (!eval)
        return 0;
    // FNV-1a over the raw bits of each probe's result. A non-finite result is folded in as a
    // fixed sentinel so a blown-up curve still fingerprints deterministically rather than
    // hashing whichever NaN payload the FPU produced.
    uint64_t h = 1469598103934665603ull;
    for (double probe : kProbes) {
        const double v = eval(probe);
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
    return h;
}

bool LcTareStore::recompute_locked(LcTare& t, const Evaluator& eval) {
    if (!eval)
        return false;
    const double kg = eval(t.adc_at_tare);
    if (!std::isfinite(kg))
        return false;
    t.offset_kg = kg;
    t.curve_fp = fingerprint(eval);
    return true;
}

bool LcTareStore::set(uint16_t uid, const std::string& entity, double adc_at_tare,
                      const Evaluator& eval) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!std::isfinite(adc_at_tare))
        return false;

    LcTare t;
    t.uid = uid;
    t.entity = entity;
    t.adc_at_tare = adc_at_tare;
    t.set_at_ms = unix_now_ms();
    if (!recompute_locked(t, eval)) {
        // Nothing is recorded. A tare whose offset cannot be evaluated is worse than no tare:
        // Node would subtract it from every sample on the channel.
        std::cout << "[LcTare] uid " << static_cast<int>(uid)
                  << ": curve yields no finite offset at adc " << adc_at_tare
                  << " — tare not recorded" << std::endl;
        return false;
    }
    tares_[uid] = t;
    return true;
}

void LcTareStore::clear(uint16_t uid) {
    std::lock_guard<std::mutex> lock(mutex_);
    tares_.erase(uid);
}

void LcTareStore::clear_all() {
    std::lock_guard<std::mutex> lock(mutex_);
    tares_.clear();
}

void LcTareStore::recompute(uint16_t uid, const Evaluator& eval) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!curves_trusted_)
        return;
    auto it = tares_.find(uid);
    if (it == tares_.end())
        return;
    LcTare probe = it->second;
    if (recompute_locked(probe, eval))
        it->second = probe;
    // else: keep the last good offset. Writing through a curve that evaluates to NaN would
    // replace a usable number with one that kills the series downstream.
}

void LcTareStore::recompute_all(const std::function<Evaluator(uint16_t)>& eval_for) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!curves_trusted_)
        return;
    if (!eval_for)
        return;
    for (auto& [uid, t] : tares_) {
        LcTare probe = t;
        if (recompute_locked(probe, eval_for(uid)))
            t = probe;
    }
}

size_t LcTareStore::recompute_stale(const std::function<Evaluator(uint16_t)>& eval_for) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!curves_trusted_ || !eval_for)
        return 0;
    size_t stale = 0;
    for (auto& [uid, t] : tares_) {
        const Evaluator eval = eval_for(uid);
        if (fingerprint(eval) == t.curve_fp)
            continue;
        ++stale;
        LcTare probe = t;
        if (recompute_locked(probe, eval))
            t = probe;
    }
    return stale;
}

void LcTareStore::set_curves_trusted(bool trusted) {
    std::lock_guard<std::mutex> lock(mutex_);
    curves_trusted_ = trusted;
}

bool LcTareStore::curves_trusted() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return curves_trusted_;
}

const LcTare* LcTareStore::tare_for(uint16_t uid) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = tares_.find(uid);
    return it == tares_.end() ? nullptr : &it->second;
}

std::vector<uint16_t> LcTareStore::uids() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<uint16_t> out;
    out.reserve(tares_.size());
    for (const auto& [uid, t] : tares_)
        out.push_back(uid);
    return out;
}

size_t LcTareStore::size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return tares_.size();
}

bool LcTareStore::load_failed() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return load_failed_;
}

std::string LcTareStore::serialize() const {
    nlohmann::json root;
    root["version"] = 1;
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& [uid, t] : tares_) {
        nlohmann::json tj;
        tj["uid"] = t.uid;
        tj["entity"] = t.entity;
        tj["adc_at_tare"] = t.adc_at_tare;
        tj["offset_kg"] = t.offset_kg;
        tj["set_at_ms"] = t.set_at_ms;
        tj["curve_fp"] = t.curve_fp;
        arr.push_back(tj);
    }
    root["tares"] = arr;
    return root.dump(2);
}

bool LcTareStore::save() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (load_failed_) {
        // Same rule as CubicCalibrationStore: a file we could not read is a file we must not
        // replace, because this store is empty precisely because the read failed.
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

size_t LcTareStore::load() {
    std::lock_guard<std::mutex> lock(mutex_);
    tares_.clear();

    std::ifstream f(file_path_);
    if (!f.is_open()) {
        // No file is the normal state: the backend unlinks it at session start, and every
        // session begins with every load cell reading absolute. Not a failure.
        load_failed_ = false;
        return 0;
    }
    std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());

    nlohmann::json root;
    try {
        root = nlohmann::json::parse(content);
    } catch (...) {
        load_failed_ = true;
        std::cout << "[LcTare] " << file_path_ << " could not be parsed — refusing to overwrite it"
                  << std::endl;
        return 0;
    }
    if (!root.contains("tares") || !root["tares"].is_array()) {
        load_failed_ = true;
        std::cout << "[LcTare] " << file_path_ << " has no tares array — refusing to overwrite it"
                  << std::endl;
        return 0;
    }
    load_failed_ = false;

    size_t loaded = 0;
    for (const auto& tj : root["tares"]) {
        if (!tj.is_object())
            continue;
        LcTare t;
        t.uid = static_cast<uint16_t>(tj.value("uid", 0));
        if (t.uid == 0)
            continue;
        t.entity = tj.value("entity", std::string());
        t.adc_at_tare = tj.value("adc_at_tare", 0.0);
        t.offset_kg = tj.value("offset_kg", 0.0);
        t.set_at_ms = tj.value("set_at_ms", 0.0);
        t.curve_fp = tj.value("curve_fp", static_cast<uint64_t>(0));
        if (!std::isfinite(t.adc_at_tare) || !std::isfinite(t.offset_kg))
            continue;
        tares_[t.uid] = t;
        ++loaded;
    }
    return loaded;
}

}  // namespace calibration
}  // namespace fsw
