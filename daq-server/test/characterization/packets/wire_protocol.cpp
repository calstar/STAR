// Characterization: the board wire protocol as compiled into daqv2_comms
// (lib/daq-protocol/src: DiabloEnums.h, DiabloPackets.h, DiabloPacketUtils.{h,cpp}).
//
//   wire_layout.txt     enum numbering, sizeof/alignof/offsetof of every packed wire struct
//   wire_encode.txt     every create_* with known values, one named field per line; error returns
//   wire_decode.txt     every parse_* on the encoded bytes, decoded fields
//   wire_malformed.txt  every parse_*: truncation at every length, null, wrong type, version,
//                       trailing bytes, oversize, count over/under-claim. Outputs start as
//                       sentinels and are printed even when the parse fails, so partial writes
//                       are frozen too.
//
// Usage: char_wire_protocol <layout|encode|decode|malformed>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include "daq-protocol.h"
#include "golden.hpp"

using namespace daq;
using chargold::hex;
using chargold::Out;
using F = Out::F;

namespace {

constexpr uint32_t kTs = 0x12345678u;

// ── layout ───────────────────────────────────────────────────────────────────

#define LAYOUT_BEGIN(T)                                                           \
    o.line(std::string("struct ") + #T + " sizeof=" + std::to_string(sizeof(T)) + \
           " alignof=" + std::to_string(alignof(T)) +                             \
           " standard_layout=" + (std::is_standard_layout_v<T> ? "1" : "0") +     \
           " trivially_copyable=" + (std::is_trivially_copyable_v<T> ? "1" : "0"))
#define LAYOUT_FIELD(T, f, ty)                                                    \
    o.line(std::string("  ") + #f + " offset=" + std::to_string(offsetof(T, f)) + \
           " size=" + std::to_string(sizeof(static_cast<T*>(nullptr)->f)) + " type=" + ty)

int do_layout() {
    Out o;
    o.line("# DAQv2 wire protocol layout (lib/daq-protocol/src)");
    o.line("DIABLO_COMMS_VERSION=" + std::to_string(DIABLO_COMMS_VERSION));
    o.line("MAX_SENSORS_PER_BOARD=" + std::to_string(MAX_SENSORS_PER_BOARD));
    o.line("MAX_ACTUATORS_PER_BOARD=" + std::to_string(MAX_ACTUATORS_PER_BOARD));
    o.line("MAX_CHUNKS_PER_PACKET=" + std::to_string(MAX_CHUNKS_PER_PACKET));
    o.line("MAX_PACKET_SIZE=" + std::to_string(MAX_PACKET_SIZE));
    o.line("MAX_ABORT_ACTUATORS=" + std::to_string(MAX_ABORT_ACTUATORS));
    o.line("MAX_ABORT_PTS=" + std::to_string(MAX_ABORT_PTS));
    o.line("");
    o.line("enum PacketType : uint8_t sizeof=" + std::to_string(sizeof(PacketType)));
#define E(x) o.line(std::string("  ") + #x + " = " + std::to_string(static_cast<int>(x)))
    E(PacketType::BOARD_HEARTBEAT);
    E(PacketType::SERVER_HEARTBEAT);
    E(PacketType::SENSOR_DATA);
    E(PacketType::ACTUATOR_COMMAND);
    E(PacketType::SENSOR_CONFIG);
    E(PacketType::ACTUATOR_CONFIG);
    E(PacketType::ABORT);
    E(PacketType::ABORT_DONE);
    E(PacketType::CLEAR_ABORT);
    E(PacketType::PWM_ACTUATOR_COMMAND);
    E(PacketType::NO_CONNECTION_ABORT);
    E(PacketType::SELF_TEST);
    E(PacketType::ENVIRONMENTAL_DATA);
    E(PacketType::STACKLIGHT_COMMAND);
    E(PacketType::LOGS);
    o.line("enum BoardState : uint8_t sizeof=" + std::to_string(sizeof(BoardState)));
    E(BoardState::SETUP);
    E(BoardState::ACTIVE);
    E(BoardState::CONNECTION_LOSS_DETECTED);
    E(BoardState::NO_CONNECTION_ABORT);
    E(BoardState::NO_CONN_ABORT_FOLLOWER);
    E(BoardState::PT_ABORT);
    E(BoardState::NO_PT_ABORT);
    E(BoardState::ABORT_FINISHED);
    E(BoardState::STANDALONE_ABORT);
    E(BoardState::SELF_TEST);
    o.line("enum EngineState : uint8_t sizeof=" + std::to_string(sizeof(EngineState)));
    E(EngineState::SAFE);
    E(EngineState::PRESSURIZING);
    E(EngineState::LOX_FILL);
    E(EngineState::FIRING);
    E(EngineState::POST_FIRE);
#undef E
    o.line("");

    LAYOUT_BEGIN(PacketHeader);
    LAYOUT_FIELD(PacketHeader, packet_type, "PacketType(u8)");
    LAYOUT_FIELD(PacketHeader, version, "u8");
    LAYOUT_FIELD(PacketHeader, timestamp, "u32");
    LAYOUT_BEGIN(BoardHeartbeatPacket);
    LAYOUT_FIELD(BoardHeartbeatPacket, firmware_hash, "u8[32]");
    LAYOUT_FIELD(BoardHeartbeatPacket, board_id, "u8");
    LAYOUT_FIELD(BoardHeartbeatPacket, engine_state, "EngineState(u8)");
    LAYOUT_FIELD(BoardHeartbeatPacket, board_state, "BoardState(u8)");
    LAYOUT_BEGIN(ServerHeartbeatPacket);
    LAYOUT_FIELD(ServerHeartbeatPacket, engine_state, "EngineState(u8)");
    LAYOUT_BEGIN(SensorDataPacket);
    LAYOUT_FIELD(SensorDataPacket, num_chunks, "u8");
    LAYOUT_FIELD(SensorDataPacket, num_sensors, "u8");
    LAYOUT_BEGIN(SensorDataChunk);
    LAYOUT_FIELD(SensorDataChunk, timestamp, "u32");
    LAYOUT_BEGIN(SensorDatapoint);
    LAYOUT_FIELD(SensorDatapoint, sensor_id, "u8");
    LAYOUT_FIELD(SensorDatapoint, data, "u32");
    LAYOUT_BEGIN(SensorConfigPacket);
    LAYOUT_FIELD(SensorConfigPacket, num_sensors, "u8");
    LAYOUT_BEGIN(ActuatorCommandPacket);
    LAYOUT_FIELD(ActuatorCommandPacket, num_commands, "u8");
    LAYOUT_BEGIN(ActuatorCommand);
    LAYOUT_FIELD(ActuatorCommand, actuator_id, "u8");
    LAYOUT_FIELD(ActuatorCommand, actuator_state, "u8");
    LAYOUT_BEGIN(PWMActuatorCommandPacket);
    LAYOUT_FIELD(PWMActuatorCommandPacket, num_commands, "u8");
    LAYOUT_BEGIN(PWMActuatorCommand);
    LAYOUT_FIELD(PWMActuatorCommand, actuator_id, "u8");
    LAYOUT_FIELD(PWMActuatorCommand, duration, "u32");
    LAYOUT_FIELD(PWMActuatorCommand, duty_cycle, "f32");
    LAYOUT_FIELD(PWMActuatorCommand, frequency, "f32");
    LAYOUT_BEGIN(ActuatorConfigPacket);
    LAYOUT_FIELD(ActuatorConfigPacket, is_abort_controller, "u8");
    LAYOUT_FIELD(ActuatorConfigPacket, num_abort_actuators, "u8");
    LAYOUT_BEGIN(AbortActuatorLocation);
    LAYOUT_FIELD(AbortActuatorLocation, ip_address, "u32");
    LAYOUT_FIELD(AbortActuatorLocation, actuator_id, "u8");
    LAYOUT_FIELD(AbortActuatorLocation, vent_state, "u8");
    LAYOUT_FIELD(AbortActuatorLocation, abort_state, "u8");
    LAYOUT_BEGIN(AbortPTSectionHeader);
    LAYOUT_FIELD(AbortPTSectionHeader, num_abort_pts, "u8");
    LAYOUT_BEGIN(AbortPTLocation);
    LAYOUT_FIELD(AbortPTLocation, ip_address, "u32");
    LAYOUT_FIELD(AbortPTLocation, sensor_id, "u8");
    LAYOUT_FIELD(AbortPTLocation, pressure_threshold_adc, "u32");
    LAYOUT_BEGIN(SelfTestPacket);
    LAYOUT_FIELD(SelfTestPacket, adc_good, "u8");
    LAYOUT_FIELD(SelfTestPacket, num_sensors, "u8");
    LAYOUT_BEGIN(SelfTestResult);
    LAYOUT_FIELD(SelfTestResult, sensor_id, "u8");
    LAYOUT_FIELD(SelfTestResult, result, "u8");
    LAYOUT_BEGIN(EnvironmentalDataPacket);
    LAYOUT_FIELD(EnvironmentalDataPacket, temperature_c, "f32");
    LAYOUT_FIELD(EnvironmentalDataPacket, pressure_pa, "u32");
    LAYOUT_FIELD(EnvironmentalDataPacket, humidity_rh, "f32");
    LAYOUT_BEGIN(StacklightCommandPacket);
    LAYOUT_FIELD(StacklightCommandPacket, red, "u8");
    LAYOUT_FIELD(StacklightCommandPacket, yellow, "u8");
    LAYOUT_FIELD(StacklightCommandPacket, green, "u8");
    LAYOUT_FIELD(StacklightCommandPacket, buzzer, "u8");
    // Host-side collection types: not on the wire, but their field order is what parse_* fills.
    o.line("struct SensorDataChunkCollection (host-side; vector member, layout not frozen)");
    o.line("struct SensorConfigData (host-side; vector member, layout not frozen)");
    return chargold::finish("wire_layout.txt", o.s.str());
}

// ── known-valued instances ───────────────────────────────────────────────────

BoardHeartbeatPacket sample_heartbeat() {
    BoardHeartbeatPacket hb{};
    for (int i = 0; i < 32; ++i)
        hb.firmware_hash[i] = static_cast<uint8_t>(0xA0 + i);
    hb.board_id = 21;
    hb.engine_state = EngineState::FIRING;
    hb.board_state = BoardState::ACTIVE;
    return hb;
}

std::vector<SensorDataChunkCollection> sample_chunks() {
    std::vector<SensorDataChunkCollection> v;
    for (uint32_t c = 0; c < 2; ++c) {
        SensorDataChunkCollection col(0x01020304u + c * 0x10, 3);
        for (uint8_t s = 1; s <= 3; ++s)
            col.add_datapoint(static_cast<uint8_t>(s + c * 4), 0xA0B0C000u + c * 0x100 + s);
        v.push_back(col);
    }
    return v;
}

const std::vector<ActuatorCommand> kCmds = {{1, 1}, {5, 0}, {10, 1}};
const std::vector<SelfTestResult> kSelfTest = {{1, 1}, {2, 0}, {7, 1}};
const std::vector<PWMActuatorCommand> kPwm = {{3, 500u, 0.25f, 10.0f}, {8, 1000u, 0.75f, 20.0f}};
const std::vector<uint8_t> kSensorIds = {1, 2, 3, 7, 10};
const std::vector<AbortActuatorLocation> kAbortActs = {{0xC0A8020Bu, 3, 1, 0},
                                                       {0x0C02A8C0u, 8, 0, 1}};
const std::vector<AbortPTLocation> kAbortPts = {{0xC0A80215u, 2, 0x4CCCCCCDu},
                                                {0x1502A8C0u, 9, 0x10000000u}};
const std::string kLogText = "line one\nline two\n";

std::vector<uint8_t> enc_heartbeat() {
    std::vector<uint8_t> b(256);
    b.resize(create_board_heartbeat_packet(sample_heartbeat(), kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_sensor_data() {
    std::vector<uint8_t> b(512);
    b.resize(create_sensor_data_packet(sample_chunks(), 3, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_abort_done() {
    std::vector<uint8_t> b(64);
    b.resize(create_abort_done_packet(kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_actuator_command() {
    std::vector<uint8_t> b(256);
    b.resize(create_actuator_command_packet(kCmds, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_self_test() {
    std::vector<uint8_t> b(256);
    b.resize(create_self_test_packet(1, kSelfTest, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_environmental() {
    std::vector<uint8_t> b(64);
    b.resize(create_environmental_data_packet(21.5f, 101325u, 45.25f, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_stacklight() {
    std::vector<uint8_t> b(64);
    StacklightCommandPacket s{1, 0, 1, 0};
    b.resize(create_stacklight_command_packet(s, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_log() {
    std::vector<uint8_t> b(256);
    b.resize(create_log_packet(1, reinterpret_cast<const uint8_t*>(kLogText.data()),
                               static_cast<uint16_t>(kLogText.size()), kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_sensor_config(bool abort) {
    std::vector<uint8_t> b(256);
    b.resize(
        create_sensor_config_packet(kSensorIds, 1, abort, 0xC0A8020Bu, 3, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_pwm() {
    std::vector<uint8_t> b(256);
    b.resize(create_pwm_actuator_packet(kPwm, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> enc_actuator_config() {
    std::vector<uint8_t> b(512);
    b.resize(create_actuator_config_packet(1, kAbortActs, kAbortPts, 2, kTs, b.data(), b.size()));
    return b;
}
std::vector<uint8_t> server_heartbeat_bytes() {
    // No create_server_heartbeat_packet exists; this is the layout heartbeat_service and
    // daq_bridge hand-build (frozen separately in service_encoders).
    return {0x02, 0x00, 0x78, 0x56, 0x34, 0x12, 0x03};
}

const std::vector<F> kHdr = {
    {"header.packet_type", 1}, {"header.version", 1}, {"header.timestamp", 4}};

std::vector<F> with_hdr(std::vector<F> body) {
    std::vector<F> v = kHdr;
    v.insert(v.end(), body.begin(), body.end());
    return v;
}

void enc_block(Out& o, const std::string& title, const std::vector<uint8_t>& b,
               const std::vector<F>& fs) {
    o.line("## " + title + " len=" + std::to_string(b.size()));
    o.fields(b.data(), b.size(), fs);
}

std::vector<F> sensor_data_fields(int chunks, int sensors) {
    std::vector<F> v = {{"num_chunks", 1}, {"num_sensors", 1}};
    for (int c = 0; c < chunks; ++c) {
        v.push_back({"chunk[" + std::to_string(c) + "].timestamp", 4});
        for (int s = 0; s < sensors; ++s) {
            const std::string p = "chunk[" + std::to_string(c) + "].dp[" + std::to_string(s) + "]";
            v.push_back({p + ".sensor_id", 1});
            v.push_back({p + ".data", 4});
        }
    }
    return with_hdr(v);
}

std::vector<F> pair_list(const std::string& count, const std::string& item, int n,
                         const std::vector<F>& per) {
    std::vector<F> v = {{count, 1}};
    for (int i = 0; i < n; ++i)
        for (const auto& f : per)
            v.push_back({item + "[" + std::to_string(i) + "]." + f.name, f.size});
    return v;
}

std::vector<F> actuator_config_fields(int n, int x) {
    std::vector<F> v = {{"is_abort_controller", 1}, {"num_abort_actuators", 1}};
    for (int i = 0; i < n; ++i) {
        const std::string p = "abort_actuator[" + std::to_string(i) + "]";
        v.push_back({p + ".ip_address", 4});
        v.push_back({p + ".actuator_id", 1});
        v.push_back({p + ".vent_state", 1});
        v.push_back({p + ".abort_state", 1});
    }
    v.push_back({"num_abort_pts", 1});
    for (int i = 0; i < x; ++i) {
        const std::string p = "abort_pt[" + std::to_string(i) + "]";
        v.push_back({p + ".ip_address", 4});
        v.push_back({p + ".sensor_id", 1});
        v.push_back({p + ".pressure_threshold_adc", 4});
    }
    v.push_back({"enable_serial_printing", 1});
    return with_hdr(v);
}

std::vector<F> sensor_config_fields(int n, bool abort) {
    std::vector<F> v = {{"num_sensors", 1}};
    for (int i = 0; i < n; ++i)
        v.push_back({"sensor_id[" + std::to_string(i) + "]", 1});
    v.push_back({"reference_voltage", 1});
    v.push_back({"necessary_for_abort", 1});
    if (abort)
        v.push_back({"controller_ip", 4});
    v.push_back({"enable_serial_printing", 1});
    return with_hdr(v);
}

/** Run an encoder into a buffer pre-filled with 0xEE; report the return value and how many
 *  bytes of the buffer it changed. */
void enc_err(Out& o, const std::string& what, const std::function<size_t(uint8_t*, size_t)>& fn,
             size_t bufsize) {
    std::vector<uint8_t> b(bufsize + 1, 0xEE);
    size_t r = fn(bufsize ? b.data() : nullptr, bufsize);
    size_t changed = 0;
    for (auto c : b)
        changed += (c != 0xEE);
    o.line("  " + what + ": ret=" + std::to_string(r) +
           " bytes_changed=" + std::to_string(changed));
}

int do_encode() {
    Out o;
    o.line("# create_* outputs (timestamp_ms = 0x12345678 throughout)");
    enc_block(
        o, "create_board_heartbeat_packet", enc_heartbeat(),
        with_hdr(
            {{"firmware_hash", 32}, {"board_id", 1}, {"engine_state", 1}, {"board_state", 1}}));
    enc_block(o, "create_sensor_data_packet (2 chunks x 3 sensors)", enc_sensor_data(),
              sensor_data_fields(2, 3));
    enc_block(o, "create_abort_done_packet", enc_abort_done(), kHdr);
    enc_block(
        o, "create_actuator_command_packet (3 commands)", enc_actuator_command(),
        with_hdr(pair_list("num_commands", "cmd", 3, {{"actuator_id", 1}, {"actuator_state", 1}})));
    {
        std::vector<F> st = {{"adc_good", 1}};
        auto rest = pair_list("num_sensors", "result", 3, {{"sensor_id", 1}, {"result", 1}});
        st.insert(st.end(), rest.begin(), rest.end());
        enc_block(o, "create_self_test_packet (adc_good=1, 3 results)", enc_self_test(),
                  with_hdr(st));
    }
    enc_block(o, "create_environmental_data_packet (21.5 C, 101325 Pa, 45.25 %RH)",
              enc_environmental(),
              with_hdr({{"temperature_c", 4}, {"pressure_pa", 4}, {"humidity_rh", 4}}));
    enc_block(o, "create_stacklight_command_packet (r=1 y=0 g=1 b=0)", enc_stacklight(),
              with_hdr({{"red", 1}, {"yellow", 1}, {"green", 1}, {"buzzer", 1}}));
    enc_block(o, "create_log_packet (flags=1, 18 text bytes)", enc_log(),
              with_hdr({{"flags", 1}, {"text_len", 2}, {"text", kLogText.size()}}));
    enc_block(o, "create_sensor_config_packet (5 ids, ref=1, abort=false, serial=3)",
              enc_sensor_config(false), sensor_config_fields(5, false));
    enc_block(o, "create_sensor_config_packet (5 ids, ref=1, abort=true, ip=0xC0A8020B, serial=3)",
              enc_sensor_config(true), sensor_config_fields(5, true));
    enc_block(o, "create_pwm_actuator_packet (2 commands)", enc_pwm(),
              with_hdr(pair_list(
                  "num_commands", "cmd", 2,
                  {{"actuator_id", 1}, {"duration", 4}, {"duty_cycle", 4}, {"frequency", 4}})));
    enc_block(o, "create_actuator_config_packet (abort ctrl, 2 actuators, 2 PTs, serial=2)",
              enc_actuator_config(), actuator_config_fields(2, 2));

    o.line("");
    o.line("# encoder edge cases: buffer pre-filled with 0xEE");
    const auto hb = sample_heartbeat();
    enc_err(
        o, "board_heartbeat buffer=40 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_board_heartbeat_packet(hb, kTs, p, n);
        },
        40);
    enc_err(
        o, "board_heartbeat buffer=41 (exact)",
        [&](uint8_t* p, size_t n) {
            return create_board_heartbeat_packet(hb, kTs, p, n);
        },
        41);
    const auto ch = sample_chunks();
    enc_err(
        o, "sensor_data buffer=37 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_sensor_data_packet(ch, 3, kTs, p, n);
        },
        37);
    enc_err(
        o, "sensor_data 0 chunks",
        [&](uint8_t* p, size_t n) {
            return create_sensor_data_packet({}, 3, kTs, p, n);
        },
        64);
    enc_err(
        o, "sensor_data num_sensors=0 with 2 chunks",
        [&](uint8_t* p, size_t n) {
            return create_sensor_data_packet(ch, 0, kTs, p, n);
        },
        64);
    enc_err(
        o, "abort_done buffer=5",
        [&](uint8_t* p, size_t n) {
            return create_abort_done_packet(kTs, p, n);
        },
        5);
    enc_err(
        o, "actuator_command 0 commands",
        [&](uint8_t* p, size_t n) {
            return create_actuator_command_packet({}, kTs, p, n);
        },
        64);
    {
        std::vector<ActuatorCommand> many(256, ActuatorCommand{1, 1});
        enc_err(
            o, "actuator_command 256 commands",
            [&](uint8_t* p, size_t n) {
                return create_actuator_command_packet(many, kTs, p, n);
            },
            1024);
        std::vector<ActuatorCommand> max(255, ActuatorCommand{2, 0});
        enc_err(
            o, "actuator_command 255 commands",
            [&](uint8_t* p, size_t n) {
                return create_actuator_command_packet(max, kTs, p, n);
            },
            1024);
    }
    enc_err(
        o, "actuator_command buffer=12 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_actuator_command_packet(kCmds, kTs, p, n);
        },
        12);
    enc_err(
        o, "self_test 0 results",
        [&](uint8_t* p, size_t n) {
            return create_self_test_packet(0, {}, kTs, p, n);
        },
        64);
    {
        std::vector<SelfTestResult> many(256, SelfTestResult{1, 1});
        enc_err(
            o, "self_test 256 results",
            [&](uint8_t* p, size_t n) {
                return create_self_test_packet(1, many, kTs, p, n);
            },
            1024);
    }
    enc_err(
        o, "self_test buffer=13 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_self_test_packet(1, kSelfTest, kTs, p, n);
        },
        13);
    enc_err(
        o, "environmental null buffer",
        [&](uint8_t*, size_t) {
            return create_environmental_data_packet(1.0f, 1u, 1.0f, kTs, nullptr, 64);
        },
        64);
    enc_err(
        o, "environmental buffer=17 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_environmental_data_packet(1.0f, 1u, 1.0f, kTs, p, n);
        },
        17);
    enc_err(
        o, "stacklight null buffer",
        [&](uint8_t*, size_t) {
            return create_stacklight_command_packet(StacklightCommandPacket{1, 1, 1, 1}, kTs,
                                                    nullptr, 64);
        },
        64);
    enc_err(
        o, "stacklight buffer=9 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_stacklight_command_packet(StacklightCommandPacket{1, 1, 1, 1}, kTs, p, n);
        },
        9);
    enc_err(
        o, "log text_len=0",
        [&](uint8_t* p, size_t n) {
            return create_log_packet(0, nullptr, 0, kTs, p, n);
        },
        64);
    {
        // text == nullptr with a non-zero length: header and length are written, the text bytes
        // are left as they were (here 0xEE) — frozen as-is.
        std::vector<uint8_t> b(32, 0xEE);
        size_t r = create_log_packet(2, nullptr, 5, kTs, b.data(), b.size());
        o.line("  log text=nullptr text_len=5: ret=" + std::to_string(r) +
               " bytes=" + hex(b.data(), r));
    }
    enc_err(
        o, "log text_len=65535 buffer=64",
        [&](uint8_t* p, size_t n) {
            static std::vector<uint8_t> big(65535, 'x');
            return create_log_packet(0, big.data(), 65535, kTs, p, n);
        },
        64);
    enc_err(
        o, "log buffer=26 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_log_packet(1, reinterpret_cast<const uint8_t*>(kLogText.data()),
                                     static_cast<uint16_t>(kLogText.size()), kTs, p, n);
        },
        26);
    enc_err(
        o, "sensor_config 0 ids",
        [&](uint8_t* p, size_t n) {
            return create_sensor_config_packet({}, 0, false, 0, 0, kTs, p, n);
        },
        64);
    {
        std::vector<uint8_t> many(256, 1);
        enc_err(
            o, "sensor_config 256 ids",
            [&](uint8_t* p, size_t n) {
                return create_sensor_config_packet(many, 0, false, 0, 0, kTs, p, n);
            },
            1024);
    }
    enc_err(
        o, "sensor_config abort=true buffer=18 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_sensor_config_packet(kSensorIds, 1, true, 1, 3, kTs, p, n);
        },
        18);
    enc_err(
        o, "sensor_config abort=false buffer=14 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_sensor_config_packet(kSensorIds, 1, false, 1, 3, kTs, p, n);
        },
        14);
    enc_err(
        o, "pwm 0 commands",
        [&](uint8_t* p, size_t n) {
            return create_pwm_actuator_packet({}, kTs, p, n);
        },
        64);
    {
        std::vector<PWMActuatorCommand> many(256, PWMActuatorCommand{1, 1, 0.5f, 1.0f});
        enc_err(
            o, "pwm 256 commands",
            [&](uint8_t* p, size_t n) {
                return create_pwm_actuator_packet(many, kTs, p, n);
            },
            8192);
    }
    enc_err(
        o, "pwm buffer=32 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_pwm_actuator_packet(kPwm, kTs, p, n);
        },
        32);
    enc_err(
        o, "actuator_config 0 actuators 0 pts",
        [&](uint8_t* p, size_t n) {
            return create_actuator_config_packet(0, {}, {}, 0, kTs, p, n);
        },
        64);
    {
        std::vector<AbortActuatorLocation> many(256, AbortActuatorLocation{1, 1, 1, 1});
        enc_err(
            o, "actuator_config 256 actuators",
            [&](uint8_t* p, size_t n) {
                return create_actuator_config_packet(0, many, {}, 0, kTs, p, n);
            },
            4096);
        std::vector<AbortPTLocation> pts(256, AbortPTLocation{1, 1, 1});
        enc_err(
            o, "actuator_config 256 pts",
            [&](uint8_t* p, size_t n) {
                return create_actuator_config_packet(0, {}, pts, 0, kTs, p, n);
            },
            4096);
    }
    enc_err(
        o, "actuator_config buffer=41 (one short)",
        [&](uint8_t* p, size_t n) {
            return create_actuator_config_packet(1, kAbortActs, kAbortPts, 2, kTs, p, n);
        },
        41);
    return chargold::finish("wire_encode.txt", o.s.str());
}

// ── decode helpers (shared by decode and malformed) ──────────────────────────

std::string hdr_str(const PacketHeader& h) {
    return "hdr{type=" + std::to_string(static_cast<int>(h.packet_type)) +
           " ver=" + std::to_string(h.version) + " ts=" + chargold::hexu(h.timestamp, 8) + "}";
}

PacketHeader sentinel_hdr() {
    PacketHeader h;
    std::memset(&h, 0xAB, sizeof h);
    return h;
}

using Decoder = std::function<std::string(const uint8_t*, size_t)>;

std::string dec_heartbeat(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    BoardHeartbeatPacket b;
    std::memset(&b, 0xEE, sizeof b);
    bool r = parse_board_heartbeat_packet(p, n, h, b);
    return "ret=" + std::to_string(r) + " " + hdr_str(h) + " hash=" + hex(b.firmware_hash, 32) +
           " board_id=" + std::to_string(b.board_id) +
           " engine_state=" + std::to_string(static_cast<int>(b.engine_state)) +
           " board_state=" + std::to_string(static_cast<int>(b.board_state));
}

std::string dec_server_heartbeat(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    ServerHeartbeatPacket b;
    std::memset(&b, 0xEE, sizeof b);
    bool r = parse_server_heartbeat_packet(p, n, h, b);
    return "ret=" + std::to_string(r) + " " + hdr_str(h) +
           " engine_state=" + std::to_string(static_cast<int>(b.engine_state));
}

std::string dec_sensor_data(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    std::vector<SensorDataChunkCollection> chunks;
    SensorDataChunkCollection sentinel(0xEEEEEEEEu, 1);
    sentinel.add_datapoint(0xEE, 0xEEEEEEEEu);
    chunks.push_back(sentinel);
    bool r = parse_sensor_data_packet(p, n, h, chunks);
    std::string s = "ret=" + std::to_string(r) + " " + hdr_str(h) +
                    " chunks=" + std::to_string(chunks.size()) + " [";
    for (const auto& c : chunks) {
        s += " {ts=" + chargold::hexu(c.timestamp, 8) +
             " num_sensors=" + std::to_string(c.num_sensors) + " dps=";
        for (const auto& d : c.datapoints)
            s += std::to_string(d.sensor_id) + ":" + chargold::hexu(d.data, 8) + ",";
        s += "}";
    }
    return s + " ]";
}

std::string dec_abort_done(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    bool r = parse_abort_done_packet(p, n, h);
    return "ret=" + std::to_string(r) + " " + hdr_str(h);
}

std::string dec_actuator_command(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    std::vector<ActuatorCommand> v = {{0xEE, 0xEE}};
    bool r = parse_actuator_command_packet(p, n, h, v);
    std::string s =
        "ret=" + std::to_string(r) + " " + hdr_str(h) + " cmds=" + std::to_string(v.size()) + " [";
    for (const auto& c : v)
        s += " " + std::to_string(c.actuator_id) + ":" + std::to_string(c.actuator_state);
    return s + " ]";
}

std::string dec_self_test(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    uint8_t adc = 0xEE;
    std::vector<SelfTestResult> v = {{0xEE, 0xEE}};
    bool r = parse_self_test_packet(p, n, h, adc, v);
    std::string s = "ret=" + std::to_string(r) + " " + hdr_str(h) +
                    " adc_good=" + std::to_string(adc) + " results=" + std::to_string(v.size()) +
                    " [";
    for (const auto& c : v)
        s += " " + std::to_string(c.sensor_id) + ":" + std::to_string(c.result);
    return s + " ]";
}

std::string dec_environmental(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    EnvironmentalDataPacket b;
    std::memset(&b, 0xEE, sizeof b);
    bool r = parse_environmental_data_packet(p, n, h, b);
    return "ret=" + std::to_string(r) + " " + hdr_str(h) +
           " temperature_c=" + chargold::fstr(b.temperature_c) +
           " pressure_pa=" + std::to_string(b.pressure_pa) +
           " humidity_rh=" + chargold::fstr(b.humidity_rh);
}

std::string dec_stacklight(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    StacklightCommandPacket b;
    std::memset(&b, 0xEE, sizeof b);
    bool r = parse_stacklight_command_packet(p, n, h, b);
    return "ret=" + std::to_string(r) + " " + hdr_str(h) + " red=" + std::to_string(b.red) +
           " yellow=" + std::to_string(b.yellow) + " green=" + std::to_string(b.green) +
           " buzzer=" + std::to_string(b.buzzer);
}

std::string dec_sensor_config(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    std::vector<uint8_t> ids = {0xEE};
    uint8_t ref = 0xEE, serial = 0xEE;
    bool abort = true;
    uint32_t ip = 0xEEEEEEEEu;
    bool r = parse_sensor_config_packet(p, n, h, ids, ref, abort, ip, serial);
    return "ret=" + std::to_string(r) + " " + hdr_str(h) + " ids=[" + hex(ids) + "]" +
           " reference_voltage=" + std::to_string(ref) +
           " necessary_for_abort=" + std::to_string(abort) +
           " controller_ip=" + chargold::hexu(ip, 8) +
           " enable_serial_printing=" + std::to_string(serial);
}

std::string dec_pwm(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    std::vector<PWMActuatorCommand> v = {{0xEE, 0xEEEEEEEEu, -1.0f, -1.0f}};
    bool r = parse_pwm_actuator_packet(p, n, h, v);
    std::string s =
        "ret=" + std::to_string(r) + " " + hdr_str(h) + " cmds=" + std::to_string(v.size()) + " [";
    for (const auto& c : v)
        s += " {id=" + std::to_string(c.actuator_id) + " duration=" + std::to_string(c.duration) +
             " duty=" + chargold::fstr(c.duty_cycle) + " freq=" + chargold::fstr(c.frequency) + "}";
    return s + " ]";
}

std::string dec_actuator_config(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    uint8_t is_abort = 0xEE, serial = 0xEE;
    std::vector<AbortActuatorLocation> acts = {{0xEEEEEEEEu, 0xEE, 0xEE, 0xEE}};
    std::vector<AbortPTLocation> pts = {{0xEEEEEEEEu, 0xEE, 0xEEEEEEEEu}};
    bool r = parse_actuator_config_packet(p, n, h, is_abort, acts, pts, serial);
    std::string s = "ret=" + std::to_string(r) + " " + hdr_str(h) +
                    " is_abort_controller=" + std::to_string(is_abort) +
                    " actuators=" + std::to_string(acts.size()) + " [";
    for (const auto& a : acts)
        s += " {ip=" + chargold::hexu(a.ip_address, 8) + " id=" + std::to_string(a.actuator_id) +
             " vent=" + std::to_string(a.vent_state) + " abort=" + std::to_string(a.abort_state) +
             "}";
    s += " ] pts=" + std::to_string(pts.size()) + " [";
    for (const auto& a : pts)
        s += " {ip=" + chargold::hexu(a.ip_address, 8) + " id=" + std::to_string(a.sensor_id) +
             " adc=" + chargold::hexu(a.pressure_threshold_adc, 8) + "}";
    return s + " ] enable_serial_printing=" + std::to_string(serial);
}

std::string dec_log(const uint8_t* p, size_t n) {
    PacketHeader h = sentinel_hdr();
    uint8_t flags = 0xEE;
    const uint8_t* text = nullptr;
    uint16_t len = 0xEEEE;
    bool r = parse_log_packet(p, n, h, flags, text, len);
    std::string where = text == nullptr ? std::string("null")
                                        : "buf+" + std::to_string(static_cast<long>(text - p));
    std::string s = "ret=" + std::to_string(r) + " " + hdr_str(h) +
                    " flags=" + std::to_string(flags) + " text_len=" + std::to_string(len) +
                    " text_ptr=" + where;
    if (r && text)
        s += " text=" + hex(text, len);
    return s;
}

struct Family {
    std::string name;
    std::function<std::vector<uint8_t>()> make;
    Decoder dec;
    std::vector<size_t> count_offsets;  // bytes holding a count the parser trusts
};

std::vector<Family> families() {
    return {
        {"board_heartbeat", enc_heartbeat, dec_heartbeat, {}},
        {"server_heartbeat", server_heartbeat_bytes, dec_server_heartbeat, {}},
        {"sensor_data", enc_sensor_data, dec_sensor_data, {6, 7}},
        {"abort_done", enc_abort_done, dec_abort_done, {}},
        {"actuator_command", enc_actuator_command, dec_actuator_command, {6}},
        {"self_test", enc_self_test, dec_self_test, {7}},
        {"environmental", enc_environmental, dec_environmental, {}},
        {"stacklight", enc_stacklight, dec_stacklight, {}},
        {"sensor_config(abort=false)",
         [] {
             return enc_sensor_config(false);
         },
         dec_sensor_config,
         {6, 13}},
        {"sensor_config(abort=true)",
         [] {
             return enc_sensor_config(true);
         },
         dec_sensor_config,
         {6, 13}},
        {"pwm_actuator", enc_pwm, dec_pwm, {6}},
        {"actuator_config", enc_actuator_config, dec_actuator_config, {7, 22}},
        {"log", enc_log, dec_log, {7}},
    };
}

int do_decode() {
    Out o;
    o.line("# parse_* on the bytes create_* produced (see wire_encode.txt)");
    for (const auto& f : families()) {
        auto b = f.make();
        o.line("## " + f.name + " len=" + std::to_string(b.size()));
        o.line("  " + f.dec(b.data(), b.size()));
    }
    return chargold::finish("wire_decode.txt", o.s.str());
}

std::string run(const Decoder& d, const std::vector<uint8_t>& b) {
    // Exact-size heap copy so an over-read is a real over-read under ASan; never a null pointer.
    std::unique_ptr<uint8_t[]> p(new uint8_t[b.size() ? b.size() : 1]);
    if (!b.empty())
        std::memcpy(p.get(), b.data(), b.size());
    return d(p.get(), b.size());
}

int do_malformed() {
    Out o;
    o.line("# parse_* on malformed input; outputs start as sentinels (0xAB header, 0xEE fields,");
    o.line("# one sentinel element in each output vector) and are printed whatever ret is.");
    for (const auto& f : families()) {
        const auto good = f.make();
        o.line("## " + f.name + " (valid len=" + std::to_string(good.size()) + ")");
        o.line("  null buffer: " + f.dec(nullptr, good.size()));
        for (size_t L = 0; L < good.size(); ++L)
            o.line("  trunc " + std::to_string(L) + ": " +
                   run(f.dec, std::vector<uint8_t>(good.begin(), good.begin() + L)));
        for (uint8_t t : {uint8_t(0), uint8_t(99), uint8_t(static_cast<uint8_t>(good[0] + 1))}) {
            auto b = good;
            b[0] = t;
            o.line("  type=" + std::to_string(t) + ": " + run(f.dec, b));
        }
        {
            auto b = good;
            b[1] = 7;
            o.line("  version=7: " + run(f.dec, b));
        }
        {
            auto b = good;
            b.insert(b.end(), {0xEE, 0xEE, 0xEE});
            o.line("  trailing+3: " + run(f.dec, b));
        }
        {
            auto b = good;
            b.resize(MAX_PACKET_SIZE + 88, 0x5A);
            o.line("  oversize(" + std::to_string(b.size()) + "): " + run(f.dec, b));
        }
        for (size_t off : f.count_offsets) {
            if (off >= good.size())
                continue;
            for (int delta : {-1, +1}) {
                auto b = good;
                b[off] = static_cast<uint8_t>(b[off] + delta);
                o.line("  count@" + std::to_string(off) + (delta > 0 ? "+1" : "-1") + ": " +
                       run(f.dec, b));
            }
            auto b = good;
            b[off] = 0xFF;
            o.line("  count@" + std::to_string(off) + "=255: " + run(f.dec, b));
            b = good;
            b[off] = 0;
            o.line("  count@" + std::to_string(off) + "=0: " + run(f.dec, b));
        }
    }
    // Specific shapes the generic matrix does not reach.
    o.line("## specific");
    {
        auto b = enc_sensor_config(false);
        b[13] = 2;  // necessary_for_abort = 2 with no ip bytes present
        o.line("  sensor_config abort_flag=2 without ip: " + run(dec_sensor_config, b));
    }
    {
        auto b = enc_log();
        b[7] = 0;
        b[8] = 0;
        o.line("  log text_len=0 with text present: " + run(dec_log, b));
    }
    o.line("  zero-length non-null every family:");
    for (const auto& f : families())
        o.line("    " + f.name + ": " + run(f.dec, {}));
    return chargold::finish("wire_malformed.txt", o.s.str());
}

}  // namespace

int main(int argc, char** argv) {
    const std::string mode = argc > 1 ? argv[1] : "";
    if (mode == "layout")
        return do_layout();
    if (mode == "encode")
        return do_encode();
    if (mode == "decode")
        return do_decode();
    if (mode == "malformed")
        return do_malformed();
    std::cerr << "usage: char_wire_protocol <layout|encode|decode|malformed>" << std::endl;
    return 2;
}
