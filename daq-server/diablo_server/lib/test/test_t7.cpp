/**
 * LabJack T7 support, without a T7: the [boards.*] type = "T7" config, what t7_bridge writes to
 * the device before streaming, and how a stream block becomes timestamped samples.
 *
 * The device is FakeT7Device, which records every call. Nothing here opens a socket.
 */
#include <cmath>
#include <iostream>
#include <memory>
#include <string>

#include "config/Config.hpp"
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

[[boards.labjack_1.channels]]
ain = 2
kind = "TC"
tc_type = "K"
role = "Nozzle"

[[boards.labjack_1.channels]]
ain = 4
kind = "LC"
differential = true
range = 0.1
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
        {t7(ch(1, "TC")), "needs tc_type", "a thermocouple with no type"},
        {t7(ch(1, "TC", "tc_type = \"Q\"")), "needs tc_type",
         "a thermocouple type that is not one"},
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

    std::cout << "=== stream plan ===" << std::endl;
    {
        const auto p = fsw::t7::plan_stream(good_board());
        check(p.scan_names == std::vector<std::string>({"AIN1", "AIN2", "AIN4"}),
              "scan list is the configured AINs, in config order");
        check(p.scan_names.front().rfind("AIN", 0) == 0,
              "first scan entry is an AIN (auto-recovery marks gaps in the first channel)");
        auto value = [&](const std::string& n) -> double {
            for (size_t i = 0; i < p.setup_names.size(); ++i)
                if (p.setup_names[i] == n)
                    return p.setup_values[i];
            return std::nan("");
        };
        check(value("AIN1_RANGE") == 10.0 && value("AIN2_RANGE") == 0.1 &&
                  value("AIN4_RANGE") == 0.1,
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
    }

    std::cout << "=== session ===" << std::endl;
    const fsw::time::TimeSyncConfig board_clock;  // default mode BoardClock
    {
        auto dev = std::make_unique<FakeT7Device>();
        FakeT7Device* d = dev.get();
        uint64_t now = 1'700'000'000'000'000'000ULL;
        T7Session s(good_board(), std::move(dev), board_clock, [&] {
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
        T7Session s(good_board(), std::make_unique<FakeT7Device>(o), board_clock, [&] {
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
        T7Board b = good_board();
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
        T7Session s(good_board(), std::make_unique<FakeT7Device>(o), board_clock, [&] {
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
        T7Session s(good_board(), std::make_unique<FakeT7Device>(), arrival, [&] {
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
        T7Board b = good_board();
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
        FakeT7Device::Options o;
        o.fail_read_after = 1;
        auto dev = std::make_unique<FakeT7Device>(o);
        FakeT7Device* d = dev.get();
        T7Session s(good_board(), std::move(dev), board_clock, [] {
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

    std::cout << (g_failures ? "FAILED: " : "PASSED")
              << (g_failures ? std::to_string(g_failures) : "") << std::endl;
    return g_failures ? 1 : 0;
}
