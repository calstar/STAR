#ifndef DAQ_ENCRYPTED_FRAME_HPP
#define DAQ_ENCRYPTED_FRAME_HPP

#include <cstdint>
#include <string>
#include <vector>

namespace daq_comms {
namespace protocol {

/** Parsed DAQv2 SELF_TEST payload (host-side mirror; filled from Diablo::parse_self_test_packet). */
struct ParsedSelfTestPacket {
    uint8_t packet_type = 0;
    uint8_t version = 0;
    uint32_t timestamp = 0;
    uint8_t adc_good = 0;
    uint8_t num_sensors = 0;
    struct Result {
        uint8_t sensor_id;
        uint8_t result;
    };
    std::vector<Result> results;
    bool is_valid = false;
};

struct RawPTSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

struct RawTCSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

struct RawRTDSample {
    uint8_t channel_id;
    uint32_t raw_resistance_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

struct RawLCSample {
    uint8_t channel_id;
    uint32_t raw_adc_counts;
    uint32_t sample_timestamp_ms;
    uint8_t status_flags;
};

struct SensorBatch {
    uint64_t frame_timestamp_ns;
    uint16_t sequence_id;

    std::vector<RawPTSample> pt_samples;
    std::vector<RawTCSample> tc_samples;
    std::vector<RawRTDSample> rtd_samples;
    std::vector<RawLCSample> lc_samples;
    std::vector<ParsedSelfTestPacket> self_tests;

    bool is_valid;
    std::string error_message;
};

}  // namespace protocol
}  // namespace daq_comms

#endif  // DAQ_ENCRYPTED_FRAME_HPP
