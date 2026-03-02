/**
 * @file ControllerService.cpp
 * @brief C++ controller service with UDP PWM output
 *
 * Pipeline:
 *   1. Reads sensor measurements (pushed via setMeasurement)
 *   2. Runs RobustDDPController::step() to compute actuation
 *   3. Sends PWM command packets over UDP to actuator board
 *      (exact combined_gui.py packet format)
 *   4. Optionally writes to Elodin DB for logging
 */

#include "control/ControllerService.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>

#include "comms/messages/control/ControllerMessages.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "control/RobustDDPController.hpp"
#include "db.hpp"
#include "elodin/ElodinClient.hpp"

using namespace vtable;
using namespace vtable::builder;

namespace fsw {
namespace control {

// ═══════════════════════════════════════════════════════════════════════
//  PWM Packet Format (matches combined_gui.py EXACTLY)
//
//  Header:  packet_type (u8) = 10
//           version     (u8) = 0
//           timestamp   (u32 LE) = ms since epoch & 0xFFFFFFFF
//  Body:    num_commands (u8)
//  Per-cmd: actuator_id  (u8)
//           duration_ms  (u32 LE)
//           duty_cycle   (float32 LE)
//           frequency    (float32 LE)
//
//  Total for 1 command: 6 + 1 + 13 = 20 bytes
// ═══════════════════════════════════════════════════════════════════════

static constexpr uint8_t PACKET_TYPE_PWM = 10;
static constexpr uint8_t COMMS_VERSION = 0;
static constexpr size_t HEADER_SIZE = 6;  // <BBI>
static constexpr size_t BODY_SIZE = 1;    // <B> num_commands
static constexpr size_t CMD_SIZE = 13;    // <BIff>
static constexpr size_t SINGLE_CMD_PACKET_SIZE = HEADER_SIZE + BODY_SIZE + CMD_SIZE;  // 20

// ═══════════════════════════════════════════════════════════════════════
//  CONSTRUCTION / INIT / DESTROY
// ═══════════════════════════════════════════════════════════════════════

ControllerService::ControllerService()
    : controller_(std::make_unique<RobustDDPController>()),
      elodin_client_(std::make_unique<fsw::elodin::ElodinClient>()) {
}

ControllerService::~ControllerService() {
    stop();
    if (udp_socket_fd_ >= 0) {
        ::close(udp_socket_fd_);
        udp_socket_fd_ = -1;
    }
}

bool ControllerService::initialize(const PWMConfig& pwm_config,
                                   const RobustDDPController::Config& controller_config,
                                   const std::string& elodin_host, uint16_t elodin_port) {
    pwm_config_ = pwm_config;

    // ── Create UDP socket for PWM commands ──────────────────────────────
    udp_socket_fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (udp_socket_fd_ < 0) {
        std::cerr << "[ControllerService] ❌ Failed to create UDP socket: " << strerror(errno)
                  << std::endl;
        return false;
    }
    std::cout << "[ControllerService] ✅ UDP socket created for PWM output → "
              << pwm_config_.actuator_board_ip << ":" << pwm_config_.actuator_port << std::endl;
    std::cout << "[ControllerService]    Fuel CH" << (int)pwm_config_.fuel_channel << "  LOX CH"
              << (int)pwm_config_.lox_channel << "  freq=" << pwm_config_.frequency_hz << "Hz"
              << "  duration=" << pwm_config_.duration_ms << "ms" << std::endl;

    // ── Elodin DB (optional) ────────────────────────────────────────────
    if (!elodin_host.empty()) {
        if (elodin_client_->connect(elodin_host, elodin_port)) {
            elodin_connected_ = true;
            registerControllerTables();
            std::cout << "[ControllerService] ✅ Connected to Elodin DB at " << elodin_host << ":"
                      << elodin_port << std::endl;
        } else {
            std::cerr << "[ControllerService] ⚠️ Elodin DB connection failed — "
                         "running without DB logging"
                      << std::endl;
        }
    } else {
        std::cout << "[ControllerService] ℹ️  No Elodin host specified — "
                     "running without DB logging"
                  << std::endl;
    }

    // ── Initialize controller ───────────────────────────────────────────
    if (!controller_->initialize(controller_config)) {
        std::cerr << "[ControllerService] ❌ Failed to initialize RobustDDPController" << std::endl;
        return false;
    }

    // Set default measurement to zeros
    {
        std::lock_guard<std::mutex> lock(input_mutex_);
        current_meas_ = {};
        current_meas_.timestamp = std::chrono::steady_clock::now();
        current_cmd_.type = RobustDDPController::CommandType::THRUST_DESIRED;
        current_cmd_.thrust_desired = 1000.0;  // Default thrust target [N]
    }

    std::cout << "[ControllerService] ✅ Controller initialized" << std::endl;
    return true;
}

// ═══════════════════════════════════════════════════════════════════════
//  START / STOP
// ═══════════════════════════════════════════════════════════════════════

bool ControllerService::start(double loop_rate_hz) {
    if (running_)
        return true;

    if (udp_socket_fd_ < 0) {
        std::cerr << "[ControllerService] ❌ Cannot start — UDP socket not initialized"
                  << std::endl;
        return false;
    }

    running_ = true;
    loop_rate_hz_ = loop_rate_hz;
    loop_interval_ms_ = 1000.0 / loop_rate_hz;

    controller_thread_ = std::thread(&ControllerService::controllerLoop, this);
    if (elodin_connected_) {
        elodin_subscriber_thread_ = std::thread(&ControllerService::elodinSubscriberLoop, this);
    }

    std::cout << "[ControllerService] ✅ Started controller loop at " << loop_rate_hz << " Hz"
              << std::endl;
    return true;
}

void ControllerService::stop() {
    if (!running_)
        return;

    running_ = false;
    if (controller_thread_.joinable()) {
        controller_thread_.join();
    }
    if (elodin_subscriber_thread_.joinable()) {
        elodin_subscriber_thread_.join();
    }
    std::cout << "[ControllerService] 🛑 Stopped controller loop" << std::endl;
}

// ═══════════════════════════════════════════════════════════════════════
//  THREAD-SAFE SETTERS / GETTERS
// ═══════════════════════════════════════════════════════════════════════

void ControllerService::setMeasurement(const RobustDDPController::Measurement& meas) {
    std::lock_guard<std::mutex> lock(input_mutex_);
    current_meas_ = meas;
    has_measurement_ = true;
}

void ControllerService::setCommand(const RobustDDPController::Command& cmd) {
    std::lock_guard<std::mutex> lock(input_mutex_);
    current_cmd_ = cmd;
}

void ControllerService::setNavState(const RobustDDPController::NavState& nav) {
    std::lock_guard<std::mutex> lock(input_mutex_);
    current_nav_ = nav;
}

RobustDDPController::ActuationCommand ControllerService::getLastActuation() const {
    std::lock_guard<std::mutex> lock(output_mutex_);
    return last_actuation_;
}

RobustDDPController::Diagnostics ControllerService::getLastDiagnostics() const {
    std::lock_guard<std::mutex> lock(output_mutex_);
    return last_diagnostics_;
}

// ═══════════════════════════════════════════════════════════════════════
//  PWM COMMAND SENDING  (matches combined_gui.py EXACTLY)
// ═══════════════════════════════════════════════════════════════════════

bool ControllerService::sendPWMCommand(uint8_t channel, float duty_cycle, float frequency,
                                       uint32_t duration_ms) {
    if (udp_socket_fd_ < 0)
        return false;

    // Build packet — total 20 bytes for single command
    uint8_t packet[SINGLE_CMD_PACKET_SIZE];
    size_t offset = 0;

    // ── Header: <BBI> ──────────────────────────────────────────────────
    packet[offset++] = PACKET_TYPE_PWM;  // packet_type = 10
    packet[offset++] = COMMS_VERSION;    // version = 0

    // Timestamp: milliseconds since epoch, truncated to uint32
    auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::system_clock::now().time_since_epoch())
                      .count();
    uint32_t ts = static_cast<uint32_t>(now_ms & 0xFFFFFFFF);
    std::memcpy(&packet[offset], &ts, 4);  // LE on x86
    offset += 4;

    // ── Body: <B> num_commands ──────────────────────────────────────────
    packet[offset++] = 1;  // Single command

    // ── Command: <BIff> ────────────────────────────────────────────────
    packet[offset++] = channel;                     // actuator_id
    std::memcpy(&packet[offset], &duration_ms, 4);  // duration_ms (LE)
    offset += 4;
    std::memcpy(&packet[offset], &duty_cycle, 4);  // duty_cycle (float LE)
    offset += 4;
    std::memcpy(&packet[offset], &frequency, 4);  // frequency (float LE)
    offset += 4;

    // Sanity check
    if (offset != SINGLE_CMD_PACKET_SIZE) {
        std::cerr << "[ControllerService] ❌ Packet build error: wrote " << offset
                  << " bytes, expected " << SINGLE_CMD_PACKET_SIZE << std::endl;
        return false;
    }

    // ── Send via UDP ───────────────────────────────────────────────────
    struct sockaddr_in dest {};
    dest.sin_family = AF_INET;
    dest.sin_port = htons(pwm_config_.actuator_port);
    if (inet_pton(AF_INET, pwm_config_.actuator_board_ip.c_str(), &dest.sin_addr) != 1) {
        std::cerr << "[ControllerService] ❌ Invalid actuator IP: " << pwm_config_.actuator_board_ip
                  << std::endl;
        return false;
    }

    ssize_t sent = sendto(udp_socket_fd_, packet, SINGLE_CMD_PACKET_SIZE, 0,
                          reinterpret_cast<struct sockaddr*>(&dest), sizeof(dest));

    if (sent != static_cast<ssize_t>(SINGLE_CMD_PACKET_SIZE)) {
        std::cerr << "[ControllerService] ❌ sendto failed: " << strerror(errno) << " (sent "
                  << sent << "/" << SINGLE_CMD_PACKET_SIZE << ")" << std::endl;
        return false;
    }

    return true;
}

void ControllerService::sendActuationPWM(const RobustDDPController::ActuationCommand& act) {
    if (!act.valid)
        return;

    float duty_F = static_cast<float>(std::max(0.0, std::min(1.0, act.duty_F)));
    float duty_O = static_cast<float>(std::max(0.0, std::min(1.0, act.duty_O)));

    sendPWMCommand(pwm_config_.fuel_channel, duty_F, pwm_config_.frequency_hz,
                   pwm_config_.duration_ms);
    sendPWMCommand(pwm_config_.lox_channel, duty_O, pwm_config_.frequency_hz,
                   pwm_config_.duration_ms);
}

// ═══════════════════════════════════════════════════════════════════════
//  CONTROLLER LOOP
// ═══════════════════════════════════════════════════════════════════════

void ControllerService::controllerLoop() {
    const auto loop_interval =
        std::chrono::microseconds(static_cast<int64_t>(loop_interval_ms_ * 1000.0));

    int tick = 0;

    while (running_) {
        auto loop_start = std::chrono::steady_clock::now();

        // ── Snapshot inputs ────────────────────────────────────────────
        RobustDDPController::Measurement meas;
        RobustDDPController::Command cmd;
        RobustDDPController::NavState nav;
        bool have_data;
        {
            std::lock_guard<std::mutex> lock(input_mutex_);
            meas = current_meas_;
            cmd = current_cmd_;
            nav = current_nav_;
            have_data = has_measurement_;
        }

        if (!have_data && tick < 5) {
            // No sensor data yet — skip but don't spam
            if (tick == 0) {
                std::cout << "[ControllerService] ⏳ Waiting for sensor data…" << std::endl;
            }
        }

        // ── Run controller step ────────────────────────────────────────
        auto [actuation, diagnostics] = controller_->step(meas, nav, cmd);

        // ── Send PWM commands to actuator board ────────────────────────
        sendActuationPWM(actuation);

        // ── Store outputs for external readers ─────────────────────────
        {
            std::lock_guard<std::mutex> lock(output_mutex_);
            last_actuation_ = actuation;
            last_diagnostics_ = diagnostics;
        }

        // ── Log to console (10% sample) ────────────────────────────────
        if (tick % 10 == 0) {
            std::cout << "[Controller] tick=" << tick << " duty_F=" << actuation.duty_F
                      << " duty_O=" << actuation.duty_O << " F_ref=" << diagnostics.F_ref
                      << " F_est=" << diagnostics.F_estimated << " MR=" << diagnostics.MR_estimated
                      << " P_ch=" << diagnostics.P_ch
                      << (diagnostics.safety_filtered ? " [FILTERED]" : "")
                      << (diagnostics.cutoff_active ? " [CUTOFF]" : "") << std::endl;
        }

        // ── Write to Elodin DB (optional) ──────────────────────────────
        if (elodin_connected_) {
            writeActuationToDB(actuation);
            writeDiagnosticsToDB(diagnostics);
            if (tick % 10 == 0) {  // Don't spam DB with measurements
                writeMeasurementToDB(meas);
            }
        }

        ++tick;

        // ── Sleep to maintain loop rate ────────────────────────────────
        auto loop_end = std::chrono::steady_clock::now();
        auto elapsed = loop_end - loop_start;
        if (elapsed < loop_interval) {
            std::this_thread::sleep_for(loop_interval - elapsed);
        }
    }
}

void ControllerService::elodinSubscriberLoop() {
    std::cout << "[ControllerService] 🎧 Elodin subscriber loop started." << std::endl;
    // Subscribe to Elodin data streams
    if (elodin_client_->is_connected()) {
        elodin_client_->subscribe_stream();
    }
    std::vector<uint8_t> rx_buffer(8192);

    while (running_ && elodin_client_->is_connected()) {
        // Read header first (12 bytes)
        uint8_t header[12];
        if (!elodin_client_->read_packet_header(header)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }

        uint32_t packet_len = *reinterpret_cast<uint32_t*>(header);
        uint8_t packet_type = header[4];
        uint16_t packet_id = (static_cast<uint16_t>(header[5]) << 8) | header[6];

        if (packet_len > rx_buffer.size()) {
            rx_buffer.resize(packet_len);
        }

        std::memcpy(rx_buffer.data(), header, 12);
        size_t payload_len = packet_len - 12;

        if (payload_len > 0) {
            ssize_t read_bytes = elodin_client_->read_data(rx_buffer.data() + 12, payload_len);
            if (read_bytes != static_cast<ssize_t>(payload_len))
                continue;
        }

        uint8_t type_hi = header[5];
        uint8_t channel_id = header[6];

        // 0x20 is PT category. 0x11 to 0x1A are CALIBRATED channels (0x10 + ch_id)
        if (type_hi == 0x20 && channel_id > 0x10 && channel_id <= 0x1A) {
            if (payload_len >= comms::messages::sensor::CalibratedPTMessage::nbytes()) {
                uint8_t* payload = rx_buffer.data() + 12;

                // Deserialize using CommsMessage — matches FSW pattern
                comms::messages::sensor::CalibratedPTMessage cal_msg;
                cal_msg.deserialize(payload);

                float pressure_psi = cal_msg.getField<3>();  // calibrated_pressure_psi
                uint8_t ch = cal_msg.getField<1>();          // channel_id from message
                if (ch == 0)
                    ch = channel_id - 0x10;  // fallback to header

                // Map based on PT names derived from config.toml.
                std::lock_guard<std::mutex> lock(input_mutex_);
                // PT_NAMES[] array positions for the controller fields:
                if (ch == 1)
                    current_meas_.P_u_fuel = pressure_psi * 6894.76;
                else if (ch == 5)
                    current_meas_.P_u_ox = pressure_psi * 6894.76;
                else if (ch == 4)
                    current_meas_.P_d_fuel = pressure_psi * 6894.76;
                else if (ch == 7)
                    current_meas_.P_d_ox = pressure_psi * 6894.76;
                else if (ch == 6)
                    current_meas_.P_reg = pressure_psi * 6894.76;
                else if (ch == 3)
                    current_meas_.P_copv = pressure_psi * 6894.76;

                current_meas_.timestamp = std::chrono::steady_clock::now();
                has_measurement_ = true;
            }
        }
    }
    std::cout << "[ControllerService] 🎧 Elodin subscriber loop stopped." << std::endl;
}

// ═══════════════════════════════════════════════════════════════════════
//  ELODIN DB WRITES (optional — only compiled if HAS_ELODIN)
// ═══════════════════════════════════════════════════════════════════════

template <typename T>
static bool send_msg(fsw::elodin::ElodinClient& client, T msg) {
    auto buf = Msg(msg).encode_vec();
    if (buf.empty())
        return false;
    return client.send_msg({0, 0}, buf);
}

bool ControllerService::registerControllerTables() {
    if (!elodin_client_ || !elodin_connected_)
        return false;

    auto actuation_vt = builder::vtable({
        raw_field(0, 8,
                  schema(PrimType::U64(), {}, component("CONTROLLER.actuation.timestamp_ns"))),
        raw_field(8, 4, schema(PrimType::F32(), {}, component("CONTROLLER.actuation.duty_F"))),
        raw_field(12, 4, schema(PrimType::F32(), {}, component("CONTROLLER.actuation.duty_O"))),
        raw_field(16, 1, schema(PrimType::U8(), {}, component("CONTROLLER.actuation.u_F_on"))),
        raw_field(17, 1, schema(PrimType::U8(), {}, component("CONTROLLER.actuation.u_O_on"))),
        raw_field(18, 1, schema(PrimType::U8(), {}, component("CONTROLLER.actuation.valid"))),
    });

    auto diagnostics_vt = builder::vtable({
        raw_field(0, 8,
                  schema(PrimType::U64(), {}, component("CONTROLLER.diagnostics.timestamp_ns"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.F_ref"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.MR_ref"))),
        raw_field(24, 8,
                  schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.F_estimated"))),
        raw_field(32, 8,
                  schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.MR_estimated"))),
        raw_field(40, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.P_ch"))),
        raw_field(48, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.cost"))),
        raw_field(56, 1,
                  schema(PrimType::U8(), {}, component("CONTROLLER.diagnostics.safety_filtered"))),
        raw_field(57, 1,
                  schema(PrimType::U8(), {}, component("CONTROLLER.diagnostics.cutoff_active"))),
        raw_field(58, 4,
                  schema(PrimType::I32(), {}, component("CONTROLLER.diagnostics.solver_iters"))),
    });

    auto measurement_vt = builder::vtable({
        raw_field(0, 8,
                  schema(PrimType::U64(), {}, component("CONTROLLER.measurement.timestamp_ns"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_copv"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_reg"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_u_fuel"))),
        raw_field(32, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_u_ox"))),
        raw_field(40, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_d_fuel"))),
        raw_field(48, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_d_ox"))),
    });

    send_msg(*elodin_client_, VTableMsg{.id = std::make_tuple(uint8_t(0x40), uint8_t(0x00)),
                                        .vtable = actuation_vt});
    send_msg(*elodin_client_, VTableMsg{.id = std::make_tuple(uint8_t(0x41), uint8_t(0x00)),
                                        .vtable = diagnostics_vt});
    send_msg(*elodin_client_, VTableMsg{.id = std::make_tuple(uint8_t(0x42), uint8_t(0x00)),
                                        .vtable = measurement_vt});

    std::cout << "[ControllerService] ✅ Registered controller tables with Elodin DB" << std::endl;
    return true;
}

void ControllerService::writeActuationToDB(const RobustDDPController::ActuationCommand& actuation) {
    constexpr uint16_t ACTUATION_MESSAGE_ID = 0x4000;

    comms::messages::control::ControllerActuationMessage msg;
    std::get<0>(msg.fields) = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                  std::chrono::steady_clock::now().time_since_epoch())
                                  .count();
    std::get<1>(msg.fields) = static_cast<float>(actuation.duty_F);
    std::get<2>(msg.fields) = static_cast<float>(actuation.duty_O);
    std::get<3>(msg.fields) = actuation.u_F_on ? 1 : 0;
    std::get<4>(msg.fields) = actuation.u_O_on ? 1 : 0;
    std::get<5>(msg.fields) = actuation.valid ? 1 : 0;

    elodin_client_->publish(ACTUATION_MESSAGE_ID, msg);
}

void ControllerService::writeDiagnosticsToDB(const RobustDDPController::Diagnostics& diagnostics) {
    constexpr uint16_t DIAGNOSTICS_MESSAGE_ID = 0x4100;

    comms::messages::control::ControllerDiagnosticsMessage msg;
    std::get<0>(msg.fields) = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                  std::chrono::steady_clock::now().time_since_epoch())
                                  .count();
    std::get<1>(msg.fields) = diagnostics.F_ref;
    std::get<2>(msg.fields) = diagnostics.MR_ref;
    std::get<3>(msg.fields) = diagnostics.F_estimated;
    std::get<4>(msg.fields) = diagnostics.MR_estimated;
    std::get<5>(msg.fields) = diagnostics.P_ch;
    std::get<6>(msg.fields) = diagnostics.cost;
    std::get<7>(msg.fields) = diagnostics.safety_filtered ? 1 : 0;
    std::get<8>(msg.fields) = diagnostics.cutoff_active ? 1 : 0;
    std::get<9>(msg.fields) = static_cast<int32_t>(diagnostics.solver_iters);

    elodin_client_->publish(DIAGNOSTICS_MESSAGE_ID, msg);
}

void ControllerService::writeMeasurementToDB(const RobustDDPController::Measurement& measurement) {
    constexpr uint16_t MEASUREMENT_MESSAGE_ID = 0x4200;

    comms::messages::control::ControllerMeasurementMessage msg;
    auto ts_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                     measurement.timestamp.time_since_epoch())
                     .count();
    std::get<0>(msg.fields) = ts_ns;
    std::get<1>(msg.fields) = measurement.P_copv;
    std::get<2>(msg.fields) = measurement.P_reg;
    std::get<3>(msg.fields) = measurement.P_u_fuel;
    std::get<4>(msg.fields) = measurement.P_u_ox;
    std::get<5>(msg.fields) = measurement.P_d_fuel;
    std::get<6>(msg.fields) = measurement.P_d_ox;

    elodin_client_->publish(MEASUREMENT_MESSAGE_ID, msg);
}

}  // namespace control
}  // namespace fsw
