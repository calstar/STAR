// Test-only re-exports of encoders that live inside service main() TUs (anonymous namespaces).
// Each svc_*.cpp compiles one *_main.cpp with main renamed and forwards to its builders.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace charsvc {

struct BuiltPacket {
    uint8_t type;
    std::vector<uint8_t> bytes;
    std::string ip;
    uint16_t port;
};

// config_broadcast_service_main.cpp
std::vector<BuiltPacket> config_broadcast_build(const std::string& config_path);
uint32_t config_broadcast_ip_le(const std::string& ip);

// heartbeat_service_main.cpp
std::vector<uint8_t> heartbeat_service_packet(uint8_t engine_state);
uint8_t heartbeat_service_state_to_engine(uint8_t sequencer_state);

// stacklight_service_main.cpp
std::vector<uint8_t> stacklight_state_bytes(uint8_t sequencer_state);  // r, y, g, buzzer

// daq_bridge_main.cpp
std::vector<uint8_t> daq_bridge_server_heartbeat();
int daq_bridge_discovery_type_to_kind(uint8_t wire_type);
uint8_t daq_bridge_kind_to_wire(int kind);
int daq_bridge_ipv4_host_octet(const std::string& ip);
/** The board ids daq_bridge registers heartbeat / self-test tables for, built exactly as its
 *  main() does: load_board_map_from_config(), then enabled boards with 0 < id <= 254, in
 *  board_map (IP string) order. */
std::vector<uint8_t> daq_bridge_config_board_ids(const std::string& config_path);
/** Sends one envelope through BackendLogForwarder to 127.0.0.1:port. */
void daq_bridge_forward_log(uint16_t port, uint8_t board_id, uint8_t flags, const uint8_t* text,
                            uint16_t text_len);

}  // namespace charsvc
