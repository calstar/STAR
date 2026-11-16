// Test-only window into config_broadcast_service_main.cpp: its packet builder lives in an
// anonymous namespace of a TU that also defines main(), so the file is compiled here with main
// renamed, and the builder is re-exported. No production code is changed.
#include "svc_bridge.hpp"

#define main config_broadcast_service_main_unused
#include "../../../diablo_server/services/config_broadcast/config_broadcast_service_main.cpp"
#undef main

namespace charsvc {

std::vector<BuiltPacket> config_broadcast_build(const std::string& config_path) {
    std::vector<BuiltPacket> out;
    for (const auto& [type, bytes, ip, port] : buildPackets(config_path))
        out.push_back({type, bytes, ip, port});
    return out;
}

uint32_t config_broadcast_ip_le(const std::string& ip) {
    return ipToU32Le(ip);
}

}  // namespace charsvc
