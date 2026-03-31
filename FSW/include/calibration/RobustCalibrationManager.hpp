#ifndef ROBUST_CALIBRATION_MANAGER_HPP
#define ROBUST_CALIBRATION_MANAGER_HPP

#include <cstdint>
#include <Eigen/Dense>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "calibration/PTCalibration.hpp"
#include "calibration/RobustCalibrationFramework.hpp"

namespace fsw {
namespace calibration {

struct SensorState {
    PTCalibrationCoeffs baseline{};
    std::unique_ptr<RobustCalibrationFramework> framework;
    SensorState();
};

/**
 * Runtime PT calibration via RobustCalibrationFramework (9-D basis, TLS / Bayesian / RLS / GLR / bias),
 * seeded from factory cubic. Streaming pressure uses predict_pressure_psi(), not a live cubic polynomial.
 */
class RobustCalibrationManager {
public:
    RobustCalibrationManager();

    void initialize_sensor(uint16_t sensor_id, const PTCalibrationCoeffs& baseline);

    void update_calibration(uint16_t sensor_id, int32_t adc_code, double reference_pressure);

    void zero_sensor(uint16_t sensor_id, int32_t adc_code);

    /** Mean PSI from the robust model (default environment). */
    double predict_pressure_psi(uint16_t sensor_id, int32_t adc_code);

    void reset_adjustment(uint16_t sensor_id);

    bool save_adjustments(const std::string& path) const;

    bool load_adjustments(const std::string& path);

private:
    mutable std::mutex mutex_;
    std::map<uint16_t, SensorState> states_;

    // Priors loaded from calibration backups.
    // If a per-sensor prior exists, it overrides the population prior for that sensor.
    std::optional<Eigen::VectorXd> population_theta_mean_;
    std::optional<Eigen::MatrixXd> population_theta_cov_;

    std::map<uint16_t, Eigen::VectorXd> restored_theta_mean_;
    std::map<uint16_t, Eigen::MatrixXd> restored_theta_cov_;
};

}  // namespace calibration
}  // namespace fsw

#endif  // ROBUST_CALIBRATION_MANAGER_HPP
