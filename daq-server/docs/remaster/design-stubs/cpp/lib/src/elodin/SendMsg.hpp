// DESIGN STUB (DESIGN-WP3 §2.3) — not compiled. Becomes diablo_server/lib/src/elodin/SendMsg.hpp.
//
// Encode one db.hpp message (VTableMsg, SetComponentMetadata, SetEntityMetadata, …) and send it on
// an Elodin connection. Replaces the two file-static copies in DatabaseConfig.cpp:16-24 and
// ControllerService.cpp:921-927 (PressureStateMachine's lambda dies with PSM).
//
// Owns:       nothing. The caller owns the client and the message; the encoded buffer is a local.
// Threads:    whatever thread calls it. Thread safety is ElodinClient::send_msg's (its
//             publish_mutex_); no lock here, none held across the call.
// Errors:     returns false when encoding yields an empty buffer or the send fails. On an empty
//             buffer it writes `encode_failure_line` to std::cerr followed by std::endl, or nothing
//             when it is nullptr — the one difference between today's two copies, kept per caller
//             (STYLE-S12): DatabaseConfig passes "[DatabaseConfig] Failed to encode message",
//             ControllerService passes nullptr. Never throws beyond what encode_vec/send_msg throw.
// Must not know: which tables exist, ids, entity names (DatabaseConfig's and ControllerService's).
//             Lib-private by mechanism, not by directory: lib/src is on fsw_daq_lib's PUBLIC
//             include list, so any consumer can resolve this path, but the header's own
//             #include "db.hpp" resolves only on fsw_daq_lib's SYSTEM PRIVATE directory
//             (DESIGN-WP3 §2.2, §2.3). A service or harness TU that includes it fails to
//             compile ("db.hpp not found").
// Contract:   the Elodin MSG bytes — elodin/golden/schema_{config_base,profile_default}.txt (every
//             service's registration stream, byte for byte).
// Static init: none (STYLE-S26).
#pragma once

#include "db.hpp"  // vendored encoder (lib/third_party/elodin, SYSTEM PRIVATE)
#include "elodin/ElodinClient.hpp"

namespace fsw::elodin {

/** Msg(msg).encode_vec(); empty → optional cerr line, false; else client.send_msg({0, 0}, buf)
 *  (the packet id is already inside buf). Same statements as both copies today. */
template <typename T>
inline bool send_msg(ElodinClient& client, T msg, const char* encode_failure_line);

}  // namespace fsw::elodin
