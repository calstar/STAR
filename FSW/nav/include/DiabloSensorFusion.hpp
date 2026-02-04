#ifndef DIABLO_SENSOR_FUSION_HPP
#define DIABLO_SENSOR_FUSION_HPP

#include <Eigen/Dense>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <vector>

#include "../comms/include/mfDiabloSensorMessages.hpp"

/**
 * @brief Sensor fusion system for DiabloAvionics navigation
 *
 * Fuses data from PT (pressure/altitude), TC/RTD (temperature), and LC (force/thrust)
 * sensors to estimate engine state and vehicle dynamics. Designed specifically for
 * engine control applications.
 */
class DiabloSensorFusion {
public:
    struct FusedMeasurement {
        double altitude_m;              // Fused altitude estimate (m)
        double pressure_ambient_pa;     // Ambient pressure (Pa)
        double temperature_ambient_c;   // Ambient temperature (°C)
        double thrust_estimated_n;      // Estimated thrust from load cells (N)
        double chamber_pressure_pa;     // Chamber pressure from PT sensors (Pa)
        double temperature_chamber_c;   // Chamber temperature from TC/RTD (°C)
        double uncertainty_altitude_m;  // Altitude uncertainty
        double uncertainty_thrust_n;    // Thrust uncertainty
        std::chrono::steady_clock::time_point timestamp;
        bool valid;
        double quality;  // Overall fusion quality (0-1)
    };

    struct SensorWeights {
        double pt_weight;          // Weight for PT sensors in altitude fusion
        double tc_weight;          // Weight for TC sensors in temperature fusion
        double rtd_weight;         // Weight for RTD sensors in temperature fusion
        double lc_weight;          // Weight for LC sensors in thrust fusion
        double quality_threshold;  // Minimum quality to consider sensor valid
    };

    DiabloSensorFusion();
    ~DiabloSensorFusion() = default;

    // Main fusion interface
    FusedMeasurement fuseSensorData();

    // Individual sensor processing
    double estimateAltitudeFromPT(const std::vector<double>& pressures_pa,
                                  const std::vector<double>& temperatures_c) const;
    double estimateThrustFromLC(const std::vector<double>& forces_n) const;
    double estimateTemperature(const std::vector<double>& tc_temps_c,
                               const std::vector<double>& rtd_temps_c) const;

    // Configuration
    void setSensorWeights(const SensorWeights& weights);
    void setReferencePressure(double p0_pa);    // Sea level reference pressure
    void setReferenceTemperature(double t0_c);  // Sea level reference temperature

    // Statistics
    double getFusionQuality() const {
        return last_fusion_quality_;
    }
    size_t getSensorCount() const;

private:
    SensorWeights weights_;
    double p0_pa_;  // Reference pressure at sea level (Pa)
    double t0_c_;   // Reference temperature at sea level (°C)

    // Running statistics
    std::deque<double> altitude_history_;
    std::deque<double> thrust_history_;
    size_t history_window_size_;

    double last_fusion_quality_;

    // Helper functions
    double barometricAltitude(double pressure_pa, double temperature_c) const;
    double weightedAverage(const std::vector<double>& values,
                           const std::vector<double>& weights) const;
    double computeUncertainty(const std::vector<double>& values,
                              const std::vector<double>& uncertainties) const;
};

#endif  // DIABLO_SENSOR_FUSION_HPP
