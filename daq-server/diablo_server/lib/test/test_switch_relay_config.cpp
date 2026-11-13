// [switch_service] + [switch_roles.*]: parsing, validation, and the list as it goes on the wire.
#include <iostream>
#include <stdexcept>
#include <string>

#include "DiabloPacketUtils.h"
#include "config/Config.hpp"

using namespace fsw::config;

static int failures = 0;
static void require(bool ok, const char* what) {
    if (!ok) {
        std::cerr << "FAIL: " << what << "\n";
        ++failures;
    }
}

static const std::string ENV_BOARD =
    "[boards.environmental_board]\ntype = \"ENVIRONMENTAL\"\nip = \"192.168.2.25\"\n"
    "send_port = 5005\nboard_id = 25\nenabled = true\nactive_connectors = [1]\n";

static const std::string SERVICE = "[switch_service]\nenabled = true\ninterval_ms = 1000\n"
                                   "env_board = \"environmental_board\"\n";

static std::string role(const std::string& key, const std::string& body) {
    return "[switch_roles." + key + "]\n" + body + "\n";
}

static bool has_error(const Config& c, const std::string& needle) {
    for (const auto& e : c.switch_relay.errors)
        if (e.find(needle) != std::string::npos)
            return true;
    return false;
}

int main() {
    {  // no section: off, nothing listed, no errors
        auto c = load_from_string(ENV_BOARD);
        require(!c.switch_relay.enabled, "absent section is disabled");
        require(c.switch_relay.roles.empty() && c.switch_relay.errors.empty(), "absent is empty");
    }
    {  // two switches, listed out of order: sorted by role, names kept, MACs parsed
        auto c = load_from_string(
            ENV_BOARD + SERVICE +
            role("backup", "role = 3\nname = \"Backup altimeter\"\nmac = \"58:CF:79:01:11:22\"") +
            role("main", "role = 0\nname = \"Main altimeter\"\nmac = \"58:cf:79:01:3f:2a\""));
        require(c.switch_relay.errors.empty(), "valid list has no errors");
        require(c.switch_relay.roles.size() == 2, "two roles");
        require(c.switch_relay.roles[0].role == 0 && c.switch_relay.roles[0].name == "Main altimeter",
                "sorted by role, named");
        require(c.switch_relay.roles[1].mac[4] == 0x11 && c.switch_relay.roles[1].mac[5] == 0x22,
                "upper-case MAC parsed");
        const BoardConfig* env = switch_relay_board(c);
        require(env && env->ip == "192.168.2.25", "env board resolved");

        daq::SwitchConfig wire = switch_config_for(c.switch_relay);
        require(wire.count == 2 && wire.entries[1].role == 3 && wire.entries[0].mac[5] == 0x2a,
                "wire list");
        // The wire carries no names: renaming a role must not change what the board holds.
        auto renamed = load_from_string(
            ENV_BOARD + SERVICE +
            role("backup", "role = 3\nname = \"Drogue\"\nmac = \"58:CF:79:01:11:22\"") +
            role("main", "role = 0\nname = \"Main\"\nmac = \"58:cf:79:01:3f:2a\""));
        require(daq::switch_config_hash(switch_config_for(renamed.switch_relay)) ==
                    daq::switch_config_hash(wire),
                "renaming does not change the hash");
    }
    {  // every way to get a role wrong
        auto c = load_from_string(
            ENV_BOARD + SERVICE + role("a", "role = 5\nmac = \"58:cf:79:01:00:01\"") +
            role("b", "role = 1\nmac = \"58:cf:79:01:00:02\"") +
            role("c", "role = 1\nmac = \"58:cf:79:01:00:03\"") +
            role("d", "role = 2\nmac = \"58:cf:79:01:00\"") +
            role("e", "role = 3\nmac = \"58:cf:79:01:00:02\"") + role("f", "mac = \"58:cf:79:01:00:09\""));
        require(has_error(c, "[switch_roles.a] role must be"), "role out of range");
        require(has_error(c, "role 1 is used by another switch"), "duplicate role");
        require(has_error(c, "[switch_roles.d] mac"), "short MAC");
        require(has_error(c, "listed twice"), "duplicate MAC");
        require(has_error(c, "[switch_roles.f] role must be"), "missing role");
        require(c.switch_relay.roles.size() == 1, "only the good one kept");
        require(c.switch_relay.roles[0].name == "b", "name defaults to the key");
    }
    {  // env_board that isn't an enabled ENVIRONMENTAL board
        auto c = load_from_string(ENV_BOARD + "[switch_service]\nenabled = true\nenv_board = \"nope\"\n");
        require(has_error(c, "env_board \"nope\""), "unknown env board");
        auto off = load_from_string(ENV_BOARD + "[switch_service]\nenabled = false\nenv_board = \"nope\"\n");
        require(off.switch_relay.errors.empty(), "disabled service does not care");
    }
    {
        std::array<uint8_t, 6> m{};
        require(parse_mac("58-cf-79-01-3f-2a", m) && m[0] == 0x58, "dashes");
        require(!parse_mac("58:cf:79:01:3f:2g", m), "bad hex");
        require(!parse_mac("58:cf:79:01:3f:2a:00", m), "too long");
        require(!parse_mac("58cf:79:01:3f:2a:0", m), "misplaced separator");
    }
    if (failures) {
        std::cerr << failures << " failure(s)\n";
        return 1;
    }
    std::cout << "Switch relay config passed\n";
}
