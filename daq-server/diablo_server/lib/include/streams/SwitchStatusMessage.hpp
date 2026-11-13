#pragma once

#include <cstdint>
#include <cstring>

#include "DiabloPackets.h"
#include "SwitchStatus.h"
#include "comms/CommsMessage.hpp"

namespace fsw {
namespace streams {

// Elodin [0x27, role], entity SW<role>: one Bluetooth switch as the environmental board relays it.
// The switch's raw status is decoded here into plain fields (the run log); what they *mean*
// (armed and live, stuck on...) is decided on the Switches page from these same fields.
//
//   0  u64 timestamp_ns   8 u8 link (1 = up)   9 i8 rssi (dBm, 0 unknown)   10 u16 age_ms
//  12  u32 config_hash   16 u8 status_valid (a StatusPacket of a version this build reads)
//  17  u8 output   18 u8 sense   19 u8 flags   20 u16 supply_mV   22 i16 current_mA
//  24  u16 power_mW   26 u16 sense_mV   28 u32 uptime_s   32 u8 reset_reason
//  33  u8 status_version (as received, also when not valid)
using SwitchStatusMessage =
    comms::CommsMessage<uint64_t, uint8_t, int8_t, uint16_t, uint32_t, uint8_t, uint8_t, uint8_t,
                        uint8_t, uint16_t, int16_t, uint16_t, uint16_t, uint32_t, uint8_t, uint8_t>;
static_assert(SwitchStatusMessage::nbytes() == 34);

inline SwitchStatusMessage make_switch_status_message(const daq::SwitchStatusReport& r,
                                                      uint64_t timestamp_ns) {
    using daq::bt_switch::StatusPacket;
    StatusPacket st{};
    const bool valid = r.status_len >= sizeof(StatusPacket) &&
                       r.status[0] == daq::bt_switch::STATUS_VERSION;
    if (valid)
        std::memcpy(&st, r.status, sizeof st);
    return SwitchStatusMessage(timestamp_ns, static_cast<uint8_t>(r.link), r.rssi, r.age_ms,
                               r.config_hash, valid ? 1 : 0, st.output, st.sense, st.flags,
                               st.supply_mV, st.current_mA, st.power_mW, st.sense_mV, st.uptime_s,
                               st.reset_reason, r.status_len ? r.status[0] : 0);
}

// Elodin [0x28, role], same entity SW<role>: what the env board did with an operator's command.
//   0 u64 timestamp_ns   8 u16 cmd_id   10 u8 cmd_output (as requested)   11 u8 cmd_result
//   (daq::SwitchCommandResult: 0 written, 1 no link, 2 write failed, 3 unknown role,
//    4 no config, 5 bad command)
using SwitchCommandResultMessage = comms::CommsMessage<uint64_t, uint16_t, uint8_t, uint8_t>;
static_assert(SwitchCommandResultMessage::nbytes() == 12);

inline SwitchCommandResultMessage make_switch_command_result_message(
    const daq::SwitchCommandResultPacket& r, uint64_t timestamp_ns) {
    return SwitchCommandResultMessage(timestamp_ns, r.command_id, r.output,
                                      static_cast<uint8_t>(r.result));
}

// Elodin [0x29, slot], entity SWSEEN<slot>: an unlisted switch heard by a "Find switches" scan.
//   0 u64 timestamp_ns   8 u64 mac (48 bits, most significant byte first as printed)   16 i8 rssi
using SwitchSeenMessage = comms::CommsMessage<uint64_t, uint64_t, int8_t>;
static_assert(SwitchSeenMessage::nbytes() == 17);

inline SwitchSeenMessage make_switch_seen_message(const daq::SwitchSeenPacket& s,
                                                  uint64_t timestamp_ns) {
    uint64_t mac = 0;
    for (uint8_t b : s.mac)
        mac = (mac << 8) | b;
    return SwitchSeenMessage(timestamp_ns, mac, s.rssi);
}

}  // namespace streams
}  // namespace fsw
