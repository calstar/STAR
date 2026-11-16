// Test-only window into stacklight_service_main.cpp (see svc_config_broadcast.cpp).
#include "svc_bridge.hpp"

#define main stacklight_service_main_unused
#include "../../../diablo_server/services/stacklight/stacklight_service_main.cpp"
#undef main

namespace charsvc {

std::vector<uint8_t> stacklight_state_bytes(uint8_t sequencer_state) {
    const daq::StacklightCommandPacket c = stateToStacklight(sequencer_state);
    return {c.red, c.yellow, c.green, c.buzzer};
}

}  // namespace charsvc
