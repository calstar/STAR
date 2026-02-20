#include "elodin/DatabaseConfig.hpp"

#include <iostream>
#include <string>

#include "db.hpp"  // utl/db.hpp — VTable builder, Msg, postcard encoding

using namespace vtable;
using namespace vtable::builder;

namespace fsw {
namespace elodin {

// ── Helper: encode a db.hpp message and send via ElodinClient ──────────────
template <typename T>
static bool send_msg(ElodinClient& client, T msg) {
    auto buf = Msg(msg).encode_vec();
    if (buf.empty()) {
        std::cerr << "[DatabaseConfig] Failed to encode message" << std::endl;
        return false;
    }
    return client.send_msg({0, 0}, buf);  // packet_id unused — already in buf
}

// ── Sensor role names (from config.toml [sensor_roles]) ────────────────────
// Index = 1-based channel_id.  0 = unused.
static const char* PT_NAMES[] = {
    "",                 // 0 (unused)
    "Fuel_Upstream",    // 1
    "GSE_Low",          // 2
    "GSE_Mid",          // 3
    "Fuel_Downstream",  // 4
    "Ox_Upstream",      // 5
    "GN2_Regulated",    // 6
    "Ox_Downstream",    // 7
    "PT_CH8",           // 8
    "PT_CH9",           // 9
    "PT_CH10",          // 10
};
static constexpr int NUM_PT = 10;

static const char* ACT_NAMES[] = {
    "",                 // 0 (unused)
    "LOX_Main",         // 1
    "Fuel_Vent",        // 2
    "Fuel_Press",       // 3
    "ACT_CH4",          // 4
    "GSE_Low_Vent",     // 5
    "LOX_Vent",         // 6
    "Fuel_Main",        // 7
    "LOX_Press",        // 8
    "Fuel_Fill_Vent",   // 9
    "Fuel_Fill_Press",  // 10
};
static constexpr int NUM_ACT = 10;

static constexpr int NUM_TC = 4;   // future TC channels
static constexpr int NUM_RTD = 4;  // future RTD channels
static constexpr int NUM_LC = 4;   // future LC channels

// ── Helper: register one raw-sensor VTable for a single channel ────────────
// All raw sensor messages share the same 21-byte layout:
//   u64 timestamp_ns | u8 channel_id | u8[3] pad | u32 raw_adc | u32 sample_ts | u8 status
// The only difference is the packet_id, entity_id, and names.
static bool register_raw_sensor_vtable(
    ElodinClient& client,
    uint8_t type_hi,     // high byte of packet_id (0x20=PT, 0x21=TC, 0x22=RTD, 0x23=LC, 0x30=ACT)
    uint8_t channel_id,  // low byte of packet_id (1-based channel)
    uint64_t entity_id,  // unique entity id for set_entity_name
    const std::string& entity_name,    // human-readable name
    const std::string& adc_field_name  // "raw_adc_counts" or "raw_resistance_counts"
) {
    std::string prefix = entity_name + ".";

    auto vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component(prefix + "timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component(prefix + "channel_id"))),
        // 3 bytes padding at offset 9 — skip
        raw_field(12, 4, schema(PrimType::U32(), {}, component(prefix + adc_field_name))),
        raw_field(16, 4, schema(PrimType::U32(), {}, component(prefix + "sample_ts_ms"))),
        raw_field(20, 1, schema(PrimType::U8(), {}, component(prefix + "status"))),
    });

    if (!send_msg(client, VTableMsg{.id = {type_hi, channel_id}, .vtable = vt})) {
        std::cerr << "[DatabaseConfig] ❌ VTable failed: " << entity_name << std::endl;
        return false;
    }

    // Name the per-field components
    send_msg(client, set_component_name(prefix + "timestamp_ns"));
    send_msg(client, set_component_name(prefix + "channel_id"));
    send_msg(client, set_component_name(prefix + adc_field_name));
    send_msg(client, set_component_name(prefix + "sample_ts_ms"));
    send_msg(client, set_component_name(prefix + "status"));

    // Name the entity
    send_msg(client, set_entity_name(entity_id, entity_name));

    return true;
}

// ── Helper: register one calibrated-sensor VTable for a single channel ─────
// All calibrated messages share the same 21-byte layout:
//   u64 timestamp_ns | u8 channel_id | u8[3] pad | f32 calibrated_value | u32 raw_counts | u8
//   cal_status
// Difference: packet_id, entity name, calibrated value field name.
static bool register_calibrated_vtable(
    ElodinClient& client,
    uint8_t type_hi,     // high byte (0x20=PT, 0x21=TC, 0x22=RTD, 0x23=LC)
    uint8_t channel_id,  // 1-based
    uint64_t entity_id, const std::string& entity_name,
    const std::string& cal_field_name,  // "pressure_psi", "temperature_c", "force_lbf"
    const std::string& raw_field_name   // "raw_adc", "raw_resistance"
) {
    std::string prefix = entity_name + ".";

    auto vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component(prefix + "timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component(prefix + "channel_id"))),
        // 3 bytes padding at offset 9 — skip
        raw_field(12, 4, schema(PrimType::F32(), {}, component(prefix + cal_field_name))),
        raw_field(16, 4, schema(PrimType::U32(), {}, component(prefix + raw_field_name))),
        raw_field(20, 1, schema(PrimType::U8(), {}, component(prefix + "cal_status"))),
    });

    uint8_t lo = static_cast<uint8_t>(0x10 + channel_id);
    if (!send_msg(client, VTableMsg{.id = {type_hi, lo}, .vtable = vt})) {
        std::cerr << "[DatabaseConfig] ❌ Calibrated VTable failed: " << entity_name << std::endl;
        return false;
    }

    send_msg(client, set_component_name(prefix + "timestamp_ns"));
    send_msg(client, set_component_name(prefix + "channel_id"));
    send_msg(client, set_component_name(prefix + cal_field_name));
    send_msg(client, set_component_name(prefix + raw_field_name));
    send_msg(client, set_component_name(prefix + "cal_status"));
    send_msg(client, set_entity_name(entity_id, entity_name));

    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

bool DatabaseConfig::register_tables(ElodinClient& client) {
    std::cout << "[DatabaseConfig] Registering per-channel VTables..." << std::endl;
    int registered = 0;

    // ── PT Raw (packet_id 0x20, ch) ───────────────────────────────────────
    for (int ch = 1; ch <= NUM_PT; ++ch) {
        std::string name = (ch <= NUM_PT && PT_NAMES[ch][0] != '\0')
                               ? std::string("PT.") + PT_NAMES[ch]
                               : "PT.CH" + std::to_string(ch);
        uint64_t eid = 0x2000 + ch;
        if (register_raw_sensor_vtable(client, 0x20, ch, eid, name, "raw_adc_counts"))
            registered++;
    }

    // ── PT Calibrated (packet_id 0x20, 0x10+ch) ──────────────────────────
    for (int ch = 1; ch <= NUM_PT; ++ch) {
        std::string name = (ch <= NUM_PT && PT_NAMES[ch][0] != '\0')
                               ? std::string("PT_Cal.") + PT_NAMES[ch]
                               : "PT_Cal.CH" + std::to_string(ch);
        uint64_t eid = 0x2010 + ch;
        if (register_calibrated_vtable(client, 0x20, ch, eid, name, "pressure_psi", "raw_adc"))
            registered++;
    }

    // ── Actuator Status (packet_id 0x30, ch) ─────────────────────────────
    for (int ch = 1; ch <= NUM_ACT; ++ch) {
        std::string name = (ch <= NUM_ACT && ACT_NAMES[ch][0] != '\0')
                               ? std::string("ACT.") + ACT_NAMES[ch]
                               : "ACT.CH" + std::to_string(ch);
        uint64_t eid = 0x3000 + ch;
        if (register_raw_sensor_vtable(client, 0x30, ch, eid, name, "raw_adc_counts"))
            registered++;
    }

    // ── TC Raw (packet_id 0x21, ch) ──────────────────────────────────────
    for (int ch = 1; ch <= NUM_TC; ++ch) {
        std::string name = "TC.CH" + std::to_string(ch);
        uint64_t eid = 0x2100 + ch;
        if (register_raw_sensor_vtable(client, 0x21, ch, eid, name, "raw_adc_counts"))
            registered++;
    }
    // ── TC Calibrated (packet_id 0x21, 0x10+ch) ─────────────────────────
    for (int ch = 1; ch <= NUM_TC; ++ch) {
        std::string name = "TC_Cal.CH" + std::to_string(ch);
        uint64_t eid = 0x2110 + ch;
        if (register_calibrated_vtable(client, 0x21, ch, eid, name, "temperature_c", "raw_adc"))
            registered++;
    }

    // ── RTD Raw (packet_id 0x22, ch) ─────────────────────────────────────
    for (int ch = 1; ch <= NUM_RTD; ++ch) {
        std::string name = "RTD.CH" + std::to_string(ch);
        uint64_t eid = 0x2200 + ch;
        if (register_raw_sensor_vtable(client, 0x22, ch, eid, name, "raw_resistance"))
            registered++;
    }
    // ── RTD Calibrated (packet_id 0x22, 0x10+ch) ────────────────────────
    for (int ch = 1; ch <= NUM_RTD; ++ch) {
        std::string name = "RTD_Cal.CH" + std::to_string(ch);
        uint64_t eid = 0x2210 + ch;
        if (register_calibrated_vtable(client, 0x22, ch, eid, name, "temperature_c",
                                       "raw_resistance"))
            registered++;
    }

    // ── LC Raw (packet_id 0x23, ch) ──────────────────────────────────────
    for (int ch = 1; ch <= NUM_LC; ++ch) {
        std::string name = "LC.CH" + std::to_string(ch);
        uint64_t eid = 0x2300 + ch;
        if (register_raw_sensor_vtable(client, 0x23, ch, eid, name, "raw_adc_counts"))
            registered++;
    }
    // ── LC Calibrated (packet_id 0x23, 0x10+ch) ─────────────────────────
    for (int ch = 1; ch <= NUM_LC; ++ch) {
        std::string name = "LC_Cal.CH" + std::to_string(ch);
        uint64_t eid = 0x2310 + ch;
        if (register_calibrated_vtable(client, 0x23, ch, eid, name, "force_lbf", "raw_adc"))
            registered++;
    }

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " per-channel VTables"
              << std::endl;
    return registered > 0;
}

bool DatabaseConfig::register_tables_from_config(ElodinClient& client,
                                                 const std::string& /* config_path */) {
    return register_tables(client);
}

bool DatabaseConfig::register_non_sensor_tables(ElodinClient& /* client */) {
    // Placeholder for navigation, engine control, etc.
    return true;
}

}  // namespace elodin
}  // namespace fsw
