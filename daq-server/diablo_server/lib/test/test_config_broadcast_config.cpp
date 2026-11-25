// config_broadcast's own config handling, through its real file-static functions (main renamed out
// of the way, as test/characterization/config/char_config_services.cpp does).
//
//   C2-7  buildPackets reads [state_machine].actuator_csv, not a cwd-relative
//         config/state_machine_actuators.csv that happens to exist
//   C2-12 a config re-read that is refused mid-run keeps the last good packets; it used to throw
//         std::invalid_argument out of the send loop and SIGABRT the service
//   C1-8  ipToU32Le refuses what inet_pton refuses, instead of encoding 0.0.0.0

#include <unistd.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

#define main config_broadcast_main_unused
#include "../../services/config_broadcast/config_broadcast_service_main.cpp"
#undef main

namespace {

int g_failures = 0;

void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        ++g_failures;
}

void write(const std::filesystem::path& p, const std::string& text) {
    std::filesystem::create_directories(p.parent_path());
    std::ofstream(p) << text;
}

// The vent byte of the first actuator entry in the first ACTUATOR_CONFIG packet: header 6 bytes,
// is_abort_controller, N, then ip(4) id(1) vent(1) abort(1) per actuator.
int first_vent_byte(const std::vector<ConfigPacket>& pkts) {
    for (const auto& [type, bytes, ip, port] : pkts)
        if (type == ACTUATOR_CONFIG && bytes.size() > 6 + 2 + 5 && bytes[7] > 0)
            return bytes[6 + 2 + 5];
    return -1;
}

std::string config(const std::string& actuator_csv, const std::string& env_id) {
    return "[boards.actuator_board]\ntype = \"ACTUATOR\"\nip = \"127.0.0.12\"\nboard_id = 12\n"
           "designated_survivor = true\n"
           "[boards.env]\ntype = \"ENVIRONMENTAL\"\nip = \"127.0.0.90\"\nboard_id = " +
           env_id + "\n[actuator_roles]\n\"Fuel Vent\" = [\"NC\", 3, 12]\n" +
           "[state_machine]\nactuator_csv = \"" + actuator_csv + "\"\n";
}

}  // namespace

int main() {
    const auto dir = std::filesystem::temp_directory_path() /
                     ("cb_cfg_" + std::to_string(getpid()));
    std::filesystem::create_directories(dir);
    const auto old_cwd = std::filesystem::current_path();
    std::filesystem::current_path(dir);

    // The decoy sits where the old fallback looked first; the configured file says otherwise.
    write(dir / "config/state_machine_actuators.csv", ",Vent,Engine Abort\nFuel Vent,CLOSE,CLOSE\n");
    write(dir / "profile/actuators.csv", ",Vent,Engine Abort\nFuel Vent,OPEN,CLOSE\n");
    const auto cfg_path = (dir / "profile/config.toml").string();
    write(cfg_path, config((dir / "profile/actuators.csv").string(), "90"));

    std::cout << "C2-7: the configured actuator CSV wins" << std::endl;
    const auto good = buildPackets(cfg_path);
    check(!good.empty(), "packets built from the good config");
    check(first_vent_byte(good) == 1,
          "Fuel Vent's vent byte comes from [state_machine].actuator_csv (OPEN), not the "
          "cwd decoy (CLOSE)");

    std::cout << "C2-12: a refused re-read keeps the last good set" << std::endl;
    write(cfg_path, config((dir / "profile/actuators.csv").string(), "0"));
    bool threw = false;
    std::vector<ConfigPacket> refused;
    std::cerr.setstate(std::ios::failbit);
    try {
        refused = buildPackets(cfg_path);
    } catch (...) {
        threw = true;
    }
    std::cerr.clear();
    check(!threw, "buildPackets does not throw on a bad environmental id saved mid-run");
    check(refused.empty(), "it returns no packets, so the send loop keeps the last good set");

    std::cout << "C1-8: addresses parse strictly" << std::endl;
    check(ipToU32Le("192.168.2.21") == 0xC0A80215u, "192.168.2.21");
    check(!ipToU32Le("not-an-ip"), "not-an-ip is refused (was 0.0.0.0)");
    check(!ipToU32Le("192.168.2.999"), "192.168.2.999 is refused (was a wrapped octet)");
    check(!ipToU32Le("1.2.3.4junk"), "1.2.3.4junk is refused (sscanf took it)");

    std::filesystem::current_path(old_cwd);
    std::filesystem::remove_all(dir);
    if (g_failures) {
        std::cout << g_failures << " check(s) failed" << std::endl;
        return 1;
    }
    std::cout << "config_broadcast config: all checks passed" << std::endl;
    return 0;
}
