#include "calibration/RobustCalibrationManager.hpp"

#include <Eigen/Dense>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
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

// Find matching close bracket/brace for a given open index.
// Returns std::string::npos on mismatch.
size_t find_matching(const std::string& s, size_t open_idx, char open_ch, char close_ch) {
    int depth = 0;
    for (size_t i = open_idx; i < s.size(); ++i) {
        if (s[i] == open_ch)
            depth++;
        else if (s[i] == close_ch) {
            depth--;
            if (depth == 0)
                return i;
        }
    }
    return std::string::npos;
}

void trim_in_place(std::string& str) {
    size_t b = 0;
    while (b < str.size() && std::isspace(static_cast<unsigned char>(str[b])))
        ++b;
    size_t e = str.size();
    while (e > b && std::isspace(static_cast<unsigned char>(str[e - 1])))
        --e;
    str = str.substr(b, e - b);
}

// Extract all doubles from a JSON-ish substring (assumes only numbers/whitespace/brackets inside).
std::vector<double> extract_all_doubles(const std::string& s) {
    std::vector<double> out;
    out.reserve(128);
    size_t i = 0;
    while (i < s.size()) {
        // Skip until we see something that can start a number.
        while (i < s.size() && !(std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '-' ||
                                 s[i] == '+' || s[i] == '.')) {
            ++i;
        }
        if (i >= s.size())
            break;

        size_t start = i;
        // Scan until the number terminates.
        while (i < s.size()) {
            char c = s[i];
            if (std::isdigit(static_cast<unsigned char>(c)) || c == '-' || c == '+' || c == '.' ||
                c == 'e' || c == 'E') {
                ++i;
            } else {
                break;
            }
        }
        std::string tok = s.substr(start, i - start);
        trim_in_place(tok);
        if (!tok.empty()) {
            try {
                out.push_back(std::stod(tok));
            } catch (...) {
                // Ignore parse failures from malformed substrings.
            }
        }
    }
    return out;
}

std::optional<Eigen::VectorXd> parse_fixed_vector(const std::string& block, const std::string& key,
                                                  int expected_n) {
    const std::string k = "\"" + key + "\"";
    const size_t kp = block.find(k);
    if (kp == std::string::npos)
        return std::nullopt;
    const size_t lb = block.find('[', kp);
    if (lb == std::string::npos)
        return std::nullopt;
    const size_t rb = find_matching(block, lb, '[', ']');
    if (rb == std::string::npos)
        return std::nullopt;

    const std::string inner = block.substr(lb + 1, rb - lb - 1);
    const auto nums = extract_all_doubles(inner);
    if (static_cast<int>(nums.size()) < expected_n)
        return std::nullopt;

    Eigen::VectorXd v(expected_n);
    for (int i = 0; i < expected_n; ++i)
        v(i) = nums[static_cast<size_t>(i)];
    return v;
}

std::optional<Eigen::MatrixXd> parse_fixed_matrix(const std::string& block, const std::string& key,
                                                  int expected_n) {
    const std::string k = "\"" + key + "\"";
    const size_t kp = block.find(k);
    if (kp == std::string::npos)
        return std::nullopt;
    const size_t lb = block.find('[', kp);
    if (lb == std::string::npos)
        return std::nullopt;
    const size_t rb = find_matching(block, lb, '[', ']');
    if (rb == std::string::npos)
        return std::nullopt;

    const std::string inner = block.substr(lb, rb - lb + 1);
    const auto nums = extract_all_doubles(inner);
    const int expected = expected_n * expected_n;
    if (static_cast<int>(nums.size()) < expected)
        return std::nullopt;

    Eigen::MatrixXd m(expected_n, expected_n);
    for (int r = 0; r < expected_n; ++r) {
        for (int c = 0; c < expected_n; ++c) {
            m(r, c) = nums[static_cast<size_t>(r * expected_n + c)];
        }
    }
    return m;
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

    // If priors were loaded before (or after) framework creation, apply the most specific ones.
    if (restored_theta_mean_.count(sensor_id) && restored_theta_cov_.count(sensor_id)) {
        state.framework->set_theta_mean_for_restore(restored_theta_mean_[sensor_id]);
        state.framework->set_theta_cov_for_restore(restored_theta_cov_[sensor_id]);
        state.framework->set_rls_P_for_restore(restored_theta_cov_[sensor_id]);
    } else if (restored_theta_mean_.count(sensor_id)) {
        state.framework->set_theta_mean_for_restore(restored_theta_mean_[sensor_id]);
    } else if (population_theta_mean_ && population_theta_cov_) {
        state.framework->set_theta_mean_for_restore(*population_theta_mean_);
        state.framework->set_theta_cov_for_restore(*population_theta_cov_);
        state.framework->set_rls_P_for_restore(*population_theta_cov_);
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

bool RobustCalibrationManager::save_adjustments(const std::string& path) const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::ofstream file(path);
    if (!file.is_open())
        return false;
    file << "{\n  \"framework_v2\": {\n";
    bool first = true;
    for (const auto& [id, state] : states_) {
        if (!state.framework)
            continue;
        Eigen::VectorXd t = state.framework->theta_mean();
        Eigen::MatrixXd cov = state.framework->theta_cov();
        if (!first)
            file << ",\n";
        first = false;
        file << "    \"" << static_cast<int>(id) << "\": {\n";
        file << "      \"theta_mean\": [";
        file << std::scientific << std::setprecision(16);
        for (int i = 0; i < RobustCalibrationFramework::N; ++i) {
            if (i)
                file << ", ";
            file << t(i);
        }
        file << "],\n";
        file << "      \"theta_cov\": [\n";
        for (int r = 0; r < RobustCalibrationFramework::N; ++r) {
            file << "        [";
            for (int c = 0; c < RobustCalibrationFramework::N; ++c) {
                if (c)
                    file << ", ";
                file << cov(r, c);
            }
            file << "]";
            if (r + 1 < RobustCalibrationFramework::N)
                file << ",\n";
        }
        file << "\n      ]\n";
        file << "    }";
    }
    file << "\n  }\n}\n";
    return true;
}

bool RobustCalibrationManager::load_adjustments(const std::string& path) {
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

    // Format 1: our runtime save format (framework_v2: theta_mean + theta_cov).
    const size_t fv2 = content.find("\"framework_v2\"");
    if (fv2 != std::string::npos) {
        // Find the object body: { ... } after "framework_v2"
        const size_t obj_open = content.find('{', fv2);
        if (obj_open != std::string::npos) {
            const size_t obj_close = find_matching(content, obj_open, '{', '}');
            if (obj_close != std::string::npos) {
                const std::string obj = content.substr(obj_open, obj_close - obj_open + 1);

                size_t pos = 1;  // skip leading '{'
                while (pos < obj.size()) {
                    size_t q1 = obj.find('"', pos);
                    if (q1 == std::string::npos)
                        break;
                    size_t q2 = obj.find('"', q1 + 1);
                    if (q2 == std::string::npos)
                        break;
                    std::string id_str = obj.substr(q1 + 1, q2 - q1 - 1);
                    bool digits_only = !id_str.empty();
                    for (char ch : id_str)
                        digits_only &= std::isdigit(static_cast<unsigned char>(ch));
                    if (!digits_only) {
                        pos = q2 + 1;
                        continue;
                    }
                    uint16_t id = static_cast<uint16_t>(std::stoi(id_str));
                    size_t colon = obj.find(':', q2 + 1);
                    if (colon == std::string::npos)
                        break;
                    size_t sub_open = obj.find('{', colon + 1);
                    if (sub_open == std::string::npos)
                        break;
                    size_t sub_close = find_matching(obj, sub_open, '{', '}');
                    if (sub_close == std::string::npos)
                        break;
                    std::string sub = obj.substr(sub_open, sub_close - sub_open + 1);

                    auto mean_opt =
                        parse_fixed_vector(sub, "theta_mean", RobustCalibrationFramework::N);
                    auto cov_opt =
                        parse_fixed_matrix(sub, "theta_cov", RobustCalibrationFramework::N);
                    if (mean_opt && cov_opt) {
                        restored_theta_mean_[id] = *mean_opt;
                        restored_theta_cov_[id] = *cov_opt;
                    }
                    pos = sub_close + 1;
                }
            }
        }

        // Apply per-sensor priors to existing frameworks.
        for (auto& [id, state] : states_) {
            if (!state.framework)
                continue;
            if (restored_theta_mean_.count(id) && restored_theta_cov_.count(id)) {
                state.framework->set_theta_mean_for_restore(restored_theta_mean_[id]);
                state.framework->set_theta_cov_for_restore(restored_theta_cov_[id]);
                state.framework->set_rls_P_for_restore(restored_theta_cov_[id]);
            }
        }
        return true;
    }

    // Format 2: older runtime save format (framework_v1: theta_mean only).
    const size_t fv1 = content.find("\"framework_v1\"");
    if (fv1 != std::string::npos) {
        size_t i = fv1;
        while (i < content.size()) {
            size_t q0 = content.find('"', i);
            if (q0 == std::string::npos)
                break;
            size_t j = q0 + 1;
            while (j < content.size() && content[j] >= '0' && content[j] <= '9')
                ++j;
            if (j == q0 + 1) {
                i = q0 + 1;
                continue;
            }
            uint16_t id = static_cast<uint16_t>(std::stoi(content.substr(q0 + 1, j - q0 - 1)));
            size_t br = content.find('[', j);
            if (br == std::string::npos)
                break;
            size_t en = find_matching(content, br, '[', ']');
            if (en == std::string::npos)
                break;
            std::string inner = content.substr(br, en - br + 1);
            auto nums = extract_all_doubles(inner);
            if (static_cast<int>(nums.size()) >= RobustCalibrationFramework::N) {
                Eigen::VectorXd t(RobustCalibrationFramework::N);
                for (int k = 0; k < RobustCalibrationFramework::N; ++k)
                    t(k) = nums[static_cast<size_t>(k)];
                restored_theta_mean_[id] = t;
                auto it = states_.find(id);
                if (it != states_.end() && it->second.framework) {
                    it->second.framework->set_theta_mean_for_restore(t);
                }
            }
            i = en + 1;
        }
        return true;
    }

    // Format 3: Python calibration backup (population_prior + pt_states).
    const size_t pp = content.find("\"population_prior\"");
    const size_t pt = content.find("\"pt_states\"");
    if (pp != std::string::npos && pt != std::string::npos) {
        // Parse population_prior object.
        const size_t pp_open = content.find('{', pp);
        if (pp_open != std::string::npos) {
            const size_t pp_close = find_matching(content, pp_open, '{', '}');
            if (pp_close != std::string::npos) {
                const std::string pp_obj = content.substr(pp_open, pp_close - pp_open + 1);
                auto pm =
                    parse_fixed_vector(pp_obj, "population_mean", RobustCalibrationFramework::N);
                auto pc = parse_fixed_matrix(pp_obj, "population_covariance",
                                             RobustCalibrationFramework::N);
                if (pm && pc) {
                    population_theta_mean_ = *pm;
                    population_theta_cov_ = *pc;
                }
            }
        }

        // Parse per-PT states.
        const size_t pt_open = content.find('{', pt);
        if (pt_open != std::string::npos) {
            const size_t pt_close = find_matching(content, pt_open, '{', '}');
            if (pt_close != std::string::npos) {
                const std::string pt_obj = content.substr(pt_open, pt_close - pt_open + 1);
                size_t pos = 1;  // skip '{'
                while (pos < pt_obj.size()) {
                    size_t q1 = pt_obj.find('"', pos);
                    if (q1 == std::string::npos)
                        break;
                    size_t q2 = pt_obj.find('"', q1 + 1);
                    if (q2 == std::string::npos)
                        break;
                    std::string id_str = pt_obj.substr(q1 + 1, q2 - q1 - 1);
                    bool digits_only = !id_str.empty();
                    for (char ch : id_str)
                        digits_only &= std::isdigit(static_cast<unsigned char>(ch));
                    if (!digits_only) {
                        pos = q2 + 1;
                        continue;
                    }
                    uint16_t id = static_cast<uint16_t>(std::stoi(id_str));
                    size_t colon = pt_obj.find(':', q2 + 1);
                    if (colon == std::string::npos)
                        break;
                    size_t sub_open = pt_obj.find('{', colon + 1);
                    if (sub_open == std::string::npos)
                        break;
                    size_t sub_close = find_matching(pt_obj, sub_open, '{', '}');
                    if (sub_close == std::string::npos)
                        break;
                    std::string sub = pt_obj.substr(sub_open, sub_close - sub_open + 1);

                    auto mean_opt =
                        parse_fixed_vector(sub, "theta_mean", RobustCalibrationFramework::N);
                    auto cov_opt =
                        parse_fixed_matrix(sub, "theta_cov", RobustCalibrationFramework::N);
                    if (mean_opt && cov_opt) {
                        restored_theta_mean_[id] = *mean_opt;
                        restored_theta_cov_[id] = *cov_opt;
                    }
                    pos = sub_close + 1;
                }
            }
        }

        // Apply both per-sensor and population priors to existing frameworks.
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
        return true;
    }

    // Unknown format: do nothing.
    return true;
}

}  // namespace calibration
}  // namespace fsw
