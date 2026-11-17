#include "service/StopSignals.hpp"

#include <signal.h>

#include <atomic>
#include <iostream>

namespace fsw::service {

namespace {

// Constant-initialised: no dynamic initialisation, nothing printed or opened at load (STYLE-S26).
std::atomic<bool> g_running{true};

// Plain globals, not atomics: written once by installStopHandlers, before the signal() calls and
// before any service creates a thread, so the writes happen-before every reader (STYLE-S24's stated
// exception). If a service ever starts a thread before installing its handlers, these must become
// atomics.
const char* g_line = nullptr;
ShutdownNotice g_notice = ShutdownNotice::kPrintThenStop;

// One handler; each case is the two statements the service's own handler had, in its order. The
// std::cout << ... << std::endl is not async-signal-safe and errno is not saved — kept as it was
// (LEDGER D-ERRNO; a write(2) would change line order in captured logs).
void handler(int /*sig*/) {
    switch (g_notice) {
        case ShutdownNotice::kPrintThenStop:
            if (g_line)
                std::cout << g_line << std::endl;
            g_running = false;
            break;
        case ShutdownNotice::kStopThenPrint:
            g_running = false;
            if (g_line)
                std::cout << g_line << std::endl;
            break;
    }
}

}  // namespace

std::atomic<bool>& running() {
    return g_running;
}

void installStopHandlers(ShutdownNotice notice, const char* line, Sigpipe sigpipe) {
    g_notice = notice;
    g_line = line;
    ::signal(SIGINT, handler);
    ::signal(SIGTERM, handler);
    // kDefault makes no signal() call for SIGPIPE at all (not SIG_DFL): the five
    // default-disposition services never touched it, so neither does the helper.
    if (sigpipe == Sigpipe::kIgnore)
        ::signal(SIGPIPE, SIG_IGN);
}

}  // namespace fsw::service
