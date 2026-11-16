// Test-only window into heartbeat_service_main.cpp (see svc_config_broadcast.cpp).
#include "svc_bridge.hpp"

#define main heartbeat_service_main_unused
#include "../../../diablo_server/services/heartbeat/heartbeat_service_main.cpp"
#undef main

namespace charsvc {

std::vector<uint8_t> heartbeat_service_packet(uint8_t engine_state) {
    return buildHeartbeatPacket(engine_state);
}

uint8_t heartbeat_service_state_to_engine(uint8_t sequencer_state) {
    return stateToEngine(sequencer_state);
}

}  // namespace charsvc
