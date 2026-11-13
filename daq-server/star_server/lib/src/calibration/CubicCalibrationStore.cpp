#include "calibration/CubicCalibrationStore.hpp"

#include <Eigen/Dense>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

#include "calibration/PTCalibration.hpp"  // pt_logical_calibration_channel

namespace fsw {
namespace calibration {

namespace {

double unix_now_sec() {
    return std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

/** slot = board_id % 10 with 0 -> 10 (same rule as calibration_service / daq_bridge). */
uint8_t slot_from_board_id(uint8_t board_id) {
    int m = static_cast<int>(board_id) % 10;
    return static_cast<uint8_t>(m == 0 ? 10 : m);
}

}  // namespace

CubicCalibrationStore::CubicCalibrationStore(std::string file_path)
    : file_path_(std::move(file_path)) {
}

void CubicCalibrationStore::register_channel(uint16_t uid, uint8_t board_id, uint8_t connector,
                                             uint8_t logical_ch, const std::string& role,
                                             const std::string& active_model, SensorKind kind,
                                             const std::string& raw_unit) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& ch = channels_[uid];
    ch.uid = uid;
    ch.live = true;  // the running config owns this uid: its logical_ch is a live sensor's
    ch.board_id = board_id;
    ch.connector = connector;
    ch.logical_ch = logical_ch;
    if (!role.empty())
        ch.role = role;
    const std::string was = ch.active_model;
    if (!active_model.empty())
        ch.active_model = active_model;  // config truth; wins over a disk-restored value
    ch.kind = kind;                      // config truth, likewise
    ch.raw_unit = raw_unit;              // config truth: which hardware this uid reads through
    // A config edit that moves a sensor between cubic and linear (a profile swap, a reload) must
    // re-derive the curve it streams from the points it already has; otherwise the old degree's
    // fit keeps streaming under the new model's name until the next capture.
    if (ch.active_model != was && !ch.points.empty())
        refit(ch);
}

void CubicCalibrationStore::refit(CubicChannel& ch) {
    if (ch.active_model == "robust") {
        // Display-only points; the robust learner lives in the service.
        ch.fit = CubicFit{};
        ch.fit_cubic = CubicFit{};
        ch.fit_linear = CubicFit{};
        ch.status = ch.points.size() < 2 ? "PENDING" : "OK";
        ch.last_error.clear();
        return;
    }
    ch.fit_cubic = compute_fit(ch.points, 3);
    ch.fit_linear = ch.points.size() >= 2 ? compute_fit(ch.points, 1) : CubicFit{};
    const bool linear = ch.active_model == "linear";
    ch.fit = linear ? ch.fit_linear : ch.fit_cubic;
    if (ch.points.empty() || (linear && ch.points.size() < 2)) {
        ch.status = "PENDING";
        ch.last_error.clear();
    } else if (!ch.fit.valid) {
        ch.status = "ERROR";
        ch.last_error = "fit produced non-finite coefficients";
    } else if (ch.points.size() < 2) {
        ch.status = "PENDING";
        ch.last_error.clear();
    } else {
        ch.status = "OK";
        ch.last_error.clear();
    }
}

CubicFit CubicCalibrationStore::compute_fit(const std::vector<CubicPoint>& pts, int max_degree) {
    CubicFit f;
    const int n = static_cast<int>(pts.size());
    if (n < 1)
        return f;

    double amin = pts[0].adc, amax = pts[0].adc, amean = 0.0;
    for (const auto& p : pts) {
        amin = std::min(amin, p.adc);
        amax = std::max(amax, p.adc);
        amean += p.adc;
    }
    amean /= static_cast<double>(n);
    double scale = amax - amin;
    if (!(scale > 0.0) || !std::isfinite(scale))
        scale = 1.0;
    f.norm_min = amean;
    f.norm_scale = scale;

    int degree = std::min(std::clamp(max_degree, 0, 3), n - 1);
    if (degree < 0)
        degree = 0;

    Eigen::MatrixXd V(n, degree + 1);
    Eigen::VectorXd y(n);
    for (int i = 0; i < n; ++i) {
        double xn = (pts[static_cast<size_t>(i)].adc - f.norm_min) / f.norm_scale;
        double xp = 1.0;
        for (int j = 0; j <= degree; ++j) {
            V(i, j) = xp;
            xp *= xn;
        }
        y(i) = pts[static_cast<size_t>(i)].psi;
    }

    Eigen::VectorXd p = V.colPivHouseholderQr().solve(y);
    Eigen::VectorXd resid = V * p - y;
    f.rmse = std::sqrt(resid.squaredNorm() / static_cast<double>(n));
    f.degree = degree;
    f.poly.assign(static_cast<size_t>(degree + 1), 0.0);
    for (int j = 0; j <= degree; ++j)
        f.poly[static_cast<size_t>(j)] = p(j);

    // Expand normalized poly p((adc - m)/s) into raw powers of adc: with a = 1/s, b = -m/s,
    // u = a*adc + b, so [A,B,C,D] follow from the binomial expansion of p0 + p1 u + p2 u^2 + p3
    // u^3.
    double pp[4] = {0.0, 0.0, 0.0, 0.0};
    for (int j = 0; j <= degree && j < 4; ++j)
        pp[j] = p(j);
    const double a = 1.0 / f.norm_scale;
    const double b = -f.norm_min / f.norm_scale;
    f.A = pp[3] * a * a * a;
    f.B = pp[2] * a * a + pp[3] * 3.0 * a * a * b;
    f.C = pp[1] * a + pp[2] * 2.0 * a * b + pp[3] * 3.0 * a * b * b;
    f.D = pp[0] + pp[1] * b + pp[2] * b * b + pp[3] * b * b * b;

    f.valid = std::isfinite(f.A) && std::isfinite(f.B) && std::isfinite(f.C) && std::isfinite(f.D);
    for (double c : f.poly)
        if (!std::isfinite(c))
            f.valid = false;
    return f;
}

CubicFit CubicCalibrationStore::add_point(uint16_t uid, double adc, double psi) {
    std::lock_guard<std::mutex> lock(mutex_);
    // Refuse an unknown uid rather than inventing a channel for it. register_channel() runs at
    // startup for every configured connector, so a uid that is not here did not come from the
    // config — and `channels_[uid]` would have silently created one, guessing PT identity from
    // the number and filing a load cell's point on a PT's logical channel.
    auto cit = channels_.find(uid);
    if (cit == channels_.end()) {
        static bool warned = false;
        if (!warned) {
            warned = true;
            std::cout << "[CubicStore] refusing capture for unregistered uid " << uid
                      << " (not in config); further such warnings suppressed" << std::endl;
        }
        return CubicFit{};
    }
    auto& ch = cit->second;

    CubicPoint pt;
    pt.adc = adc;
    pt.psi = psi;
    pt.t = unix_now_sec();
    ch.points.push_back(pt);
    if (ch.points.size() > kMaxPoints)
        ch.points.erase(ch.points.begin(), ch.points.begin() + static_cast<std::ptrdiff_t>(
                                                                   ch.points.size() - kMaxPoints));

    ch.updated_at = pt.t;

    // Robust: the point is display-only; the RLS learner is updated by the service, and refit
    // leaves the fit invalid so this uid is excluded from the logical polynomial maps.
    refit(ch);
    return ch.fit;
}

void CubicCalibrationStore::note_capture(uint16_t uid, const CaptureQuality& q) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = channels_.find(uid);
    if (it != channels_.end())
        it->second.last_capture = q;
}

void CubicCalibrationStore::set_fit_curve(uint16_t uid,
                                          const std::vector<std::pair<double, double>>& curve) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = channels_.find(uid);
    if (it != channels_.end())
        it->second.fit_curve = curve;
}

void CubicCalibrationStore::clear_channel(uint16_t uid) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = channels_.find(uid);
    if (it == channels_.end())
        return;
    it->second.points.clear();
    it->second.fit = CubicFit{};
    it->second.fit_cubic = CubicFit{};
    it->second.fit_linear = CubicFit{};
    it->second.fit_curve.clear();
    it->second.status = "PENDING";
    it->second.last_error.clear();
    it->second.updated_at = unix_now_sec();
}

const CubicFit* CubicCalibrationStore::fit_for(uint16_t uid) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = channels_.find(uid);
    if (it == channels_.end() || !it->second.fit.valid)
        return nullptr;
    return &it->second.fit;
}

const CubicChannel* CubicCalibrationStore::channel(uint16_t uid) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = channels_.find(uid);
    return it == channels_.end() ? nullptr : &it->second;
}

std::vector<uint16_t> CubicCalibrationStore::uids() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<uint16_t> out;
    out.reserve(channels_.size());
    for (const auto& [uid, ch] : channels_)
        out.push_back(uid);
    return out;
}

std::string CubicCalibrationStore::serialize() const {
    using nlohmann::json;
    json root;
    root["sensor_type"] = "PT";
    root["unit"] = "PSI";
    root["framework"] = "cubic";
    root["generated_unix"] = unix_now_sec();

    json polys = json::object();
    json poly_coeffs = json::object();
    json norm_min = json::object();
    json norm_scale = json::object();
    json lc_polys = json::object();
    json lc_poly_coeffs = json::object();
    json lc_norm_min = json::object();
    json lc_norm_scale = json::object();
    json state = json::object();

    // Logical-channel-keyed maps: consumed by PTCalibrationManager / loadCalibrationJSON (and the
    // Node backend's own loadCalibrationJSON, which keys its CalibrationMap the same way).
    //
    // Split by kind — a PT and a load cell on the same slot share a logical channel, and writing
    // both into one map let the higher uid overwrite the other (see SensorKind).
    //
    // And written LIVE FIRST, because the same collision exists inside a single kind, where the
    // kind split cannot help: an orphan's logical channel is whatever live board now owns that
    // slot, so a removed PT board's still-valid curve would overwrite the live PT that inherited
    // the channel, in uid order, in the file that is the only record of either. A live channel
    // therefore always wins its own logical channel; an orphan fills only a channel no live
    // sensor claims, which keeps a blind reload (nothing registered, e.g. a reader that does not
    // know the config) from emptying the overlay. Every entry's points are in cubic_state below
    // regardless, so nothing is lost either way.
    auto put_fit = [&](const CubicChannel& ch, bool only_if_absent) {
        if (!ch.fit.valid)
            return;
        const std::string lkey = std::to_string(static_cast<int>(ch.logical_ch));
        const bool is_lc = ch.kind == SensorKind::LC;
        if (only_if_absent && (is_lc ? lc_polys : polys).contains(lkey))
            return;
        (is_lc ? lc_polys : polys)[lkey] = {ch.fit.A, ch.fit.B, ch.fit.C, ch.fit.D};
        (is_lc ? lc_poly_coeffs : poly_coeffs)[lkey] = ch.fit.poly;
        (is_lc ? lc_norm_min : norm_min)[lkey] = ch.fit.norm_min;
        (is_lc ? lc_norm_scale : norm_scale)[lkey] = ch.fit.norm_scale;
    };
    for (const auto& [uid, ch] : channels_)
        if (ch.live)
            put_fit(ch, /*only_if_absent=*/false);
    for (const auto& [uid, ch] : channels_)
        if (!ch.live)
            put_fit(ch, /*only_if_absent=*/true);

    for (const auto& [uid, ch] : channels_) {
        // uid-keyed rich state for the UI (points + per-channel fit + identity).
        json cj;
        cj["boardId"] = static_cast<int>(ch.board_id);
        cj["connector"] = static_cast<int>(ch.connector);
        cj["logicalCh"] = static_cast<int>(ch.logical_ch);
        cj["role"] = ch.role;
        cj["active_model"] = ch.active_model;
        cj["kind"] = ch.kind == SensorKind::LC ? "LC" : "PT";
        cj["rawUnit"] = ch.raw_unit;
        cj["numPoints"] = ch.points.size();
        cj["status"] = ch.status;
        cj["last_error"] = ch.last_error;
        cj["rmse"] = ch.fit.valid ? ch.fit.rmse : 0.0;
        cj["degree"] = ch.fit.degree;
        cj["updatedAt"] = ch.updated_at;
        cj["coeffs"] = {{"A", ch.fit.A}, {"B", ch.fit.B}, {"C", ch.fit.C}, {"D", ch.fit.D}};
        cj["polyCoeffs"] = ch.fit.poly;
        cj["adcNormMin"] = ch.fit.norm_min;
        cj["adcNormScale"] = ch.fit.norm_scale;
        // Both candidate fits over the same points, for the calibration page's curve previews.
        // `polyCoeffs` above stays the ACTIVE fit, so every existing reader is unchanged.
        auto fit_json = [](const CubicFit& f) {
            return json{{"valid", f.valid},
                        {"degree", f.degree},
                        {"rmse", f.valid ? f.rmse : 0.0},
                        {"polyCoeffs", f.poly},
                        {"adcNormMin", f.norm_min},
                        {"adcNormScale", f.norm_scale}};
        };
        cj["fits"] = {{"cubic", fit_json(ch.fit_cubic)}, {"linear", fit_json(ch.fit_linear)}};
        if (ch.last_capture.valid) {
            cj["last_capture"] = {{"t", ch.last_capture.t},
                                  {"adc", ch.last_capture.adc},
                                  {"n", ch.last_capture.n},
                                  {"windowMs", ch.last_capture.window_ms},
                                  {"spreadAdc", ch.last_capture.spread},
                                  {"driftAdc", ch.last_capture.drift},
                                  {"driftZ", ch.last_capture.drift_z},
                                  {"settled", ch.last_capture.settled}};
        }
        json pts = json::array();
        for (const auto& p : ch.points)
            pts.push_back({{"adc", p.adc}, {"psi", p.psi}, {"t", p.t}});
        cj["points"] = pts;
        // Robust display overlay: sampled model curve (absent/empty for cubic uids).
        if (!ch.fit_curve.empty()) {
            json fc = json::array();
            for (const auto& [adc, psi] : ch.fit_curve)
                fc.push_back({{"adc", adc}, {"psi", psi}});
            cj["fitCurve"] = fc;
        }
        state[std::to_string(static_cast<int>(uid))] = cj;
    }

    root["calibration_polynomials"] = polys;
    root["calibration_poly_coeffs"] = poly_coeffs;
    root["calibration_adc_norm_min"] = norm_min;
    root["calibration_adc_norm_scale"] = norm_scale;
    root["lc_calibration_polynomials"] = lc_polys;
    root["lc_calibration_poly_coeffs"] = lc_poly_coeffs;
    root["lc_calibration_adc_norm_min"] = lc_norm_min;
    root["lc_calibration_adc_norm_scale"] = lc_norm_scale;
    root["cubic_state"] = state;
    return root.dump(2);
}

bool CubicCalibrationStore::save() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (load_failed_) {
        // A file we could not read is a file we must not replace: it is the only copy of the
        // operator's captured points, and this store is empty precisely because the read failed.
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

size_t CubicCalibrationStore::load() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ifstream f(file_path_);
    if (!f.is_open())
        return 0;
    std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());

    nlohmann::json root;
    try {
        root = nlohmann::json::parse(content);
    } catch (...) {
        // Corrupt/partial file — start clean rather than crash, but REMEMBER it. The service
        // saves at startup, and a caller that cannot tell "unreadable" from "no file yet"
        // would overwrite an operator's points with an empty store on the next write.
        load_failed_ = true;
        std::cout << "[CubicStore] " << file_path_
                  << " could not be parsed — refusing to overwrite it" << std::endl;
        return 0;
    }
    if (!root.contains("cubic_state") || !root["cubic_state"].is_object()) {
        load_failed_ = true;
        std::cout << "[CubicStore] " << file_path_
                  << " has no cubic_state — refusing to overwrite it" << std::endl;
        return 0;
    }
    load_failed_ = false;

    // role -> current uid, from the channels register_channel() created before this load. Durable
    // cal is filed by role, so an entry re-attaches to the connector its role now occupies — the
    // calibration follows the sensor when its cable moves to a different board port.
    std::map<std::string, uint16_t> role_to_uid;
    for (const auto& [uid, ch] : channels_)
        if (!ch.role.empty())
            role_to_uid.emplace(ch.role, uid);

    size_t loaded = 0;
    for (auto& [id_str, cj] : root["cubic_state"].items()) {
        uint16_t persisted_uid = 0;
        try {
            persisted_uid = static_cast<uint16_t>(std::stoi(id_str));
        } catch (...) {
            continue;
        }

        // The entry's durable identity is its role. Legacy entries (written before roles were
        // tracked) adopt the role of the channel currently at their persisted uid — a one-time
        // migration, after which they too follow moves.
        std::string entry_role = cj.value("role", std::string());
        if (entry_role.empty()) {
            auto pit = channels_.find(persisted_uid);
            if (pit != channels_.end())
                entry_role = pit->second.role;
        }

        // Destination = where that role lives now (config truth); else the persisted uid.
        // A legacy entry has no rawUnit: everything written before T7 support was an ADC code.
        const std::string entry_unit = cj.value("rawUnit", std::string(kRawUnitAdc));
        uint16_t uid = persisted_uid;
        if (!entry_role.empty()) {
            auto rit = role_to_uid.find(entry_role);
            if (rit != role_to_uid.end()) {
                if (channels_[rit->second].raw_unit == entry_unit) {
                    uid = rit->second;
                } else {
                    std::cout << "[CubicStore] role '" << entry_role << "' cal was taken in "
                              << entry_unit << " but the channel it now names reads "
                              << channels_[rit->second].raw_unit
                              << " — NOT attached; recalibrate it. The old points are kept under "
                                 "uid "
                              << persisted_uid << "." << std::endl;
                }
            }
        }
        // Even at its own uid, never merge across units (a board changed type, keeping its id).
        {
            auto dit = channels_.find(uid);
            if (dit != channels_.end() && dit->second.uid != 0 &&
                dit->second.raw_unit != entry_unit) {
                std::cout << "[CubicStore] uid " << uid << " cal was taken in " << entry_unit
                          << " but uid " << uid << " now reads " << dit->second.raw_unit
                          << " — dropped; recalibrate it." << std::endl;
                continue;
            }
        }

        // Merge into the channel register_channel() created at startup (config is the source of
        // truth for its identity/role/active_model); only synthesize identity when no current board
        // owns the destination uid (an orphaned role no longer in config).
        auto& ch = channels_[uid];
        const bool registered = ch.uid != 0;
        if (!registered) {
            ch.uid = uid;
            ch.board_id = static_cast<uint8_t>(uid / 100);
            ch.connector = static_cast<uint8_t>(uid % 100);
            // An orphan keeps the logical channel it was saved with when it has one: a T7
            // channel's lives above the ESP32 range, and re-deriving it the ESP32 way would land
            // its fit on a live ESP32 sensor's logical channel.
            ch.logical_ch =
                entry_unit == kRawUnitMicrovolts && cj.contains("logicalCh") &&
                        cj["logicalCh"].is_number_integer()
                    ? static_cast<uint8_t>(cj["logicalCh"].get<int>())
                    : pt_logical_calibration_channel(slot_from_board_id(ch.board_id), ch.connector);
            ch.raw_unit = entry_unit;
            ch.role = entry_role;
            ch.active_model = cj.value("active_model", std::string("cubic"));
            // Only an ORPHAN takes its kind from the file; a channel the config registered
            // keeps config's, exactly as active_model does. A legacy file has no "kind", and
            // defaulting an orphan to PT preserves what those maps have always meant.
            ch.kind = cj.value("kind", std::string("PT")) == "LC" ? SensorKind::LC : SensorKind::PT;
        }

        ch.points.clear();
        if (cj.contains("points") && cj["points"].is_array()) {
            for (const auto& pj : cj["points"]) {
                CubicPoint p;
                p.adc = pj.value("adc", 0.0);
                p.psi = pj.value("psi", 0.0);
                p.t = pj.value("t", 0.0);
                ch.points.push_back(p);
            }
        }
        if (ch.points.size() > kMaxPoints)
            ch.points.erase(ch.points.begin(),
                            ch.points.begin() +
                                static_cast<std::ptrdiff_t>(ch.points.size() - kMaxPoints));

        ch.fit_curve.clear();
        if (cj.contains("fitCurve") && cj["fitCurve"].is_array())
            for (const auto& pj : cj["fitCurve"])
                ch.fit_curve.emplace_back(pj.value("adc", 0.0), pj.value("psi", 0.0));

        // Robust: display-only points, no fit; the service re-samples fit_curve after restoring
        // the robust model from adjustments.json.
        refit(ch);
        ch.updated_at = unix_now_sec();
        if (uid != persisted_uid)
            std::cout << "[CubicStore] role '" << entry_role << "' cal re-attached to connector "
                      << static_cast<int>(uid % 100) << " (was "
                      << static_cast<int>(persisted_uid % 100) << ") — sensor moved" << std::endl;
        ++loaded;
    }
    return loaded;
}

}  // namespace calibration
}  // namespace fsw
