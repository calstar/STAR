#ifndef FSW_IP_FROM_MAC_HPP
#define FSW_IP_FROM_MAC_HPP

#include <cstdint>
#include <string>

namespace fsw {
namespace util {

/** Deterministic last-octet from MAC string "aa:bb:cc:dd:ee:ff" into base_ip range. */
std::string calculate_ip_from_mac(const std::string& mac_address, const std::string& base_ip,
                                  uint8_t ip_range_start, uint8_t ip_range_end);

}  // namespace util
}  // namespace fsw

#endif
