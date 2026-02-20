#include "calibration/SensorCalibration.hpp"

#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;

namespace fsw {
namespace calibration {

// ── Loading ────────────────────────────────────────────────────────────────

bool SensorCalibrationManager::load_from_json(const std::string& json_path) {
    std::ifstream file(json_path);
    if (!file.is_open()) {
        std::cerr << "[" << sensor_type_ << " Cal] Failed to open JSON: " << json_path << std::endl;
        return false;
    }

    std::string content((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    file.close();

    // Match: "channel_id": [C0, C1, C2, C3]   (at least 2 coefficients)
    std::regex poly_regex("\"(\\d+)\":\\s*\\[([\\d\\.\\-\\+eE]+(?:,\\s*[\\d\\.\\-\\+eE]+)+)\\]");
    std::sregex_iterator iter(content.begin(), content.end(), poly_regex);
    std::sregex_iterator end;

    size_t loaded = 0;
    for (; iter != end; ++iter) {
        std::smatch match = *iter;
        uint8_t channel_id = static_cast<uint8_t>(std::stoi(match[1].str()));
        std::string coeffs_str = match[2].str();

        // Parse coefficient list
        std::vector<double> coeffs;
        std::istringstream ss(coeffs_str);
        std::string token;
        while (std::getline(ss, token, ',')) {
            // trim whitespace
            token.erase(0, token.find_first_not_of(" \t"));
            token.erase(token.find_last_not_of(" \t") + 1);
            if (!token.empty())
                coeffs.push_back(std::stod(token));
        }

        if (!coeffs.empty()) {
            calibrations_[channel_id] = PolynomialCalibration(coeffs, default_unit_);
            loaded++;
        }
    }

    if (loaded > 0) {
        std::cout << "[" << sensor_type_ << " Cal] Loaded " << loaded
                  << " calibrations from JSON: " << json_path << std::endl;
    }
    return loaded > 0;
}

bool SensorCalibrationManager::load_from_csv(const std::string& csv_path) {
    std::ifstream file(csv_path);
    if (!file.is_open()) {
        std::cerr << "[" << sensor_type_ << " Cal] Failed to open CSV: " << csv_path << std::endl;
        return false;
    }

    // Read header line
    std::string header_line;
    std::getline(file, header_line);

    // Find columns: "{TYPE}{N} Coefficient {K}"
    // e.g. "PT1 Coefficient 0", "TC2 Coefficient 1", etc.
    std::string pattern = sensor_type_ + "(\\d+)\\s+Coefficient\\s+(\\d+)";
    std::regex col_regex(pattern, std::regex_constants::icase);

    // Parse header → column indices per channel
    std::map<uint8_t, std::map<int, int>> channel_coeff_cols;  // channel → (coeff_idx → col_idx)
    {
        std::istringstream ss(header_line);
        std::string col;
        int col_idx = 0;
        while (std::getline(ss, col, ',')) {
            std::smatch m;
            if (std::regex_search(col, m, col_regex)) {
                uint8_t ch = static_cast<uint8_t>(std::stoi(m[1].str()));
                int coeff_idx = std::stoi(m[2].str());
                channel_coeff_cols[ch][coeff_idx] = col_idx;
            }
            col_idx++;
        }
    }

    // Read all rows, use last row for coefficients
    std::vector<std::vector<std::string>> rows;
    std::string line;
    while (std::getline(file, line)) {
        if (line.empty())
            continue;
        std::vector<std::string> row;
        std::istringstream ss(line);
        std::string cell;
        while (std::getline(ss, cell, ','))
            row.push_back(cell);
        rows.push_back(row);
    }

    if (rows.empty())
        return false;
    const auto& last_row = rows.back();

    for (const auto& [ch, coeff_map] : channel_coeff_cols) {
        std::vector<double> coeffs(coeff_map.size(), 0.0);
        bool ok = true;
        for (const auto& [ci, col] : coeff_map) {
            if (col >= static_cast<int>(last_row.size())) {
                ok = false;
                break;
            }
            try {
                if (ci < static_cast<int>(coeffs.size()))
                    coeffs[ci] = std::stod(last_row[col]);
            } catch (...) {
                ok = false;
                break;
            }
        }
        if (ok && !coeffs.empty()) {
            calibrations_[ch] = PolynomialCalibration(coeffs, default_unit_);
        }
    }

    if (!calibrations_.empty()) {
        std::cout << "[" << sensor_type_ << " Cal] Loaded " << calibrations_.size()
                  << " calibrations from CSV: " << csv_path << std::endl;
    }
    return !calibrations_.empty();
}

bool SensorCalibrationManager::load_calibration(const std::string& json_dir,
                                                const std::string& csv_path) {
    // JSON first
    if (!json_dir.empty() && fs::exists(json_dir)) {
        std::string json_file = find_latest_json(json_dir);
        if (!json_file.empty() && load_from_json(json_file))
            return true;
    }
    // CSV fallback
    if (!csv_path.empty() && fs::exists(csv_path)) {
        if (load_from_csv(csv_path))
            return true;
    }
    std::cout << "[" << sensor_type_ << " Cal] ⚠️  No calibration files found — sensors uncalibrated"
              << std::endl;
    return false;
}

// ── Evaluation ─────────────────────────────────────────────────────────────

bool SensorCalibrationManager::is_calibrated(uint8_t channel_id) const {
    return calibrations_.count(channel_id) > 0;
}

double SensorCalibrationManager::calculate(uint8_t channel_id, int32_t raw_counts) const {
    auto it = calibrations_.find(channel_id);
    if (it != calibrations_.end()) {
        return it->second.evaluate(raw_counts);
    }
    return 0.0;
}

const PolynomialCalibration* SensorCalibrationManager::get(uint8_t channel_id) const {
    auto it = calibrations_.find(channel_id);
    return (it != calibrations_.end()) ? &it->second : nullptr;
}

// ── Helpers ────────────────────────────────────────────────────────────────

std::string SensorCalibrationManager::find_latest_json(const std::string& dir) const {
    if (!fs::exists(dir) || !fs::is_directory(dir))
        return "";

    std::string latest;
    std::filesystem::file_time_type latest_time{};

    for (const auto& entry : fs::directory_iterator(dir)) {
        if (entry.is_regular_file() && entry.path().extension() == ".json") {
            auto ftime = fs::last_write_time(entry.path());
            if (latest.empty() || ftime > latest_time) {
                latest_time = ftime;
                latest = entry.path().string();
            }
        }
    }
    return latest;
}

}  // namespace calibration
}  // namespace fsw



