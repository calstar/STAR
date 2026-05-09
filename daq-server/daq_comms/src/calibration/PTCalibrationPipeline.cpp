#include "calibration/PTCalibrationPipeline.hpp"

#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>

#include "../../FSW/calibration/include/PTCalibrationFramework.hpp"
#include "../../FSW/calibration/include/PTCalibrationTool.hpp"
#include "elodin/DatabaseConfig.hpp"

namespace daq_comms {
namespace calibration {

PTCalibrationPipeline::PTCalibrationPipeline() : elodin_client_(nullptr), running_(false) {
    stats_.raw_messages_received = 0;
    stats_.calibrated_messages_published = 0;
    stats_.calibration_errors = 0;
    stats_.missing_calibration = 0;
}

PTCalibrationPipeline::~PTCalibrationPipeline() {
    stop();
}

bool PTCalibrationPipeline::initialize(elodin::ElodinClient& client) {
    elodin_client_ = &client;
    return true;
}

bool PTCalibrationPipeline::load_calibration(uint8_t channel_id,
                                             const std::string& calibration_file,
                                             const std::string& calibration_map_type) {
    std::lock_guard<std::mutex> lock(calibration_mutex_);

    try {
        // Create calibration map function
        auto calibration_map = createCalibrationMap(calibration_map_type);
        if (!calibration_map) {
            std::cerr << "[PTCalibrationPipeline] Failed to create calibration map: "
                      << calibration_map_type << std::endl;
            return false;
        }

        // Create framework instance
        auto framework = std::make_shared<PTCalibrationFramework>(calibration_map);

        // Load calibration from file
        if (!framework->loadCalibration(calibration_file)) {
            std::cerr << "[PTCalibrationPipeline] Failed to load calibration from: "
                      << calibration_file << std::endl;
            return false;
        }

        // Initialize channel calibration
        ChannelCalibration channel_cal;
        channel_cal.framework = framework;
        channel_cal.environment = EnvironmentalState();  // Default environment
        channel_cal.has_calibration = true;

        channel_calibrations_[channel_id] = channel_cal;

        std::cout << "[PTCalibrationPipeline] Loaded calibration for channel " << (int)channel_id
                  << " from " << calibration_file << std::endl;
        return true;
    } catch (const std::exception& e) {
        std::cerr << "[PTCalibrationPipeline] Exception loading calibration: " << e.what()
                  << std::endl;
        return false;
    }
}

void PTCalibrationPipeline::set_calibration_parameters(uint8_t channel_id,
                                                       const std::string& calibration_map_type,
                                                       const CalibrationParameters& params) {
    std::lock_guard<std::mutex> lock(calibration_mutex_);

    // Create calibration map function
    auto calibration_map = createCalibrationMap(calibration_map_type);
    if (!calibration_map) {
        std::cerr << "[PTCalibrationPipeline] Failed to create calibration map: "
                  << calibration_map_type << std::endl;
        return;
    }

    // Create framework instance
    auto framework = std::make_shared<PTCalibrationFramework>(calibration_map);

    // Set calibration parameters directly (this is a workaround - framework doesn't expose setter)
    // We'll need to use the framework's internal state or create a wrapper
    // For now, we'll store the parameters and use them in predictPressure

    ChannelCalibration channel_cal;
    channel_cal.framework = framework;
    channel_cal.environment = EnvironmentalState();
    channel_cal.has_calibration = true;

    channel_calibrations_[channel_id] = channel_cal;
}

void PTCalibrationPipeline::set_environmental_state(uint8_t channel_id,
                                                    const EnvironmentalState& env) {
    std::lock_guard<std::mutex> lock(calibration_mutex_);
    auto it = channel_calibrations_.find(channel_id);
    if (it != channel_calibrations_.end()) {
        it->second.environment = env;
    }
}

void PTCalibrationPipeline::start() {
    if (running_) {
        return;
    }

    running_ = true;
    processing_thread_ = std::thread(&PTCalibrationPipeline::processing_loop, this);
}

void PTCalibrationPipeline::stop() {
    if (!running_) {
        return;
    }

    running_ = false;
    if (processing_thread_.joinable()) {
        processing_thread_.join();
    }
}

void PTCalibrationPipeline::process_raw_message(
    const comms::messages::sensor::RawPTMessage& raw_msg) {
    if (!elodin_client_) {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        stats_.raw_messages_received++;
    }

    // Extract fields from RawPTMessage
    uint64_t timestamp_ns = std::get<0>(raw_msg.fields);
    uint8_t channel_id = std::get<1>(raw_msg.fields);
    uint32_t raw_adc = std::get<3>(raw_msg.fields);

    // Convert ADC to voltage
    double voltage = adc_to_voltage(raw_adc);

    // Find calibration framework for this channel
    std::lock_guard<std::mutex> lock(calibration_mutex_);
    auto it = channel_calibrations_.find(channel_id);
    if (it == channel_calibrations_.end() || !it->second.has_calibration) {
        // No calibration available
        {
            std::lock_guard<std::mutex> stats_lock(stats_mutex_);
            stats_.missing_calibration++;
        }
        return;
    }

    const auto& channel_cal = it->second;

    try {
        // Use FSW calibration framework to predict pressure with uncertainty
        auto [pressure_pa, variance] =
            channel_cal.framework->predictPressure(voltage, channel_cal.environment);

        // Convert variance to quality metric (0-1 scale)
        float quality = variance_to_quality(variance);

        // Create CalibratedPTMessage
        comms::messages::filtered::CalibratedPTMessage calibrated_msg;
        std::get<0>(calibrated_msg.fields) = timestamp_ns;
        std::get<1>(calibrated_msg.fields) = channel_id;
        std::get<2>(calibrated_msg.fields) = pressure_pa;
        std::get<3>(calibrated_msg.fields) = channel_cal.environment.temperature;
        std::get<4>(calibrated_msg.fields) = quality;
        std::get<5>(calibrated_msg.fields) = 1;  // Valid

        // Publish to Elodin
        std::array<uint8_t, 2> calibrated_pt_packet_id = {0x30, 0x00};
        elodin_client_->publish(calibrated_pt_packet_id, calibrated_msg);

        {
            std::lock_guard<std::mutex> stats_lock(stats_mutex_);
            stats_.calibrated_messages_published++;
        }
    } catch (const std::exception& e) {
        std::cerr << "[PTCalibrationPipeline] Calibration error for channel " << (int)channel_id
                  << ": " << e.what() << std::endl;
        {
            std::lock_guard<std::mutex> stats_lock(stats_mutex_);
            stats_.calibration_errors++;
        }
    }
}

void PTCalibrationPipeline::processing_loop() {
    // TODO: Implement polling from Elodin DB for RawPTMessage
    // For now, this is called directly via process_raw_message()
    while (running_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

double PTCalibrationPipeline::adc_to_voltage(uint32_t raw_adc) const {
    return (static_cast<double>(raw_adc) / ADC_MAX_COUNT) * ADC_REFERENCE_VOLTAGE;
}

float PTCalibrationPipeline::variance_to_quality(double variance) const {
    // Convert variance to quality metric (0-1 scale)
    // Lower variance = higher quality
    // Typical variance for good calibration: < 10000 Pa² (100 Pa std dev)
    // Poor calibration: > 1000000 Pa² (1000 Pa std dev)
    const double good_variance = 10000.0;    // 100 Pa std dev
    const double poor_variance = 1000000.0;  // 1000 Pa std dev

    if (variance <= good_variance) {
        return 1.0f;
    } else if (variance >= poor_variance) {
        return 0.0f;
    } else {
        // Linear interpolation
        double ratio = (poor_variance - variance) / (poor_variance - good_variance);
        return static_cast<float>(ratio);
    }
}

PTCalibrationPipeline::Stats PTCalibrationPipeline::get_stats() const {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    return stats_;
}

}  // namespace calibration
}  // namespace daq_comms
