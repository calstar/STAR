# DESIGN-WP8 — shared C++ service plumbing

The "as decided" execution note for WP8 (D17(a)): what an implementer does, in what order, and
why. Decisions: D39 (review), D43 (casing, `// Kept:`), D45 (deepening), D46 (tag long form),
the debate verdict (`debates/WP8/verdict.md`, ratified under D39; LEDGER **D54**) and the
simplicity round that followed it (LEDGER **D57**: `parseArgs` and `follow_sequencer_state`
dropped, the `// Kept:` tags moved to pass 1, `StopSignals`' notice reduced to a print order plus
a nullable line, no read-site edits) and a final cosmetic round (wording and line references only;
no decision changed). How it got here — the reviewed text, its amendments, the
withdrawn `UdpSocket`/`ConfigFile` interfaces, the alternatives (B RAII types, C signals only),
the walkthroughs and the first gate classification — is preserved verbatim in
[`debates/WP8/history.md`](debates/WP8/history.md).

**Baseline.** Every line number below is from `git show backend-remastered:daq-server/<path>` at
`backend-remastered` @ **`91ee0bc8`**, whose `diablo_server/` is byte-identical to `main` @
`15b5a0c5` (and to `b2599617`, the reviewed note's anchor). Paths are relative to
`daq-server/diablo_server/` unless they start with `test/`, `docs/` or `lib/CMakeLists.txt`. C1
(`packets/`, `elodin/`) is on the tip. Function names, not numbers, are the contract: if WP3
lands first, re-anchor with `grep -n`.

**Prerequisites.** Pass 1: §7.2 gaps 1-3 (`lifecycle/`) merged and gated. Pass 2: gap 5
(`sequencer/`) merged green — the D32 batch for pass 2 is gap 5 alone; if it is not green, pass 2
is not queued (ledger entry). Pass 1 never waits on gap 5. The passes are **separate queue
items, each fully gated** (full gate + Linux leg + CI, D19).

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
| `// Kept:` tags, S12 long form (D46); comment lines only | `controller_main.cpp:147` (D-CTL); heartbeat 252, config_broadcast 526 (D-BIND) | **1** | — |
| `fsw::net::serveTcpClients` + `TcpServeOptions`; `Conn`, `reap_finished` verbatim from `sequencer_main.cpp:284-301`; `on_client` only through the public enqueueing API (D42 binding 1) | sequencer 282-349, controller 151-214 | **2** | gap 5 |

**Stays per service, every `close()` on its line:** listener setup (sequencer 252-276, controller
128-147, ota 410-434); UDP sockets and destinations (heartbeat 232-263, stacklight 268-282,
config_broadcast 509-531 and 554-558); `AbortBroadcaster.cpp`; the config-path blocks (heartbeat
202-213, stacklight 211-228, config_broadcast 468-485, controller 276-301); the argv loops
(§1.4); the two Elodin followers (heartbeat `elodinThread` 103-152, stacklight 99-136); per-client
readers; `trim`; encoders. ota, heartbeat, stacklight, config_broadcast and t7_bridge adopt
`StopSignals` only.

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
  unknown-flag policies; each main keeps its loop **where it is**. **A file-static `parseArgs()`
  per main** (D57): it is per-main, so it shares nothing; it rewrites the 8-29 post-argv sites
  per main that read the parsed values (`config_path`, ports, hosts, …) through an `Options`
  struct, and no golden can see any of that; and t7_bridge's loop is only half convertible (its
  `next` lambda's `std::exit(2)` cannot become a returned code without changing how the process
  exits). Gap 4 (`--help` texts) is still worth writing; nothing in WP8 is gated on it.
  **`follow_sequencer_state`** (D57): heartbeat 103-152 and stacklight 99-136 are identical in
  control flow (§1.7), but the helper plus a three-field text struct, two file-static wrappers
  and two `on_state` lambdas nets ≤ ~20 lines out of the tree, for a new TU, a new header, a
  callback type and a gating characterization (gap 7) that cannot be made to fail deterministically
  on its refused half (§7.2). D49's test — the simplest design that keeps every golden — says
  the two bodies stay where they are. **A generic `SubscriberLoop`:** the eight B3 sites are
  four different things (§1.7); after D57 not even the two identical followers are shared.
  **An owning `UdpSender` / RAII sockets:**
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
print **then** clear the flag — five print `"\n[<Tag>] Shutting down..."`, calibration
`"\n[CalibrationService] Caught signal, shutting down..."`, the controller
`"\n[controller_service] Caught signal, shutting down…"` (U+2026); daq_bridge's `signal_handler`
(108-111) clears the flag **first**, then prints; t7_bridge's `on_signal` (83-85) only clears the
flag. The exact strings are the "call" column of §2.1's table, the handler lines its "replaces"
column. **SIGPIPE** is ignored by ota (408),
sequencer (243), t7_bridge (345) and daq_bridge (344) and takes its default (the process dies,
−13) in heartbeat, stacklight, config_broadcast, controller and calibration — LEDGER Parked
"SIGPIPE disposition" verbatim, a per-service setting until the team decides. Every reply on a TCP
command socket uses `MSG_NOSIGNAL` (`sequencer_main.cpp:75,326`, `controller_main.cpp:97,192`,
`ota_service_main.cpp:305`); what can kill a default-disposition service is a write to the Elodin
socket (`transport/src/transport/TCPClient.cpp:148`, `::write`), i.e. a db restart.

### 1.4 CLI and config loading today

Flags, `--help` texts and config resolution are per service and stay so, **and so do the loops
that parse them** (D57; gap 4 would pin the help texts, worth writing, not gating): argv loops at
heartbeat 179-199, stacklight 186-208 (help **omits `--force-state`**;
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
Differences: three literals, the timeout, and whether `n < 0` logs. **Both stay in their mains**
(D57, §0 Rejected); WP8 changes neither body — the `g_running` reads at heartbeat 106 and
stacklight 102 keep their spelling (§2.1). Everything else stays its owner's too:
`PressureFeed::runLoop` (`services/sequencer/PressureFeed.cpp:78-193`),
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
include/{service/StopSignals,net/TcpCommandServer}.hpp` (two headers, two TUs; D57 struck the
third); the signatures and the load-bearing facts are restated here.

### 2.1 `lib/include/service/StopSignals.hpp` + `lib/src/service/StopSignals.cpp` (pass 1)

```cpp
namespace fsw::service {
enum class ShutdownNotice { kPrintThenStop, kStopThenPrint };  // print order: eight / daq_bridge
enum class Sigpipe { kDefault, kIgnore };  // LEDGER Parked; never changed in a refactor
std::atomic<bool>& running();              // true until SIGINT/SIGTERM; constant-initialised
/** signal(SIGINT, h); signal(SIGTERM, h); and, for kIgnore, signal(SIGPIPE, SIG_IGN) — in that
 *  order, with ::signal, never sigaction. kDefault makes NO signal() call for SIGPIPE — not
 *  signal(SIGPIPE, SIG_DFL), which would overwrite a disposition inherited from a launcher that
 *  ignores SIGPIPE; today's five default-disposition mains make no such call either, so neither
 *  does the helper. `line` is printed verbatim (callers include the
 *  leading "\n") and must outlive the process; nullptr prints nothing (t7_bridge), and the
 *  notice is then immaterial. */
void installStopHandlers(ShutdownNotice notice, const char* line, Sigpipe sigpipe);
}
```

- The notice is a **two-value print order plus a nullable line** (D57): there is no `kSilent`
  — "print nothing" is `line == nullptr`, the shape `StopSignals` already used for the text and
  the one D45's `send_msg` uses. t7_bridge passes `kPrintThenStop, nullptr` (the common order,
  so daq_bridge stays the only `kStopThenPrint` user; with no line the value is unobservable).
- One file-static `std::atomic<bool> g_running{true}` (constant initialisation), one file-static
  `const char* g_line` and `ShutdownNotice g_notice`, written by `installStopHandlers` before the
  `signal()` calls. Plain globals, not atomics (S24's stated exception): every thread in every
  service is created **after** its `installStopHandlers` call (heartbeat 271 > 228, stacklight
  295 > 264, ota 451 > 406, sequencer's `svc.init` threads > 241, controller `service.start()`
  494 and the control thread 500 > 490, t7_bridge 351 > 343, daq_bridge's discovery 473 > 341;
  config_broadcast and calibration run one thread; `ControllerService::initialize` at 462 starts
  none — its threads start in `start()`, `ControllerService.cpp:203,208`). If a future change
  starts a thread before the call, these must become atomics.
- The handler is one function with a `switch (g_notice)`; each case is today's two statements in
  today's order — `kPrintThenStop`: `if (g_line) std::cout << g_line << std::endl;` then
  `g_running = false;`; `kStopThenPrint`: the same two in the other order — including the
  non-async-signal-safe `std::cout << … << std::endl` and not saving `errno` (parked: BLOAT-MAP
  defect 6; a `write(2)` would change line order in captured logs). The `switch (g_notice)` and
  the `if (g_line)` test are the two statements no handler has today: the switch selects the one
  case that service's own handler was, and the test is true in every printing service and false
  only in t7_bridge, whose handler prints nothing today — unobservable. `::signal`, not `sigaction`:
  with BSD semantics `SA_RESTART` restarts the blocked `recv`/`accept`/`waitpid`; **`select`,
  `usleep` and the `SO_RCVTIMEO`/`SO_SNDTIMEO` socket calls return `EINTR` regardless** of
  `SA_RESTART` (research §0.2), so today's exposure is kept exactly (the loops already `continue`
  on `select() <= 0` and the sleeps are 100 ms slices); dropping `SA_RESTART` would widen it to
  `accept`/`recv`/`waitpid`, and `SA_RESETHAND` makes a second SIGTERM fatal (gap 2 catches it).
  No static object in the TU prints or works at load (§7.3). No identifier spelled `main`.

Per-service settings (the whole table is the contract; the call goes exactly where today's
`signal()` lines are, §1.2, always before the service's first thread, even where that order
looks wrong):

| service | call | replaces |
|---|---|---|
| heartbeat | `installStopHandlers(kPrintThenStop, "\n[HeartbeatService] Shutting down...", kDefault)` | 228-229, flag 37, handler 43-46 |
| stacklight | `(kPrintThenStop, "\n[StacklightService] Shutting down...", kDefault)` | 264-265, 33, 36-39 |
| config_broadcast | `(kPrintThenStop, "\n[ConfigBroadcast] Shutting down...", kDefault)` | 498-499, 44, 46-49 |
| ota | `(kPrintThenStop, "\n[OTAService] Shutting down...", kIgnore)` | 406-408, 43, 45-48 |
| sequencer | `(kPrintThenStop, "\n[Sequencer] Shutting down...", kIgnore)`; 243's trailing comment moves onto the call | 241-243, 46, 55-58 |
| controller | `(kPrintThenStop, "\n[controller_service] Caught signal, shutting down…", kDefault)`; the 489 banner stays | 490-491, 54, 56-59 |
| t7_bridge | `(kPrintThenStop, nullptr, kIgnore)` — prints nothing; 345's trailing comment moves onto the call | 343-345, 56, 83-85 |
| calibration (WP9 cleanup) | `(kPrintThenStop, "\n[CalibrationService] Caught signal, shutting down...", kDefault)` | 656-657, 154, 459-462 |
| daq_bridge (WP10 cleanup) | `(kStopThenPrint, "\n[DAQ Bridge] Shutting down...", kIgnore)`; the full-line comment 343 stays above the call | 341-344, 106, 108-111 |

Trailing comments (S38, comments move with their code): sequencer 243 `// don't crash on broken
TCP connections` and t7_bridge 345 `// a dropped Elodin socket must not kill the process` each
become the trailing comment of the `installStopHandlers` call that replaces their statement —
they say *why this service* ignores SIGPIPE, which the `kIgnore` argument alone does not, and the
Parked SIGPIPE item leans on that. daq_bridge's 343 is a full line above 344 and stays above the
call (WP10). clang-format will rewrap the call with its comment; that is the expected non-dimmed
diff (D43(6)).

**No read site changes** (D57). Every main keeps its reads byte-identical by binding the old
name to the library's flag at namespace scope, where the deleted declaration stood:

```cpp
auto& g_running = fsw::service::running();          // six mains, inside their `namespace {`
static auto& g_running = fsw::service::running();   // controller_main.cpp:54 is file-scope static
```

All seven WP8 mains spell the flag `g_running` (heartbeat 37, stacklight 33, config_broadcast 44,
ota 43, sequencer 46, controller 54, t7_bridge 56); keep each main's own name — calibration's and
daq_bridge's is `running` (154 / 106, the latter with external linkage) and WP9/WP10 bind that
name instead. The reference binds, at the main's dynamic initialisation, to an atomic that is
**constant-initialised** in `fsw_daq_lib` (`std::atomic<bool> g_running{true}`, a `constexpr`
constructor), so DSO initialisation order cannot bite and the binding does no I/O — S26 holds, and
after pass 1 exactly **two** of the three harness executables that `#include` a main (§7.3:
`char_cfg_stacklight`, `char_cfg_config_broadcast`) run the same binding at load with nothing
printed; `char_cfg_daq_bridge` includes a main WP8 does not touch, until WP10's cleanup binds its
`running` the same way. `fsw_daq_lib` is **`SHARED`** (`lib/CMakeLists.txt:45`): the one `running()`
call goes through the PLT; thereafter each `g_running` read is an atomic load through the stored
address, into the shared object's data — had the sites called `running()` instead, each read
would be a PLT call. Either way unobservable, and nothing a golden can see. The controller keeps
`static` so its symbol stays internal, as today; the other six are already inside an anonymous
namespace. File-static functions and lambdas that read `g_running` (heartbeat 106, t7 96/172/
192/268, sequencer 203, controller 82/171, ota 311) therefore change nothing either.

### 2.2 `lib/include/net/TcpCommandServer.hpp` + `lib/src/net/TcpCommandServer.cpp` (pass 2)

```cpp
namespace fsw::net {
struct TcpServeOptions { size_t max_clients; const char* busy_log_prefix; };  // 64; "[Sequencer] " | "[ControllerService] ⚠️  "
/** The loop sequencer_main.cpp:303-349 / controller_main.cpp:171-214 with identical syscalls
 *  and branches; the one textual change is the spawn lambda, which calls on_client(raw->fd)
 *  where today's calls handleClient(raw->fd, svc) / handleControlClient(raw->fd, svc) —
 *  unobservable (the Conn/reap_finished block 284-301 / 152-169 moves in front of it, §6.2): while
 *  (running) { reap; select(listen_fd, 10 ms); accept; reap; cap check: "ERR:too many
 *  connections\n" (MSG_NOSIGNAL), cerr << busy_log_prefix << "client limit (" << max_clients <<
 *  ") reached — refusing connection", close; spawn a tracked thread running on_client(fd) then
 *  done = true }. Then shutdown(SHUT_RDWR) every tracked fd, then join every thread. Borrows
 *  listen_fd; never closes it. */
void serveTcpClients(int listen_fd, const std::atomic<bool>& running,
                     const TcpServeOptions& opts, const std::function<void(int)>& on_client);
}
```

- **Body:** `Conn` and `reap_finished` move **verbatim** from `sequencer_main.cpp:284-301`, with
  their leading comment 282-283 (S38); the loop and the shutdown/join tail from 303-349. The
  controller's copy (151-214, its comment 151 included) is deleted. Deleting the `Conn`/
  `reap_finished` block from both mains is not optional: a `Conn` struct and a `reap_finished`
  lambda left behind with no loop to use them are `-Wunused-variable` on the lambda, and
  `baseline_warnings.txt` (10 lines) admits no new line. The 10 ms select timeout is a constant
  inside (both users; D17d).
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
- Adoption: sequencer 282-349 → `serveTcpClients(listen_fd, g_running, {kMaxClients,
  "[Sequencer] "}, [&svc](int fd){ handleClient(fd, svc); })`; 252-280 (listener and the two ready
  lines) and 351-353 unchanged. Controller 151-214 → `serveTcpClients(listen_fd, g_running,
  {kMaxControlClients, "[ControllerService] ⚠️  "}, [svc](int fd){ handleControlClient(fd, svc);
  })`; 128-149 and 216 unchanged. `g_running` is the main's reference to
  `fsw::service::running()` (§2.1), so the argument is the library's atomic. `kMaxClients` (51)
  and `kMaxControlClients` (72) stay named constants in their mains (§5).

### 2.3 The Elodin followers — not shared (D57)

Struck by the simplicity round; the section number is kept so citations hold. The decided text
(`follow_sequencer_state`, `SequencerStateFollowerText`, the file-static wrapper call form, the
back-off fact) is in `debates/WP8/history.md` and the verdict; the reason it is out is in §0
Rejected. What WP8 leaves exactly as it is: heartbeat `elodinThread` 103-152 and stacklight 99-136,
`kElodinRecvTimeoutMs` (41) and `kStacklightRecvTimeoutMs` (97), the `std::thread` lines 271 and
295, the joins 296 and 344-345, and the uninterruptible `sleep_for(2 s)` at heartbeat 109 /
stacklight 105 (with elodin-db down a stop is noticed only between connect attempts, so the exit
bound is ≈ 2 s, not the receive timeout; `lifecycle/golden/shutdown.txt:7` records stacklight
`[0, 1.2] s` with the db up — team question 5 stands, now as a fact about the mains).

## 3. Ownership and data flow

| piece | owns | threads | guarded by |
|---|---|---|---|
| `StopSignals` | the process stop flag, the notice settings | written by the signal handler (any thread the kernel picks), read by every loop | `std::atomic<bool>` (seq_cst, as today); settings written once before `signal()` |
| `serveTcpClients` | the `Conn` vector (calling thread's stack) and the client threads; **not** `listen_fd` | the calling thread (sequencer: main; controller: the detached control thread) + one per client | `Conn::done` atomic; the vector is touched only by the calling thread |
| listener fds, UDP sockets, destinations, config paths, argv loops, the two Elodin followers and their `ElodinClient`s | **the mains, unchanged** | — | — |

No new mutex. No lock is held across any call into shared code. The command-path locks inside
`SequencerService` and `ControllerService` are untouched (WP10 §1, incl. C4-1). Lifetimes that
must not move: sequencer's client threads are joined before `svc` is destroyed at the end of
`main` (282-283); the controller's control thread stays **detached** (500-501), so `main` reaches
`service.stop()` while it may still be in `select` (C4-5); ota's clients stay detached (S22).

## 4. Error handling: today, and how it stays

| failure | today | after WP8 |
|---|---|---|
| UDP `socket()`, bad IP, NIC resolve, `bindToDaqInterface` (heartbeat, stacklight, config_broadcast, AbortBroadcaster) | per-service text and exit code (§1.5) | **unchanged** (not shared); the two ignored binds gain a `// Kept: D-BIND` tag in pass 1 |
| TCP socket/bind/listen (sequencer, ota); socket/bind (controller: logged with `strerror`, control thread returns, service runs on) | logged, `close`, exit 1 / D-CTL | **unchanged** (listeners stay in the mains) |
| TCP listen (controller) | ignored (147) | unchanged; `// Kept: D-CTL` tag in pass 1 |
| 65th concurrent client | busy line + log, `close` | inside `serveTcpClients`, same bytes and log |
| oversized sequencer line, controller junk, ota junk | per-service reader (§1.6) | unchanged |
| Elodin subscribe refused / read error (heartbeat, stacklight) | log, `disconnect`, retry at once / heartbeat logs, stacklight silent, both disconnect | **unchanged** (the followers stay in their mains, D57) |
| bad TOML / missing file | `config::load` logs and returns defaults (C2-4); config_broadcast SIGABRT (C2-12) | no shared code catches or checks anything around `config::load` |
| bad CLI value | `atoi` → 0; t7 `exit(2)`; daq_bridge `stoi` throws → abort | **unchanged** (the argv loops are not touched, D57) |

Exit codes that must not change: 0 on clean stop and on `--help` everywhere; 1 for the startup
failures above; t7_bridge 2 (bad argv, T7 config errors), 3 (no LJM without `--fake`), 0 (no T7);
config_broadcast −6 (SIGABRT, C2-12); a process killed before its handler is installed: −2/−15;
any service whose SIGPIPE is default and is hit by one: −13.

## 5. Naming

- Namespaces follow the tree: `fsw::service` (new, process-level, camelCase with
  `installStopHandlers`), `fsw::net` (next to `DaqInterface`, camelCase). WP8 adds nothing to
  `fsw::elodin` (D57; D43(2)'s snake_case ruling for it stands for WP10's `register_all_tables`).
- `installStopHandlers`, `running()`: what they do to the process. Not "ServiceMain".
  `TcpCommandServer.hpp` holds `serveTcpClients`; not "LineCommandServer" (line reading stays in
  the mains).
- Per-service constants keep their names and stay in their mains (`kElodinRecvTimeoutMs`,
  `kStacklightRecvTimeoutMs`, `kMaxClients`, `kMaxLineBytes`, `kMaxControlClients`) because
  **nothing in WP8 moves them**: `serveTcpClients` takes `max_clients` as a value, and the
  followers are untouched. What cites them is narrower than "the READMEs": only
  `test/characterization/lifecycle/README.md:26` and `lifecycle/golden/shutdown.txt:7,27` (with
  the `[0, 4] s` rows 34-39 and `lifecycle.py:1381,1388,1535` that print them) name
  `kStacklightRecvTimeoutMs` and `kElodinRecvTimeoutMs`, as the *reason* for a bound, not as a
  symbol under test; **nothing under `test/` names `kMaxClients`, `kMaxLineBytes` or
  `kMaxControlClients`** (they appear only in `docs/`). Renaming any of them would break no
  test; they keep their names because a move-only pass renames nothing (S16). Log tags are not
  renamed (S16): tests grep them.

## 6. Passes

Pass 1 adopts the one piece that is behaviour-identical by construction and is the prerequisite
of WP9 and WP10, and places the three `// Kept:` tags (comment lines, no gate). Pass 2 adopts the
one move with identical syscalls and branches, `serveTcpClients` (§2.2: only the spawn lambda's
callee changes). One commit per (helper, service) pair, so a red
golden names its cause (D12e). Run the guards in §7 after each commit (under the stack lock,
subsets per D23); format only touched files with the pinned clang-format 19.1.7; clang-format's
include regrouping and rewraps are an expected non-dimmed diff (D43(6)).

### 6.1 Pass 1 — `StopSignals` + tags (one queue item; gaps 1-3 merged first)

In every main the edit is the same four things and nothing else: add
`#include "service/StopSignals.hpp"`; replace the flag's declaration with the namespace-scope
reference of §2.1 (same name, same place, `static` where it was `static`); delete the handler;
replace the `signal()` lines with the one `installStopHandlers` call from §2.1's table. **No read
site is touched** (D57): the lists below are what stays byte-identical, checked with `git diff`.
The `<signal.h>` / `<csignal>` include **stays** in each main (heartbeat 16, stacklight 12,
config_broadcast 12, ota 24, sequencer 30, controller 23 `<csignal>`, t7_bridge 22): the main no
longer calls `signal()` itself, but a move-only commit does not "fix" an include; the only include
diff expected is clang-format's regrouping around the new `service/StopSignals.hpp` line (D43(6)).

1. `lib/src/service/StopSignals.cpp` + header; append to `FSW_SOURCES`. Build.
2. t7_bridge: 56 → `auto& g_running = fsw::service::running();`; delete `on_signal` (83-85);
   343-345 → `fsw::service::installStopHandlers(fsw::service::ShutdownNotice::kPrintThenStop,
   nullptr, fsw::service::Sigpipe::kIgnore);` with 345's trailing comment on the call. Reads at
   96, 172, 192, 268 unchanged. Guard: `t7_integration` (CI, D34) + `t7` ctest.
3. heartbeat: 37 → the reference; delete 43-46; 228-229 → its call (§2.1 table). Reads at 106,
   276, 291 unchanged.
4. stacklight: 33 → the reference; delete 36-39; 264-265 → its call. Reads at 102, 305 unchanged.
   Run `config/check.sh cpp` (§7.3).
5. config_broadcast: 44 → the reference; delete 46-49; 498-499 → its call. Reads at 545, 600
   unchanged. Run `config/check.sh cpp` (§7.3).
6. ota: 43 → the reference; delete 45-48; 406-408 → its call with `kIgnore`. Reads at 311, 439
   unchanged.
7. sequencer: 46 → the reference; delete 55-58; 241-243 → its call with `kIgnore`, 243's trailing
   comment on the call. Reads at 203, 303 unchanged.
8. controller: 54 → `static auto& g_running = fsw::service::running();`; delete 56-59; 490-491 →
   its call (`…` is U+2026, copy the bytes); the `// ── Install signal handlers ──` banner 489
   stays (S38). Reads at 82, 171, 507 unchanged.
9. Tags, S12 long form (D46: `// Kept: <id> (D17) — <class>/<phase>: <rule violated>; loud
   half: <surface>`), comment lines only, one commit:
   - `controller_main.cpp:147`, above `::listen(listen_fd, 4);` —
     `// Kept: D-CTL (D17) — control/startup: S14, listen() status dropped, the service runs on
     with no TCP fire gate; loud half: none (the ready line 148-149 prints regardless; gap 6)`.
     With no `TcpListener` there is no `kListen` branch to make explicit (D43(4)); the tag on the
     call is the mark.
   - `heartbeat_service_main.cpp:252` and `config_broadcast_service_main.cpp:526`, above the
     `bindToDaqInterface` call — `// Kept: D-BIND (D17) — observation/startup: S14,
     bindToDaqInterface's bool dropped; loud half: its own cerr line (DaqInterface.cpp:198, 202)`.
     The config_broadcast tag is the third commit that touches a `#include`d main; run
     `config/check.sh cpp` again.

### 6.2 Pass 2 — `serveTcpClients` alone (one queue item; gap 5 merged green first)

Commit order — helper TU → sequencer → controller — so a bisect names its commit and the helper is
a contiguous block:

1. `lib/src/net/TcpCommandServer.cpp` + header; append to `FSW_SOURCES`. `Conn` and
   `reap_finished` **verbatim** from `sequencer_main.cpp:284-301`, with the comment 282-283 as
   `Conn`'s leading comment (S38). That comment is **stale where it lands**: it names `svc` and
   `main()`, and `TcpCommandServer.cpp` has neither. It still moves verbatim and is not re-homed
   to the sequencer's call site — S38 moves a definition with its leading comment and corrects
   stale comments in cleanup, not in a move-only. **Stale after pass 2 (one line):**
   `TcpCommandServer.cpp`'s `Conn` comment (ex sequencer 282-283) — corrected in WP10's cleanup
   queue item (DESIGN-WP10 §6.2). Build.
2. sequencer 282-349 → `serveTcpClients` (§2.2): the comment and the `Conn`/`reap_finished`
   block 282-301 go with the loop (left behind they are `-Wunused-variable`, and
   `baseline_warnings.txt` admits no new line); 252-280 (listener, the `Listening on port` line
   and the `Commands:` line) and 351-353 unchanged.
3. controller 151-214 → `serveTcpClients`; the comment 151 is dropped with the duplicate
   definition it introduced (S38: the surviving copy is the sequencer's, with its own comment);
   128-149 and 216 unchanged. The ready line 148-149 stays after `listen()` (whose failure is
   ignored, so it prints whenever bind succeeded). Commit message lists the S15 literal split
   (§2.2).

Do not touch, in either pass: stacklight's `trim`/`getTomlValue` (141-175, external linkage,
§7.3); the B4 encoders; the per-service constants; the precedence code; the argv loops; the two
followers and their `buf[5]/buf[6]` checks.

**Fallback (verdict §2, re-cut by D57).** Pass 2 has one piece and one gate: if gap 5 is not
merged green, pass 2 is **not queued** and the ledger records that `serveTcpClients` stays in its
two mains. There is no residual pass 2 (the tags are pass 1's). Pass 1 never waits on gap 5.

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
| followers (**not touched by WP8**, D57) | `packets/golden/service_{heartbeat,stacklight}.txt` (subscribe bytes, state→output map), `startup.txt` | black box with a stand-in elodin-db; listed so a red here is known not to be WP8's |
| config loading | `config/golden/bin/{daq_bridge,stacklight,config_broadcast}`; `config/golden/cpp/*` (§7.3); sequencer N6 load-time lines | black box + D18 white box |
| t7_bridge | ctest `t7_integration` (D31 list; D34: CI only), `t7` | ctest |
| everything | TSan CI job; integration (167 checks) | — |

### 7.2 Gaps (proposed cases; design only, none written here)

Classification (verdict, ratified under D39; re-cut by D57): **before pass 1** — 1, 2, 3
(`lifecycle/`); **before pass 2** — 5 (`sequencer/`) alone, the whole D32 batch for pass 2;
**worth writing, not gating** — 4 (`config/`), 6 (the only D-CTL characterization), 7
(`packets/`) and 8; **nice-to-have** — 9. Numbers are stable: DESIGN-WP10 and the research cite
them.

1. **[before pass 1] SIGPIPE disposition is not covered anywhere.** Case for `lifecycle/`: start
   each of the nine services alone (loopback config), `kill -PIPE <pid>`, record `alive after 1 s`
   or `exit -13`. Expected: daq_bridge, ota, sequencer, t7_bridge alive; controller, calibration,
   heartbeat, config_broadcast, stacklight exit −13. Mutation: flip one service's `Sigpipe` → red.
   The only test that would catch a uniform setting.
2. **[before pass 1] Shutdown of sequencer, controller and t7_bridge** is not in `shutdown.txt`.
   Add SIGTERM and SIGINT exit code and latency bound for each (controller's > 3 s, C4-5, as a
   bound, not a fix). Plus research §1's **second-SIGTERM case** (verdict §5; team question 2
   confirms): SIGTERM twice 50 ms apart to heartbeat, expect exit 0, not −15 (catches
   `SA_RESETHAND`). Also closes DESIGN-WP10 gap 2. **Note for its author, controller case:** the
   controller installs its handlers at 490, after `service.initialize` (462-465) and the PWM/NIC
   setup (313-352), so the SIGTERM is sent only once the post-install line `🎯 Controller running.
   PWM gated to FIRE state (TCP :N).` (503) is in the log; a SIGTERM before that line kills with
   −15 legitimately (§1.2) and is not a failure of the case.
3. **[before pass 1] The `Shutting down` line** printed by each handler is read by no test; nor is
   daq_bridge's flag-then-print order. Add, per service, the handler's exact line (bytes, incl.
   the leading newline and controller's U+2026) and its position relative to the service's final
   line to `shutdown.txt`.
4. **[worth writing, not gating] `--help` text and exit code** of all nine binaries, and
   t7_bridge's exit 2 on an unknown flag and on a missing value: a `config/golden/bin/help/`
   golden (stdout, exit code). Not gating since D57: WP8 no longer touches an argv loop.
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
   these ladders (C0 writes it, LEDGER D54(1)).
7. **[worth writing, not gating] Follower reconnect and subscribe-refused**: no case drops a
   follower's connection and checks that heartbeat/stacklight re-subscribe. Not gating since D57
   (the followers stay in their mains). **Reconnect half**, as before: with the stand-in db
   (`packets/bb.py` `FakeElodin`, 278-385), drop the connection, expect a second identical
   subscribe request (`len=6 ty=0 id=[0x11,0x0d] payload 50 00`) and resumed state tracking.
   `FakeElodin` cannot do this today: its only teardown is `close()`, which shuts every accepted
   socket and the listener; the case needs a **per-connection close** (shutdown + close one
   accepted socket, let its `_read` thread exit, keep the listener up) — add that to `bb.py`
   first. **Refused half, re-specified so it can fail.** The old text ("stand-in replies with an
   error") tests nothing: `subscribe_tables` (`ElodinClient.cpp:95-103` → `subscribe_table`
   105-118 → `send_msg` 255-285) returns false only when the socket is not connected, `write_all`
   fails, or it throws; an ErrorResponse from the db is never read on this path, so the stand-in's
   reply cannot reach the `Failed to subscribe` branch. The branch is reached only if the
   **subscribe write itself fails**: specify "the stand-in closes the accepted socket before the
   follower's first write". Know its limit before writing it: a plain `close()` sends FIN, and
   the first `write()` after a FIN normally succeeds (the RST comes back after the data), which
   lands in the `read failed` branch instead; forcing the write to fail needs an RST on the wire
   (`SO_LINGER {1, 0}` then `close()`), and even that races the follower's connect → write on
   loopback. If the author cannot make it deterministic, **delete that half** rather than keep a
   case that cannot go red; the reconnect half covers the retry-at-once path's observable (a
   second subscribe) either way.
8. **[worth writing, not gating] Config path fallback** (heartbeat, stacklight, config_broadcast,
   controller) has no case where `--config` names a missing file and a fallback exists. Add to
   `config/golden/bin/`. Not gating: the blocks stay in their mains — and since D57 the argv loops
   that feed them stay too, so WP8 touches nothing between `argv` and `config::load`.
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
byte-identical by construction: do not move, rename or change the linkage of any symbol above —
and since D57 this is true by inspection: in stacklight and config_broadcast WP8 touches only the
flag declaration (33 / 44, now the reference), the handler (36-39 / 46-49), the two `signal()`
lines (264-265 / 498-499), one `#include`, and the D-BIND tag comment at config_broadcast 526;
`main`'s body beyond the two `signal()` lines (stacklight 264-265, config_broadcast 498-499) and
the D-BIND tag at config_broadcast 526, `elodinThread`, `trim`, `getTomlValue`,
`parseVentAbortFromCsv` and `buildPackets` are not edited. Every header a WP8 main newly includes
lives under `lib/include` with its source in `fsw_daq_lib` (nothing new on `_CFG_INCLUDES` or the
link line); no identifier spelled `main` in any new header; no static object in a new TU prints or
reads a file at load (S26); the namespace-scope `g_running` reference (§2.1) also runs its dynamic
initialisation inside the two harness executables whose main pass 1 edits (`char_cfg_stacklight`,
`char_cfg_config_broadcast`; `char_cfg_daq_bridge` includes an untouched main until WP10's
cleanup) — one call into `fsw_daq_lib` returning a constant-initialised atomic, no I/O, nothing
printed; `serveTcpClients` and the `StopSignals` TU are linked but never called by the
harness and must not register anything at load. If a change nevertheless needs the harness
touched, D18 applies (those two files only, goldens byte-identical, mutations re-run, orchestrator
reviews). Run `bash test/characterization/config/check.sh cpp <bin dirs>` (ctest
`characterization_config_cpp`, no lock) after every commit that touches stacklight or
config_broadcast (pass 1 steps 4, 5 and 9), and `config/run.sh` (bin half, under the lock) once
per such commit.

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
  are in no timing ctest — so pass 2 has no timing-ctest exposure. What each pass does touch
  beyond the goldens that gate it: pass 1, the config `golden/cpp/` via the stacklight and
  config_broadcast `#include`s (§7.3; the flag, handler and signal lines, and the D-BIND tag);
  pass 2, the sequencer characterization's republish bounds (`[0.8, 1.5]×`, judged on the Linux
  leg and CI) — pass 2 edits no `#include`d main.
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
usage-on-unknown-flag stay per service — confirm nobody wants them in a shared parser later (D57
left every argv loop where it is, so this is now purely a question for a later package).

Remaining team questions (verdict §6, verbatim; after D57, 4 and 5 are about the followers in
their mains and no longer about a WP8 helper):

1. Who writes gap 6, the only D-CTL characterization, now that no WP owes it? — **Answered**,
   LEDGER D54(1): C0 writes it, not gating.
2. Add research §1's second-SIGTERM case (catches `SA_RESETHAND`) to gap 2?
3. Ratify the D-FD shape above, and that `UniqueFd` arrives with that package?
4. Self-pipe: the follower's wake needs `ElodinClient` to expose its fd — in the proposal's scope?
5. Should `shutdown.txt` gain a db-down follower case, given the 2 s back-off makes stacklight's `[0, 1.2] s`
   conditional?
