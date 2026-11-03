#include "config/T7Config.hpp"

#include <arpa/inet.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <toml++/toml.hpp>

namespace fsw {
namespace config {

int T7Board::effective_scans_per_read() const {
    if (scans_per_read > 0)
        return scans_per_read;
    // A 50 ms block: low enough latency for the GUI, few enough reads that LJM's per-call cost
    // does not matter.
    return std::max(1, static_cast<int>(scan_rate_hz / 20.0));
}

namespace detail {

namespace {

// The T7's analog input ranges (AIN#_RANGE accepts exactly these spans).
constexpr double kRanges[] = {10.0, 1.0, 0.1, 0.01};
const std::set<std::string> kKinds = {"PT", "TC", "LC", "VOLTAGE"};
const std::set<std::string> kTcTypes = {"B", "E", "J", "K", "N", "R", "S", "T"};

// Above this an aggregate rate is certainly beyond the T7 (its fastest stream is 100 kS/s at
// resolution index 0 and the widest range). The device reports STREAM_SCAN_OVERLAP for anything
// it cannot keep up with below this; this check only catches an obvious typo.
constexpr double kMaxAggregateSamplesPerS = 100000.0;

// Stream accepts resolution indices 0-8; the T7-Pro's 9-12 are command-response only.
constexpr int kMaxStreamResolutionIndex = 8;

bool is_ipv4(const std::string& s) {
    in_addr a{};
    return inet_pton(AF_INET, s.c_str(), &a) == 1;
}

std::string at(const std::string& section, int idx) {
    return "[" + section + "] channel " + std::to_string(idx + 1) + ": ";
}

}  // namespace

std::vector<T7Board> parse_t7_boards(const toml::table& root, std::vector<std::string>& errors) {
    std::vector<T7Board> out;
    const auto* boards = root["boards"].as_table();
    if (!boards)
        return out;

    std::map<uint8_t, std::string> slot_owner;
    for (auto&& [key, node] : *boards) {
        const auto* bt = node.as_table();
        if (!bt || (*bt)["type"].value<std::string>().value_or("") != "T7")
            continue;

        T7Board b;
        b.section = "boards." + std::string(key.str());
        const std::string& sec = b.section;
        auto err = [&](const std::string& m) {
            errors.push_back("[" + sec + "] " + m);
        };

        b.ip = (*bt)["ip"].value<std::string>().value_or("");
        b.mac = (*bt)["mac"].value<std::string>().value_or("");
        b.serial = (*bt)["serial"].value<int64_t>().value_or(0);
        b.enabled = (*bt)["enabled"].value<bool>().value_or(true);
        b.board_id = static_cast<int>((*bt)["board_id"].value<int64_t>().value_or(-1));
        b.scan_rate_hz = (*bt)["scan_rate_hz"].value<double>().value_or(b.scan_rate_hz);
        b.resolution_index =
            static_cast<int>((*bt)["resolution_index"].value<int64_t>().value_or(0));
        b.settling_us = (*bt)["settling_us"].value<double>().value_or(0.0);
        b.scans_per_read = static_cast<int>((*bt)["scans_per_read"].value<int64_t>().value_or(0));

        // A disabled board is allowed to be half-filled in (that is how a new one gets added:
        // declared, then its MAC learnt from the lease table), so only its shape is checked.
        if (b.board_id < 1 || b.board_id > 255)
            err("board_id must be an integer from 1 to 255");
        if (b.enabled) {
            if (b.ip.empty())
                err("ip is required");
            else if (!is_ipv4(b.ip))
                err("ip \"" + b.ip + "\" is not an IPv4 address");
        }
        if (!(b.scan_rate_hz > 0.0))
            err("scan_rate_hz must be positive");
        if (b.resolution_index < 0 || b.resolution_index > kMaxStreamResolutionIndex)
            err("resolution_index must be 0-" + std::to_string(kMaxStreamResolutionIndex) +
                " (stream does not support the T7-Pro's 9-12)");
        if (b.settling_us < 0.0)
            err("settling_us cannot be negative");
        if (b.scans_per_read < 0)
            err("scans_per_read cannot be negative");

        if (const auto* arr = (*bt)["channels"].as_array()) {
            std::map<int, int> ain_owner;  // AIN -> channel index that uses it (incl. diff pair)
            for (size_t i = 0; i < arr->size(); ++i) {
                const int idx = static_cast<int>(i);
                const auto* ct = (*arr)[i].as_table();
                if (!ct) {
                    err("channels must be a list of tables ([[" + sec + ".channels]])");
                    continue;
                }
                T7Channel c;
                const auto ain = (*ct)["ain"].value<int64_t>();
                c.ain = ain ? static_cast<int>(*ain) : -1;
                c.kind = (*ct)["kind"].value<std::string>().value_or("");
                c.role = (*ct)["role"].value<std::string>().value_or("");
                c.differential = (*ct)["differential"].value<bool>().value_or(false);
                c.tc_type = (*ct)["tc_type"].value<std::string>().value_or("");
                // A thermocouple is tens of millivolts: +/-0.1 V covers a type K to 1372 C,
                // where the 0.01 V range would clip a K above ~245 C.
                c.range_v = (*ct)["range"].value<double>().value_or(c.kind == "TC" ? 0.1 : 10.0);

                const std::string p = at(sec, idx);
                if (c.ain < 0 || c.ain > kT7MaxAin) {
                    errors.push_back(p + "ain must be 0-" + std::to_string(kT7MaxAin));
                } else {
                    auto claim = [&](int n) {
                        auto [it, inserted] = ain_owner.emplace(n, idx);
                        if (!inserted)
                            errors.push_back(p + "AIN" + std::to_string(n) +
                                             " is already used by channel " +
                                             std::to_string(it->second + 1));
                    };
                    claim(c.ain);
                    if (c.differential) {
                        if (c.ain % 2 != 0)
                            errors.push_back(p +
                                             "a differential input must be an even AIN "
                                             "(it pairs with the odd one above it)");
                        else
                            claim(c.ain + 1);
                    }
                }
                if (!kKinds.count(c.kind))
                    errors.push_back(p + "kind \"" + c.kind +
                                     "\" must be one of PT, TC, LC, VOLTAGE");
                if (std::none_of(std::begin(kRanges), std::end(kRanges), [&](double r) {
                        return std::fabs(r - c.range_v) < 1e-9;
                    }))
                    errors.push_back(p + "range must be one of 10, 1, 0.1, 0.01 (volts)");
                if (c.kind == "TC" && !kTcTypes.count(c.tc_type))
                    errors.push_back(p + "a thermocouple needs tc_type, one of B E J K N R S T");
                if (c.kind != "TC" && !c.tc_type.empty())
                    errors.push_back(p + "tc_type is only meaningful on kind = \"TC\"");
                b.channels.push_back(std::move(c));
            }
        } else if ((*bt).contains("channels")) {
            err("channels must be a list of tables ([[" + sec + ".channels]])");
        }

        if (b.enabled) {
            if (b.channels.empty())
                err("an enabled T7 needs at least one [[" + sec + ".channels]] entry");
            const double aggregate = b.scan_rate_hz * static_cast<double>(b.channels.size());
            if (aggregate > kMaxAggregateSamplesPerS)
                err("scan_rate_hz x channels = " + std::to_string(static_cast<int>(aggregate)) +
                    " samples/s, beyond the T7's 100000");
            if (b.board_id >= 1 && b.board_id <= 255) {
                auto [it, inserted] = slot_owner.emplace(b.slot(), sec);
                if (!inserted)
                    err("board_id " + std::to_string(b.board_id) + " shares Elodin slot " +
                        std::to_string(b.slot()) + " with [" + it->second +
                        "]; give T7s board_ids that differ mod 10");
                if (b.slot() > 8)
                    err("board_id " + std::to_string(b.board_id) + " maps to slot " +
                        std::to_string(b.slot()) + "; only slots 1-8 fit the table id");
            }
        }
        out.push_back(std::move(b));
    }
    return out;
}

}  // namespace detail
}  // namespace config
}  // namespace fsw
