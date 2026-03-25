#include "util/IpFromMac.hpp"

#include <sstream>
#include <string>

namespace fsw {
namespace util {

std::string calculate_ip_from_mac(const std::string& mac_address, const std::string& base_ip,
                                  uint8_t ip_range_start, uint8_t ip_range_end) {
    std::istringstream mac_stream(mac_address);
    std::string byte_str;
    uint32_t mac_hash = 0;
    int byte_count = 0;

    while (std::getline(mac_stream, byte_str, ':') && byte_count < 6) {
        uint8_t byte_val = static_cast<uint8_t>(std::stoul(byte_str, nullptr, 16));
        mac_hash = (mac_hash << 8) | byte_val;
        byte_count++;
    }

    const uint32_t span =
        static_cast<uint32_t>(ip_range_end) - static_cast<uint32_t>(ip_range_start) + 1u;
    uint8_t ip_octet = static_cast<uint8_t>(ip_range_start + (span > 0 ? (mac_hash % span) : 0));

    size_t last_dot = base_ip.rfind('.');
    std::string base = last_dot != std::string::npos ? base_ip.substr(0, last_dot) : base_ip;

    return base + "." + std::to_string(ip_octet);
}

}  // namespace util
}  // namespace fsw
