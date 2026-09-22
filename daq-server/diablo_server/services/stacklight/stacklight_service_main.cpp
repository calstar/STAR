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