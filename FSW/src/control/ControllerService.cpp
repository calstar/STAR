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
#include "comms/messages/sensor/SensorMessages.hpp"
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
                                   const std::string& elodin_host, uint16_t elodin_port,
                                   const std::string& relay_host, uint16_t relay_port) {
    relay_host_ = relay_host;
    relay_port_ = relay_port;
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

    // ── Load PT calibration (for raw ADC → PSI in relay subscriber) ───────
    pt_calibration_.load_calibration();
    if (pt_calibration_.get_calibrated_count() > 0)
        std::cout << "[ControllerService] ✅ PT calibration loaded ("
                  << pt_calibration_.get_calibrated_count() << " channels)" << std::endl;
    else
        std::cout << "[ControllerService] ⚠️  No PT calibration files found — "
                     "using linear ADC fallback"
                  << std::endl;

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
    relay_subscriber_thread_ = std::thread(&ControllerService::relaySubscriberLoop, this);

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
    if (relay_subscriber_thread_.joinable()) {
        relay_subscriber_thread_.join();
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

void ControllerService::setFireActive(bool active) {
    fire_active_ = active;
    std::cout << "[ControllerService] 🔥 Fire state: "
              << (active ? "ACTIVE — PWM enabled" : "INACTIVE — PWM suppressed") << std::endl;
}

void ControllerService::setTestDuty(float fuel, float ox) {
    test_duty_fuel_ = std::max(0.0f, std::min(1.0f, fuel));
    test_duty_ox_ = std::max(0.0f, std::min(1.0f, ox));
    if (fuel > 0.0f || ox > 0.0f)
        std::cout << "[ControllerService] 🧪 Test duty override: fuel=" << test_duty_fuel_.load()
                  << " ox=" << test_duty_ox_.load() << " (DDP bypassed)" << std::endl;
    else
        std::cout << "[ControllerService] 🧪 Test duty cleared — DDP controller active"
                  << std::endl;
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

        if (!have_data) {
            // No sensor data yet — do not run controller or send any PWM
            if (tick == 0 || tick % 50 == 0) {
                std::cout << "[ControllerService] ⏳ Waiting for sensor data from Elodin relay…"
                          << std::endl;
            }
            ++tick;
            auto loop_end = std::chrono::steady_clock::now();
            auto elapsed = loop_end - loop_start;
            if (elapsed < loop_interval)
                std::this_thread::sleep_for(loop_interval - elapsed);
            continue;
        }

        // ── Run controller step (or use fixed test duty) ───────────────
        float td_f = test_duty_fuel_.load();
        float td_o = test_duty_ox_.load();

        RobustDDPController::ActuationCommand actuation;
        RobustDDPController::Diagnostics diagnostics;

        if (td_f > 0.0f || td_o > 0.0f) {
            // Open-loop validation: bypass DDP, send fixed duty cycles
            actuation.duty_F = td_f;
            actuation.duty_O = td_o;
            actuation.u_F_on = td_f > 0.0f;
            actuation.u_O_on = td_o > 0.0f;
            actuation.valid = true;
        } else {
            auto [a, d] = controller_->step(meas, nav, cmd);
            actuation = a;
            diagnostics = d;
        }

        // ── Send PWM commands only when FIRE state is active ──────────
        if (fire_active_) {
            sendActuationPWM(actuation);
        }

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
            // Drain any responses Elodin DB sends back — without this the recv
            // buffer fills, Elodin DB applies TCP backpressure, and our send
            // buffer grows unboundedly until the write blocks.
            {
                std::array<uint8_t, 4096> drain_buf;
                while (elodin_client_->read_data(drain_buf.data(), drain_buf.size()) > 0) {
                }
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

// ═══════════════════════════════════════════════════════════════════════
//  RELAY WEBSOCKET SUBSCRIBER
//  Minimal WebSocket client — connects to Elodin Relay (ws://host:port)
//  and parses binary frames containing Elodin TABLE packets.
// ═══════════════════════════════════════════════════════════════════════

static int ws_tcp_connect(const std::string& host, uint16_t port) {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;
    struct sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
        ::close(fd);
        return -1;
    }
    if (::connect(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) != 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

static bool read_exact(int fd, uint8_t* buf, size_t n) {
    size_t total = 0;
    while (total < n) {
        ssize_t r = recv(fd, buf + total, n - total, 0);
        if (r <= 0)
            return false;
        total += static_cast<size_t>(r);
    }
    return true;
}

static bool ws_upgrade(int fd, const std::string& host, uint16_t port) {
    std::string req =
        "GET / HTTP/1.1\r\n"
        "Host: " +
        host + ":" + std::to_string(port) +
        "\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n";
    if (send(fd, req.c_str(), req.size(), 0) < 0)
        return false;
    char buf[2048];
    std::string resp;
    while (resp.find("\r\n\r\n") == std::string::npos) {
        ssize_t n = recv(fd, buf, sizeof(buf) - 1, 0);
        if (n <= 0)
            return false;
        buf[n] = '\0';
        resp += buf;
    }
    return resp.find("101") != std::string::npos;
}

static bool ws_read_frame(int fd, std::vector<uint8_t>& out) {
    uint8_t hdr[2];
    if (!read_exact(fd, hdr, 2))
        return false;
    uint8_t opcode = hdr[0] & 0x0F;
    if (opcode == 0x08)
        return false;  // close frame
    uint64_t plen = hdr[1] & 0x7F;
    if (plen == 126) {
        uint8_t ext[2];
        if (!read_exact(fd, ext, 2))
            return false;
        plen = (uint64_t(ext[0]) << 8) | ext[1];
    } else if (plen == 127) {
        uint8_t ext[8];
        if (!read_exact(fd, ext, 8))
            return false;
        plen = 0;
        for (int i = 0; i < 8; ++i)
            plen = (plen << 8) | ext[i];
    }
    if (plen == 0) {
        out.clear();
        return true;
    }
    out.resize(plen);
    return read_exact(fd, out.data(), plen);
}

void ControllerService::relaySubscriberLoop() {
    std::cout << "[ControllerService] Relay subscriber: ws://" << relay_host_ << ":" << relay_port_
              << std::endl;
    std::vector<uint8_t> frame;

    while (running_) {
        int fd = ws_tcp_connect(relay_host_, relay_port_);
        if (fd < 0) {
            std::cerr << "[ControllerService] Relay connect failed, retrying in 2s..." << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(2));
            continue;
        }
        if (!ws_upgrade(fd, relay_host_, relay_port_)) {
            std::cerr << "[ControllerService] Relay WS handshake failed, retrying..." << std::endl;
            ::close(fd);
            std::this_thread::sleep_for(std::chrono::seconds(2));
            continue;
        }
        std::cout << "[ControllerService] ✅ Connected to Elodin Relay WS" << std::endl;

        while (running_) {
            if (!ws_read_frame(fd, frame))
                break;
            if (frame.size() < 8)
                continue;

            // 8-byte Elodin header: len(4) ty(1) packetId[2](1+1) requestId(1)
            uint8_t ty = frame[4];
            uint8_t pid_hi = frame[5];
            uint8_t pid_lo = frame[6];

            if (ty != 1)
                continue;  // TABLE only
            if (pid_hi != 0x20)
                continue;

            const uint8_t* payload = frame.data() + 8;
            size_t payload_size = frame.size() - 8;

            float pressure_psi = 0.0f;
            uint8_t ch = 0;

            if (pid_lo >= 0x01 && pid_lo <= 0x0A) {
                // ── Raw PT [0x20, 0x01..0x0A] — calibrate inline ──────────
                if (payload_size < comms::messages::sensor::RawPTMessage::nbytes())
                    continue;
                comms::messages::sensor::RawPTMessage raw_msg;
                raw_msg.deserialize(payload);
                ch = raw_msg.getField<1>();  // channel_id from message
                if (ch == 0)
                    ch = pid_lo;  // fallback to packet low byte
                uint32_t raw_adc = raw_msg.getField<3>();
                double psi_d =
                    pt_calibration_.calculate_pressure(ch, static_cast<int32_t>(raw_adc));
                if (!std::isfinite(psi_d) || psi_d < -50.0 || psi_d > 15000.0) {
                    // Fallback: simple linear scale (320M ADC ≈ 20 PSI, 80M range ≈ 0–68 PSI)
                    constexpr double ADC_MAX = 2147483648.0;
                    psi_d = (static_cast<double>(raw_adc) / ADC_MAX) * 500.0;
                }
                pressure_psi = static_cast<float>(psi_d);
            } else if (pid_lo >= 0x11 && pid_lo <= 0x1A) {
                // ── Calibrated PT [0x20, 0x11..0x1A] — use directly ───────
                if (payload_size < comms::messages::sensor::CalibratedPTMessage::nbytes())
                    continue;
                comms::messages::sensor::CalibratedPTMessage cal_msg;
                cal_msg.deserialize(payload);
                ch = pid_lo - 0x10;  // channel 1-10
                pressure_psi = cal_msg.getField<3>();
            } else {
                continue;
            }

            if (ch == 0 || !std::isfinite(pressure_psi))
                continue;

            {
                std::lock_guard<std::mutex> lock(input_mutex_);
                // Channel mapping from config.toml [sensor_roles_pt_board]:
                // ch=1: FUEL UP → P_u_fuel, ch=3: FUEL DN → P_d_fuel
                // ch=5: LOX UP → P_u_ox, ch=7: LOX DN → P_d_ox
                // ch=6: GN2 REG → P_reg / P_copv proxy
                if (ch == 1)
                    current_meas_.P_u_fuel = pressure_psi * 6894.76;
                else if (ch == 5)
                    current_meas_.P_u_ox = pressure_psi * 6894.76;
                else if (ch == 3)
                    current_meas_.P_d_fuel = pressure_psi * 6894.76;
                else if (ch == 7)
                    current_meas_.P_d_ox = pressure_psi * 6894.76;
                else if (ch == 6) {
                    current_meas_.P_reg = pressure_psi * 6894.76;
                    current_meas_.P_copv = pressure_psi * 6894.76;
                }
                current_meas_.timestamp = std::chrono::steady_clock::now();
                has_measurement_ = true;
            }
        }

        ::close(fd);
        if (running_) {
            std::cerr << "[ControllerService] Relay WS disconnected, reconnecting..." << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
    std::cout << "[ControllerService] Relay subscriber stopped." << std::endl;
}

void ControllerService::elodinSubscriberLoop() {
    std::cout << "[ControllerService] 🎧 Elodin subscriber loop started." << std::endl;
    // Subscribe to Elodin data streams
    if (elodin_client_->is_connected()) {
        elodin_client_->subscribe_stream();
    }
    std::vector<uint8_t> rx_buffer(8192);

    while (running_ && elodin_client_->is_connected()) {
        // 8-byte Elodin header: len(4) ty(1) id_hi(1) id_lo(1) req_id(1)
        uint8_t header[8];
        if (!elodin_client_->read_packet_header(header)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }

        // packet_len counts bytes after the 4-byte len field, so payload = packet_len - 4
        uint32_t packet_len = *reinterpret_cast<uint32_t*>(header);
        if (packet_len < 4 || packet_len > 65536) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            continue;
        }
        size_t payload_len = packet_len - 4;

        if (payload_len + 8 > rx_buffer.size()) {
            rx_buffer.resize(payload_len + 8);
        }

        std::memcpy(rx_buffer.data(), header, 8);

        if (payload_len > 0) {
            ssize_t read_bytes = elodin_client_->read_data(rx_buffer.data() + 8, payload_len);
            if (read_bytes != static_cast<ssize_t>(payload_len))
                continue;
        }

        uint8_t type_hi = header[5];
        uint8_t channel_id = header[6];

        // 0x20 is PT category. 0x11 to 0x1A are CALIBRATED channels (0x10 + ch_id)
        if (type_hi == 0x20 && channel_id > 0x10 && channel_id <= 0x1A) {
            if (payload_len >= comms::messages::sensor::CalibratedPTMessage::nbytes()) {
                uint8_t* payload = rx_buffer.data() + 8;

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
                else if (ch == 3)
                    current_meas_.P_d_fuel = pressure_psi * 6894.76;
                else if (ch == 7)
                    current_meas_.P_d_ox = pressure_psi * 6894.76;
                else if (ch == 6) {
                    current_meas_.P_reg = pressure_psi * 6894.76;
                    current_meas_.P_copv = pressure_psi * 6894.76;
                }

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

    // Field order matches ControllerDiagnosticsMessage (tight-packed, aligned):
    //   U64@0 + 6×F64@8..55 + I32@56 (4-byte aligned) + U8@60 + U8@61 = 62 bytes
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
        raw_field(56, 4,
                  schema(PrimType::I32(), {}, component("CONTROLLER.diagnostics.solver_iters"))),
        raw_field(60, 1,
                  schema(PrimType::U8(), {}, component("CONTROLLER.diagnostics.safety_filtered"))),
        raw_field(61, 1,
                  schema(PrimType::U8(), {}, component("CONTROLLER.diagnostics.cutoff_active"))),
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
                                  std::chrono::system_clock::now().time_since_epoch())
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
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count();
    std::get<1>(msg.fields) = diagnostics.F_ref;
    std::get<2>(msg.fields) = diagnostics.MR_ref;
    std::get<3>(msg.fields) = diagnostics.F_estimated;
    std::get<4>(msg.fields) = diagnostics.MR_estimated;
    std::get<5>(msg.fields) = diagnostics.P_ch;
    std::get<6>(msg.fields) = diagnostics.cost;
    std::get<7>(msg.fields) = static_cast<int32_t>(diagnostics.solver_iters);
    std::get<8>(msg.fields) = diagnostics.safety_filtered ? 1 : 0;
    std::get<9>(msg.fields) = diagnostics.cutoff_active ? 1 : 0;

    elodin_client_->publish(DIAGNOSTICS_MESSAGE_ID, msg);
}

void ControllerService::writeMeasurementToDB(const RobustDDPController::Measurement& measurement) {
    constexpr uint16_t MEASUREMENT_MESSAGE_ID = 0x4200;

    comms::messages::control::ControllerMeasurementMessage msg;
    // Use system_clock for consistency with DAQ bridge (epoch ms in GUI).
    auto ts_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                     std::chrono::system_clock::now().time_since_epoch())
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
