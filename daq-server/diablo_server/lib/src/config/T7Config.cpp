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
const std::set<std::string> kKinds = {"PT", "TC", "LC", "RTD", "VOLTAGE"};
// Thermocouple types t7_bridge can convert to temperature. Only K so far: its curve is the
// NIST ITS-90 inverse the calibration service already uses (fsw::calibration::type_k_*).
const std::set<std::string> kTcTypes = {"K"};
const std::set<std::string> kPtSignals = {"0-5V", "0.5-4.5V", "1-5V", "0-10V", "4-20mA"};

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
    std::map<std::string, std::string> role_owner;  // across every T7: the GUI keys by role
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
        b.cjc_offset_k = (*bt)["cjc_offset_k"].value<double>().value_or(b.cjc_offset_k);

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

        if (!std::isfinite(b.cjc_offset_k) || std::fabs(b.cjc_offset_k) > 20.0)
            err("cjc_offset_k must be within +/-20 K");

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
                c.full_scale = (*ct)["full_scale"].value<double>().value_or(0.0);
                c.signal = (*ct)["signal"].value<std::string>().value_or("");
                c.shunt_ohms = (*ct)["shunt_ohms"].value<double>().value_or(0.0);
                c.sensitivity_mv_per_v =
                    (*ct)["sensitivity_mv_per_v"].value<double>().value_or(0.0);
                c.excitation_v = (*ct)["excitation_v"].value<double>().value_or(0.0);
                c.r0_ohms = (*ct)["r0_ohms"].value<double>().value_or(0.0);
                c.ljtr_ohms = (*ct)["ljtr_ohms"].value<double>().value_or(0.0);
                const auto vref = (*ct)["vref_v"].value<double>();
                c.vref_v = vref.value_or(2.5);

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
                                     "\" must be one of PT, TC, LC, RTD, VOLTAGE");
                if (std::none_of(std::begin(kRanges), std::end(kRanges), [&](double r) {
                        return std::fabs(r - c.range_v) < 1e-9;
                    }))
                    errors.push_back(p + "range must be one of 10, 1, 0.1, 0.01 (volts)");
                if (c.kind == "TC" && !kTcTypes.count(c.tc_type))
                    errors.push_back(p + "tc_type \"" + c.tc_type +
                                     "\": only type K thermocouples are converted so far");
                if (c.kind != "TC" && !c.tc_type.empty())
                    errors.push_back(p + "tc_type is only meaningful on kind = \"TC\"");

                // The GUI lists a T7 channel by its role, like any PT/TC/LC.
                if (c.kind != "VOLTAGE") {
                    if (c.role.empty())
                        errors.push_back(p + "a " + c.kind + " channel needs a role (its name)");
                    else if (!role_owner.emplace(c.role, sec).second)
                        errors.push_back(p + "role \"" + c.role + "\" is already used by [" +
                                         role_owner[c.role] + "]");
                }
                auto need = [&](bool ok, const std::string& what) {
                    if (!ok)
                        errors.push_back(p + what);
                };
                if (c.kind == "PT") {
                    need(c.full_scale > 0, "a PT needs full_scale (psi at full output)");
                    need(kPtSignals.count(c.signal) > 0,
                         "a PT needs signal, one of 0-5V 0.5-4.5V 1-5V 0-10V 4-20mA");
                    if (c.signal == "4-20mA")
                        need(c.shunt_ohms > 0, "a 4-20mA PT needs shunt_ohms");
                    else
                        need(c.shunt_ohms == 0, "shunt_ohms is only meaningful on a 4-20mA PT");
                }
                if (c.kind == "LC") {
                    need(c.full_scale > 0, "an LC needs full_scale (kg at rated output)");
                    need(c.sensitivity_mv_per_v > 0, "an LC needs sensitivity_mv_per_v");
                    need(c.excitation_v > 0, "an LC needs excitation_v");
                }
                if (c.kind == "RTD") {
                    need(c.r0_ohms > 0,
                         "an RTD needs r0_ohms (100 for a Pt100, 1000 for a Pt1000)");
                    need(c.ljtr_ohms > 0,
                         "an RTD needs ljtr_ohms (the LJTick-Resistance's fixed resistor)");
                    need(c.vref_v > 0 && c.vref_v <= 10.0, "vref_v must be within (0, 10] V");
                    need(c.range_v >= c.vref_v, "an RTD's range must cover vref_v (use 10)");
                } else {
                    need(c.r0_ohms == 0 && c.ljtr_ohms == 0 && !vref,
                         "r0_ohms, ljtr_ohms and vref_v are only meaningful on an RTD");
                }
                if (c.kind != "PT")
                    need(c.signal.empty() && c.shunt_ohms == 0,
                         "signal and shunt_ohms are only meaningful on a PT");
                if (c.kind != "LC")
                    need(c.sensitivity_mv_per_v == 0 && c.excitation_v == 0,
                         "sensitivity_mv_per_v and excitation_v are only meaningful on an LC");
                if (c.kind != "PT" && c.kind != "LC")
                    need(c.full_scale == 0, "full_scale is only meaningful on a PT or LC");
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
