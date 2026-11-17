// DESIGN STUB (DESIGN-WP9 §2, move-only step 4) — not compiled. Becomes
// diablo_server/services/calibration/CalibrationCommands.{hpp,cpp}. Body: 1631-1819, the inside of
// `if (type_hi == 0x46)`; its outer-loop `continue` at 1637 becomes `return`; the inner-loop
// `continue`s at 1673, 1789, 1796 stay `continue` (DESIGN-WP9 §4). 1673 and 1796 (a refused
// capture inside Zero All / Tare All) are NOT exercised by today's stack.txt — burst() sends 10
// fresh samples per uid before cmd 0 and cmd 8 — so a wrong `return` there passes today's golden;
// the stale-uid C0 case (DESIGN-WP9 §7.2) gates this step. 1789 is exercised (cmd(8, 0, 1.0)).
//
// Decodes a CalibrationCommand row (ts u64 | cmd u8 @8 | pad @9 | sensor_id u16 LE @10 | ref f32
// @12, memcpy not cast) and runs cmd 0-8 through CalibrationActions. CalibrationContext comes
// from CalibrationActions.hpp (D58: no separate header), which the .cpp needs for the actions
// anyway.
//
// Owns:       nothing; the dedupe memory is main's CommandDedupe, passed in.
// Threads:    one. Called from main's loop head only, as the last statement of the 0x46 branch,
//             followed by main's `continue`.
// Errors:     pkt_len < 24 → ignored, no log; duplicate → dropped; cmd ≥ 9 → only the "Received
//             CalibrationCommand" line. **No reply exists**: a command's effects are files, later
//             published values and log lines.
// Must not know: the Elodin client, subscription state, the raw-stream state (StreamState).
// Contract:   calibration/golden/stack.txt (every command, dedupe, refused captures, unknown cmd 9,
//             uid 9999).
#pragma once

#include <sys/types.h>

#include <cstdint>

#include "CalibrationActions.hpp"
#include "calibration/CommandDedupe.hpp"

namespace fsw::calibration_service {

void handle_calibration_command(CalibrationContext& ctx,
                                fsw::calibration::CommandDedupe& command_dedupe,
                                const uint8_t* pkt_buf, ssize_t pkt_len);

}  // namespace fsw::calibration_service
