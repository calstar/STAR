// DESIGN STUB (DESIGN-WP3 §2.5; D42 binding 3) — not compiled. Becomes
// diablo_server/lib/include/elodin/TableId.hpp.
//
// The one computation of a board-namespaced Elodin table id: (type_hi, (slot-1)*0x20 + half + ch).
// Replaces 15 copies in DatabaseConfig.cpp (+ appendTables), T7Stream.cpp's table_id /
// calibrated_table_id and SensorTables.cpp's makeRef. A later D-SLOT fix (refuse slot > 8 or a
// non-injective id map) changes this function and its return type, and the compiler then lists
// every caller that must decide what a refused id means (that is why it is not std::optional
// today: an always-engaged optional is a branch no input can take, STYLE-S34).
//
// Owns:       nothing; pure, constexpr, no I/O, no state.
// Threads:    any.
// Errors:     none. **Wraps silently in uint8_t exactly as today** (slot 10, ch 1, calibrated →
//             0x31 = PT2_Cal.CH1's id: D-SLOT, LEDGER lead defect; frozen by the pipeline fixture's
//             board 60). Integer promotion to int, then the cast reduces mod 256; a caller passing
//             an int channel converts it first, which gives the same byte (modular conversion).
// Must not know: the slot rule (board_id % 10, 0 → 10: the caller passes the slot it already has),
//             entity names, which families exist (type_hi is the family; no enum to keep in step).
// Contract:   every registered and published table id — elodin/golden/schema_*.txt, pipeline/,
//             config/golden/cpp/config/* (PtRoleRef table bytes), t7_integration.
// Naming:     STYLE-S1 (lib/include/elodin is snake_case); D42 calls it tableIdFor().
#pragma once

#include <cstdint>
#include <utility>

namespace fsw::elodin {

/** Low-byte offset of the half a table belongs to. */
enum class TableHalf : uint8_t { kRaw = 0x00, kCalibrated = 0x10 };

/** {type_hi, static_cast<uint8_t>((slot - 1) * 0x20 + static_cast<uint8_t>(half) + channel)}. */
constexpr std::pair<uint8_t, uint8_t> table_id_for(uint8_t type_hi, uint8_t slot, uint8_t channel,
                                                   TableHalf half) noexcept;

}  // namespace fsw::elodin
