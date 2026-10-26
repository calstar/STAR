/**
 * Actuator hotfire board: the decisions, with no hardware attached.
 *
 * Everything here is plain C++ (no Arduino, Ethernet or FreeRTOS), so the
 * host unit tests in Hotfire_Tests exercise this exact code rather than a
 * copy of it. The firmware owns the pins, PWM and UDP; it hands every
 * received packet to Controller::onPacket(), calls Controller::tick() on a
 * fixed period, and carries out what the controller asks through Outputs.
 *
 * The controller decides:
 *   - what each packet is, and which actuator commands to accept in which
 *     state and from which sender
 *   - the state machine: WaitingForServer -> Active, and the abort paths
 *     ConnectionLossDetected -> NoConnectionAbort -> PTAbort / NoPTAbort ->
 *     AbortFinished (plus NoConnAbortFollower on non-controller boards)
 *   - the abort timers, and which vent / abort / NO_CONNECTION_ABORT /
 *     ABORT_DONE packets go to which boards
 */

#pragma once

#include <stdint.h>
#include <string.h>

#include <set>
#include <vector>

#include "actuator_config.h"
#include "daq-protocol.h"
#include "hotfire_config.h"

namespace ActuatorHotfire {

enum class State : uint8_t {
    WaitingForServer = 1,  // SETUP
    Active = 2,
    ConnectionLossDetected = 3,
    NoConnectionAbort = 4,
    NoConnAbortFollower = 5,
    PTAbort = 6,
    NoPTAbort = 7,
    AbortFinished = 8
};

enum class PacketKind {
    None,
    ServerHeartbeat,
    Config,
    Abort,
    AbortDone,
    ClearAbort,
    SensorData,
    NoConnAbort
};

/** UDP port every board (PT and actuator) listens on. */
constexpr uint16_t BOARD_LISTEN_PORT = 5005;
/** NO_CONNECTION_ABORT is sent this many times, this far apart. */
constexpr uint8_t NO_CONN_ABORT_SENDS = 3;
constexpr uint32_t NO_CONN_ABORT_RESEND_MS = 10;

inline const char* stateName(State s) {
    switch (s) {
        case State::WaitingForServer:
            return "WaitingForServer";
        case State::Active:
            return "Active";
        case State::NoConnectionAbort:
            return "NoConnectionAbort";
        case State::PTAbort:
            return "PTAbort";
        case State::NoPTAbort:
            return "NoPTAbort";
        case State::AbortFinished:
            return "AbortFinished";
        case State::ConnectionLossDetected:
            return "ConnectionLossDetected";
        case State::NoConnAbortFollower:
            return "NoConnAbortFollower";
    }
    return "?";
}

/** What the heartbeat reports for each state. */
inline daq::BoardState boardStateFor(State s) {
    switch (s) {
        case State::WaitingForServer:
            return daq::BoardState::SETUP;
        case State::Active:
            return daq::BoardState::ACTIVE;
        case State::ConnectionLossDetected:
            return daq::BoardState::CONNECTION_LOSS_DETECTED;
        case State::NoConnectionAbort:
            return daq::BoardState::NO_CONNECTION_ABORT;
        case State::NoConnAbortFollower:
            return daq::BoardState::NO_CONN_ABORT_FOLLOWER;
        case State::PTAbort:
            return daq::BoardState::PT_ABORT;
        case State::NoPTAbort:
            return daq::BoardState::NO_PT_ABORT;
        case State::AbortFinished:
            return daq::BoardState::ABORT_FINISHED;
    }
    return daq::BoardState::SETUP;
}

/** Header-only packet (NO_CONNECTION_ABORT, ABORT_DONE, ...). */
inline size_t createHeaderOnlyPacket(daq::PacketType type, uint32_t now_ms,
                                     uint8_t* buffer, size_t buffer_size) {
    if (buffer_size < sizeof(daq::PacketHeader))
        return 0;
    daq::PacketHeader header;
    header.packet_type = type;
    header.version = 1;
    header.timestamp = now_ms;
    memcpy(buffer, &header, sizeof(header));
    return sizeof(header);
}

/**
 * What the controller asks the firmware to do. The firmware implements it
 * with real pins and UDP; the host tests record the calls.
 */
class Outputs {
public:
    virtual ~Outputs() = default;
    /** Drive a local actuator. Stops any PWM running on it first. */
    virtual void setActuator(uint8_t actuator_id, bool on) = 0;
    /** Start a PWM command on a local actuator (id already range-checked). */
    virtual void startPwm(const daq::PWMActuatorCommand& cmd) = 0;
    /** Send one UDP packet. */
    virtual void send(uint32_t ip, uint16_t port, const uint8_t* data,
                      size_t len) = 0;
    /** The state changed. */
    virtual void onStateChange(State from, State to) {
        (void)from;
        (void)to;
    }
    /** An ACTUATOR_COMMAND / PWM_ACTUATOR_COMMAND was refused in this state.
     */
    virtual void onCommandsIgnored(uint8_t packet_type, State in_state) {
        (void)packet_type;
        (void)in_state;
    }
};

/** What one received packet turned out to be. */
struct PacketResult {
    PacketKind kind = PacketKind::None;
    bool has_log_mode = false;  // an ACTUATOR_CONFIG carried a log-mode byte
    uint8_t log_mode = 0;
};

class Controller {
public:
    Controller(Outputs& out, uint8_t num_actuators)
        : out_(out), num_actuators_(num_actuators) {
    }

    /** Off by default (ENABLE_ALL_STATE_TRANSITIONS): Active ignores abort
     *  packets and heartbeat loss. */
    bool enable_all_transitions = ENABLE_ALL_STATE_TRANSITIONS;

    void begin(uint32_t now_ms) {
        state_ = State::WaitingForServer;
        state_enter_ms_ = now_ms;
        last_server_heartbeat_ms_ = 0;
    }

    State state() const {
        return state_;
    }
    uint32_t stateEnterMs() const {
        return state_enter_ms_;
    }
    daq::BoardState boardState() const {
        return boardStateFor(state_);
    }
    bool isAbortController() const {
        return is_abort_controller_;
    }
    bool configValid() const {
        return config_valid_;
    }
    const std::vector<daq::AbortActuatorLocation>& abortActuators() const {
        return abort_actuators_;
    }
    const std::vector<daq::AbortPTLocation>& abortPts() const {
        return abort_pts_;
    }

    /**
     * Handle one received packet. `server_ip` is where the board currently
     * thinks the server is, `self_ip` its own address (both host order,
     * a.b.c.d = a<<24 | ... | d).
     */
    PacketResult onPacket(const uint8_t* buffer, size_t len, uint32_t remote_ip,
                          uint32_t server_ip, uint32_t self_ip,
                          uint32_t now_ms) {
        (void)self_ip;
        PacketResult r;
        if (len < sizeof(daq::PacketHeader))
            return r;
        // Any packet at all means its sender is reachable.
        connection_loss_received_ips_.insert(remote_ip);

        daq::PacketHeader hdr;
        memcpy(&hdr, buffer, sizeof(hdr));

        switch (hdr.packet_type) {
            case daq::PacketType::SERVER_HEARTBEAT: {
                daq::PacketHeader dummy;
                daq::ServerHeartbeatPacket data;
                if (daq::parse_server_heartbeat_packet(buffer, len, dummy,
                                                       data)) {
                    last_server_heartbeat_ms_ = now_ms;
                    connection_loss_received_ips_.insert(server_ip);
                    r.kind = PacketKind::ServerHeartbeat;
                }
                break;
            }
            case daq::PacketType::ACTUATOR_CONFIG: {
                daq::PacketHeader dummy;
                uint8_t is_controller = 0;
                uint8_t log_mode = 0;
                std::vector<daq::AbortActuatorLocation> act_locs;
                std::vector<daq::AbortPTLocation> pt_locs;
                if (daq::parse_actuator_config_packet(buffer, len, dummy,
                                                      is_controller, act_locs,
                                                      pt_locs, log_mode)) {
                    is_abort_controller_ = (is_controller != 0);
                    abort_actuators_ = act_locs;
                    abort_pts_ = pt_locs;
                    config_valid_ = true;
                    r.kind = PacketKind::Config;
                    r.has_log_mode = true;
                    r.log_mode = log_mode;
                }
                break;
            }
            case daq::PacketType::ABORT:
                r.kind = PacketKind::Abort;
                break;
            case daq::PacketType::ABORT_DONE:
                r.kind = PacketKind::AbortDone;
                break;
            case daq::PacketType::CLEAR_ABORT:
                r.kind = PacketKind::ClearAbort;
                break;
            case daq::PacketType::SENSOR_DATA:
                onSensorData(buffer, len, remote_ip);
                r.kind = PacketKind::SensorData;
                break;
            case daq::PacketType::NO_CONNECTION_ABORT:
                r.kind = PacketKind::NoConnAbort;
                break;
            case daq::PacketType::ACTUATOR_COMMAND: {
                daq::PacketHeader cmd_header;
                std::vector<daq::ActuatorCommand> commands;
                if (daq::parse_actuator_command_packet(buffer, len, cmd_header,
                                                       commands)) {
                    if (acceptsCommandFrom(remote_ip, server_ip)) {
                        for (const auto& cmd : commands)
                            if (validActuator(cmd.actuator_id))
                                out_.setActuator(cmd.actuator_id,
                                                 cmd.actuator_state != 0);
                    } else {
                        out_.onCommandsIgnored(buffer[0], state_);
                    }
                }
                break;
            }
            case daq::PacketType::PWM_ACTUATOR_COMMAND: {
                daq::PacketHeader cmd_header;
                std::vector<daq::PWMActuatorCommand> commands;
                if (daq::parse_pwm_actuator_packet(buffer, len, cmd_header,
                                                   commands)) {
                    if (acceptsCommandFrom(remote_ip, server_ip)) {
                        for (const auto& cmd : commands)
                            if (validActuator(cmd.actuator_id))
                                out_.startPwm(cmd);
                    } else {
                        out_.onCommandsIgnored(buffer[0], state_);
                    }
                }
                break;
            }
            default:
                break;
        }

        applyTransition(r.kind, now_ms);
        return r;
    }

    /** Run the timers. Call on a fixed period (the firmware uses 1 ms). */
    void tick(uint32_t now_ms, uint32_t self_ip, uint32_t server_ip) {
        switch (state_) {
            case State::Active:
                if (enable_all_transitions && heartbeatTimedOut(now_ms)) {
                    setState(State::ConnectionLossDetected, now_ms);
                    connection_loss_received_ips_.clear();
                }
                break;
            case State::ConnectionLossDetected:
                tickConnectionLoss(now_ms, server_ip);
                break;
            case State::NoConnectionAbort:
                tickNoConnectionAbort(now_ms, self_ip);
                break;
            case State::PTAbort:
                tickPtAbort(now_ms, self_ip);
                break;
            case State::NoPTAbort:
                tickNoPtAbort(now_ms, self_ip);
                break;
            case State::WaitingForServer:
            case State::AbortFinished:
            case State::NoConnAbortFollower:
                break;
        }
    }

    /** Would an actuator command from `remote_ip` be applied right now? */
    bool acceptsCommandFrom(uint32_t remote_ip, uint32_t server_ip) const {
        // Every board ignores the server once its abort has finished, or
        // while it is following the designated survivor.
        if ((state_ == State::AbortFinished ||
             state_ == State::NoConnAbortFollower) &&
            remote_ip == server_ip)
            return false;

        if (state_ == State::Active)
            return true;

        if (is_abort_controller_) {
            // The designated survivor takes server commands during its own
            // abort sequences.
            return state_ == State::NoConnectionAbort ||
                   state_ == State::PTAbort || state_ == State::NoPTAbort ||
                   state_ == State::AbortFinished;
        }
        // Other boards take commands from non-server IPs (the designated
        // survivor) during aborts.
        return state_ == State::NoConnAbortFollower ||
               state_ == State::NoConnectionAbort ||
               state_ == State::PTAbort || state_ == State::NoPTAbort ||
               state_ == State::AbortFinished;
    }

private:
    bool validActuator(uint8_t id) const {
        return id >= 1 && id <= num_actuators_;
    }

    bool heartbeatTimedOut(uint32_t now_ms) const {
        if (last_server_heartbeat_ms_ == 0)
            return false;
        return now_ms - last_server_heartbeat_ms_ > HEARTBEAT_TIMEOUT_MS;
    }

    void setState(State s, uint32_t now_ms) {
        if (s == state_)
            return;
        const State from = state_;
        state_ = s;
        state_enter_ms_ = now_ms;
        out_.onStateChange(from, s);
    }

    void applyTransition(PacketKind kind, uint32_t now_ms) {
        // Global recovery from a finished abort.
        if (kind == PacketKind::ClearAbort && state_ == State::AbortFinished) {
            setState(State::Active, now_ms);
            return;
        }
        switch (state_) {
            case State::WaitingForServer:
                if (kind == PacketKind::Config)
                    setState(State::Active, now_ms);
                break;
            case State::Active:
                // Stays Active on abort packets unless all transitions are
                // enabled.
                if (!enable_all_transitions)
                    break;
                if (kind == PacketKind::Abort || kind == PacketKind::AbortDone)
                    setState(State::AbortFinished, now_ms);
                else if (kind == PacketKind::NoConnAbort &&
                         !is_abort_controller_)
                    setState(State::NoConnAbortFollower, now_ms);
                break;
            case State::ConnectionLossDetected:
                if (kind == PacketKind::ServerHeartbeat)
                    setState(State::Active, now_ms);
                break;
            default:
                break;
        }
    }

    /** PT readings arriving during an abort. */
    void onSensorData(const uint8_t* buffer, size_t len, uint32_t remote_ip) {
        const bool tracking_received = state_ == State::NoConnectionAbort;
        const bool tracking_threshold = state_ == State::PTAbort;
        if (!(tracking_received || tracking_threshold) || !config_valid_ ||
            abort_pts_.empty())
            return;
        std::vector<daq::SensorDataChunkCollection> chunks;
        daq::PacketHeader dummy;
        if (!daq::parse_sensor_data_packet(buffer, len, dummy, chunks))
            return;
        for (const auto& col : chunks) {
            for (const auto& dp : col.datapoints) {
                for (size_t i = 0; i < abort_pts_.size(); i++) {
                    const auto& pt = abort_pts_[i];
                    if (pt.ip_address != remote_ip ||
                        pt.sensor_id != dp.sensor_id)
                        continue;
                    if (tracking_received && i < pt_received_.size())
                        pt_received_[i] = true;
                    if (tracking_threshold && i < pt_below_threshold_.size() &&
                        dp.data < pt.pressure_threshold_adc)
                        pt_below_threshold_[i] = true;
                }
            }
        }
    }

    /** Drive every abort actuator to its vent (or abort) state: local ones
     *  directly, the rest by ACTUATOR_COMMAND to the board that owns them. */
    void applyToAllActuators(bool vent, uint32_t now_ms, uint32_t self_ip) {
        uint8_t packet[MAX_PACKET_SIZE];
        for (const auto& loc : abort_actuators_) {
            const bool on = (vent ? loc.vent_state : loc.abort_state) != 0;
            if (loc.ip_address == self_ip) {
                if (validActuator(loc.actuator_id))
                    out_.setActuator(loc.actuator_id, on);
                continue;
            }
            std::vector<daq::ActuatorCommand> cmds;
            cmds.push_back({loc.actuator_id, static_cast<uint8_t>(on ? 1 : 0)});
            size_t n = daq::create_actuator_command_packet(cmds, now_ms, packet,
                                                           sizeof(packet));
            if (n > 0)
                out_.send(loc.ip_address, BOARD_LISTEN_PORT, packet, n);
        }
    }

    void sendNoConnectionAbortToPts(uint32_t now_ms) {
        uint8_t packet[sizeof(daq::PacketHeader)];
        size_t n = createHeaderOnlyPacket(daq::PacketType::NO_CONNECTION_ABORT,
                                          now_ms, packet, sizeof(packet));
        if (n == 0)
            return;
        for (const auto& pt : abort_pts_)
            out_.send(pt.ip_address, BOARD_LISTEN_PORT, packet, n);
    }

    void sendAbortDoneToAll(uint32_t now_ms, uint32_t self_ip) {
        uint8_t packet[sizeof(daq::PacketHeader)];
        size_t n = createHeaderOnlyPacket(daq::PacketType::ABORT_DONE, now_ms,
                                          packet, sizeof(packet));
        if (n == 0)
            return;
        for (const auto& pt : abort_pts_)
            out_.send(pt.ip_address, BOARD_LISTEN_PORT, packet, n);
        for (const auto& loc : abort_actuators_)
            if (loc.ip_address != self_ip)
                out_.send(loc.ip_address, BOARD_LISTEN_PORT, packet, n);
    }

    void tickConnectionLoss(uint32_t now_ms, uint32_t server_ip) {
        if (connection_loss_received_ips_.count(server_ip)) {
            setState(State::Active, now_ms);
            return;
        }
        if (now_ms - state_enter_ms_ < CONNECTION_LOSS_GRACE_MS)
            return;
        if (is_abort_controller_) {
            setState(State::NoConnectionAbort, now_ms);
            no_conn_abort_sends_done_ = 0;
            no_conn_abort_vent_sent_ = false;
            pt_received_.assign(abort_pts_.size(), false);
        } else {
            setState(State::NoConnAbortFollower, now_ms);
        }
    }

    void tickNoConnectionAbort(uint32_t now_ms, uint32_t self_ip) {
        if (is_abort_controller_ && config_valid_) {
            // NO_CONNECTION_ABORT to every PT, a few times, spaced by the
            // tick rather than by blocking.
            const uint32_t elapsed = now_ms - state_enter_ms_;
            while (no_conn_abort_sends_done_ < NO_CONN_ABORT_SENDS &&
                   elapsed >=
                       no_conn_abort_sends_done_ * NO_CONN_ABORT_RESEND_MS) {
                sendNoConnectionAbortToPts(now_ms);
                no_conn_abort_sends_done_++;
            }
            if (!no_conn_abort_vent_sent_ && !abort_actuators_.empty()) {
                applyToAllActuators(true, now_ms, self_ip);
                no_conn_abort_vent_sent_ = true;
            }
        }

        if (now_ms - state_enter_ms_ < NO_CONN_ABORT_PT_WAIT_MS)
            return;
        bool all_pt_received = true;
        for (bool got : pt_received_)
            if (!got) {
                all_pt_received = false;
                break;
            }
        if (all_pt_received && !abort_pts_.empty()) {
            setState(State::PTAbort, now_ms);
            pt_below_threshold_.assign(abort_pts_.size(), false);
            pt_abort_vent_done_ = false;
            pt_abort_abort_done_ = false;
        } else {
            setState(State::NoPTAbort, now_ms);
            no_pt_abort_vent_done_ = false;
            no_pt_abort_abort_done_ = false;
        }
    }

    void tickPtAbort(uint32_t now_ms, uint32_t self_ip) {
        if (!pt_abort_vent_done_ && config_valid_) {
            applyToAllActuators(true, now_ms, self_ip);
            pt_abort_vent_done_ = true;
        }
        if (pt_abort_abort_done_)
            return;
        bool all_below = true;
        for (bool b : pt_below_threshold_)
            if (!b) {
                all_below = false;
                break;
            }
        if (all_below ||
            now_ms - state_enter_ms_ >= PT_ABORT_THRESHOLD_TIMEOUT_MS) {
            applyToAllActuators(false, now_ms, self_ip);
            sendAbortDoneToAll(now_ms, self_ip);
            pt_abort_abort_done_ = true;
            setState(State::AbortFinished, now_ms);
        }
    }

    void tickNoPtAbort(uint32_t now_ms, uint32_t self_ip) {
        if (!no_pt_abort_vent_done_ && config_valid_) {
            applyToAllActuators(true, now_ms, self_ip);
            no_pt_abort_vent_done_ = true;
        }
        if (no_pt_abort_vent_done_ && !no_pt_abort_abort_done_ &&
            now_ms - state_enter_ms_ >= NO_PT_ABORT_VENT_TO_ABORT_MS) {
            applyToAllActuators(false, now_ms, self_ip);
            sendAbortDoneToAll(now_ms, self_ip);
            no_pt_abort_abort_done_ = true;
            setState(State::AbortFinished, now_ms);
        }
    }

    Outputs& out_;
    uint8_t num_actuators_;

    State state_ = State::WaitingForServer;
    uint32_t state_enter_ms_ = 0;
    uint32_t last_server_heartbeat_ms_ = 0;

    // Config from the server.
    bool is_abort_controller_ = false;
    bool config_valid_ = false;
    std::vector<daq::AbortActuatorLocation> abort_actuators_;
    std::vector<daq::AbortPTLocation> abort_pts_;

    // ConnectionLossDetected: senders heard from since the loss.
    std::set<uint32_t> connection_loss_received_ips_;

    // NoConnectionAbort.
    uint8_t no_conn_abort_sends_done_ = 0;
    bool no_conn_abort_vent_sent_ = false;
    std::vector<bool> pt_received_;  // index = abort_pts_ index

    // PTAbort.
    std::vector<bool> pt_below_threshold_;
    bool pt_abort_vent_done_ = false;
    bool pt_abort_abort_done_ = false;

    // NoPTAbort.
    bool no_pt_abort_vent_done_ = false;
    bool no_pt_abort_abort_done_ = false;
};

}  // namespace ActuatorHotfire
