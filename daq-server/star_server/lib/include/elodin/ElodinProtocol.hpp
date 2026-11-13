#ifndef DAQ_ELODIN_PROTOCOL_HPP
#define DAQ_ELODIN_PROTOCOL_HPP

#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace fsw {
namespace elodin {

// Elodin packet types
enum class PacketType : uint8_t { MSG = 0, TABLE = 1, TIME_SERIES = 2 };

// Packet header structure
struct PacketHeader {
    uint32_t len;                      // Length of payload + 4
    PacketType ty;                     // Packet type
    std::array<uint8_t, 2> packet_id;  // Packet identifier
    uint8_t request_id;                // Request ID (usually 0)
};

// Hash functions for Elodin IDs (FNV-1a)
inline uint32_t fnv1a_hash_32(std::string_view str) {
    uint32_t hash = 0x811c9dc5;
    size_t i = 0;
    for (auto c : str) {
        if (++i >= 32)
            break;
        hash ^= static_cast<uint8_t>(c);
        hash *= 0x01000193;
    }
    return hash;
}

inline uint64_t fnv1a_hash_64(std::string_view str) {
    uint64_t hash = 0xcbf29ce484222325;
    size_t i = 0;
    for (auto c : str) {
        if (++i >= 64)
            break;
        hash ^= static_cast<uint8_t>(c);
        hash *= 0x00000100000001B3;
    }
    return hash;
}

inline uint16_t fnv1a_hash_16_xor(std::string_view str) {
    auto hash = fnv1a_hash_32(str);
    uint16_t upper = static_cast<uint16_t>((hash >> 16) & 0xFFFF);
    uint16_t lower = static_cast<uint16_t>(hash & 0xFFFF);
    return upper ^ lower;
}

inline std::array<uint8_t, 2> msg_id(std::string_view str) {
    auto hash = fnv1a_hash_16_xor(str);
    return {static_cast<uint8_t>(hash & 0xff), static_cast<uint8_t>((hash >> 8) & 0xff)};
}

inline uint64_t component_id(std::string_view str) {
    auto hash = fnv1a_hash_64(str) & ~(1ul << 63);
    return hash;
}

}  // namespace elodin
}  // namespace fsw

#endif  // DAQ_ELODIN_PROTOCOL_HPP
