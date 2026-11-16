// The only private hook left in the config characterization (see char_config_dump.cpp).
//
// ActuatorCommander resolves each [actuator_roles] entry to a board address, channel, polarity,
// PWM ownership and Elodin command table, and picks the bind address and actuator port, but no
// public method reports any of it: the only observable effect is a UDP datagram to the board's
// configured address (192.168.2.x on every shipped profile), which this suite must never send.
// So these two lines of the golden are read from the private members here, in a TU of their own,
// so the hook is one file to delete or rewrite when ActuatorCommander is restructured.
//
// Everything this header includes is included first, so the macro reaches only the one class.
#include <atomic>
#include <cstdio>
#include <map>
#include <mutex>
#include <ostream>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "control/StateMachine.hpp"
#include "elodin/ElodinClient.hpp"
#define private public
#include "control/ActuatorCommander.hpp"
#undef private

namespace {

std::string q(const std::string& s) {
    std::string o = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\')
            o += '\\', o += c;
        else if (c == '\n')
            o += "\\n";
        else if (c == '\r')
            o += "\\r";
        else if (c == '\t')
            o += "\\t";
        else
            o += c;
    }
    return o + "\"";
}
const char* b(bool v) {
    return v ? "true" : "false";
}
std::string hex2(unsigned v) {
    char buf[8];
    std::snprintf(buf, sizeof(buf), "0x%02X", v & 0xFF);
    return buf;
}

}  // namespace

void char_dump_actuator_commander_private(const sequencer::ActuatorCommander& ac,
                                          std::ostream& out) {
    out << "bind_addr_ = " << q(ac.bind_addr_) << " explicit=" << b(ac.bind_addr_explicit_)
        << " actuator_port_ = " << ac.actuator_port_ << "\n";
    for (const auto& [n, r] : ac.roles_)
        out << "role " << q(n) << " = {channel=" << r.channel << " board_id=" << r.board_id
            << " board_ip=" << q(r.board_ip) << " is_no=" << b(r.is_no) << " is_pwm=" << b(r.is_pwm)
            << " cmd_table_hi=" << hex2(r.cmd_table_hi) << "}\n";
}
