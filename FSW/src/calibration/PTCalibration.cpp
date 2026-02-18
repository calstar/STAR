#include "calibration/PTCalibration.hpp"

#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
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

PTCalibrationManager::PTCalibrationManager() {
    // Auto-load calibration on construction
    load_calibration();
}

bool PTCalibrationManager::load_calibration() {
    // Try JSON first (from calibration GUI)
    if (!default_json_dir_.empty() && fs::exists(default_json_dir_)) {
        std::string json_file = find_latest_json_file(default_json_dir_);
        if (!json_file.empty() && load_from_json(json_file)) {
            std::cout << "[PTCalibration] Loaded " << calibrations_.size()
                      << " calibrations from JSON: " << json_file << std::endl;
            return true;
        }
    }

    // Fall back to CSV
    if (!default_csv_path_.empty() && fs::exists(default_csv_path_)) {
        if (load_from_csv(default_csv_path_)) {
            std::cout << "[PTCalibration] Loaded " << calibrations_.size()
                      << " calibrations from CSV: " << default_csv_path_ << std::endl;
            return true;
        }
    }

    std::cout << "[PTCalibration] ⚠️  No calibration files found - sensors will be uncalibrated"
              << std::endl;
    return false;
}

bool PTCalibrationManager::load_from_json(const std::string& json_path) {
    std::ifstream file(json_path);
    if (!file.is_open()) {
        std::cerr << "[PTCalibration] Failed to open JSON file: " << json_path << std::endl;
        return false;
    }

    // Simple JSON parser for calibration format
    // Format: {"calibration_polynomials": {"1": [A, B, C, D], "2": [A, B, C, D], ...}}
    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    file.close();

    // Find calibration_polynomials section
    // Match pattern: "channel_id": [A, B, C, D]
    std::regex poly_regex(
        "\"(\\d+)\":\\s*\\[([\\d\\.\\-\\+eE]+),\\s*([\\d\\.\\-\\+eE]+),\\s*([\\d\\.\\-\\+eE]+),\\s*"
        "([\\d\\.\\-\\+eE]+)\\]");
    std::sregex_iterator iter(content.begin(), content.end(), poly_regex);
    std::sregex_iterator end;

    size_t loaded = 0;
    for (; iter != end; ++iter) {
        std::smatch match = *iter;
        uint8_t channel_id = static_cast<uint8_t>(std::stoi(match[1].str()));
        double A = std::stod(match[2].str());
        double B = std::stod(match[3].str());
        double C = std::stod(match[4].str());
        double D = std::stod(match[5].str());

        calibrations_[channel_id] = PTCalibrationCoeffs(A, B, C, D);
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

double PTCalibrationManager::calculate_pressure(uint8_t channel_id, int32_t adc_code) const {
    const auto* coeffs = get_calibration(channel_id);
    if (coeffs) {
        return coeffs->calculate_pressure(adc_code);
    }
    return 0.0;  // Uncalibrated
}

void PTCalibrationManager::set_default_paths(const std::string& json_dir,
                                             const std::string& csv_path) {
    default_json_dir_ = json_dir;
    default_csv_path_ = csv_path;
}

std::string PTCalibrationManager::find_latest_json_file(const std::string& json_dir) const {
    if (!fs::exists(json_dir) || !fs::is_directory(json_dir)) {
        return "";
    }

    std::string latest_file;
    std::time_t latest_time = 0;

#if __cplusplus >= 201703L
    for (const auto& entry : fs::directory_iterator(json_dir)) {
        if (entry.is_regular_file() && entry.path().extension() == ".json") {
            auto file_time = fs::last_write_time(entry.path());
            auto time_t =
                std::chrono::duration_cast<std::chrono::seconds>(file_time.time_since_epoch())
                    .count();

            if (time_t > latest_time) {
                latest_time = time_t;
                latest_file = entry.path().string();
            }
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
                std::string full_path = json_dir + "/" + filename;
                struct stat file_stat;
                if (stat(full_path.c_str(), &file_stat) == 0 && S_ISREG(file_stat.st_mode)) {
                    if (file_stat.st_mtime > latest_time) {
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
