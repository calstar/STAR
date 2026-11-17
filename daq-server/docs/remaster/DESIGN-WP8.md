# DESIGN-WP8 — shared C++ service plumbing

The "as decided" execution note for WP8 (D17(a)): what an implementer does, in what order, and
why. Decisions: D39 (review), D43 (casing, `// Kept:`), D45 (deepening), D46 (tag long form),
and the debate verdict (`debates/WP8/verdict.md`, ratified under D39; LEDGER **D54**). How it got
here — the reviewed text, its amendments, the withdrawn `UdpSocket`/`ConfigFile` interfaces, the
alternatives (B RAII types, C signals only), the walkthroughs and the first gate classification —
is preserved verbatim in [`debates/WP8/history.md`](debates/WP8/history.md).

**Baseline.** Every line number below is from `git show backend-remastered:daq-server/<path>` at
`backend-remastered` @ **`91ee0bc8`**, whose `diablo_server/` is byte-identical to `main` @
`15b5a0c5` (and to `b2599617`, the reviewed note's anchor). Paths are relative to
`daq-server/diablo_server/` unless they start with `test/`, `docs/` or `lib/CMakeLists.txt`. C1
(`packets/`, `elodin/`) is on the tip. Function names, not numbers, are the contract: if WP3
lands first, re-anchor with `grep -n`.

**Prerequisites.** Pass 1: §7.2 gaps 1-3 (`lifecycle/`) merged and gated. Pass 2: gaps 4, 5, 7
(`config/`, `sequencer/`, `packets/`) merged as one D32 batch. Pass 1 never waits on gaps 5-7.
The passes are **separate queue items, each fully gated** (full gate + Linux leg + CI, D19).

**Scope.** WP3 → **WP8** → WP9 → WP10. WP8 edits only
`services/{heartbeat,stacklight,config_broadcast,ota,controller}/*_main.cpp`,
`services/sequencer/sequencer_main.cpp`, `services/t7_bridge/t7_bridge_main.cpp` and the new TUs
in `fsw_daq_lib`. **`AbortBroadcaster.cpp` is untouched** (verdict ruling 4: compiled into six
ctest executables, two timing-judged). `calibration_main.cpp` adopts `StopSignals` in WP9's
cleanup and `daq_bridge_main.cpp` in WP10's; §2.1's table fixes their settings. WP8 does not edit
`SequencerService.cpp`, `ActuatorCommander.cpp`, `ControllerService.cpp`, `PressureFeed.cpp`.

**Rules applied:** D5, D12(e), D17, D18/D20, D31/D34, D32, D42 (bindings 1 and 2); STYLE-S1
(D43(2): `fsw::service` and `fsw::net` camelCase, `fsw::elodin` snake_case), S12, S14, S15, S21,
S22, S24, S25, S26, S34; LEDGER Parked "SIGPIPE disposition"; D-CTL, D-BIND and D-FD stay as they
are (reported, never fixed).

## 0. The decision

BLOAT-MAP proposed four shared pieces (`UdpSender`, `LineCommandServer`, `SubscriberLoop`,
`ServiceMain`). Read against the source, most "copies" differ in ways a test or an operator can
see: SIGPIPE, handler print order, backlog, select timeout, client cap, thread lifetime, read
discipline, reconnect cadence, which failures are fatal. D17 forbids a uniform pattern that
changes any of that and an abstraction with one user. What survives, after the debate:

| shared | users (today's lines) | pass | gate |
|---|---|---|---|
| `fsw::service::running()`, `installStopHandlers` — §2.1, `::signal`, install points of §1.2 | the seven WP8 services; calibration (WP9), daq_bridge (WP10) | **1** | gaps 1, 2, 3 |
| `fsw::net::serveTcpClients` + `TcpServeOptions`; `Conn`, `reap_finished` verbatim from `sequencer_main.cpp:284-301`; `on_client` only through the public enqueueing API (D42 binding 1) | sequencer 303-349, controller 171-214 | **2** | gap 5 |
| `fsw::elodin::follow_sequencer_state` + `SequencerStateFollowerText`, called from each main's file-static wrapper | heartbeat 103-152, stacklight 99-136 | **2** | gap 7 |
| file-static `parseArgs` per main (§6.2; t7's `exit(2)` verbatim) | seven mains | 2 | gap 4 |
| `// Kept:` tags, S12 long form (D46) | `controller_main.cpp:147` (D-CTL); heartbeat 252, config_broadcast 526 (D-BIND) | 2 | — |

**Stays per service, every `close()` on its line:** listener setup (sequencer 252-276, controller
128-147, ota 410-434); UDP sockets and destinations (heartbeat 232-263, stacklight 268-282,
config_broadcast 509-531 and 554-558); `AbortBroadcaster.cpp`; the config-path blocks (heartbeat
202-213, stacklight 211-228, config_broadcast 468-485, controller 276-301); per-client readers;
`trim`; encoders. ota adopts `StopSignals` only.

Rejected, with the reason kept so a later package does not reintroduce it:

- **`openTcpListener` / `TcpListener{fd, failed, err}`** (debate). Its "closed by the callee on
  `kBind`" closes before the caller's `bind() failed` line at all three callers
  (`sequencer_main.cpp:267-269`, `ota_service_main.cpp:425-427`, `controller_main.cpp:142-145`):
  log, `close`, return today; `close`, log, return after. Unobservable, but not statement for
  statement. `kListen` has one user (the controller ignores `listen()`); the three failure
  ladders stay in three mains anyway.
- **`openUdpSocket(bool)`** (debate). With `AbortBroadcaster.cpp` untouched, `openUdpSocket(true)`
  has one user (heartbeat); `openUdpSocket(false)` saves one line at two sites.
- **`ipv4Destination`** (debate). heartbeat 255-263 and stacklight 274-282 agree; config_broadcast
  zeroes and sets the family once (529-531) and fills `sin_addr`/`sin_port` per packet (554-558),
  so it is a third user only by reordering.
- **`find_config_file` / `read_file_text`** (debate, D49). A second open in stacklight,
  config_broadcast and the controller, and the controller's four log lines (280, 287, 292, 299)
  rebuilt from flags. No golden needs either.
- **`UniqueFd`.** No WP8 helper opens or returns an fd; every socket is opened and closed in its
  main as today. It is the header the D-FD/D-CTL fix package mints (§8).
- **`ServiceMain` / a framework `main`.** No two services start in the same order (§1.2);
  a SIGTERM before installation kills with −15, after it exits 0; a framework that owns the order
  changes exit codes. **A shared argv parser:** nine flag sets and `--help` texts, three
  missing-value policies (ignore / t7's `exit(2)` / daq_bridge's `std::stoi` that throws), two
  unknown-flag policies; each main keeps its loop, pass 2 only moves it into a file-static
  `parseArgs()`. **A generic `SubscriberLoop`:** the eight B3 sites are four different things
  (§1.7); only the two identical followers are shared. **An owning `UdpSender` / RAII sockets:**
  AbortBroadcaster and ActuatorCommander open a socket per send, heartbeat closes its socket
  **before** joining the Elodin thread (295-296), ControllerService closes in its destructor — a
  type bypassed at its first three users is not the abstraction (S34).
- **`transport/NetworkSocket.hpp` `UDPSocket`** sets `O_NONBLOCK`/`SO_REUSEADDR` and binds in its
  constructor (`transport/src/transport/NetworkSocket.cpp:17-60`): a non-blocking `sendto` changes
  what a full send buffer does. **A shared `trim()`:** stacklight and config_broadcast strip `"`
  too (`stacklight_service_main.cpp:141-145`, `config_broadcast_service_main.cpp:55-59`); ota and
  sequencer do not (`ota_service_main.cpp:50-54`, `sequencer_main.cpp:60-64`); stacklight's is
  reached by the config harness (§7.3). **B4 encoders** PARKED: WP8 touches none.
  **`elodin::PacketHeader`** for the `buf[5]/buf[6]` reads: nothing a golden could confirm.

## 1. Baseline (what the code does today)

### 1.1 Per service: threads and flags

No service main holds a mutex except t7_bridge's `g_log_mutex` (59, a leaf taken only in
`Line::~Line`). Cross-thread state is atomics only.

| service (file, lines) | threads | cross-thread state |
|---|---|---|
| heartbeat (`services/heartbeat/heartbeat_service_main.cpp`, 299) | main: send loop 276-293; `elodinThread` 103-152 | `g_running` 37, `g_engine_state` 38 |
| stacklight (`services/stacklight/stacklight_service_main.cpp`, 348) | main: send loop 305-341; `elodinThread` 99-136 unless `--force-state` 289-296 | `g_running` 33, `g_seq_state` 34 |
| config_broadcast (`services/config_broadcast/config_broadcast_service_main.cpp`, 607) | main only, loop 545-602 | `g_running` 44 |
| ota (`services/ota/ota_service_main.cpp`, 459) | main: accept loop 439-454; one **detached** thread per client 451-453 running `handleClient` 300-375 (may fork `pio`, 218) | `g_running` 43; `g_bind_address` 62 written once before threads |
| sequencer (`services/sequencer/sequencer_main.cpp`, 354) | main: accept loop 303-341; one tracked thread per client 333-340 (`handleClient` 197-222); plus `SequencerService`'s (WP10) | `g_running` 46; `Conn::done` 284-288; `conns` touched only by main |
| controller (`services/controller/controller_main.cpp`, 514) | main: wait loop 507-509; **detached** `control_thread` 500-501 running `runControlServer` 127-217, one tracked thread per client (`handleControlClient` 75-125); plus `ControllerService`'s (WP10) | `g_running` 54 (static); `Conn::done` |
| t7_bridge (`services/t7_bridge/t7_bridge_main.cpp`, 356) | main: joins 353-354; one thread per enabled T7, `run_board` 159-274 | `g_running` 56 |
| calibration (`services/calibration/calibration_main.cpp`) / daq_bridge (`daq_bridge/daq_bridge_main.cpp`) | WP9 / WP10 | `running` 154 (static) / `running` 106 (**external linkage**) |

### 1.2 Startup order (observable: a signal before installation is fatal; log line order)

| service | order today (lines) |
|---|---|
| heartbeat | argv 179-199 → config path fallback 202-213 → `config::load` 217 → precedence 218-226 → **signals 228-229** → UDP socket + `SO_BROADCAST` 232-240 → NIC resolve (fatal) + bind (result ignored) 246-253 → dest 255-263 → 2 start lines 265-268 → Elodin thread 271 → loop |
| stacklight | argv 186-208 → fallback + read text 211-228 → `getTomlValue` overrides 230-262 → **signals 264-265** → socket 268-272 → dest 274-282 → 2 start lines 284-287 → `--force-state` line or Elodin thread 289-296 → loop |
| config_broadcast | argv 456-466 → fallback + read text 468-485 → empty → exit 1 487-490 → `config::load` for interval 493-496 → **signals 498-499** → `buildPackets` 503 (+ warning 504-507) → socket 509-513 → NIC resolve (fatal) + bind (ignored) 519-527 → 2 start lines 533-535 → loop |
| ota | argv 383-396 → NIC resolve (fatal) 398-404 → **signals + SIGPIPE ignore 406-408** → listen socket 410-434 → 2 start lines 436-437 → loop |
| sequencer | argv 229-239 → **signals + SIGPIPE ignore 241-243** → `svc.init` (exit 1) 245-249 → listen socket 252-276 → 2 start lines 278-280 → loop |
| controller | argv 239-273 → config text with logged fallbacks 276-301 → `config::load` 303 → `loadStatesFromConfig` 310 → PWM/NIC/settings 313-352 (NIC fatal 328-332) → banner 355-394 → fire state 401-423 → gate posture 430-451 → LUT paths 453-460 → `service.initialize` (exit 1) 462-465 → command 468-487 → **signals 490-491** → `service.start` (exit 1) 494-497 → control thread 500-501 → start line 503 → wait loop |
| t7_bridge | argv 279-309 → no-LJM check (exit 3) 311-318 → `config::load` 320 → t7 errors (exit 2) 321-326 → board filter (exit 0) 328-337 → **signals + SIGPIPE ignore 343-345** → start line 347 → threads 349-352 |
| calibration | argv 602-617 → adjustments discovery 619-651 → 2 start lines 653-654 → **signals 656-657** → WP9 |
| daq_bridge | positional argv 309-318 → start lines 320-323 → config exists (exit 1) 330-339 → **signals + SIGPIPE ignore 341-344** → WP10 |

### 1.3 Signal handling today

All nine use `signal()`/`std::signal()` (BSD semantics on glibc and macOS: `SA_RESTART`, handler
stays installed; research `cpp-service-plumbing.md` §0.1); none uses `sigaction`. Seven handlers
print `"\n[<Tag>] Shutting down..."` (controller: `"\n[controller_service] Caught signal, shutting
down…"`, U+2026) **then** clear the flag; daq_bridge's `signal_handler` (108-111) clears the flag
**first**, then prints; t7_bridge's `on_signal` (83-85) only clears the flag. Handler lines and
exact strings are the "replaces" column of §2.1's table. **SIGPIPE** is ignored by ota (408),
sequencer (243), t7_bridge (345) and daq_bridge (344) and takes its default (the process dies,
−13) in heartbeat, stacklight, config_broadcast, controller and calibration — LEDGER Parked
"SIGPIPE disposition" verbatim, a per-service setting until the team decides. Every reply on a TCP
command socket uses `MSG_NOSIGNAL` (`sequencer_main.cpp:75,326`, `controller_main.cpp:97,192`,
`ota_service_main.cpp:305`); what can kill a default-disposition service is a write to the Elodin
socket (`transport/src/transport/TCPClient.cpp:148`, `::write`), i.e. a db restart.

### 1.4 CLI and config loading today

Flags, `--help` texts and config resolution are per service and stay so (gap 4 pins the help
texts): argv loops at heartbeat 179-199, stacklight 186-208 (help **omits `--force-state`**;
**config overrides CLI**, C1-11/C6-7), config_broadcast 456-466, ota 383-396, sequencer 229-239,
controller 239-273, t7_bridge 280-309 (`<flag> needs a value` → `exit(2)` 283-286; unknown flag →
usage, **exit 2**), calibration 602-617 (WP9), daq_bridge positional `argv[1..3]` 313-318
(`std::stoi(argv[3])` throws on junk). Config-path fallbacks: heartbeat 202-213 (silent),
stacklight 211-228 and config_broadcast 468-485 (read the text; empty → `[ConfigBroadcast] No
config loaded`, exit 1, 487-490), controller 276-301 (**three** paths, four log lines: `❌ Cannot
open config: …` 280, `ℹ️  Using fallback config: …` 287, `❌ No config.toml found. Using
defaults.` 292, `📋 Loaded config: …` 299). Elsewhere missing values and unknown flags are
ignored; `--help` exits 0 everywhere. `config::load` (`lib/src/config/Config.cpp`) logs and
returns defaults on a missing or malformed file (C2-4); no shared code may wrap it in `try` or add
a check — config_broadcast's uncaught `std::invalid_argument` → SIGABRT is frozen in
`test/characterization/config/golden/bin/` (C2-12).

### 1.5 UDP senders (B1) — all stay where they are

heartbeat 232-263 (`SO_BROADCAST`; `resolveDaqBindAddress` fatal, `bindToDaqInterface` result
ignored at 252; `Invalid broadcast IP`, exit 1), stacklight 268-282 (no bind; `Invalid target IP`),
config_broadcast 509-531 (resolve fatal, bind ignored at 526) with `inet_pton`/`sin_port` per
packet 554-558 (`tx_bad_addr` on failure), `AbortBroadcaster::sendPacket`
(`services/sequencer/AbortBroadcaster.cpp:80-125`: socket per send, `SO_BROADCAST` 86-87, bind
non-fatal 91-94, `SO_SNDTIMEO` 100 ms 98-99, `close` 125 before the summary 127-133). Not WP8's:
`ActuatorCommander::sendBatch` (343-390), `ControllerService::initialize`
(`lib/src/control/ControllerService.cpp:92-103`), daq_bridge's `BackendLogForwarder` (54-90).

### 1.6 TCP command servers today (B2)

| | sequencer (`sequencer_main.cpp`) | controller (`controller_main.cpp`) | ota (`ota_service_main.cpp`) |
|---|---|---|---|
| port / runs on | `--port`, default 9998 / main thread | `[controller_service].port` or `--control-port` / detached thread 500-501 | `--port`, default 9997 / main thread |
| socket/bind/listen | 252-276; each failure logged, `close`, **exit 1** | 128-147; socket/bind failure logged with `strerror`, `close`, **return — the service keeps running without its control port** (D-CTL); `listen()` result ignored at 147 | 410-434; logged, `close`, exit 1 |
| backlog / ready log | 10 / `[Sequencer] Listening on port N` + command list 278-280 | 4 / `[ControllerService] 🎮 Control server on TCP :N  (FIRE_START | FIRE_STOP)` 148-149 | 5 / `[OTAService] Listening on port N` 436-437 |
| select timeout / cap | 10 ms (310) / `kMaxClients` 64 (51), reap before and after accept | 10 ms (174) / `kMaxControlClients` 64 (72), same | 1 s (443) / none |
| busy reply | `"ERR:too many connections\n"`, `MSG_NOSIGNAL`, cerr `[Sequencer] client limit (64) reached — refusing connection` 325-329 | same bytes; `[ControllerService] ⚠️  client limit (64) reached — refusing connection` 191-195 | — |
| client threads | tracked `Conn{th, fd, done}` 284-288, joined; at exit `shutdown(fd, SHUT_RDWR)` all, join all 345-349, then `close(listen_fd)` 351 | identical 152-156, 210-214, 216 | **detached** 451-453, never joined |
| per-client read | `SO_RCVTIMEO` 5 s; 512-byte chunks; every `\n` line dispatched; `buf.size() > 512` → `oversized command — dropping connection` (197-222) | `SO_RCVTIMEO` 5 s; ≤ 64 bytes; first line; one reply (75-125) | `SO_RCVTIMEO` 30 s; one byte per `recv` (311); first line; one reply (300-375) |

The two accept loops share every syscall and branch (verdict ruling 2); the textual differences
(`tv` before `fd_set` in the controller, 174-177 vs 307-310; `timeval` init style; names; `::`
qualifiers; the busy prefix bytes; capture `&svc`/`svc`) have no effect.

### 1.7 Elodin subscribe sites (B3)

The two followers — heartbeat `elodinThread` 103-152 (`sleep_for(2 s)` 109; 3000 ms
`kElodinRecvTimeoutMs` 41; cerr `Elodin read failed (<err>) — reconnecting` 135-137) and stacklight
`elodinThread` 99-136 (2 s at 105; 500 ms `kStacklightRecvTimeoutMs` 97; silent `disconnect` 123)
— are identical in control flow (ruling 3): connect → 2 s → subscribe → cerr + `disconnect` →
timeout → cout → `read_packet` → `n < 0` disconnect → `n < 8` → `buf[5]/buf[6]`, `n >= 17`.
Differences: three literals, the timeout, and whether `n < 0` logs. Everything else stays its
owner's: `PressureFeed::runLoop` (`services/sequencer/PressureFeed.cpp:78-193`),
`ControllerService::connectSubscriber`/`elodinSubscriberLoop` (`ControllerService.cpp:763-818`,
WP10), calibration 1477-1595 (first connect `return 1` at 1544-1545; WP9), the publishers
`SequencerService.cpp:1253-1293`, t7_bridge 195-206, daq_bridge 574-606 and 745-776.

## 2. Interfaces

All new code goes into `fsw_daq_lib` (`lib/CMakeLists.txt` `FSW_SOURCES`, appended at the end) so
every service and the config harness (`test/characterization/config/CMakeLists.txt`, which links
`fsw_daq_lib` and adds `lib/include`) pick it up with no CMake change beyond the source list.
Headers in `lib/include/` under the directory of their namespace. Inside `namespace fsw`, spell
config types `::fsw::config::Config` (the `fsw::fsw` trap, `lib/include/net/DaqInterface.hpp:54-57`).
The full declarations with S36 doc comments are the stubs `docs/remaster/design-stubs/cpp/lib/
include/{service/StopSignals,net/TcpCommandServer,elodin/SequencerStateFollower}.hpp`; the
signatures and the load-bearing facts are restated here.

### 2.1 `lib/include/service/StopSignals.hpp` + `lib/src/service/StopSignals.cpp` (pass 1)

```cpp
namespace fsw::service {
enum class ShutdownNotice { kSilent, kPrintThenStop, kStopThenPrint };  // t7 / seven / daq_bridge
enum class Sigpipe { kDefault, kIgnore };  // LEDGER Parked; never changed in a refactor
std::atomic<bool>& running();              // true until SIGINT/SIGTERM; constant-initialised
/** signal(SIGINT, h); signal(SIGTERM, h); and, for kIgnore, signal(SIGPIPE, SIG_IGN) — in that
 *  order, with ::signal, never sigaction. `line` is printed verbatim (callers include the
 *  leading "\n"), must outlive the process, and is nullptr iff notice == kSilent. */
void installStopHandlers(ShutdownNotice notice, const char* line, Sigpipe sigpipe);
}
```

- One file-static `std::atomic<bool> g_running{true}` (constant initialisation), one file-static
  `const char* g_line` and `ShutdownNotice g_notice`, written by `installStopHandlers` before the
  `signal()` calls. Plain globals, not atomics (S24's stated exception): every thread in every
  service is created **after** its `installStopHandlers` call (heartbeat 271 > 228, stacklight
  295 > 264, ota 451 > 406, sequencer's `svc.init` threads > 241, controller `service.start()`
  494 and the control thread 500 > 490, t7_bridge 351 > 343, daq_bridge's discovery 473 > 341;
  config_broadcast and calibration run one thread; `ControllerService::initialize` at 462 starts
  none — its threads start in `start()`, `ControllerService.cpp:203,208`). If a future change
  starts a thread before the call, these must become atomics.
- The handler is one function with a `switch (g_notice)`; each case is today's body **statement
  for statement**, including the non-async-signal-safe `std::cout << … << std::endl` and not
  saving `errno` (parked: BLOAT-MAP defect 6; a `write(2)` would change line order in captured
  logs). `::signal`, not `sigaction`: without `SA_RESTART` blocked `recv`/`accept`/`select`/
  `usleep`/`waitpid` return `EINTR`; `SA_RESETHAND` makes a second SIGTERM fatal (gap 2 catches
  it). No static object in the TU prints or works at load (§7.3). No identifier spelled `main`.

Per-service settings (the whole table is the contract; the call goes exactly where today's
`signal()` lines are, §1.2, always before the service's first thread, even where that order
looks wrong):

| service | call | replaces |
|---|---|---|
| heartbeat | `installStopHandlers(kPrintThenStop, "\n[HeartbeatService] Shutting down...", kDefault)` | 228-229, flag 37, handler 43-46 |
| stacklight | `(kPrintThenStop, "\n[StacklightService] Shutting down...", kDefault)` | 264-265, 33, 36-39 |
| config_broadcast | `(kPrintThenStop, "\n[ConfigBroadcast] Shutting down...", kDefault)` | 498-499, 44, 46-49 |
| ota | `(kPrintThenStop, "\n[OTAService] Shutting down...", kIgnore)` | 406-408, 43, 45-48 |
| sequencer | `(kPrintThenStop, "\n[Sequencer] Shutting down...", kIgnore)` | 241-243, 46, 55-58 |
| controller | `(kPrintThenStop, "\n[controller_service] Caught signal, shutting down…", kDefault)` | 490-491, 54, 56-59 |
| t7_bridge | `(kSilent, nullptr, kIgnore)` | 343-345, 56, 83-85 |
| calibration (WP9 cleanup) | `(kPrintThenStop, "\n[CalibrationService] Caught signal, shutting down...", kDefault)` | 656-657, 154, 459-462 |
| daq_bridge (WP10 cleanup) | `(kStopThenPrint, "\n[DAQ Bridge] Shutting down...", kIgnore)` | 341-344, 106, 108-111 |

Every read of the old flag becomes `fsw::service::running()` (a main may bind
`auto& g_running = fsw::service::running();` at the top of `main` to keep the diff to the
declaration; file-static functions and lambdas call `running()`).

### 2.2 `lib/include/net/TcpCommandServer.hpp` + `lib/src/net/TcpCommandServer.cpp` (pass 2)

```cpp
namespace fsw::net {
struct TcpServeOptions { size_t max_clients; const char* busy_log_prefix; };  // 64; "[Sequencer] " | "[ControllerService] ⚠️  "
/** sequencer_main.cpp:303-349 / controller_main.cpp:171-214 statement for statement: while
 *  (running) { reap; select(listen_fd, 10 ms); accept; reap; cap check: "ERR:too many
 *  connections\n" (MSG_NOSIGNAL), cerr << busy_log_prefix << "client limit (" << max_clients <<
 *  ") reached — refusing connection", close; spawn a tracked thread running on_client(fd) then
 *  done = true }. Then shutdown(SHUT_RDWR) every tracked fd, then join every thread. Borrows
 *  listen_fd; never closes it. */
void serveTcpClients(int listen_fd, const std::atomic<bool>& running,
                     const TcpServeOptions& opts, const std::function<void(int)>& on_client);
}
```

- **Body:** `Conn` and `reap_finished` move **verbatim** from `sequencer_main.cpp:284-301`; the
  loop and the shutdown/join tail from 303-349. The controller's copy (152-214) is deleted. The
  10 ms select timeout is a constant inside (both users; D17d).
- **Ownership:** `listen_fd` is opened and closed by the main as today (sequencer 252-276, `close`
  351; controller 128-147, `close` 216); the helper never closes it. The `Conn` vector lives on
  the calling thread's stack. `on_client` runs on the client thread and closes its client fd
  (221 / 124). **`on_client` outlives every client thread:** all are joined before
  `serveTcpClients` returns, so `[&svc]` (a stack `SequencerService`) is safe, as today.
- **Must not know `fsw::service`:** `running` is the caller's atomic (the mains pass
  `fsw::service::running()`); the TU does not include `StopSignals.hpp`. Must not know the line
  protocol, read discipline or reply texts (three read disciplines stay in three mains, §1.6).
  **`on_client` reaches a service only through its public, enqueueing API** (D42 binding 1:
  `SequencerService::transitionTo`/`setDebugMode`/`manualActuator`/`extendFire`/
  `scriptStatusReport`; `ControllerService::setFireActive`), never a `do*` body — today's
  `handleClient` → `handleCommandLine` already does exactly this.
- **S15 literal split, listed in the commit message:** today's one literal
  `"[Sequencer] client limit ("` (327) / `"[ControllerService] ⚠️  client limit ("` (193) becomes
  the prefix at the call site plus `"client limit ("` in the helper; the sorted multiset of
  literals is not identical and the commit says so. Bytes on the wire and in the log are. The
  helper keeps the statement sequence and with it the D-FD race (§8).
- Adoption: sequencer 303-349 → `serveTcpClients(listen_fd, fsw::service::running(), {kMaxClients,
  "[Sequencer] "}, [&svc](int fd){ handleClient(fd, svc); })`; 351-353 unchanged. Controller
  171-214 → `serveTcpClients(listen_fd, fsw::service::running(), {kMaxControlClients,
  "[ControllerService] ⚠️  "}, [svc](int fd){ handleControlClient(fd, svc); })`; 216 unchanged.
  `kMaxClients` (51) and `kMaxControlClients` (72) stay named constants in their mains (§5).

### 2.3 `lib/include/elodin/SequencerStateFollower.hpp` + `lib/src/elodin/SequencerStateFollower.cpp` (pass 2)

```cpp
namespace fsw::elodin {
struct SequencerStateFollowerText {
    const char* subscribe_failed;    // cerr, whole line
    const char* connected;           // cout, whole line
    const char* read_failed_prefix;  // cerr: prefix << last_error() << ") — reconnecting"; nullptr = silent
};
/** heartbeat_service_main.cpp:103-152 statement for statement: connect (sleep_for(2 s) on
 *  failure) → subscribe_tables({kTableSequencerState}) (failure: subscribe_failed, disconnect,
 *  retry at once) → set_recv_timeout_ms(recv_timeout_ms) → connected → read_packet into a
 *  4096-byte stack buffer; n < 0 → optional log, disconnect; n < 8 → continue; buf[5]/buf[6] ==
 *  0x50/0x00 and n >= 17 → on_state(buf[16]). Runs until `running` is false. */
void follow_sequencer_state(const std::string& host, uint16_t port,
                            const std::atomic<bool>& running, int recv_timeout_ms,
                            const SequencerStateFollowerText& text,
                            const std::function<void(uint8_t)>& on_state);
}
```

- **Call form (decided): each main's file-static wrapper.** `elodinThread(std::string host,
  uint16_t port)` stays in heartbeat (103) and stacklight (99) with its body replaced by one call,
  so the `std::thread` lines 271 and 295 are **byte-identical**. The alternative is
  `std::thread(follow_sequencer_state, host, port, std::ref(fsw::service::running()), …)`:
  `std::thread` decay-copies its arguments and `std::atomic<bool>` is non-copyable, so a bare
  `running()` does not compile (ruling 6). Not chosen: it edits 271/295.
- heartbeat: `recv_timeout_ms = kElodinRecvTimeoutMs` (3000, stays at 41 — the lifecycle bounds
  cite it by name), text = the literals at 113-115, 122-123, 135-136,
  `on_state = [](uint8_t s){ g_engine_state.store(stateToEngine(s)); }`. stacklight:
  `kStacklightRecvTimeoutMs` (500, stays at 97), texts 109-110, 116-117, `nullptr`,
  `on_state = [](uint8_t s){ g_seq_state.store(s); }`. Joined where today (296, 344-345).
- **The nullptr text field is data, not a knob** (verdict §3): a literal-or-nothing per-service
  setting is the explicit setting S12 and D17's boundary clause require, the shape of
  `StopSignals`' `line` and of D45's `send_msg`. `on_state` is a callback type by D43(3): both
  users agree observably. **Must not know `fsw::service`** (takes the caller's atomic), what a
  state means (`on_state`), or the mains' sockets and send loops.
- **Back-off is a latency fact, not a tunable:** the `sleep_for(2 s)` at heartbeat 109 /
  stacklight 105 is **uninterruptible** — not sliced on `running`. With elodin-db down, each
  follower notices a stop only between connect attempts, so the exit bound is ≈ 2 s, not
  `recv_timeout_ms`. `lifecycle/golden/shutdown.txt:7` records stacklight `[0, 1.2] s` *before*
  elodin-db is killed; the bound holds only with the db up (team question 5). The helper keeps the
  unsliced sleep.

## 3. Ownership and data flow

| piece | owns | threads | guarded by |
|---|---|---|---|
| `StopSignals` | the process stop flag, the notice settings | written by the signal handler (any thread the kernel picks), read by every loop | `std::atomic<bool>` (seq_cst, as today); settings written once before `signal()` |
| `serveTcpClients` | the `Conn` vector (calling thread's stack) and the client threads; **not** `listen_fd` | the calling thread (sequencer: main; controller: the detached control thread) + one per client | `Conn::done` atomic; the vector is touched only by the calling thread |
| `follow_sequencer_state` | its own `ElodinClient` (on its stack) | the thread the main's wrapper runs on | publishes through the caller's `on_state`, which stores into the main's atomic |
| listener fds, UDP sockets, destinations, config paths | **the mains, unchanged** | — | — |

No new mutex. No lock is held across any call into shared code. The command-path locks inside
`SequencerService` and `ControllerService` are untouched (WP10 §1, incl. C4-1). Lifetimes that
must not move: sequencer's client threads are joined before `svc` is destroyed at the end of
`main` (282-283); the controller's control thread stays **detached** (500-501), so `main` reaches
`service.stop()` while it may still be in `select` (C4-5); ota's clients stay detached (S22).

## 4. Error handling: today, and how it stays

| failure | today | after WP8 |
|---|---|---|
| UDP `socket()`, bad IP, NIC resolve, `bindToDaqInterface` (heartbeat, stacklight, config_broadcast, AbortBroadcaster) | per-service text and exit code (§1.5) | **unchanged** (not shared); the two ignored binds gain a `// Kept: D-BIND` tag in pass 2 |
| TCP socket/bind/listen (sequencer, ota); socket/bind (controller: logged with `strerror`, control thread returns, service runs on) | logged, `close`, exit 1 / D-CTL | **unchanged** (listeners stay in the mains) |
| TCP listen (controller) | ignored (147) | unchanged; `// Kept: D-CTL` tag in pass 2 |
| 65th concurrent client | busy line + log, `close` | inside `serveTcpClients`, same bytes and log |
| oversized sequencer line, controller junk, ota junk | per-service reader (§1.6) | unchanged |
| Elodin subscribe refused / read error (heartbeat, stacklight) | log, `disconnect`, retry at once / heartbeat logs, stacklight silent, both disconnect | inside `follow_sequencer_state`: same / `read_failed_prefix` set or `nullptr` |
| bad TOML / missing file | `config::load` logs and returns defaults (C2-4); config_broadcast SIGABRT (C2-12) | no shared code catches or checks anything around `config::load` |
| bad CLI value | `atoi` → 0; t7 `exit(2)`; daq_bridge `stoi` throws → abort | unchanged (`parseArgs` is file-static, per service) |

Exit codes that must not change: 0 on clean stop and on `--help` everywhere; 1 for the startup
failures above; t7_bridge 2 (bad argv, T7 config errors), 3 (no LJM without `--fake`), 0 (no T7);
config_broadcast −6 (SIGABRT, C2-12); a process killed before its handler is installed: −2/−15;
any service whose SIGPIPE is default and is hit by one: −13.

## 5. Naming

- Namespaces follow the tree: `fsw::service` (new, process-level, camelCase with
  `installStopHandlers`), `fsw::net` (next to `DaqInterface`, camelCase), `fsw::elodin`
  (snake_case: `follow_sequencer_state`; the type `SequencerStateFollowerText` is PascalCase, S3).
- `installStopHandlers`, `running()`: what they do to the process. Not "ServiceMain".
  `TcpCommandServer.hpp` holds `serveTcpClients`; not "LineCommandServer" (line reading stays in
  the mains). `follow_sequencer_state`: two callers follow one table; not "SubscriberLoop".
- Per-service constants keep their names and stay in their mains (`kElodinRecvTimeoutMs`,
  `kStacklightRecvTimeoutMs`, `kMaxClients`, `kMaxLineBytes`, `kMaxControlClients`): the lifecycle
  and sequencer READMEs cite them by name. Log tags are not renamed (S16): tests grep them.

## 6. Passes

Pass 1 adopts the one piece that is behaviour-identical by construction and is the prerequisite
of WP9 and WP10. Pass 2 adopts the two statement-identical moves and does the cleanup. One commit
per (helper, service) pair, so a red golden names its cause (D12e). Run the guards in §7 after
each commit (under the stack lock, subsets per D23); format only touched files with the pinned
clang-format 19.1.7; clang-format's include regrouping is an expected non-dimmed diff (D43(6)).

### 6.1 Pass 1 — `StopSignals` (one queue item; gaps 1-3 merged first)

1. `lib/src/service/StopSignals.cpp` + header; append to `FSW_SOURCES`. Build.
2. t7_bridge: delete `g_running` (56) and `on_signal` (83-85); replace 343-345 with
   `fsw::service::installStopHandlers(kSilent, nullptr, kIgnore)`; every `g_running` read (96,
   172, 192, 268) → `fsw::service::running()`. Guard: `t7_integration` (CI, D34) + `t7` ctest.
3. heartbeat: delete 37, 43-46; 228-229 → its call (§2.1 table); reads at 106, 276, 291.
4. stacklight: delete 33, 36-39; 264-265 → its call; reads at 102, 305.
5. config_broadcast: delete 44, 46-49; 498-499 → its call; reads at 545, 600.
6. ota: delete 43, 45-48; 406-408 → its call with `kIgnore`; reads at 311, 439.
7. sequencer: delete 46, 55-58; 241-243 → its call with `kIgnore`; reads at 203, 303.
8. controller: delete 54, 56-59; 490-491 → its call (`…` is U+2026, copy the bytes); reads at
   82, 171, 507.

### 6.2 Pass 2 — `serveTcpClients`, `follow_sequencer_state`, `parseArgs`, tags (one queue item; gaps 4, 5, 7 merged first as one D32 batch, gap 7 after C1)

Commit order — helper TU → each (helper, service) adoption → `parseArgs` → tags — so a bisect
names its commit and an ejected helper is a contiguous block:

1. `lib/src/net/TcpCommandServer.cpp` + header; append to `FSW_SOURCES`. `Conn` and
   `reap_finished` **verbatim** from `sequencer_main.cpp:284-301`.
2. sequencer 303-349 → `serveTcpClients` (§2.2). 252-276 and 351-353 unchanged.
3. controller 152-214 → `serveTcpClients`; 128-149 and 216 unchanged. The ready line 148-149
   stays after `listen()` (whose failure is ignored, so it prints whenever bind succeeded).
   Commit message lists the S15 literal split (§2.2).
4. `lib/src/elodin/SequencerStateFollower.cpp` + header; append.
5. heartbeat: `elodinThread` body 104-151 → one call to `follow_sequencer_state` with §2.3's
   arguments; 271 byte-identical; `kElodinRecvTimeoutMs` stays at 41.
6. stacklight: `elodinThread` body 100-135 likewise; 295 byte-identical;
   `kStacklightRecvTimeoutMs` stays at 97.
7. In each of the seven mains, move the argv loop into a file-static
   `parseArgs(int, char**, Options&)` returning `std::optional<int>` (exit code for `--help`).
   Help text and flag order byte-identical (gap 4 pins them). Not daq_bridge or calibration.
   t7_bridge's `next` lambda (282-288) moves **verbatim**, `std::exit(2)` included: it is not
   converted to a returned exit code (an `exit` from inside the loop skips destructors and
   flushes differently from a `return` out of `main`).
8. Tags, S12 long form (D46: `// Kept: <id> (D17) — <class>/<phase>: <rule violated>; loud
   half: <surface>`), comment lines only:
   - `controller_main.cpp:147`, above `::listen(listen_fd, 4);` —
     `// Kept: D-CTL (D17) — control/startup: S14, listen() status dropped, the service runs on
     with no TCP fire gate; loud half: none (the ready line 148-149 prints regardless; gap 6)`.
     With no `TcpListener` there is no `kListen` branch to make explicit (D43(4)); the tag on the
     call is the mark.
   - `heartbeat_service_main.cpp:252` and `config_broadcast_service_main.cpp:526`, above the
     `bindToDaqInterface` call — `// Kept: D-BIND (D17) — observation/startup: S14,
     bindToDaqInterface's bool dropped; loud half: its own cerr line (DaqInterface.cpp:198, 202)`.
9. Leave stacklight's `trim`/`getTomlValue` (141-175) where they are, with external linkage
   (§7.3). Do not touch the B4 encoders, the per-service constants, the precedence code, or the
   `buf[5]/buf[6]` checks outside the follower.

**Fallback (verdict §2).** Pass 2 ships whichever of `serveTcpClients` / `follow_sequencer_state`
has its gap merged green; a piece whose gap is ejected (D32) stays in its mains, with a ledger
entry; if both, pass 2 is `parseArgs` + tags. Pass 1 never waits on gaps 5-7.

### 6.3 What must not change (checked by §7; this list is the acceptance test)

- **Packet bytes and order:** SERVER_HEARTBEAT (`02 00 <system ms LE> <engine>`); STACKLIGHT_COMMAND;
  every SENSOR_CONFIG/ACTUATOR_CONFIG byte incl. reversed abort IPs (C1-2) and `ipToU32Le` → 0
  (C1-8); ABORT ×4 and the double `triggerAbort` (C1-10); the Elodin subscribe request
  `len=6 ty=0 id=[0x11,0x0d] payload 50 00` from both followers.
- **TCP reply text:** `ERR:too many connections\n`; every sequencer, controller and ota reply in
  §1.6 and in the goldens; controller's `ERR\n` on CRLF (C4-5); `''` on half-close; sequencer's
  close on a 600-byte line.
- **Timing constants:** heartbeat 3000 ms receive, 2 s reconnect, 100 ms slices, `max(100,·)`,
  10 s stats; stacklight 500 ms, 2 s, 100 ms loop; config_broadcast `max(500,·)`, 100 ms slices;
  sequencer/controller select 10 ms, `SO_RCVTIMEO` 5 s, caps 64, line 512/64; ota select 1 s,
  `SO_RCVTIMEO` 30 s; t7 100 ms nap, 1→10 s back-off, 2 s db gate; backlogs 10/4/5.
- **Exit codes:** §4. **Startup order:** §1.2, including where signals are installed.
  **SIGPIPE per service:** §1.3 / §2.1 table.
- **Log lines a test reads (S15):** `Listening for DiabloAvionics packets`, `[DAQ Bridge]
  Shutdown complete`, `[HeartbeatService] Stopped.`, `[Cal] Stopped.`, calibration's
  `Elodin|subscrib` match (lifecycle); stacklight's three start lines and `--force-state` line,
  config_broadcast's `No config loaded` (config `golden/bin/`); `SEQ_FACTS`/`CTL_FACTS` counts
  incl. the controller's `control connection closed with no command (timeout or peer went away)`
  (sequencer N6); everything a `#include`d main prints during `dump()` (config `golden/cpp/`).
- **Warnings baseline:** `config_broadcast_service_main.cpp: warning: unused variable
  'DEFAULT_LISTEN_PORT' [-Wunused-const-variable]` (`baseline_warnings.txt:8`, constant at 53)
  survives both passes: the constant stays, unused, in that file's anonymous namespace.
- **Shutdown order:** sequencer shutdown→join→close→`Stopped.`; controller `service.stop()` with
  the control thread detached (C4-5 >3 s exit stays); heartbeat `close(sock)` before `join`;
  ota's detached clients not waited for.
- **`AbortBroadcaster::sendPacket` is not touched** — not its socket creation, not the
  `SO_SNDTIMEO` after the bind, not the repeat loop whose `sendto` can fail a repeat with EINTR
  (research §0.2, D42). The ABORT/ABORT_DONE timing that C4-3's goldens freeze does not move.

## 7. Guarding characterization

### 7.1 Coverage per part

| part | covered by | how |
|---|---|---|
| stop handlers: exit code and latency on SIGTERM/SIGINT; final log lines | `lifecycle/golden/shutdown.txt` | heartbeat, stacklight, config_broadcast, ota, calibration, daq_bridge: exit 0 within bounds citing `kElodinRecvTimeoutMs`, `kStacklightRecvTimeoutMs`, ota's 1 s select, 100 ms slices; no packets after the signal; `[HeartbeatService] Stopped.`, `[DAQ Bridge] Shutdown complete`, `[Cal] Stopped.` |
| UDP setup + bytes | `packets/golden/service_{heartbeat,stacklight,config_broadcast,abort,daq_bridge}.txt`; `lifecycle/golden/startup.txt` | black box |
| TCP servers | `sequencer/golden/*` (every reply, CRLF, two commands per write, oversize close), `sequencer/golden/controller__*.txt`, `lifecycle/golden/ota.txt`, `shutdown.txt` (`command port still accepting: False`) | black box |
| followers | `packets/golden/service_{heartbeat,stacklight}.txt` (subscribe bytes, state→output map), `startup.txt` | black box with a stand-in elodin-db |
| config loading | `config/golden/bin/{daq_bridge,stacklight,config_broadcast}`; `config/golden/cpp/*` (§7.3); sequencer N6 load-time lines | black box + D18 white box |
| t7_bridge | ctest `t7_integration` (D31 list; D34: CI only), `t7` | ctest |
| everything | TSan CI job; integration (167 checks) | — |

### 7.2 Gaps (proposed cases; design only, none written here)

Classification (verdict, ratified under D39): **before pass 1** — 1, 2, 3 (`lifecycle/`);
**before pass 2, one D32 batch** — 4 (`config/`), 5 (`sequencer/`), 7 (`packets/`, after C1);
**worth writing, not gating** — 6 (the only D-CTL characterization) and 8; **nice-to-have** — 9.
Numbers are stable: DESIGN-WP10 and the research cite them.

1. **[before pass 1] SIGPIPE disposition is not covered anywhere.** Case for `lifecycle/`: start
   each of the nine services alone (loopback config), `kill -PIPE <pid>`, record `alive after 1 s`
   or `exit -13`. Expected: daq_bridge, ota, sequencer, t7_bridge alive; controller, calibration,
   heartbeat, config_broadcast, stacklight exit −13. Mutation: flip one service's `Sigpipe` → red.
   The only test that would catch a uniform setting.
2. **[before pass 1] Shutdown of sequencer, controller and t7_bridge** is not in `shutdown.txt`.
   Add SIGTERM and SIGINT exit code and latency bound for each (controller's > 3 s, C4-5, as a
   bound, not a fix). Plus research §1's **second-SIGTERM case** (verdict §5; team question 2
   confirms): SIGTERM twice 50 ms apart to heartbeat, expect exit 0, not −15 (catches
   `SA_RESETHAND`). Also closes DESIGN-WP10 gap 2.
3. **[before pass 1] The `Shutting down` line** printed by each handler is read by no test; nor is
   daq_bridge's flag-then-print order. Add, per service, the handler's exact line (bytes, incl.
   the leading newline and controller's U+2026) and its position relative to the service's final
   line to `shutdown.txt`.
4. **[before pass 2] `--help` text and exit code** of all nine binaries, and t7_bridge's exit 2 on
   an unknown flag and on a missing value: a `config/golden/bin/help/` golden (stdout, exit code).
5. **[before pass 2] `ERR:too many connections`**: no session opens 65 connections. Add to
   `sequencer/` for both ports, :9998 and :9999 (hold 64 idle connections, the 65th gets the busy
   bytes; the 64 then close; a 66th gets a normal reply). Bounded by `SO_RCVTIMEO` 5 s; the
   timing-bearing case (64 held connections under D27 load; mutation: doubled select period).
   Also assert the busy **log line bytes**: `[Sequencer] client limit (64) reached — refusing
   connection` and `[ControllerService] ⚠️  client limit (64) reached — refusing connection` —
   U+26A0 U+FE0F followed by **two** spaces, and the em dash U+2014 in both.
6. **[worth writing, not gating] Every listener failure ladder.** Controller with its control port
   pre-bound: keeps running, logs `[ControllerService] ❌ Control bind(N) failed: <strerror>`, PWM
   gate unreachable by TCP (D-CTL's only characterization). Sequencer with :9998 pre-bound:
   `[Sequencer] bind() failed on port N`, exit 1. ota likewise. Not gating: WP8 no longer moves
   these ladders (team question 1 asks who writes it).
7. **[before pass 2, after C1] Follower reconnect and subscribe-refused**: no case restarts
   elodin-db and checks that heartbeat/stacklight re-subscribe. Add to `packets/` with the
   stand-in db: drop the connection, expect a second identical subscribe request and resumed
   state tracking. Also the subscribe-refused path (stand-in replies with an error).
8. **[worth writing, not gating] Config path fallback** (heartbeat, stacklight, config_broadcast,
   controller) has no case where `--config` names a missing file and a fallback exists. Add to
   `config/golden/bin/`. Not gating: the blocks stay in their mains.
9. **[nice-to-have] ota concurrency**: a second client during a flash, and SIGTERM during a flash
   (detached threads: process exits without finishing). Add to `lifecycle/ota`.

### 7.3 White-box harness hooks

`test/characterization/config/char_config_services.cpp:20-30` `#define main
char_service_main_unused` and `#include`s `stacklight_service_main.cpp`, `daq_bridge_main.cpp`,
`config_broadcast_service_main.cpp` (one executable each, linking `fsw_daq_lib` with
`lib/include` on the path). It calls stacklight's `getTomlValue` (external linkage, 147-175),
daq_bridge's board-map helpers (WP10's file) and config_broadcast's `parseVentAbortFromCsv`,
`buildPackets` (anonymous namespace, 89-130, 185-448). Its golden is the dump followed by
**everything the process printed during `dump()`**.

WP8 needs **no harness edit** if it keeps these rules, which make the three `golden/cpp/` dirs
byte-identical by construction: do not move, rename or change the linkage of any symbol above
(WP8 touches only stacklight's and config_broadcast's `main`, flag, handler and — in stacklight —
`elodinThread`'s body); every header a WP8 main newly includes lives under `lib/include` with its
source in `fsw_daq_lib` (nothing new on `_CFG_INCLUDES` or the link line); no identifier spelled
`main` in any new header; no static object in a new TU prints or reads a file at load (S26);
`follow_sequencer_state`, `serveTcpClients` and the `StopSignals` TU are linked but never called
by the harness and must not register anything at load. If a change nevertheless needs the harness
touched, D18 applies (those two files only, goldens byte-identical, mutations re-run, orchestrator
reviews). Run `bash test/characterization/config/check.sh cpp <bin dirs>` (ctest
`characterization_config_cpp`, no lock) after every commit that touches stacklight or
config_broadcast, and `config/run.sh` (bin half, under the lock) once per such commit.

## 8. Risks

- **Concurrency.** No new lock. `serveTcpClients` keeps reap-before-and-after-accept and
  shutdown-all-then-join-all; joining before shutting down would wait out each client's 5 s
  `SO_RCVTIMEO`. The controller's control thread stays detached (C4-5). The sequencer's
  join-before-`svc`-destruction stays, and so does its inability to exit while the worker is
  deadlocked (**C4-1**; WP8 adds no timeout and no detach). C4-2 and C4-3's code is not touched.
- **One flag per process.** After pass 1 there is one flag in `fsw_daq_lib`. A test binary that
  links it and starts two services in one process would share a flag; none does (no `extern` or
  `g_running` reference outside the mains in `lib/`, `transport/`, `test/characterization/`).
- **SIGPIPE.** A uniform `kIgnore` would keep five services alive on a broken Elodin socket and
  make their `write` failures (not characterized) the behaviour. §2.1's table is the contract;
  gap 1 is the only test that would catch a flip.
- **Timing ctests (D31, D34): exposure is `t7_integration` only** (pass 1 step 2; CI-judged).
  `sequencer_main.cpp` and `controller_main.cpp` build only their binaries
  (`services/CMakeLists.txt:15,36`), `AbortBroadcaster.cpp` is untouched, and heartbeat/stacklight
  are in no ctest — so pass 2 has no timing-ctest exposure. What pass 2 does touch: the sequencer
  characterization's republish bounds (`[0.8, 1.5]×`, judged on the Linux leg and CI) and the
  config `golden/cpp/` via the stacklight `#include` (§7.3).
- **Lifecycle shutdown bounds** cite the mains' constants by name (`kElodinRecvTimeoutMs` 3000 →
  heartbeat's `[0, 3.6] s`, `shutdown.txt:27`); keep the names and the constants in the mains.
- **D-FD, fix shape (team note, verdict §3).** A `closed` flag only narrows the window: flag read
  → `shutdown()` still races the handler's `close()` at 221/124. Shape: the handler never closes;
  the owning `Conn` closes after the shutdown/join loop (`UniqueFd` or an `int` closed at reap —
  the team's call). FIN moves ≤ 10 ms; observable; its own package (S8); lands once. Not WP8's.
- **Stand.** Nothing here runs against `config/config.toml` or `192.168.2.x`; every check is the
  hermetic stack under `with_stack_lock.sh`.

## Open items

Still open from the review: SIGPIPE is the team's decision (LEDGER Parked) — until then §2.1's
column is frozen; daq_bridge's `std::stoi(argv[3])` abort on junk and t7_bridge's
usage-on-unknown-flag stay per service — confirm nobody wants them in a shared parser later.

Remaining team questions (verdict §6, verbatim):

1. Who writes gap 6, the only D-CTL characterization, now that no WP owes it?
2. Add research §1's second-SIGTERM case (catches `SA_RESETHAND`) to gap 2?
3. Ratify the D-FD shape above, and that `UniqueFd` arrives with that package?
4. Self-pipe: the follower's wake needs `ElodinClient` to expose its fd — in the proposal's scope?
5. Should `shutdown.txt` gain a db-down follower case, given the 2 s back-off makes stacklight's `[0, 1.2] s`
   conditional?
