// Fail-fast config (STYLE S11): every check that refuses a config at startup, each against the
// value that used to slip through, plus the shipped profiles, which must all still load.
//
//   C2-4  missing file / not TOML            -> ConfigError, not a default Config
//   C1-8  an address inet_pton cannot read   -> ConfigError, not 0.0.0.0
//   C2-5  out-of-range port / id             -> ConfigError, not a wrap
//   C2-6  wrong-typed value                  -> ConfigError, not the default
//   C2-9  duplicate [[states]] name          -> ConfigError, not last-wins
//   C2-12 bad environmental board id         -> ConfigError (an invalid_argument), exit 78
//   C2-8  transition row of the wrong width  -> StateMachine::load refuses the file
//
// Run from anywhere: DAQ_SERVER_DIR is the daq-server checkout.

#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <string>
#include <vector>

#include "config/Config.hpp"
#include "control/StateMachine.hpp"

using fsw::config::ConfigError;

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        ++g_failures;
}

// The problems load_from_string reports for `toml`, or {} when it loads.
std::vector<std::string> problems(const std::string& toml) {
    try {
        (void)fsw::config::load_from_string(toml);
        return {};
    } catch (const ConfigError& e) {
        return e.problems();
    }
}

bool mentions(const std::vector<std::string>& ps, const std::string& needle) {
    for (const auto& p : ps)
        if (p.find(needle) != std::string::npos)
            return true;
    return false;
}

void refused(const std::string& toml, const std::string& needle, const std::string& what) {
    const auto ps = problems(toml);
    check(mentions(ps, needle), what + " -> refused naming \"" + needle + "\"");
    if (!mentions(ps, needle))
        for (const auto& p : ps)
            std::cout << "         got: " << p << std::endl;
}

void accepted(const std::string& toml, const std::string& what) {
    const auto ps = problems(toml);
    check(ps.empty(), what + " -> accepted");
    for (const auto& p : ps)
        std::cout << "         got: " << p << std::endl;
}

std::string write_temp(const std::string& name, const std::string& text) {
    const auto path = std::filesystem::temp_directory_path() /
                      ("cfg_failfast_" + std::to_string(getpid()) + "_" + name);
    std::ofstream(path) << text;
    return path.string();
}

const std::string kDaq = DAQ_SERVER_DIR;

}  // namespace

int main() {
    std::cout << "C2-4: a file that cannot be used is never a default Config" << std::endl;
    {
        bool threw = false;
        try {
            (void)fsw::config::load("/nonexistent/dir/config.toml");
        } catch (const ConfigError& e) {
            threw = mentions(e.problems(), "cannot open");
        }
        check(threw, "missing file -> ConfigError \"cannot open\"");
        refused("[network\nbind_ip = 0.0.0.0\n", "not valid TOML", "unclosed section header");
        refused("{ \"network\": { \"sensor_port\": 5006 } }", "not valid TOML", "JSON");
        refused("[network]\nsensor_port = 5006\nsensor_port = 5007\n", "not valid TOML",
                "duplicate key");
        fsw::config::Config out;
        std::cerr.setstate(std::ios::failbit);  // report_refused's lines are not under test
        const int rc = fsw::config::load_at_startup("/nonexistent/config.toml", "[t]", out);
        std::cerr.clear();
        check(rc == 78, "load_at_startup on a missing file returns 78");
        const std::string good = write_temp("good.toml", "[network]\nsensor_port = 5006\n");
        check(fsw::config::load_at_startup(good, "[t]", out) == 0 && out.network.sensor_port == 5006,
              "load_at_startup on a good file returns 0 and fills the Config");
        std::filesystem::remove(good);
    }

    std::cout << "C1-8: every address field must be IPv4" << std::endl;
    for (const auto& [sec, key] : std::vector<std::pair<std::string, std::string>>{
             {"network", "bind_ip"},
             {"database", "host"},
             {"server_heartbeat", "broadcast_ip"},
             {"heartbeat_service", "broadcast_ip"},
             {"heartbeat_service", "elodin_host"},
             {"controller_service", "host"},
             {"actuator_service", "bind_address"},
         }) {
        refused("[" + sec + "]\n" + key + " = \"not-an-ip\"\n", "is not an IPv4 address",
                "[" + sec + "]." + key + " = not-an-ip");
        refused("[" + sec + "]\n" + key + " = \"192.168.2.999\"\n", "is not an IPv4 address",
                "[" + sec + "]." + key + " = 192.168.2.999");
    }
    refused("[boards.pt]\ntype = \"PT\"\nip = \"192.168.2.\"\nboard_id = 21\n",
            "is not an IPv4 address", "[boards.pt].ip = 192.168.2.");
    accepted("[boards.pt]\ntype = \"PT\"\nip = \"192.168.2.21\"\nboard_id = 21\n",
             "[boards.pt].ip = 192.168.2.21");

    std::cout << "C2-5: ports and ids that do not fit are refused, not wrapped" << std::endl;
    for (const char* v : {"70000", "-1", "65536", "0"})
        refused(std::string("[network]\nsensor_port = ") + v + "\n", "out of range",
                std::string("[network].sensor_port = ") + v);
    accepted("[network]\nsensor_port = 1\nactuator_cmd_port = 65535\n", "ports 1 and 65535");
    refused("[database]\nport = 65536\n", "[database].port", "[database].port = 65536");
    refused("[boards.pt]\ntype = \"PT\"\nboard_id = 21\nlisten_port = 65537\n",
            "listen_port", "[boards.pt].listen_port = 65537");
    refused("[boards.pt]\ntype = \"PT\"\nboard_id = 21\nsend_port = -5\n", "send_port",
            "[boards.pt].send_port = -5");
    refused("[boards.pt]\ntype = \"PT\"\nboard_id = 300\n", "board_id", "board_id = 300");
    accepted("[boards.pt]\ntype = \"PT\"\nboard_id = 300\nenabled = false\n",
             "board_id = 300 on a disabled board");
    for (const char* v : {"[256]", "[-1]", "[0]"})
        refused(std::string("[boards.pt]\ntype = \"PT\"\nboard_id = 21\nactive_connectors = ") +
                    v + "\n",
                "active_connectors[0]", std::string("active_connectors = ") + v);
    refused("[actuator_roles]\n\"V\" = [\"NC\", 300, 12]\n", "(channel)", "role channel 300");
    refused("[[states]]\nid = 256\nname = \"Idle\"\n", "id = 256", "[[states]] id = 256");
    refused("[fire]\nduration_ms = -1\n", "[fire].duration_ms", "[fire].duration_ms = -1");

    std::cout << "C2-6: a value of the wrong type is refused, not defaulted" << std::endl;
    refused("[network]\nsensor_port = \"5006\"\n", "must be an integer", "port as a string");
    refused("[network]\nactuator_cmd_port = 5005.0\n", "must be an integer", "port as a float");
    refused("[database]\nport = true\n", "must be an integer", "port as a bool");
    refused("[network]\nbind_ip = 127\n", "must be a string", "address as an integer");
    refused("[heartbeat_service]\nenabled = \"yes\"\n", "must be true or false",
            "bool as a string");
    refused("[boards.pt]\ntype = \"PT\"\nboard_id = 21\nenabled = 1\n", "must be true or false",
            "enabled = 1");
    refused("[boards.pt]\ntype = \"PT\"\nboard_id = 21.0\n", "must be an integer",
            "board_id = 21.0");
    refused("[boards.pt]\ntype = \"PT\"\nboard_id = 21\nactive_connectors = [\"1\"]\n",
            "must be an integer", "connector id as a string");
    refused("[sensor_roles_pt]\n\"Fuel\" = \"1\"\n", "(channel)", "sensor role as a string");
    refused("[abort_pts]\n\"COPV\" = \"900\"\n", "must be a number", "abort_pts as a string");
    refused("[actuator_roles]\n\"V\" = \"NC\"\n", "must be [", "actuator role not an array");
    refused("[actuator_roles]\n\"V\" = [\"NC\", 1]\n", "must be [", "actuator role too short");
    refused("[[states]]\nid = \"1\"\nname = \"Idle\"\n", "must be an integer",
            "[[states]] id as a string");
    refused("network = 5\n", "must be a table", "[network] not a table");
    accepted("[boards.pt]\ntype = \"PT\"\nboard_id = 21\nadc_ref_voltage = 5\n"
             "enable_serial_printing = true\n",
             "an integer where a number goes; enable_serial_printing as a bool");

    std::cout << "C2-9: a [[states]] name declared twice is refused" << std::endl;
    refused("[[states]]\nid = 1\nname = \"Idle\"\n[[states]]\nid = 2\nname = \"Idle\"\n",
            "already the name of [[states]] #1", "two states named Idle");
    accepted("[[states]]\nid = 1\nname = \"Idle\"\n[[states]]\nid = 2\nname = \"Armed\"\n",
             "Idle and Armed");

    std::cout << "C2-12: a bad environmental id is a ConfigError, so a main can exit 78" << std::endl;
    {
        const std::string env = "[boards.env]\ntype = \"ENVIRONMENTAL\"\nboard_id = 0\n";
        refused(env, "integer from 1 to 255", "environmental board_id = 0");
        const std::string path = write_temp("env.toml", env);
        fsw::config::Config out;
        std::cerr.setstate(std::ios::failbit);
        const int rc = fsw::config::load_at_startup(path, "[t]", out);
        std::cerr.clear();
        check(rc == 78, "load_at_startup returns 78 for it (config_broadcast used to SIGABRT)");
        std::filesystem::remove(path);
    }

    std::cout << "S11: every problem is reported at once" << std::endl;
    {
        const auto ps = problems(
            "[network]\nsensor_port = 70000\nbind_ip = \"nope\"\n[database]\nport = \"x\"\n");
        check(ps.size() == 3, "three problems, three entries (got " + std::to_string(ps.size()) +
                                  ")");
        check(mentions(ps, "line 2:"), "each names its line");
    }

    std::cout << "Shipped configs load cleanly" << std::endl;
    std::vector<std::string> shipped;
    for (const auto& e : std::filesystem::directory_iterator(kDaq + "/config"))
        if (e.path().extension() == ".toml")
            shipped.push_back(e.path().string());
    std::vector<std::string> profiles;
    for (const auto& e : std::filesystem::directory_iterator(kDaq + "/config/profiles"))
        if (std::filesystem::exists(e.path() / "config.toml"))
            profiles.push_back(e.path().string());
    check(profiles.size() >= 3, "found the profiles (" + std::to_string(profiles.size()) + ")");
    for (const auto& p : profiles)
        shipped.push_back(p + "/config.toml");
    for (const auto& path : shipped) {
        std::string why;
        try {
            (void)fsw::config::load(path);
        } catch (const ConfigError& e) {
            why = e.what();
        }
        check(why.empty(), path.substr(kDaq.size() + 1) + " loads" + (why.empty() ? "" : ": " + why));
    }

    std::cout << "C2-8: every profile's transition table is well formed" << std::endl;
    for (const auto& p : profiles) {
        const std::string name = std::filesystem::path(p).filename().string();
        std::ifstream f(p + "/config.toml");
        const std::string toml((std::istreambuf_iterator<char>(f)), {});
        sequencer::StateMachine::loadStatesFromConfig(toml);
        sequencer::StateMachine sm;
        check(sm.load(p + "/state_transitions.csv"), name + ": StateMachine::load accepts it");
        // Read the table back row by row: Emergency Abort from every row, Fire only from Ready
        // (and Fire itself), where the table has those columns at all (le4 and digital-twin
        // have no abort columns; fromName would still answer from the compiled enum).
        std::ifstream csv(p + "/state_transitions.csv");
        std::string line;
        std::getline(csv, line);
        const std::string header = line + ",";
        const bool has_ea = header.find(",Emergency Abort,") != std::string::npos;
        const bool has_fire = header.find(",Fire,") != std::string::npos;
        const auto ea = sequencer::StateMachine::fromName("Emergency Abort");
        const auto fire = sequencer::StateMachine::fromName("Fire");
        while (std::getline(csv, line)) {
            const std::string from_name = line.substr(0, line.find(','));
            if (from_name.empty())
                continue;
            const auto from = sequencer::StateMachine::fromName(from_name);
            if (has_ea)
                check(sm.isAllowed(from, ea), name + ": " + from_name + " -> Emergency Abort");
            if (has_fire && from_name != "Ready" && from_name != "Fire" &&
                from_name != "Calibrate")
                check(!sm.isAllowed(from, fire), name + ": no " + from_name + " -> Fire bypass");
        }
    }
    {
        sequencer::StateMachine::loadStatesFromConfig("");
        const std::string ragged =
            write_temp("ragged.csv", ",Idle,Armed,Fire\nIdle,1,1,0\nArmed,1,1\nFire,1,0,1\n");
        sequencer::StateMachine sm;
        std::cerr.setstate(std::ios::failbit);
        const bool loaded = sm.load(ragged);
        std::cerr.clear();
        check(!loaded, "a row one cell short is refused, not read left-aligned");
        const std::string full =
            write_temp("full.csv", ",Idle,Armed,Fire\nIdle,1,1,0\nArmed,1,1,0\nFire,1,0,1\n");
        check(sm.load(full), "the same table with every cell loads");
        std::filesystem::remove(ragged);
        std::filesystem::remove(full);
    }

    if (g_failures) {
        std::cout << g_failures << " check(s) failed" << std::endl;
        return 1;
    }
    std::cout << "config fail-fast: all checks passed" << std::endl;
    return 0;
}
