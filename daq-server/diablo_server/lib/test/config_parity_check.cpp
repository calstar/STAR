// Parity harness for the toml++ config migration (temporary; deleted in the cleanup commit).
//
// Proves the new fsw::config::load()-based board derivations match the old hand-rolled
// load_active_boards()/load_pt_boards() byte-for-byte against the real config.toml, and that the
// file is valid strict TOML. Run: ./config_parity_check [path/to/config.toml]

#include <cstdlib>
#include <iostream>
#include <string>
#include <toml++/toml.hpp>

#include "config/Config.hpp"
#include "config/LoadActiveBoards.hpp"

using namespace fsw::config;

static int g_failures = 0;
#define CHECK(cond, msg)                            \
    do {                                            \
        if (!(cond)) {                              \
            std::cerr << "FAIL: " << (msg) << "\n"; \
            ++g_failures;                           \
        }                                           \
    } while (0)

int main(int argc, char** argv) {
    const std::string path = argc > 1 ? argv[1] : "config/config.toml";

    // 1. Strict-TOML validity guard.
    try {
        auto t = toml::parse_file(path);
        (void)t;
    } catch (const toml::parse_error& e) {
        std::cerr << "FAIL: " << path << " is not valid TOML: " << e.description() << "\n";
        return 1;
    }

    const Config cfg = load(path);

    // 2. active_boards parity.
    const auto old_ab = load_active_boards(path);
    const auto new_ab = active_boards(cfg);
    CHECK(old_ab.size() == new_ab.size(), "active_boards: kind count differs");
    for (const auto& [kind, vec] : old_ab) {
        auto it = new_ab.find(kind);
        CHECK(it != new_ab.end(), "active_boards: kind missing in new");
        if (it == new_ab.end())
            continue;
        CHECK(vec.size() == it->second.size(), "active_boards: board count differs for kind");
        for (size_t i = 0; i < vec.size() && i < it->second.size(); ++i) {
            CHECK(vec[i].board_id == it->second[i].board_id, "active_boards: board_id");
            CHECK(vec[i].board_number == it->second[i].board_number, "active_boards: board_number");
            CHECK(vec[i].channels == it->second[i].channels, "active_boards: channels");
        }
    }

    // 3. pt_boards parity.
    const auto old_pt = load_pt_boards(path);
    const auto new_pt = pt_boards(cfg);
    CHECK(old_pt.size() == new_pt.size(), "pt_boards: slot count differs");
    for (const auto& [slot, b] : old_pt) {
        auto it = new_pt.find(slot);
        CHECK(it != new_pt.end(), "pt_boards: slot missing in new");
        if (it == new_pt.end())
            continue;
        CHECK(b.board_id == it->second.board_id, "pt_boards: board_id");
        CHECK(b.interface == it->second.interface, "pt_boards: interface");
        CHECK(b.full_scale_psi == it->second.full_scale_psi, "pt_boards: full_scale_psi");
        CHECK(b.sense_resistor_ohms == it->second.sense_resistor_ohms, "pt_boards: sense_resistor");
        CHECK(b.adc_ref_voltage == it->second.adc_ref_voltage, "pt_boards: adc_ref_voltage");
    }

    if (g_failures == 0) {
        std::cout << "config_parity_check: PASS (" << path << ")\n";
        return 0;
    }
    std::cerr << "config_parity_check: " << g_failures << " FAILURE(S)\n";
    return 1;
}
