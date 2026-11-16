# Research: C++ service plumbing (for WP8)

Topic brief: modern patterns for small long-running C++ daemons on Linux — signal handling,
structured lifecycle, fail-fast config, socket RAII, framework vs thin layer — measured against
WP8's constraint that today's `::signal` semantics, EINTR behaviour and per-service SIGPIPE
dispositions are preserved in behaviour. Paths are relative to `daq-server/diablo_server/` unless
they start with `deploy/`, `test/` or `docs/`. Line numbers are `backend-remastered` @ 85a02f9a
(product code = `main` @ 15b5a0c5). Every idea is labelled **ADOPTABLE** (behaviour-preserving,
may go into a WP8 pass) or **PROPOSAL** (changes something observable; for the team, never a
remaster change, per AGENT-RULES 6 / D17e).

## 0. What "today's semantics" actually are (the baseline every idea is measured against)

This section is not an idea; it is the fact base the ideas rest on, and two items in it are new
to DESIGN-WP8 §1.3.

1. **`::signal` = `sigaction` with `SA_RESTART`, handler not reset, signal masked during the
   handler.** glibc's `signal()` "calls sigaction(2) using flags that supply BSD semantics",
   equivalent to `sa.sa_flags = SA_RESTART`, provided `_DEFAULT_SOURCE` is defined (it is, by
   default under g++) — https://man7.org/linux/man-pages/man2/signal.2.html. macOS `signal(3)` is
   BSD semantics natively —
   https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/signal.3.html.
2. **`SA_RESTART` does not restart everything.** signal(7) lists interfaces that "always fail with
   EINTR … regardless of SA_RESTART": socket input calls when `SO_RCVTIMEO` is set, socket output
   calls when `SO_SNDTIMEO` is set, `select`/`poll`/`epoll_wait`, `nanosleep`/`usleep`/`sleep`/
   `clock_nanosleep` — https://man7.org/linux/man-pages/man7/signal.7.html. So *today* a SIGTERM
   already produces EINTR in exactly these of our calls, **in whichever thread takes it**:

   | call (file:line) | today on EINTR | effect of the signal landing on that thread |
   |---|---|---|
   | heartbeat main `usleep(100000)` (`services/heartbeat/heartbeat_service_main.cpp:292`) | loop re-checks `g_running` | exit ≤100 ms sooner |
   | sequencer/controller `select` 10 ms (`services/sequencer/sequencer_main.cpp:310-311`, `services/controller/controller_main.cpp:178`) | `<= 0 → continue` | negligible |
   | ota `select` 1 s (`services/ota/ota_service_main.cpp:443-445`) | `<= 0 → continue` | exit up to 1 s sooner |
   | Elodin `read_exact` with `SO_RCVTIMEO` (`transport/src/transport/TCPClient.cpp:217-221`) | **retried** (`continue`) — a fresh `SO_RCVTIMEO` wait starts | none; follower still waits ≤3 s (heartbeat) / 500 ms (stacklight) |
   | Elodin `_write_all` (`TCPClient.cpp:146-149`) | retried | none |
   | **AbortBroadcaster `sendto` with `SO_SNDTIMEO` 100 ms** (`services/sequencer/AbortBroadcaster.cpp:98-99, 115-123`) | counted as a failed repeat, logged `sendto(ABORT) repeat N failed: Interrupted system call`; the `usleep` gap at 123 is cut short | **an ABORT repeat can be lost to a SIGTERM** |
   | **ActuatorCommander `sendto` with `SO_SNDTIMEO`** (`services/sequencer/ActuatorCommander.cpp:354, 371-379`) | logged failure, batch returns false | an actuator command can be reported failed |

   The last two rows are new: a SIGTERM delivered to the sequencer worker mid-abort makes one of
   the four repeats fail (C1-10's double `triggerAbort` masks it with 8). Which thread takes a
   process-directed signal is "arbitrary" per POSIX/signal(7); on Linux `complete_signal()` tries
   the thread the signal was addressed to first — the group leader, i.e. `main` — so in practice
   Linux interrupts the main loop (rows 1–3) and macOS may hit any thread
   (https://github.com/torvalds/linux/blob/master/kernel/signal.c, `complete_signal`). **Report as
   a defect candidate (Defects, not fixed):** "SIGTERM during an abort can drop an ABORT repeat
   (EINTR on `SO_SNDTIMEO` sendto); rare on Linux because the leader usually takes the signal."
3. **Our handlers are not async-signal-safe**, and also do not save `errno`. signal-safety(7):
   errno access is safe only "provided that the signal handler saves errno on entry and restores
   its value before returning" — https://man7.org/linux/man-pages/man7/signal-safety.7.html.
   The `std::cout << … << std::endl` in eight handlers (DESIGN-WP8 §1.3) can clobber `errno`
   between a failing syscall and the `strerror(errno)` that reports it in the interrupted thread
   (e.g. `AbortBroadcaster.cpp:120-121`). Same defect class as BLOAT-MAP defect 6; park, don't fix.
4. **Masks and ignored dispositions cross `fork`/`exec`.** "A child created via fork(2) inherits a
   copy of its parent's signal mask; the signal mask is preserved across execve(2)" (signal(7));
   ignored dispositions stay ignored across exec, caught ones reset to default —
   https://man7.org/linux/man-pages/man2/execve.2.html. We fork in two places:
   ota's `pio` build (`services/ota/ota_service_main.cpp:218-245`) and daq_bridge's `popen`
   (`daq_bridge/daq_bridge_main.cpp:453`). Today `pio` therefore already runs with SIGPIPE
   **ignored** (ota sets `SIG_IGN` at 408) and SIGINT/SIGTERM at default. Also: the ota child calls
   `std::to_string`/`setenv` (allocating) between `fork` and `exec` in a multithreaded process,
   which fork(2) forbids ("the child can safely call only async-signal-safe functions … until …
   execve") — https://man7.org/linux/man-pages/man2/fork.2.html. Defect candidate (child deadlock
   if another thread held the malloc lock at fork); park.

## 1. Idea: keep `::signal`; if anything, spell it as `sigaction(SA_RESTART)` — ADOPTABLE, not recommended

**What.** Modern guidance is "use sigaction, not signal" (signal(2) portability note above).

**Maps to.** DESIGN-WP8 §2.1 `installStopHandlers` (one handler, `switch` on `ShutdownNotice`).

**Equivalence.** `sigaction` with `sa_flags = SA_RESTART`, empty `sa_mask` (the kernel still masks
the delivered signal because `SA_NODEFER` is absent) is exactly what glibc's `signal()` installs
(§0.1). So it is behaviour-identical on Linux; on macOS `signal(3)` also installs `SA_RESTART`
unless `siginterrupt` was called (we never call it). Any other flag set is a behaviour change:
no `SA_RESTART` → every *restartable* call (`accept`, `recv` without timeout, `waitpid` at
`ota_service_main.cpp:259`, `read` on the ota build pipe) starts returning EINTR, which none of
those sites handle (`waitpid < 0` → `"waitpid failed"`); `SA_RESETHAND` → a second SIGTERM kills
with −15.

**Cost.** ~6 lines; a diff with no observable benefit. DESIGN-WP8 already decided `::signal`.
**Verdict.** Agree with DESIGN-WP8: keep `::signal`. Record the equivalence so a reviewer
proposing `sigaction` knows the only safe flag set. **Guard it:** the lifecycle SIGPIPE gap
(DESIGN-WP8 §7.2-1) plus a "second SIGTERM does not kill" case (send SIGTERM twice 50 ms apart to
heartbeat; expect exit 0, not −15) catches `SA_RESETHAND`; nothing black-box catches a dropped
`SA_RESTART` except the ota `waitpid` path during a flash (gap 9).

## 2. Idea: move signal work out of the handler — self-pipe / sigwait thread / signalfd — PROPOSAL

**What.** Three standard ways to make the handler trivially safe and turn the signal into an
event: (a) **self-pipe** — handler `write()`s one byte to a non-blocking pipe that the loop
`select`s on (D. J. Bernstein, https://cr.yp.to/docs/selfpipe.html); libuv does exactly this,
installing its handlers with `SA_RESTART` and writing a message to the loop's signal pipe
(https://github.com/libuv/libuv/blob/v1.x/src/unix/signal.c, `uv__signal_register_handler`);
(b) **sigwait thread** — block SIGINT/SIGTERM with `pthread_sigmask` before creating any thread,
one thread loops on `sigwait` and does the shutdown work in normal context
(https://man7.org/linux/man-pages/man3/pthread_sigmask.3.html); (c) **signalfd** (Linux only) —
signals "should be blocked using sigprocmask(2)" and are read as fd events
(https://man7.org/linux/man-pages/man2/signalfd.2.html); macOS needs kqueue `EVFILT_SIGNAL`
instead, so (c) costs a second implementation for our Mac dev/test loop.

**Maps to.** The eight printing handlers (DESIGN-WP8 §1.3 table); the loops in §0.2's table.

**Exactly what each changes (why this is a proposal):**

| change | observable effect | where a test would see it |
|---|---|---|
| `Shutting down…` printed outside the handler (any of a/b/c) | position of that line relative to lines other threads print in the same instant; daq_bridge's flag-then-print order (`daq_bridge_main.cpp:108-111`) stops meaning anything | DESIGN-WP8 gap 3 (line + position), once written |
| (b)/(c): signals blocked in all worker threads | the main loop no longer gets EINTR: ota exit goes from "usually immediate on Linux" to up to 1 s; heartbeat main up to +100 ms; AbortBroadcaster/ActuatorCommander can no longer lose a send to EINTR (fixes §0.2's defect) | `shutdown.txt` bounds are `[0, 1.6]` (ota) and `[0, 3.6]` (heartbeat): **the goldens would stay green** — the latency change is real but uncaught |
| (b)/(c): blocked mask inherited by children | `pio` (ota, `:243`) and the `popen` child (daq_bridge `:453`) start with SIGINT/SIGTERM **blocked** unless the child unblocks before `exec`; a `systemctl stop` (KillMode=control-group sends SIGTERM to every process in the unit) no longer stops a running `pio` until `TimeoutStopSec` → SIGKILL (https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) | not characterized (gap 9 is nice-to-have) |
| (a) self-pipe with the existing `select` loops | sequencer/controller/ota wake at once on a signal **in any thread** (not only when the leader takes it): shutdown gets faster and deterministic | within bounds; uncaught |
| (b) sigwait thread | one more thread per process; the signal TU must create it before any other thread, which fixes the install point (DESIGN-WP8 §1.2 shows nine different install points, and a signal before install is exit −15) | lifecycle exit-code cases if the thread start moves |

**Cost.** Small code (≈60 lines shared), large review: every loop that should wake needs the fd
added; children need `pthread_sigmask(SIG_SETMASK, &empty)` between fork and exec (async-signal-
safe, fine) — or `posix_spawn` with `POSIX_SPAWN_SETSIGMASK`, which also removes §0.4's
allocate-after-fork defect (https://man7.org/linux/man-pages/man3/posix_spawn.3.html).
**Recommended proposal for the team:** (a) self-pipe + handler that does only `running=false;
write(pipe)` with errno saved, printing moved to the loop, **plus** a characterization case that
pins the shutdown line order first. It is the only option that works unchanged on Linux and macOS
and does not touch masks inherited by `pio`.

## 3. Idea: `std::jthread` + `std::stop_token` + `std::stop_callback` for thread lifecycle — ADOPTABLE only in one narrow form; the useful parts are PROPOSALS

**What.** C++20 `std::jthread` requests stop and joins in its destructor; `std::stop_callback`
runs a callable when stop is requested — the standard hook for unblocking a thread parked in a
syscall, since a stop token alone cannot interrupt `recv`
(https://en.cppreference.com/w/cpp/thread/jthread, https://en.cppreference.com/w/cpp/thread/stop_callback;
design paper P0660, https://wg21.link/p0660). Toolchains: `CMAKE_CXX_STANDARD 20`
(`daq-server/CMakeLists.txt:4`); verified a jthread + stop_callback TU compiles with Apple clang 21
on this Mac; CI's gcc-12 libstdc++ has had it since GCC 10; libc++ marked it non-experimental in
LLVM 18 (https://libcxx.llvm.org/ReleaseNotes/18.html) — CI's clang-18 is fine either way.

**Maps to and verdict per site:**

| site | today | with jthread/stop_callback | verdict |
|---|---|---|---|
| `serveTcpClients` (DESIGN-WP8 §2.3; `sequencer_main.cpp:282-351`, controller 151-216) | `Conn{th, fd, done}`; after loop `shutdown(fd)` **all**, then join **all** | `std::stop_callback` per conn doing `shutdown(fd, SHUT_RDWR)`; but `vector<jthread>` destruction does stop+join **one at a time** (conn 2 keeps serving while conn 1 joins) | ADOPTABLE only as two explicit loops (`request_stop()` all, then `join()` all) — i.e. the same code with different spelling. Low value; do not do it in WP8. |
| heartbeat/stacklight follower (`followSequencerState`, DESIGN-WP8 §2.4) | exits after ≤ `kElodinRecvTimeoutMs` (3000) because `read_exact` retries EINTR and waits the timeout (§0.2) | stop_callback calls `shutdown()` on the Elodin fd → exit in ms | **PROPOSAL**: heartbeat SIGTERM latency 3.6 s → ~0.1 s; would also need `ElodinClient` to expose the fd, and `read_exact` would see `0`/error → the `Elodin read failed … reconnecting` cerr line at shutdown (new log line). |
| controller control thread, **detached** (`controller_main.cpp:500-501`) | `main` returns while it may sit in `select`; C4-5 ">3 s to exit" | jthread joins it | **PROPOSAL** (changes exit timing; DESIGN-WP8 §3 forbids). |
| ota client threads, **detached** (`ota_service_main.cpp:451-453`) | process exits with a flash in flight | joined → SIGTERM waits for a 60 s flash | **PROPOSAL**; arguably worse for operators; needs a team call. |
| sequencer worker deadlock **C4-1** | SIGTERM never exits (join waits on a deadlocked worker) | jthread does not help: stop tokens cannot break a mutex self-deadlock | Neither. The stand behaviour is systemd's: default `TimeoutStopSec` then SIGKILL (`deploy/systemd/sensor-actuator.service` sets none). **PROPOSAL** (deploy): an explicit `TimeoutStopSec=` so the operator knows the bound. |
| t7_bridge `nap()` 100 ms slices (`services/t7_bridge/t7_bridge_main.cpp:94-98`) | polls `g_running` | `condition_variable_any::wait_for(lock, stop_token, d, pred)` wakes at once | PROPOSAL (≤100 ms faster exit), negligible value. |

**Cost.** Low per site; the value is entirely in the latency changes, which is why the valuable
uses are proposals. **Trap for the debate:** `jthread`'s destructor joins, so a `jthread` member
silently turns a detached thread into a joined one — exactly the controller/ota lifetimes
DESIGN-WP8 §3 says must not move.

## 4. Idea: fail-fast config validation with a "do not restart" exit code — PROPOSAL (with an in-tree precedent)

**What.** Parse → validate into a typed settings struct, collect *all* errors, print them, exit
with a dedicated status; tell the supervisor not to restart on that status. systemd:
`RestartPreventExitStatus=` "will prevent automatic service restarts, regardless of the restart
setting" (systemd.service URL above). BSD `sysexits.h` names `EX_CONFIG` = 78 for this
(https://man.freebsd.org/cgi/man.cgi?query=sysexits). toml++ already reports `toml::parse_error`
with a source region (line/column) (https://marzer.github.io/tomlplusplus/classtoml_1_1parse__error.html).

**Precedent in our tree.** `deploy/systemd/sensor-t7.service:21-22` already does this:
`Restart=on-failure` + `RestartPreventExitStatus=2 3`, matching t7_bridge's exit 2 (bad argv/T7
config) and 3 (no LJM). Every other C++ unit is `Restart=always` + `RestartSec=5`.

**Maps to (all defects already in the ledger, so all PROPOSALS):**

- C2-4: `config::load` catches `toml::parse_error` and returns defaults
  (`lib/src/config/Config.cpp:446-452`) — a service starts on defaults after a typo.
- D-SLOT: slot > 8 only warns (`Config.cpp:49-53`) and the table id wraps onto PT2.CH1.
- C2-12 vs daq_bridge: the same bad env board id is SIGABRT (−6) in config_broadcast, exit 1 in
  daq_bridge — two policies for one error.
- C6-9: calibration exits 1 when Elodin is not up — the opposite mistake (fatal on a transient).
- C2-2: profile TOMLs never checked for underscore ints.

**Proposal shape.** One `validate(const Config&) -> std::vector<std::string>` in `fsw_daq_lib`,
called by every service right after `config::load`; non-empty → print each error, `exit(78)`;
every unit gets `RestartPreventExitStatus=78` (otherwise `Restart=always` turns fail-fast into a
5 s crash loop, which is what `sensor-elodin.service` comments already complain about). Transient
conditions (Elodin down, NIC not up) stay retry, not fatal — the C6-9 fix is the inverse rule.
**Cost.** Medium: changes exit codes (frozen, DESIGN-WP8 §4), unit files, and the config goldens
(`test/characterization/config/golden/bin/`); needs a team list of which checks are fatal.
**Nothing here is adoptable in the remaster**: even a validator that only *logs* adds lines to
the config goldens. A `--check-config` flag changes `--help` text (DESIGN-WP8 gap 4).

## 5. Idea: socket RAII (`unique_fd`) vs a framework (asio / libuv / sd-event) — thin layer wins; RAII ADOPTABLE only where close is already at scope end

**RAII.** Android's `android::base::unique_fd` is the reference design: move-only owner, explicit
`reset()`/`release()`, closes in the destructor
(https://android.googlesource.com/platform/system/libbase/+/refs/heads/main/include/android-base/unique_fd.h).
DESIGN-WP8 §0 rejected an owning `UdpSender` because RAII moves `close()` to scope end. Checked
per site:

| site | today's close points | RAII identical? |
|---|---|---|
| AbortBroadcaster `sendPacket` (`AbortBroadcaster.cpp:80-125`) | only exit after socket success is the single `close` at 125 | **yes** — ADOPTABLE (a `UniqueFd` local; same close instant) |
| ActuatorCommander `sendBatch` (`ActuatorCommander.cpp` 343-390) | `close` on bind failure and at the end, both function exits | **yes** — ADOPTABLE (WP10's file, not WP8's) |
| heartbeat process socket | `close(sock)` **before** `elodin_thread.join()` (`heartbeat_service_main.cpp:295-296`) | only with an explicit `reset()` there — then RAII buys nothing |
| sequencer/ota listeners | closed after clients joined; `shutdown.txt` checks "command port still accepting: False" | early-exit `return 1` paths close today too; identical, but the listener is what `lifecycle/stack.py:358-362` warns about (Linux keeps a select()ed socket bound) — leave it |
| controller listener | leaks on `kListen` (fall through, DESIGN-WP8 §2.3) and in the detached thread | RAII would close it when `runControlServer` returns — changes nothing visible today but is not "statement for statement"; leave |

Value is small (two per-send sites, both already correct). Not worth a type with two users in WP8.

**Frameworks.**

| | asio (standalone, header-only) | libuv | sd-event (libsystemd) | thin in-house (DESIGN-WP8) |
|---|---|---|---|---|
| macOS dev/test | yes | yes | **no** (Linux-only; https://www.freedesktop.org/software/systemd/man/latest/sd-event.html) | yes |
| signals | `signal_set`; "the application must not also register a signal handler using functions such as signal() or sigaction()"; restart semantics are a per-registration flag (`signal_set_base::flags::restart`) — https://think-async.com/Asio/asio-1.30.2/doc/asio/reference/signal_set.html | owns the handler, `SA_RESTART`, self-pipe (§2) | signalfd; requires blocking signals (§2 child-mask trap) | `::signal`, per-service notice + SIGPIPE table |
| loops | proactor/reactor replaces every `select`+timeout loop | same | same | loops stay where they are |
| what it changes | print-in-handler impossible → line order; EINTR model replaced; wake latency of every loop; thread model of 9 mains | same | same, plus mask inheritance into `pio`/`popen` | nothing (by construction) |
| dependency | ~header-only, Boost-free | C lib | systemd only | none |

Every framework replaces the thing the contract freezes (loop timing, handler output, EINTR
exposure). For ~7 tiny mains whose loops are 10–40 lines each, the frameworks' wins (timers,
async DNS, cross-platform polling) are features we don't use. **Verdict:** thin in-house layer as
DESIGN-WP8 specifies; a framework is a PROPOSAL only if the team ever wants event-driven
shutdown (§2a gives that for ~60 lines without a dependency). `sd_notify` readiness
(`Type=notify`, `READY=1`, `WatchdogSec=`, systemd.service URL above) is the one systemd feature
worth proposing on its own: it would let `sensor-*` ordering wait for "listening" instead of
"exec'd" — but it is a deploy + log-free behaviour change, so PROPOSAL.

## 6. Summary for WP8

- **Adoptable inside the remaster:** keep `::signal` (or the exactly-equivalent
  `sigaction(SA_RESTART)` with no other flags — not recommended); `UniqueFd` only at
  AbortBroadcaster/ActuatorCommander per-send sockets (marginal). DESIGN-WP8 as written already
  preserves everything this research found observable.
- **Proposals for the team:** self-pipe handler + printing in the loop (§2a); stop_callback →
  `shutdown(fd)` for followers (§3); `posix_spawn` with a reset mask for ota/daq_bridge children;
  fail-fast config with `exit(78)` + `RestartPreventExitStatus=78` (§4); explicit
  `TimeoutStopSec=` for the sequencer unit (C4-1); `sd_notify` readiness.
- **New defect candidates (report, don't fix):** (1) SIGTERM during an abort/actuator batch can
  fail a `sendto` with EINTR (`SO_SNDTIMEO` sockets are never restarted) — an ABORT repeat lost;
  (2) handlers don't save `errno`; (3) ota allocates and `setenv`s between `fork` and `exec` in a
  multithreaded process.
- **Characterization gaps this adds to DESIGN-WP8 §7.2:** a "second SIGTERM" case (catches
  `SA_RESETHAND`); tighter *lower* information for ota/heartbeat shutdown latency if the team
  wants §2/§3 changes to be visible (today's `[0, x]` bounds cannot see a slowdown inside x).

## Questions for the debate advocates

1. The shutdown goldens are `[0, upper]` bounds. A sigwait/signalfd design makes ota up to 1 s
   slower on Linux and stays green. Is "within the golden's bound" the contract, or is "no
   observable change" (D5) — and if the latter, who writes the case that would see it?
2. The EINTR-on-`SO_SNDTIMEO` loss in `AbortBroadcaster` is exactly the kind of behaviour a
   remaster must preserve. Should WP8 add a characterization case for it (SIGTERM the sequencer
   mid-abort; count ABORT repeats), or is it too timing-dependent to freeze?
3. If the team adopts self-pipe shutdown, does the `Shutting down…` line move to before or after
   the service's teardown lines — and is the daq_bridge flag-then-print order meant, or accidental?
4. For fail-fast config: which of D-SLOT, C2-2, C2-4, underscore ints, unknown keys is fatal, and
   is exit 78 + `RestartPreventExitStatus` acceptable on a stand where "service came back on
   defaults" has been the failure mode so far?
5. Is anyone relying on `pio` inheriting SIGPIPE-ignored from ota? A `posix_spawn` cleanup that
   resets dispositions would change it.
6. Should `sensor-actuator.service` (sequencer) carry an explicit `TimeoutStopSec` now, given C4-1
   means a SIGTERM can hang until systemd's default kill timeout?
