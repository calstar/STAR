/**
 * Stacklight Service — C++ STACKLIGHT_COMMAND sender.
 *
 * Subscribes to Elodin [0x5000] (SequencerState) for current state, maps it to
 * a StacklightCommandPacket (red/yellow/green/buzzer), and sends it via UDP
 * unicast to the stacklight board whenever the state changes (plus a periodic
 * keepalive resend).
 */

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

#include "elodin/ElodinClient.hpp"
#include "DAQv2-Comms.h"
#include "control/StateMachine.hpp"

namespace {
std::atomic<bool> g_running{true};
std::atomic<uint8_t> g_seq_state{static_cast<uint8_t>(sequencer::State::UNKNOWN)};

void signalHandler(int /*sig*/) {
    std::cout << "\n[StacklightService] Shutting down..." << std::endl;
    g_running = false;
}

// ── sequencer::State → StacklightCommandPacket ──────────────────────────────
// Standard industrial convention: red = danger, yellow = caution,
// green = safe, buzzer = most urgent states (fire, abort).
Diablo::StacklightCommandPacket stateToStacklight(uint8_t s) {
    using sequencer::State;
    Diablo::StacklightCommandPacket cmd{0, 0, 0, 0};

    switch (static_cast<State>(s)) {
        case State::IDLE:
            cmd.green = 1;
            break;
        case State::DEBUG:
        case State::CALIBRATE:
        case State::GN2_VENT:
        case State::FUEL_VENT:
        case State::OX_VENT:
        case State::GN2_HIGH_VENT:
        case State::VENT:
            cmd.yellow = 1;
            break;
        case State::ARMED:
        case State::READY:
        case State::PRESS_STANDBY:
            cmd.red = 1;
            cmd.yellow = 1;
            break;
        case State::FUEL_FILL:
        case State::OX_FILL:
        case State::GN2_LOW_PRESS:
        case State::FUEL_PRESS:
        case State::OX_PRESS:
        case State::GN2_HIGH_PRESS:
            cmd.red = 1;
            break;
        case State::FIRE:
            cmd.red = 1;
            cmd.buzzer = 1;
            break;
        case State::ENGINE_ABORT:
        case State::GSE_ABORT:
        case State::EMERGENCY_ABORT:
            cmd.red = 1;
            cmd.buzzer = 1;
            break;
        case State::UNKNOWN:
        default:
            cmd.red = 1;
            cmd.yellow = 1;
            cmd.green = 1;
            cmd.buzzer = 1;
            break;
    }
    return cmd;
}

}