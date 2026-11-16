// Test-only window into daq_bridge_main.cpp (see svc_config_broadcast.cpp).
#include "svc_bridge.hpp"

#define main daq_bridge_main_unused
#include "../../../diablo_server/daq_bridge/daq_bridge_main.cpp"
#undef main

namespace charsvc {

std::vector<uint8_t> daq_bridge_server_heartbeat() {
    return build_server_heartbeat_packet();
}

int daq_bridge_discovery_type_to_kind(uint8_t wire_type) {
    return static_cast<int>(discovery_board_type_to_enum(wire_type));
}

uint8_t daq_bridge_kind_to_wire(int kind) {
    return config_board_type_to_wire_u8(static_cast<BoardType>(kind));
}

int daq_bridge_ipv4_host_octet(const std::string& ip) {
    return ipv4_host_octet(ip);
}

std::vector<uint8_t> daq_bridge_config_board_ids(const std::string& config_path) {
    std::map<std::string, BoardConfig> board_map;
    BoardByOctet by_octet;
    std::string db_host;
    uint16_t db_port = 0;
    load_board_map_from_config(config_path, board_map, &by_octet, db_host, db_port);
    std::vector<uint8_t> config_board_ids;
    for (const auto& [ip, cfg] : board_map) {
        if (cfg.enabled && cfg.board_id > 0 && cfg.board_id <= 254)
            config_board_ids.push_back(static_cast<uint8_t>(cfg.board_id));
    }
    return config_board_ids;
}

void daq_bridge_forward_log(uint16_t port, uint8_t board_id, uint8_t flags, const uint8_t* text,
                            uint16_t text_len) {
    BackendLogForwarder f("127.0.0.1", port);
    f.forward(board_id, flags, text, text_len);
}

}  // namespace charsvc
