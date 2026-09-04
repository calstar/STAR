#include "calibration/CubicCalibrationStore.hpp"

#include <Eigen/Dense>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
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
                                             const std::string& active_model) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& ch = channels_[uid];
    ch.uid = uid;
    ch.board_id = board_id;
    ch.connector = connector;
    ch.logical_ch = logical_ch;
    if (!role.empty())
        ch.role = role;
    if (!active_model.empty())
        ch.active_model = active_model;  // config truth; wins over a disk-restored value
}

CubicFit CubicCalibrationStore::compute_fit(const std::vector<CubicPoint>& pts) const {
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

    int degree = std::min(3, n - 1);
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
    auto& ch = channels_[uid];
    if (ch.uid == 0) {
        // Never registered (e.g. capture arrived before config wiring) — derive identity from uid.
        ch.uid = uid;
        ch.board_id = static_cast<uint8_t>(uid / 100);
        ch.connector = static_cast<uint8_t>(uid % 100);
        ch.logical_ch =
            pt_logical_calibration_channel(slot_from_board_id(ch.board_id), ch.connector);
    }

    CubicPoint pt;
    pt.adc = adc;
    pt.psi = psi;
    pt.t = unix_now_sec();
    ch.points.push_back(pt);
    if (ch.points.size() > kMaxPoints)
        ch.points.erase(ch.points.begin(), ch.points.begin() + static_cast<std::ptrdiff_t>(
                                                                   ch.points.size() - kMaxPoints));

    ch.updated_at = pt.t;

    if (ch.active_model == "robust") {
        // Robust: the point is display-only; the RLS learner is updated by the service. Leave the
        // cubic fit invalid so this uid is excluded from the logical polynomial maps and no cubic
        // is applied. Status tracks point count.
        ch.fit = CubicFit{};
        ch.status = ch.points.size() < 2 ? "PENDING" : "OK";
        ch.last_error.clear();
        return ch.fit;
    }

    ch.fit = compute_fit(ch.points);
    if (!ch.fit.valid) {
        ch.status = "ERROR";
        ch.last_error = "fit produced non-finite coefficients";
    } else if (ch.points.size() < 2) {
        ch.status = "PENDING";
        ch.last_error.clear();
    } else {
        ch.status = "OK";
        ch.last_error.clear();
    }
    return ch.fit;
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
    json state = json::object();

    for (const auto& [uid, ch] : channels_) {
        // Logical-channel-keyed maps: consumed by PTCalibrationManager / loadCalibrationJSON.
        if (ch.fit.valid) {
            const std::string lkey = std::to_string(static_cast<int>(ch.logical_ch));
            polys[lkey] = {ch.fit.A, ch.fit.B, ch.fit.C, ch.fit.D};
            poly_coeffs[lkey] = ch.fit.poly;
            norm_min[lkey] = ch.fit.norm_min;
            norm_scale[lkey] = ch.fit.norm_scale;
        }

        // uid-keyed rich state for the UI (points + per-channel fit + identity).
        json cj;
        cj["boardId"] = static_cast<int>(ch.board_id);
        cj["connector"] = static_cast<int>(ch.connector);
        cj["logicalCh"] = static_cast<int>(ch.logical_ch);
        cj["role"] = ch.role;
        cj["active_model"] = ch.active_model;
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
    root["cubic_state"] = state;
    return root.dump(2);
}

bool CubicCalibrationStore::save() const {
    std::lock_guard<std::mutex> lock(mutex_);
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
        return 0;  // corrupt/partial file — start clean rather than crash
    }
    if (!root.contains("cubic_state") || !root["cubic_state"].is_object())
        return 0;

    size_t loaded = 0;
    for (auto& [id_str, cj] : root["cubic_state"].items()) {
        uint16_t uid = 0;
        try {
            uid = static_cast<uint16_t>(std::stoi(id_str));
        } catch (...) {
            continue;
        }

        // Merge into the channel register_channel() already created at startup: config is the
        // source of truth for identity/role/active_model, so don't clobber them with disk values.
        auto& ch = channels_[uid];
        const bool registered = ch.uid != 0;
        ch.uid = uid;
        ch.board_id = static_cast<uint8_t>(uid / 100);
        ch.connector = static_cast<uint8_t>(uid % 100);
        ch.logical_ch =
            pt_logical_calibration_channel(slot_from_board_id(ch.board_id), ch.connector);
        if (!registered) {
            ch.role = cj.value("role", std::string());
            ch.active_model = cj.value("active_model", std::string("cubic"));
        } else if (ch.role.empty()) {
            ch.role = cj.value("role", std::string());
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

        if (ch.active_model == "robust") {
            // Display-only points; no cubic fit. The service re-samples fit_curve after restoring
            // the robust model from adjustments.json.
            ch.fit = CubicFit{};
            ch.status = ch.points.size() < 2 ? "PENDING" : "OK";
        } else {
            ch.fit = compute_fit(ch.points);
            ch.status = !ch.fit.valid ? (ch.points.empty() ? "PENDING" : "ERROR")
                                      : (ch.points.size() < 2 ? "PENDING" : "OK");
        }
        ch.updated_at = unix_now_sec();
        ++loaded;
    }
    return loaded;
}

}  // namespace calibration
}  // namespace fsw
