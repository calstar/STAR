#pragma once

#include <chrono>
#include <cstdint>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#include "elodin/ElodinClient.hpp"

namespace fsw {
namespace data_logger {

struct ChannelInfo {
    std::string name;
    int slog_idx;
    uint32_t value_offset;
    enum class Type { U8, U32, F32, U64 } type;
};

class DataLoggerService {
public:
    DataLoggerService();
    ~DataLoggerService();

    bool initialize(const std::string& config_path);
    void run();

private:
    void start_logging();
    void stop_logging();
    void process_packet(const std::array<uint8_t, 2>& packet_id, const uint8_t* payload,
                        size_t len);

    // Helpers for .sensorlog format
    void write_header();
    void write_record(uint32_t offset_ms, uint16_t channel_idx, double value);

    fsw::elodin::ElodinClient elodin_client_;
    std::string db_host_ = "127.0.0.1";
    uint16_t db_port_ = 2240;

    // Logging state
    bool is_logging_ = false;
    std::ofstream log_file_;
    std::string current_filepath_;
    uint64_t start_time_ms_ = 0;

    // Mapping
    std::map<std::pair<uint8_t, uint8_t>, ChannelInfo> channel_map_;
    std::vector<std::string> active_channels_;

    // State tracking
    uint8_t last_sequencer_state_ = 0;
};

}  // namespace data_logger
}  // namespace fsw
