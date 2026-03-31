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
    uint8_t type_hi,  // high byte (0x20=PT, 0x21=TC, 0x22=RTD, 0x23=LC)
    uint8_t pkt_lo,   // full low byte for packet ID (already includes board offset + 0x10)
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

    if (!send_msg(client, VTableMsg{.id = {type_hi, pkt_lo}, .vtable = vt})) {
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
                                     const std::vector<BoardChannels>& pt_boards,
                                     const std::vector<BoardChannels>& act_boards,
                                     const std::vector<BoardChannels>& tc_boards,
                                     const std::vector<BoardChannels>& rtd_boards,
                                     const std::vector<BoardChannels>& lc_boards,
                                     const std::vector<BoardChannels>& enc_boards) {
    std::cout << "[DatabaseConfig] Registering RAW VTables (board-namespaced)..." << std::endl;
    int registered = 0;
    int pt_count = 0, act_count = 0, tc_count = 0, rtd_count = 0, lc_count = 0, enc_count = 0;

    for (const auto& board : pt_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "PT" + std::to_string(board.board_number) + ".CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x20) << 8) | lo;
            if (register_raw_sensor_vtable(client, 0x20, lo, entity_id, entity, "raw_adc_counts")) {
                registered++;
                pt_count++;
            }
        }
    }

    for (const auto& board : act_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "ACT" + std::to_string(board.board_number) + ".CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x30) << 8) | lo;
            if (register_raw_sensor_vtable(client, 0x30, lo, entity_id, entity, "raw_adc_counts")) {
                registered++;
                act_count++;
            }
        }
    }

    for (const auto& board : tc_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "TC" + std::to_string(board.board_number) + ".CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x21) << 8) | lo;
            if (register_raw_sensor_vtable(client, 0x21, lo, entity_id, entity, "raw_adc_counts")) {
                registered++;
                tc_count++;
            }
        }
    }

    for (const auto& board : rtd_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "RTD" + std::to_string(board.board_number) + ".CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x22) << 8) | lo;
            if (register_raw_sensor_vtable(client, 0x22, lo, entity_id, entity,
                                           "raw_resistance_counts")) {
                registered++;
                rtd_count++;
            }
        }
    }

    for (const auto& board : lc_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "LC" + std::to_string(board.board_number) + ".CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x23) << 8) | lo;
            if (register_raw_sensor_vtable(client, 0x23, lo, entity_id, entity, "raw_adc_counts")) {
                registered++;
                lc_count++;
            }
        }
    }

    for (const auto& board : enc_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "ENC" + std::to_string(board.board_number) + ".CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x24) << 8) | lo;
            if (register_raw_sensor_vtable(client, 0x24, lo, entity_id, entity, "raw_angle")) {
                registered++;
                enc_count++;
            }
        }
    }

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " RAW VTables (" << pt_count
              << " PT, " << act_count << " ACT, " << tc_count << " TC, " << rtd_count << " RTD, "
              << lc_count << " LC, " << enc_count << " ENC)" << std::endl;
    return registered > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API — CALIBRATED VTables only (for calibration_service)
// ════════════════════════════════════════════════════════════════════════════

bool DatabaseConfig::register_calibrated_tables(ElodinClient& client,
                                                const std::vector<BoardChannels>& pt_boards,
                                                const std::vector<BoardChannels>& tc_boards,
                                                const std::vector<BoardChannels>& rtd_boards,
                                                const std::vector<BoardChannels>& lc_boards,
                                                const std::vector<BoardChannels>& enc_boards,
                                                const std::vector<BoardChannels>& act_boards) {
    std::cout << "[DatabaseConfig] Registering CALIBRATED VTables..." << std::endl;
    int registered = 0;

    for (const auto& board : pt_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "PT" + std::to_string(board.board_number) + "_Cal.CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + 0x10 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x20) << 8) | lo;
            if (register_calibrated_vtable(client, 0x20, lo, entity_id, entity, "pressure_psi",
                                           "raw_adc"))
                registered++;
        }
    }

    for (const auto& board : tc_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "TC" + std::to_string(board.board_number) + "_Cal.CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + 0x10 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x21) << 8) | lo;
            if (register_calibrated_vtable(client, 0x21, lo, entity_id, entity, "temperature_c",
                                           "raw_adc"))
                registered++;
        }
    }

    for (const auto& board : rtd_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "RTD" + std::to_string(board.board_number) + "_Cal.CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + 0x10 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x22) << 8) | lo;
            if (register_calibrated_vtable(client, 0x22, lo, entity_id, entity, "temperature_c",
                                           "raw_resistance"))
                registered++;
        }
    }

    for (const auto& board : lc_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "LC" + std::to_string(board.board_number) + "_Cal.CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + 0x10 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x23) << 8) | lo;
            if (register_calibrated_vtable(client, 0x23, lo, entity_id, entity, "force_n",
                                           "raw_adc"))
                registered++;
        }
    }

    for (const auto& board : enc_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "ENC" + std::to_string(board.board_number) + "_Cal.CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + 0x10 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x24) << 8) | lo;
            if (register_calibrated_vtable(client, 0x24, lo, entity_id, entity, "position_deg",
                                           "raw_adc"))
                registered++;
        }
    }

    // Actuators use 0x31 for calibrated (separate type byte to avoid collision with raw 0x30)
    for (const auto& board : act_boards) {
        for (uint8_t ch : board.channels) {
            std::string entity =
                "ACT" + std::to_string(board.board_number) + "_Cal.CH" + std::to_string(ch);
            uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + 0x10 + ch);
            uint64_t entity_id = (static_cast<uint64_t>(0x31) << 8) | lo;
            if (register_calibrated_vtable(client, 0x31, lo, entity_id, entity, "current_a",
                                           "raw_adc"))
                registered++;
        }
    }

    std::cout << "[DatabaseConfig] ✅ Registered " << registered << " CALIBRATED VTables"
              << std::endl;
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

static bool register_calibration_command_vtable(ElodinClient& client) {
    // CalibrationCommand: u64 timestamp_ns | u8 type | u8 sensor_id | u16 pad | f32 reference_value
    auto vt = builder::vtable({
        raw_field(0, 8, schema(PrimType::U64(), {}, component("CALIBRATION.command.timestamp_ns"))),
        raw_field(8, 1, schema(PrimType::U8(), {}, component("CALIBRATION.command.type"))),
        raw_field(9, 1, schema(PrimType::U8(), {}, component("CALIBRATION.command.sensor_id"))),
        raw_field(12, 4,
                  schema(PrimType::F32(), {}, component("CALIBRATION.command.reference_value"))),
    });
    if (!send_msg(client, VTableMsg{.id = {0x46, 0x00}, .vtable = vt}))
        return false;
    send_msg(client, set_component_name("CALIBRATION.command.timestamp_ns"));
    send_msg(client, set_component_name("CALIBRATION.command.type"));
    send_msg(client, set_component_name("CALIBRATION.command.sensor_id"));
    send_msg(client, set_component_name("CALIBRATION.command.reference_value"));
    send_msg(client, set_entity_name(0x4600, "CALIBRATION.command"));
    return true;
}

bool DatabaseConfig::register_non_sensor_tables(ElodinClient& client,
                                                const std::vector<BoardChannels>& act_boards) {
    bool ok = true;
    if (!register_sequencer_vtable(client))
        ok = false;
    if (!register_calibration_command_vtable(client))
        ok = false;

    // Register actuator commanded state VTables [0x32, (board_number-1)*0x20 + ch]
    int act_cmd_count = 0;
    if (!act_boards.empty()) {
        for (const auto& board : act_boards) {
            for (uint8_t ch : board.channels) {
                uint8_t lo = static_cast<uint8_t>((board.board_number - 1) * 0x20 + ch);
                std::string entity_name =
                    "ACT_CMD.B" + std::to_string(board.board_number) + ".CH" + std::to_string(ch);
                uint64_t entity_id = (static_cast<uint64_t>(0x32) << 8) | lo;
                if (register_actuator_state_vtable(client, 0x32, lo, entity_id, entity_name))
                    act_cmd_count++;
            }
        }
    } else {
        // Fallback: register for 4 boards x 10 channels when no board info available
        for (int bn = 1; bn <= 4; ++bn) {
            for (int ch = 1; ch <= 10; ++ch) {
                uint8_t lo = static_cast<uint8_t>((bn - 1) * 0x20 + ch);
                std::string entity_name =
                    "ACT_CMD.B" + std::to_string(bn) + ".CH" + std::to_string(ch);
                uint64_t entity_id = (static_cast<uint64_t>(0x32) << 8) | lo;
                if (register_actuator_state_vtable(client, 0x32, lo, entity_id, entity_name))
                    act_cmd_count++;
            }
        }
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
