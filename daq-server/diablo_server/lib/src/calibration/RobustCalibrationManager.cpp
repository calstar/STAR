#include "calibration/RobustCalibrationManager.hpp"

#include <Eigen/Dense>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <vector>

namespace fsw {
namespace calibration {

namespace {

double monotonic_sec_now() {
    using clock = std::chrono::steady_clock;
    static const clock::time_point t0 = clock::now();
    return std::chrono::duration<double>(clock::now() - t0).count();
}

// Read a fixed-length numeric vector from a JSON value (an array of at least n numbers).
std::optional<Eigen::VectorXd> json_vec(const nlohmann::json& j, int n) {
    if (!j.is_array() || static_cast<int>(j.size()) < n)
        return std::nullopt;
    Eigen::VectorXd v(n);
    for (int i = 0; i < n; ++i) {
        if (!j[static_cast<size_t>(i)].is_number())
            return std::nullopt;
        v(i) = j[static_cast<size_t>(i)].get<double>();
    }
    return v;
}

// Read an n×n matrix from a JSON value: nested ([[...],...]) or a flat array of n*n numbers.
std::optional<Eigen::MatrixXd> json_mat(const nlohmann::json& j, int n) {
    if (!j.is_array())
        return std::nullopt;
    if (static_cast<int>(j.size()) == n && j[0].is_array()) {
        Eigen::MatrixXd m(n, n);
        for (int r = 0; r < n; ++r) {
            if (!j[static_cast<size_t>(r)].is_array() ||
                static_cast<int>(j[static_cast<size_t>(r)].size()) < n)
                return std::nullopt;
            for (int c = 0; c < n; ++c) {
                const auto& e = j[static_cast<size_t>(r)][static_cast<size_t>(c)];
                if (!e.is_number())
                    return std::nullopt;
                m(r, c) = e.get<double>();
            }
        }
        return m;
    }
    if (static_cast<int>(j.size()) >= n * n) {  // flat fallback
        Eigen::MatrixXd m(n, n);
        for (int r = 0; r < n; ++r)
            for (int c = 0; c < n; ++c) {
                const auto& e = j[static_cast<size_t>(r * n + c)];
                if (!e.is_number())
                    return std::nullopt;
                m(r, c) = e.get<double>();
            }
        return m;
    }
    return std::nullopt;
}

// True when a JSON object key is a non-empty run of digits (a numeric sensor id).
bool is_numeric_key(const std::string& s) {
    return !s.empty() && std::all_of(s.begin(), s.end(), [](unsigned char c) {
        return std::isdigit(c) != 0;
    });
}

/** Saved θ that drifts far from the factory cubic is usually bad priors — drop them. */
double robust_prior_max_psi_mismatch() {
    const char* s = std::getenv("CAL_ROBUST_PRIOR_MAX_PSI_ERR");
    if (!s || !*s)
        return 125.0;
    char* end = nullptr;
    double v = std::strtod(s, &end);
    if (end == s || !std::isfinite(v) || v <= 0.0)
        return 125.0;
    return v;
}

/** After loading adjustments.json, θ may still match an old factory seed (e.g. Ox used PT1
 * fallback). If restored θ disagrees with the current factory cubic, re-seed so ADC→PSI tracks
 * merged JSON/CSV.
 */
void reconcile_frameworks_with_factory_baseline(std::map<uint16_t, SensorState>& states) {
    const double lim = robust_prior_max_psi_mismatch();
    for (auto& [id, st] : states) {
        if (!st.framework)
            continue;
        if (st.framework->max_abs_error_vs_factory(st.baseline) > lim) {
            std::cerr << "[RobustCalibration] Sensor " << static_cast<int>(id)
                      << ": loaded θ vs current factory cubic mismatch > " << lim
                      << " PSI (ADC grid) — re-seeding robust from factory baseline.\n";
            st.framework->seed_from_factory_cubic(st.baseline);
        }
    }
}

}  // namespace

SensorState::SensorState() = default;

RobustCalibrationManager::RobustCalibrationManager() = default;

void RobustCalibrationManager::initialize_sensor(uint16_t sensor_id,
                                                 const PTCalibrationCoeffs& baseline) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& state = states_[sensor_id];
    state.baseline = baseline;
    state.framework = std::make_unique<RobustCalibrationFramework>(static_cast<int>(sensor_id));
    state.framework->seed_from_factory_cubic(baseline);

    const double prior_limit = robust_prior_max_psi_mismatch();

    // If priors were loaded before (or after) framework creation, apply the most specific ones.
    if (restored_theta_mean_.count(sensor_id) && restored_theta_cov_.count(sensor_id)) {
        state.framework->set_theta_mean_for_restore(restored_theta_mean_[sensor_id]);
        state.framework->set_theta_cov_for_restore(restored_theta_cov_[sensor_id]);
        state.framework->set_rls_P_for_restore(restored_theta_cov_[sensor_id]);
        if (state.framework->max_abs_error_vs_factory(baseline) > prior_limit) {
            std::cerr << "[RobustCalibration] Discarding adjustments prior for sensor "
                      << static_cast<int>(sensor_id) << ": max |robust-factory| > " << prior_limit
                      << " PSI on ADC grid — re-seeding from factory cubic.\n";
            state.framework->seed_from_factory_cubic(baseline);
        }
    } else if (restored_theta_mean_.count(sensor_id)) {
        state.framework->set_theta_mean_for_restore(restored_theta_mean_[sensor_id]);
        if (state.framework->max_abs_error_vs_factory(baseline) > prior_limit) {
            std::cerr << "[RobustCalibration] Discarding adjustments mean-only prior for sensor "
                      << static_cast<int>(sensor_id) << " — re-seeding from factory cubic.\n";
            state.framework->seed_from_factory_cubic(baseline);
        }
    } else if (population_theta_mean_ && population_theta_cov_) {
        state.framework->set_theta_mean_for_restore(*population_theta_mean_);
        state.framework->set_theta_cov_for_restore(*population_theta_cov_);
        state.framework->set_rls_P_for_restore(*population_theta_cov_);
        if (state.framework->max_abs_error_vs_factory(baseline) > prior_limit) {
            std::cerr << "[RobustCalibration] Discarding population prior for sensor "
                      << static_cast<int>(sensor_id) << " — re-seeding from factory cubic.\n";
            state.framework->seed_from_factory_cubic(baseline);
        }
    }
}

void RobustCalibrationManager::update_calibration(uint16_t sensor_id, int32_t adc_code,
                                                  double reference_pressure) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = states_.find(sensor_id);
    if (it == states_.end() || !it->second.framework)
        return;
    CalibrationPoint pt;
    pt.adc_code = static_cast<double>(adc_code);
    pt.pressure = reference_pressure;
    pt.timestamp = monotonic_sec_now();
    pt.uncertainty = 0.01;
    it->second.framework->add_calibration_point(pt);
}

void RobustCalibrationManager::zero_sensor(uint16_t sensor_id, int32_t adc_code) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = states_.find(sensor_id);
    if (it == states_.end() || !it->second.framework)
        return;
    CalibrationPoint pt;
    pt.adc_code = static_cast<double>(adc_code);
    pt.pressure = 0.0;
    pt.timestamp = monotonic_sec_now();
    pt.uncertainty = 0.01;
    it->second.framework->add_calibration_point(pt);
}

double RobustCalibrationManager::predict_pressure_psi(uint16_t sensor_id, int32_t adc_code) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = states_.find(sensor_id);
    if (it == states_.end() || !it->second.framework)
        return 0.0;
    return it->second.framework->predict_pressure_psi(static_cast<double>(adc_code));
}

bool RobustCalibrationManager::has_sensor(uint16_t sensor_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = states_.find(sensor_id);
    return it != states_.end() && it->second.framework != nullptr;
}

void RobustCalibrationManager::reset_adjustment(uint16_t sensor_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = states_.find(sensor_id);
    if (it == states_.end())
        return;
    auto& state = it->second;
    state.framework = std::make_unique<RobustCalibrationFramework>(static_cast<int>(sensor_id));
    state.framework->seed_from_factory_cubic(state.baseline);
}

void RobustCalibrationManager::reseed_sensor(uint16_t sensor_id,
                                             const PTCalibrationCoeffs& baseline) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& state = states_[sensor_id];
    state.baseline = baseline;
    state.framework = std::make_unique<RobustCalibrationFramework>(static_cast<int>(sensor_id));
    state.framework->seed_from_factory_cubic(baseline);
}

bool RobustCalibrationManager::save_adjustments(
    const std::string& path, const std::map<uint16_t, std::string>* uid_to_role) const {
    std::lock_guard<std::mutex> lock(mutex_);
    constexpr int N = RobustCalibrationFramework::N;
    nlohmann::json fw2 = nlohmann::json::object();
    for (const auto& [id, state] : states_) {
        if (!state.framework)
            continue;
        Eigen::VectorXd t = state.framework->theta_mean();
        Eigen::MatrixXd cov = state.framework->theta_cov();
        nlohmann::json mean = nlohmann::json::array();
        for (int i = 0; i < N; ++i)
            mean.push_back(t(i));
        nlohmann::json cvec = nlohmann::json::array();
        for (int r = 0; r < N; ++r) {
            nlohmann::json row = nlohmann::json::array();
            for (int c = 0; c < N; ++c)
                row.push_back(cov(r, c));
            cvec.push_back(row);
        }
        nlohmann::json entry = {{"theta_mean", mean}, {"theta_cov", cvec}};
        // Record the role so load can re-attach this state to the role's current sensor_id.
        if (uid_to_role) {
            auto rit = uid_to_role->find(id);
            if (rit != uid_to_role->end() && !rit->second.empty())
                entry["role"] = rit->second;
        }
        fw2[std::to_string(static_cast<int>(id))] = std::move(entry);
    }
    const nlohmann::json root = {{"framework_v2", fw2}};

    std::ofstream file(path);
    if (!file.is_open())
        return false;
    file << root.dump(2) << "\n";
    return file.good();
}

bool RobustCalibrationManager::load_adjustments(
    const std::string& path, const std::map<uint16_t, std::string>* uid_to_role) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ifstream file(path);
    if (!file.is_open())
        return false;
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());

    // Clear previous priors (this manager can be reused within one process).
    population_theta_mean_.reset();
    population_theta_cov_.reset();
    restored_theta_mean_.clear();
    restored_theta_cov_.clear();

    nlohmann::json root;
    try {
        root = nlohmann::json::parse(content);
    } catch (...) {
        return true;  // unparseable — treat as unknown format, leave state as-is
    }
    if (!root.is_object())
        return true;

    constexpr int N = RobustCalibrationFramework::N;

    // Inverse role -> current sensor_id, so a role-tagged entry is restored onto the connector that
    // role now occupies (calibration follows the sensor across a move).
    std::map<std::string, uint16_t> role_to_uid;
    if (uid_to_role)
        for (const auto& [uid, role] : *uid_to_role)
            if (!role.empty())
                role_to_uid.emplace(role, uid);  // roles are unique; first wins

    auto apply_restored = [&]() {
        for (auto& [id, state] : states_) {
            if (!state.framework)
                continue;
            if (restored_theta_mean_.count(id) && restored_theta_cov_.count(id)) {
                state.framework->set_theta_mean_for_restore(restored_theta_mean_[id]);
                state.framework->set_theta_cov_for_restore(restored_theta_cov_[id]);
                state.framework->set_rls_P_for_restore(restored_theta_cov_[id]);
            } else if (population_theta_mean_ && population_theta_cov_) {
                state.framework->set_theta_mean_for_restore(*population_theta_mean_);
                state.framework->set_theta_cov_for_restore(*population_theta_cov_);
                state.framework->set_rls_P_for_restore(*population_theta_cov_);
            }
        }
    };

    // Format 1: runtime save format (framework_v2: theta_mean + theta_cov per numeric id).
    if (root.contains("framework_v2") && root["framework_v2"].is_object()) {
        for (auto& [id_str, sub] : root["framework_v2"].items()) {
            if (!is_numeric_key(id_str) || !sub.is_object())
                continue;
            uint16_t id = static_cast<uint16_t>(std::stoi(id_str));
            // Re-file by role onto its current sensor_id when the role is known; else keep the
            // persisted id (legacy entries / roles no longer in config).
            if (sub.contains("role") && sub["role"].is_string()) {
                auto rit = role_to_uid.find(sub["role"].get<std::string>());
                if (rit != role_to_uid.end())
                    id = rit->second;
            }
            auto mean = sub.contains("theta_mean") ? json_vec(sub["theta_mean"], N) : std::nullopt;
            auto cov = sub.contains("theta_cov") ? json_mat(sub["theta_cov"], N) : std::nullopt;
            if (mean && cov) {
                restored_theta_mean_[id] = *mean;
                restored_theta_cov_[id] = *cov;
            }
        }
        apply_restored();
        reconcile_frameworks_with_factory_baseline(states_);
        return true;
    }

    // Format 2: older runtime save format (framework_v1: theta_mean only).
    if (root.contains("framework_v1") && root["framework_v1"].is_object()) {
        for (auto& [id_str, val] : root["framework_v1"].items()) {
            if (!is_numeric_key(id_str))
                continue;
            const uint16_t id = static_cast<uint16_t>(std::stoi(id_str));
            const nlohmann::json& arr =
                val.is_array() ? val
                               : (val.is_object() && val.contains("theta_mean") ? val["theta_mean"]
                                                                                : nlohmann::json());
            auto mean = json_vec(arr, N);
            if (mean) {
                restored_theta_mean_[id] = *mean;
                auto it = states_.find(id);
                if (it != states_.end() && it->second.framework)
                    it->second.framework->set_theta_mean_for_restore(*mean);
            }
        }
        reconcile_frameworks_with_factory_baseline(states_);
        return true;
    }

    // Format 3: Python calibration backup (population_prior + pt_states).
    if (root.contains("population_prior") && root.contains("pt_states")) {
        if (root["population_prior"].is_object()) {
            const auto& pp = root["population_prior"];
            auto pm =
                pp.contains("population_mean") ? json_vec(pp["population_mean"], N) : std::nullopt;
            auto pc = pp.contains("population_covariance")
                          ? json_mat(pp["population_covariance"], N)
                          : std::nullopt;
            if (pm && pc) {
                population_theta_mean_ = *pm;
                population_theta_cov_ = *pc;
            }
        }
        if (root["pt_states"].is_object()) {
            for (auto& [id_str, sub] : root["pt_states"].items()) {
                if (!is_numeric_key(id_str) || !sub.is_object())
                    continue;
                const uint16_t id = static_cast<uint16_t>(std::stoi(id_str));
                auto mean =
                    sub.contains("theta_mean") ? json_vec(sub["theta_mean"], N) : std::nullopt;
                auto cov = sub.contains("theta_cov") ? json_mat(sub["theta_cov"], N) : std::nullopt;
                if (mean && cov) {
                    restored_theta_mean_[id] = *mean;
                    restored_theta_cov_[id] = *cov;
                }
            }
        }
        apply_restored();
        reconcile_frameworks_with_factory_baseline(states_);
        return true;
    }

    // Unknown format: do nothing.
    return true;
}

}  // namespace calibration
}  // namespace fsw
