#include "data_logger/DataLoggerService.hpp"
#include "time/MonotonicTime.hpp"
#include <iostream>
#include <iomanip>
#include <sstream>
#include <cstring>
#include <cmath>
#include <filesystem>
#include <thread>

namespace fsw {
namespace data_logger {

DataLoggerService::DataLoggerService() : elodin_client_() {}

DataLoggerService::~DataLoggerService() {
    stop_logging();
}

bool DataLoggerService::initialize(const std::string& config_path) {
    // 1. Connect to Elodin DB
    if (!elodin_client_.connect(db_host_, db_port_)) {
        std::cerr << "[DataLogger] ❌ Failed to connect to Elodin DB at " << db_host_ << ":" << db_port_ << std::endl;
        return false;
    }

    // 2. Subscribe to all streams (ElodinClient::subscribe_stream() takes no arguments)
    elodin_client_.subscribe_stream();

    // 3. Setup mappings for all calibrated sensors
    // PT Calibrated (0x20, 0x11..0x1E)
    for (int ch = 1; ch <= 14; ch++) {
        uint8_t packet_ch = 0x10 + ch;
        channel_map_[{0x20, packet_ch}] = {"PT.CH" + std::to_string(ch), 0, 12, ChannelInfo::Type::F32};
    }
    // TC Calibrated (0x21, 0x11..0x24)
    for (int ch = 1; ch <= 20; ch++) {
        uint8_t packet_ch = 0x10 + ch;
        channel_map_[{0x21, packet_ch}] = {"TC.CH" + std::to_string(ch), 0, 12, ChannelInfo::Type::F32};
    }
    // RTD Calibrated (0x22, 0x11..0x24)
    for (int ch = 1; ch <= 20; ch++) {
        uint8_t packet_ch = 0x10 + ch;
        channel_map_[{0x22, packet_ch}] = {"RTD.CH" + std::to_string(ch), 0, 12, ChannelInfo::Type::F32};
    }
    // LC Calibrated (0x23, 0x11..0x1A)
    for (int ch = 1; ch <= 10; ch++) {
        uint8_t packet_ch = 0x10 + ch;
        channel_map_[{0x23, packet_ch}] = {"LC.CH" + std::to_string(ch), 0, 12, ChannelInfo::Type::F32};
    }
    // Actuator State (0x31, 1..20)
    for (int ch = 1; ch <= 20; ch++) {
        channel_map_[{0x31, (uint8_t)ch}] = {"ACT.CH" + std::to_string(ch), 0, 9, ChannelInfo::Type::U8};
    }

    // Build active_channels list for SLOG header
    active_channels_.push_back("PSM.state"); // Index 0 for PSM.state to match Python legacy
    for (auto& [id, info] : channel_map_) {
        info.slog_idx = active_channels_.size();
        active_channels_.push_back(info.name);
    }

    std::cout << "[DataLogger] Ready to log " << active_channels_.size() << " channels" << std::endl;
    return true;
}

void DataLoggerService::run() {
    uint8_t buffer[2048];
    while (true) {
        // ElodinClient::read_packet returns total length (header+payload), 0 if no data, -1 on error
        ssize_t n = elodin_client_.read_packet(buffer, sizeof(buffer));
        if (n > 8) {
            // Header is 8 bytes: len(4), ty(1), packet_id(2), request_id(1)
            std::array<uint8_t, 2> packet_id = {buffer[5], buffer[6]};
            process_packet(packet_id, buffer + 8, n - 8);
        } else if (n < 0) {
            // Error - handle reconnect?
            std::cerr << "[DataLogger] Read error: " << elodin_client_.last_error() << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(1));
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void DataLoggerService::start_logging() {
    if (is_logging_) return;

    namespace fs = std::filesystem;
    fs::create_directories("data/runs");

    auto now = std::chrono::system_clock::now();
    auto in_time_t = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << "data/runs/run_" << std::put_time(std::localtime(&in_time_t), "%Y-%m-%d_%H-%M-%S") << ".sensorlog";
    current_filepath_ = ss.str();

    log_file_.open(current_filepath_, std::ios::binary);
    if (!log_file_.is_open()) {
        std::cerr << "[DataLogger] ❌ Failed to open log file: " << current_filepath_ << std::endl;
        return;
    }

    start_time_ms_ = fsw::time::monotonic_ns() / 1000000ULL;
    is_logging_ = true;
    
    write_header();
    std::cout << "[DataLogger] Started → " << current_filepath_ << std::endl;
}

void DataLoggerService::stop_logging() {
    if (!is_logging_) return;

    // The .sensorlog format requires prepending the channel list at the end (or rewriting).
    // Our write_header() currently writes a minimal header.
    // To match the Python implementation perfectly, we'll rewrite the file with the full header.
    log_file_.close();
    
    // Rewrite with full header
    std::ifstream in(current_filepath_, std::ios::binary);
    std::vector<uint8_t> data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    in.close();

    // Skip the placeholder 16-byte header written in write_header()
    size_t old_header_size = 4 + 2 + 8 + 2; 
    std::vector<uint8_t> records(data.begin() + old_header_size, data.end());

    log_file_.open(current_filepath_, std::ios::binary | std::ios::trunc);
    write_header(); // This time with full channel list
    log_file_.write((char*)records.data(), records.size());
    log_file_.close();

    is_logging_ = false;
    std::cout << "[DataLogger] Stopped logging to " << current_filepath_ << std::endl;
}

void DataLoggerService::process_packet(const std::array<uint8_t, 2>& packet_id, const uint8_t* payload, size_t len) {
    // 1. Handle Sequencer State [0x50, 0x00]
    if (packet_id[0] == 0x50 && packet_id[1] == 0x00) {
        if (len < 9) return;
        uint8_t current_state = payload[8];
        if (current_state == 4 && !is_logging_) { // ARMED
            start_logging();
        } else if ((current_state == 0 || current_state == 6) && is_logging_) { // IDLE or ABORT
            stop_logging();
        }
        
        if (is_logging_) {
            uint32_t offset_ms = (fsw::time::monotonic_ns() / 1000000ULL) - start_time_ms_;
            write_record(offset_ms, active_channels_.size() - 1, (double)current_state);
        }
        last_sequencer_state_ = current_state;
        return;
    }

    // 2. Handle Sensor Packets
    if (!is_logging_) return;

    auto it = channel_map_.find({packet_id[0], packet_id[1]});
    if (it != channel_map_.end()) {
        const auto& info = it->second;
        if (len < info.value_offset + 1) return;

        double val = 0;
        if (info.type == ChannelInfo::Type::F32) {
            float fval;
            std::memcpy(&fval, payload + info.value_offset, 4);
            val = (double)fval;
        } else if (info.type == ChannelInfo::Type::U8) {
            val = (double)payload[info.value_offset];
        }

        uint32_t offset_ms = (fsw::time::monotonic_ns() / 1000000ULL) - start_time_ms_;
        write_record(offset_ms, info.slog_idx, val);
    }
}

void DataLoggerService::write_header() {
    // MAGIC
    log_file_.write("SLOG", 4);
    // VERSION (1)
    uint16_t version = 1;
    log_file_.write((char*)&version, 2);
    // Start Time (double ms)
    double start_time = (double)start_time_ms_;
    log_file_.write((char*)&start_time, 8);
    
    // Channel list (if file is closed and we are rewriting, this will be non-empty)
    uint16_t ch_count = is_logging_ ? 0 : active_channels_.size();
    log_file_.write((char*)&ch_count, 2);
    
    if (!is_logging_) {
        for (const auto& name : active_channels_) {
            uint16_t name_len = (uint16_t)name.length();
            log_file_.write((char*)&name_len, 2);
            log_file_.write(name.c_str(), name_len);
        }
    }
    log_file_.flush();
}

void DataLoggerService::write_record(uint32_t offset_ms, uint16_t channel_idx, double value) {
    if (!log_file_.is_open()) return;
    
    log_file_.write((char*)&offset_ms, 4);
    log_file_.write((char*)&channel_idx, 2);
    log_file_.write((char*)&value, 8);
}

} // namespace data_logger
} // namespace fsw
