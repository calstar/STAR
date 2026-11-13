#ifndef ROBUST_CALIBRATION_MANAGER_HPP
#define ROBUST_CALIBRATION_MANAGER_HPP

#include <Eigen/Dense>
#include <cstdint>
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
 * Runtime PT calibration via RobustCalibrationFramework (9-D basis, TLS / Bayesian / RLS / GLR /
 * bias), seeded from factory cubic. Streaming pressure uses predict_pressure_psi(), not a live
 * cubic polynomial.
 */
class RobustCalibrationManager {
public:
    RobustCalibrationManager();

    void initialize_sensor(uint16_t sensor_id, const PTCalibrationCoeffs& baseline);

    void update_calibration(uint16_t sensor_id, int32_t adc_code, double reference_pressure);

    void zero_sensor(uint16_t sensor_id, int32_t adc_code);

    /** Reseed a sensor's framework cleanly from the given cubic baseline, discarding any learned
     * adjustments and ignoring restored/population priors. Used when a calibration profile is
     * swapped live: the profile is the whole cal, so robust resets and relearns from it. */
    void reseed_sensor(uint16_t sensor_id, const PTCalibrationCoeffs& baseline);

    /** Mean PSI from the robust model (default environment). */
    double predict_pressure_psi(uint16_t sensor_id, int32_t adc_code);

    /** True if this sensor_id was initialized for robust tracking (factory-baselined). */
    bool has_sensor(uint16_t sensor_id) const;

    void reset_adjustment(uint16_t sensor_id);

    /** Persist per-sensor θ. When uid_to_role is given, each entry also records its role so a later
     *  load can re-attach it to the role's current sensor_id (calibration follows the sensor). */
    bool save_adjustments(const std::string& path,
                          const std::map<uint16_t, std::string>* uid_to_role = nullptr) const;

    /** Restore per-sensor θ. When uid_to_role is given, an entry tagged with a role is restored
     * into the sensor_id that role currently maps to (so a moved sensor keeps its learned state),
     *  falling back to the persisted numeric id for untagged/legacy entries. */
    bool load_adjustments(const std::string& path,
                          const std::map<uint16_t, std::string>* uid_to_role = nullptr);

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
