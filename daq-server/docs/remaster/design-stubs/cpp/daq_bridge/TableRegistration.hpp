// DESIGN STUB (DESIGN-WP10 §4.3, CLEANUP only, after §7.4 gap 1; name AMENDED per D43(2)) — not
// compiled. Becomes diablo_server/daq_bridge/TableRegistration.{hpp,cpp}.
//
// The one place daq_bridge registers its Elodin tables, replacing the two copies at first connect
// (578-592) and reconnect (759-773). It is also the one daq_bridge site where a later D-SLOT
// injectivity check lands (D42 binding 3); the ids themselves come from DatabaseConfig →
// fsw::elodin::table_id_for (DESIGN-WP3 §2.5). calibration_service registers the calibrated tables
// as well, in its own main: two registrars across two processes, frozen (walkthrough (c2)).
//
// Owns:       nothing; it sends on the caller's connected client.
// Threads:    daq_bridge's single thread.
// Order:      register_tables (raw) → register_calibrated_tables → register_ball_valve_tables (only
//             if bv boards exist) → register_heartbeat_tables → register_environmental_tables →
//             register_self_test_tables. Never reordered: the order is the registration stream in
//             elodin/golden (first connect) and the new reconnect golden (gap 1).
// Errors:     report_failures == true (first connect): "⚠️  RAW VTable registration failed" and
//             "⚠️  Ball valve RAW VTable registration failed" printed at the point each of those two
//             calls returns false (not after all six). false (reconnect): every result ignored.
//             The connect/reconnect log lines, `elodin_connected = true` and the 1500 ms drain stay
//             at the call sites in main, unchanged.
// Must not know: when to connect or reconnect (main's 5 s gate), subscribers, the drain.
//             Adds no barrier or acknowledgement wait: D-SUB's window (a subscription accepted
//             during a re-registration that changes an id's content binds to stale components) is
//             preserved exactly.
// Contract:   elodin/golden/schema_*.txt section daq_bridge (1559 packets on config_base); the
//             reconnect stream once DESIGN-WP10 §7.4 gap 1 freezes it.
#pragma once

#include <cstdint>
#include <map>
#include <vector>

#include "config/LoadActiveBoards.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"

/** `active_boards` is main's map; its keys were inserted by main's operator[] (559-566). This
 *  function reads with find() and never inserts. */
void register_all_tables(fsw::elodin::ElodinClient& client,
                         const std::map<fsw::config::ActiveBoardKind,
                                        std::vector<fsw::elodin::BoardChannels>>& active_boards,
                         const std::vector<uint8_t>& config_board_ids, bool report_failures);
