#include "../include/DiabloSensorFusion.hpp"
#include "../../include/DiabloGlobals.h"
#include "../../../utl/diablo_nav_utils.hpp"
#include <algorithm>
#include <cmath>

DiabloSensorFusion::DiabloSensorFusion()
    : p0_pa_(101325.0),  // Standard sea level pressure
      t0_c_(15.0),        // Standard sea level temperature
      history_window_size_(100),
      last_fusion_quality_(0.0) {
    
    // Default sensor weights
    weights_.pt_weight = 1.0;
    weights_.tc_weight = 0.6;
    weights_.rtd_weight = 0.4;
    weights_.lc_weight = 1.0;
    weights_.quality_threshold = 0.5;
}

void DiabloSensorFusion::setSensorWeights(const SensorWeights& weights) {
    weights_ = weights;
}

void DiabloSensorFusion::setReferencePressure(double p0_pa) {
    p0_pa_ = p0_pa;
}

void DiabloSensorFusion::setReferenceTemperature(double t0_c) {
    t0_c_ = t0_c;
}

double DiabloSensorFusion::barometricAltitude(double pressure_pa, double temperature_c) const {
    // Use our utility function for barometric altitude
    double temperature_k = DiabloNavUtils::celsiusToKelvin(temperature_c);
    double t0_k = DiabloNavUtils::celsiusToKelvin(t0_c_);
    return DiabloNavUtils::pressureToAltitude(pressure_pa, temperature_k, p0_pa_, t0_k);
}

double DiabloSensorFusion::weightedAverage(const std::vector<double>& values,
                                          const std::vector<double>& weights) const {
    // Use robust weighted average from our utilities
    return DiabloNavUtils::robustWeightedAverage(values, weights, 3.0);
}

double DiabloSensorFusion::computeUncertainty(const std::vector<double>& values,
                                              const std::vector<double>& uncertainties) const {
    // Use our utility function for combining uncertainties
    return DiabloNavUtils::combineUncertainties(uncertainties);
}

double DiabloSensorFusion::estimateAltitudeFromPT(
    const std::vector<double>& pressures_pa,
    const std::vector<double>& temperatures_c) const {
    
    if (pressures_pa.empty()) {
        return 0.0;
    }
    
    // Use median pressure for robustness against outliers
    std::vector<double> sorted_pressures = pressures_pa;
    std::sort(sorted_pressures.begin(), sorted_pressures.end());
    double median_pressure = sorted_pressures[sorted_pressures.size() / 2];
    
    // Use average temperature if available
    double avg_temperature = t0_c_;
    if (!temperatures_c.empty()) {
        double sum_temp = 0.0;
        size_t count = 0;
        for (double temp : temperatures_c) {
            if (std::isfinite(temp) && temp > -50.0 && temp < 200.0) {
                sum_temp += temp;
                count++;
            }
        }
        if (count > 0) {
            avg_temperature = sum_temp / count;
        }
    }
    
    return barometricAltitude(median_pressure, avg_temperature);
}

double DiabloSensorFusion::estimateThrustFromLC(
    const std::vector<double>& forces_n) const {
    
    // Use our utility function for thrust estimation
    return DiabloNavUtils::estimateThrustFromLoadCells(forces_n);
}

double DiabloSensorFusion::estimateTemperature(
    const std::vector<double>& tc_temps_c,
    const std::vector<double>& rtd_temps_c) const {
    
    std::vector<double> all_temps;
    std::vector<double> all_weights;
    
    // Add TC temperatures with their weight
    for (double temp : tc_temps_c) {
        if (std::isfinite(temp) && temp > -100.0 && temp < 2000.0) {
            all_temps.push_back(temp);
            all_weights.push_back(weights_.tc_weight);
        }
    }
    
    // Add RTD temperatures with their weight
    for (double temp : rtd_temps_c) {
        if (std::isfinite(temp) && temp > -100.0 && temp < 1000.0) {
            all_temps.push_back(temp);
            all_weights.push_back(weights_.rtd_weight);
        }
    }
    
    if (all_temps.empty()) {
        return t0_c_;  // Return reference temperature
    }
    
    return weightedAverage(all_temps, all_weights);
}

DiabloSensorFusion::FusedMeasurement DiabloSensorFusion::fuseSensorData() {
    FusedMeasurement fused;
    fused.valid = false;
    fused.quality = 0.0;
    fused.timestamp = std::chrono::steady_clock::now();
    
    // Collect PT sensor data
    std::vector<double> pt_pressures;
    std::vector<double> pt_temperatures;
    std::vector<double> pt_uncertainties;
    std::vector<double> pt_weights;
    
    for (int i = 0; i < 8; i++) {
        std::mutex* lock = get_pt_message_lock(i);
        mfPTMessage* msg = get_pt_message(i);
        if (lock && msg) {
            std::lock_guard<std::mutex> guard(*lock);
            double pressure = msg->template getField<2>();
            double temp = msg->template getField<4>();
            double quality = msg->template getField<5>();
            bool valid = msg->template getField<6>();
            
            if (valid && quality >= weights_.quality_threshold) {
                pt_pressures.push_back(pressure);
                pt_temperatures.push_back(temp);
                // Estimate uncertainty from quality (lower quality = higher uncertainty)
                pt_uncertainties.push_back(1000.0 * (1.0 - quality));  // Scale factor
                pt_weights.push_back(quality * weights_.pt_weight);
            }
        }
    }
    
    // Collect TC sensor data
    std::vector<double> tc_temperatures;
    for (int i = 0; i < 4; i++) {
        std::mutex* lock = get_tc_message_lock(i);
        mfTCMessage* msg = get_tc_message(i);
        if (lock && msg) {
            std::lock_guard<std::mutex> guard(*lock);
            double temp = msg->template getField<2>();
            double quality = msg->template getField<5>();
            bool valid = msg->template getField<6>();
            
            if (valid && quality >= weights_.quality_threshold) {
                tc_temperatures.push_back(temp);
            }
        }
    }
    
    // Collect RTD sensor data
    std::vector<double> rtd_temperatures;
    for (int i = 0; i < 4; i++) {
        std::mutex* lock = get_rtd_message_lock(i);
        mfRTDMessage* msg = get_rtd_message(i);
        if (lock && msg) {
            std::lock_guard<std::mutex> guard(*lock);
            double temp = msg->template getField<2>();
            double quality = msg->template getField<4>();
            bool valid = msg->template getField<5>();
            
            if (valid && quality >= weights_.quality_threshold) {
                rtd_temperatures.push_back(temp);
            }
        }
    }
    
    // Collect LC sensor data
    std::vector<double> lc_forces;
    std::vector<double> lc_uncertainties;
    for (int i = 0; i < 4; i++) {
        std::mutex* lock = get_lc_message_lock(i);
        mfLCMessage* msg = get_lc_message(i);
        if (lock && msg) {
            std::lock_guard<std::mutex> guard(*lock);
            double force = msg->template getField<2>();
            double quality = msg->template getField<4>();
            bool valid = msg->template getField<5>();
            
            if (valid && quality >= weights_.quality_threshold) {
                lc_forces.push_back(force);
                lc_uncertainties.push_back(100.0 * (1.0 - quality));  // Scale factor
            }
        }
    }
    
    // Fuse measurements
    if (!pt_pressures.empty()) {
        fused.altitude_m = estimateAltitudeFromPT(pt_pressures, pt_temperatures);
        fused.pressure_ambient_pa = weightedAverage(pt_pressures, pt_weights);
        fused.uncertainty_altitude_m = computeUncertainty(pt_pressures, pt_uncertainties);
        
        // Find chamber pressure (typically highest pressure PT sensor)
        auto max_it = std::max_element(pt_pressures.begin(), pt_pressures.end());
        if (max_it != pt_pressures.end()) {
            fused.chamber_pressure_pa = *max_it;
        }
        
        fused.valid = true;
    }
    
    // Fuse temperature
    fused.temperature_ambient_c = estimateTemperature(tc_temperatures, rtd_temperatures);
    
    // If we have chamber temperature sensors, use those for chamber temp
    if (!tc_temperatures.empty()) {
        // Assume first TC is chamber temperature (could be configured)
        fused.temperature_chamber_c = tc_temperatures[0];
    } else if (!rtd_temperatures.empty()) {
        fused.temperature_chamber_c = rtd_temperatures[0];
    } else {
        fused.temperature_chamber_c = fused.temperature_ambient_c;
    }
    
    // Fuse thrust
    if (!lc_forces.empty()) {
        fused.thrust_estimated_n = estimateThrustFromLC(lc_forces);
        fused.uncertainty_thrust_n = computeUncertainty(lc_forces, lc_uncertainties);
    }
    
    // Compute overall fusion quality
    size_t sensor_count = pt_pressures.size() + tc_temperatures.size() + 
                         rtd_temperatures.size() + lc_forces.size();
    
    if (sensor_count > 0) {
        // Quality based on number of sensors and their individual qualities
        fused.quality = std::min(1.0, static_cast<double>(sensor_count) / 10.0);
    }
    
    fused.valid = fused.valid && (fused.quality > 0.0);
    last_fusion_quality_ = fused.quality;
    
    // Update history
    if (fused.valid) {
        altitude_history_.push_back(fused.altitude_m);
        if (altitude_history_.size() > history_window_size_) {
            altitude_history_.pop_front();
        }
        
        if (!lc_forces.empty()) {
            thrust_history_.push_back(fused.thrust_estimated_n);
            if (thrust_history_.size() > history_window_size_) {
                thrust_history_.pop_front();
            }
        }
    }
    
    return fused;
}

size_t DiabloSensorFusion::getSensorCount() const {
    size_t count = 0;
    for (int i = 0; i < 8; i++) {
        std::mutex* lock = get_pt_message_lock(i);
        mfPTMessage* msg = get_pt_message(i);
        if (lock && msg) {
            std::lock_guard<std::mutex> guard(*lock);
            if (msg->template getField<6>()) {  // calibration_valid
                count++;
            }
        }
    }
    // Add TC, RTD, LC counts similarly
    return count;
}

