# DESIGN-WP8 — shared C++ service plumbing

Target design for WP8 (BLOAT-MAP §5 B1–B3, B5, B6; WP8 row), written before any code moves (D17a).
Design only: nothing here changes a golden, and every observable listed in §6 stays bit for bit.

Line numbers are for `backend-remastered` @ b2599617 (product code identical to `main` @ 15b5a0c5;
only `test_integration.sh`, `.gitignore` and the top `CMakeLists.txt` differ). Paths are relative
to `daq-server/diablo_server/` unless they start with `test/` or `docs/`. The `packets/` and
`elodin/` characterization areas are **not on `backend-remastered` yet**: they are on `queue/C1`
(f872c788); read them with `git show queue/C1:daq-server/test/characterization/packets/...`.

**Prerequisites:** C1 (`packets/`, `elodin/`) merged into `backend-remastered`; the gaps marked
"before pass 1" in §7.2 closed (characterization, merged and gated).

**Orchestrator decisions recorded here (design review):** sharing functions rather than classes,
and the narrower set of shared pieces in §0, is accepted. Pass 1 (adoption) and pass 2 (cleanup)
are **separate queue items, each fully gated** (full gate + Linux leg + CI, D19).

Order in the DAG: WP3 → **WP8** → WP9 → WP10. WP8 adopts the shared code in the files BLOAT-MAP
gives it: `services/{heartbeat,stacklight,config_broadcast,ota,controller}/*_main.cpp`,
`services/sequencer/{sequencer_main,AbortBroadcaster}.cpp`, `services/t7_bridge/t7_bridge_main.cpp`.
`calibration_main.cpp` adopts in WP9's cleanup pass and `daq_bridge_main.cpp` in WP10's cleanup
pass; this note fixes their settings (§2 tables) so those packages only apply them. WP8 does not
edit `SequencerService.cpp`, `ActuatorCommander.cpp`, `ControllerService.cpp`, `PressureFeed.cpp`.

## 0. Summary of the decision

BLOAT-MAP proposed four shared pieces (`UdpSender`, `LineCommandServer`, `SubscriberLoop`,
`ServiceMain`). Read against the source, most of the "copies" differ in ways a test or an operator
can see: SIGPIPE, handler print order, backlog, select timeout, client cap, thread lifetime, read
discipline, reconnect cadence, which failures are fatal. D17 forbids both a uniform pattern that
changes any of that and an abstraction with one user. What survives:

| shared piece | users in WP8 | later users | replaces |
|---|---|---|---|
| `fsw::service` stop flag + `installStopHandlers()` | heartbeat, stacklight, config_broadcast, ota, sequencer, controller, t7_bridge | calibration (WP9), daq_bridge (WP10) | B5, 9 handlers + 9 flags |
| `fsw::net::openUdpSocket()` | heartbeat, stacklight, config_broadcast, AbortBroadcaster | ControllerService, ActuatorCommander, BackendLogForwarder (WP10, optional) | B1 `socket()` + `SO_BROADCAST` |
| `fsw::net::ipv4Destination()` | heartbeat, stacklight, config_broadcast | ControllerService ×2, BackendLogForwarder (WP10, optional) | B1 `sockaddr_in` fill + `inet_pton` |
| `fsw::net::openTcpListener()` | sequencer, controller, ota | — | B2 listen-socket setup |
| `fsw::net::serveTcpClients()` | sequencer, controller | — | B2 select/accept/reap/cap/join loop |
| `fsw::elodin::followSequencerState()` | heartbeat, stacklight | — | B3 the two identical `[0x50,0x00]` subscriber threads |
| `fsw::config::findConfigFile()` + `readFileText()` (cleanup pass) | heartbeat, stacklight, config_broadcast, controller | — | B6 the config-path fallback blocks |

Rejected, with the reason kept here so a later package does not reintroduce them:

- **`ServiceMain` / a framework `main`.** No two services start in the same order (§1.2): signals
  are installed after config in heartbeat/stacklight/config_broadcast, **before** `svc.init()` in
  the sequencer (`sequencer_main.cpp:241-249`: handlers at 241-243, `init` at 245-249), after
  `initialize()` and before `start()` in the controller (462-497), right after the positional
  argv and the config-exists check in daq_bridge; a SIGTERM that arrives before installation kills the process with -15, after it
  exits 0. A framework that owns the order changes exit codes. The shared "pattern" is the stop
  flag, the handler installer and a documented skeleton (§2.1), not a function.
- **A shared argv parser.** Nine flag sets, nine `--help` texts, three missing-value policies
  (ignore / t7's `exit(2)` / daq_bridge's positional `std::stoi` that throws), two unknown-flag
  policies (ignore / t7's usage + exit 2), clamping at parse time in some and after config in
  others. A table-driven parser would need a per-service hook for each of those; nothing is left
  to share. Each main keeps its loop; the cleanup pass only moves it into a file-static
  `parseArgs()` (§6.2).
- **A generic `SubscriberLoop`.** The eight B3 sites are four different things: two identical
  `[0x50,0x00]` followers (shared, above); two subscribers with their own retry rules
  (`PressureFeed::runLoop`: 200 ms back-off, re-subscribe of tables that never delivered, `mtx_`
  around the table list; `ControllerService::elodinSubscriberLoop`: 101 tables, 20 × 100 ms
  back-off, header-then-payload reads, no receive timeout); calibration's tracker-driven
  subscribe with **no retry on the first connect (exit 1, C6-9)** and an uninterruptible 2 s
  sleep on reconnect; and three publishers (`SequencerService` 5 s retry thread, `t7_bridge`
  2 s gate inside the stream loop, `daq_bridge` 5 s gate inside the packet loop). A loop with
  knobs for all of them is a different program per caller. They stay where they are; WP9/WP10
  move them as-is.
- **An owning `UdpSender` class.** Lifetimes differ: AbortBroadcaster and ActuatorCommander open a
  socket per send; heartbeat closes its socket before joining the Elodin thread; ControllerService
  closes in its destructor. RAII would move `close()` to scope end. Functions, not a class.
- **`transport/NetworkSocket.hpp` `UDPSocket`.** Sets `O_NONBLOCK` and `SO_REUSEADDR` and binds in
  its constructor (`transport/src/transport/NetworkSocket.cpp:17-60`): a non-blocking `sendto`
  changes what a full send buffer does. Not adopted.
- **A shared `trim()`.** Two semantics: stacklight and config_broadcast strip `"` too
  (`stacklight_service_main.cpp:141-145`, `config_broadcast_service_main.cpp:55-59`); ota and
  sequencer do not (`ota_service_main.cpp:50-54`, `sequencer_main.cpp:60-64`). Merging changes
  parsing. The two quote-stripping copies are a two-user candidate, but stacklight's sits outside
  the anonymous namespace and is reached by the config harness (§7.3); leave both.
- **B4 (hand-rolled encoders).** PARKED (LEDGER Parked, BLOAT-MAP B4): WP8 touches no packet
  encoder — not `buildHeartbeatPacket`, not `stateToStacklight`/`create_stacklight_command_packet`,
  not `buildPackets`, not `AbortBroadcaster::sendPacket`'s header, not daq_bridge's
  `build_server_heartbeat_packet` (which uses `DIABLO_COMMS_VERSION` and `steady_clock` where
  heartbeat_service uses 0 and `system_clock`; both frozen).
- **Header parsing via `elodin::PacketHeader`.** `buf[5]/buf[6]` reads stay. The struct
  (`lib/include/elodin/ElodinProtocol.hpp:17-22`) would read the same bytes, but nothing is gained
  that a golden could confirm beyond the follower goldens already pinning the bytes; not worth a
  diff in WP8.

## 1. Current responsibilities and shared state

### 1.1 Per service: threads, flags, mutexes

No service main holds a mutex today except t7_bridge's `g_log_mutex`. Shared state between threads
is atomics only.

| service (file, lines) | threads | cross-thread state | mutexes / lock order |
|---|---|---|---|
| heartbeat (`services/heartbeat/heartbeat_service_main.cpp`, 299) | main: send loop 276-293; `elodinThread` 103-152 | `g_running` 37, `g_engine_state` 38 (atomics) | none |
| stacklight (`services/stacklight/stacklight_service_main.cpp`, 348) | main: send loop 305-341; `elodinThread` 99-136 unless `--force-state` 289-296 | `g_running` 33, `g_seq_state` 34 | none |
| config_broadcast (`services/config_broadcast/config_broadcast_service_main.cpp`, 607) | main only, loop 545-602 | `g_running` 44 | none |
| ota (`services/ota/ota_service_main.cpp`, 459) | main: accept loop 439-454; one **detached** thread per client 451-453 running `handleClient` 300-375 (may fork `pio`, 230-245) | `g_running` 43; `g_bind_address` 62 written once before threads | none |
| sequencer (`services/sequencer/sequencer_main.cpp`, 354) | main: accept loop 303-341; one tracked thread per client 333-340 (`handleClient` 197-222); plus everything `SequencerService` starts (WP10) | `g_running` 46; `Conn::done` atomics 284-288; `conns` vector touched only by main | none in the main; each command goes through `SequencerService`'s queue (WP10 §1) |
| controller (`services/controller/controller_main.cpp`, 514) | main: wait loop 507-509; **detached** `control_thread` 500-501 running `runControlServer` 127-217, which runs one tracked thread per client (`handleControlClient` 75-125); plus `ControllerService` threads (WP10) | `g_running` 54 (static); `Conn::done` | none in the main |
| t7_bridge (`services/t7_bridge/t7_bridge_main.cpp`, 356) | main: joins 353-354; one thread per enabled T7, `run_board` 159-274 | `g_running` 56 | `g_log_mutex` 59, leaf lock taken only in `Line::~Line` 64-67 |
| calibration (`services/calibration/calibration_main.cpp`, 2139) | WP9 | `running` 154 (static) | WP9 |
| daq_bridge (`daq_bridge/daq_bridge_main.cpp`, 1074) | main only | `running` 106 (**external linkage**) | none in the main |

### 1.2 Startup order (observable: a signal before installation is fatal, and log line order)

| service | order today (lines) |
|---|---|
| heartbeat | argv 179-199 → config path fallback 202-213 → `config::load` 217 → precedence 218-226 → **signals 228-229** → UDP socket + `SO_BROADCAST` 232-240 → NIC resolve (fatal) + bind (result ignored) 246-253 → dest 255-263 → 2 start lines 265-268 → Elodin thread 271 → loop |
| stacklight | argv 186-208 → fallback + read text 211-228 → `getTomlValue` overrides 230-262 → **signals 264-265** → socket 268-272 → dest 274-282 → 2 start lines 284-287 → `--force-state` line or Elodin thread 289-296 → loop |
| config_broadcast | argv 456-466 → fallback + read text 468-485 → empty → exit 1 487-490 → `config::load` for interval 493-496 → **signals 498-499** → `buildPackets` 503 (+ warning 504-507) → socket 509-513 → NIC resolve (fatal) + bind (ignored) 519-527 → 2 start lines 533-535 → loop |
| ota | argv 383-396 → NIC resolve (fatal) 398-404 → **signals + SIGPIPE ignore 406-408** → listen socket 410-434 → 2 start lines 436-437 → loop |
| sequencer | argv 229-239 → **signals + SIGPIPE ignore 241-243** → `svc.init` (exit 1) 245-249 → listen socket 252-276 → 2 start lines 278-280 → loop |
| controller | argv 239-273 → config text with logged fallbacks 276-301 → `config::load` 303 → `loadStatesFromConfig` 310 → PWM/NIC/settings 313-352 (NIC fatal 327-332) → banner 355-394 → fire state 401-423 → gate posture 430-451 → LUT paths 453-460 → `service.initialize` (exit 1) 462-465 → command 468-487 → **signals 490-491** → `service.start` (exit 1) 494-497 → control thread 500-501 → start line 503 → wait loop |
| t7_bridge | argv 279-309 → no-LJM check (exit 3) 311-318 → `config::load` 320 → t7 errors (exit 2) 321-326 → board filter (exit 0) 328-337 → **signals + SIGPIPE ignore 343-345** → start line 347 → threads |
| calibration | argv 602-617 → adjustments discovery 619-651 → 2 start lines 653-654 → **signals 656-657** → rest is WP9 |
| daq_bridge | positional argv 309-318 → 3 start lines 320-323 → config exists (exit 1) 330-339 → **signals + SIGPIPE ignore 341-344** → rest is WP10 |

### 1.3 Signal handling today

All nine use `signal()`/`std::signal()` (BSD semantics on glibc and macOS: `SA_RESTART`, handler
stays installed). None uses `sigaction`. The handler bodies:

| service | handler (lines) | body, in order | async-signal-safe | SIGPIPE |
|---|---|---|---|---|
| heartbeat | `signalHandler` 43-46 | `std::cout << "\n[HeartbeatService] Shutting down..." << std::endl;` then flag = false | no | **default (dies)** |
| stacklight | `signalHandler` 36-39 | `"\n[StacklightService] Shutting down..."`, then flag | no | **default (dies)** |
| config_broadcast | `signalHandler` 46-49 | `"\n[ConfigBroadcast] Shutting down..."`, then flag | no | **default (dies)** |
| ota | `signalHandler` 45-48 | `"\n[OTAService] Shutting down..."`, then flag | no | ignored (408) |
| sequencer | `signalHandler` 55-58 | `"\n[Sequencer] Shutting down..."`, then flag | no | ignored (243) |
| controller | `signalHandler` 56-59 | `"\n[controller_service] Caught signal, shutting down…"` (U+2026), then flag | no | **default (dies)** |
| calibration | `signalHandler` 459-462 | `"\n[CalibrationService] Caught signal, shutting down..."`, then flag | no | **default (dies)** |
| daq_bridge | `signal_handler` 108-111 | flag = false **first**, then `"\n[DAQ Bridge] Shutting down..."` | no | ignored (344) |
| t7_bridge | `on_signal` 83-85 | flag = false only | yes | ignored (345) |

The SIGPIPE column is LEDGER Parked "SIGPIPE disposition" verbatim; it is a per-service setting in
§2.2 and stays so until the team decides. Exposure today: every service reply on a TCP command
socket uses `MSG_NOSIGNAL` (`sequencer_main.cpp:75,326`, `controller_main.cpp:97,192`,
`ota_service_main.cpp:305`), so a disconnected command client cannot kill anyone. What can: writes
to the Elodin socket, which `transport/src/transport/TCPClient.cpp:148` does with `::write`. That
is how a db restart can kill controller (publisher), calibration (publisher and subscriber), and the
heartbeat/stacklight followers (their only writes are subscribe requests on connect).

### 1.4 CLI and config loading today

| service | default path | flags (lines) | missing value | unknown flag | `--help` | config resolution | precedence |
|---|---|---|---|---|---|---|---|
| heartbeat | `config/config.toml` | `--config --elodin-host --elodin-port --interval-ms --broadcast-ip --broadcast-port` 179-199 | flag ignored | ignored | stdout, 2 lines, exit 0 (194-197) | if unopenable, first of `config/config.toml`, `../config/config.toml` that opens, else unchanged (silent) 202-213; then `config::load` | defaults < config < CLI; interval clamped `max(100, …)` after merge |
| stacklight | `config/config.toml` | `--config --elodin-host --elodin-port --interval-ms --target-ip --target-port --force-state` 186-208 | ignored | ignored | stdout 2 lines, exit 0; **omits `--force-state`** | same fallback list, reads the text 211-228; own `getTomlValue` 147-175 | **config overrides CLI** (C1-11, C6-7); `std::stoi` (C2-3) |
| config_broadcast | `config/config.toml` | `--config --interval-ms` 456-466 | ignored | ignored | stdout 1 line, exit 0 | same list, reads text; empty → `[ConfigBroadcast] No config loaded`, exit 1 (487-490) | CLI `--interval-ms` (clamped 500) overrides config (clamped 500); config re-read every cycle in `buildPackets` |
| ota | `config/config.toml` | `--port --config` 383-396 | ignored | ignored | stdout 3 lines, exit 0 | none; `config::load` directly 398-400 | — |
| sequencer | `config/config.toml` | `--config --port` 229-239 | ignored | ignored | stdout 1 line, exit 0 | none; `svc.init(config_path)` (WP10) | — |
| controller | `../../config/config.toml` | `--config --elodin-host --elodin-port --control-port --thrust --p-fuel --p-ox --lut-path` 239-273 | ignored | ignored | stdout 8 lines, exit 0 | logged fallback over **three** paths 276-301 (`❌ Cannot open config: …`, `ℹ️  Using fallback config: …`, `❌ No config.toml found. Using defaults.`, `📋 Loaded config: …`) | defaults < config < CLI |
| t7_bridge | `config/config.toml` | `--config --board --elodin-host --elodin-port --fake --fake-state` 280-309 | `<flag> needs a value` → `exit(2)` (283-286) | usage to stdout, **exit 2** | same usage, exit 0 | none | CLI over `[database]` |
| calibration | `config/config.toml` | `--config --host/--elodin-host --port/--elodin-port --adjustments` 602-617 | ignored | ignored | stdout 1 line, exit 0 | none | WP9 |
| daq_bridge | `config/config.toml` | positional `argv[1..3]` 313-318; `std::stoi(argv[3])` throws on junk (uncaught) | — | — | none | must open or `❌ FATAL … not found`, exit 1 (330-339) | `[network] sensor_port` overrides `argv[3]` (C1-12) |

`config::load` (`lib/src/config/Config.cpp`) logs and returns defaults on a missing or malformed
file (C2-4). No shared code may wrap it in `try` or add a check: config_broadcast's uncaught
`std::invalid_argument` → SIGABRT is frozen in `test/characterization/config/golden/bin/` (C2-12),
daq_bridge's caught one → exit 1 likewise.

### 1.5 UDP sender setup today (B1)

| site (lines) | lifetime | `SO_BROADCAST` | `SO_SNDTIMEO` | bind | dest | failure handling |
|---|---|---|---|---|---|---|
| heartbeat 232-263 | process | yes (237-240) | no | `resolveDaqBindAddress` fatal (exit 1), `bindToDaqInterface` result ignored | `memset`, `htons`, `inet_pton` ≠ 1 → `Invalid broadcast IP: …`, exit 1 | `socket() failed`, exit 1 |
| stacklight 268-282 | process | no | no | none | as heartbeat → `Invalid target IP: …`, exit 1 | `socket() failed`, exit 1 |
| config_broadcast 509-560 | process | no | no | resolve fatal, bind ignored (519-527) | `memset` once 529-531; per packet `inet_pton` ≠ 1 → count `tx_bad_addr`, skip; then `sin_port` 554-558 | `socket() failed`, exit 1 |
| AbortBroadcaster `sendPacket` (`services/sequencer/AbortBroadcaster.cpp` 74-125) | per send | yes (86-87) | 100 ms (98-99) | `bindToDaqInterface` non-fatal, logged (91-94) | precomputed `dest_addr_` | `socket() failed`, return |
| ActuatorCommander `sendBatch` (`services/sequencer/ActuatorCommander.cpp` 343-390) | per send | no | 100 ms (352-355) | **hand-rolled `bind` even for 0.0.0.0** (357-365), fatal for the send | precomputed per board | `socket() failed: <strerror>` |
| ControllerService `initialize` (`lib/src/control/ControllerService.cpp` 92-103) | object | no | no | `bindToDaqInterface` fatal | per send 431-437, 498-502 | `❌ Failed to create UDP socket: <strerror>` |
| daq_bridge `BackendLogForwarder` (`daq_bridge/daq_bridge_main.cpp` 54-90) | object | no | no | none (loopback) | `memset`, `inet_pton` result ignored | `ready()` false, logged by caller 486-490 |

### 1.6 TCP command servers today (B2)

| | sequencer (`sequencer_main.cpp`) | controller (`controller_main.cpp`) | ota (`ota_service_main.cpp`) |
|---|---|---|---|
| port | `--port`, default 9998 | `[controller_service].port` / `--control-port` | `--port`, default 9997 |
| runs on | main thread | detached thread (500-501) | main thread |
| socket/bind/listen | 252-276; each failure logged, `close`, **exit 1** | 128-147; socket/bind failure logged with `strerror`, `close`, **return — the service keeps running without its control port**; `listen()` result ignored | 410-434; logged, exit 1 |
| `SO_REUSEADDR` | yes | yes | yes |
| backlog | 10 | 4 | 5 |
| ready log | `[Sequencer] Listening on port N` + command list 278-280 | `[ControllerService] 🎮 Control server on TCP :N  (FIRE_START | FIRE_STOP)` 148-149 | `[OTAService] Listening on port N` + 437 |
| select timeout | 10 ms (310) | 10 ms (174) | 1 s (443) |
| client cap | `kMaxClients` 64 (51); reap before and after accept | `kMaxControlClients` 64 (72); same | none |
| busy reply | `"ERR:too many connections\n"`, `MSG_NOSIGNAL`, log `[Sequencer] client limit (64) reached — refusing connection` | same bytes; log `[ControllerService] ⚠️  client limit (64) reached — refusing connection` | — |
| client threads | tracked (`Conn{th, fd, done}`), joined; at exit `shutdown(fd, SHUT_RDWR)` all, then join all, then `close(listen_fd)` 345-351 | identical 152-216 | **detached**, never joined |
| per-client read | `SO_RCVTIMEO` 5 s; `recv` 512-byte chunks; every `\n` line dispatched; `buf.size() > 512` → log `oversized command — dropping connection`, close (197-222) | `SO_RCVTIMEO` 5 s; up to 64 bytes; first line only; one reply; close (75-125) | `SO_RCVTIMEO` 30 s; one byte per `recv`; first line; silently keeps ≤ 8192 bytes; one reply; close (300-375) |
| reply texts | `OK`, `OK:<ms>`, `ERR:<reason>` (83-177, WP10 for the reasons) | `OK\n`, `ERR\n`, `ERR:fire gate disabled (sequencer owns the valves)\n` | `OK\n`, `ERR:<reason>\n` (319-372) |

### 1.7 Elodin connect/subscribe/reconnect sites (B3)

| site (lines) | role | connect retry | subscribe | recv timeout | read error | owner after WP8 |
|---|---|---|---|---|---|---|
| heartbeat `elodinThread` 103-152 | subscriber `[0x50,0x00]` | 2 s sleep | `subscribe_tables({kTableSequencerState})`; fail → cerr line, `disconnect`, retry at once | 3000 ms (`kElodinRecvTimeoutMs` 41) | cerr `Elodin read failed (<err>) — reconnecting`, `disconnect` | **`followSequencerState`** |
| stacklight `elodinThread` 99-136 | same | 2 s | same, own text | 500 ms (`kStacklightRecvTimeoutMs` 97) | silent `disconnect` | **`followSequencerState`** |
| `PressureFeed::runLoop` (`services/sequencer/PressureFeed.cpp` 78-193) | subscriber, calibrated PTs | 200 ms | table list copied under `mtx_` after connect; fail → log, `disconnect`, 200 ms sleep | 200 ms | silent `disconnect` | unchanged |
| `ControllerService::connectSubscriber`/`elodinSubscriberLoop` (`ControllerService.cpp` 763-818) | subscriber, 100 PT tables + `[0x50,0x00]` | 20 × 100 ms, checks `running_` | fail → log, `disconnect` | none (header reads) | read loop exits on `!is_connected()` | WP10 moves as-is |
| calibration 1477-1595 | subscriber + publisher, tracker | **first connect: none, `return 1`** (1544-1545); later `reconnect()` after an uninterruptible 2 s sleep (1564-1578) | `subscribe_table` per table with `SubscriptionTracker` | 1000 ms | — | WP9 |
| `SequencerService::tryConnectElodin`/`startElodinRetry` (`SequencerService.cpp` 1253-1293) | publisher | thread, `kElodinRetrySeconds` 5 in 100 ms slices | — (registers tables) | — | — | WP10 moves as-is |
| t7_bridge `run_board` 195-206 | publisher | gate every 2 s inside the stream loop | — (registers raw tables) | — | — | unchanged |
| daq_bridge 574-606 and 745-776 | publisher | first connect once; then every 5 s inside the packet loop | — (two registration lists, the second without return checks and without the 1.5 s drain) | — | — | WP10 (`registerAllTables`, cleanup) |

## 2. Target boundaries and public interfaces

All new code goes into `fsw_daq_lib` (`lib/CMakeLists.txt` `FSW_SOURCES`, appended at the end of
the list) so every service, the sequencer test targets that compile `AbortBroadcaster.cpp`, and the
config harness (`test/characterization/config/CMakeLists.txt`, which links `fsw_daq_lib` and adds
`lib/include`) pick it up with no CMake change beyond the source list. Headers in `lib/include/`
under the directory of their namespace. Inside `namespace fsw`, refer to config types as
`::fsw::config::Config` (the `fsw::fsw` trap noted in `lib/include/net/DaqInterface.hpp:57-59`).

### 2.1 `lib/include/service/StopSignals.hpp` + `lib/src/service/StopSignals.cpp`

```cpp
namespace fsw::service {

/** What the SIGINT/SIGTERM handler prints. Each value is one service's behaviour today. */
enum class ShutdownNotice {
    kSilent,         // flag only (t7_bridge)
    kPrintThenStop,  // std::cout << line << std::endl; then flag = false (seven services)
    kStopThenPrint,  // flag = false; then std::cout << line << std::endl (daq_bridge)
};

/** Whether SIGPIPE keeps its default action (the process dies) or is ignored. Per service: see
 *  LEDGER Parked "SIGPIPE disposition". Do not change a service's value in a refactor. */
enum class Sigpipe { kDefault, kIgnore };

/** The process's stop flag: true until SIGINT/SIGTERM. Constant-initialised. */
std::atomic<bool>& running();

/** signal(SIGINT, h); signal(SIGTERM, h); and, for kIgnore, signal(SIGPIPE, SIG_IGN) — in that
 *  order, with ::signal (BSD semantics, SA_RESTART), never sigaction. `line` is printed verbatim
 *  (callers include the leading "\n") and must outlive the process (a string literal). */
void installStopHandlers(ShutdownNotice notice, const char* line, Sigpipe sigpipe);

}  // namespace fsw::service
```

Implementation notes (all load-bearing):

- One file-static `std::atomic<bool> g_running{true}` (constant initialisation, no static-init
  order issue), one file-static `const char* g_line` and `ShutdownNotice g_notice`, written by
  `installStopHandlers` before the `signal()` calls. They are plain globals, not atomics, and
  that is safe because every thread in every service is created **after** its
  `installStopHandlers` call (heartbeat 271 > 228, stacklight 295 > 264, ota 451 > 406, sequencer's
  `svc.init` threads > 241, controller `service.start()` 494 and the control thread 500 > 490,
  t7_bridge 351 > 343, daq_bridge's discovery 473 > 341; config_broadcast and calibration run one
  thread; `ControllerService::initialize` at 462 starts none — its threads start in `start()`,
  `ControllerService.cpp:203,208`). The writes happen-before every `std::thread` constructor, so
  every thread sees them; the handler itself runs only after `signal()` returns. If a future
  change starts a thread before the call, these must become atomics.
- The handler is one function with a `switch (g_notice)`; each case is today's body **statement
  for statement**, including the non-async-signal-safe `std::cout << … << std::endl`. Making the
  handlers async-signal-safe is a parked defect (BLOAT-MAP defect 6), not WP8's: a `write(2)`
  bypasses the `std::cout` buffer and changes line order in captured logs.
- `::signal`, not `sigaction`: `sigaction` without `SA_RESTART` makes blocked `recv`/`accept`/
  `select`/`usleep` return `EINTR` and changes shutdown timing; with `SA_RESTART` it is equivalent
  but is a diff with no benefit.
- No static object in the TU prints or does work at load: the config harness captures process
  stdout around a `#include`d main (§7.3).

Per-service settings (the whole table is the contract; the call goes exactly where today's
`signal()` lines are, §1.2):

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

Every read of the old flag (`g_running`, `running`) becomes `fsw::service::running()` (each main
may bind `auto& g_running = fsw::service::running();` at the top of `main` to keep the diff to
the declaration; lambdas and file-static functions that read it call `running()`).

The documented skeleton every main follows (a pattern, not code): parse argv → locate and load
config → resolve settings with the service's own precedence → open sockets → start-up log lines →
start threads → loop on `running()` → tear down in the service's own order → final log line →
`return 0`. **`installStopHandlers` has no fixed slot in that sequence**: it goes exactly where
each service installs its handlers today (§1.2), always before the service's first thread:
after config in heartbeat (228), stacklight (264) and config_broadcast (498); after the NIC
resolve and before the listener in ota (406); **before `svc.init()` in the sequencer** (241-243,
`init` at 245); after `initialize()` (462) and before `start()` (494) in the controller (490);
after the board filter in t7_bridge (343); after the banner and before config load in calibration
(656); after the config-exists check in daq_bridge (341). Steps are kept in today's order per §1.2
even where that order looks wrong.

### 2.2 `lib/include/net/UdpSocket.hpp` + `lib/src/net/UdpSocket.cpp`

```cpp
namespace fsw::net {
/** socket(AF_INET, SOCK_DGRAM, 0); if `broadcast`, setsockopt(SO_BROADCAST, 1) with the result
 *  ignored. Returns the fd, or -1 with errno from socket() untouched. Logs nothing. */
int openUdpSocket(bool broadcast);

/** Zero `out`, sin_family = AF_INET, sin_port = htons(port), inet_pton(AF_INET, ip, &sin_addr).
 *  Returns inet_pton(...) == 1. Logs nothing. */
bool ipv4Destination(const std::string& ip, uint16_t port, sockaddr_in& out);
}
```

Callers keep their own failure text, exit code, `SO_SNDTIMEO`, `bindToDaqInterface` call and
`close()` placement. Adoption: heartbeat 232-240 (`openUdpSocket(true)`), 255-263; stacklight 268
(`false`), 274-282; config_broadcast 509 (`false`), and per packet 554-558 (fill a fresh
`sockaddr_in` with `ipv4Destination(ip, listen_port, dest)`; on false count `tx_bad_addr` and
`continue`, as today); AbortBroadcaster 80-87 (`true`). Not in WP8: ControllerService,
ActuatorCommander (its `bind` to `0.0.0.0` is not `bindToDaqInterface`'s no-op and its
error text differs; it keeps its own bind), BackendLogForwarder — WP10 may adopt `openUdpSocket`
and `ipv4Destination` where the statement sequence is identical.

### 2.3 `lib/include/net/TcpCommandServer.hpp` + `lib/src/net/TcpCommandServer.cpp`

```cpp
namespace fsw::net {
struct TcpListener {
    enum class Failed { kNone, kSocket, kBind, kListen };
    int fd = -1;          // open unless failed is kSocket or kBind (closed by the callee)
    Failed failed = Failed::kNone;
    int err = 0;          // errno of the failing call
};
/** socket(SOCK_STREAM) → SO_REUSEADDR=1 (result ignored) → bind(INADDR_ANY:port) → listen(backlog).
 *  On socket or bind failure the fd is closed and returned as -1. On listen failure the fd is
 *  returned OPEN with failed = kListen: the controller ignores that failure today and keeps
 *  serving; the others log, close and exit 1. Logs nothing. */
TcpListener openTcpListener(uint16_t port, int backlog);

struct TcpServeOptions {
    size_t max_clients;            // 64 for both users
    const char* busy_log_prefix;   // "[Sequencer] " | "[ControllerService] ⚠️  "
};
/** The accept loop sequencer_main.cpp:282-349 and controller_main.cpp:151-214 share, statement
 *  for statement: while (running) { reap; select(listen_fd, 10 ms); accept; reap; cap check with
 *  "ERR:too many connections\n" (MSG_NOSIGNAL) and cerr << busy_log_prefix << "client limit (" <<
 *  max_clients << ") reached — refusing connection"; spawn a tracked thread running
 *  on_client(fd) then done = true }. After the loop: shutdown(fd, SHUT_RDWR) every tracked
 *  connection, then join every thread. Does NOT close listen_fd (callers do, after it returns). */
void serveTcpClients(int listen_fd, const std::atomic<bool>& running,
                     const TcpServeOptions& opts, const std::function<void(int)>& on_client);
}
```

The 10 ms select timeout is a constant inside `serveTcpClients` (both users use it); it is not a
parameter because nothing else would pass one (D17d). ota adopts `openTcpListener` only: its
1 s select, uncapped detached threads and process exit with flashes in flight stay in its main
(a detach mode would have one user). The per-client readers stay in each main: three read
disciplines (§1.6) that the goldens freeze.

Adoption: sequencer 252-276 → `openTcpListener(listen_port, 10)`, then on `kSocket`
`[Sequencer] socket() failed`, on `kBind` `[Sequencer] bind() failed on port N`, on `kListen`
`[Sequencer] listen() failed` + `close` — each `return 1`, text as today; 282-349 →
`serveTcpClients(listen_fd, running(), {64, "[Sequencer] "}, [&svc](int fd){ handleClient(fd, svc); })`;
351-353 unchanged. Controller 128-147 → `openTcpListener(port, 4)`; `kSocket` → `❌ Control socket
failed: <strerror(err)>` and return; `kBind` → `❌ Control bind(N) failed: <strerror(err)>` and
return; `kListen` → **fall through** (today's ignored result); 151-214 → `serveTcpClients(...,
{64, "[ControllerService] ⚠️  "}, [svc](int fd){ handleControlClient(fd, svc); })`; 216
unchanged. `strerror(errno)` becomes `strerror(l.err)`: same value, captured at the failing call.

### 2.4 `lib/include/elodin/SequencerStateFollower.hpp` + `lib/src/elodin/SequencerStateFollower.cpp`

```cpp
namespace fsw::elodin {
struct SequencerStateFollowerText {
    const char* subscribe_failed;   // cerr, whole line
    const char* connected;          // cout, whole line
    const char* read_failed_prefix; // cerr: prefix << client.last_error() << ") — reconnecting";
                                    // nullptr = drop the socket silently (stacklight)
};
/** Subscribe to [0x50,0x00] and report current_state (payload byte 8) of every row, until
 *  `running` is false. heartbeat_service_main.cpp:103-152 statement for statement: connect
 *  (2 s sleep on failure) → subscribe_tables({kTableSequencerState}) (failure: log, disconnect,
 *  retry at once) → set_recv_timeout_ms(recv_timeout_ms) → log connected → read_packet into a
 *  4096-byte stack buffer; n < 0 → optional log, disconnect; n < 8 → continue; buf[5]/buf[6] ==
 *  0x50/0x00 and n >= 17 → on_state(buf[16]). */
void followSequencerState(const std::string& host, uint16_t port,
                          const std::atomic<bool>& running, int recv_timeout_ms,
                          const SequencerStateFollowerText& text,
                          const std::function<void(uint8_t)>& on_state);
}
```

heartbeat: `recv_timeout_ms = kElodinRecvTimeoutMs` (3000, stays a named constant in the main —
the lifecycle bounds cite it), text = the three literals at 113-115, 122-123, 135-136,
`on_state = [](uint8_t s){ g_engine_state.store(stateToEngine(s)); }`. stacklight:
`kStacklightRecvTimeoutMs` (500, stays in the main), texts 109-110, 116-117, `nullptr`,
`on_state = [](uint8_t s){ g_seq_state.store(s); }`. The `std::thread` is created where it is
today (heartbeat 271, stacklight 295), joined where it is today (296, 344-345).

### 2.5 `lib/include/config/ConfigFile.hpp` + `lib/src/config/ConfigFile.cpp` (cleanup pass only)

```cpp
namespace fsw::config {
struct ConfigFileChoice { std::string path; bool found; bool fell_back; };
/** If `requested` opens, it. Else the first of `fallbacks` that opens (fell_back = true). Else
 *  `requested` with found = false. Opens each candidate with std::ifstream and closes it. */
ConfigFileChoice findConfigFile(const std::string& requested,
                                std::initializer_list<const char*> fallbacks);
/** Whole file as text; "" if it does not open. */
std::string readFileText(const std::string& path);
}
```

heartbeat 202-213, stacklight 211-228, config_broadcast 468-485 with `{"config/config.toml",
"../config/config.toml"}`; controller 276-301 with the three-path list and its four log lines
emitted by the caller from `found`/`fell_back` in today's order (`❌ Cannot open config` before the
search, `ℹ️  Using fallback config` / `❌ No config.toml found. Using defaults.` after,
`📋 Loaded config` when found). Difference from today: stacklight, config_broadcast and controller
read the chosen file through a second open instead of the stream that probed it. Same bytes; it is
why this is cleanup, not move-only.

## 3. Ownership and data flow

| piece | owns | threads | guarded by |
|---|---|---|---|
| `StopSignals` | the process stop flag, the notice settings | written by the signal handler (any thread the kernel picks), read by every loop | `std::atomic<bool>` (seq_cst, as today); settings written once before `signal()` and never again |
| `openUdpSocket`/`ipv4Destination` | nothing (the caller owns the fd) | caller's | — |
| `openTcpListener` | nothing (caller owns the fd and closes it after `serveTcpClients` returns, as today) | caller's | — |
| `serveTcpClients` | the `Conn` vector (on the calling thread's stack) and the client threads | the calling thread (sequencer: main; controller: the detached control thread) + one per client | `Conn::done` atomic; the vector is touched only by the calling thread, as today |
| `followSequencerState` | its own `ElodinClient` (on its stack) | the thread the main starts | publishes through the caller's `on_state`, which stores into the main's atomic |

No new mutex. No lock is held across any call into shared code. t7_bridge's `g_log_mutex` stays a
leaf in its main. The command-path locks inside `SequencerService` and `ControllerService` are
untouched by WP8 (WP10 §1 documents them, including C4-1).

Lifetimes that must not move: sequencer's client threads are joined before `svc` (a stack object
they reference) is destroyed at the end of `main` (comment at 282-283); the controller's control
thread stays **detached** (500-501) and is never joined, so `main` reaches `service.stop()` and
returns while it may still be in `select`; ota's client threads stay detached.

## 4. Error handling: today, and how it stays

| failure | today | after WP8 |
|---|---|---|
| UDP `socket()` fails (heartbeat, stacklight, config_broadcast) | `[<Tag>] socket() failed`, exit 1 | caller tests `openUdpSocket(...) < 0`, same line, exit 1 |
| AbortBroadcaster `socket()` | `[AbortBroadcaster] socket() failed`, return | same |
| bad broadcast / target IP | `Invalid broadcast IP: …` / `Invalid target IP: …`, `close`, exit 1 | `!ipv4Destination(...)`, same |
| config_broadcast bad packet address | `tx_bad_addr[dest]++`, skip | same |
| NIC resolve not ok | heartbeat/config_broadcast `close(sock)`, exit 1; ota/controller exit 1 | unchanged (not shared) |
| `bindToDaqInterface` fails | heartbeat/config_broadcast: ignored (it logs itself); AbortBroadcaster: extra cerr line, continues | unchanged |
| TCP socket/bind/listen (sequencer, ota) | logged, `close`, exit 1 | `openTcpListener` + same lines, exit 1 |
| TCP socket/bind (controller) | logged with `strerror`, control thread returns, service runs on | same, via `TcpListener::err` |
| TCP listen (controller) | ignored | ignored (`kListen` falls through with an open fd) |
| 65th concurrent client | busy line + log, `close` | inside `serveTcpClients`, same bytes and log |
| oversized sequencer line, controller junk, ota junk | per-service reader (§1.6) | unchanged (readers stay in the mains) |
| Elodin subscribe refused (heartbeat/stacklight) | log, `disconnect`, retry at once | inside `followSequencerState`, same |
| Elodin read error | heartbeat logs, stacklight silent; both disconnect | `read_failed_prefix` set / `nullptr` |
| bad TOML / missing file | `config::load` logs and returns defaults (C2-4); config_broadcast SIGABRT on bad env board id (C2-12) | no shared code catches or checks anything around `config::load` |
| bad CLI value | `atoi` → 0; t7 `exit(2)`; daq_bridge `stoi` throws → abort | unchanged (parsers stay per service) |

Exit codes that must not change: 0 on clean stop and on `--help` everywhere; 1 for the startup
failures above; t7_bridge 2 (bad argv, T7 config errors), 3 (no LJM without `--fake`), 0 (no T7);
config_broadcast −6 (SIGABRT, C2-12); a process killed before its handler is installed: −2/−15;
any service whose SIGPIPE is default and is hit by one: −13.

## 5. Naming

- Namespaces follow the existing tree: `fsw::service` (new, process-level), `fsw::net` (next to
  `DaqInterface`), `fsw::elodin`, `fsw::config`.
- `installStopHandlers`, `running()`: what they do to the process. Not "ServiceMain": there is no
  shared main.
- `TcpCommandServer.hpp` holds `openTcpListener` and `serveTcpClients`; not "LineCommandServer",
  because line reading stays in the three mains.
- `followSequencerState`: the two callers follow one table; not "SubscriberLoop", which promised a
  generality that would have one user per knob.
- `openUdpSocket`, `ipv4Destination`: verbs and nouns of POSIX; not "UdpSender" (it owns nothing).
- Per-service constants keep their names and stay in their mains (`kElodinRecvTimeoutMs`,
  `kStacklightRecvTimeoutMs`, `kMaxClients`, `kMaxLineBytes`, `kMaxControlClients`): the lifecycle
  and sequencer READMEs cite them by name.
- Log tags are not renamed (`[Sequencer]` vs `[SequencerService]`, `[controller_service]` vs
  `[ControllerService]`, `[ConfigBroadcast]` vs the binary name): tests grep them.

## 6. Passes

WP8 is a consolidation, not a split, so its two passes are: (1) **adopt where the shared code is
the replaced code statement for statement**; (2) **cleanup** where adoption changes something
unobservable (an extra `open()`, a moved block). One commit per (helper, service) pair, so a red
golden names its cause. Run the guards in §7 after each commit (under the stack lock, subsets per
D23); format only touched files with the pinned clang-format 19.1.7.

### 6.1 Pass 1 — adoption (behaviour-identical by construction)

1. `lib/src/service/StopSignals.cpp` + header; append to `FSW_SOURCES`. Build.
2. t7_bridge: delete `g_running` (56) and `on_signal` (83-85); replace 343-345 with
   `fsw::service::installStopHandlers(kSilent, nullptr, kIgnore)`; every `g_running` read (96,
   172, 192, 268) → `fsw::service::running()`. Guard: `t7_integration` (CI, D34) + `t7` ctest.
3. heartbeat: delete 37, 43-46; 228-229 → `installStopHandlers(kPrintThenStop, "\n[HeartbeatService] Shutting down...", kDefault)`; reads at 106, 276, 291.
4. stacklight: delete 33, 36-39; 264-265 → its call; reads at 102, 305.
5. config_broadcast: delete 44, 46-49; 498-499 → its call; reads at 545, 600.
6. ota: delete 43, 45-48; 406-408 → its call with `kIgnore`; reads at 311, 439.
7. sequencer: delete 46, 55-58; 241-243 → its call with `kIgnore`; reads at 203, 303.
8. controller: delete 54, 56-59; 490-491 → its call (`…` is U+2026, copy the bytes); reads at
   82, 171, 507.
9. `lib/src/net/UdpSocket.cpp` + header; append to `FSW_SOURCES`.
10. heartbeat 232-240 and 255-263; stacklight 268, 274-282; config_broadcast 509 and 529-531 +
    554-558; AbortBroadcaster 80-87. Keep every log line, `close`, and the position of each
    `setsockopt(SO_SNDTIMEO)` (AbortBroadcaster 98-99, after the bind) as today.
11. `lib/src/net/TcpCommandServer.cpp` + header; append to `FSW_SOURCES`.
12. sequencer 252-276 → `openTcpListener(listen_port, 10)` + the three logs; 282-349 →
    `serveTcpClients`. Move the `Conn` struct and `reap_finished` lambda into the TCU **verbatim**.
13. controller 128-147 → `openTcpListener(port, 4)` with `kListen` ignored; 151-214 →
    `serveTcpClients`; 148-149 ready line stays in `runControlServer` after the listener opens
    (today it prints after `listen()`, whose failure is ignored, so it prints whenever bind
    succeeded — keep that).
14. ota 410-434 → `openTcpListener(listen_port, 5)` + its three logs. 439-454 unchanged.
15. `lib/src/elodin/SequencerStateFollower.cpp` + header; append.
16. heartbeat 103-152 → thin wrapper or direct `std::thread(followSequencerState, …)` at 271 with
    the texts in §2.4; `kElodinRecvTimeoutMs` stays at 41. stacklight 99-136 likewise, at 295.

### 6.2 Pass 2 — cleanup

1. `lib/src/config/ConfigFile.cpp` + header; adopt in heartbeat, stacklight, config_broadcast,
   controller (§2.5).
2. In each WP8 main, move the argv loop into a file-static `parseArgs(int, char**, Options&)`
   returning `std::optional<int>` (exit code for `--help`/errors). Help text and flag order
   byte-identical. Not for daq_bridge or calibration (WP10/WP9). t7_bridge's `next` lambda
   (283-286) moves **verbatim**, `std::exit(2)` included: it is not converted to a returned exit
   code (an `exit` from inside the loop skips destructors and flushes differently from a
   `return` out of `main`).
3. Leave stacklight's `trim`/`getTomlValue` (141-175) **where they are and with external
   linkage**: the config harness calls `getTomlValue` (§7.3).
4. Do not touch the B4 encoders, the per-service constants, the precedence code, or the
   `buf[5]/buf[6]` checks outside the follower.

### 6.3 What must not change (checked by §7; list is the acceptance test)

- **Packet bytes and order:** SERVER_HEARTBEAT from heartbeat_service (`02 00 <system ms LE> <engine>`)
  and daq_bridge (`02 <DIABLO_COMMS_VERSION> <steady ms> 00`); STACKLIGHT_COMMAND; every
  SENSOR_CONFIG/ACTUATOR_CONFIG byte incl. reversed abort IPs (C1-2) and `ipToU32Le` → 0 (C1-8);
  ABORT ×4 repeats per call and the double `triggerAbort` (C1-10); the Elodin subscribe request
  `len=6 ty=0 id=[0x11,0x0d] payload 50 00` from both followers.
- **TCP reply text:** `ERR:too many connections\n`; every sequencer, controller and ota reply in
  §1.6 and in the goldens; controller's `ERR\n` on CRLF (C4-5); `''` on half-close; sequencer's
  close on a 600-byte line.
- **Timing constants:** heartbeat 3000 ms receive, 2 s reconnect, 100 ms slices, `max(100,·)`
  interval, 10 s stats; stacklight 500 ms, 2 s, 100 ms loop; config_broadcast `max(500,·)`,
  100 ms slices; sequencer/controller select 10 ms, `SO_RCVTIMEO` 5 s, caps 64, line 512/64;
  ota select 1 s, `SO_RCVTIMEO` 30 s, connect 5 s, transfer 60 s, 8192; AbortBroadcaster 100 ms
  `SO_SNDTIMEO`, repeats and gap; t7 100 ms nap, 1→10 s back-off, 2 s db gate; backlogs 10/4/5.
- **Exit codes:** §4.
- **Log lines a test reads:** `Listening for DiabloAvionics packets`, `Proactive SENSOR_CONFIG sent
  to N`, `[DAQ Bridge] Shutdown complete`, `[HeartbeatService] Stopped.`, `[Cal] Stopped.`,
  `Saved robust adjustments on shutdown`, calibration's `Elodin|subscrib` readiness match
  (lifecycle); stacklight's three start lines and `--force-state` line, config_broadcast's
  `No config loaded`, daq_bridge's start-up through `[System] Mode` (config `golden/bin/`);
  sequencer load-time verdicts and the `SEQ_FACTS`/`CTL_FACTS` message counts, incl. the
  controller's `control connection closed with no command (timeout or peer went away)`
  (sequencer N6); everything a `#include`d main prints during `dump()` (config `golden/cpp/`).
- **Startup order:** §1.2, including where signals are installed.
- **Warnings baseline:** `config_broadcast_service_main.cpp: warning: unused variable
  'DEFAULT_LISTEN_PORT' [-Wunused-const-variable]` (`baseline_warnings.txt:8`, constant at 53)
  survives both passes: the constant stays, unused, in that file's anonymous namespace. Removing it
  is a baseline change for the orchestrator, not a WP8 cleanup.
- **SIGPIPE per service:** §1.3 / §2.1 table.
- **Shutdown order:** sequencer shutdown→join→close→`Stopped.`; controller `service.stop()` with the
  control thread detached (C4-5 >3 s exit stays); heartbeat `close(sock)` before `join`; ota's
  detached clients not waited for.

## 7. Guarding characterization

### 7.1 Coverage per part

| part | covered by | how |
|---|---|---|
| stop handlers: exit code and latency on SIGTERM/SIGINT | `lifecycle/golden/shutdown.txt` | heartbeat, stacklight, config_broadcast, ota, calibration, daq_bridge: exit 0 within bounds citing `kElodinRecvTimeoutMs`, `kStacklightRecvTimeoutMs`, ota's 1 s select, 100 ms slices; no packets after the signal |
| final log lines | `shutdown.txt` | `[HeartbeatService] Stopped.`, `[DAQ Bridge] Shutdown complete`, `[Cal] Stopped.` |
| UDP setup + bytes | `queue/C1` `packets/golden/service_{heartbeat,stacklight,config_broadcast,abort,daq_bridge}.txt`; `lifecycle/golden/startup.txt` (first packets, periods) | black box |
| TCP servers | `sequencer/golden/*` (every reply, CRLF, two commands per write, oversize close), `sequencer/golden/controller__*.txt` (`OK`, `ERR`, `''`, counts), `lifecycle/golden/ota.txt` (replies), `shutdown.txt` (`command port still accepting: False`) | black box |
| followers | `packets/golden/service_{heartbeat,stacklight}.txt` (subscribe bytes, state→output map), `startup.txt` | black box with a stand-in elodin-db |
| config loading | `config/golden/bin/{daq_bridge,stacklight,config_broadcast}` (start-up lines, `No config loaded` exit 1, `UNCAUGHT` C2-12); `config/golden/cpp/*` (§7.3); sequencer N6 load-time lines | black box + D18 white box |
| AbortBroadcaster | `packets/golden/service_abort.txt`; `sequencer/golden/*__aborts*`, `entry/*Abort*` (N2: ×4 repeats); ctests `abort_ordering`, `sequencer_concurrency`, `script_runtime`, `hold_rules`, `script_states` (all compile `AbortBroadcaster.cpp`) | black box + ctest |
| t7_bridge | ctest `t7_integration` (D31 list; D34: CI only), `t7` | ctest |
| everything | TSan CI job; integration (167 checks) | — |

### 7.2 Gaps (proposed cases; design only, none written here)

Classification (orchestrator): **must close before pass 1** — gaps 1, 2, 3, 5, 6, 7; **before
pass 2 only** — gaps 4 and 8; **nice-to-have** — gap 9.

1. **[before pass 1] SIGPIPE disposition is not covered anywhere.** Nothing in any area delivers SIGPIPE. Case for
   `lifecycle/`: start each of the nine services alone (loopback config), `kill -PIPE <pid>`,
   record `alive after 1 s` or `exit -13`. Expected: daq_bridge, ota, sequencer, t7_bridge alive;
   controller, calibration, heartbeat, config_broadcast, stacklight exit −13. Mutation: flip one
   service's `Sigpipe` value → red. This is the only test that would catch a uniform setting.
2. **[before pass 1] Shutdown of sequencer, controller and t7_bridge** is not in `shutdown.txt`.
   Add SIGTERM and SIGINT exit code and latency bound for each (controller's > 3 s, C4-5, as a
   bound, not a fix). This also closes DESIGN-WP10 gap 2.
3. **[before pass 1] The `Shutting down` line** printed by each handler is read by no test; nor is daq_bridge's
   flag-then-print order. Add, per service, the handler's exact line (bytes, incl. the leading
   newline and controller's U+2026) and its position relative to the service's final line to
   `shutdown.txt`.
4. **[before pass 2] `--help` text and exit code** of all nine binaries, and t7_bridge's exit 2 on an unknown flag
   and on a missing value: a `config/golden/bin/help/` golden (stdout, exit code).
5. **[before pass 1] `ERR:too many connections`**: no session opens 65 connections. Add to
   `sequencer/` for both ports, :9998 and :9999 (hold 64 idle connections, the 65th gets the busy
   bytes; the 64 then close; a 66th gets a normal reply). Bounded by `SO_RCVTIMEO` 5 s. Also
   assert the busy **log line bytes**: `[Sequencer] client limit (64) reached — refusing
   connection` and `[ControllerService] ⚠️  client limit (64) reached — refusing connection` —
   U+26A0 U+FE0F followed by **two** spaces, and the em dash U+2014 in both.
6. **[before pass 1] Every listener failure ladder.** Controller with its control port pre-bound:
   keeps running, logs `[ControllerService] ❌ Control bind(N) failed: <strerror>`, PWM gate
   unreachable by TCP. Sequencer with :9998 pre-bound: `[Sequencer] bind() failed on port N`,
   exit 1. ota with its port pre-bound: `[OTAService] bind() failed on port N`, exit 1. Exact text
   and exit code for each (socket()/listen() failures cannot be provoked black-box; they stay
   uncovered and are named so).
7. **[before pass 1] Follower reconnect and subscribe-refused**: no case restarts elodin-db and checks that heartbeat/stacklight
   re-subscribe (only "still sending" after the db dies). Add to `packets/` with the stand-in db:
   drop the connection, expect a second identical subscribe request and resumed state tracking.
   Also the subscribe-refused path (stand-in replies with an error).
8. **[before pass 2] Config path fallback** (heartbeat, stacklight, config_broadcast, controller) has no case
   where `--config` names a missing file and a fallback exists. Add to `config/golden/bin/`.
9. **[nice-to-have] ota concurrency**: a second client during a flash, and SIGTERM during a flash (detached
   threads: process exits without finishing). Add to `lifecycle/ota`.

### 7.3 White-box harness hooks

`test/characterization/config/char_config_services.cpp:20-30` `#define main
char_service_main_unused` and `#include`s `stacklight_service_main.cpp`, `daq_bridge_main.cpp`,
`config_broadcast_service_main.cpp` (one executable each, `config/CMakeLists.txt:33-41`, linking
`fsw_daq_lib` with `lib/include` on the path). It calls: stacklight `getTomlValue` (global,
external linkage, 147-175); daq_bridge `BoardType`, `BoardConfig`, `BoardByOctet`,
`ServerHeartbeatConfig`, `load_board_map_from_config`, `ipv4_host_octet`,
`resolve_board_config_by_source_ip`, `config_board_type_to_wire_u8` (WP10's file); config_broadcast
`parseVentAbortFromCsv`, `buildPackets` (anonymous namespace, 89-130, 185-448). Its golden is the
dump followed by **everything the process printed during `dump()`**.

WP8 needs **no harness edit** if it keeps these rules, which make the three `golden/cpp/` dirs
byte-identical by construction:

- Do not move, rename or change the linkage of any symbol above. (WP8 only touches stacklight's
  and config_broadcast's `main`, flag, handler and socket lines.)
- Every header a WP8 main newly includes lives under `lib/include` and its source is in
  `fsw_daq_lib`; nothing new is needed on `_CFG_INCLUDES` or the link line.
- No identifier spelled `main` in any new header (the harness's macro would rename it).
- No static object in a new TU prints or reads a file at load time (static init runs outside the
  harness's capture and would add lines before the golden's body).
- `followSequencerState` and the signal TU are linked but never called by the harness; they must
  not register anything at load.

If a WP8 change nevertheless needs the harness touched, D18 applies: edit only those two harness
files, goldens byte-identical, re-run the area's mutations (`config/README.md`), orchestrator
reviews the diff. `char_ac_private.cpp` (`#define private public` around `ActuatorCommander.hpp`)
is not affected by WP8; it is WP10's.

Keeping the goldens identical: run `bash test/characterization/config/check.sh cpp <bin dirs>`
(ctest `characterization_config_cpp`, no lock) after every commit that touches stacklight or
config_broadcast, and `config/run.sh` (bin half, under the lock) once per such commit.

## 8. Risks

- **Concurrency.** No new lock. `serveTcpClients` must keep the reap-before-and-after-accept
  sequence and the shutdown-all-then-join-all order; joining before shutting down waits out each
  client's 5 s `SO_RCVTIMEO`. The controller's control thread stays detached; joining it would
  change the controller's exit timing (C4-5). The sequencer's join-before-`svc`-destruction must
  stay, and so must its inability to exit while the worker is deadlocked (**C4-1**: a SIGTERM
  after a refused dynamic state does not exit; WP8 adds no timeout and no detach that would
  "fix" it). WP8 does not touch the code behind **C4-2** (double timeout) or **C4-3** (abort does
  not cancel a pending stage); the AbortBroadcaster change is confined to socket creation, so the
  ABORT/ABORT_DONE timing that C4-3's goldens freeze does not move.
- **Signal handlers.** Moving the handler into a shared library TU changes nothing about its
  async-signal-safety (still unsafe, as today) but does put a `switch` in it; the per-notice
  bodies must be copied, not "simplified" (daq_bridge's order differs). Using `sigaction` is a
  behaviour change (EINTR) unless `SA_RESTART` is set; use `::signal`.
- **One flag per process.** Today each main's flag is file-local; after WP8 there is one in
  `fsw_daq_lib`. A test binary that links `fsw_daq_lib` and starts two services in one process
  would now share a flag; none does (checked: no `extern` or `g_running` reference outside the
  mains, `grep` over `lib/`, `transport/`, `test/characterization/`).
- **SIGPIPE.** A uniform `kIgnore` would keep five services alive on a broken Elodin socket and
  make their `write` failures (not characterized) the behaviour. The table in §2.1 is the
  contract; gap 7.2-1 is the only test that would catch a flip.
- **Exit codes via static init.** A shared-library constructor that throws or prints would change
  exit codes and the config harness's output. None allowed.
- **Timing tests (D31, D34).** WP8 changes `AbortBroadcaster.cpp`, which is compiled into
  `test_script_runtime`, `test_sequencer_concurrency`, `test_abort_ordering`, `test_hold_rules`,
  `test_script_states`, `test_sequencer_elodin` (`lib/CMakeLists.txt` 254-342, 406-416). On this
  Mac the 10 ms sleep overshoots (~3.5 ms per sleep, D34), so `actuator_delays`,
  `script_positions` and `script_runtime` are **judged on CI only**; a CI run is required. If
  `script_runtime` or `sequencer_concurrency` needs a retry on the WP8 tip, D31's rule applies:
  run it 10× alone and compare the pass rate with the pre-WP8 tip measured the same way. The
  sequencer characterization's republish bounds (`[0.8, 1.5]×` of the 1 s loop, C4L) are judged
  on the Linux leg and CI, not on this Mac.
- **The lifecycle shutdown bounds** are derived from the constants WP8 must keep in the mains
  (`kElodinRecvTimeoutMs` 3000 → heartbeat's `[0, 3.6] s`); moving a constant into shared code
  under a different name is not a behaviour change but breaks the citation. Keep names.
- **Stand.** Nothing in this package is run against `config/config.toml` or `192.168.2.x`; every
  check above is the hermetic stack under `with_stack_lock.sh`.

## Open questions

1. SIGPIPE: the team's decision (LEDGER Parked). Until then §2.1's column is frozen.
2. (Decided: gaps 1, 2, 3, 5, 6, 7 close before pass 1; 4 and 8 before pass 2; 9 optional.)
3. daq_bridge's `std::stoi(argv[3])` abort on junk and t7_bridge's usage-on-unknown-flag are
   untested and stay per service; confirm nobody wants them in a shared parser later.

---

# Amendments (design/cpp2, 2026-11-16) — alternatives, interfaces, walkthroughs

Added after the review (D39), with the research of D42 (`docs/remaster/research/cpp-service-plumbing.md`,
`teststand-architecture.md`, `abort-statemachines.md`) and STYLE.md (D43, cited `STYLE-S<n>`).
Nothing above is deleted. Where this section changes the reviewed text it says **AMENDMENT**.

## A. Alternatives considered

Three genuinely different designs were scored; a fourth family (event-loop frameworks) is listed
because the debate will raise it, but it is outside the remaster by construction.

| | **A. Free functions + per-service settings (§0–§2, chosen)** | B. Small RAII types | C. Status quo + shared signal plumbing only |
|---|---|---|---|
| shape | `installStopHandlers`/`running()`; `openUdpSocket`, `ipv4Destination`; `openTcpListener` returning `TcpListener{fd, failed, err}`; `serveTcpClients`; `follow_sequencer_state`; cleanup `find_config_file`/`read_file_text` | `UniqueFd` (move-only owner, Android `unique_fd` model, research §5); `UdpSocket` owning an fd + destination; `TcpCommandServer` object owning listener, `Conn`s and the accept thread; `SequencerStateFollower` object owning its thread | one `StopSignals` TU (§2.1); every socket, accept loop and follower stays in its main |
| clarity | each main still reads top to bottom in today's order; the shared code is "what POSIX does", named | the strongest single-site clarity (ownership in the type), but the order of `close()`, `join()` and `shutdown()` moves into destructors a reader must know | clearest diff; nine mains keep ~250 lines of near-identical socket and loop code |
| lines deleted (est.) | ~330: 9 handlers + flags (~55), 4 socket blocks (~40), 2 accept loops (~120), 2 followers (~90), 4 config fallbacks (cleanup, ~40), minus ~200 shared | similar to A plus ~20 `close()` calls, minus ~60 more in class boilerplate | ~55 (handlers + flags) |
| testability | unchanged black-box (§7); the shared pieces have no new seam a golden needs | an object could be unit-tested, but D20 keeps goldens black-box, so nothing gains | unchanged |
| fit with characterization | no harness edit (§7.3 rules); every golden reached as today | `char_config_services.cpp` `#include`s stacklight/config_broadcast/daq_bridge mains and captures **everything printed** during `dump()`: an RAII member whose destructor runs at a different point, or a type with a static, moves output; heartbeat's `close(sock)` **before** `elodin_thread.join()` (`heartbeat_service_main.cpp:295-296`) must become an explicit `reset()`, i.e. RAII in name only (research §5 table) | no harness edit |
| EINTR / signal semantics (D42 binding 2) | `::signal` = `sigaction` with `SA_RESTART` (research §0.1); every `select`/`usleep`/`SO_SNDTIMEO` EINTR site (research §0.2 table) unchanged | unchanged if it keeps `::signal`; but a `jthread`-based follower/server (research §3) turns the detached controller/ota threads into joined ones on destruction, the "trap for the debate" | unchanged |
| thread/lock risk | no new mutex (§3); `serveTcpClients` keeps reap-before-and-after-accept, shutdown-all-then-join-all | `TcpCommandServer`'s destructor would join; the controller's control thread is **detached** today (`controller_main.cpp:500-501`, C4-5 >3 s exit) and ota's clients are detached — an owning object changes exit timing unless it, too, detaches (then it owns nothing) | none |
| float path (D22) | none | none | none |

**Out of bounds — event loop / signal-as-event** (asio `signal_set`, libuv, sd-event; self-pipe,
`sigwait` thread, `signalfd`; research §2, §5): each replaces the handler's printing, the EINTR
model and the wake latency of every loop. Self-pipe is the research's recommended **PROPOSAL** for
the team; sd-event and `signalfd` do not run on the macOS dev loop. None is a remaster design (D42
binding 2: the chosen design preserves EINTR behaviour).

**Why B lost.** RAII is identical only where `close()` is already at scope end: AbortBroadcaster's
and ActuatorCommander's per-send sockets (research §5). Those are two users of a one-line saving.
Everywhere else the explicit close position is observable (heartbeat's close-before-join; the
listener that `lifecycle/stack.py:358-362` must see released; the controller's listener leaked on
`kListen`) or the lifetime is detached by design (STYLE-S21, S22). A type that must be bypassed at
its first three users is not the abstraction (STYLE-S34).

**Why C lost.** It is the zero-risk floor, and the right fallback if any pass-1 gap (§7.2) cannot
be closed. But the two accept loops are statement-for-statement copies (the controller's comment
says "mirrors sequencer_main.cpp's accept loop") and the two followers differ only in three
literals and a timeout; leaving them doubles every future fix to the cap/busy reply or the
subscribe retry. A keeps exactly the shared code whose users agree observably (STYLE-S34, D43(3)).

**Decision: A, as reviewed.** No divergence in structure. Amendments to names and comments only:

- **AMENDMENT (D43(2), STYLE-S1):** `followSequencerState` → `follow_sequencer_state`
  (`lib/include/elodin` is snake_case), `findConfigFile` → `find_config_file`, `readFileText` →
  `read_file_text` (`lib/include/config`). `SequencerStateFollowerText` stays (a type, STYLE-S3).
  The `fsw::net` names and the new `fsw::service` names keep camelCase (`lib/include/net` is
  camelCase; `fsw::service` is new and picks camelCase with `installStopHandlers`).
- **AMENDMENT (D43(4), STYLE-S12):** cleanup pass 2 makes the controller's `kListen` fall-through
  an explicit branch `// Kept: D-CTL (D17)` and marks heartbeat's and config_broadcast's ignored
  `bindToDaqInterface` result `// Kept: D-BIND (D17)`. Pass 1 adds no such line.
- **AMENDMENT (D42 binding 1):** `serveTcpClients`'s `on_client` reaches a service only through
  its public, enqueueing API (`SequencerService::transitionTo`, `setDebugMode`, `manualActuator`,
  `extendFire`, `scriptStatusReport`; `ControllerService::setFireActive`), never a `do*` body. Today
  `handleClient` → `handleCommandLine` already does exactly this; the stub says it so a later
  "simplification" cannot bypass `enqueueAndWait` (research abort-statemachines, structural
  choice 3).
- **AMENDMENT (research §0.2):** §6.3's "must not change" gains the EINTR exposure of the
  `SO_SNDTIMEO` sends: AbortBroadcaster's `sendto` can fail a repeat with EINTR when the signal
  lands on the sending thread. WP8 changes only the socket-creation lines of `sendPacket`, so the
  `setsockopt(SO_SNDTIMEO)` stays after the bind and the repeat loop is untouched.

New defect candidates found while writing this section (report, never fix; for LEDGER Defects):

- **D-FD (candidate)** `sequencer_main.cpp:345-349` (and the controller's copy at 210-214):
  after the accept loop, `shutdown(c->fd, SHUT_RDWR)` runs on every tracked connection, including
  ones whose `handleClient` already `close()`d its fd (`:222`) but were not yet reaped. That fd
  number may have been reused, so shutdown can cut an unrelated socket during the last
  milliseconds of a stop. A reused fd that is an unconnected UDP socket just gets `ENOTCONN`; the
  realistic victim is a connected TCP socket opened meanwhile on another thread (the Elodin client
  of the sequencer's retry thread, or a controller notify in flight). `serveTcpClients`
  keeps the statement sequence, and with it this race.
- From research §0.2-§0.4, already in D42: EINTR can drop an ABORT repeat; handlers do not save
  `errno`; ota allocates between `fork` and `exec`.

## B. Interfaces

Declaration-only stubs, STYLE-S36 doc comments (owns / threads and locks / must not know /
contract surfaces and their goldens), in `docs/remaster/design-stubs/cpp/` — not under
`diablo_server/`, in no CMake target:

| stub | target path | §, pass |
|---|---|---|
| `lib/include/service/StopSignals.hpp` | `diablo_server/lib/include/service/StopSignals.hpp` | §2.1, pass 1 |
| `lib/include/net/UdpSocket.hpp` | `diablo_server/lib/include/net/UdpSocket.hpp` | §2.2, pass 1 |
| `lib/include/net/TcpCommandServer.hpp` | `diablo_server/lib/include/net/TcpCommandServer.hpp` | §2.3, pass 1 |
| `lib/include/elodin/SequencerStateFollower.hpp` | `diablo_server/lib/include/elodin/SequencerStateFollower.hpp` | §2.4, pass 1 (name amended) |
| `lib/include/config/ConfigFile.hpp` | `diablo_server/lib/include/config/ConfigFile.hpp` | §2.5, pass 2 (names amended) |

Signatures are §2's, with the amended names. Each stub restates the rules of §7.3 that keep the
config harness byte-identical: no identifier `main`, nothing at static initialisation (STYLE-S26).

## C. Walkthroughs (the WP8-owned steps)

The full traces are in DESIGN-WP10 "Walkthroughs" (fire, abort, daq_bridge reconnect) and
DESIGN-WP9 "Walkthroughs" (calibration save). These are the steps that run through WP8 code, with
the one owner of each. "Owner" = the module whose code performs the step and whose state or output
it produces; a caller that only triggers it is named as the trigger.

**C.1 A command arrives on :9998 (every fire/abort starts here).**

| # | step | owner (file after WP8) | thread | notes |
|---|---|---|---|---|
| 1 | listener exists, `SO_REUSEADDR`, backlog 10 | `openTcpListener` (`net/TcpCommandServer.cpp`); fd owned by `sequencer_main` | main | failure ladder text and `exit 1` stay in `sequencer_main` (§2.3) |
| 2 | `select` 10 ms, `accept`, reap, cap 64, busy reply | `serveTcpClients` | main | |
| 3 | per-client thread created and tracked | `serveTcpClients` (owns the `Conn` vector) | main → conn | |
| 4 | read lines (`SO_RCVTIMEO` 5 s, 512-byte chunks, oversize close) | `handleClient` in `sequencer_main.cpp` (stays: one of three read disciplines, §1.6) | conn | `on_client` |
| 5 | parse verb, call the public API | `handleCommandLine` in `sequencer_main.cpp` | conn | AMENDMENT: only public enqueueing methods (§A) |
| 6 | queue the command, wait ≤ 10 s | `SequencerService::enqueueAndWait` (WP10 core TU) | conn waits; worker runs | the single entry point (D42 binding 1) |
| 7 | reply `OK…`/`ERR:<reason>` with `MSG_NOSIGNAL`, close | `handleCommandLine` / `handleClient` | conn | |

**C.2 FIRE_START/FIRE_STOP arrives on the controller's port.** Steps 1-3 as C.1 with backlog 4,
`serveTcpClients` on the **detached** control thread; step 4 is `handleControlClient`
(`controller_main.cpp`, first line only, 64 bytes); step 5 calls `ControllerService::setFireActive`
directly — that *is* the controller's public API (it has no queue); the reply is `OK\n`/`ERR…`.
A failed bind leaves the controller running without its port (D-CTL, `// Kept:` in pass 2).

**C.3 Heartbeat/stacklight follow the sequencer state.** Owner of the subscription and of reading
`current_state` (payload byte 8): `follow_sequencer_state` on the thread the main creates (heartbeat
271, stacklight 295). Owner of what the state *means*: the main's `on_state` (heartbeat maps it to
an engine state for SERVER_HEARTBEAT; stacklight stores it for its light pattern). Owner of sending
SERVER_HEARTBEAT / STACKLIGHT_COMMAND: the main's loop on the main thread, through
`openUdpSocket`/`ipv4Destination`-made sockets it owns and closes.

**C.4 SIGTERM to the sequencer during a fire.** Owner of the flag: `StopSignals` (handler prints
`\n[Sequencer] Shutting down...`, then clears `running()`). Owner of noticing it: `serveTcpClients`
(its `select` returns, EINTR or timeout, within 10 ms). Owner of tearing the connections down:
`serveTcpClients` (shutdown all, join all — D-FD candidate above). Owner of closing the listener and
printing `[Sequencer] Stopped.`: `sequencer_main`. Owner of stopping the worker, the hold timer
(which sends FIRE_STOP through `notifyControllerFire` if the hold was active) and the republish
loop: `SequencerService`'s destructor at the end of `main` (WP10, unchanged order: worker, Elodin
retry, continuous loop, hold timer). If C4-1 has wedged the worker, the join never returns and the
process does not exit (frozen; systemd's stop timeout ends it).

No WP8 step has two owners. One step has a frozen double trigger (none in WP8's own code): the
controller's fire gate, see DESIGN-WP10 walkthrough (a).
