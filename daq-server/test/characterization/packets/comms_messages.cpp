// Characterization: the server-side message types in diablo_server/transport/include/comms/**
// (every `using X = CommsMessage<...>`), the Elodin TABLE frame ElodinClient::serialize_msg wraps
// them in, the host-side sample structs in protocol/EncryptedFrame.hpp, the Elodin header and id
// hashes in ElodinProtocol.hpp, and fsw/BoardTypeWire.hpp. Golden: comms_messages.txt.
//
// For a CommsMessage the contract is the serialized (packed, host-order) layout, so that is what
// is frozen: MessageSize, alignof, and per field its serialized offset, size, type, the value of a
// known-valued instance and its bytes. sizeof(CommsMessage) is a std::tuple's size, which libc++
// and libstdc++ lay out differently, so it is deliberately not frozen.
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <tuple>
#include <type_traits>
#include <utility>
#include <vector>

// The top-level comms/*.hpp headers define unused static helpers (generateTestMessage*, ...);
// their -Wunused-function noise is not this test's to report.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#include "comms/BarometerMessage.hpp"
#include "comms/CalibrationMessage.hpp"
#include "comms/CommsMessage.hpp"
#include "comms/EngineControlMessage.hpp"
#include "comms/GPSMessage.hpp"
#include "comms/IMUMessage.hpp"
#include "comms/NavigationMessage.hpp"
#include "comms/PTMessage.hpp"
#include "comms/RTDMessage.hpp"
#include "comms/SystemHealthMessage.hpp"
#include "comms/TCMessage.hpp"
#include "comms/ValveControlMessage.hpp"
#pragma GCC diagnostic pop
#include "comms/messages/board/BoardHeartbeatMessage.hpp"
#include "comms/messages/control/ControlMessages.hpp"
#include "comms/messages/control/ControllerMessages.hpp"
#include "comms/messages/filtered/FilteredMessages.hpp"
#include "comms/messages/flight/FlightMessages.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/CalibratedSensorMessages.hpp"
#include "comms/messages/sensor/EnvironmentalMessage.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"
#include "comms/messages/sensor/T7Messages.hpp"
#include "config/BoardDiscovery.hpp"
#include "daq-protocol.h"
#include "elodin/ElodinClient.hpp"
#include "elodin/ElodinProtocol.hpp"
#include "fsw/BoardTypeWire.hpp"
#include "golden.hpp"
#include "protocol/EncryptedFrame.hpp"

using chargold::hex;
using chargold::Out;

namespace {

// ── portable type names (never typeid: mangling differs between toolchains) ──
template <typename T>
struct TN;
#define TN_(T, s)                   \
    template <>                     \
    struct TN<T> {                  \
        static std::string name() { \
            return s;               \
        }                           \
    }
TN_(uint8_t, "u8");
TN_(uint16_t, "u16");
TN_(uint32_t, "u32");
TN_(uint64_t, "u64");
TN_(int8_t, "i8");
TN_(int16_t, "i16");
TN_(int32_t, "i32");
TN_(int64_t, "i64");
TN_(float, "f32");
TN_(double, "f64");
TN_(bool, "bool");
TN_(char, "char");
TN_(fsw::elodin::PacketType, "elodin::PacketType(u8)");
#undef TN_
template <typename T, size_t N>
struct TN<std::array<T, N>> {
    static std::string name() {
        return "array<" + TN<T>::name() + "," + std::to_string(N) + ">";
    }
};
template <typename... Ts>
struct TN<comms::CommsMessage<Ts...>> {
    static std::string name() {
        std::string s = "msg{";
        ((s += TN<Ts>::name() + ","), ...);
        return s + "}";
    }
};

template <typename T>
struct is_msg : std::false_type {};
template <typename... Ts>
struct is_msg<comms::CommsMessage<Ts...>> : std::true_type {};
template <typename T>
struct is_arr : std::false_type {};
template <typename T, size_t N>
struct is_arr<std::array<T, N>> : std::true_type {};

/** A known value for field `seed`: integers carry their seed in every byte (LE bytes
 *  seed*16+0, +1, ...), floats a short exact binary fraction. */
template <typename T>
void fill(T& v, unsigned seed) {
    if constexpr (is_msg<T>::value) {
        unsigned k = 0;
        std::apply(
            [&](auto&... f) {
                ((fill(f, seed * 8 + k++)), ...);
            },
            v.fields);
    } else if constexpr (is_arr<T>::value) {
        unsigned k = 0;
        for (auto& e : v)
            fill(e, seed * 4 + k++);
    } else if constexpr (std::is_same_v<T, bool>) {
        v = (seed % 2) == 0;
    } else if constexpr (std::is_same_v<T, float>) {
        v = 1.5f + 0.25f * static_cast<float>(seed % 64);
    } else if constexpr (std::is_same_v<T, double>) {
        v = -2.5 + 0.125 * static_cast<double>(seed % 64);
    } else if constexpr (std::is_enum_v<T>) {
        v = static_cast<T>(1);
    } else {
        using U = std::make_unsigned_t<T>;
        U u = 0;
        for (size_t j = 0; j < sizeof(T); ++j)
            u |= static_cast<U>(static_cast<U>(((seed & 0x0F) << 4) + j) << (8 * j));
        v = static_cast<T>(u);
    }
}

template <typename T>
std::string val(const T& v) {
    if constexpr (is_msg<T>::value) {
        std::string s = "{";
        std::apply(
            [&](const auto&... f) {
                ((s += val(f) + ","), ...);
            },
            v.fields);
        return s + "}";
    } else if constexpr (is_arr<T>::value) {
        std::string s = "[";
        for (const auto& e : v)
            s += val(e) + ",";
        return s + "]";
    } else if constexpr (std::is_floating_point_v<T>) {
        return chargold::fstr(v);
    } else if constexpr (std::is_same_v<T, bool>) {
        return v ? "true" : "false";
    } else if constexpr (std::is_enum_v<T>) {
        return std::to_string(static_cast<int>(v));
    } else if constexpr (std::is_signed_v<T>) {
        return std::to_string(static_cast<long long>(v));
    } else {
        return chargold::hexu(static_cast<uint64_t>(v), static_cast<int>(sizeof(T) * 2));
    }
}

template <typename M>
void dump_msg(Out& o, const std::string& name, uint16_t table_id) {
    M m;
    fill(m, 1);
    constexpr size_t n = MessageSize<M>::value;
    static_assert(n == M::nbytes(), "MessageSize and nbytes disagree");
    std::vector<uint8_t> bytes(n, 0xCD);
    m.serialize(bytes.data());

    o.line("message " + name + " fields=" + std::to_string(std::tuple_size_v<decltype(m.fields)>) +
           " MessageSize=" + std::to_string(n) + " alignof=" + std::to_string(alignof(M)));
    size_t off = 0, idx = 0;
    std::apply(
        [&](const auto&... f) {
            (([&] {
                 using T = std::decay_t<decltype(f)>;
                 const size_t sz = MessageSize<T>::value;
                 o.line("  [" + std::to_string(idx) + "] " + TN<T>::name() + " @" +
                        std::to_string(off) + " +" + std::to_string(sz) + " = " + val(f));
                 o.line("      bytes: " + hex(bytes.data() + off, sz));
                 off += sz;
                 ++idx;
             }()),
             ...);
        },
        m.fields);
    o.line("  serialized_total=" + std::to_string(off));

    // Round trip through deserialize (memcpy per top-level field, not flattening).
    M back;
    back.deserialize(bytes.data());
    std::vector<uint8_t> again(n, 0xCD);
    back.serialize(again.data());
    o.line(std::string("  deserialize(serialize(x)) reserializes identically: ") +
           (again == bytes ? "yes" : "NO"));

    // The TABLE frame the backend receives: [len u32][ty u8][id hi,lo][req u8][body].
    fsw::elodin::ElodinClient client;
    auto frame = client.serialize_msg(table_id, m);
    o.line("  elodin frame id=" + chargold::hexu(table_id, 4) +
           " len=" + std::to_string(frame.size()));
    o.fields(frame.data(), frame.size(),
             {{"frame.len", 4}, {"frame.ty", 1}, {"frame.packet_id", 2}, {"frame.request_id", 1}});
    const bool body_same =
        frame.size() == 8 + n && std::equal(bytes.begin(), bytes.end(), frame.begin() + 8);
    // (the body bytes are the field bytes above; only whether they match is printed)
    o.line(std::string("  frame body == serialize(): ") + (body_same ? "yes" : "NO"));
}

#define LAYOUT(T)                                                                 \
    o.line(std::string("struct ") + #T + " sizeof=" + std::to_string(sizeof(T)) + \
           " alignof=" + std::to_string(alignof(T)))
#define FIELD(T, f)                                                               \
    o.line(std::string("  ") + #f + " offset=" + std::to_string(offsetof(T, f)) + \
           " size=" + std::to_string(sizeof(static_cast<T*>(nullptr)->f)))

}  // namespace

int main() {
    Out o;
    o.line(
        "# transport/include/comms message types: serialized layout and a known-valued instance");
    o.line("# (field k of a message is filled from seed k; integers repeat (seed&15)<<4 + byte#).");
    using namespace comms::messages;
    dump_msg<::BarometerMessage>(o, "BarometerMessage", 0x0100);
    dump_msg<::CalibrationMessage>(o, "CalibrationMessage", 0x0101);
    dump_msg<::EngineControlMessage>(o, "EngineControlMessage", 0x0102);
    dump_msg<::GPSPositionMessage>(o, "GPSPositionMessage", 0x0103);
    dump_msg<::GPSVelocityMessage>(o, "GPSVelocityMessage", 0x0104);
    dump_msg<::IMUMessage>(o, "IMUMessage", 0x0105);
    dump_msg<::NavigationMessage>(o, "NavigationMessage (global)", 0x0106);
    dump_msg<::PTMessage>(o, "PTMessage", 0x0107);
    dump_msg<::RTDMessage>(o, "RTDMessage", 0x0108);
    dump_msg<::SystemHealthMessage>(o, "SystemHealthMessage", 0x0109);
    dump_msg<::TCMessage>(o, "TCMessage", 0x010A);
    dump_msg<::ValveControlMessage>(o, "ValveControlMessage", 0x010B);
    dump_msg<board::BoardHeartbeatElodinMessage>(o, "board::BoardHeartbeatElodinMessage", 0x1015);
    dump_msg<control::ActuatorCommandMessage>(o, "control::ActuatorCommandMessage", 0x3201);
    dump_msg<control::ControlStateMessage>(o, "control::ControlStateMessage", 0x0200);
    dump_msg<control::ControllerActuationMessage>(o, "control::ControllerActuationMessage", 0x4000);
    dump_msg<control::ControllerDiagnosticsMessage>(o, "control::ControllerDiagnosticsMessage",
                                                    0x4100);
    dump_msg<control::ControllerMeasurementMessage>(o, "control::ControllerMeasurementMessage",
                                                    0x4200);
    dump_msg<control::ControllerStateTransitionMessage>(
        o, "control::ControllerStateTransitionMessage", 0x4300);
    dump_msg<control::ControllerFireStateMessage>(o, "control::ControllerFireStateMessage", 0x4400);
    dump_msg<filtered::CalibratedPTMessage>(o, "filtered::CalibratedPTMessage", 0x0300);
    dump_msg<filtered::CalibratedTCMessage>(o, "filtered::CalibratedTCMessage", 0x0301);
    dump_msg<filtered::FilteredStateMessage>(o, "filtered::FilteredStateMessage", 0x0302);
    dump_msg<flight::NavigationMessage>(o, "flight::NavigationMessage", 0x0400);
    dump_msg<flight::AttitudeMessage>(o, "flight::AttitudeMessage", 0x0401);
    dump_msg<sensor::RawPTMessage>(o, "sensor::RawPTMessage", 0x2001);
    dump_msg<sensor::RawTCMessage>(o, "sensor::RawTCMessage", 0x2101);
    dump_msg<sensor::RawRTDMessage>(o, "sensor::RawRTDMessage", 0x2201);
    dump_msg<sensor::RawLCMessage>(o, "sensor::RawLCMessage", 0x2301);
    dump_msg<sensor::ActuatorStateMessage>(o, "sensor::ActuatorStateMessage", 0x3101);
    dump_msg<sensor::CalibratedPTMessage>(o, "sensor::CalibratedPTMessage", 0x2011);
    dump_msg<sensor::CalibratedTCMessage>(o, "sensor::CalibratedTCMessage", 0x2111);
    dump_msg<sensor::CalibratedRTDMessage>(o, "sensor::CalibratedRTDMessage", 0x2211);
    dump_msg<sensor::CalibratedLCMessage>(o, "sensor::CalibratedLCMessage", 0x2311);
    dump_msg<sensor::CalibratedACTMessage>(o, "sensor::CalibratedACTMessage", 0x3111);
    dump_msg<sensor::CalibratedValvePositionMessage>(o, "sensor::CalibratedValvePositionMessage",
                                                     0x3411);
    dump_msg<sensor::EnvironmentalMessage>(o, "sensor::EnvironmentalMessage", 0x2515);
    dump_msg<sensor::T7RawMessage>(o, "sensor::T7RawMessage", 0x2601);
    dump_msg<sensor::T7CalibratedMessage>(o, "sensor::T7CalibratedMessage", 0x2611);
    // daq_bridge publishes SELF_TEST with an ad-hoc type spelled inline.
    dump_msg<comms::CommsMessage<uint64_t, uint8_t, uint8_t>>(
        o, "daq_bridge SelfTestElodinMsg CommsMessage<u64,u8,u8>", 0x6015);

    o.line("");
    o.line("# protocol/EncryptedFrame.hpp host-side structs");
    using namespace daq_comms::protocol;
    LAYOUT(RawPTSample);
    FIELD(RawPTSample, channel_id);
    FIELD(RawPTSample, raw_adc_counts);
    FIELD(RawPTSample, sample_timestamp_ms);
    FIELD(RawPTSample, status_flags);
    LAYOUT(RawTCSample);
    FIELD(RawTCSample, channel_id);
    FIELD(RawTCSample, raw_adc_counts);
    FIELD(RawTCSample, sample_timestamp_ms);
    FIELD(RawTCSample, status_flags);
    LAYOUT(RawRTDSample);
    FIELD(RawRTDSample, channel_id);
    FIELD(RawRTDSample, raw_resistance_counts);
    FIELD(RawRTDSample, sample_timestamp_ms);
    FIELD(RawRTDSample, status_flags);
    LAYOUT(RawLCSample);
    FIELD(RawLCSample, channel_id);
    FIELD(RawLCSample, raw_adc_counts);
    FIELD(RawLCSample, sample_timestamp_ms);
    FIELD(RawLCSample, status_flags);
    LAYOUT(ParsedSelfTestPacket::Result);
    FIELD(ParsedSelfTestPacket::Result, sensor_id);
    FIELD(ParsedSelfTestPacket::Result, result);
    {
        ParsedSelfTestPacket p;
        o.line("ParsedSelfTestPacket defaults: packet_type=" + std::to_string(p.packet_type) +
               " version=" + std::to_string(p.version) + " timestamp=" +
               std::to_string(p.timestamp) + " adc_good=" + std::to_string(p.adc_good) +
               " num_sensors=" + std::to_string(p.num_sensors) +
               " is_valid=" + std::to_string(p.is_valid));
    }

    o.line("");
    o.line("# elodin/ElodinProtocol.hpp");
    LAYOUT(fsw::elodin::PacketHeader);
    FIELD(fsw::elodin::PacketHeader, len);
    FIELD(fsw::elodin::PacketHeader, ty);
    FIELD(fsw::elodin::PacketHeader, packet_id);
    FIELD(fsw::elodin::PacketHeader, request_id);
    o.line("PacketType MSG=" + std::to_string(int(fsw::elodin::PacketType::MSG)) +
           " TABLE=" + std::to_string(int(fsw::elodin::PacketType::TABLE)) +
           " TIME_SERIES=" + std::to_string(int(fsw::elodin::PacketType::TIME_SERIES)));
    for (const char* s : {"VTableMsg", "VTableStream", "SetComponentMetadata", "SetEntityMetadata",
                          "MsgStream", "GetEarliestTimestamp", "ErrorResponse", "", "a",
                          "a-name-longer-than-thirty-two-characters-for-the-cutoff"}) {
        auto id = fsw::elodin::msg_id(s);
        o.line(std::string("  \"") + s +
               "\": fnv1a_32=" + chargold::hexu(fsw::elodin::fnv1a_hash_32(s), 8) +
               " fnv1a_64=" + chargold::hexu(fsw::elodin::fnv1a_hash_64(s), 16) + " msg_id=[" +
               chargold::hexu(id[0], 2) + "," + chargold::hexu(id[1], 2) + "]" +
               " component_id=" + chargold::hexu(fsw::elodin::component_id(s), 16));
    }
    {
        auto pid = fsw::elodin::message_id_to_packet_id(0x2A31);
        o.line("message_id_to_packet_id(0x2a31) = [" + chargold::hexu(pid[0], 2) + "," +
               chargold::hexu(pid[1], 2) + "]");
    }

    o.line("");
    o.line("# fsw/BoardTypeWire.hpp");
    o.line("  kUnknown=" + std::to_string(fsw::daq_wire::kUnknown));
    o.line("  kPressureTransducer=" + std::to_string(fsw::daq_wire::kPressureTransducer));
    o.line("  kLoadCell=" + std::to_string(fsw::daq_wire::kLoadCell));
    o.line("  kRtd=" + std::to_string(fsw::daq_wire::kRtd));
    o.line("  kThermocouple=" + std::to_string(fsw::daq_wire::kThermocouple));
    o.line("  kActuator=" + std::to_string(fsw::daq_wire::kActuator));
    o.line("  kEnvironmental=" + std::to_string(fsw::daq_wire::kEnvironmental));
    o.line("  kBallValve=" + std::to_string(fsw::daq_wire::kBallValve));

    o.line("");
    o.line(
        "# config/BoardDiscovery: what a BOARD_HEARTBEAT announces (daq_bridge feeds it every "
        "one)");
    o.line(
        "# (the hash-derived MAC and assigned IP use std::hash and are not portable: not frozen)");
    {
        fsw::config::BoardDiscovery disc;
        disc.set_static_ip_for_board(21, "127.0.0.21");
        daq::BoardHeartbeatPacket hb{};
        hb.board_id = 21;
        hb.engine_state = daq::EngineState::SAFE;
        hb.board_state = daq::BoardState::ACTIVE;
        uint8_t buf[64];
        size_t n = daq::create_board_heartbeat_packet(hb, 0x12345678u, buf, sizeof buf);
        buf[1] = 3;  // header version, which discovery records as firmware_version
        disc.process_board_announcement(buf, n, "127.0.0.21");
        disc.process_board_announcement(buf, n - 1, "127.0.0.22");  // truncated: ignored
        for (const char* ip : {"127.0.0.21", "127.0.0.22"}) {
            auto b = disc.get_board_by_ip(ip);
            if (!b) {
                o.line(std::string("  ") + ip + ": none");
                continue;
            }
            const auto& g = b->signature;
            o.line(std::string("  ") + ip + ": board_id=" + std::to_string(g.board_id) +
                   " board_type=" + std::to_string(g.board_type) +
                   " hardware_version=" + std::to_string(g.hardware_version) +
                   " firmware_version=" + std::to_string(g.firmware_version) + " serial_number=" +
                   std::to_string(g.serial_number) + " port=" + std::to_string(b->port) +
                   " is_configured=" + std::to_string(b->is_configured));
        }
    }
    return chargold::finish("comms_messages.txt", o.s.str());
}
