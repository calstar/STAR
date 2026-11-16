// DESIGN STUB (DESIGN-WP10 §4.3, move-only step 4) — not compiled. Becomes
// diablo_server/daq_bridge/BoardMap.{hpp,cpp}, linked into daq_bridge and char_cfg_daq_bridge only.
// Bodies: daq_bridge_main.cpp 139-305, `static` removed (external linkage, STYLE-S27 lists it),
// default arguments moved to this declaration. Lands in ONE commit with the harness re-pointing
// (char_config_services.cpp includes this header instead of the main; D18 extension, §7.3).
//
// Board identity for the bridge: the [boards.*] map read from config, the loopback-octet fallback
// index, and source IP → configured board resolution.
//
// Owns:       nothing persistent; load_board_map_from_config fills the caller's out-parameters.
// Threads:    daq_bridge is single-threaded; all called from main.
// Errors:     load_board_map_from_config prints `[Config] WARN: loopback host octet …` to stderr
//             (captured in config/golden/cpp/daq_bridge) and lets fsw::config errors propagate:
//             std::invalid_argument → main's "FATAL: …", exit 1 (C2-12's daq_bridge half). Unknown
//             IPs resolve to nullptr; main treats them as discovered type or PT.
// Must not know: Elodin, the pipeline, sockets, config pushes (daq_bridge pushes no board config;
//             config_broadcast_service does — C6-1, C6-6; history.md walkthrough (c1)).
// Names:      global namespace kept (a namespace would need a second harness edit, §4.3; STYLE-S4
//             records the exception); `BoardConfig`/`ServerHeartbeatConfig` coexist with
//             fsw::config's types only because nothing here says `using namespace fsw::config`.
// Contract:   config/golden/cpp/daq_bridge/*, config/golden/bin/daq_bridge/* (start-up through
//             `[System] Mode`), pipeline routing; mutation in §7.3 (`octet >= 2` → `>= 3`).
#pragma once

#include <cstdint>
#include <map>
#include <string>

#include "config/LoadActiveBoards.hpp"
#include "time/BoardClockSync.hpp"

using BoardType = fsw::config::ActiveBoardKind;

struct BoardConfig {
    BoardType type;
    std::string ip;
    int active_channels;  // length of active_connectors; log-only here
    bool enabled;
    int board_id;
};

struct ServerHeartbeatConfig {
    uint32_t interval_ms = 1000;
    uint16_t broadcast_port = 5005;
    std::string broadcast_ip = "255.255.255.255";
    bool send_from_daq_bridge =
        true;  // false when heartbeat_service is used (C6-3: fixed at start)
};

/** Keyed by the host octet of each board's config IP (the simulator binds 127.0.0.<octet>). */
using BoardByOctet = std::map<int, BoardConfig>;

/** Last octet of a dotted IPv4 string, or -1. */
int ipv4_host_octet(const std::string& ip);

/** [database], [network] sensor_port/bind_ip (C1-12: sensor_port overrides argv[3]),
 *  [server_heartbeat], [time_sync], log port, [boards.*]. */
void load_board_map_from_config(const std::string& config_path,
                                std::map<std::string, BoardConfig>& board_map,
                                BoardByOctet* out_board_by_octet, std::string& db_host,
                                uint16_t& db_port, uint16_t* out_sensor_port = nullptr,
                                std::string* out_bind_ip = nullptr,
                                ServerHeartbeatConfig* out_hb = nullptr,
                                fsw::time::TimeSyncConfig* out_ts = nullptr,
                                uint16_t* out_log_port = nullptr);

/** DAQv2 discovery signature board_type → BoardType. */
BoardType discovery_board_type_to_enum(uint8_t t);

/** BoardType → DAQv2 wire byte (fsw::daq_wire). */
uint8_t config_board_type_to_wire_u8(BoardType t);

/** Config IP first, then the 127.0.0.<octet> fallback; nullptr if neither. */
const BoardConfig* resolve_board_config_by_source_ip(
    const std::string& source_ip, const std::map<std::string, BoardConfig>& board_map,
    const BoardByOctet& board_by_octet);

/** CLEANUP ONLY: the routing-table print, daq_bridge_main.cpp 383-418 (one call site, a split of
 *  main; D43(3)). The harness does not call it. Parameters are the locals the block reads. */
void print_board_routing_table(/* the locals 383-418 read, by const reference */);
