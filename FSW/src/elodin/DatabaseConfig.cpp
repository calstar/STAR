#include "elodin/DatabaseConfig.hpp"

#include <iostream>
#include <map>
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

// ── Helper: register one raw-sensor VTable for a single channel ────────────
// All raw sensor messages share the same 21-byte layout:
//   u64 timestamp_ns | u8 channel_id | u8[3] pad | u32 raw_adc | u32 sample_ts | u8 status
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
//   u64 timestamp_ns | u8 channel_id | u8[3] pad | f32 calibrated_value | u32 raw_counts | u8 cal_status
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
// PUBLIC API — RAW VTables only (for daq_bridge)
// ════════════════════════════════════════════════════════════════════════════

bool DatabaseConfig::register_tables(ElodinClient& client,
                                     const std::map<int, std::string>* pt_channel_to_name,
                                     const std::map<int, std::string>* act_channel_to_name) {
    std::cout << "[DatabaseConfig] Registering RAW VTables (config-driven)..." << std::endl;
    int registered = 0;

    // ── PT Raw: only register channels that exist in config ────────────────
    if (pt_channel_to_name && !pt_channel_to_name->empty()) {
        for (const auto& [ch, name] : *pt_channel_to_name) {
            std::string entity = "PT." + name;
            uint64_t eid = 0x2000 + ch;
            if (register_raw_sensor_vtable(client, 0x20, ch, eid, entity, "raw_adc_counts"))
                registered++;
        }
    } else {
        std::cerr << "[DatabaseConfig] ⚠️  No PT sensor roles in config — no PT VTables registered"
                  << std::endl;
    }

    // ── Actuator Raw: only register channels that exist in config ──────────
    if (act_channel_to_name && !act_channel_to_name->empty()) {
        for (const auto& [ch, name] : *act_channel_to_name) {
            std::string entity = "ACT." + name;
            uint64_t eid = 0x3000 + ch;
            if (register_raw_sensor_vtable(client, 0x30, ch, eid, entity, "raw_adc_counts"))
                registered++;
        }
    } else {
        std::cerr
            << "[DatabaseConfig] ⚠️  No actuator roles in config — no ACT VTables registered"
            << std::endl;
    }

    // NOTE: TC, RTD, LC raw VTables are NOT registered here because no boards
    // of those types are currently in the config. When TC/RTD/LC boards are
    // added to config.toml, add their sensor_roles sections and parse them
    // in daq_bridge_main.cpp, then pass the maps here.

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " RAW VTables" << std::endl;
    return registered > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API — CALIBRATED VTables only (for calibration_service)
// ════════════════════════════════════════════════════════════════════════════

bool DatabaseConfig::register_calibrated_tables(
    ElodinClient& client, const std::map<int, std::string>* pt_channel_to_name) {
    std::cout << "[DatabaseConfig] Registering CALIBRATED VTables..." << std::endl;
    int registered = 0;

    // ── PT Calibrated: only register channels that exist in config ─────────
    if (pt_channel_to_name && !pt_channel_to_name->empty()) {
        for (const auto& [ch, name] : *pt_channel_to_name) {
            std::string entity = "PT_Cal." + name;
            uint64_t eid = 0x2010 + ch;
            if (register_calibrated_vtable(client, 0x20, ch, eid, entity, "pressure_psi",
                                           "raw_adc"))
                registered++;
        }
    }

    // NOTE: TC_Cal, RTD_Cal, LC_Cal will be added when those sensor types
    // are present in config. Same pattern as above.

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " CALIBRATED VTables"
              << std::endl;
    return registered > 0;
}

bool DatabaseConfig::register_tables_from_config(ElodinClient& client,
                                                 const std::string& /* config_path */) {
    return register_tables(client, nullptr, nullptr);
}

bool DatabaseConfig::register_non_sensor_tables(ElodinClient& /* client */) {
    // Placeholder for navigation, engine control, etc.
    return true;
}

}  // namespace elodin
}  // namespace fsw
