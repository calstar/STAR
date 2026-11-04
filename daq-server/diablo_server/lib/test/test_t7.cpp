/**
 * LabJack T7 support, without a T7: the [boards.*] type = "T7" config, what t7_bridge writes to
 * the device before streaming, and how a stream block becomes timestamped samples.
 *
 * The device is FakeT7Device, which records every call. Nothing here opens a socket.
 */
#include <unistd.h>

#include <algorithm>
#include <climits>
#include <cmath>
#include <iostream>
#include <memory>
#include <set>
#include <string>

#include "calibration/TypeK.hpp"
#include "config/Config.hpp"
#include "t7/T7Calibration.hpp"
#include "t7/T7Convert.hpp"
#include "t7/T7Stream.hpp"

using fsw::config::Config;
using fsw::config::T7Board;
using fsw::t7::FakeT7Device;
using fsw::t7::T7Error;
using fsw::t7::T7Session;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

static bool has_error(const Config& c, const std::string& needle) {
    for (const auto& e : c.t7_errors)
        if (e.find(needle) != std::string::npos)
            return true;
    return false;
}

static void print_errors(const Config& c) {
    for (const auto& e : c.t7_errors)
        std::cout << "         " << e << std::endl;
}

// A valid T7 with a PT, a TC and a differential load cell.
static const char* kGood = R"(
[boards.pt_board]
type = "PT"
ip = "192.168.2.21"
board_id = 21
active_connectors = [1, 2]

[boards.labjack_1]
type = "T7"
ip = "192.168.2.81"
mac = "aa:bb:cc:dd:ee:81"
board_id = 81
enabled = true
scan_rate_hz = 100.0

[[boards.labjack_1.channels]]
ain = 1
kind = "PT"
role = "LOX Tank"
range = 10.0
signal = "0-5V"
full_scale = 1000.0

[[boards.labjack_1.channels]]
ain = 2
kind = "TC"
tc_type = "K"
role = "Nozzle"

[[boards.labjack_1.channels]]
ain = 4
kind = "LC"
role = "Thrust"
differential = true
range = 0.1
full_scale = 500.0
sensitivity_mv_per_v = 2.0
excitation_v = 10.0
)";

// One T7 board section around a channel table, for the error cases.
static std::string t7(const std::string& channels, const std::string& extra = "",
                      const std::string& name = "lj", int board_id = 81) {
    return "[boards." + name + "]\ntype = \"T7\"\nip = \"192.168.2." + std::to_string(board_id) +
           "\"\nboard_id = " + std::to_string(board_id) + "\n" + extra + "\n" + channels;
}
static std::string ch(int ain, const std::string& kind, const std::string& extra = "",
                      const std::string& board = "lj") {
    return "[[boards." + board + ".channels]]\nain = " + std::to_string(ain) + "\nkind = \"" +
           kind + "\"\n" + extra + "\n";
}

static T7Board good_board() {
    return fsw::config::load_from_string(kGood).t7_boards.at(0);
}

// The same board with AIN2 as a plain voltage input: no thermocouple, so no AIN14 in the scan.
// The stream-timing cases below use it so each scan is exactly the three configured inputs.
static T7Board stream_board() {
    T7Board b = good_board();
    b.channels[1].kind = "VOLTAGE";
    b.channels[1].tc_type.clear();
    b.channels[1].range_v = 10.0;
    return b;
}

static bool near(double a, double b, double tol) {
    return std::fabs(a - b) <= tol;
}

int main() {
    std::cout << "=== T7 config ===" << std::endl;
    {
        const Config c = fsw::config::load_from_string(kGood);
        print_errors(c);
        check(c.t7_errors.empty(), "a valid T7 parses with no errors");
        check(c.t7_boards.size() == 1, "exactly the one type = \"T7\" board is a T7 board");
        const T7Board& b = c.t7_boards.at(0);
        check(b.section == "boards.labjack_1" && b.ip == "192.168.2.81" && b.board_id == 81 &&
                  b.mac == "aa:bb:cc:dd:ee:81",
              "section, ip, board_id and mac are read");
        check(b.slot() == 1, "board_id 81 is Elodin slot 1");
        check(b.effective_scans_per_read() == 5, "scans_per_read defaults to a 50 ms block");
        check(b.channels.size() == 3, "three channels");
        check(b.channels[0].ain == 1 && b.channels[0].kind == "PT" &&
                  b.channels[0].role == "LOX Tank" && b.channels[0].range_v == 10.0,
              "PT channel: ain, kind, role, range");
        check(b.channels[0].negative_ch() == 199, "single-ended by default (NEGATIVE_CH 199)");
        check(b.channels[1].range_v == 0.1 && b.channels[1].tc_type == "K",
              "a TC with no range gets +/-0.1 V, not the 10 V default");
        check(b.channels[2].negative_ch() == 5, "differential AIN4 pairs with AIN5");

        // Every other reader must keep ignoring a T7.
        const auto active = fsw::config::active_boards(c);
        size_t n = 0;
        for (const auto& [kind, boards] : active)
            n += boards.size();
        check(n == 1, "active_boards() still sees only the PT board, not the T7");
    }
    {
        const Config c = fsw::config::load_from_string(
            "[boards.pt]\ntype = \"PT\"\nip = \"192.168.2.21\"\nboard_id = 21\n");
        check(c.t7_boards.empty() && c.t7_errors.empty(), "a config with no T7 has no T7 errors");
    }
    {
        // Disabled and half filled in is how a T7 gets added: allowed.
        const Config c = fsw::config::load_from_string(
            "[boards.new_lj]\ntype = \"T7\"\nboard_id = 81\nenabled = false\nmac = \"\"\n");
        print_errors(c);
        check(c.t7_errors.empty() && c.t7_boards.size() == 1 && !c.t7_boards[0].enabled,
              "a disabled T7 with no ip and no channels is not an error");
    }

    struct Bad {
        std::string toml, needle, what;
    };
    const Bad bad[] = {
        {t7(ch(1, "PT") + ch(1, "TC", "tc_type = \"K\"")), "AIN1 is already used",
         "the same AIN twice"},
        {t7(ch(0, "LC", "differential = true") + ch(1, "PT")), "AIN1 is already used",
         "an AIN that is the other half of a differential pair"},
        {t7(ch(3, "LC", "differential = true")), "must be an even AIN", "an odd differential AIN"},
        {t7(ch(14, "PT")), "ain must be 0-13", "AIN14 (a T7 has AIN0-13)"},
        {t7(ch(1, "PT", "range = 5.0")), "range must be one of", "a range the T7 does not have"},
        {t7(ch(1, "TC")), "only type K", "a thermocouple with no type"},
        {t7(ch(1, "TC", "tc_type = \"J\"")), "only type K",
         "a thermocouple type with no curve yet (J)"},
        {t7(ch(1, "PT", "signal = \"0-5V\"\nrole = \"A\"")), "needs full_scale",
         "a PT with no full_scale"},
        {t7(ch(1, "PT", "full_scale = 100.0\nrole = \"A\"")), "needs signal",
         "a PT with no signal"},
        {t7(ch(1, "PT", "full_scale = 100.0\nsignal = \"0-3V\"\nrole = \"A\"")), "needs signal",
         "a PT signal that is not one"},
        {t7(ch(1, "PT", "full_scale = 100.0\nsignal = \"4-20mA\"\nrole = \"A\"")),
         "needs shunt_ohms", "a 4-20mA PT with no shunt"},
        {t7(ch(1, "PT", "full_scale = 1.0\nsignal = \"0-5V\"\nshunt_ohms = 250.0\nrole = \"A\"")),
         "only meaningful on a 4-20mA", "a shunt on a voltage PT"},
        {t7(ch(1, "LC", "full_scale = 1.0\nexcitation_v = 5.0\nrole = \"A\"")),
         "needs sensitivity_mv_per_v", "an LC with no sensitivity"},
        {t7(ch(1, "LC", "full_scale = 1.0\nsensitivity_mv_per_v = 2.0\nrole = \"A\"")),
         "needs excitation_v", "an LC with no excitation"},
        {t7(ch(1, "TC", "tc_type = \"K\"\nsignal = \"0-5V\"\nrole = \"A\"")),
         "only meaningful on a PT", "a PT signal on a TC"},
        {t7(ch(1, "TC", "tc_type = \"K\"\nfull_scale = 5.0\nrole = \"A\"")),
         "only meaningful on a PT or LC", "full_scale on a TC"},
        {t7(ch(1, "TC", "tc_type = \"K\"")), "needs a role", "a TC with no role"},
        {t7(ch(1, "TC", "tc_type = \"K\"\nrole = \"A\"") +
            ch(2, "TC", "tc_type = \"K\"\nrole = \"A\"")),
         "role \"A\" is already used", "the same role twice"},
        {t7(ch(1, "PT"), "cjc_offset_k = 40.0"), "cjc_offset_k", "an absurd cjc_offset_k"},
        {t7(ch(1, "PT", "tc_type = \"K\"")), "only meaningful", "tc_type on a PT"},
        {t7(ch(1, "STRAIN")), "kind \"STRAIN\"", "an unknown kind"},
        {t7(""), "at least one", "an enabled T7 with no channels"},
        {"[boards.lj]\ntype = \"T7\"\nboard_id = 81\n" + ch(1, "PT"), "ip is required",
         "an enabled T7 with no ip"},
        {"[boards.lj]\ntype = \"T7\"\nip = \"192.168.2\"\nboard_id = 81\n" + ch(1, "PT"),
         "not an IPv4", "a malformed ip"},
        {t7(ch(1, "PT"), "", "lj", 300), "board_id must be", "board_id out of range"},
        {t7(ch(1, "PT"), "resolution_index = 9"), "resolution_index must be 0-8",
         "a resolution index stream does not support"},
        {t7(ch(1, "PT") + ch(2, "PT"), "scan_rate_hz = 60000.0"), "beyond the T7",
         "an aggregate rate past 100 kS/s"},
        {t7(ch(1, "PT"), "scan_rate_hz = 0.0"), "must be positive", "a zero scan rate"},
        {t7(ch(1, "PT"), "", "lj", 81) + t7(ch(1, "PT", "", "lj2"), "", "lj2", 91),
         "shares Elodin slot 1", "two T7s on the same slot"},
        {t7(ch(1, "PT"), "", "lj", 89), "only slots 1-8", "a slot past 8"},
    };
    for (const auto& b : bad) {
        const Config c = fsw::config::load_from_string(b.toml);
        const bool ok = has_error(c, b.needle);
        check(ok, "rejects " + b.what);
        if (!ok)
            print_errors(c);
    }

    {
        // The GUI's config editor writes through smol-toml, which turns 10.0 into 10.
        const Config c = fsw::config::load_from_string(
            t7(ch(1, "PT", "range = 10\nsignal = \"0-5V\"\nfull_scale = 5000\nrole = \"A\"")));
        print_errors(c);
        check(c.t7_errors.empty() && c.t7_boards.at(0).channels.at(0).range_v == 10.0 &&
                  c.t7_boards.at(0).channels.at(0).full_scale == 5000.0,
              "integer range / full_scale (as the GUI writes them) are read as numbers");
    }

    std::cout << "=== type K ===" << std::endl;
    {
        using fsw::calibration::type_k_c_from_mv;
        using fsw::calibration::type_k_mv_from_c;
        // NIST ITS-90 type K table points; these are also the sub-range boundaries of the inverse.
        const double table[][2] = {
            {-100, -3.554}, {0, 0.0}, {100, 4.096}, {400, 16.397}, {800, 33.275}};
        bool inv = true, fwd = true;
        for (const auto& [c, mv] : table) {
            inv = inv && near(type_k_c_from_mv(mv), c, 0.1);
            fwd = fwd && near(type_k_mv_from_c(c), mv, 0.005);
        }
        check(inv, "mV -> C matches the NIST table within 0.1 C");
        check(fwd, "C -> mV matches the NIST table within 5 uV");
        bool round = true;
        for (double c = -200; c <= 1300; c += 7.3)
            round = round && near(type_k_c_from_mv(type_k_mv_from_c(c)), c, 1e-6);
        check(round, "C -> mV -> C round-trips across -200..1300 C");
        check(std::isnan(type_k_c_from_mv(80.0)) && std::isnan(type_k_mv_from_c(2000.0)),
              "off the curve is NaN, not a number");
    }

    std::cout << "=== conversions ===" << std::endl;
    {
        fsw::config::T7Channel pt;
        pt.kind = "PT";
        pt.full_scale = 1000;
        pt.signal = "0-5V";
        check(near(fsw::t7::pt_psi(2.5, pt), 500, 1e-9) && near(fsw::t7::pt_psi(0, pt), 0, 1e-9),
              "0-5V PT: 2.5 V is half scale");
        pt.signal = "0.5-4.5V";
        check(near(fsw::t7::pt_psi(0.5, pt), 0, 1e-9) && near(fsw::t7::pt_psi(4.5, pt), 1000, 1e-9),
              "0.5-4.5V PT: 0.5 V is zero, 4.5 V full scale");
        pt.signal = "1-5V";
        check(near(fsw::t7::pt_psi(3.0, pt), 500, 1e-9), "1-5V PT: 3 V is half scale");
        pt.signal = "0-10V";
        check(near(fsw::t7::pt_psi(10.0, pt), 1000, 1e-9), "0-10V PT: 10 V is full scale");
        pt.signal = "4-20mA";
        pt.shunt_ohms = 250;  // 4 mA -> 1 V, 20 mA -> 5 V
        check(near(fsw::t7::pt_psi(1.0, pt), 0, 1e-9) &&
                  near(fsw::t7::pt_psi(3.0, pt), 500, 1e-9) &&
                  near(fsw::t7::pt_psi(5.0, pt), 1000, 1e-9),
              "4-20mA PT across 250 ohm: 1 V zero, 3 V half, 5 V full");
        pt.signal = "";
        check(std::isnan(fsw::t7::pt_psi(2.5, pt)), "a PT with no signal converts to NaN");

        fsw::config::T7Channel lc;
        lc.kind = "LC";
        lc.full_scale = 500;
        lc.sensitivity_mv_per_v = 2.0;
        lc.excitation_v = 10.0;  // rated output 20 mV
        check(near(fsw::t7::lc_kg(0.010, lc), 250, 1e-9) &&
                  near(fsw::t7::lc_kg(-0.020, lc), -500, 1e-9),
              "LC: 10 mV of a 20 mV rated output is half load; sign follows the bridge");

        const double off = fsw::t7::cjc_device_offset_k(300.0, 1.8);
        check(near(fsw::t7::cjc_temp_c(1.8, off, 0.0), 300.0 - 273.15, 1e-9),
              "CJC: AIN14 at the reference reading gives the device's own temperature");
        check(near(fsw::t7::cjc_temp_c(1.81, off, 0.0) - fsw::t7::cjc_temp_c(1.8, off, 0.0),
                   -0.92379, 1e-9) &&
                  near(fsw::t7::cjc_temp_c(1.8, off, -4.9), 300.0 - 273.15 - 4.9, 1e-9),
              "CJC: -92.379 K per AIN14 volt, plus cjc_offset_k");

        // A thermocouple at 200 C, terminals at 25 C, reads EMF(200) - EMF(25).
        const double v =
            (fsw::calibration::type_k_mv_from_c(200.0) - fsw::calibration::type_k_mv_from_c(25.0)) /
            1000.0;
        check(near(fsw::t7::tc_c(v, 25.0), 200.0, 1e-6),
              "TC: the cold junction's EMF is added back");
        check(!near(fsw::t7::tc_c(v, 0.0), 200.0, 10.0),
              "TC: without it the reading is ~25 C low (the junction matters)");
        check(std::isnan(fsw::t7::tc_c(0.5, 25.0)), "TC: 500 mV is off the curve -> NaN");
    }

    std::cout << "=== stream plan ===" << std::endl;
    {
        const auto p = fsw::t7::plan_stream(good_board());
        check(p.scan_names == std::vector<std::string>({"AIN1", "AIN2", "AIN4", "AIN14"}),
              "scan list is the configured AINs in config order, then AIN14 for the TC");
        check(p.cjc_index == 3 && !p.channels[3].has_value() && p.channels[1]->kind == "TC",
              "AIN14 is marked as the cold junction and carries no channel");
        const auto q = fsw::t7::plan_stream(stream_board());
        check(q.scan_names == std::vector<std::string>({"AIN1", "AIN2", "AIN4"}) &&
                  q.cjc_index == -1,
              "no thermocouple, no AIN14");
        check(p.scan_names.front().rfind("AIN", 0) == 0,
              "first scan entry is an AIN (auto-recovery marks gaps in the first channel)");
        auto value = [&](const std::string& n) -> double {
            for (size_t i = 0; i < p.setup_names.size(); ++i)
                if (p.setup_names[i] == n)
                    return p.setup_values[i];
            return std::nan("");
        };
        check(value("AIN1_RANGE") == 10.0 && value("AIN2_RANGE") == 0.1 &&
                  value("AIN4_RANGE") == 0.1 && value("AIN14_RANGE") == 10.0,
              "each AIN's range is written");
        check(value("AIN1_NEGATIVE_CH") == 199 && value("AIN4_NEGATIVE_CH") == 5,
              "single-ended and differential inputs are written");
        check(value("STREAM_RESOLUTION_INDEX") == 0 && value("STREAM_SETTLING_US") == 0 &&
                  value("STREAM_TRIGGER_INDEX") == 0 && value("STREAM_CLOCK_SOURCE") == 0,
              "stream timing registers are written");
        bool only_config = true;
        for (const auto& n : p.setup_names)
            if (n.find("DIO") != std::string::npos || n.find("DAC") != std::string::npos ||
                n.find("FIO") != std::string::npos || n.find("EIO") != std::string::npos ||
                n.find("CIO") != std::string::npos || n.find("MIO") != std::string::npos)
                only_config = false;
        check(only_config, "nothing written drives an output (no DIO/FIO/EIO/CIO/MIO/DAC)");
        check(fsw::t7::table_id(1, 3) == std::array<uint8_t, 2>{0x26, 0x03} &&
                  fsw::t7::table_id(2, 13) == std::array<uint8_t, 2>{0x26, 0x2D},
              "table id is {0x26, (slot-1)*0x20 + ain}");
        check(fsw::t7::entity_name(1, 3) == "T71.AIN3", "entity name T7<slot>.AIN<n>");
        check(fsw::t7::calibrated_table_id(1, 3) == std::array<uint8_t, 2>{0x26, 0x13} &&
                  fsw::t7::calibrated_table_id(2, 13) == std::array<uint8_t, 2>{0x26, 0x3D} &&
                  fsw::t7::calibrated_entity_name(1, 3) == "T71_Cal.AIN3",
              "calibrated table is the raw id + 0x10, entity T7<slot>_Cal.AIN<n>");
        check(std::string(fsw::t7::calibrated_field("PT")) == "pressure_psi" &&
                  std::string(fsw::t7::calibrated_field("TC")) == "temperature_c" &&
                  std::string(fsw::t7::calibrated_field("LC")) == "force_kg" &&
                  std::string(fsw::t7::calibrated_field("VOLTAGE")).empty(),
              "calibrated fields have the ESP32 boards' names; VOLTAGE has none");
    }

    std::cout << "=== session ===" << std::endl;
    const fsw::time::TimeSyncConfig board_clock;  // default mode BoardClock
    {
        auto dev = std::make_unique<FakeT7Device>();
        FakeT7Device* d = dev.get();
        uint64_t now = 1'700'000'000'000'000'000ULL;
        T7Session s(stream_board(), std::move(dev), board_clock, [&] {
            return now;
        });
        const double rate = s.start();
        check(d->opened_ip == "192.168.2.81", "opens the T7 at the configured ip");
        check(rate == 100.0 && d->streaming, "stream started at the asked rate");
        check(d->writes.size() == s.plan().setup_names.size(),
              "every setup register written, before the stream started");

        // Block 1 arrives 2 ms after its newest scan (scan 4, 40 ms in).
        now += 42'000'000ULL;
        const auto b1 = s.read();
        check(b1.scans == 5 && b1.samples.size() == 15, "a block is 5 scans x 3 AINs");
        check(b1.samples[0].ain == 1 && b1.samples[1].ain == 2 && b1.samples[2].ain == 4,
              "samples carry their AIN, in scan order");
        check(std::fabs(b1.samples[3].volts - (0.1 + 0.05 * std::sin(2 * M_PI * 0.2 * 0.01))) <
                  1e-6,
              "volts are the device's values for that AIN and scan");
        check(b1.samples[3].sample_ms == 10 && b1.samples[14].sample_ms == 40,
              "sample_ms is scan time since stream start (10 ms per scan at 100 Hz)");
        const uint64_t t0 = b1.samples[0].timestamp_ns, t4 = b1.samples[12].timestamp_ns;
        check(t4 - t0 == 40'000'000ULL, "scans in a block are 10 ms apart");
        check(b1.samples[13].timestamp_ns == t4, "one timestamp for every AIN in a scan");
        check(t4 <= now, "the newest scan is not stamped after it arrived");

        now += 50'000'000ULL;  // next block, same latency
        const auto b2 = s.read();
        check(b2.samples[0].timestamp_ns - t4 == 10'000'000ULL,
              "the next block continues one scan period after the last");
        check(b2.samples[0].sample_ms == 50, "and its sample_ms continues the count");

        s.stop();
        check(!d->streaming && d->closed, "stop() stops the stream and closes the device");
    }
    {
        // The device rounds the rate: timestamps must follow what it runs at, not the ask.
        FakeT7Device::Options o;
        o.rate_cap_hz = 50.0;
        uint64_t now = 1'700'000'000'000'000'000ULL;
        T7Session s(stream_board(), std::make_unique<FakeT7Device>(o), board_clock, [&] {
            return now;
        });
        check(s.start() == 50.0, "start() returns the device's actual rate");
        now += 100'000'000ULL;
        const auto b = s.read();
        check(b.samples[3].timestamp_ns - b.samples[0].timestamp_ns == 20'000'000ULL &&
                  b.samples[3].sample_ms == 20,
              "scan spacing uses the actual rate (20 ms at 50 Hz)");
    }
    {
        // At 300 Hz scans fall between whole milliseconds. The clock sync works in whole ms and
        // the sub-ms part is added back, which must not push the newest scan past its arrival.
        T7Board b = stream_board();
        b.scan_rate_hz = 300.0;
        uint64_t now = 1'700'000'000'000'000'000ULL;
        T7Session s(b, std::make_unique<FakeT7Device>(), board_clock, [&] {
            return now;
        });
        s.start();
        now += 46'000'000ULL;
        for (int i = 0; i < 3; ++i) {
            const auto blk = s.read();
            check(blk.samples.back().timestamp_ns <= now,
                  "300 Hz block " + std::to_string(i + 1) + ": newest scan not after arrival");
            now += 50'000'000ULL;
        }
    }
    {
        FakeT7Device::Options o;
        o.dummy_scan_every = 5;  // scan 4 of each 5-scan block is lost
        uint64_t now = 1'700'000'000'000'000'000ULL;
        T7Session s(stream_board(), std::make_unique<FakeT7Device>(o), board_clock, [&] {
            return now;
        });
        s.start();
        now += 50'000'000ULL;
        const auto b = s.read();
        bool any_dummy = false;
        for (const auto& x : b.samples)
            any_dummy = any_dummy || x.volts == -9999.0f;
        check(b.skipped_samples == 3 && b.samples.size() == 12,
              "auto-recovery scans are counted and not published");
        check(!any_dummy, "no -9999 reaches Elodin");
    }
    {
        fsw::time::TimeSyncConfig arrival;
        arrival.mode = fsw::time::TimeSyncConfig::Mode::Arrival;
        uint64_t now = 1'700'000'000'000'000'000ULL;
        T7Session s(stream_board(), std::make_unique<FakeT7Device>(), arrival, [&] {
            return now;
        });
        s.start();
        now += 777'000'000ULL;
        const auto b = s.read();
        check(b.samples.back().timestamp_ns == now &&
                  now - b.samples.front().timestamp_ns == 40'000'000ULL,
              "[time_sync] arrival: newest scan at arrival, the rest a period apart behind it");
    }
    {
        T7Board b = stream_board();
        b.serial = 470099999;
        auto dev = std::make_unique<FakeT7Device>();  // serial 470000000
        FakeT7Device* d = dev.get();
        T7Session s(b, std::move(dev), board_clock, [] {
            return uint64_t{0};
        });
        bool threw = false;
        try {
            s.start();
        } catch (const T7Error&) {
            threw = true;
        }
        check(threw && !d->streaming && d->writes.empty(),
              "a T7 with the wrong serial is refused before anything is written to it");
        s.stop();
    }
    {
        // No serial in config: start() still reads it, for the bridge's bring-up log line.
        auto dev = std::make_unique<FakeT7Device>();  // serial 470000000
        T7Session s(stream_board(), std::move(dev), board_clock, [] {
            return uint64_t{0};
        });
        check(s.serial() == 0, "serial() is 0 before start()");
        s.start();
        check(s.serial() == 470000000, "start() reads the serial even when the config gives none");
        s.stop();
    }
    {
        FakeT7Device::Options o;
        o.fail_read_after = 1;
        auto dev = std::make_unique<FakeT7Device>(o);
        FakeT7Device* d = dev.get();
        T7Session s(stream_board(), std::move(dev), board_clock, [] {
            return 1'700'000'000'000'000'000ULL;
        });
        s.start();
        s.read();
        bool threw = false;
        try {
            s.read();
        } catch (const T7Error& e) {
            threw = e.code() == 1306;
        }
        check(threw, "a lost link surfaces as T7Error with LJM's code");
        s.stop();
        check(d->closed, "and the session still closes the device");
    }

    std::cout << "=== restart: a stream left running ===" << std::endl;
    {
        // A T7 keeps streaming after the bridge that started it dies, and refuses configuration
        // while it does. A killed bridge (or a server torn down mid-run) is modelled by dropping
        // its session without stop(): the unit is the device, and it outlives the connection.
        using fsw::t7::FakeT7Unit;
        auto unit = std::make_shared<FakeT7Unit>();
        auto handle = [&](FakeT7Device::Options o = {}) {
            o.unit = unit;
            return std::make_unique<FakeT7Device>(o);
        };
        const auto now = [] {
            return 1'700'000'000'000'000'000ULL;
        };
        {
            T7Session a(stream_board(), handle(), board_clock, now);
            a.start();
            a.read();
            check(!a.stopped_leftover_stream(), "a fresh T7: nothing to stop");
        }  // killed: no stop()
        check(unit->streaming && unit->stops == 0,
              "a bridge that dies without stopping leaves the T7 streaming");

        // The next bridge comes up with an edited config: AIN1 moved to the 1 V range.
        T7Board edited = stream_board();
        edited.channels[0].range_v = 1.0;
        auto dev = handle();
        FakeT7Device* d = dev.get();
        T7Session b(edited, std::move(dev), board_clock, now);
        bool started = true;
        try {
            b.start();
        } catch (const T7Error& e) {
            started = false;
            std::cout << "    start: " << e.what() << std::endl;
        }
        check(started && b.stopped_leftover_stream(),
              "the next bridge stops the leftover stream and starts its own");
        check(unit->stops == 1 && unit->starts == 2 && unit->streaming,
              "one stop, then a second stream start");
        check(d->stop_calls == 1 && std::none_of(d->writes.begin(), d->writes.end(),
                                                 [](const auto& w) {
                                                     return w.first == "STREAM_ENABLE";
                                                 }),
              "by eStreamStop on the new handle (what a real T7 answers), not the fallback");
        check(unit->reg("AIN1_RANGE") == 1.0,
              "the device is reconfigured to the new config, not left on the old one");
        check(d->streaming && b.read().samples.size() == 15, "and the new stream delivers");

        b.stop();
        check(!unit->streaming, "a clean stop leaves the T7 idle");
        T7Session c(stream_board(), handle(), board_clock, now);
        c.start();
        check(!c.stopped_leftover_stream(), "and the bridge after a clean stop finds nothing");
        c.stop();
    }
    {
        // If LJM answers a new handle's stop locally (1225) and never tells the device, the
        // setup write hits STREAM_IS_ACTIVE: stop it at the device with STREAM_ENABLE = 0.
        auto unit = std::make_shared<fsw::t7::FakeT7Unit>();
        FakeT7Device::Options o;
        o.unit = unit;
        o.stop_only_own_stream = true;
        const auto now = [] {
            return 1'700'000'000'000'000'000ULL;
        };
        {
            T7Session a(stream_board(), std::make_unique<FakeT7Device>(o), board_clock, now);
            a.start();
        }
        auto dev = std::make_unique<FakeT7Device>(o);
        FakeT7Device* d = dev.get();
        T7Session b(stream_board(), std::move(dev), board_clock, now);
        bool started = true;
        try {
            b.start();
        } catch (const T7Error& e) {
            started = false;
            std::cout << "    start: " << e.what() << std::endl;
        }
        const bool wrote_enable =
            std::find(d->writes.begin(), d->writes.end(),
                      std::pair<std::string, double>("STREAM_ENABLE", 0.0)) != d->writes.end();
        check(started && wrote_enable && b.stopped_leftover_stream(),
              "a stop LJM keeps to itself falls back to STREAM_ENABLE = 0, then configures");
        b.stop();
    }
    {
        // Two bridges on one T7 (an old server never shut down): the new one takes the stream
        // and the old one's reads fail rather than silently stalling. They then keep taking it
        // from each other on every retry (a stop from any connection stops the device), which is
        // why the bridge logs each takeover: two live bridges on one T7 is a setup error.
        auto unit = std::make_shared<fsw::t7::FakeT7Unit>();
        FakeT7Device::Options o;
        o.unit = unit;
        const auto now = [] {
            return 1'700'000'000'000'000'000ULL;
        };
        T7Session old_one(stream_board(), std::make_unique<FakeT7Device>(o), board_clock, now);
        old_one.start();
        T7Session new_one(stream_board(), std::make_unique<FakeT7Device>(o), board_clock, now);
        new_one.start();
        int code = 0;
        try {
            old_one.read();
        } catch (const T7Error& e) {
            code = e.code();
        }
        check(code == 1306, "the bridge whose stream was taken over gets no more data (1306)");
        check(new_one.read().samples.size() == 15, "while the new one streams");
        new_one.stop();
        old_one.stop();
    }
    {
        // A stop that fails for a real reason is not "nothing was running".
        FakeT7Device::Options o;
        o.fail_stop_code = 1239;  // LJME_RECONNECT_FAILED
        auto dev = std::make_unique<FakeT7Device>(o);
        FakeT7Device* d = dev.get();
        T7Session s(stream_board(), std::move(dev), board_clock, [] {
            return 1'700'000'000'000'000'000ULL;
        });
        int code = 0;
        try {
            s.start();
        } catch (const T7Error& e) {
            code = e.code();
        }
        check(code == 1239 && d->writes.empty(),
              "a stop that fails for a real reason stops start(), before any write");
        s.stop();
    }
    {
        // Across processes: the unit is a file, and a new FakeT7Unit (a new bridge) reads it.
        const std::string path = "/tmp/test_t7_unit_" + std::to_string(::getpid()) + ".state";
        std::remove(path.c_str());
        const auto now = [] {
            return 1'700'000'000'000'000'000ULL;
        };
        {
            FakeT7Device::Options o;
            o.unit = std::make_shared<fsw::t7::FakeT7Unit>(path);
            T7Session a(stream_board(), std::make_unique<FakeT7Device>(o), board_clock, now);
            a.start();
        }  // process 1 killed
        FakeT7Device::Options o;
        o.unit = std::make_shared<fsw::t7::FakeT7Unit>(path);
        check(o.unit->streaming && o.unit->scan_names.size() == 3,
              "a state file carries the running stream to the next process");
        T7Session b(stream_board(), std::make_unique<FakeT7Device>(o), board_clock, now);
        b.start();
        check(b.stopped_leftover_stream() && b.read().samples.size() == 15,
              "which stops it and streams");
        b.stop();
        check(!fsw::t7::FakeT7Unit(path).streaming, "and a clean stop is saved too");
        std::remove(path.c_str());
    }

    std::cout << "=== cold junction ===" << std::endl;
    {
        // The bridge publishes raw volts only; what it alone can add is each scan's cold
        // junction, which calibration_service needs to turn TC volts into temperature.
        FakeT7Device::Options o;
        o.device_temp_k = 300.0;  // board cjc_offset_k -4.9 -> junction at 21.95 C
        o.signal = [](int ain, double) {
            return ain == 1 ? 1.25 : 0.001;
        };
        auto dev = std::make_unique<FakeT7Device>(o);
        FakeT7Device* d = dev.get();
        uint64_t now = 1'700'000'000'000'000'000ULL;
        T7Session s(good_board(), std::move(dev), board_clock, [&] {
            return now;
        });
        s.start();
        check(d->reads == std::vector<std::string>({"TEMPERATURE_DEVICE_K", "AIN14"}),
              "a TC board reads TEMPERATURE_DEVICE_K beside AIN14 before streaming");
        check(near(s.cjc_device_offset_k(), 465.129215, 1e-6),
              "and solves AIN14's offset from them (the fake sits on LabJack's nominal line)");
        now += 50'000'000ULL;
        const auto b = s.read();
        check(b.samples.size() == 20, "5 scans x (3 AINs + AIN14), all raw volts");
        check(b.cold_junction.size() == 5, "one cold-junction reading per scan");
        bool cj_ok = true;
        for (size_t k = 0; k < b.cold_junction.size(); ++k)
            cj_ok = cj_ok && near(b.cold_junction[k].temp_c, 300.0 - 273.15 - 4.9, 1e-4) &&
                    b.cold_junction[k].timestamp_ns == b.samples[k * 4].timestamp_ns &&
                    b.cold_junction[k].sample_ms == b.samples[k * 4].sample_ms;
        check(cj_ok,
              "at the terminals' temperature (device + cjc_offset_k), stamped like its scan");
        check(near(b.samples[0].volts, 1.25, 1e-6),
              "the PT is published as its volts, unconverted");
    }
    {
        T7Session s(stream_board(), std::make_unique<FakeT7Device>(), board_clock, [] {
            return 1'700'000'000'000'000'000ULL;
        });
        s.start();
        check(s.read().cold_junction.empty(), "a board with no TC publishes no cold junction");
    }

    std::cout << "=== calibration map ===" << std::endl;
    {
        const Config c = fsw::config::load_from_string(kGood);
        const fsw::t7::T7CalibrationMap m(c);
        check(m.all().size() == 3, "every PT / TC / LC input on an enabled T7");
        const auto* pt = m.by_uid(8101);
        check(pt != nullptr && pt->channel.kind == "PT" && pt->board_key == "labjack_1" &&
                  pt->slot == 1 && pt->logical_ch == 129,
              "uid board_id*100+ain; logical channel 128 + (slot-1)*16 + ain");
        check(m.by_table(1, 4) == m.by_uid(8104) && m.by_table(1, 4)->channel.kind == "LC",
              "lookup by raw table (slot, ain) finds the same input");
        check(m.by_table(1, 14) == nullptr, "AIN14 (CJC) is not a calibrated input");
        const auto raw_list = m.raw_tables();
        std::set<std::pair<uint8_t, uint8_t>> raw(raw_list.begin(), raw_list.end());
        check(raw == std::set<std::pair<uint8_t, uint8_t>>(
                         {{0x26, 0x01}, {0x26, 0x02}, {0x26, 0x04}, {0x26, 0x0F}}),
              "subscribes each input's raw table, plus the TC board's cold junction (0x0F)");
        check(fsw::t7::t7_logical_channel(8, 15) == 255 && fsw::t7::t7_logical_channel(1, 0) == 128,
              "T7 logical channels span 128-255, clear of the ESP32 boards' 1-80");
        check(fsw::t7::t7_counts(1.25) == 1250000 && fsw::t7::t7_counts(-0.0000014) == -1 &&
                  fsw::t7::t7_counts(1e9) == INT32_MAX,
              "the calibration code is microvolts, rounded and clamped");
    }
    {
        Config c = fsw::config::load_from_string(kGood);
        c.t7_errors.push_back("[boards.labjack_1] something");
        check(fsw::t7::T7CalibrationMap(c).empty(),
              "a T7 config the bridge refuses calibrates nothing (it is not streaming)");
        T7Board off = good_board();
        Config c2;
        off.enabled = false;
        c2.t7_boards.push_back(off);
        check(fsw::t7::T7CalibrationMap(c2).empty(), "nor does a disabled T7");
    }
    {
        FakeT7Device::Options o;
        o.device_temp_k = 150.0;  // a broken internal sensor
        T7Session s(good_board(), std::make_unique<FakeT7Device>(o), board_clock, [] {
            return uint64_t{0};
        });
        bool threw = false;
        try {
            s.start();
        } catch (const T7Error&) {
            threw = true;
        }
        check(threw, "an implausible device temperature stops the start (no wrong CJC)");
        s.stop();
    }

    std::cout << (g_failures ? "FAILED: " : "PASSED")
              << (g_failures ? std::to_string(g_failures) : "") << std::endl;
    return g_failures ? 1 : 0;
}
