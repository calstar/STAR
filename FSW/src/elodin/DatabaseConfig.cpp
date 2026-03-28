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
//   u64 timestamp_ns | u8 channel_id | u8[3] pad | f32 calibrated_value | u32 raw_counts | u8
//   cal_status
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

// ── Helper: register actuator state VTable (0=closed, 1=open) ───────────────
// Layout: u64 timestamp_ns | u8 channel_id | u8 actuator_state (10 bytes)
static bool register_actuator_state_vtable(ElodinClient& client, uint8_t type_hi,
                                           uint8_t channel_id, uint64_t entity_id,
                                           const std::string& entity_name) {
    std::string prefix = entity_name + ".";

    auto vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component(prefix + "timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component(prefix + "channel_id"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, component(prefix + "actuator_state"))),
    });

    if (!send_msg(client, VTableMsg{.id = {type_hi, channel_id}, .vtable = vt})) {
        std::cerr << "[DatabaseConfig] ❌ Actuator state VTable failed: " << entity_name
                  << std::endl;
        return false;
    }

    send_msg(client, set_component_name(prefix + "timestamp_ns"));
    send_msg(client, set_component_name(prefix + "channel_id"));
    send_msg(client, set_component_name(prefix + "actuator_state"));
    send_msg(client, set_entity_name(entity_id, entity_name));

    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API — RAW VTables only (for daq_bridge)
// ════════════════════════════════════════════════════════════════════════════

bool DatabaseConfig::register_tables(ElodinClient& client,
                                     const std::vector<uint8_t>& pt_channels,
                                     const std::vector<uint8_t>& act_channels,
                                     const std::vector<uint8_t>& tc_channels,
                                     const std::vector<uint8_t>& rtd_channels,
                                     const std::vector<uint8_t>& lc_channels,
                                     const std::vector<uint8_t>& enc_channels) {
    std::cout << "[DatabaseConfig] Registering RAW VTables (generic channel names)..." << std::endl;
    int registered = 0;

    for (uint8_t ch : pt_channels) {
        std::string entity = "PT.CH" + std::to_string(ch);
        if (register_raw_sensor_vtable(client, 0x20, ch, 0x2000 + ch, entity, "raw_adc_counts"))
            registered++;
    }

    for (uint8_t ch : act_channels) {
        std::string entity = "ACT.CH" + std::to_string(ch);
        if (register_raw_sensor_vtable(client, 0x30, ch, 0x3000 + ch, entity, "raw_adc_counts"))
            registered++;
        if (register_actuator_state_vtable(client, 0x31, ch, 0x3100 + ch, entity))
            registered++;
    }

    for (uint8_t ch : tc_channels) {
        std::string entity = "TC.CH" + std::to_string(ch);
        if (register_raw_sensor_vtable(client, 0x21, ch, 0x2100 + ch, entity, "raw_adc_counts"))
            registered++;
    }

    for (uint8_t ch : rtd_channels) {
        std::string entity = "RTD.CH" + std::to_string(ch);
        if (register_raw_sensor_vtable(client, 0x22, ch, 0x2200 + ch, entity, "raw_resistance_counts"))
            registered++;
    }

    for (uint8_t ch : lc_channels) {
        std::string entity = "LC.CH" + std::to_string(ch);
        if (register_raw_sensor_vtable(client, 0x23, ch, 0x2300 + ch, entity, "raw_adc_counts"))
            registered++;
    }

    for (uint8_t ch : enc_channels) {
        std::string entity = "ENC.CH" + std::to_string(ch);
        if (register_raw_sensor_vtable(client, 0x24, ch, 0x2400 + ch, entity, "raw_angle"))
            registered++;
    }

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " RAW VTables ("
              << pt_channels.size() << " PT, " << act_channels.size() << " ACT, "
              << tc_channels.size() << " TC, " << rtd_channels.size() << " RTD, "
              << lc_channels.size() << " LC, " << enc_channels.size() << " ENC)" << std::endl;
    return registered > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API — CALIBRATED VTables only (for calibration_service)
// ════════════════════════════════════════════════════════════════════════════

bool DatabaseConfig::register_calibrated_tables(ElodinClient& client,
                                                const std::vector<uint8_t>& pt_channels,
                                                const std::vector<uint8_t>& tc_channels,
                                                const std::vector<uint8_t>& rtd_channels,
                                                const std::vector<uint8_t>& lc_channels,
                                                const std::vector<uint8_t>& enc_channels) {
    std::cout << "[DatabaseConfig] Registering CALIBRATED VTables..." << std::endl;
    int registered = 0;

    for (uint8_t ch : pt_channels) {
        std::string entity = "PT_Cal.CH" + std::to_string(ch);
        if (register_calibrated_vtable(client, 0x20, ch, 0x2010 + ch, entity, "pressure_psi", "raw_adc"))
            registered++;
    }

    for (uint8_t ch : tc_channels) {
        std::string entity = "TC_Cal.CH" + std::to_string(ch);
        if (register_calibrated_vtable(client, 0x21, ch, 0x2110 + ch, entity, "temperature_c", "raw_adc"))
            registered++;
    }

    for (uint8_t ch : rtd_channels) {
        std::string entity = "RTD_Cal.CH" + std::to_string(ch);
        if (register_calibrated_vtable(client, 0x22, ch, 0x2210 + ch, entity, "temperature_c", "raw_resistance"))
            registered++;
    }

    for (uint8_t ch : lc_channels) {
        std::string entity = "LC_Cal.CH" + std::to_string(ch);
        if (register_calibrated_vtable(client, 0x23, ch, 0x2310 + ch, entity, "force_n", "raw_adc"))
            registered++;
    }

    for (uint8_t ch : enc_channels) {
        std::string entity = "ENC_Cal.CH" + std::to_string(ch);
        if (register_calibrated_vtable(client, 0x24, ch, 0x2410 + ch, entity, "position_deg", "raw_adc"))
            registered++;
    }

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " CALIBRATED VTables" << std::endl;
    return registered > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API — BOARD HEARTBEAT VTables
// ════════════════════════════════════════════════════════════════════════════

bool DatabaseConfig::register_heartbeat_tables(ElodinClient& client,
                                               const std::vector<uint8_t>& board_ids) {
    std::cout << "[DatabaseConfig] Registering BOARD_HEARTBEAT VTables (" << board_ids.size()
              << " boards)..." << std::endl;
    int registered = 0;

    // Board heartbeat layout (16 bytes, no padding required):
    //   u64 timestamp_ns (0,8) | u8 board_id (8) | u8 board_type (9)
    //   u8 engine_state (10)   | u8 board_state (11) | u32 packet_ts_ms (12,4)
    for (uint8_t board_id : board_ids) {
        std::string entity = "BOARD.HB_" + std::to_string(board_id);
        std::string prefix = entity + ".";

        auto vt = builder::vtable({
            raw_field(0, 8, schema(PrimType::U64(), {}, component(prefix + "timestamp_ns"))),
            raw_field(8, 1, schema(PrimType::U8(), {}, component(prefix + "board_id"))),
            raw_field(9, 1, schema(PrimType::U8(), {}, component(prefix + "board_type"))),
            raw_field(10, 1, schema(PrimType::U8(), {}, component(prefix + "engine_state"))),
            raw_field(11, 1, schema(PrimType::U8(), {}, component(prefix + "board_state"))),
            raw_field(12, 4, schema(PrimType::U32(), {}, component(prefix + "packet_ts_ms"))),
        });

        uint64_t entity_id = 0x1000 + board_id;
        if (!send_msg(client, VTableMsg{.id = {0x10, board_id}, .vtable = vt})) {
            std::cerr << "[DatabaseConfig] ❌ Heartbeat VTable failed: " << entity << std::endl;
            continue;
        }

        send_msg(client, set_component_name(prefix + "timestamp_ns"));
        send_msg(client, set_component_name(prefix + "board_id"));
        send_msg(client, set_component_name(prefix + "board_type"));
        send_msg(client, set_component_name(prefix + "engine_state"));
        send_msg(client, set_component_name(prefix + "board_state"));
        send_msg(client, set_component_name(prefix + "packet_ts_ms"));
        send_msg(client, set_entity_name(entity_id, entity));
        registered++;
    }

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " HEARTBEAT VTables"
              << std::endl;
    return registered > 0;
}

static bool register_self_test_vtable(ElodinClient& client, uint8_t board_id) {
    std::string entity = "SELF_TEST.BOARD_" + std::to_string(board_id);
    std::string prefix = entity + ".";

    auto vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component(prefix + "timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component(prefix + "sensor_id"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, component(prefix + "result"))),
    });

    uint64_t entity_id = 0x6000 + board_id;
    if (!send_msg(client, VTableMsg{.id = {0x60, board_id}, .vtable = vt}))
        return false;

    send_msg(client, set_component_name(prefix + "timestamp_ns"));
    send_msg(client, set_component_name(prefix + "sensor_id"));
    send_msg(client, set_component_name(prefix + "result"));
    send_msg(client, set_entity_name(entity_id, entity));
    return true;
}

bool DatabaseConfig::register_self_test_tables(ElodinClient& client,
                                               const std::vector<uint8_t>& board_ids) {
    std::cout << "[DatabaseConfig] Registering SELF_TEST VTables (" << board_ids.size()
              << " boards)..." << std::endl;
    int registered = 0;
    for (uint8_t board_id : board_ids) {
        if (register_self_test_vtable(client, board_id)) {
            registered++;
        }
    }
    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " SELF_TEST VTables"
              << std::endl;
    return registered > 0;
}

// ── Helper: register Sequencer tables ──────────────
static bool register_sequencer_vtable(ElodinClient& client) {
    // SequencerState: u64@0 + u8@8 + 3-byte hole + u32@12 + u8@16 = 17 bytes (u32 4-aligned like
    // sensor rows)
    auto vt1 = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("SEQUENCER.state.timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component("SEQUENCER.state.current_state"))),
        raw_field(12, 4, schema(PrimType::U32(), {}, component("SEQUENCER.state.allowed_bitmask"))),
        raw_field(16, 1, schema(PrimType::U8(), {}, component("SEQUENCER.state.debug_mode"))),
    });
    if (!send_msg(client, VTableMsg{.id = {0x50, 0x00}, .vtable = vt1}))
        return false;
    send_msg(client, set_component_name("SEQUENCER.state.timestamp_ns"));
    send_msg(client, set_component_name("SEQUENCER.state.current_state"));
    send_msg(client, set_component_name("SEQUENCER.state.allowed_bitmask"));
    send_msg(client, set_component_name("SEQUENCER.state.debug_mode"));
    send_msg(client, set_entity_name(0x5000, "SEQUENCER.state"));

    // StateTransition: U64+U8+U8+U8 (11 bytes)
    auto vt2 = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CONTROLLER.state.timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.from_state"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.to_state"))),
        raw_field(10, 1, schema(PrimType::U8(), {}, component("CONTROLLER.state.reason"))),
    });
    if (!send_msg(client, VTableMsg{.id = {0x43, 0x00}, .vtable = vt2}))
        return false;
    send_msg(client, set_component_name("CONTROLLER.state.timestamp_ns"));
    send_msg(client, set_component_name("CONTROLLER.state.from_state"));
    send_msg(client, set_component_name("CONTROLLER.state.to_state"));
    send_msg(client, set_component_name("CONTROLLER.state.reason"));
    send_msg(client, set_entity_name(0x4300, "CONTROLLER.state"));

    return true;
}

bool DatabaseConfig::register_non_sensor_tables(ElodinClient& client) {
    bool ok = true;
    if (!register_sequencer_vtable(client))
        ok = false;

    // Register actuator commanded state VTables [0x32, global_ch] for up to 4 boards × 10 channels
    // Global channel = (board_id - 11) * 10 + local_channel (boards 11-14, channels 1-10)
    int act_cmd_count = 0;
    for (int global_ch = 1; global_ch <= 40; ++global_ch) {
        std::string entity_name = "ACT_CMD.CH" + std::to_string(global_ch);
        uint64_t entity_id = (static_cast<uint64_t>(0x32) << 8) | static_cast<uint64_t>(global_ch);
        if (register_actuator_state_vtable(client, 0x32, static_cast<uint8_t>(global_ch), entity_id,
                                           entity_name))
            act_cmd_count++;
    }
    if (act_cmd_count > 0)
        std::cout << "[DatabaseConfig] ✅ Registered " << act_cmd_count
                  << " actuator commanded VTables [0x32]" << std::endl;

    if (ok) {
        std::cout << "[DatabaseConfig] ✅ Registered Sequencer/Controller VTables" << std::endl;
    }
    return ok;
}

}  // namespace elodin
}  // namespace fsw
