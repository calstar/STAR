// DESIGN STUB (DESIGN-WP10 §4.3, CLEANUP only) — not compiled. Becomes
// diablo_server/daq_bridge/ElodinPublish.{hpp,cpp}. Two blocks of main's packet loop, each with one
// call site (a split of a god function, not an abstraction: D43(3)): self-test publish 816-883 and
// the raw batch publish 885-989.
//
// Owns:       nothing; every local the blocks use is passed by reference, so counters and the
//             board_map insertion of a discovered board stay main's state.
// Threads:    daq_bridge's single thread.
// Order:      statement for statement as today: the guard conditions stay at the call site in main
//             (`elodin_connected && is_connected() && !self_tests.empty()`; `publishing`), then
//             begin_batch → publish rows → flush_batch (→ ++elodin_publish_count, else
//             ++elodin_drop_count) → for self-tests, the non-blocking drain. Board slot: board_id
//             % 10, 0 → 10, as today (WP10 does not adopt table_id_for).
// Errors:     a failed publish is counted, never logged per row; unknown board id for a self-test
//             → the fallback ladder (config IP, discovery, 127.0.0.<octet>), else skipped.
// Must not know: registration, reconnect, routing decisions (main resolves board type and config
//             before calling), heartbeat/log/environmental paths.
// Contract:   raw tables (0x20 PT, 0x30 ACT, 0x23 LC, 0x21 TC, 0x22 RTD, 0x24 ENC, 0x33 BV; low
//             byte (slot-1)*0x20 + ch), [0x60+s, board] self-test rows — pipeline/golden/*,
//             packets/golden/service_daq_bridge.txt, test_integration.sh.
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>

#include "BoardMap.hpp"
#include "config/BoardDiscovery.hpp"
#include "elodin/ElodinClient.hpp"
#include "streams/SensorFramePipeline.hpp"
#include "time/BoardClockSync.hpp"

/** 816-883 body. */
void publish_self_tests(fsw::elodin::ElodinClient& elodin_client,
                        const daq_comms::protocol::SensorBatch& batch,
                        const BoardConfig* effective_cfg,
                        const std::map<std::string, BoardConfig>& board_map,
                        fsw::config::BoardDiscovery& discovery, const std::string& source_ip,
                        uint64_t receive_timestamp_ns, size_t& elodin_publish_count);

/** 885-989 body. */
void publish_raw_batch(fsw::elodin::ElodinClient& elodin_client, bool publishing,
                       const daq_comms::protocol::SensorBatch& batch, BoardType board_type,
                       const BoardConfig* effective_cfg, const std::string& source_ip,
                       uint64_t receive_timestamp_ns, fsw::time::BoardClockSync& clock_sync,
                       size_t& elodin_publish_count, size_t& elodin_drop_count);
