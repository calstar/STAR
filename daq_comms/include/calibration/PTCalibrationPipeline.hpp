#ifndef DAQ_PT_CALIBRATION_PIPELINE_HPP
#define DAQ_PT_CALIBRATION_PIPELINE_HPP

#include <Eigen/Core>
#include <Eigen/Dense>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "comms/messages/filtered/FilteredMessages.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"
#include "elodin/ElodinClient.hpp"

// FSW calibration framework types
// Note: These are in the global namespace from FSW
#include "../../FSW/calibration/include/PTCalibrationFramework.hpp"
class PTCalibrationFramework;

namespace daq_comms {
namespace calibration {

/**
 * @brief PT Calibration Pipeline using FSW's robust calibration framework
 *
 * Reads RawPTMessage from Elodin DB, applies Bayesian/TLS calibration via FSW framework,
 * publishes CalibratedPTMessage
 */
class PTCalibrationPipeline {
public:
    PTCalibrationPipeline();
    ~PTCalibrationPipeline();

    /**
     * @brief Initialize with Elodin client
     */
    bool initialize(elodin::ElodinClient& client);

    /**
     * @brief Load calibration for a channel from file
     * @param channel_id Channel ID
     * @param calibration_file Path to calibration file (saved by PTCalibrationTool)
     * @param calibration_map_type Type of calibration map ("polynomial" or "environmental_robust")
     * @return true if loaded successfully
     */
    bool load_calibration(uint8_t channel_id, const std::string& calibration_file,
                          const std::string& calibration_map_type = "environmental_robust");

    /**
     * @brief Set calibration parameters directly (for testing or manual setup)
     * @param channel_id Channel ID
     * @param calibration_map_type Type of calibration map
     * @param params Calibration parameters
     */
    void set_calibration_parameters(uint8_t channel_id, const std::string& calibration_map_type,
                                    const CalibrationParameters& params);

    /**
     * @brief Set environmental state for a channel (temperature, humidity, etc.)
     */
    void set_environmental_state(uint8_t channel_id, const EnvironmentalState& env);

    /**
     * @brief Start processing raw PT messages
     */
    void start();

    /**
     * @brief Stop processing
     */
    void stop();

    /**
     * @brief Process a single RawPTMessage (for direct integration)
     */
    void process_raw_message(const comms::messages::sensor::RawPTMessage& raw_msg);

    /**
     * @brief Check if running
     */
    bool is_running() const {
        return running_;
    }

    /**
     * @brief Get statistics
     */
    struct Stats {
        uint64_t raw_messages_received;
        uint64_t calibrated_messages_published;
        uint64_t calibration_errors;
        uint64_t missing_calibration;
    };
    Stats get_stats() const;

private:
    struct ChannelCalibration {
        std::shared_ptr<PTCalibrationFramework> framework;
        EnvironmentalState environment;
        bool has_calibration;
    };

    void processing_loop();
    double adc_to_voltage(uint32_t raw_adc) const;
    float variance_to_quality(double variance) const;

    elodin::ElodinClient* elodin_client_;
    std::map<uint8_t, ChannelCalibration> channel_calibrations_;
    std::mutex calibration_mutex_;

    std::atomic<bool> running_;
    std::thread processing_thread_;

    Stats stats_;
    mutable std::mutex stats_mutex_;

    // Default ADC to voltage conversion (assuming 3.3V reference, 24-bit ADC)
    static constexpr double ADC_REFERENCE_VOLTAGE = 3.3;
    static constexpr uint32_t ADC_MAX_COUNT = 16777215;  // 24-bit
};

}  // namespace calibration
}  // namespace daq_comms

#endif  // DAQ_PT_CALIBRATION_PIPELINE_HPP
