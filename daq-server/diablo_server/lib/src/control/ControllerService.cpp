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
#include <fstream>
#include <iostream>
#include <sstream>
#include <thread>

#include "comms/messages/control/ControllerMessages.hpp"
#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "comms/messages/sensor/SensorMessages.hpp"
#include "control/RobustDDPController.hpp"
#include "db.hpp"
#include "elodin/ElodinClient.hpp"
#include "elodin/SendMsg.hpp"
#include "net/DaqInterface.hpp"

using namespace vtable;
using namespace vtable::builder;

namespace fsw {
namespace control {

// ═══════════════════════════════════════════════════════════════════════
//  CONSTRUCTION / INIT / DESTROY
// ═══════════════════════════════════════════════════════════════════════

ControllerService::ControllerService()
    : controller_(std::make_unique<RobustDDPController>()),
      elodin_client_(std::make_unique<fsw::elodin::ElodinClient>()),
      elodin_subscriber_(std::make_unique<fsw::elodin::ElodinClient>()) {
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
                                   const std::string& lut_path,
                                   const std::string& thrust_curve_path) {
    elodin_host_ = elodin_host;
    elodin_port_ = elodin_port;
    pwm_config_ = pwm_config;

    // ── Create UDP socket for PWM commands ──────────────────────────────
    udp_socket_fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (udp_socket_fd_ < 0) {
        std::cerr << "[ControllerService] ❌ Failed to create UDP socket: " << strerror(errno)
                  << std::endl;
        return false;
    }
    if (!fsw::net::bindToDaqInterface(udp_socket_fd_, pwm_config_.bind_address,
                                      "ControllerService")) {
        ::close(udp_socket_fd_);
        udp_socket_fd_ = -1;
        return false;
    }
    auto describe = [](const PWMTarget& t) {
        return t.resolved() ? t.board_ip + " CH" + std::to_string(static_cast<int>(t.channel))
                            : std::string("(unresolved — PWM suppressed)");
    };
    std::cout << "[ControllerService] ✅ UDP socket created for PWM output → :"
              << pwm_config_.actuator_port
              << (pwm_config_.bind_address == "0.0.0.0"
                      ? std::string()
                      : " (from " + pwm_config_.bind_address + ")")
              << std::endl;
    std::cout << "[ControllerService]    Fuel " << describe(pwm_config_.fuel) << "   Ox "
              << describe(pwm_config_.ox) << "  freq=" << pwm_config_.frequency_hz << "Hz"
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

    // ── Elodin subscriber (dedicated read-only connection for calibrated PT) ──
    // A failure here is no longer terminal for the subscriber: elodinSubscriberLoop() retries.
    if (!elodin_host.empty() && !connectSubscriber())
        std::cerr << "[ControllerService] ⚠️  Elodin subscriber connection failed — retrying in "
                     "the background"
                  << std::endl;

    // ── Initialize controller ───────────────────────────────────────────
    if (!controller_->initialize(controller_config)) {
        std::cerr << "[ControllerService] ❌ Failed to initialize RobustDDPController" << std::endl;
        return false;
    }

    // ── Optional LUT (bypasses DDP for boolean control) ──────────────────
    if (!lut_path.empty()) {
        if (lut_.load(lut_path)) {
            std::cout
                << "[ControllerService] ✅ Using LUT for optimal boolean control (DDP bypassed)"
                << std::endl;
        } else {
            std::cerr << "[ControllerService] ⚠️ LUT load failed — falling back to DDP" << std::endl;
        }
    }

    // ── Optional thrust curve (time-varying target from Layer 2) ─────────
    if (!thrust_curve_path.empty()) {
        if (loadThrustCurve(thrust_curve_path)) {
            thrust_curve_loaded_ = true;
            std::cout << "[ControllerService] ✅ Thrust curve loaded: " << thrust_curve_path << " ("
                      << thrust_curve_times_.size() << " points)" << std::endl;
        } else {
            std::cerr << "[ControllerService] ⚠️ Thrust curve load failed: " << thrust_curve_path
                      << std::endl;
        }
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
    // Started whenever a db is configured, not only when the first connect happened to succeed:
    // the loop reconnects, so a controller that boots while the db is down now picks it up
    // instead of running blind for the rest of the session.
    if (!elodin_host_.empty()) {
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

void ControllerService::setFireActive(bool active) {
    // The single funnel both activation paths go through — the TCP FIRE_START/FIRE_STOP server and
    // the [0x50] state-packet parity fallback. Guarding here rather than at each caller means a
    // disabled gate cannot be reached by any route, present or future.
    if (!fire_gate_enabled_.load())
        return;

    const bool was_active = fire_active_.exchange(active);
    if (was_active == active)
        return;
    std::cout << "[ControllerService] 🔥 Fire state: "
              << (active ? "ACTIVE — PWM enabled" : "INACTIVE — PWM suppressed") << std::endl;

    if (active && !was_active) {
        fire_start_time_ = std::chrono::steady_clock::now();
        // FIRE_START: send a single open command using the same priority as the loop
        float td_f = test_duty_fuel_.load();
        float td_o = test_duty_ox_.load();

        RobustDDPController::ActuationCommand actuation;

        if (td_f > 0.0f || td_o > 0.0f) {
            // Fallback / test duty: just send whatever is set
            actuation.duty_F = td_f;
            actuation.duty_O = td_o;
            actuation.u_F_on = td_f > 0.0f;
            actuation.u_O_on = td_o > 0.0f;
            actuation.valid = true;
        } else if (lut_.is_loaded()) {
            RobustDDPController::Measurement meas;
            RobustDDPController::Command cmd;
            {
                std::lock_guard<std::mutex> lock(input_mutex_);
                meas = current_meas_;
                cmd = current_cmd_;
            }
            std::map<std::string, double> point;
            point["P_u_fuel"] = meas.P_u_fuel;
            point["P_u_ox"] = meas.P_u_ox;
            double thrust_ref = (cmd.type == RobustDDPController::CommandType::THRUST_DESIRED)
                                    ? cmd.thrust_desired
                                    : 0.0;
            if (thrust_curve_loaded_ &&
                cmd.type == RobustDDPController::CommandType::THRUST_DESIRED)
                thrust_ref = interpolateThrustCurve(0.0);  // t=0 at FIRE_START
            point["thrust_desired"] = thrust_ref;
            point["MR_ref"] = 2.2;
            const double P_ch_est = 0.5 * (meas.P_ch_mp1 + meas.P_ch_mp2);
            if (P_ch_est > 0.0)
                point["P_ch"] = P_ch_est;
            std::map<std::string, double> lut_out;
            if (lut_.evaluate(point, lut_out)) {
                double u_f = lut_out.count("u_safe_F") ? lut_out.at("u_safe_F")
                             : lut_out.count("duty_F") ? lut_out.at("duty_F")
                                                       : 0.0;
                double u_o = lut_out.count("u_safe_O") ? lut_out.at("u_safe_O")
                             : lut_out.count("duty_O") ? lut_out.at("duty_O")
                                                       : 0.0;
                actuation.duty_F = std::clamp(u_f, 0.0, 1.0);
                actuation.duty_O = std::clamp(u_o, 0.0, 1.0);
                actuation.u_F_on = actuation.duty_F > 0.01;
                actuation.u_O_on = actuation.duty_O > 0.01;
                actuation.valid = true;
            }
        } else {
            RobustDDPController::Measurement meas;
            RobustDDPController::Command cmd;
            RobustDDPController::NavState nav;
            {
                std::lock_guard<std::mutex> lock(input_mutex_);
                meas = current_meas_;
                cmd = current_cmd_;
                nav = current_nav_;
            }
            auto [a, d] = controller_->step(meas, nav, cmd);
            actuation = a;
        }

        if (actuation.valid)
            sendActuationPWM(actuation);
        std::cout << "[ControllerService] 🔥 FIRE open command sent: duty_F=" << actuation.duty_F
                  << " duty_O=" << actuation.duty_O << std::endl;

    } else if (!active && was_active) {
        // FIRE_STOP: send a single zero-duty close command on both channels
        RobustDDPController::ActuationCommand zero;
        zero.duty_F = 0.0;
        zero.duty_O = 0.0;
        zero.u_F_on = false;
        zero.u_O_on = false;
        zero.valid = true;
        sendActuationPWM(zero);
        std::cout << "[ControllerService] 🛑 FIRE close command sent (duty=0)" << std::endl;
    }

    // Write fire-state event to Elodin DB [0x44, 0x00]
    if (elodin_client_ && elodin_connected_) {
        comms::messages::control::ControllerFireStateMessage fs_msg;
        std::get<0>(fs_msg.fields) = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                         std::chrono::system_clock::now().time_since_epoch())
                                         .count();
        std::get<1>(fs_msg.fields) = active ? uint8_t(1) : uint8_t(0);
        // Capture current actuation state for context
        {
            std::lock_guard<std::mutex> lock(input_mutex_);
            std::get<2>(fs_msg.fields) = static_cast<float>(current_meas_.P_u_fuel > 0 ? 1.0 : 0.0);
            std::get<3>(fs_msg.fields) = static_cast<float>(current_meas_.P_u_ox > 0 ? 1.0 : 0.0);
        }
        elodin_client_->publish(0x4400, fs_msg);
    }
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
//  CONTROLLER LOOP
// ═══════════════════════════════════════════════════════════════════════

void ControllerService::controllerLoop() {
    const auto loop_interval =
        std::chrono::microseconds(static_cast<int64_t>(loop_interval_ms_ * 1000.0));

    int tick = 0;

    while (running_) {
        auto loop_start = std::chrono::steady_clock::now();

        // ── Snapshot inputs ────────────────────────────────────────────
        float td_f = test_duty_fuel_.load();
        float td_o = test_duty_ox_.load();
        const bool use_test_duty = (td_f > 0.0f || td_o > 0.0f);

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

        // When only upstream (ch 1, 5) is present, P_d_fuel/P_d_ox stay 0 so engine estimate
        // and diagnostics (MR, P_ch, F_est) are zero. Use upstream as fallback for injector
        // pressure so the controller sees varying state instead of defaulting to fixed duty.
        // This is an estimated fallback only — flag it in diagnostics if it triggers during FIRE.
        constexpr double P_D_FROM_U_FRAC = 0.95;
        bool p_d_fuel_fallback = false;
        bool p_d_ox_fallback = false;
        if (meas.P_d_fuel <= 0.0 && meas.P_u_fuel > 0.0) {
            meas.P_d_fuel = meas.P_u_fuel * P_D_FROM_U_FRAC;
            p_d_fuel_fallback = true;
        }
        if (meas.P_d_ox <= 0.0 && meas.P_u_ox > 0.0) {
            meas.P_d_ox = meas.P_u_ox * P_D_FROM_U_FRAC;
            p_d_ox_fallback = true;
        }
        if ((p_d_fuel_fallback || p_d_ox_fallback) && fire_active_.load() && tick % 50 == 0) {
            std::cerr << "[ControllerService] ⚠️  Downstream PT fallback active during FIRE: "
                      << (p_d_fuel_fallback ? "P_d_fuel " : "")
                      << (p_d_ox_fallback ? "P_d_ox " : "")
                      << "— using 0.95 * upstream. Install downstream PTs for accurate control."
                      << std::endl;
        }

        // Require sensor data for DDP; test duty can send without it. In fire mode with LUT, run
        // anyway so we always command duty (even 0) and report P_ch from chamber MP1/2 average.
        const bool run_without_data = (fire_active_ && lut_.is_loaded());
        if (!have_data && !use_test_duty && !run_without_data) {
            if (tick == 0 || tick % 50 == 0) {
                std::cout << "[ControllerService] ⏳ Waiting for sensor data from Elodin…"
                          << std::endl;
            }
            ++tick;
            auto loop_end = std::chrono::steady_clock::now();
            auto elapsed = loop_end - loop_start;
            if (elapsed < loop_interval)
                std::this_thread::sleep_for(loop_interval - elapsed);
            continue;
        }

        RobustDDPController::ActuationCommand actuation;
        RobustDDPController::Diagnostics diagnostics;

        if (use_test_duty) {
            // Open-loop validation: bypass DDP, send fixed duty cycles (no sensor data required)
            actuation.duty_F = td_f;
            actuation.duty_O = td_o;
            actuation.u_F_on = td_f > 0.0f;
            actuation.u_O_on = td_o > 0.0f;
            actuation.valid = true;
            diagnostics.F_ref = (cmd.type == RobustDDPController::CommandType::THRUST_DESIRED)
                                    ? cmd.thrust_desired
                                    : 0.0;
        } else if (lut_.is_loaded()) {
            // LUT mode: policy LUT uses P_u_fuel, P_u_ox, thrust_desired, MR_ref.
            // Optional P_ch for legacy 3D engine LUTs.
            const double P_ch_est = (meas.P_ch_mp1 > 0.0 || meas.P_ch_mp2 > 0.0)
                                        ? 0.5 * (meas.P_ch_mp1 + meas.P_ch_mp2)
                                        : 0.0;

            if (!fire_active_) {
                actuation.duty_F = 0.0;
                actuation.duty_O = 0.0;
                actuation.u_F_on = false;
                actuation.u_O_on = false;
                actuation.valid = true;
                diagnostics.F_ref = (cmd.type == RobustDDPController::CommandType::THRUST_DESIRED)
                                        ? cmd.thrust_desired
                                        : 0.0;
                diagnostics.F_estimated = 0.0;
                diagnostics.MR_estimated = 0.0;
                diagnostics.P_ch = 0.0;
            } else {
                std::map<std::string, double> point;
                point["P_u_fuel"] = meas.P_u_fuel;
                point["P_u_ox"] = meas.P_u_ox;
                double thrust_ref = (cmd.type == RobustDDPController::CommandType::THRUST_DESIRED)
                                        ? cmd.thrust_desired
                                        : 0.0;
                if (thrust_curve_loaded_ &&
                    cmd.type == RobustDDPController::CommandType::THRUST_DESIRED) {
                    auto t_elapsed = std::chrono::steady_clock::now() - fire_start_time_;
                    double t_s = std::chrono::duration<double>(t_elapsed).count();
                    thrust_ref = interpolateThrustCurve(t_s);
                }
                point["thrust_desired"] = thrust_ref;
                point["MR_ref"] = 2.2;  // Default O/F target (mid-band)
                if (P_ch_est > 0.0)
                    point["P_ch"] = P_ch_est;  // For legacy 3D engine LUTs

                std::map<std::string, double> lut_out;
                if (lut_.evaluate(point, lut_out)) {
                    double u_f = lut_out.count("u_safe_F") ? lut_out.at("u_safe_F")
                                 : lut_out.count("duty_F") ? lut_out.at("duty_F")
                                                           : 0.0;
                    double u_o = lut_out.count("u_safe_O") ? lut_out.at("u_safe_O")
                                 : lut_out.count("duty_O") ? lut_out.at("duty_O")
                                                           : 0.0;
                    // Use continuous duty (0-1) for PWM; clamp to valid range
                    actuation.duty_F = std::clamp(u_f, 0.0, 1.0);
                    actuation.duty_O = std::clamp(u_o, 0.0, 1.0);
                    actuation.u_F_on = actuation.duty_F > 0.01;
                    actuation.u_O_on = actuation.duty_O > 0.01;
                    actuation.valid = true;

                    diagnostics.F_ref = thrust_ref;
                    diagnostics.P_ch = P_ch_est;
                    constexpr double P_MIN_VALID = 1e5;
                    if (meas.P_u_fuel >= P_MIN_VALID && meas.P_u_ox >= P_MIN_VALID) {
                        if (lut_out.count("F"))
                            diagnostics.F_estimated = lut_out.at("F");
                        if (lut_out.count("MR"))
                            diagnostics.MR_estimated = lut_out.at("MR");
                    } else {
                        diagnostics.F_estimated = 0.0;
                        diagnostics.MR_estimated = 0.0;
                    }
                } else {
                    // LUT miss or out-of-range: still command 0/0 and report P_ch so fire mode
                    // always outputs
                    actuation.duty_F = 0.0;
                    actuation.duty_O = 0.0;
                    actuation.u_F_on = false;
                    actuation.u_O_on = false;
                    actuation.valid = true;
                    diagnostics.F_ref = thrust_ref;
                    diagnostics.P_ch = P_ch_est;
                    diagnostics.F_estimated = 0.0;
                    diagnostics.MR_estimated = 0.0;
                }
            }
        } else {
            auto [a, d] = controller_->step(meas, nav, cmd);
            actuation = a;
            diagnostics = d;
        }

        // ── Send PWM output every tick while FIRE is active ───────────
        if (fire_active_.load() && actuation.valid) {
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
            // Diagnostic: when F_est=0 and fire active, log pressure state to debug missing PT data
            if (fire_active_.load() && diagnostics.F_estimated == 0.0 && tick % 100 == 0) {
                std::cerr << "[Controller] ⚠️ F_est=0: P_u_fuel=" << meas.P_u_fuel / 6894.76
                          << " psi, P_u_ox=" << meas.P_u_ox / 6894.76
                          << " psi (need both ≥14.5 psi). Check PT ch1/ch5." << std::endl;
            }
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
//  THRUST CURVE (Layer 2 pressure curve → time-varying target)
// ═══════════════════════════════════════════════════════════════════════

bool ControllerService::loadThrustCurve(const std::string& path) {
    thrust_curve_times_.clear();
    thrust_curve_values_.clear();

    std::ifstream f(path);
    if (!f.is_open())
        return false;

    std::string line;
    if (!std::getline(f, line) || line.find("time_s") == std::string::npos)
        return false;  // Expect header "time_s,thrust_N"

    while (std::getline(f, line)) {
        if (line.empty())
            continue;
        std::istringstream iss(line);
        double t, F;
        char comma;
        if (iss >> t >> comma >> F) {
            thrust_curve_times_.push_back(t);
            thrust_curve_values_.push_back(F);
        }
    }
    return thrust_curve_times_.size() >= 2;
}

double ControllerService::interpolateThrustCurve(double t_elapsed_s) const {
    if (thrust_curve_times_.empty() || thrust_curve_values_.empty())
        return 0.0;

    if (t_elapsed_s <= thrust_curve_times_.front())
        return thrust_curve_values_.front();
    if (t_elapsed_s >= thrust_curve_times_.back())
        return thrust_curve_values_.back();

    for (size_t i = 0; i + 1 < thrust_curve_times_.size(); ++i) {
        double t0 = thrust_curve_times_[i];
        double t1 = thrust_curve_times_[i + 1];
        if (t_elapsed_s >= t0 && t_elapsed_s <= t1) {
            double alpha = (t_elapsed_s - t0) / (t1 - t0);
            return thrust_curve_values_[i] * (1.0 - alpha) + thrust_curve_values_[i + 1] * alpha;
        }
    }
    return thrust_curve_values_.back();
}

}  // namespace control
}  // namespace fsw
