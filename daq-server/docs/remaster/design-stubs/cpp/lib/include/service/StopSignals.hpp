// DESIGN STUB (DESIGN-WP8 §2.1) — not compiled. Becomes
// diablo_server/lib/include/service/StopSignals.hpp
// (+ lib/src/service/StopSignals.cpp in fsw_daq_lib).
//
// The process stop flag and the SIGINT/SIGTERM/SIGPIPE installer every service main calls once.
// Replaces nine file-local flags and handlers (DESIGN-WP8 §1.3).
//
// Owns:       one std::atomic<bool> (constant-initialised, true until SIGINT/SIGTERM) and, written
//             once by installStopHandlers before ::signal(), the notice kind and line (plain
//             globals: every thread in every service is created after the call, so the writes
//             happen-before every reader; STYLE-S24 states this exception).
// Threads:    installStopHandlers: the main thread, once, exactly where the service installs its
//             handlers today (§1.2: after config in heartbeat/stacklight/config_broadcast, before
//             svc.init() in the sequencer, after initialize() and before start() in the controller,
//             …), always before its first thread. running(): any thread. The handler runs on
//             whichever thread the kernel picks (on Linux usually the group leader).
// Semantics:  ::signal — BSD semantics, i.e. sigaction with SA_RESTART, handler not reset, signal
//             masked during the handler (research cpp-service-plumbing §0.1). Never sigaction with
//             another flag set: dropping SA_RESTART makes accept/recv/waitpid return EINTR;
//             SA_RESETHAND makes a second SIGTERM fatal. EINTR exposure stays today's: select,
//             usleep and SO_RCVTIMEO/SO_SNDTIMEO socket calls are interrupted regardless (§0.2),
//             including AbortBroadcaster's SO_SNDTIMEO sendto (an ABORT repeat can fail; D42).
// Handler:    one function, switch on the notice; each case is today's body statement for
//             statement, including the non-async-signal-safe std::cout << line << std::endl and
//             not saving errno (parked: BLOAT-MAP defect 6; research §0.3). daq_bridge's case
//             clears the flag before printing; the others print first; t7_bridge prints nothing.
// Errors:     none returned; ::signal's result is ignored, as today.
// Must not know: any service; config; sockets; what a service does on stop (each main tears down
//             in its own order, §1.2/§6.3). No ServiceMain (rejected, §0).
// Contract:   exit codes (0 after install, −2/−15 before; −13 for SIGPIPE where kDefault) and the
//             "Shutting down" line — lifecycle/golden/shutdown.txt, DESIGN-WP8 §7.2 gaps 1-3.
// Static init: none beyond the constant-initialised atomic; no output at load (the config harness
//             captures stdout around #include'd mains, §7.3). No identifier spelled `main`.
#pragma once

#include <atomic>

namespace fsw::service {

/** What the SIGINT/SIGTERM handler prints. Each value is one service's behaviour today. */
enum class ShutdownNotice {
    kSilent,         // flag only (t7_bridge)
    kPrintThenStop,  // std::cout << line << std::endl; then flag = false (seven services)
    kStopThenPrint,  // flag = false; then std::cout << line << std::endl (daq_bridge)
};

/** SIGPIPE keeps its default action (the process dies, −13) or is ignored. Per service, frozen
 *  until the team decides (LEDGER Parked "SIGPIPE disposition"); never changed in a refactor. */
enum class Sigpipe { kDefault, kIgnore };

/** The process's stop flag: true until SIGINT/SIGTERM. */
std::atomic<bool>& running();

/** signal(SIGINT, h); signal(SIGTERM, h); and for kIgnore signal(SIGPIPE, SIG_IGN) — in that
 *  order. `line` is printed verbatim (callers include the leading "\n"; the controller's U+2026 is
 *  bytes in the literal) and must outlive the process (a string literal). `line` is nullptr
 *  **iff** notice == kSilent (t7_bridge); every printing notice passes a literal. Per-service
 *  arguments: DESIGN-WP8 §2.1 table. */
void installStopHandlers(ShutdownNotice notice, const char* line, Sigpipe sigpipe);

}  // namespace fsw::service
