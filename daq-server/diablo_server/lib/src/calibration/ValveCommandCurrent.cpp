#include "calibration/ValveCommandCurrent.hpp"

#include <cmath>
#include <fstream>
#include <nlohmann/json.hpp>
#include <regex>
#include <sstream>

#include "daq-protocol.h"

namespace fsw {
namespace calibration {
namespace valve_current {

namespace {
std::string fmt(double v) {
    std::ostringstream os;
    os.precision(4);
    os << v;
    return os.str();
}

uint16_t to_ua(double ma) {
    return static_cast<uint16_t>(std::lround(ma * 1000.0));
}
}  // namespace

std::string validate(const Currents& c) {
    for (const auto& [name, v] : {std::pair{"closed", c.closed_ma}, std::pair{"open", c.open_ma}}) {
        if (!std::isfinite(v) || v < kMinMa || v > kMaxMa)
            return std::string(name) + " current " + fmt(v) + " mA is outside " + fmt(kMinMa) +
                   "-" + fmt(kMaxMa) + " mA";
    }
    if (std::fabs(c.open_ma - c.closed_ma) < kMinSpanMa)
        return "closed " + fmt(c.closed_ma) + " mA and open " + fmt(c.open_ma) +
               " mA are less than " + fmt(kMinSpanMa) + " mA apart";
    return "";
}

std::string entity_for(int slot, int channel) {
    return "BV" + std::to_string(slot) + "_Cal.CH" + std::to_string(channel);
}

std::map<std::string, Currents> parse(const std::string& json_text,
                                      std::vector<std::string>* warnings) {
    std::map<std::string, Currents> out;
    auto warn = [&](const std::string& w) {
        if (warnings)
            warnings->push_back(w);
    };
    nlohmann::json root;
    try {
        root = nlohmann::json::parse(json_text);
    } catch (const std::exception& e) {
        warn(std::string("ball valve currents: unreadable JSON (") + e.what() + ")");
        return out;
    }
    if (!root.is_object() || !root.contains("valves") || !root["valves"].is_object())
        return out;

    static const std::regex kEntity(R"(^BV\d+_Cal\.CH\d+$)");
    for (const auto& [entity, v] : root["valves"].items()) {
        if (!std::regex_match(entity, kEntity)) {
            warn("ball valve currents: " + entity + " is not a ball valve channel, ignored");
            continue;
        }
        if (!v.is_object() || !v.contains("closed_ma") || !v.contains("open_ma") ||
            !v["closed_ma"].is_number() || !v["open_ma"].is_number()) {
            warn("ball valve currents: " + entity + " needs numeric closed_ma and open_ma, using " +
                 "4 / 20 mA");
            continue;
        }
        Currents c{v["closed_ma"].get<double>(), v["open_ma"].get<double>()};
        if (const std::string why = validate(c); !why.empty()) {
            warn("ball valve currents: " + entity + " " + why + ", using 4 / 20 mA");
            continue;
        }
        out[entity] = c;
    }
    return out;
}

std::map<std::string, Currents> load_file(const std::string& path,
                                          std::vector<std::string>* warnings) {
    std::ifstream f(path);
    if (!f.is_open())
        return {};
    std::stringstream ss;
    ss << f.rdbuf();
    return parse(ss.str(), warnings);
}

std::vector<daq::ValveCurrentEntry> entries_for_board(int slot, const std::vector<int>& channels,
                                                      const std::map<std::string, Currents>& store) {
    std::vector<daq::ValveCurrentEntry> out;
    for (int ch : channels) {
        if (ch < 1 || ch > 255)
            continue;
        if (out.size() >= MAX_ACTUATORS_PER_BOARD)
            break;
        const auto it = store.find(entity_for(slot, ch));
        const Currents c = (it != store.end()) ? it->second : Currents{};
        daq::ValveCurrentEntry e{};
        e.actuator_id = static_cast<uint8_t>(ch);
        e.closed_ua = to_ua(c.closed_ma);
        e.open_ua = to_ua(c.open_ma);
        out.push_back(e);
    }
    return out;
}

std::map<std::string, double> parse_trials(const std::string& json_text, int64_t now_epoch_ms,
                                           std::vector<std::string>* warnings) {
    std::map<std::string, double> out;
    auto warn = [&](const std::string& w) {
        if (warnings)
            warnings->push_back(w);
    };
    nlohmann::json root;
    try {
        root = nlohmann::json::parse(json_text);
    } catch (const std::exception& e) {
        warn(std::string("ball valve trials: unreadable JSON (") + e.what() + ")");
        return out;
    }
    if (!root.is_object() || !root.contains("valves") || !root["valves"].is_object())
        return out;
    static const std::regex kEntity(R"(^BV\d+_Cal\.CH\d+$)");
    for (const auto& [entity, v] : root["valves"].items()) {
        if (!std::regex_match(entity, kEntity) || !v.is_object() || !v.contains("ma") ||
            !v["ma"].is_number() || !v.contains("expires_at_ms") ||
            !v["expires_at_ms"].is_number()) {
            warn("ball valve trials: " + entity + " is not {ma, expires_at_ms} on a valve, ignored");
            continue;
        }
        const double ma = v["ma"].get<double>();
        if (!std::isfinite(ma) || ma < kMinMa || ma > kMaxMa) {
            warn("ball valve trials: " + entity + " " + fmt(ma) + " mA is outside " + fmt(kMinMa) +
                 "-" + fmt(kMaxMa) + " mA, ignored");
            continue;
        }
        if (v["expires_at_ms"].get<double>() <= static_cast<double>(now_epoch_ms))
            continue;  // over: not a problem, just not sent
        out[entity] = ma;
    }
    return out;
}

std::map<std::string, double> load_trials_file(const std::string& path, int64_t now_epoch_ms,
                                               std::vector<std::string>* warnings) {
    std::ifstream f(path);
    if (!f.is_open())
        return {};
    std::stringstream ss;
    ss << f.rdbuf();
    return parse_trials(ss.str(), now_epoch_ms, warnings);
}

std::vector<daq::ValveTestCurrentEntry> trial_entries_for_board(
    int slot, const std::vector<int>& channels, const std::map<std::string, double>& trials) {
    std::vector<daq::ValveTestCurrentEntry> out;
    for (int ch : channels) {
        if (ch < 1 || ch > 255)
            continue;
        if (out.size() >= MAX_ACTUATORS_PER_BOARD)
            break;
        const auto it = trials.find(entity_for(slot, ch));
        daq::ValveTestCurrentEntry e{};
        e.actuator_id = static_cast<uint8_t>(ch);
        e.ua = (it != trials.end()) ? to_ua(it->second) : 0;
        out.push_back(e);
    }
    return out;
}

}  // namespace valve_current
}  // namespace calibration
}  // namespace fsw
