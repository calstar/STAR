# DESIGN-WP10 — split the sequencer, actuator, controller and bridge god files

The "as decided" execution note for WP10 (D17(a)): what an implementer does, in what order, and
why. Decisions: D39 (review), D45, D47 (debate), D49 (simplicity review round 1). How it got here
— the reviewed text, its amendments, the alternatives (B collaborator objects, C minimal), the
walkthroughs C(a)-(c), the collaborator tiers and the closed questions — is preserved verbatim in
[`debates/WP10/history.md`](debates/WP10/history.md). The collaborator tier table and admission
rule for later fix packages are LEDGER **D47** (WP10 introduces no collaborator object).

**Baseline.** Every line number below is from `git show backend-remastered:daq-server/<path>` at
`backend-remastered` @ **`fbc4ad70`**, whose `diablo_server/` is byte-identical to `main` @
`15b5a0c5`. If WP3/WP8/WP9 land first (the DAG says they do), re-anchor with
`grep -n '^[A-Za-z].*<Class>::\|^static\|^// ─\|^// ═' <file>`: the function names, not the
numbers, are the contract.

| file | lines | unit |
|---|---|---|
| `diablo_server/services/sequencer/SequencerService.cpp` | 1295 | `sequencer::SequencerService` (`lib/include/control/SequencerService.hpp`, 342) |
| `diablo_server/services/sequencer/ActuatorCommander.cpp` | 829 | `sequencer::ActuatorCommander` (`lib/include/control/ActuatorCommander.hpp`, 237) |
| `diablo_server/lib/src/control/ControllerService.cpp` | 1160 | `fsw::control::ControllerService` (`lib/include/control/ControllerService.hpp`, 244) |
| `diablo_server/daq_bridge/daq_bridge_main.cpp` | 1074 | daq_bridge's `main` and its file-scope helpers |

**Prerequisites:** WP8 and WP9 merged (DAG); DESIGN-WP8 gap 2 (sequencer/controller/t7
SIGTERM/SIGINT exit code and latency) merged. C1 (`packets/`, `elodin/`) is already on the tip.

**Ownership:** WP10 owns `diablo_server/CMakeLists.txt` (D39). D18 is extended for WP10 to
`test/characterization/config/CMakeLists.txt`, for exactly two edits (§7.2, §7.3), landing in
commit 1 with the code they follow.

**Rules applied:** D5, D12(e), D17, D18/D20, D22, D25, D31/D34; STYLE-S1, S7, S12, S15, S27,
S33, S34, S38; the Parked SIGPIPE entry; the C1-10 / C4-x defects stay as they are (§1.3).

**Abstraction (STYLE-S34, D17(d)).** No new class, interface, template, callback type or knob.
Moving member functions to another TU of the same class is not an abstraction. Extracting a block
of daq_bridge's `main` into a named free function with one call site is allowed only where §4.3
lists it, in cleanup.

**The cut rule (D47).** A TU is cut where (i) it runs in a different phase or thread set
(`SequencerService_config`, `SequencerService_controller_notify`, `ActuatorCommander_load`), or
(ii) it is a wire format or transport a different reader reviews (`SequencerService_elodin`,
`ControllerService_pwm`, `ControllerService_elodin`). The abort path is never cut (D42 binding 1):
both `triggerAbort` sites, the 716-730 block and the 835 call stay in `doTransitionTo` in core
`SequencerService.cpp`; `schedule_gen_`, `pending_roles_`, `applyForState`, `emit`, the stage
thread **and the send path it calls (`sendBatch`, `sendUDP`)** stay in core
`ActuatorCommander.cpp` (D49: no `ActuatorCommander_udp.cpp`).

---

## 0. Boundary with WP8 (lands first)

WP8 owns process plumbing in the mains (stop flag, `installStopHandlers` with the per-service
SIGPIPE setting, `serveTcpClients`; listener and UDP socket setup stays in each main — DESIGN-WP8
§0, debate verdict D54; the heartbeat/stacklight followers stay in their mains too, D57). It
rejects a generic `SubscriberLoop`, a shared argv parser and every UDP helper, so every
Elodin loop below stays its owner's code. WP10 does not touch `sequencer_main.cpp` or
`controller_main.cpp`.

| site in WP10's files | WP10 action |
|---|---|
| `ActuatorCommander.cpp:343-371` socket per batch, `SO_SNDTIMEO` 100 ms, `bind(bind_addr_)` | stays in core (`sendBatch`), socket creation included (WP8 shares no UDP helper); the explicit `bind()` and its `[ActuatorCommander] bind(<addr>) failed` log stay. |
| `ControllerService.cpp:92-98` (one socket, `bindToDaqInterface`), sends 434-439, 498-506 | `initialize` stays in core, socket creation included (WP8 shares no UDP helper); the sends go to `_pwm`. |
| `daq_bridge_main.cpp:49-90` `BackendLogForwarder` | moves as-is to `daq_bridge/BackendLogForwarder.hpp`. |
| `SequencerService.cpp:1023-1114` TCP client; `:1253-1293` Elodin retry; `ControllerService.cpp:754-915` subscriber | move as-is to `_controller_notify` / the `_elodin` TUs; no WP8 helper applies. |
| `daq_bridge_main.cpp:574-606` and `:745-776` publisher connect + 5 s reconnect | **stay in `main`, two separate sites** (§4.2). |
| `daq_bridge_main.cpp:106-111, 341-344` signals | cleanup applies DESIGN-WP8 §2.1: `installStopHandlers(kStopThenPrint, "\n[DAQ Bridge] Shutting down...", Sigpipe::kIgnore)` at 341-344, `running` (106) → `fsw::service::running()`. |

SIGPIPE: `sequencer_service` and `daq_bridge` ignore it, `controller_service` dies on it. The
sequencer's `send()` at `SequencerService.cpp:1075` has no `MSG_NOSIGNAL`, nor has
`ElodinClient::write_all`; both depend on the process disposition, which WP10 does not touch.

---

## 1. SequencerService

### 1.1 Responsibilities (`SequencerService.cpp`)

| lines | what |
|---|---|
| 1-25 | includes, `namespace sequencer {` |
| 27-53 | file-statics: `VTABLE_*` ids (27-33), `kControllerConnectTimeoutMs` (35-39), `SequencerStateMsg` (17 bytes) and `StateTransitionMsg` (41-47), `now_ns()` (49-53) |
| 55-137 | destructor (stop worker, join, `stopElodinRetry`, `stopContinuousLoop`, `hold_timer_.stop()`); command queue `commandLoop`, `enqueueAndWait` (10 s), `enqueueDetached` |
| 139-567 | `readFile`, `loadConfig`, `configDir`, `resolveDataPath`, `applyConfig` (states, CSVs, NIC, abort, `[fire]` 264, holds 326, `[flow]` 373, scripts + `pressure_feed_.start` 483-549, controller endpoint 556-566) |
| 569-993 | `init`, `isAbortState`, `transitionTo` x4, `doTransitionTo` (666-938), debug/manual/extend and their `do*` bodies |
| 995-1114 | "Elodin publishing" banner (995-997), `notifyControllerFire` (one retry), `notifyControllerFireOnce` |
| 1116-1293 | `publishState` (1116-1168), `makeScriptEnv` + `scriptStatusReport` (1170-1243), `publishStateTransition`, `tryConnectElodin`, `start/stopElodinRetry` (1245-1293) |

`init` order (frozen by sequencer N6 load-time lines, `elodin/golden/schema_*.txt` section
`sequencer`, every `sequencer/golden/*__entry__*` first datagram): `loadConfig` →
`load_from_string` → `applyConfig` → `load_active_boards` snapshot (580-588) → `tryConnectElodin`
→ `startElodinRetry` → boot state → `publishState` → `applyForState(boot, true)` →
`startContinuousLoop` → worker thread (616) → "Initialized". All of it stays in core.

### 1.2 Threads and locks (unchanged by the split)

The `cmd_thread_` worker runs every `do*` body; connection threads block in `enqueueAndWait`
(<= 10 s); the hold-timer and script threads re-enter only through `enqueueDetached` (879, 1187);
the hold-timer thread also runs `notifyControllerFire`. `config_mutex_` (`SequencerService.hpp:255`,
non-recursive) is taken at 546, 552, 673, 717, 740, 904, 925, 1130 (`publishState`), 1217. Lock
order (must not change): `config_mutex_` → `ScriptRunner::mtx_` (924-929) and →
`PressureFeed::mtx_` (1217-1240). After the split `doTransitionTo` (core) calls `publishState`
(`_elodin`) at 705, 727, 759, 776, 933, and `doSetDebugMode` at 952: same call, same member mutex,
now across TUs.

### 1.3 Defects that stay exactly as they are

- **C4-1.** `doTransitionTo` 716-730 locks `config_mutex_` (717) and, for a refused state, calls
  `publishState()` (727) inside that scope; `publishState` locks it again at 1130 unless Elodin is
  down (1117-1118). The worker wedges; every later command times out after 10 s; SIGTERM does not
  exit. Frozen by `sequencer/golden/digital-twin__scripts-load.txt`. Forbidden: a
  `recursive_mutex`, moving the call out of the scope, an unlocked `publishState` variant,
  reordering 716-730.
- **C4-2.** A dynamic state's timeout is both a hold rule (`applyConfig` 514-520) and
  `ScriptRunner`'s deadline; both post the timeout transition. Keep both.
- **C4-3.** 835 calls `applyForState(to, !isAbortState(to))`; an abort does not bump
  `schedule_gen_` (`ActuatorCommander.cpp:462`), so a pending stage of the left state lands after
  the abort batch. Frozen by `default__aborts`.
- **C1-10.** `triggerAbort` at 794-795 and again at 915-917: 8 ABORTs, then 4 ABORT_DONEs. Frozen
  by `packets/golden/service_abort.txt` and sequencer N3a.
- **C4-4.** With `sequencer_owns_valves` the hold has no notifier (862) and
  `ActuatorCommander.cpp:434` still skips `is_pwm` roles in Fire. Frozen by
  `default__fire-sequencer-owns-valves`.
- **C4-6.** `RELOAD_CONFIG` → `ERR:unknown command` (`sequencer_main.cpp:177`, WP8's file).

### 1.4 Target TUs

`SequencerService.hpp` is not edited (member order, construction and destruction order unchanged).

| TU | source lines | size after move-only (§6.3) |
|---|---|---|
| `SequencerService.cpp` (core) | 1-25, 55-137, 569-993, 1170-1243, 1295 | 608 |
| `SequencerService_config.cpp` | 139-567 | 455 |
| `SequencerService_controller_notify.cpp` | 35-39, 995-1114 | 151 |
| `SequencerService_elodin.cpp` | 27-33, 41-53, 1116-1168, 1245-1293 | 148 |

File-statics have exactly one using TU, so no internal header: `now_ns` (users 1164, 1249),
`VTABLE_*`, the two message aliases → `_elodin`; `kControllerConnectTimeoutMs` →
`_controller_notify`; `readFile`, `resolveDataPath` → `_config`. **Move, never copy** (STYLE-S27):
a left-behind `static` is a `-Wunused-*` warning, which the D4 baseline turns red. The banner at
995-997 says "Elodin publishing" but heads `notifyControllerFire`; it moves with it (STYLE-S38)
and cleanup re-homes it above `publishState`.

---

## 2. ActuatorCommander

Today: 1-26 includes, namespace; 28-41 `ActuatorCommandedMsg`, `static actuator_elodin_low_byte`
(36-41; slot `board_id % 10`, 0 → 10); 43-55 "Helpers" banner, `static trimVal` (46-50), `static
toLower` (52-55); 57-257 "load()" banner, `setDefaultBindAddress`, `load`; 259-274
`findStateActuators`; 276-390 `sendUDP`, `sendBatch` (socket per batch, `SO_SNDTIMEO` 100 ms at
354, 3 rounds, `usleep(1000)` at 386); 392-611 `applyForState` (generation bump 462, `emit` 504,
detached stage thread 592); 613-829 republish loop (100 x 10 ms, 656), overrides, script
positions, `publishCommandedState`, `publishInitialState`.

`overrides_mutex_`, `script_positions_mutex_`, `pending_roles_mutex_` are never held together
(header 202-206). The `elodin_` pointer is written by `setElodinClient` while loop/stage threads
read it: an existing unsynchronised write, reported, not fixed.

| TU | source lines | size after move-only (§6.3) |
|---|---|---|
| `ActuatorCommander.cpp` (core) | 1-45, 52-55, 259-829 | 620 |
| `ActuatorCommander_load.cpp` | 46-50 (`trimVal`), 57-257 | 233 |

`ActuatorCommander.hpp` is not edited (`char_ac_private.cpp` reads its privates, §7.2). `trimVal`
is used only by `load`; `toLower` only by core (268, 692, 726); `actuator_elodin_low_byte` only by
core. Also unchanged: one socket per batch, iteration by board IP string, 1 ms stage poll,
precedence manual > script > CSV (§6.4 lists the frozen surfaces).

---

## 3. ControllerService

Today: 1-12 file comment; 13-39 includes (incl. `db.hpp`), `using namespace vtable;
using namespace vtable::builder;` (35-36), namespaces; 41-62 PWM wire format and constants (type
10, version 0, 20/33 bytes); 64-381 lifecycle, setters, `setFireActive` (250), getters; 383-530
PWM senders (`sendActuationPWM` 509); 532-752 `controllerLoop`; 754-915 subscriber; 917-1107
`static send_msg<T>` (921-927), `registerControllerTables`, `write*ToDB`; 1109-1160 thrust curve.

| TU | source lines | size after move-only (§6.3) |
|---|---|---|
| `ControllerService.cpp` (core) | 1-39, 64-381, 532-752, 1109-1160 | 630 |
| `ControllerService_pwm.cpp` | 13-39 (include block), 41-62, 383-530, 1159-1160 | 199 |
| `ControllerService_elodin.cpp` | 13-39 (include block), 754-1107 (incl. `send_msg`), 1159-1160 | 383 |

All three go into `fsw_daq_lib` (`lib/CMakeLists.txt` `FSW_SOURCES`). The header is unchanged in
move-only; cleanup's dead-code commit is WP10's one header edit (§6.2). `interpolateThrustCurve`
and every double-precision control step stay in core with their callers (`setFireActive`,
`controllerLoop`), so inlining and FMA contraction see the same code (D22); `sendActuationPWM` is
clamp-and-cast, nothing fusable. The two `using namespace` lines (35-36) are copied, with the rest
of 13-39, into core, `_elodin` and `_pwm` in move-only (name lookup unchanged); cleanup removes
them from every TU that does not need them (core and `_pwm`; only `registerControllerTables`,
929-1051, in `_elodin`, uses `vtable`/`vtable::builder` names). If WP3 has replaced `send_msg`
with `elodin/SendMsg.hpp`, the include moves instead of the template.

Threads entering the new TUs: `controller_thread_` → `sendActuationPWM` (700) and `write*ToDB`
(728-731); connection threads → `setFireActive` → `sendActuationPWM` (329 open, 341 close);
`elodin_subscriber_thread_` → the subscriber loop and, via parity, `setFireActive`. `_pwm` is
lock-free (`setFireActive` releases `input_mutex_` before sending). Kept races, reported only:
`fire_start_time_` (written on a TCP/subscriber thread, read by the loop); `udp_socket_fd_` sent
from two threads. C4-5's straggler PWM (the loop reads `fire_active_` at 699) stays.

---

## 4. daq_bridge_main.cpp

### 4.1 Responsibilities

1-28 includes; 30-47 and 91 anonymous namespace with the SERVER_HEARTBEAT builder; 49-90
`class BackendLogForwarder` (all inline, inside that namespace); 92-104 more includes; 106-111
`running`, `signal_handler`; 113-137 `BoardType`, `BoardConfig`, `ServerHeartbeatConfig`,
`BoardByOctet`; 139-305 the five `static` board-map functions (`load_board_map_from_config`
151-232, `resolve_board_config_by_source_ip` 282-305); 307-1074 `main` (signals 341-344, routing
print 383-418, log forwarder 486-490, proactive SENSOR_CONFIG 502-527, Elodin connect and
registration 574-606, loop 608-1067 with SERVER_HEARTBEAT 629, reconnect 749-776, self-test
publish 816-883, raw batch 885-989 (extracted: 890-989, §4.3)). One thread, no mutex; the
library objects start no threads.

### 4.2 The two registration sites stay separate

First connect (578-592) checks two returns and prints `⚠️  RAW VTable registration failed` and
`⚠️  Ball valve RAW VTable registration failed`, then drains 1500 ms; reconnect (759-773) ignores
every return and does not drain. They differ observably, so they stay two blocks of `main`
(STYLE-S34; D49). Re-registration after an Elodin restart is not characterized (§7.4 gap 1);
freezing it and any shared registration helper belong to a future D-SLOT/D-SUB fix package.

### 4.3 Target files

| file | contents | size after move-only | after cleanup |
|---|---|---|---|
| `daq_bridge/daq_bridge_main.cpp` | 1-47, 91-111, 307-1074, plus `#include "BackendLogForwarder.hpp"`, `"BoardMap.hpp"` | ~841 | ~640 |
| `daq_bridge/BackendLogForwarder.hpp` | 49-90 verbatim, `#pragma once`, its includes (`<arpa/inet.h>`, `<netinet/in.h>`, `<sys/socket.h>`, `<unistd.h>`, `<cstring>`, `<cstdint>`, `<string>`, `<vector>`); global namespace; header-only (splitting it would be an edit) | ~55 | ~55 |
| `daq_bridge/BoardMap.hpp` | 113-137 types; declarations of the five functions, `load_board_map_from_config`'s default arguments here; includes `<cstdint>`, `<map>`, `<string>`, `config/LoadActiveBoards.hpp`, `time/BoardClockSync.hpp` | ~60 | ~63 |
| `daq_bridge/BoardMap.cpp` | 139-305 bodies, `static` removed, defaults removed from the definition; includes `<cstdlib>`, `<fstream>`, `<iostream>`, `config/Config.hpp`, `fsw/BoardTypeWire.hpp`, `"BoardMap.hpp"` | ~180 | ~220 |
| `daq_bridge/ElodinPublish.{hpp,cpp}` (cleanup) | `publish_self_tests` (816-883), `publish_raw_batch` (890-989; 885-888 stay in `main`) | — | ~45 / ~195 |

Global `BoardConfig`/`ServerHeartbeatConfig` coexist with `fsw::config`'s (`Config.hpp:35, 222`)
only because nothing here says `using namespace fsw::config`; keep it so, and no `daq_bridge`
namespace (it would need a second harness edit). Cleanup extractions (one call site each, D43(3)):
`print_board_routing_table` (383-418) into `BoardMap.cpp`; `publish_self_tests`,
`publish_raw_batch` into `ElodinPublish.cpp`. The guards stay at the call sites: 885-888 (the
banner, `bool publishing = …` and its `begin_batch`) stay in `main`, so `publish_raw_batch` is
890-989 and takes `publishing` as a parameter (by value). Every other local is passed by reference
(`elodin_client`, `effective_cfg`, `board_map`, `discovery`, `source_ip`, `receive_timestamp_ns`,
`clock_sync`, counters); statement order, `begin_batch` / `flush_batch` / drain and counter
increments exactly as today (the self-test path increments `elodin_publish_count` on a good flush
and nothing on a failed one, 877-878; only the raw path counts `elodin_drop_count`, 983). Nothing
else in `main` moves. Stub declarations:
`design-stubs/cpp/daq_bridge/{BoardMap,BackendLogForwarder,ElodinPublish}.hpp`.

---

## 5. Naming

New TUs are `<Class>_<aspect>.cpp` (§1.4, §2, §3); daq_bridge files are named for what they hold.
Move-only renames nothing; cleanup's only new identifiers are `print_board_routing_table`,
`publish_self_tests`, `publish_raw_batch` (snake_case, STYLE-S1). The harness-read
`ActuatorCommander` privates and `ActuatorRole` fields are never renamed (STYLE-S7).

---

## 6. Execution

### 6.0 Rules for every move-only commit

1. Cut whole top-level definitions with their leading comment blocks and section banners; paste
   them in the same relative order; open and close the same namespace.
2. Class TUs (`SequencerService_*`, `ActuatorCommander_load`, `ControllerService_*`): copy the
   source file's **entire include block** verbatim into each new TU, pruning nothing
   (ControllerService: lines 13-39, the two `using` lines included). `BoardMap.cpp` and the two
   new daq_bridge headers take §4.3's include lists instead. File-statics move to their one user
   (§1.4, §2).
3. `SequencerService.hpp`, `ActuatorCommander.hpp`, `ControllerService.hpp` untouched. No comment
   line added or edited (STYLE-S38): moved comments are verbatim, including 113-137's in
   `BoardMap.hpp`. The only additions are the two new daq_bridge headers' STYLE-S36 header
   comment and declaration doc lines, as the stubs give them. Same-class TUs and definition-only
   `.cpp` files (`_config`, `_controller_notify`, `_elodin`, `_pwm`, `_load`, `BoardMap.cpp`) get
   no new module header comment (S36 asks it of new headers).
4. `export PATH=/Users/roshantaneja/Downloads/STAR/.git/remaster-tools/fmtvenv/bin:$PATH;
   clang-format -i <new and edited files only>` (19.1.7).
5. Review with `git diff -M --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change
   HEAD~1`: every non-dimmed line is an include, `#pragma once` or an include guard, a namespace
   line, a removed `static` or default argument (daq_bridge only), the new headers' prototype
   lines and S36/doc comments, CMake, or clang-format's include regrouping/rewrap (D43(6)).
6. String literals (STYLE-S15): `grep -oh '"[^"]*"' <files> | sort` over the touched sources is
   identical before and after the commit, except the include paths of copied include blocks.

### 6.1 Move-only queue item (one item, three commits; D49)

Branch from the tip; one queue item; each commit builds with no new warning. A failed queue
branch is deleted and the item re-cut from the then-current tip with a full re-gate (D25).

**Commit 1 — daq_bridge, `ActuatorCommander_load`, both harness edits, all CMake restructuring.**

- [ ] `daq_bridge/BackendLogForwarder.hpp`, `BoardMap.hpp`, `BoardMap.cpp` as §4.3;
      `daq_bridge_main.cpp` keeps 1-47, 91-111, 307-1074 and includes the two headers.
- [ ] `services/sequencer/ActuatorCommander_load.cpp`: lines 46-50, 57-257, with the include block
      1-26 and the closing `}  // namespace sequencer`. Core keeps 1-45, 52-55, 259-829.
- [ ] Harness, `test/characterization/config/char_config_services.cpp:24`:
      `#include "../../../diablo_server/daq_bridge/daq_bridge_main.cpp"` →
      `#include "../../../diablo_server/daq_bridge/BoardMap.hpp"` (the `#elif
      CHAR_SERVICE_DAQ_BRIDGE` branch, 23-24; the other two branches untouched).
- [ ] Harness, `test/characterization/config/CMakeLists.txt`: after line 19 add
      `${_DS}/services/sequencer/ActuatorCommander_load.cpp`; after the `endforeach()` (41) add
      `target_sources(char_cfg_daq_bridge PRIVATE ${_DS}/daq_bridge/BoardMap.cpp)`. (That scope
      does not see `ACTUATOR_COMMANDER_SOURCES`, so the list stays explicit.)
- [ ] `diablo_server/CMakeLists.txt`, before `add_subdirectory(lib)` (line 2):
  ```cmake
  set(SEQ_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/services/sequencer)
  set(ACTUATOR_COMMANDER_SOURCES
      ${SEQ_SRC_DIR}/ActuatorCommander.cpp
      ${SEQ_SRC_DIR}/ActuatorCommander_load.cpp)
  set(SEQUENCER_SOURCES
      ${SEQ_SRC_DIR}/SequencerService.cpp
      ${SEQ_SRC_DIR}/StateMachine.cpp
      ${ACTUATOR_COMMANDER_SOURCES}
      ${SEQ_SRC_DIR}/AbortBroadcaster.cpp
      ${SEQ_SRC_DIR}/HoldTimer.cpp
      ${SEQ_SRC_DIR}/ScriptStates.cpp
      ${SEQ_SRC_DIR}/ScriptRunner.cpp
      ${SEQ_SRC_DIR}/PressureFeed.cpp)
  ```
  (the order every target lists today).
- [ ] `services/CMakeLists.txt` 14-24: `add_executable(sequencer_service
      sequencer/sequencer_main.cpp ${SEQUENCER_SOURCES})`.
- [ ] `lib/CMakeLists.txt`, the 6 SequencerService test executables — `test_sequencer_elodin`
      (256-263), `test_hold_rules` (278-285), `test_script_states` (301-308), `test_script_runtime`
      (327-334), the `foreach` pair `test_sequencer_concurrency`/`test_abort_ordering` (409-416):
      replace the eight sequencer source lines with `${SEQUENCER_SOURCES}`. The 4
      ActuatorCommander-only executables — `test_fire_lifecycle` (156), `test_actuator_delays`
      (205), `test_script_positions` (225), `test_ball_valve_commander` (241): replace the
      `ActuatorCommander.cpp` line with `${ACTUATOR_COMMANDER_SOURCES}`.
- [ ] `daq_bridge/CMakeLists.txt:3`: `add_executable(daq_bridge daq_bridge_main.cpp BoardMap.cpp)`.
- [ ] Harness proof (D18): `config/golden/cpp/*` and `config/golden/bin/daq_bridge/*`
      byte-identical; the config area's recorded mutations re-run; two new mutations, each red
      then reverted: in `ActuatorCommander_load.cpp` `role.is_pwm = !r.controller_role.empty();` →
      `= false;` (the `role … is_pwm=` lines go red); in `BoardMap.cpp`,
      `load_board_map_from_config`'s `if (octet >= 2)` (baseline 218, not the one at 298) →
      `>= 3` (the `board_by_octet[…]` and `resolve("127.0.0.2…")` lines go red). The orchestrator
      reviews the harness diff.

**Commit a — SequencerService TUs.**

- [ ] `services/sequencer/SequencerService_config.cpp` (139-567),
      `SequencerService_controller_notify.cpp` (35-39, 995-1114), `SequencerService_elodin.cpp`
      (27-33, 41-53, 1116-1168, 1245-1293); each with include block 1-25 and line 1295. Core keeps
      1-25, 55-137, 569-993, 1170-1243, 1295.
- [ ] `diablo_server/CMakeLists.txt`: append `${SEQ_SRC_DIR}/SequencerService_config.cpp`,
      `…_controller_notify.cpp`, `…_elodin.cpp` to `SEQUENCER_SOURCES` right after
      `SequencerService.cpp`.

**Commit b — ControllerService TUs.**

- [ ] `lib/src/control/ControllerService_pwm.cpp` (41-62, 383-530) and
      `ControllerService_elodin.cpp` (754-1107), each with lines 13-39 and 1159-1160. Core keeps
      1-39, 64-381, 532-752, 1109-1160.
- [ ] `lib/CMakeLists.txt` `FSW_SOURCES`: after line 41 add `src/control/ControllerService_pwm.cpp`
      and `src/control/ControllerService_elodin.cpp`.

"All CMake in commit 1" means the restructuring: CMake cannot list a file that does not exist yet,
so commits a and b each append their own source lines and nothing else.

**Verify** (port-binding runs under `bash daq-server/test/characterization/with_stack_lock.sh`,
subsets only, D23/D36). Build and warnings after every commit; the rest on the item's tip:

- [ ] Clean build; warnings vs `test/characterization/baseline_warnings.txt` unchanged (D4).
- [ ] `ctest -R 'actuator_delays|script_positions|ball_valve_commander|fire_lifecycle|hold_rules|script_states|script_runtime|sequencer_concurrency|abort_ordering|sequencer_elodin|controller_pwm_roles|robust_ddp|characterization_config_cpp'`.
- [ ] Characterization, in subsets (iterate with `CHAR_SEQ_ONLY=<regex>`):
      ```
      CHAR_AREAS=sequencer,packets,config,lifecycle \
        bash daq-server/test/characterization/with_stack_lock.sh \
        bash daq-server/test/characterization/run.sh
      CHAR_AREAS=elodin,pipeline bash daq-server/test/characterization/with_stack_lock.sh \
        bash daq-server/test/characterization/run.sh
      ```
- [ ] `bash daq-server/test/characterization/linux/linux_gate.sh --areas sequencer,config,lifecycle,packets,elodin,pipeline <tip>`.
- [ ] **CI run, required** (D34: any WP touching the sequencer). `actuator_delays`,
      `script_positions`, `script_runtime` and `t7_integration` (which links `fsw_daq_lib`, changed
      by commit b) are judged on CI only; this Mac and the local Docker leg inherit the host's
      timer overshoot. If CI cannot judge them, the item waits; there is no partial fallback.
- [ ] D31: if any of `actuator_delays`, `script_positions`, `script_runtime`,
      `sequencer_concurrency` needed a retry, run it 10x alone (Linux) on the item's tip and on
      **the pre-WP tip**; the item is not done unless its pass rate is no worse.
- [ ] A red sequencer session that is only a republish interval or a multiplied PressureFeed
      stream is re-run on the pre-WP tip before WP10 is blamed (§8; D-PF does not gate WP10).

### 6.2 Cleanup queue item

Cut from the tip after the move-only item merges; fully gated like it (same verify list; D31
baseline: the pre-WP tip, as for the move-only item). Content:

- [ ] **Dead ControllerService code, one commit.** Delete `setNavState` (hpp 92; cpp 245-248 and
      blank 249), `getLastActuation`/`getLastDiagnostics` with their doc comment (hpp 138-140 and
      blank 141; cpp 373-381 and blank 382), `output_mutex_`/`last_actuation_`/`last_diagnostics_`
      with their comment (hpp 220-223 and blank 224) and the store block in `controllerLoop` (cpp
      703-708 and blank 709): 27 lines plus 5 blanks; the cpp lines are in core after move-only.
      Proof: clean build (it recompiles `fsw_daq_lib`'s ControllerService TUs,
      `controller_service`, `test_controller_pwm_roles` and, through `PWMTargets.hpp:29`,
      `char_config_dump`, without editing any of them); then
      `git grep -n 'setNavState\|getLastActuation\|getLastDiagnostics\|output_mutex_\|last_actuation_\|last_diagnostics_' -- daq-server ':!daq-server/docs'`
      prints nothing (before: only `ControllerService.{hpp,cpp}`); `packets/golden/service_pwm.txt`,
      `sequencer/golden/controller__*` and the config goldens byte-identical. `current_nav_` stays
      (read at cpp 322, 558; §9).
- [ ] **Include pruning** in every new and touched TU, to what it uses; a clean build is the
      proof.
- [ ] **`using namespace vtable; using namespace vtable::builder;`** out of every TU that does
      not need them: core `ControllerService.cpp` and `ControllerService_pwm.cpp` (they stay in
      `_elodin`).
- [ ] **`// Kept:` tags** at every frozen-defect site, long form (STYLE-S12, D46):
      `// Kept: <id> (D17) — <class>/<phase>: <rule>; loud half: <surface>`. Proposed text,
      settled in the cleanup review; `grep -rn 'Kept: C4-\|Kept: C1-\|Kept: C6-'` is the fix
      packages' index.

| id | site (move-only file; baseline anchor) | class/phase | rule | loud half |
|---|---|---|---|---|
| C4-1 | `SequencerService.cpp`, refused-state block (716-730) | control/duty | a refusal leaves the rig commandable | `ERR:` after the 10 s worker timeout on :9998 (`digital-twin__scripts-load`) |
| C1-10 | `SequencerService.cpp`, both `triggerAbort()` calls (794-795, 915-917) | safety/duty | one ABORT broadcast per abort entry | boards: 8 ABORT, ABORT_DONE re-timed (`service_abort.txt`) |
| C4-3 | `SequencerService.cpp` 835; `ActuatorCommander.cpp` 462 | safety/duty | abort entry cancels pending stages | actuator UDP (`default__aborts`) |
| C4-2 | `SequencerService_config.cpp`, dynamic-state hold rule (514-520) | control/duty | one timeout transition per entry | `[HoldTimer]` log |
| C4-4 | `ActuatorCommander.cpp` 434; `SequencerService.cpp` 862 | control/duty | every Fire role has an owner | controller `ERR:fire gate disabled …` (`default__fire-sequencer-owns-valves`) |
| C4-5 | `ControllerService.cpp`, `fire_active_` read in `controllerLoop` (699) | safety/duty | no PWM after the zero-duty close | PWM UDP (dropped by N7b) |
| C1-12 | `daq_bridge_main.cpp` 368-369 | observation/startup | argv's bind port is the port bound | startup log (`config/golden/bin/daq_bridge`) |
| C6-1 | `daq_bridge_main.cpp` 525-527 | observation/startup | a log line states what was sent | "Proactive SENSOR_CONFIG sent to N" (lifecycle `startup`) |
| C6-3 | `daq_bridge_main.cpp` 629 | safety/duty | SERVER_HEARTBEAT loss is taken over | none (boards abort 15 s later; lifecycle `hbloss`) |

- [ ] **`publishState` lock contract**, above `publishState` in `SequencerService_elodin.cpp`:
      `// Lock contract: acquires config_mutex_ and releases it before pressure_feed_.read and
      elodin_.publish. Callers must not hold config_mutex_, except doTransitionTo's refused-state
      block (Kept: C4-1 (D17)).` Re-home the "Elodin publishing" banner (995-997) above it.
- [ ] **Stale comments (STYLE-S38)**, comments only, each now naming a moved line or file:
      `test/characterization/config/char_config_services.cpp:1-4` (daq_bridge's branch now
      includes `BoardMap.hpp`, not a main) and `:100` (`BoardMap.cpp`'s
      `load_board_map_from_config`); `test/characterization/packets/README.md:37` and
      `test/characterization/config/README.md:40` (the BoardMap functions are no longer
      file-static helpers of a main); `lib/include/control/ScriptStates.hpp:60` (cites
      `SequencerService.cpp:384-445`, which moves to `SequencerService_config.cpp`); and, once WP8 pass 2 has
      landed, the `Conn` comment WP8 moved verbatim into `lib/src/net/TcpCommandServer.cpp` (from
      `sequencer_main.cpp:282-283`; it names `svc` and `main()`, neither of which exists there — DESIGN-WP8
      §6.2 "Stale after pass 2"). The harness
      comment edits are allowed under D18 (goldens byte-identical; the orchestrator reviews).
- [ ] **daq_bridge extractions** (§4.3): `print_board_routing_table`, `publish_self_tests`,
      `publish_raw_batch`; `ElodinPublish.cpp` added to `daq_bridge/CMakeLists.txt`. The harness
      does not call them.
- [ ] **daq_bridge signals** (§0): `installStopHandlers(kStopThenPrint, "\n[DAQ Bridge] Shutting
      down...", Sigpipe::kIgnore)`, `fsw::service::running()`.

Not in cleanup (parked or forbidden): fixing C4-1/C4-2/C4-3/C1-10/C4-4/C4-5/C6-1/C6-3/C1-12; a
shared registration helper for daq_bridge (§4.2); replacing the republish 10 ms slices with a
condition variable (`ActuatorCommander.cpp:652-654` defers it; it changes timing); B4 encoders;
unifying `toLower`/`trimVal`/`trim`; the `fire_start_time_` and `elodin_` pointer races; a shared
table-id helper (WP3's `table_id_for` was dropped by D62, DESIGN-WP3 §2.5; the candidates in
history are for a D-SLOT package).

### 6.3 Sizes (STYLE-S33: C++ TU ≤ 700; no waiver)

Move-only figures are bare range sums on the baseline (copied include block + moved ranges +
namespace lines); the blank separators between pasted ranges add ±5. Cleanup figures are
estimates.

| file | today | after commit 1 | after a | after b | after cleanup |
|---|---|---|---|---|---|
| `SequencerService.cpp` | 1295 | 1295 | 608 | 608 | ~608 (+tags, −includes) |
| `SequencerService_config.cpp` | — | — | 455 | 455 | ~450 |
| `SequencerService_controller_notify.cpp` | — | — | 151 | 151 | ~140 |
| `SequencerService_elodin.cpp` | — | — | 148 | 148 | ~150 |
| `ActuatorCommander.cpp` | 829 | 620 | 620 | 620 | ~620 |
| `ActuatorCommander_load.cpp` | — | 233 | 233 | 233 | ~225 |
| `ControllerService.cpp` | 1160 | 1160 | 1160 | 630 | ~600 (−32 dead, −2 `using`, +tag) |
| `ControllerService_pwm.cpp` | — | — | — | 199 | ~185 (−2 `using`) |
| `ControllerService_elodin.cpp` | — | — | — | 383 | ~380 |
| `ControllerService.hpp` | 244 | 244 | 244 | 244 | 234 |
| `daq_bridge_main.cpp` | 1074 | ~841 | ~841 | ~841 | ~640 |
| `BoardMap.{hpp,cpp}` | — | ~60 / ~180 | | | ~63 / ~220 |
| `BackendLogForwarder.hpp` | — | ~55 | | | ~55 |
| `ElodinPublish.{hpp,cpp}` | — | — | | | ~45 / ~195 |

`daq_bridge_main.cpp` is over 700 between move-only and cleanup: interim, not a waiver (STYLE.md conflict
9, D43(9): size targets are per WP). Its cleanup no longer relies on a registration helper: the
three extractions alone remove 204 lines (383-418, 816-883, 890-989). Without `_pwm`, core
`ControllerService.cpp` would be ~800 and need a waiver.

### 6.4 Must not change (both items)

| surface | frozen by |
|---|---|
| actuator UDP bytes, order, board, 3 rounds, `usleep(1000)` | `sequencer/golden/*` (N2), `actuator_delays`, `ball_valve_commander` |
| abort: ABORT first, 2 x 4 repeats, ABORT_DONE after 3000 ms (60 x 50 ms), no CLEAR_ABORT | `packets/golden/service_abort.txt`, sequencer `first datagram:` |
| stage delays, generation semantics incl. C4-3 | sequencer N4, `default__aborts`, `actuator_delays` |
| republish 100 x 10 ms, `defer_first_pass` | sequencer N5 `[0.8, 1.5] x 1 s`, `script_positions`, `script_runtime` |
| PWM bytes, version 0, same-board single packet | `packets/golden/service_pwm.txt`, `sequencer/golden/controller__*`, `default__fire-*` |
| TCP replies (`OK`, `OK:<ms>`, `ERR:<reason>`, `ERR:unknown command`, `ERR:too many connections`, `ERR:not in FIRE state`, `SCRIPT:…`, `END`; controller `OK`, `ERR`, `ERR:fire gate disabled (sequencer owns the valves)`) | `default__malformed`, `default__holds`, `digital-twin__scripts-load`, `controller__*` |
| timing: 10 s command timeout, 300 ms connect, `SO_SNDTIMEO` 1 s / 100 ms, Elodin retry 5 s in 100 ms slices, 3000 ms abort done, hold rounding `d*1000+0.5`, controller 20 x 100 ms and 1 ms, daq_bridge 500 µs / 5 s / 1500 ms / 2 s | sequencer N4/N5, `hold_rules`, lifecycle bounds (§7.4 gap 2) |
| Elodin tables and registration order | `elodin/golden/schema_*.txt` (startup), `pipeline/golden/*` |
| SERVER_HEARTBEAT, log envelope, SENSOR_CONFIG push (C6-1: none) | `packets/golden/service_daq_bridge.txt`, lifecycle `startup`, `hbloss` |
| exit codes (daq_bridge: 1 for missing config, C2-12, NIC, FSW manager, pipeline; 0 after the loop); startup order; startup log through `[System] Mode` | lifecycle `shutdown`, sequencer N6, `config/golden/bin/daq_bridge` |
| log lines read by tests: SEQ_LOAD, SEQ_FACTS, CTL_FACTS (`char_sequencer.py:349-372`); daq_bridge "Listening for DiabloAvionics packets", "Proactive SENSOR_CONFIG sent to", "[DAQ Bridge] Shutdown complete" | sequencer, lifecycle |
| controller tables [0x40]-[0x44] and order, subscribe set, loop log sampling `tick % 10/50/100`; daq_bridge raw/env/self-test table ids and fallback ladder | `elodin/golden`, `pipeline/golden/*` |
| SIGPIPE: sequencer ignore, daq_bridge ignore, controller default | WP8's per-service setting |

---

## 7. Guarding characterization

### 7.1 Coverage

Black box: `sequencer/` (64 sessions, incl. C4-1, C4-3, C4-4, C4-6), `packets/` (`service_abort`,
`service_pwm`, `service_daq_bridge`), `elodin/` (sections `sequencer`, `controller_service`,
`daq_bridge`), `lifecycle/`, `pipeline/`, `config/golden/bin/daq_bridge`, `test_integration.sh`.
White box: `config/golden/cpp/config` `=== ActuatorCommander` (§7.2), `config/golden/cpp/daq_bridge`
(§7.3). Ctests: the §6.1 verify list.

### 7.2 `char_ac_private.cpp` (`#define private public`, line 23)

It reads `bind_addr_`, `bind_addr_explicit_`, `actuator_port_`, `roles_` and the `ActuatorRole`
fields. `ActuatorCommander.hpp` is unchanged, so the file needs no edit; its target
`char_config_dump` (`config/CMakeLists.txt:15-21`) gains `ActuatorCommander_load.cpp` (commit 1).
It is the only `#define private public` in the tree; no harness reaches a private of
`SequencerService.hpp` or `ControllerService.hpp`. `char_config_dump.cpp:38` includes
`PWMTargets.hpp`, which includes `ControllerService.hpp` (`PWMTargets.hpp:29`): cleanup's header
edit recompiles it without editing it. `ActuatorCommander.cpp:101` names `PWMTargets.hpp` in a
comment only.

### 7.3 `char_config_services.cpp` (`#include` of `daq_bridge_main.cpp`)

It reaches, all from 113-305: `BoardType`, `BoardConfig`, `BoardByOctet`, `ServerHeartbeatConfig`,
`load_board_map_from_config`, `ipv4_host_octet`, `resolve_board_config_by_source_ip`,
`config_board_type_to_wire_u8`, and `fsw::time::TimeSyncConfig` (via `time/BoardClockSync.hpp`,
which `BoardMap.hpp` includes); it captures stdout/stderr around the call, so the `[Config] WARN`
line is golden. After commit 1 it compiles no `main` for daq_bridge (closer to D20). The stacklight
and config_broadcast branches need no edit. `print_board_routing_table` in `BoardMap.cpp` (cleanup)
does not affect it.

### 7.4 Gaps (none gates WP10)

1. Re-registration after an Elodin restart is not frozen for daq_bridge (759-773), the sequencer
   (`tryConnectElodin`) or the controller (`connectSubscriber`). WP10 keeps that code verbatim;
   freezing it belongs to a future D-SLOT/D-SUB fix package (D49).
2. Not characterized: controller TABLE rows, LUT/DDP duties and the thrust curve (hence D22's
   "control math stays in core"); ActuatorCommander failure paths; daq_bridge stats/time-sync text
   and the discovery fallback; C4-2's double fire (avoided) and C4-5's straggler (dropped by N7b).
   Timing constants are frozen only as bounds; move-only changes none. Sequencer/controller exit
   codes and SIGTERM latency are closed by DESIGN-WP8 gap 2 (a prerequisite).

---

## 8. Risks

- **Concurrency.** The split changes no thread, lock or call order; the risk is an "obvious" fix
  slipping in: everything §1.3 forbids, nesting two ActuatorCommander mutexes, or moving
  `notifyControllerFire` off the thread that calls it. TSan (CI) stays green with no new
  suppressions.
- **Static init and linkage.** No moved TU has a namespace-scope object with dynamic
  initialization; add none. File-statics move, never copy. daq_bridge's helpers gain external
  linkage (linked only into `daq_bridge` and `char_cfg_daq_bridge`); `BackendLogForwarder` leaves
  its anonymous namespace (no other definition of the name exists). `fsw_daq_lib` exports the same
  symbols after move-only and three fewer after cleanup.
- **Timing (D31, D34).** On this Mac `sleep_for(10 ms)` overshoots ~3.5 ms, so the republish runs
  ~1.35 s against the sequencer bound of 1.5 x 1 s. A red sequencer session whose only diff is a
  republish interval, or a multiplied PressureFeed stream, is checked against the same run on the
  pre-WP tip before WP10 is blamed. D-PF (`PressureFeed.cpp:118-146`) is its own investigation
  item and does not gate WP10; WP10 does not move `PressureFeed.cpp`.
## 9. Open question

1. After cleanup deletes `setNavState`, `current_nav_` is never written (read at
   `ControllerService.cpp:322, 558`): a planned input or a dead member? WP10 keeps it either way;
   the team decides.
