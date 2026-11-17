#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "comms/messages/control/ControllerMessages.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"
#include "control/ControllerService.hpp"
#include "control/RobustDDPController.hpp"
#include "db.hpp"
#include "elodin/ElodinClient.hpp"
#include "elodin/SendMsg.hpp"
#include "net/DaqInterface.hpp"

using namespace vtable;
using namespace vtable::builder;

namespace fsw {
namespace control {

/**
 * Connect the subscriber and subscribe to everything it reads.
 *
 * Both halves must run on every reconnect, not just the first connect: the VTables live in the db
 * process, so a db restart loses them and a reconnect that skips re-subscription comes back
 * permanently silent. SequencerService::tryConnectElodin() documents the same rule for the
 * publishing side, and heartbeat_service treats a failed subscribe as a failed connection for
 * exactly this reason — so this returns false and lets the caller retry the whole thing.
 */
bool ControllerService::connectSubscriber() {
    if (elodin_host_.empty())
        return false;
    if (!elodin_subscriber_->connect(elodin_host_, elodin_port_))
        return false;

    // Calibrated PT tables for all board-number slots.
    // low byte encoding: (board_number-1)*0x20 + 0x10 + channel
    std::vector<std::pair<uint8_t, uint8_t>> tables;
    for (uint8_t board_number = 1; board_number <= 10; ++board_number) {
        const uint8_t base = static_cast<uint8_t>((board_number - 1) * 0x20);
        for (uint8_t ch = 1; ch <= 10; ++ch)
            tables.push_back({0x20, static_cast<uint8_t>(base + 0x10 + ch)});
    }
    // Sequencer state stream [0x50,0x00] for FIRE gate parity.
    tables.push_back({0x50, 0x00});
    if (!elodin_subscriber_->subscribe_tables(tables)) {
        std::cerr << "[ControllerService] ⚠️  Elodin subscribe failed — dropping the connection "
                     "so it is retried rather than sitting on a silent socket"
                  << std::endl;
        elodin_subscriber_->disconnect();
        return false;
    }

    std::cout << "[ControllerService] ✅ Elodin subscriber connected — "
                 "subscribed to calibrated PT + Sequencer state"
              << std::endl;
    return true;
}

void ControllerService::elodinSubscriberLoop() {
    std::cout
        << "[ControllerService] 🎧 Elodin subscriber loop started (dedicated subscriber client)."
        << std::endl;
    std::vector<uint8_t> rx_buffer(8192);

    // Outer loop: reconnect. This used to be absent — the thread started once and its inner loop
    // exited the moment is_connected() went false, so a single db restart or network blip left
    // the controller deaf to sequencer state for the life of the process, with nothing but one
    // log line to say so. That matters because this path is the FIRE-gate parity fallback: it is
    // what closes the PWM gate if the TCP command path is not working.
    while (running_) {
        if (!elodin_subscriber_->is_connected()) {
            if (!connectSubscriber()) {
                for (int i = 0; i < 20 && running_; ++i)
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }
        }
        subscriberReadLoop(rx_buffer);
        if (running_)
            std::cerr << "[ControllerService] ⚠️  Elodin subscriber disconnected — reconnecting"
                      << std::endl;
    }
    std::cout << "[ControllerService] 🎧 Elodin subscriber loop stopped." << std::endl;
}

void ControllerService::subscriberReadLoop(std::vector<uint8_t>& rx_buffer) {
    while (running_ && elodin_subscriber_->is_connected()) {
        // 8-byte Elodin header: len(4) ty(1) id_hi(1) id_lo(1) req_id(1)
        uint8_t header[8];
        if (!elodin_subscriber_->read_packet_header(header)) {
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
            // Use blocking read_bytes_exact so we never misalign on a partial payload.
            // The non-blocking read_data would return 0 if bytes aren't in the socket
            // buffer yet, causing the next read_packet_header to consume payload bytes
            // as a header and corrupt all subsequent reads.
            if (!elodin_subscriber_->read_bytes_exact(rx_buffer.data() + 8, payload_len))
                continue;
        }

        uint8_t type_hi = header[5];
        uint8_t pid_lo = header[6];

        // Sequencer state [0x50,0x00] -> keep controller FIRE gate in parity even
        // if TCP FIRE_START/FIRE_STOP control path misses an edge.
        if (type_hi == 0x50 && pid_lo == 0x00 && payload_len >= 17) {
            uint8_t state_val = rx_buffer[8 + 8];
            // Parity fallback for a missed TCP FIRE_START/FIRE_STOP edge. The id comes from
            // config ([fire] state) via setFireStateId rather than a literal, so renumbering
            // states cannot move the PWM ignition gate onto a different one.
            //
            // Skipped entirely when the gate is disabled — setFireActive() would refuse anyway,
            // but this branch runs at packet rate and there is no reason to call into it
            // continuously just to be turned away. The `continue` stays either way so the packet
            // is still consumed rather than falling through to the PT decoders below.
            if (fire_gate_enabled_.load())
                setFireActive(state_val == fire_state_id_);
            continue;
        }

        // 0x20 is PT category; calibrated channels for the low-pressure PT board (#1,
        // board_id=21 → board_number=1) are encoded as pid_lo in 0x11..0x1A.
        // Do NOT mask off board bits here (e.g. &0x1F) or we will mis-map HP PT
        // channels into Fuel/Ox channels and the controller will sit on zeros.
        if (type_hi == 0x20) {
            if (pid_lo < 0x11 || pid_lo > 0x1A)
                continue;

            if (payload_len >= comms::messages::sensor::CalibratedPTMessage::nbytes()) {
                uint8_t* payload = rx_buffer.data() + 8;

                // Deserialize using CommsMessage — matches FSW pattern
                comms::messages::sensor::CalibratedPTMessage cal_msg;
                cal_msg.deserialize(payload);

                float pressure_psi = cal_msg.getField<3>();  // calibrated_pressure_psi
                uint8_t ch = cal_msg.getField<1>();          // channel_id from message
                if (ch == 0)
                    ch = static_cast<uint8_t>(pid_lo - 0x10);  // fallback to header

                // Map based on PT names derived from config.toml (ch 4/8 = Chamber Mid 1/2).
                std::lock_guard<std::mutex> lock(input_mutex_);
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
                } else if (ch == 4)
                    current_meas_.P_ch_mp1 = pressure_psi * 6894.76;
                else if (ch == 8)
                    current_meas_.P_ch_mp2 = pressure_psi * 6894.76;

                current_meas_.timestamp = std::chrono::steady_clock::now();
                has_measurement_ = true;
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  ELODIN DB WRITES (optional — only compiled if HAS_ELODIN)
// ═══════════════════════════════════════════════════════════════════════

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
        raw_field(56, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_ch_mp1"))),
        raw_field(64, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_ch_mp2"))),
    });

    // PSM state transition [0x43, 0x00]: U64(8) + U8(1) + U8(1) + U8(1) = 11 bytes
    auto state_trans_vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CONTROLLER.state.timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.from_state"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.to_state"))),
        raw_field(10, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.reason"))),
    });

    // Fire state event [0x44, 0x00]: U64(8) + U8(1) + F32(4) + F32(4) = 17 bytes
    auto fire_state_vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CONTROLLER.fire.timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component("CONTROLLER.fire.fire_active"))),
        raw_field(9, 4, schema(PrimType::F32(), {}, component("CONTROLLER.fire.duty_F"))),
        raw_field(13, 4, schema(PrimType::F32(), {}, component("CONTROLLER.fire.duty_O"))),
    });

    fsw::elodin::send_msg(
        *elodin_client_,
        VTableMsg{.id = std::make_tuple(uint8_t(0x40), uint8_t(0x00)), .vtable = actuation_vt},
        nullptr);
    fsw::elodin::send_msg(
        *elodin_client_,
        VTableMsg{.id = std::make_tuple(uint8_t(0x41), uint8_t(0x00)), .vtable = diagnostics_vt},
        nullptr);
    fsw::elodin::send_msg(
        *elodin_client_,
        VTableMsg{.id = std::make_tuple(uint8_t(0x42), uint8_t(0x00)), .vtable = measurement_vt},
        nullptr);
    fsw::elodin::send_msg(
        *elodin_client_,
        VTableMsg{.id = std::make_tuple(uint8_t(0x43), uint8_t(0x00)), .vtable = state_trans_vt},
        nullptr);
    fsw::elodin::send_msg(
        *elodin_client_,
        VTableMsg{.id = std::make_tuple(uint8_t(0x44), uint8_t(0x00)), .vtable = fire_state_vt},
        nullptr);

    // Send component names so Elodin exports with strings instead of schema hashes
    std::vector<std::string> actuation_fields = {
        "CONTROLLER.actuation.timestamp_ns", "CONTROLLER.actuation.duty_F",
        "CONTROLLER.actuation.duty_O",       "CONTROLLER.actuation.u_F_on",
        "CONTROLLER.actuation.u_O_on",       "CONTROLLER.actuation.valid"};
    std::vector<std::string> diagnostics_fields = {"CONTROLLER.diagnostics.timestamp_ns",
                                                   "CONTROLLER.diagnostics.F_ref",
                                                   "CONTROLLER.diagnostics.MR_ref",
                                                   "CONTROLLER.diagnostics.F_estimated",
                                                   "CONTROLLER.diagnostics.MR_estimated",
                                                   "CONTROLLER.diagnostics.P_ch",
                                                   "CONTROLLER.diagnostics.cost",
                                                   "CONTROLLER.diagnostics.solver_iters",
                                                   "CONTROLLER.diagnostics.safety_filtered",
                                                   "CONTROLLER.diagnostics.cutoff_active"};
    std::vector<std::string> measurement_fields = {
        "CONTROLLER.measurement.timestamp_ns", "CONTROLLER.measurement.P_copv",
        "CONTROLLER.measurement.P_reg",        "CONTROLLER.measurement.P_u_fuel",
        "CONTROLLER.measurement.P_u_ox",       "CONTROLLER.measurement.P_d_fuel",
        "CONTROLLER.measurement.P_d_ox",       "CONTROLLER.measurement.P_ch_mp1",
        "CONTROLLER.measurement.P_ch_mp2"};
    std::vector<std::string> state_fields = {
        "CONTROLLER.state.timestamp_ns", "CONTROLLER.state.from_state", "CONTROLLER.state.to_state",
        "CONTROLLER.state.reason"};
    std::vector<std::string> fire_fields = {"CONTROLLER.fire.timestamp_ns",
                                            "CONTROLLER.fire.fire_active", "CONTROLLER.fire.duty_F",
                                            "CONTROLLER.fire.duty_O"};

    for (const auto& f : actuation_fields)
        fsw::elodin::send_msg(*elodin_client_, set_component_name(f), nullptr);
    for (const auto& f : diagnostics_fields)
        fsw::elodin::send_msg(*elodin_client_, set_component_name(f), nullptr);
    for (const auto& f : measurement_fields)
        fsw::elodin::send_msg(*elodin_client_, set_component_name(f), nullptr);
    for (const auto& f : state_fields)
        fsw::elodin::send_msg(*elodin_client_, set_component_name(f), nullptr);
    for (const auto& f : fire_fields)
        fsw::elodin::send_msg(*elodin_client_, set_component_name(f), nullptr);

    fsw::elodin::send_msg(*elodin_client_, set_entity_name(0x4000, "CONTROLLER.actuation"),
                          nullptr);
    fsw::elodin::send_msg(*elodin_client_, set_entity_name(0x4100, "CONTROLLER.diagnostics"),
                          nullptr);
    fsw::elodin::send_msg(*elodin_client_, set_entity_name(0x4200, "CONTROLLER.measurement"),
                          nullptr);
    fsw::elodin::send_msg(*elodin_client_, set_entity_name(0x4300, "CONTROLLER.state"), nullptr);
    fsw::elodin::send_msg(*elodin_client_, set_entity_name(0x4400, "CONTROLLER.fire"), nullptr);

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
    std::get<7>(msg.fields) = measurement.P_ch_mp1;
    std::get<8>(msg.fields) = measurement.P_ch_mp2;

    elodin_client_->publish(MEASUREMENT_MESSAGE_ID, msg);
}

}  // namespace control
}  // namespace fsw
