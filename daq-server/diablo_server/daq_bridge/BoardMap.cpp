#include "BoardMap.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>

#include "config/Config.hpp"
#include "fsw/BoardTypeWire.hpp"
/** Last octet of a dotted IPv4 string (e.g. "192.168.2.51" -> 51), or -1 if not parseable. */
int ipv4_host_octet(const std::string& ip) {
    const auto dot = ip.rfind('.');
    if (dot == std::string::npos || dot + 1 >= ip.size())
        return -1;
    const std::string tail = ip.substr(dot + 1);
    if (tail.empty() || tail.find_first_not_of("0123456789") != std::string::npos)
        return -1;
    const int v = std::atoi(tail.c_str());
    return (v >= 0 && v <= 255) ? v : -1;
}

// Minimal config parse: [database] host/port, [network] sensor_port/bind_ip, [server_heartbeat],
// [boards.xxx] type/ip/enabled
void load_board_map_from_config(const std::string& config_path,
                                std::map<std::string, BoardConfig>& board_map,
                                BoardByOctet* out_board_by_octet, std::string& db_host,
                                uint16_t& db_port, uint16_t* out_sensor_port,
                                std::string* out_bind_ip, ServerHeartbeatConfig* out_hb,
                                fsw::time::TimeSyncConfig* out_ts, uint16_t* out_log_port) {
    db_host = "127.0.0.1";
    db_port = 2240;
    {
        std::ifstream f(config_path);
        if (!f.is_open())
            return;  // missing file → keep defaults, no boards (matches old behavior)
    }

    const fsw::config::Config c = fsw::config::load(config_path);
    db_host = c.database.host;
    db_port = c.database.port;
    if (out_sensor_port)
        *out_sensor_port = c.network.sensor_port;
    if (out_bind_ip)
        *out_bind_ip = c.network.bind_ip;
    if (out_hb) {
        out_hb->interval_ms = c.server_heartbeat.interval_ms;
        out_hb->broadcast_port = c.server_heartbeat.broadcast_port;
        out_hb->broadcast_ip = c.server_heartbeat.broadcast_ip;
        out_hb->send_from_daq_bridge = c.server_heartbeat.send_from_daq_bridge;
    }
    if (out_ts)
        *out_ts = c.time_sync;
    if (out_log_port)
        *out_log_port = c.logs.backend_udp_port;

    auto kind = [](const std::string& t) {
        if (t == "PT")
            return BoardType::PT;
        if (t == "LC")
            return BoardType::LC;
        if (t == "TC")
            return BoardType::TC;
        if (t == "RTD")
            return BoardType::RTD;
        if (t == "ACTUATOR")
            return BoardType::ACTUATOR;
        if (t == "ENCODER")
            return BoardType::ENCODER;
        if (t == "ENVIRONMENTAL")
            return BoardType::ENVIRONMENTAL;
        if (t == "BALL_VALVE")
            return BoardType::BALL_VALVE;
        return BoardType::UNKNOWN;
    };
    for (const auto& b : c.boards) {
        if (b.ip.empty())
            continue;
        BoardType bt = kind(b.type);
        if (bt == BoardType::UNKNOWN)
            continue;
        BoardConfig bc{bt, b.ip, static_cast<int>(b.active_connectors.size()), b.enabled,
                       b.board_id};
        board_map[b.ip] = bc;
        // Index the board by its config-IP host octet for the loopback fallback (see BoardByOctet).
        if (out_board_by_octet && b.enabled) {
            const int octet = ipv4_host_octet(b.ip);
            if (octet >= 2) {
                auto [it, inserted] = out_board_by_octet->emplace(octet, bc);
                if (!inserted)
                    std::cerr << "[Config] WARN: loopback host octet " << octet << " (127.0.0."
                              << octet << ") is claimed by both [" << it->second.ip << "] and ["
                              << b.ip
                              << "]; keeping the first. Give boards config IPs with distinct "
                                 "last octets."
                              << std::endl;
            }
        }
    }
    // NOTE: do NOT add 127.0.0.1→PT. When the simulator can't bind config IPs it binds
    // 127.0.0.<host octet> (one per board); resolve_board_config_by_source_ip maps that back.
}

// Map discovery signature board_type (DAQv2 wire: 1=PT, 2=LC, 3=RTD, 4=TC, 5=ACT, 6=ENC, 7=ENV,
// 8=BALL_VALVE)
BoardType discovery_board_type_to_enum(uint8_t t) {
    switch (t) {
        case fsw::daq_wire::kPressureTransducer:
            return BoardType::PT;
        case fsw::daq_wire::kLoadCell:
            return BoardType::LC;
        case fsw::daq_wire::kRtd:
            return BoardType::RTD;
        case fsw::daq_wire::kThermocouple:
            return BoardType::TC;
        case fsw::daq_wire::kActuator:
            return BoardType::ACTUATOR;
        case 6:
            return BoardType::ENCODER;
        case fsw::daq_wire::kEnvironmental:
            return BoardType::ENVIRONMENTAL;
        case fsw::daq_wire::kBallValve:
            return BoardType::BALL_VALVE;
        default:
            return BoardType::UNKNOWN;
    }
}

uint8_t config_board_type_to_wire_u8(BoardType t) {
    switch (t) {
        case BoardType::PT:
            return fsw::daq_wire::kPressureTransducer;
        case BoardType::LC:
            return fsw::daq_wire::kLoadCell;
        case BoardType::RTD:
            return fsw::daq_wire::kRtd;
        case BoardType::TC:
            return fsw::daq_wire::kThermocouple;
        case BoardType::ACTUATOR:
            return fsw::daq_wire::kActuator;
        case BoardType::ENCODER:
            return 6;
        case BoardType::ENVIRONMENTAL:
            return fsw::daq_wire::kEnvironmental;
        case BoardType::BALL_VALVE:
            return fsw::daq_wire::kBallValve;
        default:
            return fsw::daq_wire::kUnknown;
    }
}

/**
 * Resolve a packet's source IP to its config board. Real deployments send from the config IP, so
 * the direct board_map lookup hits. The integration test can't bind the 192.168.2.* config IPs, so
 * the simulator binds each board to 127.0.0.<host-octet> (the last octet of its config IP); those
 * packets resolve by that octet via board_by_octet. This is identity-based — unlike the old
 * index-based scheme it does NOT depend on the bridge and the sim iterating [boards] in the same
 * order, which they don't (toml++ sorts alphabetically; the Python sim uses file order).
 */
const BoardConfig* resolve_board_config_by_source_ip(
    const std::string& source_ip, const std::map<std::string, BoardConfig>& board_map,
    const BoardByOctet& board_by_octet) {
    auto it = board_map.find(source_ip);
    if (it != board_map.end() && it->second.enabled)
        return &it->second;
    if (source_ip.compare(0, 8, "127.0.0.") == 0) {
        const int octet = ipv4_host_octet(source_ip);
        if (octet >= 2) {
            auto bo = board_by_octet.find(octet);
            if (bo != board_by_octet.end() && bo->second.enabled)
                return &bo->second;
        }
    }
    return nullptr;
}
