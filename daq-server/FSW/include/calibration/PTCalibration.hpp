#ifndef PT_CALIBRATION_HPP
#define PT_CALIBRATION_HPP

#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <string>

namespace fsw {
namespace calibration {

/**
 * @brief PT Calibration Coefficients
 *
 * Cubic polynomial: psi = A * (adc^3) + B * (adc^2) + C * adc + D
 */
struct PTCalibrationCoeffs {
    double A;  // Coefficient for adc^3
    double B;  // Coefficient for adc^2
    double C;  // Coefficient for adc
    double D;  // Constant term

    PTCalibrationCoeffs() : A(0.0), B(0.0), C(0.0), D(0.0) {
    }
    PTCalibrationCoeffs(double a, double b, double c, double d) : A(a), B(b), C(c), D(d) {
    }

    /**
     * @brief Calculate pressure (psi) from ADC code
     * @param adc_code Raw ADC code (32-bit signed integer)
     * @return Calibrated pressure in PSI
     */
    double calculate_pressure(int32_t adc_code) const {
        double adc = static_cast<double>(adc_code);
        return (A * adc * adc * adc) + (B * adc * adc) + (C * adc) + D;
    }

    /**
     * @brief Invert psi = A*x^3 + B*x^2 + C*x + D to find ADC code for target PSI
     * @param target_psi Target pressure in PSI
     * @return ADC code, or nullopt if out of range
     */
    std::optional<int32_t> invert_to_adc(double target_psi) const;
};

/**
 * PT board slot (1–10, from board_id % 10 with 0→10) + local connector (1–10) → factory/JSON
 * logical channel index (slot 1 → 1..10, slot 2 → 11..20, …). Same rule as calibration_service.
 */
inline uint8_t pt_logical_calibration_channel(uint8_t board_slot_number, uint8_t local_connector) {
    if (local_connector == 0 || local_connector > 10)
        return local_connector;
    const int idx =
        (static_cast<int>(board_slot_number) - 1) * 10 + static_cast<int>(local_connector);
    if (idx < 1 || idx > 255)
        return local_connector;
    return static_cast<uint8_t>(idx);
}

/**
 * @brief PT Calibration Manager
 *
 * Loads and manages PT calibration coefficients from JSON or CSV files.
 * Provides calibrated pressure values for sensor channels.
 */
class PTCalibrationManager {
public:
    PTCalibrationManager();
    ~PTCalibrationManager() = default;

    /**
     * @brief Load calibration from JSON file (from calibration GUI)
     * @param json_path Path to JSON calibration file
     * @param merge_missing_only If true, only add channels not already present after CSV; if false,
     *        every channel in JSON overwrites the same logical key (GUI per-connector calibration).
     * @return true if at least one channel was loaded/merged
     */
    bool load_from_json(const std::string& json_path, bool merge_missing_only = false);

    /**
     * @brief Load calibration from CSV file (from DiabloAvionics)
     * @param csv_path Path to CSV calibration file
     * @return true if loaded successfully
     */
    bool load_from_csv(const std::string& csv_path);

    /**
     * @brief Auto-load calibration from default paths
     * Default: factory CSV first, then newest GUI JSON overlays every channel it lists (fixes CSV
     * PT6≠GN2 ch6). CAL_PT_JSON_MISSING_ONLY=1 — JSON only fills gaps (legacy). CAL_PT_JSON_FIRST=1
     * — JSON only, then CSV.
     * @return true if any calibration was loaded
     */
    bool load_calibration();

    /**
     * @brief Get calibration coefficients for a sensor channel
     * @param channel_id Sensor channel ID (1-indexed)
     * @return Calibration coefficients if available, nullptr otherwise
     */
    const PTCalibrationCoeffs* get_calibration(uint8_t channel_id) const;

    /**
     * @brief Check if a channel has calibration
     * @param channel_id Sensor channel ID
     * @return true if calibrated
     */
    bool is_calibrated(uint8_t channel_id) const;

    /**
     * @brief Calculate calibrated pressure for a channel
     * @param channel_id Sensor channel ID
     * @param adc_code Raw ADC code
     * @return Calibrated pressure in PSI, or 0.0 if not calibrated
     */
    double calculate_pressure(uint8_t channel_id, int32_t adc_code) const;

    /**
     * @brief Get number of calibrated channels
     */
    size_t get_calibrated_count() const {
        return calibrations_.size();
    }

    /**
     * @brief Set default calibration file paths
     */
    static void set_default_paths(const std::string& json_dir, const std::string& csv_path);

private:
    // Map: channel_id -> calibration coefficients
    std::map<uint8_t, PTCalibrationCoeffs> calibrations_;

    // Default paths
    static std::string default_json_dir_;
    static std::string default_csv_path_;

    // Helper methods
    bool parse_json_file(const std::string& json_path);
    bool parse_csv_file(const std::string& csv_path);
    std::string find_latest_json_file(const std::string& json_dir) const;
};

}  // namespace calibration
}  // namespace fsw

#endif  // PT_CALIBRATION_HPP
