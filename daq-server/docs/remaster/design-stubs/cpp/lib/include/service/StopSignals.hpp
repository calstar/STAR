// DESIGN STUB (DESIGN-WP8 §2.1; notice shape per D57) — not compiled. Becomes
// diablo_server/lib/include/service/StopSignals.hpp
// (+ lib/src/service/StopSignals.cpp in fsw_daq_lib).
//
// The process stop flag and the SIGINT/SIGTERM/SIGPIPE installer every service main calls once.
// Replaces nine file-local flags and handlers (DESIGN-WP8 §1.3).
//
// Owns:       one std::atomic<bool> (constant-initialised, true until SIGINT/SIGTERM) and, written
//             once by installStopHandlers before ::signal(), the print order and the line (plain
//             globals: every thread in every service is created after the call, so the writes
//             happen-before every reader; STYLE-S24 states this exception).
// Threads:    installStopHandlers: the main thread, once, exactly where the service installs its
//             handlers today (§1.2: after config in heartbeat/stacklight/config_broadcast, before
//             svc.init() in the sequencer, after initialize() and before start() in the controller,
//             …), always before its first thread. running(): any thread. The handler runs on
//             whichever thread the kernel picks (on Linux usually the group leader).
// Read sites: none change (D57). Each main binds its old flag name to running() at namespace
//             scope, where the deleted declaration stood — `auto& g_running =
//             fsw::service::running();` inside the anonymous namespace (six mains), `static auto&
//             g_running = …` in controller_main.cpp (its 54 is file-scope static) — so every
//             `while (g_running)` is byte-identical. The reference binds at the main's dynamic
//             initialisation to an atomic that is constant-initialised here, so DSO init order
//             cannot bite and no I/O happens (STYLE-S26 holds, also inside the config harness that
//             #include's a main). fsw_daq_lib is SHARED (lib/CMakeLists.txt:45): the one running()
//             call goes through the PLT; each read is then an atomic load through the stored
//             address. Unobservable.
// Semantics:  ::signal — BSD semantics, i.e. sigaction with SA_RESTART, handler not reset, signal
//             masked during the handler (research cpp-service-plumbing §0.1). Never sigaction with
//             another flag set: dropping SA_RESTART makes accept/recv/waitpid return EINTR;
//             SA_RESETHAND makes a second SIGTERM fatal. EINTR exposure stays today's: select,
//             usleep and SO_RCVTIMEO/SO_SNDTIMEO socket calls are interrupted regardless (§0.2),
//             including AbortBroadcaster's SO_SNDTIMEO sendto (an ABORT repeat can fail; D42).
// Handler:    one function, switch on the print order; each case is today's two statements in
//             today's order — kPrintThenStop: `if (line) std::cout << line << std::endl;` then
//             `flag = false;`; kStopThenPrint (daq_bridge): the same two the other way round —
//             including the non-async-signal-safe std::cout << … << std::endl and not saving errno
//             (parked: BLOAT-MAP defect 6; research §0.3). The switch and the `if (line)` test are
//             the two statements no handler has today: the switch selects the one case that
//             service's handler was; the test is true in every printing service, false only in
//             t7_bridge, which prints nothing today. Unobservable.
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

/** In which order the SIGINT/SIGTERM handler prints its line and clears the flag. Two values,
 *  because two orders exist today; "print nothing" is not an order but a nullptr `line`. */
enum class ShutdownNotice {
    kPrintThenStop,  // std::cout << line << std::endl; then flag = false (eight services)
    kStopThenPrint,  // flag = false; then std::cout << line << std::endl (daq_bridge)
};

/** SIGPIPE is left alone or ignored. kDefault means NO signal() call for SIGPIPE at all — not
 *  signal(SIGPIPE, SIG_DFL), which would overwrite a disposition inherited from a launcher that
 *  ignores SIGPIPE; today's five default-disposition mains make no such call, and die with −13 on
 *  a SIGPIPE. Per service, frozen until the team decides (LEDGER Parked "SIGPIPE disposition");
 *  never changed in a refactor. */
enum class Sigpipe { kDefault, kIgnore };

/** The process's stop flag: true until SIGINT/SIGTERM. */
std::atomic<bool>& running();

/** signal(SIGINT, h); signal(SIGTERM, h); and for kIgnore signal(SIGPIPE, SIG_IGN) — in that
 *  order; for kDefault no SIGPIPE call. `line` is printed verbatim (callers include the leading
 *  "\n"; the controller's U+2026 is bytes in the literal) and must outlive the process (a string
 *  literal). `line == nullptr`
 *  prints nothing (t7_bridge, which passes kPrintThenStop: with no line the order is
 *  immaterial, and daq_bridge stays the only kStopThenPrint user). Per-service arguments:
 *  DESIGN-WP8 §2.1 table. */
void installStopHandlers(ShutdownNotice notice, const char* line, Sigpipe sigpipe);

}  // namespace fsw::service
