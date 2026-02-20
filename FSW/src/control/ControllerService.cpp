/**
 * @file ControllerService.cpp
 * @brief C++ controller service integrated with Elodin DB
 *
 * This service:
 * 1. Reads sensor measurements from Elodin DB
 * 2. Runs RobustDDPController to compute actuation commands
 * 3. Writes controller outputs (actuation + diagnostics) to Elodin DB
 * 4. Supports SITL and HITL runs with full replay capability
 */

#include "control/ControllerService.hpp"

#include <chrono>
#include <iostream>
#include <thread>

#include "control/RobustDDPController.hpp"
#include "db.hpp"  // utl/db.hpp — VTable builder, Msg, postcard encoding
#include "elodin/ElodinClient.hpp"

using namespace vtable;
using namespace vtable::builder;

namespace fsw {
namespace control {

ControllerService::ControllerService()
    : running_(false),
      elodin_client_(std::make_unique<elodin::ElodinClient>()),
      controller_(std::make_unique<RobustDDPController>()) {
}

ControllerService::~ControllerService() {
    stop();
}

bool ControllerService::initialize(const std::string& elodin_host, uint16_t elodin_port,
                                  const RobustDDPController::Config& controller_config) {
    // Connect to Elodin DB
    if (!elodin_client_->connect(elodin_host, elodin_port)) {
        std::cerr << "[ControllerService] ❌ Failed to connect to Elodin DB at " << elodin_host
                  << ":" << elodin_port << std::endl;
        return false;
    }

    std::cout << "[ControllerService] ✅ Connected to Elodin DB at " << elodin_host << ":"
              << elodin_port << std::endl;

    // Register controller message tables with Elodin
    if (!registerControllerTables()) {
        std::cerr << "[ControllerService] ❌ Failed to register controller tables" << std::endl;
        return false;
    }

    // Initialize controller
    if (!controller_->initialize(controller_config)) {
        std::cerr << "[ControllerService] ❌ Failed to initialize RobustDDPController"
                  << std::endl;
        return false;
    }

    std::cout << "[ControllerService] ✅ Controller initialized" << std::endl;

    return true;
}

// Helper: encode a db.hpp message and send via ElodinClient
template <typename T>
static bool send_msg(elodin::ElodinClient& client, T msg) {
    auto buf = Msg(msg).encode_vec();
    if (buf.empty()) {
        std::cerr << "[ControllerService] Failed to encode message" << std::endl;
        return false;
    }
    return client.send_msg({0, 0}, buf);  // packet_id unused — already in buf
}

bool ControllerService::registerControllerTables() {
    // Packet IDs for controller messages
    constexpr std::array<uint8_t, 2> ACTUATION_PACKET_ID = {0x40, 0x00};
    constexpr std::array<uint8_t, 2> DIAGNOSTICS_PACKET_ID = {0x41, 0x00};
    constexpr std::array<uint8_t, 2> MEASUREMENT_PACKET_ID = {0x42, 0x00};

    // Register ControllerActuationMessage VTable
    // Fields: timestamp_ns (u64), duty_F (f32), duty_O (f32), u_F_on (u8), u_O_on (u8), valid (u8)
    // Total: 8 + 4 + 4 + 1 + 1 + 1 = 19 bytes
    auto actuation_vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CONTROLLER.actuation.timestamp_ns"))),
        raw_field(8, 4, schema(PrimType::F32(), {}, component("CONTROLLER.actuation.duty_F"))),
        raw_field(12, 4, schema(PrimType::F32(), {}, component("CONTROLLER.actuation.duty_O"))),
        raw_field(16, 1, schema(PrimType::U8(), {}, component("CONTROLLER.actuation.u_F_on"))),
        raw_field(17, 1, schema(PrimType::U8(), {}, component("CONTROLLER.actuation.u_O_on"))),
        raw_field(18, 1, schema(PrimType::U8(), {}, component("CONTROLLER.actuation.valid"))),
    });

    // Register ControllerDiagnosticsMessage VTable
    // Fields: timestamp_ns (u64), F_ref (f64), MR_ref (f64), F_estimated (f64), MR_estimated (f64),
    //         P_ch (f64), cost (f64), safety_filtered (u8), cutoff_active (u8), solver_iters (i32)
    // Total: 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 4 = 62 bytes
    auto diagnostics_vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CONTROLLER.diagnostics.timestamp_ns"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.F_ref"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.MR_ref"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.F_estimated"))),
        raw_field(32, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.MR_estimated"))),
        raw_field(40, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.P_ch"))),
        raw_field(48, 8, schema(PrimType::F64(), {}, component("CONTROLLER.diagnostics.cost"))),
        raw_field(56, 1, schema(PrimType::U8(), {}, component("CONTROLLER.diagnostics.safety_filtered"))),
        raw_field(57, 1, schema(PrimType::U8(), {}, component("CONTROLLER.diagnostics.cutoff_active"))),
        raw_field(58, 4, schema(PrimType::I32(), {}, component("CONTROLLER.diagnostics.solver_iters"))),
    });

    // Register ControllerMeasurementMessage VTable
    // Fields: timestamp_ns (u64), P_copv (f64), P_reg (f64), P_u_fuel (f64), P_u_ox (f64),
    //         P_d_fuel (f64), P_d_ox (f64)
    // Total: 8 + 8 + 8 + 8 + 8 + 8 + 8 = 56 bytes
    auto measurement_vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CONTROLLER.measurement.timestamp_ns"))),
        raw_field(8, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_copv"))),
        raw_field(16, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_reg"))),
        raw_field(24, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_u_fuel"))),
        raw_field(32, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_u_ox"))),
        raw_field(40, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_d_fuel"))),
        raw_field(48, 8, schema(PrimType::F64(), {}, component("CONTROLLER.measurement.P_d_ox"))),
    });

    // Send VTable registration messages
    if (!send_msg(*elodin_client_, VTableMsg{.id = ACTUATION_PACKET_ID, .vtable = actuation_vt})) {
        std::cerr << "[ControllerService] ❌ Failed to register actuation VTable" << std::endl;
        return false;
    }

    // Set component names for actuation
    send_msg(*elodin_client_, set_component_name("CONTROLLER.actuation.timestamp_ns"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.actuation.duty_F"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.actuation.duty_O"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.actuation.u_F_on"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.actuation.u_O_on"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.actuation.valid"));

    if (!send_msg(*elodin_client_, VTableMsg{.id = DIAGNOSTICS_PACKET_ID, .vtable = diagnostics_vt})) {
        std::cerr << "[ControllerService] ❌ Failed to register diagnostics VTable" << std::endl;
        return false;
    }

    // Set component names for diagnostics
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.timestamp_ns"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.F_ref"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.MR_ref"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.F_estimated"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.MR_estimated"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.P_ch"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.cost"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.safety_filtered"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.cutoff_active"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.diagnostics.solver_iters"));

    if (!send_msg(*elodin_client_, VTableMsg{.id = MEASUREMENT_PACKET_ID, .vtable = measurement_vt})) {
        std::cerr << "[ControllerService] ❌ Failed to register measurement VTable" << std::endl;
        return false;
    }

    // Set component names for measurement
    send_msg(*elodin_client_, set_component_name("CONTROLLER.measurement.timestamp_ns"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.measurement.P_copv"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.measurement.P_reg"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.measurement.P_u_fuel"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.measurement.P_u_ox"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.measurement.P_d_fuel"));
    send_msg(*elodin_client_, set_component_name("CONTROLLER.measurement.P_d_ox"));

    std::cout << "[ControllerService] ✅ Registered controller tables with Elodin DB"
              << std::endl;
    return true;
}

bool ControllerService::start(double loop_rate_hz) {
    if (running_) {
        return true;
    }

    if (!elodin_client_->is_connected()) {
        std::cerr << "[ControllerService] ❌ Cannot start - not connected to Elodin DB"
                  << std::endl;
        return false;
    }

    running_ = true;
    loop_rate_hz_ = loop_rate_hz;
    loop_interval_ms_ = 1000.0 / loop_rate_hz;

    controller_thread_ = std::thread(&ControllerService::controllerLoop, this);

    std::cout << "[ControllerService] ✅ Started controller loop at " << loop_rate_hz
              << " Hz" << std::endl;
    return true;
}

void ControllerService::stop() {
    if (!running_) {
        return;
    }

    running_ = false;
    if (controller_thread_.joinable()) {
        controller_thread_.join();
    }

    std::cout << "[ControllerService] 🛑 Stopped controller loop" << std::endl;
}

void ControllerService::controllerLoop() {
    const auto loop_interval =
        std::chrono::milliseconds(static_cast<int64_t>(loop_interval_ms_));

    while (running_) {
        auto loop_start = std::chrono::steady_clock::now();

        // TODO: Read sensor measurements from Elodin DB
        // For now, use placeholder measurement
        RobustDDPController::Measurement meas;
        meas.P_copv = 0.0;
        meas.P_reg = 0.0;
        meas.P_u_fuel = 0.0;
        meas.P_u_ox = 0.0;
        meas.P_d_fuel = 0.0;
        meas.P_d_ox = 0.0;
        meas.timestamp = std::chrono::duration_cast<std::chrono::nanoseconds>(
                             std::chrono::steady_clock::now().time_since_epoch())
                             .count();

        // TODO: Read navigation state from Elodin DB
        RobustDDPController::NavState nav;
        nav.h = 0.0;
        nav.vz = 0.0;
        nav.theta = 0.0;
        nav.mass_estimate = 10.0;

        // TODO: Read command from Elodin DB (thrust_desired, altitude_goal, etc.)
        RobustDDPController::Command cmd;
        cmd.command_type = RobustDDPController::CommandType::THRUST_DESIRED;
        cmd.thrust_desired = 1000.0;
        cmd.altitude_goal = 0.0;

        // Run controller step
        auto [actuation, diagnostics] = controller_->step(meas, nav, cmd);

        // Write actuation to Elodin DB
        writeActuationToDB(actuation);

        // Write diagnostics to Elodin DB
        writeDiagnosticsToDB(diagnostics);

        // Write measurement to DB (for replay)
        writeMeasurementToDB(meas);

        // Sleep to maintain loop rate
        auto loop_end = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(loop_end - loop_start);
        if (elapsed < loop_interval) {
            std::this_thread::sleep_for(loop_interval - elapsed);
        }
    }
}

void ControllerService::writeActuationToDB(
    const RobustDDPController::ActuationCommand& actuation) {
    constexpr uint16_t ACTUATION_MESSAGE_ID = 0x4000;  // [0x40, 0x00]

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

void ControllerService::writeDiagnosticsToDB(
    const RobustDDPController::Diagnostics& diagnostics) {
    constexpr uint16_t DIAGNOSTICS_MESSAGE_ID = 0x4100;  // [0x41, 0x00]

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

void ControllerService::writeMeasurementToDB(
    const RobustDDPController::Measurement& measurement) {
    constexpr uint16_t MEASUREMENT_MESSAGE_ID = 0x4200;  // [0x42, 0x00]

    comms::messages::control::ControllerMeasurementMessage msg;
    std::get<0>(msg.fields) = measurement.timestamp;
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

