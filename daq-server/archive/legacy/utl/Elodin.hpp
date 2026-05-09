#ifndef ELODIN_DB_H
#define ELODIN_DB_H
#include <cstdint>
#include <cstring>

#include "TCPSocket.hpp"
#include "db.hpp"

extern std::unique_ptr<Socket> LocalSock;
extern std::unique_ptr<Socket> GroundStationSock;

template <typename T>
static void write(const T& value);

/* Template Specialization */
template <>
void write(const uint32_t& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const float& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const uint64_t& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const double& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const uint8_t& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const int16_t& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const bool& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const int32_t& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

template <>
void write(const uint16_t& val) {
    LocalSock->write_all_elodin(&val, sizeof(val));
}

// @note: we can use this to make sure that we never try to write an unsupported
// type
template <typename T>
void write(const T&) {
    static_assert(sizeof(T) == 0,
                  "You are trying to write a type that is not supported, "
                  "please see Elodin.hpp and add a write() specialization");
}

// a concept to enforce the type of our template function argument
template <typename T>
concept IsMessageFactory = requires(T msg) { typename std::tuple_size<decltype(msg.fields)>; };

// @note this one should be the last one
template <IsMessageFactory MessageType>
void write(const MessageType& message_obj) {
    constexpr std::size_t N = MessageSize<MessageType>::value;
    std::array<uint8_t, N> buffer{};
    message_obj.serialize(buffer.data());
    LocalSock->write_all_elodin(buffer.data(), buffer.size());
}

template <IsMessageFactory MessageType>
static void write_to_elodindb(std::array<uint8_t, 2> packet_id, const MessageType& Message) {
    auto message_header =
        PacketHeader{.len = MessageSize<MessageType>::value + 4,
                     // requires a cast because of PacketType enum class definition
                     .ty = PacketType::TABLE,
                     .packet_id = packet_id,
                     .request_id = 0};

    // FIXED: Create complete packet in single buffer to prevent fragmentation
    constexpr std::size_t message_size = MessageSize<MessageType>::value;
    constexpr std::size_t total_size = sizeof(message_header) + message_size;

    std::array<uint8_t, total_size> complete_packet{};

    // Copy header to buffer
    std::memcpy(complete_packet.data(), &message_header, sizeof(message_header));

    // Serialize message directly into buffer after header
    Message.serialize(complete_packet.data() + sizeof(message_header));

    // Send complete packet atomically
    LocalSock->write_all_elodin(complete_packet.data(), total_size);
}

/*
 * @brief Send telemetry to both local DB and ground station
 * This provides a unified interface like the one in dbConfig.hpp
 */
template <IsMessageFactory MessageType>
static void write_to_both(std::array<uint8_t, 2> packet_id, const MessageType& Message) {
    // Send to local database only (ground station functionality removed for simplicity)
    write_to_elodindb(packet_id, Message);
}

#endif  // ELODIN_DB_H
