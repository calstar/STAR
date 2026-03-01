#ifndef SENSOR_CALIBRATION_HPP
#define SENSOR_CALIBRATION_HPP

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace fsw {
namespace calibration {

// ────────────────────────────────────────────────────────────────────────────
// PolynomialCalibration — generic N-th order polynomial calibration
// Applies:  output = C[0]*x^N + C[1]*x^(N-1) + ... + C[N]
// Stored highest-degree-first (numpy polyfit convention).
// ────────────────────────────────────────────────────────────────────────────
struct PolynomialCalibration {
    std::vector<double> coeffs;  // highest-degree-first
    int order = 0;               // polynomial degree (coeffs.size() - 1)
    double r_squared = 0.0;      // quality metric from fitting
    std::string unit;            // output unit label ("PSI", "°C", "lbf", …)

    PolynomialCalibration() = default;

    // Cubic shortcut (PT legacy compat): A*x³ + B*x² + C*x + D
    PolynomialCalibration(double A, double B, double C, double D, const std::string& u = "PSI")
        : coeffs{A, B, C, D}, order(3), unit(u) {
    }

    // Generic constructor
    PolynomialCalibration(std::vector<double> c, const std::string& u = "")
        : coeffs(std::move(c)), order(static_cast<int>(coeffs.size()) - 1), unit(u) {
    }

    /// Evaluate the polynomial at x (Horner's method — numerically stable)
    double evaluate(double x) const {
        if (coeffs.empty())
            return 0.0;
        double result = coeffs[0];
        for (size_t i = 1; i < coeffs.size(); ++i) {
            result = result * x + coeffs[i];
        }
        return result;
    }

    /// Convenience for int32 ADC codes
    double evaluate(int32_t adc_code) const {
        return evaluate(static_cast<double>(adc_code));
    }

    bool is_valid() const {
        return !coeffs.empty();
    }
};

// ────────────────────────────────────────────────────────────────────────────
// SensorCalibrationManager — manages per-channel polynomial calibrations
//   for any sensor type (PT, TC, RTD, LC).
//   Loads from JSON / CSV, same file formats as PTCalibrationManager.
// ────────────────────────────────────────────────────────────────────────────
class SensorCalibrationManager {
public:
    /// @param sensor_type "PT", "TC", "RTD", "LC"
    /// @param default_unit output physical unit
    /// @param default_order default polynomial order if not specified in file
    explicit SensorCalibrationManager(const std::string& sensor_type,
                                      const std::string& default_unit = "", int default_order = 3)
        : sensor_type_(sensor_type), default_unit_(default_unit), default_order_(default_order) {
    }

    ~SensorCalibrationManager() = default;

    // ── Loading ────────────────────────────────────────────────────────────
    /// Load calibration from a JSON calibration file
    bool load_from_json(const std::string& json_path);

    /// Load calibration from a CSV file (DiabloAvionics format)
    bool load_from_csv(const std::string& csv_path);

    /// Auto-discover & load from default directories
    bool load_calibration(const std::string& json_dir, const std::string& csv_path);

    /// Manually set coefficients for a channel
    void set_calibration(uint8_t channel_id, const PolynomialCalibration& cal) {
        calibrations_[channel_id] = cal;
    }

    // ── Evaluation ─────────────────────────────────────────────────────────
    bool is_calibrated(uint8_t channel_id) const;
    double calculate(uint8_t channel_id, int32_t raw_counts) const;
    const PolynomialCalibration* get(uint8_t channel_id) const;
    size_t calibrated_count() const {
        return calibrations_.size();
    }

    const std::string& sensor_type() const {
        return sensor_type_;
    }

private:
    std::string sensor_type_;
    std::string default_unit_;
    int default_order_;
    std::map<uint8_t, PolynomialCalibration> calibrations_;

    std::string find_latest_json(const std::string& dir) const;
};

// ────────────────────────────────────────────────────────────────────────────
// RTD-specific helpers (Callendar-Van Dusen)
// R(T) = R0*(1 + A*T + B*T² + C*(T-100)*T³)     T >= 0 °C
// R(T) = R0*(1 + A*T + B*T²)                     T <  0 °C  (approx)
//
// IEC 60751 (Pt100):
//   A =  3.9083e-3
//   B = -5.775e-7
//   C = -4.183e-12  (only used T < 0)
//   R0 = 100 Ω
//
// For an ADC that reads counts proportional to resistance, the calibration
// is: counts → resistance (linear) → temperature (CVD inverse).
// The polynomial approach from SensorCalibrationManager still applies
// if you just want a 3rd-order poly fit from calibration data.
// But we also expose the physics-based CVD calculation here.
// ────────────────────────────────────────────────────────────────────────────
namespace rtd {

struct CVDCoeffs {
    double R0 = 100.0;  // Reference resistance at 0 °C (Pt100)
    double A = 3.9083e-3;
    double B = -5.775e-7;
    double C = -4.183e-12;  // only for T < 0 °C
};

/// Convert resistance (Ω) to temperature (°C) using iterative CVD inverse
inline double resistance_to_temp_cvd(double resistance_ohms, const CVDCoeffs& cvd = CVDCoeffs{}) {
    // Quadratic approximation: T ≈ (-A + sqrt(A² - 4B*(1 - R/R0))) / (2B)
    double ratio = resistance_ohms / cvd.R0;
    double disc = cvd.A * cvd.A - 4.0 * cvd.B * (1.0 - ratio);
    if (disc < 0.0)
        return -999.0;  // out of range
    return (-cvd.A + std::sqrt(disc)) / (2.0 * cvd.B);
}

/// Convert ADC counts to resistance (assuming linear relationship)
inline double counts_to_resistance(int32_t counts, double gain, double offset) {
    return static_cast<double>(counts) * gain + offset;
}

}  // namespace rtd

// ────────────────────────────────────────────────────────────────────────────
// TC-specific helpers
// Standard NIST polynomial: V(mV) → T(°C)
// Order varies by type (K, J, T, E, …). We store poly coeffs per type.
// Cold-junction compensation: T_actual = T_measured + T_cold_junction
// ────────────────────────────────────────────────────────────────────────────
namespace tc {

enum class TCType { K, J, T, E, N, S, R, B, CUSTOM };

/// Cold junction compensation
struct ColdJunctionConfig {
    bool enabled = false;
    double fixed_temp_c = 25.0;  // fixed CJC value (if no sensor)
    uint8_t cjc_channel_id = 0;  // or channel that reads CJC sensor
};

/// NIST ITS-90 Type K coefficients (0–1372 °C range, voltage in mV → temp in °C)
/// Simplified 9th-order from NIST tables
inline std::vector<double> nist_type_k_mv_to_c() {
    // These are the NIST Type K inverse coefficients (mV → °C), 0–20.644 mV range
    return {-1.318058e+2, 4.830222e+1,  -1.646031e+0, 5.464731e-2, -9.650715e-4,
            8.802193e-6,  -3.110810e-8, 0.0,          0.0};
}

}  // namespace tc

}  // namespace calibration
}  // namespace fsw

#endif  // SENSOR_CALIBRATION_HPP
