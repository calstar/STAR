#include "SwitchRelay.h"

#include <string.h>

namespace {
bool same(const uint8_t a[6], const uint8_t b[6]) { return memcmp(a, b, 6) == 0; }
}  // namespace

SwitchRelay::Slot *SwitchRelay::find(const uint8_t mac[6]) {
    for (auto &s : slots_)
        if (s.listed && same(s.mac, mac)) return &s;
    return nullptr;
}

const SwitchRelay::Slot *SwitchRelay::find(const uint8_t mac[6]) const {
    for (const auto &s : slots_)
        if (s.listed && same(s.mac, mac)) return &s;
    return nullptr;
}

size_t SwitchRelay::applyConfig(const daq::SwitchConfig &config, uint32_t hash) {
    if (hasConfig_ && hash == hash_) return 0;

    Slot next[daq::MAX_SWITCHES];
    for (uint8_t i = 0; i < config.count && i < daq::MAX_SWITCHES; ++i) {
        const daq::SwitchConfigEntry &e = config.entries[i];
        if (e.role >= daq::MAX_SWITCHES) continue;
        Slot &s = next[e.role];
        if (const Slot *old = find(e.mac)) s = *old;  // keeps its link and status
        s.listed = true;
        memcpy(s.mac, e.mac, 6);
        s.fresh = true;  // report under the (possibly new) role at once
    }

    size_t nDropped = 0;
    for (const auto &old : slots_) {
        if (!old.listed) continue;
        bool kept = false;
        for (const auto &s : next)
            if (s.listed && same(s.mac, old.mac)) kept = true;
        if (!kept) memcpy(dropped_[nDropped++], old.mac, 6);
    }

    for (uint8_t r = 0; r < daq::MAX_SWITCHES; ++r) slots_[r] = next[r];
    hasConfig_ = true;
    hash_ = hash;
    return nDropped;
}

int SwitchRelay::roleFor(const uint8_t mac[6]) const {
    for (uint8_t r = 0; r < daq::MAX_SWITCHES; ++r)
        if (slots_[r].listed && same(slots_[r].mac, mac)) return r;
    return -1;
}

bool SwitchRelay::shouldConnect(const uint8_t mac[6]) const {
    const Slot *s = find(mac);
    return s && !s->up;
}

bool SwitchRelay::wantsScan() const {
    for (const auto &s : slots_)
        if (s.listed && !s.up) return true;
    return false;
}

const uint8_t *SwitchRelay::macFor(uint8_t role) const {
    return role < daq::MAX_SWITCHES && slots_[role].listed ? slots_[role].mac : nullptr;
}

bool SwitchRelay::connected(uint8_t role) const {
    return role < daq::MAX_SWITCHES && slots_[role].listed && slots_[role].up;
}

void SwitchRelay::onConnected(const uint8_t mac[6]) {
    if (Slot *s = find(mac)) {
        s->up = true;
        s->fresh = true;
    }
}

void SwitchRelay::onDisconnected(const uint8_t mac[6]) {
    if (Slot *s = find(mac)) {
        s->up = false;
        s->rssi = 0;
        s->fresh = true;
    }
}

void SwitchRelay::onRssi(const uint8_t mac[6], int8_t rssi) {
    if (Slot *s = find(mac)) s->rssi = rssi;
}

void SwitchRelay::onStatus(const uint8_t mac[6], const uint8_t *bytes, size_t len, uint32_t nowMs) {
    Slot *s = find(mac);
    if (!s) return;
    if (len > daq::MAX_SWITCH_STATUS_BYTES) len = daq::MAX_SWITCH_STATUS_BYTES;
    memcpy(s->status, bytes, len);
    s->statusLen = static_cast<uint8_t>(len);
    s->haveStatus = true;
    s->statusAtMs = nowMs;
    s->fresh = true;
}

size_t SwitchRelay::collectReports(uint32_t nowMs, daq::SwitchStatusReport *out, size_t max) {
    size_t n = 0;
    for (uint8_t r = 0; r < daq::MAX_SWITCHES && n < max; ++r) {
        Slot &s = slots_[r];
        if (!s.listed) continue;
        const bool due = s.fresh || !s.everReported || nowMs - s.reportedAtMs >= REPORT_PERIOD_MS;
        if (!due) continue;

        daq::SwitchStatusReport &rep = out[n++];
        rep = daq::SwitchStatusReport{};
        rep.role = r;
        rep.link = s.up ? daq::SwitchLink::UP : daq::SwitchLink::DOWN;
        rep.rssi = s.rssi;
        rep.config_hash = hash_;
        if (s.haveStatus) {
            const uint32_t age = nowMs - s.statusAtMs;
            rep.age_ms = age > 0xFFFE ? 0xFFFE : static_cast<uint16_t>(age);
            rep.status_len = s.statusLen;
            memcpy(rep.status, s.status, s.statusLen);
        }
        s.fresh = false;
        s.everReported = true;
        s.reportedAtMs = nowMs;
    }
    return n;
}

void SwitchRelay::result(const daq::SwitchCommandPacket &cmd, daq::SwitchCommandResult r) {
    if (nResults_ == sizeof results_ / sizeof results_[0]) {  // DAQ not draining: drop the oldest
        memmove(results_, results_ + 1, (nResults_ - 1) * sizeof results_[0]);
        --nResults_;
    }
    results_[nResults_++] = daq::SwitchCommandResultPacket{cmd.command_id, cmd.role, cmd.output, r};
}

void SwitchRelay::submitCommand(const daq::SwitchCommandPacket &cmd) {
    using R = daq::SwitchCommandResult;
    if (cmd.output > 1) return result(cmd, R::BAD_COMMAND);
    if (!hasConfig_) return result(cmd, R::NO_CONFIG);
    if (cmd.role >= daq::MAX_SWITCHES || !slots_[cmd.role].listed) return result(cmd, R::UNKNOWN_ROLE);
    if (!slots_[cmd.role].up) return result(cmd, R::NO_LINK);
    if (queued_ == MAX_QUEUED) return result(cmd, R::BAD_COMMAND);
    queue_[queued_].cmd = cmd;
    memcpy(queue_[queued_].mac, slots_[cmd.role].mac, 6);
    ++queued_;
}

bool SwitchRelay::takeCommand(daq::SwitchCommandPacket &cmd, uint8_t mac[6]) {
    while (queued_ > 0) {
        Queued q = queue_[0];
        memmove(queue_, queue_ + 1, (queued_ - 1) * sizeof queue_[0]);
        --queued_;
        // Still the same switch under that role? A new list may have moved or dropped it.
        const Slot &s = slots_[q.cmd.role];
        if (!s.listed || !same(s.mac, q.mac)) {
            result(q.cmd, daq::SwitchCommandResult::UNKNOWN_ROLE);
            continue;
        }
        if (!s.up) {
            result(q.cmd, daq::SwitchCommandResult::NO_LINK);
            continue;
        }
        cmd = q.cmd;
        memcpy(mac, q.mac, 6);
        return true;
    }
    return false;
}

void SwitchRelay::finishCommand(const daq::SwitchCommandPacket &cmd, bool written) {
    result(cmd, written ? daq::SwitchCommandResult::WRITTEN : daq::SwitchCommandResult::WRITE_FAILED);
}

size_t SwitchRelay::collectResults(daq::SwitchCommandResultPacket *out, size_t max) {
    size_t n = nResults_ < max ? nResults_ : max;
    memcpy(out, results_, n * sizeof results_[0]);
    memmove(results_, results_ + n, (nResults_ - n) * sizeof results_[0]);
    nResults_ -= n;
    return n;
}
