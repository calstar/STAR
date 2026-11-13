#include "calibration/PTCalibration.hpp"

#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <regex>
#include <sstream>

#if __cplusplus >= 201703L
#include <filesystem>
namespace fs = std::filesystem;
#else
// Fallback for older C++ standards
#include <dirent.h>
#include <sys/stat.h>
namespace fs {
inline bool exists(const std::string& path) {
    struct stat buffer;
    return (stat(path.c_str(), &buffer) == 0);
}
inline bool is_directory(const std::string& path) {
    struct stat buffer;
    if (stat(path.c_str(), &buffer) != 0)
        return false;
    return S_ISDIR(buffer.st_mode);
}
struct path {
    std::string p;
    path(const std::string& s) : p(s) {
    }
    std::string string() const {
        return p;
    }
    std::string extension() const {
        size_t pos = p.find_last_of('.');
        return (pos != std::string::npos) ? p.substr(pos) : "";
    }
};
struct directory_iterator {
    DIR* dir;
    struct dirent* entry;
    directory_iterator(const std::string& dir_path) {
        dir = opendir(dir_path.c_str());
        entry = nullptr;
    }
    ~directory_iterator() {
        if (dir)
            closedir(dir);
    }
    bool has_next() {
        if (!dir)
            return false;
        entry = readdir(dir);
        return entry != nullptr;
    }
    fs::path path() const {
        return entry ? std::string(entry->d_name) : "";
    }
    bool is_regular_file() const {
        if (!entry)
            return false;
        struct stat buffer;
        std::string full_path = std::string(dir->d_name) + "/" + entry->d_name;
        if (stat(full_path.c_str(), &buffer) != 0)
            return false;
        return S_ISREG(buffer.st_mode);
    }
};
}  // namespace fs
#endif

namespace fsw {
namespace calibration {

// Static member initialization
std::string PTCalibrationManager::default_json_dir_ = "scripts/calibration/calibrations";
std::string PTCalibrationManager::default_csv_path_ =
    "external/DiabloAvionics/PT_Board/Calibration/PT Calibration Attempt 2026-02-04_test2.csv";

PTCalibrationManager::PTCalibrationManager(bool auto_load) {
    // Auto-load calibration on construction unless the caller opts out (physics-or-nothing).
    if (auto_load)
        load_calibration();
}

bool PTCalibrationManager::load_calibration() {
    calibrations_.clear();

    // Default: load Diablo factory CSV first (stable), then GUI JSON exports. Override with
    // CAL_PT_JSON_FIRST=1 to prefer the newest JSON in scripts/calibration/calibrations/.
    const char* jf = std::getenv("CAL_PT_JSON_FIRST");
    const bool json_first =
        jf && (jf[0] == '1' || jf[0] == 'y' || jf[0] == 'Y' || jf[0] == 't' || jf[0] == 'T');

    auto try_csv = [this]() -> bool {
        if (!default_csv_path_.empty() && fs::exists(default_csv_path_)) {
            if (load_from_csv(default_csv_path_)) {
                std::cout << "[PTCalibration] Loaded " << calibrations_.size()
                          << " calibrations from CSV (factory): " << default_csv_path_ << std::endl;
                return true;
            }
        }
        return false;
    };

    auto try_json = [this]() -> bool {
        if (!default_json_dir_.empty() && fs::exists(default_json_dir_)) {
            std::string json_file = find_latest_json_file(default_json_dir_);
            if (!json_file.empty() && load_from_json(json_file, false)) {
                std::cout << "[PTCalibration] Loaded " << calibrations_.size()
                          << " calibrations from JSON: " << json_file << std::endl;
                return true;
            }
        }
        return false;
    };

    if (json_first) {
        if (try_json())
            return true;
        if (try_csv())
            return true;
    } else {
        // CSV column labels (PT1, PT6, …) are bench IDs — they may not match vehicle logical
        // connectors (e.g. "PT6" in CSV ≠ GN2 Reg on connector 6). Newest GUI JSON is keyed by
        // logical channel; overlay it on CSV so ch 5/6/7 etc. get the right cubics.
        try_csv();
        const char* missing_only_env = std::getenv("CAL_PT_JSON_MISSING_ONLY");
        const bool json_missing_only =
            missing_only_env && (missing_only_env[0] == '1' || missing_only_env[0] == 'y' ||
                                 missing_only_env[0] == 'Y' || missing_only_env[0] == 't' ||
                                 missing_only_env[0] == 'T');
        if (!default_json_dir_.empty() && fs::exists(default_json_dir_)) {
            std::string json_file = find_latest_json_file(default_json_dir_);
            if (!json_file.empty() && load_from_json(json_file, json_missing_only)) {
                if (json_missing_only) {
                    std::cout << "[PTCalibration] Merged missing channels from JSON only: "
                              << json_file << " (total " << calibrations_.size()
                              << " logical channels)" << std::endl;
                } else {
                    std::cout << "[PTCalibration] Overlaid GUI JSON on CSV: " << json_file
                              << " (logical channels present in JSON replace CSV; total keys "
                              << calibrations_.size() << ")" << std::endl;
                }
            }
        }
        if (!calibrations_.empty())
            return true;
        if (try_json())
            return true;
    }

    std::cout << "[PTCalibration] ⚠️  No calibration files found - sensors will be uncalibrated"
              << std::endl;
    return false;
}

bool PTCalibrationManager::load_from_json(const std::string& json_path, bool merge_missing_only) {
    std::ifstream file(json_path);
    if (!file.is_open()) {
        std::cerr << "[PTCalibration] Failed to open JSON file: " << json_path << std::endl;
        return false;
    }

    // Format: {"calibration_polynomials": {"1": [A, B, C, D], "2": [A, B, C, D], ...}}
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    file.close();

    nlohmann::json root;
    try {
        root = nlohmann::json::parse(content);
    } catch (const std::exception& e) {
        std::cerr << "[PTCalibration] JSON parse error in " << json_path << ": " << e.what()
                  << std::endl;
        return false;
    }
    if (!root.contains("calibration_polynomials") || !root["calibration_polynomials"].is_object())
        return false;

    size_t loaded = 0;
    for (const auto& [ch_str, arr] : root["calibration_polynomials"].items()) {
        if (!arr.is_array() || arr.size() < 4)
            continue;
        if (!arr[0].is_number() || !arr[1].is_number() || !arr[2].is_number() ||
            !arr[3].is_number())
            continue;
        int ch = 0;
        try {
            ch = std::stoi(ch_str);
        } catch (...) {
            continue;
        }
        const uint8_t channel_id = static_cast<uint8_t>(ch);
        if (merge_missing_only && calibrations_.find(channel_id) != calibrations_.end())
            continue;
        calibrations_[channel_id] = PTCalibrationCoeffs(arr[0].get<double>(), arr[1].get<double>(),
                                                        arr[2].get<double>(), arr[3].get<double>());
        loaded++;
    }

    return loaded > 0;
}

bool PTCalibrationManager::load_from_csv(const std::string& csv_path) {
    std::ifstream file(csv_path);
    if (!file.is_open()) {
        std::cerr << "[PTCalibration] Failed to open CSV file: " << csv_path << std::endl;
        return false;
    }

    // Read header line
    std::string header_line;
    std::getline(file, header_line);

    // Find PT columns: "PT{N} Coefficient 0", "PT{N} Coefficient 1", etc.
    std::regex pt_col_regex(R"(PT(\d+)\s+Coefficient\s+(\d+))", std::regex_constants::icase);
    std::sregex_iterator iter(header_line.begin(), header_line.end(), pt_col_regex);
    std::sregex_iterator end;

    std::map<uint8_t, std::array<int, 4>> pt_col_indices;  // channel_id -> [col_idx for A, B, C, D]
    std::vector<std::string> columns;

    // Parse header to get column indices
    std::istringstream header_stream(header_line);
    std::string col;
    int col_idx = 0;
    while (std::getline(header_stream, col, ',')) {
        columns.push_back(col);
        std::smatch match;
        if (std::regex_search(col, match, pt_col_regex)) {
            uint8_t pt_num = static_cast<uint8_t>(std::stoi(match[1].str()));
            int coeff_idx = std::stoi(match[2].str());
            if (coeff_idx >= 0 && coeff_idx < 4) {
                pt_col_indices[pt_num][coeff_idx] = col_idx;
            }
        }
        col_idx++;
    }

    // Read all rows and use last row for coefficients
    std::vector<std::vector<std::string>> rows;
    std::string line;
    while (std::getline(file, line)) {
        if (line.empty())
            continue;
        std::vector<std::string> row;
        std::istringstream line_stream(line);
        std::string cell;
        while (std::getline(line_stream, cell, ',')) {
            row.push_back(cell);
        }
        rows.push_back(row);
    }

    if (rows.empty()) {
        return false;
    }

    // Use last row for coefficients
    const auto& last_row = rows.back();

    // Extract coefficients for each PT
    for (const auto& [pt_num, col_indices] : pt_col_indices) {
        if (col_indices[0] < static_cast<int>(last_row.size()) &&
            col_indices[1] < static_cast<int>(last_row.size()) &&
            col_indices[2] < static_cast<int>(last_row.size()) &&
            col_indices[3] < static_cast<int>(last_row.size())) {
            try {
                double A = std::stod(last_row[col_indices[0]]);
                double B = std::stod(last_row[col_indices[1]]);
                double C = std::stod(last_row[col_indices[2]]);
                double D = std::stod(last_row[col_indices[3]]);

                calibrations_[pt_num] = PTCalibrationCoeffs(A, B, C, D);
            } catch (const std::exception& e) {
                std::cerr << "[PTCalibration] Error parsing coefficients for PT "
                          << static_cast<int>(pt_num) << ": " << e.what() << std::endl;
            }
        }
    }

    return !calibrations_.empty();
}

const PTCalibrationCoeffs* PTCalibrationManager::get_calibration(uint8_t channel_id) const {
    auto it = calibrations_.find(channel_id);
    if (it != calibrations_.end()) {
        return &it->second;
    }
    return nullptr;
}

bool PTCalibrationManager::is_calibrated(uint8_t channel_id) const {
    return calibrations_.find(channel_id) != calibrations_.end();
}

void PTCalibrationManager::set_calibration(uint8_t channel_id, const PTCalibrationCoeffs& coeffs) {
    calibrations_[channel_id] = coeffs;
}

void PTCalibrationManager::clear_calibration(uint8_t channel_id) {
    calibrations_.erase(channel_id);
}

double PTCalibrationManager::calculate_pressure(uint8_t channel_id, int32_t adc_code) const {
    const auto* coeffs = get_calibration(channel_id);
    if (coeffs) {
        double p = coeffs->calculate_pressure(adc_code);
        if (!std::isfinite(p))
            return 0.0;
        return std::clamp(p, -3000.0, 20000.0);
    }
    return 0.0;  // Uncalibrated
}

std::optional<int32_t> PTCalibrationCoeffs::invert_to_adc(double target_psi) const {
    auto eval = [this](double x) {
        return (A * x * x * x) + (B * x * x) + (C * x) + D;
    };
    for (const auto& [lo, hi] : {std::pair<int64_t, int64_t>(0, 2147483647),
                                 std::pair<int64_t, int64_t>(-2147483648, 0)}) {
        double f_lo = eval(lo);
        double f_hi = eval(hi);
        if (!(std::min(f_lo, f_hi) <= target_psi && target_psi <= std::max(f_lo, f_hi)))
            continue;
        double left = lo, right = hi;
        for (int i = 0; i < 64; ++i) {
            double mid = std::round((left + right) / 2);
            double f_mid = eval(mid);
            if (std::abs(f_mid - target_psi) < 0.5)
                return static_cast<int32_t>(mid);
            if (f_lo < f_hi) {
                if (f_mid < target_psi)
                    left = mid;
                else
                    right = mid;
            } else {
                if (f_mid > target_psi)
                    left = mid;
                else
                    right = mid;
            }
        }
        return static_cast<int32_t>(std::round((left + right) / 2));
    }
    return std::nullopt;
}

void PTCalibrationManager::set_default_paths(const std::string& json_dir,
                                             const std::string& csv_path) {
    default_json_dir_ = json_dir;
    default_csv_path_ = csv_path;
}

/** Match calibration_orchestrator._load_prior_from_polynomial_calibration: skip non-factory JSON.
 */
static bool skip_json_for_pt_polynomial_load(const std::string& filename) {
    if (filename == "adjustments.json")
        return true;
    if (filename.find("learned_prior") != std::string::npos)
        return true;
    // Operator-built cubics are owned by CubicCalibrationStore, which applies them via
    // set_calibration() after load. Excluding the file here keeps the factory overlay pure so the
    // service can snapshot true factory coefficients (for revert-on-clear).
    if (filename == "cubic_calibration.json")
        return true;
    return false;
}

std::string PTCalibrationManager::find_latest_json_file(const std::string& json_dir) const {
    if (!fs::exists(json_dir) || !fs::is_directory(json_dir)) {
        return "";
    }

    std::string latest_file;
    std::time_t latest_time = 0;
    // Seeding "newest so far" with 0 silently discarded every candidate: libstdc++'s
    // fs::file_time_type is __file_clock, whose epoch is 2174-01-01, so a present-day file's
    // time_since_epoch() is NEGATIVE (~-4.6e9 s) and `time_t > 0` is never true. This function
    // therefore always returned "" and no JSON calibration has ever loaded — the service stat()ed
    // the file and then skipped it, reporting "No calibration files found". Track the first
    // candidate explicitly instead of relying on a sentinel that assumes a 1970 epoch.
    bool have_candidate = false;

#if __cplusplus >= 201703L
    for (const auto& entry : fs::directory_iterator(json_dir)) {
        if (!entry.is_regular_file() || entry.path().extension() != ".json")
            continue;
        const std::string fname = entry.path().filename().string();
        if (skip_json_for_pt_polynomial_load(fname))
            continue;
        auto file_time = fs::last_write_time(entry.path());
        auto time_t =
            std::chrono::duration_cast<std::chrono::seconds>(file_time.time_since_epoch()).count();

        if (!have_candidate || time_t > latest_time) {
            have_candidate = true;
            latest_time = time_t;
            latest_file = entry.path().string();
        }
    }
#else
    // Fallback for older C++ standards
    DIR* dir = opendir(json_dir.c_str());
    if (dir) {
        struct dirent* entry;
        while ((entry = readdir(dir)) != nullptr) {
            std::string filename = entry->d_name;
            if (filename.length() > 5 && filename.substr(filename.length() - 5) == ".json") {
                if (skip_json_for_pt_polynomial_load(filename))
                    continue;
                std::string full_path = json_dir + "/" + filename;
                struct stat file_stat;
                if (stat(full_path.c_str(), &file_stat) == 0 && S_ISREG(file_stat.st_mode)) {
                    if (!have_candidate || file_stat.st_mtime > latest_time) {
                        have_candidate = true;
                        latest_time = file_stat.st_mtime;
                        latest_file = full_path;
                    }
                }
            }
        }
        closedir(dir);
    }
#endif

    return latest_file;
}

}  // namespace calibration
}  // namespace fsw
