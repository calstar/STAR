#ifndef DAQ_SENSOR_ROUTER_HPP
#define DAQ_SENSOR_ROUTER_HPP

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "../../daq_comms/include/comms/messages/sensor/CalibratedPTMessage.hpp"
#include "../../daq_comms/include/comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "../../daq_comms/include/comms/messages/sensor/SensorMessages.hpp"
#include "../../daq_comms/include/protocol/EncryptedFrame.hpp"
#include "../calibration/PTCalibration.hpp"
#include "../calibration/SensorCalibration.hpp"

namespace fsw {
namespace routing {

/**
 * @brief Configuration for sensor channel routing
 */
struct SensorChannelConfig {
    uint8_t channel_id;
    std::string table_name;           // Elodin table name (e.g., "pt_chamber_raw")
    std::array<uint8_t, 2> table_id;  // Elodin table ID
    std::string sensor_type;          // "PT", "TC", "RTD", "LC"
    std::string location;             // Human-readable location (e.g., "chamber", "fuel_inlet")
};

/**
 * @brief Routes decoded sensor frames to Elodin tables
 *
 * Maps sensor channels to Elodin table IDs based on configuration.
 * This allows adding/removing sensors without code changes.
 */
class SensorRouter {
public:
    SensorRouter();
    ~SensorRouter() = default;

    /**
     * @brief Load routing configuration from TOML file
     * @param config_path Path to TOML configuration file
     * @return true if loaded successfully
     */
    bool load_config(const std::string& config_path);

    /**
     * @brief Add a sensor channel configuration manually
     */
    void add_channel(const SensorChannelConfig& config);

    /**
     * @brief Get table ID for a sensor channel
     * @param sensor_type "PT", "TC", "RTD", or "LC"
     * @param channel_id Channel identifier
     * @return Table ID if found, empty array otherwise
     */
    std::array<uint8_t, 2> get_table_id(const std::string& sensor_type, uint8_t channel_id) const;

    /**
     * @brief Get table name for a sensor channel (for debugging)
     */
    std::string get_table_name(const std::string& sensor_type, uint8_t channel_id) const;

    /**
     * @brief Convert a sensor batch into Elodin messages
     * @param batch Decoded sensor batch
     * @return Vector of (table_id, message) pairs ready for publishing
     */
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawPTMessage>>
    route_pt_samples(const daq_comms::protocol::SensorBatch& batch,
                     uint64_t receive_timestamp_ns) const;

    /**
     * @brief Convert PT samples to calibrated messages
     * @param batch Decoded sensor batch
     * @return Vector of (table_id, calibrated_message) pairs
     */
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedPTMessage>>
    route_pt_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                uint64_t receive_timestamp_ns, uint8_t pt_board_slot = 1) const;

    /**
     * @brief Set PT calibration manager (legacy)
     */
    void set_pt_calibration(const calibration::PTCalibrationManager* cal_manager) {
        pt_calibration_ = cal_manager;
    }

    /// Set calibration managers for each sensor type
    void set_tc_calibration(const calibration::SensorCalibrationManager* m) {
        tc_calibration_ = m;
    }
    void set_rtd_calibration(const calibration::SensorCalibrationManager* m) {
        rtd_calibration_ = m;
    }
    void set_lc_calibration(const calibration::SensorCalibrationManager* m) {
        lc_calibration_ = m;
    }

    // ── Raw routing ────────────────────────────────────────────────────────
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawTCMessage>>
    route_tc_samples(const daq_comms::protocol::SensorBatch& batch,
                     uint64_t receive_timestamp_ns) const;

    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawRTDMessage>>
    route_rtd_samples(const daq_comms::protocol::SensorBatch& batch,
                      uint64_t receive_timestamp_ns) const;

    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::RawLCMessage>>
    route_lc_samples(const daq_comms::protocol::SensorBatch& batch,
                     uint64_t receive_timestamp_ns) const;

    // ── Calibrated routing (require SensorCalibrationManager) ─────────────
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedTCMessage>>
    route_tc_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                uint64_t receive_timestamp_ns) const;

    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedRTDMessage>>
    route_rtd_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                 uint64_t receive_timestamp_ns) const;

    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedLCMessage>>
    route_lc_samples_calibrated(const daq_comms::protocol::SensorBatch& batch,
                                uint64_t receive_timestamp_ns) const;

    /**
     * @brief RTD Pt100 temperature conversion — no calibration manager required.
     *
     * Applies Callendar-Van Dusen (Pt100, R0=100Ω, A=3.9083e-3, B=-5.775e-7):
     *   resistance_ohm = raw_resistance_counts * 0.001
     *   T = (-R0*A + sqrt((R0*A)^2 - 4*R0*B*(R0 - R))) / (2*R0*B)
     *
     * Outputs CalibratedRTDMessage at packet_id {0x22, 0x10 + channel_id + 1}
     * (matching the RTD_Cal VTable registered in DatabaseConfig).
     */
    std::vector<std::pair<std::array<uint8_t, 2>, comms::messages::sensor::CalibratedRTDMessage>>
    route_rtd_samples_pt100(const daq_comms::protocol::SensorBatch& batch,
                            uint64_t receive_timestamp_ns) const;

private:
    std::unordered_map<std::string, SensorChannelConfig>
        channel_map_;  // Key: "sensor_type:channel_id"

    const calibration::PTCalibrationManager* pt_calibration_ = nullptr;
    const calibration::SensorCalibrationManager* tc_calibration_ = nullptr;
    const calibration::SensorCalibrationManager* rtd_calibration_ = nullptr;
    const calibration::SensorCalibrationManager* lc_calibration_ = nullptr;

    std::string make_key(const std::string& sensor_type, uint8_t channel_id) const;
};

}  // namespace routing
}  // namespace fsw

#endif  // DAQ_SENSOR_ROUTER_HPP
