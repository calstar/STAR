// SWITCH_STATUS -> the Elodin row the bridge logs (streams/SwitchStatusMessage.hpp).
#include <cstring>
#include <iostream>

#include "streams/SwitchStatusMessage.hpp"

using daq::bt_switch::StatusPacket;

static int failures = 0;
static void require(bool ok, const char* what) {
    if (!ok) {
        std::cerr << "FAIL: " << what << "\n";
        ++failures;
    }
}

int main() {
    StatusPacket st{};
    st.version = daq::bt_switch::STATUS_VERSION;
    st.output = 1;
    st.sense = 3;
    st.flags = daq::bt_switch::FLAG_INA_OK | daq::bt_switch::FLAG_READING_VALID;
    st.supply_mV = 8412;
    st.current_mA = -123;
    st.power_mW = 1035;
    st.sense_mV = 2471;
    st.uptime_s = 0x01020304;
    st.reset_reason = 9;

    daq::SwitchStatusReport r;
    r.role = 2;
    r.link = daq::SwitchLink::UP;
    r.rssi = -67;
    r.age_ms = 420;
    r.config_hash = 0xCAFEF00D;
    r.status_len = sizeof st;
    std::memcpy(r.status, &st, sizeof st);

    auto m = fsw::streams::make_switch_status_message(r, 123456789ULL);
    uint8_t row[fsw::streams::SwitchStatusMessage::nbytes()];
    m.serialize(row);
    auto u16 = [&](int o) { uint16_t v; std::memcpy(&v, row + o, 2); return v; };
    auto u32 = [&](int o) { uint32_t v; std::memcpy(&v, row + o, 4); return v; };
    int16_t cur;
    std::memcpy(&cur, row + 22, 2);
    uint64_t ts;
    std::memcpy(&ts, row, 8);

    require(ts == 123456789ULL, "timestamp");
    require(row[8] == 1 && static_cast<int8_t>(row[9]) == -67, "link and rssi");
    require(u16(10) == 420 && u32(12) == 0xCAFEF00D, "age and config hash");
    require(row[16] == 1, "status valid");
    require(row[17] == 1 && row[18] == 3 && row[19] == 3, "output, sense, flags");
    require(u16(20) == 8412 && cur == -123 && u16(24) == 1035 && u16(26) == 2471,
            "supply, current, power, sense mV");
    require(u32(28) == 0x01020304 && row[32] == 9 && row[33] == 1, "uptime, reset, version");

    // A status of a version this build can't read: logged as not valid, fields zero.
    r.status[0] = 2;
    m = fsw::streams::make_switch_status_message(r, 0);
    m.serialize(row);
    require(row[16] == 0 && row[17] == 0 && row[33] == 2, "unknown version not decoded");

    // Link down before any status arrived.
    daq::SwitchStatusReport none;
    m = fsw::streams::make_switch_status_message(none, 0);
    m.serialize(row);
    require(row[8] == 0 && row[16] == 0 && u16(10) == 0xFFFF, "no status yet");

    {  // "Find switches" row: the MAC packs most significant byte first, as printed
        daq::SwitchSeenPacket seen{3, {0x58, 0xCF, 0x79, 0x01, 0xAB, 0xCD}, -80};
        auto sm = fsw::streams::make_switch_seen_message(seen, 5);
        uint8_t srow[fsw::streams::SwitchSeenMessage::nbytes()];
        sm.serialize(srow);
        uint64_t mac;
        std::memcpy(&mac, srow + 8, 8);
        require(mac == 0x58CF7901ABCDULL, "seen MAC");
        require(static_cast<int8_t>(srow[16]) == -80, "seen rssi");
    }
    if (failures) {
        std::cerr << failures << " failure(s)\n";
        return 1;
    }
    std::cout << "Switch status message passed\n";
}
