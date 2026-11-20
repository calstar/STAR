// Pins fsw::config::find_pt_role / pt_role_tables — the role -> board -> channel -> Elodin table
// walk that was lifted out of config_broadcast_service_main.cpp so the sequencer's pressure
// subscriber can resolve a sensor by name instead of hardcoding a channel number.
//
// The two cases that matter most are the ones the old hardcoding got wrong on this very rig:
//
//   "GN2 Regulated"  board_id 21 -> slot 1 -> ch 6 -> {0x20, 0x16}
//   "GN2 High"       board_id 22 -> slot 2 -> ch 4 -> {0x20, 0x34}
//
// ControllerService assigns its `P_copv` from channel 6, which is GN2 Regulated — the regulated
// downstream pressure, not the COPV — and its subscriber filter (pid_lo < 0x11 || pid_lo > 0x1A)
// drops every board-2 sensor, GN2 High included. Both are silent. A test that computes 0x34 from
// config is what keeps a second consumer from inheriting either.
//
// Pure: no sockets, no files, no clock. Config comes in as a string.

#include <iostream>
#include <string>

#include "config/Config.hpp"
#include "config/SensorTables.hpp"
#include "script/ScriptConfig.hpp"
#include "script/StateScript.hpp"
#include "t7/T7Stream.hpp"

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

// Two PT boards laid out as the server profile lays them out, plus a disabled third and an
// ACTUATOR board that must never be searched for sensor roles.
//
// pt_board_z is declared FIRST in this text but sorts last, and it re-declares "GN2 High" on a
// different channel. Which one find_pt_role returns is therefore a statement about cfg.boards
// ordering — see the duplicate-role case below.
static const char* kConfig = R"TOML(
[boards.pt_board_z]
type = "PT"
ip = "192.168.2.99"
board_id = 29
enabled = true

[boards.pt_board]
type = "PT"
ip = "192.168.2.21"
board_id = 21
enabled = true

[boards.pt_board_2]
type = "PT"
ip = "192.168.2.22"
board_id = 22
enabled = true

[boards.pt_board_off]
type = "PT"
ip = "192.168.2.28"
board_id = 28
enabled = false

[boards.pt_board_slot10]
type = "PT"
ip = "192.168.2.30"
board_id = 30
enabled = true

[boards.actuator_board]
type = "ACTUATOR"
ip = "192.168.2.12"
board_id = 12
enabled = true

[sensor_roles_pt_board_z]
"GN2 High" = 9

[sensor_roles_pt_board]
"Fuel Upstream" = 1
"Ox Upstream" = 5
"GN2 Regulated" = 6

[sensor_roles_pt_board_2]
"GSE High" = 1
"GN2 High" = 4

[sensor_roles_pt_board_off]
"Ghost Sensor" = 3

[sensor_roles_pt_board_slot10]
"Slot Ten Sensor" = 2

[sensor_roles_actuator_board]
"Not A Sensor" = 1
)TOML";

int main() {
    const fsw::config::Config cfg = fsw::config::load_from_string(kConfig);
    check(cfg.boards.size() == 6, "fixture parsed six boards");

    // ── The two traps, computed from config ───────────────────────────────────────────────────
    {
        const auto r = fsw::config::find_pt_role(cfg, "GN2 Regulated");
        check(r.has_value(), "GN2 Regulated resolves");
        if (r) {
            check(r->board_key == "pt_board", "GN2 Regulated is on pt_board");
            check(r->channel == 6, "GN2 Regulated is channel 6");
            check(r->board_number == 1, "board_id 21 -> slot 1");
            check(r->table() == std::make_pair<uint8_t, uint8_t>(0x20, 0x16),
                  "GN2 Regulated table is {0x20, 0x16}");
        }
    }
    {
        const auto r = fsw::config::find_pt_role(cfg, "GN2 High");
        check(r.has_value(), "GN2 High resolves");
        if (r) {
            check(r->board_number == 2, "board_id 22 -> slot 2");
            check(r->channel == 4, "GN2 High is channel 4");
            // The whole point: 0x34 is outside the 0x11..0x1A window ControllerService filters on,
            // so a consumer that copies that filter drops the COPV sensor entirely.
            check(
                r->table() == std::make_pair<uint8_t, uint8_t>(0x20, 0x34),
                "GN2 High table is {0x20, 0x34} — board 2, NOT in ControllerService's 0x11..0x1A");
            check(r->board != nullptr && r->board->ip == "192.168.2.22",
                  "ref carries the owning board");
        }
    }

    // ── slot() wraparound: board_id 30 -> slot 10, not slot 0 ─────────────────────────────────
    {
        const auto r = fsw::config::find_pt_role(cfg, "Slot Ten Sensor");
        check(r.has_value(), "Slot Ten Sensor resolves");
        if (r) {
            check(r->board_number == 10, "board_id 30 -> slot 10 (not 0)");
            // (10-1)*0x20 + 0x10 + 2 = 0x120 + 0x12 = 0x132, truncated to uint8_t = 0x32.
            // Pinned as the encoding's actual behaviour at slot 10 rather than asserted correct:
            // a slot-10 PT board would collide with slot 2's channel 2. Worth knowing.
            check(r->table_lo == static_cast<uint8_t>((10 - 1) * 0x20 + 0x10 + 2),
                  "slot 10 table_lo follows the documented encoding");
        }
    }

    // ── Boards that must not contribute roles ────────────────────────────────────────────────
    check(!fsw::config::find_pt_role(cfg, "Ghost Sensor").has_value(),
          "a disabled board's roles do not resolve");
    check(!fsw::config::find_pt_role(cfg, "Not A Sensor").has_value(),
          "a non-PT board's roles do not resolve");
    check(!fsw::config::find_pt_role(cfg, "Nonexistent").has_value(),
          "an unknown role resolves to nullopt, not a default");

    // ── Duplicate role: which board wins, and is it stable? ──────────────────────────────────
    //
    // pt_board_z declares "GN2 High" on channel 9 and is written FIRST in the TOML text, but
    // [boards] is parsed by iterating a toml++ table, which is key-sorted. So cfg.boards order is
    // alphabetical by section key and "pt_board_2" precedes "pt_board_z". This asserts the rule
    // that actually holds, so a future change to either ordering is caught here rather than by a
    // sensor silently reading the wrong board.
    {
        const auto r = fsw::config::find_pt_role(cfg, "GN2 High");
        check(r.has_value() && r->board_key == "pt_board_2",
              "duplicate role resolves by cfg.boards order (key-sorted), not TOML text order");
    }

    // ── pt_role_tables: every role on every enabled PT board, and nothing else ───────────────
    {
        const auto all = fsw::config::pt_role_tables(cfg);
        // 1 (z) + 3 (pt_board) + 2 (pt_board_2) + 1 (slot10) = 7; the disabled and ACTUATOR
        // boards contribute nothing.
        check(all.size() == 7, "pt_role_tables lists every enabled PT board's roles and no others");
        bool saw_ghost = false, saw_actuator_role = false;
        for (const auto& r : all) {
            if (r.role == "Ghost Sensor")
                saw_ghost = true;
            if (r.role == "Not A Sensor")
                saw_actuator_role = true;
        }
        check(!saw_ghost, "pt_role_tables omits a disabled board");
        check(!saw_actuator_role, "pt_role_tables omits a non-PT board");
    }

    // ── LabJack T7 PT inputs resolve too, on the T7's calibrated table ───────────────────────
    //
    // The sequencer reads a pressure by role; a PT on a T7 is published by calibration_service on
    // {0x26, (slot-1)*0x20 + 0x10 + ain} in the same CalibratedPTMessage layout. AIN6 on slot 1
    // shares its low byte (0x16) with GN2 Regulated's ESP32 table: only the high byte differs.
    {
        const std::string t7 = std::string(kConfig) + R"TOML(
[boards.labjack_1]
type = "T7"
ip = "192.168.2.81"
board_id = 81

[[boards.labjack_1.channels]]
ain = 6
kind = "PT"
role = "T7 Tank"
signal = "0-5V"
full_scale = 1000.0

[[boards.labjack_1.channels]]
ain = 2
kind = "TC"
role = "T7 Nozzle"
tc_type = "K"

[boards.labjack_2]
type = "T7"
ip = "192.168.2.82"
board_id = 82
enabled = false

[[boards.labjack_2.channels]]
ain = 1
kind = "PT"
role = "Disabled T7 PT"
signal = "0-5V"
full_scale = 1000.0
)TOML";
        const fsw::config::Config c = fsw::config::load_from_string(t7);
        check(c.t7_errors.empty(), "T7 fixture parses without errors");
        const auto r = fsw::config::find_pt_role(c, "T7 Tank");
        check(r.has_value(), "a T7 PT input resolves by role");
        if (r) {
            check(r->t7 != nullptr && r->board == nullptr && r->board_key == "labjack_1",
                  "it carries its T7, and no ESP32 board");
            check(r->channel == 6 && r->board_number == 1, "AIN6 on slot 1");
            const auto id = fsw::t7::calibrated_table_id(1, 6);
            check(r->table() == std::make_pair(id[0], id[1]) &&
                      r->table() == std::make_pair<uint8_t, uint8_t>(0x26, 0x16),
                  "its table is the T7 calibrated table {0x26, 0x16}, not {0x20, 0x16}");
        }
        check(!fsw::config::find_pt_role(c, "T7 Nozzle").has_value(), "a T7 TC is not a pressure");
        check(!fsw::config::find_pt_role(c, "Disabled T7 PT").has_value(),
              "nor does a PT on a disabled T7");
        check(fsw::config::find_pt_role(c, "GN2 Regulated")->table() ==
                  std::make_pair<uint8_t, uint8_t>(0x20, 0x16),
              "the ESP32 PT with the same low byte keeps its own table");
        check(fsw::config::pt_role_tables(c).size() == 8, "pt_role_tables adds the one T7 PT");

        const auto names = fsw::script::build_slug_tables(c);
        check(names.tables.sensors.count(fsw::script::slugify("T7 Tank")) == 1,
              "a state script may name it (slug T7_TANK)");

        // t7_bridge refuses to stream while the T7 config has errors, so nothing it would carry
        // may be named: a script reading it is refused at load instead of waiting on silence.
        const fsw::config::Config broken =
            fsw::config::load_from_string(t7 +
                                          "\n[[boards.labjack_1.channels]]\nain = 99\n"
                                          "kind = \"PT\"\nrole = \"Bad\"\n");
        check(!broken.t7_errors.empty() && !fsw::config::find_pt_role(broken, "T7 Tank"),
              "with T7 config errors no T7 input resolves");
    }

    // ── board_key_of strips the prefix, and tolerates a section without one ──────────────────
    {
        fsw::config::BoardConfig b;
        b.section = "boards.pt_board_2";
        check(fsw::config::board_key_of(b) == "pt_board_2", "board_key_of strips \"boards.\"");
        b.section = "pt_board_2";
        check(fsw::config::board_key_of(b) == "pt_board_2",
              "board_key_of passes a bare key through");
    }

    std::cout << (g_failures == 0 ? "\nAll sensor-table checks passed.\n"
                                  : "\nFAILURES: " + std::to_string(g_failures) + "\n");
    return g_failures == 0 ? 0 : 1;
}
