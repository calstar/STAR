#include "t7/T7Calibration.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>

#include "t7/T7Stream.hpp"

namespace fsw {
namespace t7 {

uint8_t t7_logical_channel(uint8_t slot, uint8_t ain) {
    return static_cast<uint8_t>(kT7LogicalBase + (slot - 1) * 16 + ain);
}

uint16_t t7_uid(int board_id, int ain) {
    return static_cast<uint16_t>(board_id * 100 + ain);
}

int32_t t7_counts(double volts) {
    const double uv = std::round(volts * 1e6);
    if (!std::isfinite(uv))
        return 0;
    return static_cast<int32_t>(
        std::clamp(uv, static_cast<double>(INT32_MIN), static_cast<double>(INT32_MAX)));
}

double t7_volts(double counts) {
    return counts / 1e6;
}

std::array<uint8_t, 2> cjc_table_id(uint8_t slot) {
    return {kTypeHi, static_cast<uint8_t>((slot - 1) * 0x20 + kCjcTableOffset)};
}

T7CalibrationMap::T7CalibrationMap(const config::Config& cfg) {
    if (!cfg.t7_errors.empty())
        return;
    for (const auto& b : cfg.t7_boards) {
        if (!b.enabled)
            continue;
        const std::string key =
            b.section.rfind("boards.", 0) == 0 ? b.section.substr(7) : b.section;
        for (const auto& c : b.channels) {
            if (c.kind != "PT" && c.kind != "LC" && c.kind != "TC" && c.kind != "RTD")
                continue;
            T7CalChannel t;
            t.board_key = key;
            t.board_id = b.board_id;
            t.slot = b.slot();
            t.channel = c;
            t.uid = t7_uid(b.board_id, c.ain);
            t.logical_ch = t7_logical_channel(t.slot, static_cast<uint8_t>(c.ain));
            by_uid_[t.uid] = channels_.size();
            by_table_[{t.slot, static_cast<uint8_t>(c.ain)}] = channels_.size();
            channels_.push_back(std::move(t));
        }
    }
}

const T7CalChannel* T7CalibrationMap::by_uid(uint16_t uid) const {
    auto it = by_uid_.find(uid);
    return it == by_uid_.end() ? nullptr : &channels_[it->second];
}

const T7CalChannel* T7CalibrationMap::by_table(uint8_t slot, uint8_t ain) const {
    auto it = by_table_.find({slot, ain});
    return it == by_table_.end() ? nullptr : &channels_[it->second];
}

std::vector<uint8_t> T7CalibrationMap::tc_slots() const {
    std::set<uint8_t> s;
    for (const auto& c : channels_)
        if (c.channel.kind == "TC")
            s.insert(c.slot);
    return {s.begin(), s.end()};
}

std::vector<std::pair<uint8_t, uint8_t>> T7CalibrationMap::raw_tables() const {
    std::vector<std::pair<uint8_t, uint8_t>> out;
    for (const auto& c : channels_) {
        const auto id = table_id(c.slot, static_cast<uint8_t>(c.channel.ain));
        out.emplace_back(id[0], id[1]);
    }
    for (uint8_t slot : tc_slots()) {
        const auto id = cjc_table_id(slot);
        out.emplace_back(id[0], id[1]);
    }
    return out;
}

}  // namespace t7
}  // namespace fsw
