# DESIGN-WP10 — split the sequencer, actuator, controller and bridge god files

Target-design note required by D17(a) before WP10's move-only pass. Scope: four files under
`daq-server/diablo_server/`:

| file | lines | class / unit |
|---|---|---|
| `services/sequencer/SequencerService.cpp` | 1295 | `sequencer::SequencerService` (header `lib/include/control/SequencerService.hpp`, 342) |
| `services/sequencer/ActuatorCommander.cpp` | 829 | `sequencer::ActuatorCommander` (header `lib/include/control/ActuatorCommander.hpp`, 237) |
| `lib/src/control/ControllerService.cpp` | 1160 | `fsw::control::ControllerService` (header `lib/include/control/ControllerService.hpp`, 244) |
| `daq_bridge/daq_bridge_main.cpp` | 1074 | the `daq_bridge` executable's `main` and its file-scope helpers |

All line numbers below were re-anchored on `backend-remastered` @ `b2599617` (product code there is
`main` @ `15b5a0c5`). If WP3/WP8/WP9 land first (the DAG says they do), re-anchor with the `grep -n`
anchors given in each step; the function names, not the numbers, are the contract of this note.

**Prerequisites:** C1 (`packets/`, `elodin/`) merged into `backend-remastered`; WP8 and WP9 merged
(DAG); DESIGN-WP8 gap 2 (sequencer/controller/t7 SIGTERM/SIGINT exit code and latency) merged.

**Orchestrator decisions recorded here (design review):**
- WP10 **owns `diablo_server/CMakeLists.txt`** (for `SEQUENCER_SOURCES` /
  `ACTUATOR_COMMANDER_SOURCES`).
- `char_config_services.cpp`'s daq_bridge branch is re-pointed to `BoardMap.hpp` (accepted).
- **D18 is extended for WP10:** besides the two harness `.cpp` files, WP10 may edit
  `test/characterization/config/CMakeLists.txt`, only to add `ActuatorCommander_load.cpp` and
  `ActuatorCommander_udp.cpp` to `char_config_dump` and `target_sources(char_cfg_daq_bridge PRIVATE
  …/daq_bridge/BoardMap.cpp)`. **That CMake edit, the BoardMap split and the include change land
  in ONE commit** (§6.1 step 4). Goldens byte-identical; the area's mutations re-run; the
  orchestrator reviews the harness diff.
- The move-only pass and the cleanup pass are **separate queue items, each fully gated**.

Rules this note applies: D5 (contract frozen), D12(e) (move-only package merged alone, then
cleanup), D17 (design over speed, behaviour bit for bit, per-service settings, no single-user
abstractions), D18/D20 (harness re-pointing), D22 (float), D31/D34 (timing tests), the Parked
SIGPIPE entry, and the C4-x / C1-10 defects, which stay exactly as they are.

**What "no single-user abstraction" means here.** No new class, interface, template, callback type
or configuration knob with one user. Moving existing member functions into another TU of the same
class is not an abstraction. Extracting a block of `main()` into a named free function with one call
site (cleanup pass, daq_bridge only) is a split of a god function, not an abstraction; it is allowed
only where listed below.

---

## 0. Boundary with WP8 (lands first)

WP8 owns process plumbing in the mains (`DESIGN-WP8.md`, committed beside this note): the stop
flag and `installStopHandlers` with the per-service SIGPIPE setting, `openTcpListener` +
`serveTcpClients` replacing the `:9998` accept loop in `sequencer_main.cpp` and the `:9999` loop
in `controller_main.cpp`, `openUdpSocket` + `ipv4Destination` (functions, not an owning
`UdpSender` class), and `followSequencerState` for heartbeat/stacklight only. DESIGN-WP8 §0
**rejects** a generic `SubscriberLoop` and a shared argv parser, so every Elodin loop below stays
its owner's code. WP10 does not touch `sequencer_main.cpp` or `controller_main.cpp`; it
designs the class splits assuming WP8 has landed. Per call site:

| BLOAT-MAP site | in WP10's files | WP8 adoption list (BLOAT-MAP WP8) | WP10 action |
|---|---|---|---|
| B1 `ActuatorCommander.cpp:343-371` (socket per batch, `SO_SNDTIMEO` 100 ms, hand `bind()` to `bind_addr_`) | yes | not listed | **moves as-is** to `ActuatorCommander_udp.cpp`. Not adopted: a per-batch socket with an explicit `bind()` (including to `0.0.0.0`) and its own failure log `[ActuatorCommander] bind(<addr>) failed: <strerror>` differ from `fsw::net::bindToDaqInterface`; adopting would change the log and possibly the source port lifetime. It may adopt `fsw::net::openUdpSocket(false)` in cleanup (same statement); the bind stays its own. |
| B1 `ControllerService.cpp:92-98` (one socket for the process, `bindToDaqInterface`), sends at `:434-439`, `:498-506` | yes | not listed (WP8's "controller" is `controller_main.cpp`) | **moves as-is** (`initialize` stays in the core TU, sends go to `ControllerService_pwm.cpp`). Cleanup may adopt `openUdpSocket(false)` and `ipv4Destination` where the statements are identical (DESIGN-WP8 §2.2). |
| B1 `daq_bridge_main.cpp:57-83` `BackendLogForwarder` | yes | not listed | **moves as-is** to `daq_bridge/BackendLogForwarder.hpp`. |
| B1 TCP client `SequencerService.cpp:1023-1114` `notifyControllerFireOnce` | yes | TCP clients are listed in B1 but no WP8 helper is named | **moves as-is** to `SequencerService_controller_notify.cpp`. Adopt a WP8 helper in cleanup only if it keeps: non-blocking connect + `poll` 300 ms, `SO_SNDTIMEO` 1 s, blocking restore before `send`, `SO_RCVTIMEO` 300 ms, one `recv` of at most 15 bytes, prefix test `"OK"`, every log text below. |
| B3 `SequencerService.cpp:1253-1293` (`tryConnectElodin`, retry thread) | yes | none (a publisher re-registration loop; DESIGN-WP8 shares no Elodin loop) | **moves as-is** to `SequencerService_elodin.cpp`; no WP8 helper applies. |
| B3 `ControllerService.cpp:754-915` (connect+subscribe, 2 s retry, read loop) | yes | not listed | **moves as-is** to `ControllerService_elodin.cpp`. DESIGN-WP8 has no `SubscriberLoop`, so this stays; for the record it keeps: subscribe failure drops the connection with the same log; retry = 20 x 100 ms slices checking `running_`; read loop sleeps 1 ms on no header and on `packet_len < 4 || > 65536`; `read_bytes_exact` for the payload; the reconnect log lines. |
| B3 `daq_bridge_main.cpp:574-606` and `:745-776` (publisher connect + 5 s reconnect inside the single-threaded loop) | yes | not listed | **not** a subscriber; becomes `registerAllTables()` in cleanup (§4.6). |
| B5 signals `daq_bridge_main.cpp:106-111, 341-344` | yes | WP8 | WP8 does not adopt daq_bridge; WP10's **cleanup** applies DESIGN-WP8 §2.1's setting `installStopHandlers(kStopThenPrint, "\n[DAQ Bridge] Shutting down...", Sigpipe::kIgnore)` at 341-344 and replaces `running` (106) with `fsw::service::running()`. Move-only leaves them in `daq_bridge_main.cpp`. |

SIGPIPE (Parked entry): `sequencer_service` and `daq_bridge` ignore it; `controller_service` dies on
it. WP10 code depends on that, so it is listed here as a cross-check for WP8: the sequencer's
`notifyControllerFireOnce` calls `send()` without `MSG_NOSIGNAL` (`SequencerService.cpp:1075`), and
`ElodinClient::write_all` uses no `MSG_NOSIGNAL` anywhere in `lib/`, so daq_bridge surviving an
elodin-db restart (`lifecycle/golden/shutdown.txt`: "daq_bridge still running: True") and the
controller dying on one both come from the process-level disposition, not from the code WP10
moves.

---

## 1. SequencerService

### 1.1 Current responsibilities (`SequencerService.cpp`)

| lines | what |
|---|---|
| 1-25 | includes, `namespace sequencer {` |
| 27-33 | Elodin ids `VTABLE_SEQUENCER_STATE = 0x5000`, `VTABLE_STATE_TRANSITION = 0x4300` (file-static) |
| 35-39 | `kControllerConnectTimeoutMs = 300` (file-static) |
| 41-47 | `SequencerStateMsg` (17 bytes), `StateTransitionMsg` aliases |
| 49-53 | `static now_ns()` (steady clock) |
| 55-71 | destructor: stop worker (`cmd_mutex_`, `cmd_stop_`), join, `stopElodinRetry`, `stopContinuousLoop`, `hold_timer_.stop()` — in that order |
| 73-137 | command queue: `commandLoop`, `enqueueAndWait` (10 s), `enqueueDetached` |
| 139-147 | `static readFile` |
| 149-187 | `loadConfig` (fallbacks `config/`, `../config/`, `../../config/`), `configDir` |
| 189-204 | `static resolveDataPath` (prefixes `""`, `../`, `../../`) |
| 206-567 | `applyConfig`: `[[states]]` 218, transitions CSV 220-227, actuator + delays CSV 229-239, NIC 241-250, abort broadcaster 252-262, `[fire]` 264-324, hold rules 326-371, `[flow]` 373-481, dynamic states + `pressure_feed_.start` 483-549, publish `hold_rules_` 551-554, controller endpoint 556-566 |
| 569-623 | `init` (order below) |
| 625-631 | `isAbortState` |
| 633-664 | public `transitionTo` overloads (enqueue) |
| 666-938 | `doTransitionTo` |
| 940-993 | `setDebugMode`/`doSetDebugMode`, `manualActuator`/`doManualActuator`, `extendFire`/`doExtendFire` |
| 995-1114 | `notifyControllerFire` (one retry), `notifyControllerFireOnce` (TCP client) |
| 1116-1168 | `publishState` ([0x50,0x00]) |
| 1170-1204 | `makeScriptEnv` |
| 1206-1243 | `scriptStatusReport` (`SCRIPTS` reply body) |
| 1245-1251 | `publishStateTransition` ([0x43,0x00]) |
| 1253-1293 | `tryConnectElodin`, `startElodinRetry`, `stopElodinRetry` |

`init` order (observable: load-time log lines frozen by sequencer N6, schema order frozen by
`elodin/golden/schema_*.txt` section `sequencer`, first datagrams frozen by every
`sequencer/golden/*__entry__*` session): `loadConfig` → `load_from_string` → `applyConfig`
(states, CSVs, NIC, abort, fire, holds, flow, scripts and `PressureFeed` thread, controller
endpoint, "Fire valve ownership" log) → `load_active_boards` snapshot (580-588) →
`tryConnectElodin` (non-sensor tables, BV_CMD tables, `setElodinClient`, `publishInitialState`) →
`startElodinRetry` → `current_state_ = bootState()` → `publishState` →
`applyForState(boot, true)` → `startContinuousLoop(boot, false)` → worker thread → "Initialized".

### 1.2 Threads and shared state (sequencer process)

| thread | created at | runs |
|---|---|---|
| main | `sequencer_main.cpp` | accept loop (WP8) |
| connection threads (<= 64) | `sequencer_main.cpp` | parse a line, call a public method, block in `enqueueAndWait` <= 10 s |
| `cmd_thread_` worker | `init` 616 | every `do*` body; the only thread inside the state machine |
| `elodin_retry_thread_` | `startElodinRetry` 1278 | every 5 s (100 ms slices): `tryConnectElodin` if disconnected |
| `ActuatorCommander::loop_thread_` | `startContinuousLoop` | republish |
| stage threads (detached) | `ActuatorCommander::applyForState` 592 | delayed stages |
| `HoldTimer::timer_thread_` | `HoldTimer::start` | expiry: `on_active(false)` → `notifyControllerFire(false)` on this thread, then `on_expire` → `enqueueDetached` |
| `ScriptRunner::thread_` | `ScriptRunner::start` | script; `set_valve` → commander, `transition` → `enqueueDetached` |
| `AbortBroadcaster::done_thread_` | `triggerAbort` | ABORT_DONE after 60 x 50 ms |
| `PressureFeed::thread_` | `pressure_feed_.start` | its own Elodin subscription |

| primitive | type (header line) | guards |
|---|---|---|
| `cmd_mutex_` + `cmd_cv_` | `std::mutex`, `std::condition_variable` (hpp 167-168) | `cmd_queue_`, `cmd_stop_` writes |
| `cmd_stop_` | `std::atomic<bool>` (170) | shutdown |
| `config_mutex_` | `mutable std::mutex`, **non-recursive** (255) | `hold_rules_`, `dynamic_states_`, `refused_states_` |
| `current_state_`, `debug_mode_` | `std::atomic` (235-236) | — |
| `elodin_retry_stop_` | `std::atomic<bool>` (283) | retry thread |
| unguarded, written only in `applyConfig`/`init` before the worker starts | — | `fire_state_`, `fire_expiry_state_`, `fire_duration_ms_`, `fire_extended_ms_`, `controller_host_/port_`, `sequencer_owns_valves_`, `daq_bind_address_`, `actuator_boards_`, `ball_valve_boards_`, `elodin_host_/port_`, `config_path_/content_` |
| `elodin_` (`ElodinClient`) | internal `publish_mutex_` (`ElodinClient.hpp:191`) | used by worker, retry thread, loop and stage threads (through the commander's pointer) |

Lock order today (must not change): `config_mutex_` → `ScriptRunner::mtx_` (`doTransitionTo`
924-929 holds `config_mutex_` across `script_runner_.start(...)` and `makeScriptEnv`);
`config_mutex_` → `PressureFeed::mtx_` (`scriptStatusReport` 1217-1240 holds it across
`pressure_feed_.read`). `publishState` takes `config_mutex_` (1130-1139) and releases it before
`pressure_feed_.read` and `elodin_.publish`. `cmd_mutex_` is never held while running a command.
Cross-thread re-entry is avoided by `enqueueDetached` from the hold-timer and script threads
(864-882, 1186-1190).

### 1.3 Known defects that must stay exactly as they are

- **C4-1 deadlock.** `doTransitionTo` 716-730: `std::lock_guard<std::mutex> lk(config_mutex_)` at
  717, then, for a state in `refused_states_`, `publishState()` at 727 *inside that scope*.
  `publishState` returns early at 1117-1118 when `!elodin_.is_connected()`; otherwise it locks
  `config_mutex_` again at 1130 → self-deadlock on a non-recursive mutex. The worker never returns;
  every later command times out after `kCommandTimeoutSeconds` (10 s) with "command timed out
  after 10s waiting for the worker — reporting failure (it may still run)"; the destructor's
  `cmd_thread_.join()` (65-66) never returns, so SIGTERM does not exit. Frozen by
  `sequencer/golden/digital-twin__scripts-load.txt`. After the split `doTransitionTo` stays in
  `SequencerService.cpp` and `publishState` moves to `SequencerService_elodin.cpp`: the re-entry
  becomes cross-TU but is the same call on the same member mutex. Forbidden in both passes:
  changing `config_mutex_` to `recursive_mutex`, moving the `publishState()` call out of the
  scope, adding an unlocked `publishState` variant, or reordering the 716-730 block.
- **C4-2 double timeout.** A dynamic state's timeout is both a hold rule (`applyConfig` 514-520,
  armed by `hold_timer_.start` 863) and `ScriptRunner`'s own deadline (`ScriptRunner.cpp:489`,
  `env.transition(ds.timeout_target)` 528); both post `doTransitionTo(timeout_target)` via
  `enqueueDetached`. Keep both.
- **C4-3 abort does not cancel a pending stage.** `doTransitionTo` 835 calls
  `applyForState(to, /*is_transition=*/!isAbortState(to))`; for an abort that is `false`, so
  `ActuatorCommander::applyForState` 462 does not bump `schedule_gen_` and a stage of the state
  being left still lands after the abort batch. Frozen by `default__aborts` (Fuel Press +0.2 s
  after Engine Abort).
- **C1-10 `triggerAbort` twice.** 794-795 (before anything else) and 915-917 (after
  `current_state_ = to`): 8 ABORTs, then 4 ABORT_DONEs (the second call cancels and reschedules
  the first's ABORT_DONE). Frozen by `packets/golden/service_abort.txt` and sequencer N3a `xK`.
- **C4-4.** With `sequencer_owns_valves = true` (`applyConfig` 560) the hold has no notifier (862)
  and `ActuatorCommander::applyForState` 434 still skips `is_pwm` roles in the fire state: nobody
  commands them. Frozen by `default__fire-sequencer-owns-valves`.
- **C4-6.** `RELOAD_CONFIG` → `ERR:unknown command` (reply built in `sequencer_main.cpp:177`,
  WP8's file). Frozen by `default__malformed`.

### 1.4 Target TUs

The header `SequencerService.hpp` is **not edited** in either pass (layout, member order and
therefore construction/destruction order unchanged). All four TUs define members of the one class.

| TU | contents (current lines) | approx. lines |
|---|---|---|
| `SequencerService.cpp` | 1-25, 55-137, 569-993, 1170-1243, closing namespace | ~610 |
| `SequencerService_config.cpp` | 139-567 (`readFile`, `loadConfig`, `configDir`, `resolveDataPath`, `applyConfig`) | ~455 |
| `SequencerService_controller_notify.cpp` | 35-39, 995-1114 (`notifyControllerFire`, `notifyControllerFireOnce`) | ~150 |
| `SequencerService_elodin.cpp` | 27-33, 41-53, 1116-1168, 1245-1293 (`publishState`, `publishStateTransition`, `tryConnectElodin`, `start/stopElodinRetry`) | ~150 |

Public interface: unchanged (`init`, `transitionTo` x4, `setDebugMode`, `manualActuator`,
`extendFire`, `scriptStatusReport`, `currentState`, `isDebugMode`). No new types.

File-statics each have exactly one using TU, so no shared internal header is needed:
`now_ns`, `VTABLE_*`, `SequencerStateMsg`, `StateTransitionMsg` → `_elodin`;
`kControllerConnectTimeoutMs` → `_controller_notify`; `readFile`, `resolveDataPath` → `_config`.
**Move, never copy**: a `static` function or `static constexpr` left in a TU that no longer uses it
is a `-Wunused-function` / `-Wunused-const-variable` warning, which the gate's warning baseline
(D4) turns red.

### 1.5 Ownership and data flow after the split

Unchanged: all state stays on the one object; which thread runs which member is identical. The
only new fact is that some lock-holding call chains cross TUs: `doTransitionTo` (core) →
`publishState` (`_elodin`) at 705, 727 (C4-1), 759, 776, 933; `doSetDebugMode` (core) →
`publishState` 952; `init` (core) → `tryConnectElodin`, `startElodinRetry`, `publishState`;
`HoldTimer` on the worker or the timer thread → `notifyControllerFire` (`_controller_notify`);
`applyConfig` (`_config`) writes the fields `doTransitionTo` and `notifyControllerFireOnce` read,
before the worker exists.

### 1.6 Error handling as today

`init` returns false (sequencer_main prints "[Sequencer] Initialization failed", exits 1) on: a
transitions CSV that does not load (223-226), an actuator CSV that does not load (236-238), an
unresolvable DAQ NIC (246-247), an invalid `[server_heartbeat].broadcast_ip` (259-261). A missing
config is non-fatal (171-176). Elodin down is non-fatal (593-596). Refusals return false with a
`refusal_reason` the TCP layer prints verbatim after `ERR:`: `unknown state`, `state is not
holdable`, `duration not permitted for this state`, `duration exceeds max (<max_ms> ms)`, the
stored `refused_states_` text, `PressureFeed::explain(role, status)`, `transition rejected`,
`debug mode required`. Commands that throw are logged ("command threw: …" / "an unknown
exception") and the promise is still fulfilled (94-105). Every refusal republishes state
(705, 727, 759, 776). `notifyControllerFire`: one retry, then the "❌ controller_service did not
acknowledge …" line; never blocks the transition beyond 2 x (300 ms connect + 300 ms recv).

All of this moves verbatim; the split adds no error path.

---

## 2. ActuatorCommander

### 2.1 Current responsibilities (`ActuatorCommander.cpp`)

| lines | what |
|---|---|
| 1-26 | includes (incl. `DiabloPacketUtils.h`), `namespace sequencer {` |
| 28-41 | `ActuatorCommandedMsg`; `static actuator_elodin_low_byte` (slot rule `board_id % 10`, 0 → 10) |
| 43-50 | `static trimVal` |
| 52-55 | `static toLower` |
| 57-64 | `setDefaultBindAddress` |
| 66-257 | `load`: config, bind address/port, board IP map with `192.168.2.N` fallback, roles, positions CSV (fallback list 122-129), delays CSV (188-251) |
| 259-274 | `findStateActuators` (case-insensitive) |
| 276-390 | `sendUDP`, `sendBatch`: serialize per board, socket, `SO_SNDTIMEO` 100 ms, `bind(bind_addr_)`, 3 interleaved rounds with `usleep(1000)` between |
| 392-611 | `applyForState`: snapshot script positions, resolve under `overrides_mutex_`, generation bump on transition, stage split, `emit` lambda, stage 0 inline, detached stage thread with 1 ms polling |
| 613-666 | `startContinuousLoop` (republish: 100 x 10 ms slices, 655-656), `stopContinuousLoop` |
| 668-716 | `delayForRole`, `positionsForState`, `sendSingleActuator` |
| 718-792 | overrides, `logOverrideShadowingScript` (function-local static mutex + set), script positions |
| 794-827 | `publishCommandedState` ([0x32/0x35, ch]), `publishInitialState` |

### 2.2 Shared state

| primitive | guards |
|---|---|
| `overrides_mutex_` | `manual_overrides_` |
| `script_positions_mutex_` | `script_positions_` |
| `pending_roles_mutex_` | `pending_roles_` |
| `schedule_gen_` atomic | stage cancellation |
| `loop_running_` atomic | republish loop |
| `logOverrideShadowingScript`'s local `static std::mutex mtx` | its `said` set |
| unguarded, set before threads | `roles_`, `state_actuators_`, `state_actuator_delays_`, `bind_addr_`, `actuator_port_`, `fire_state_`, `loop_state_` (written before the loop thread starts) |
| `elodin_` raw pointer | set by `setElodinClient` (from `init` or the sequencer's retry thread) while loop/stage threads read it — an existing unsynchronised write; keep, report only |

No two of the three mutexes are ever held together (header 202-206; `applyForState` 423-458,
`emit` 513-522, `setScriptPosition` 769-781). Keep it that way.

### 2.3 Target TUs

Header unchanged in both passes (see §7: `char_ac_private.cpp` reads its private members).

| TU | contents | approx. lines |
|---|---|---|
| `ActuatorCommander.cpp` | 1-41, 43-45 banner, 52-55 (`toLower`), 259-274, 392-829 | ~505 |
| `ActuatorCommander_load.cpp` | 46-50 (`trimVal`), 57-257 | ~225 |
| `ActuatorCommander_udp.cpp` | 276-390 (`sendUDP`, `sendBatch`) | ~130 |

`toLower` is used by `findStateActuators`, `sendSingleActuator`, `setManualOverride` (all core) and
not by `load`; `trimVal` only by `load`; `actuator_elodin_low_byte` only by core functions. One TU
each, no shared header.

### 2.4 Error handling and observables

`load` returns false for an unopenable positions CSV ("Cannot open state_machine_actuators.csv") or
an empty one; missing delays file means no delays; a non-numeric delay cell is ignored. `sendBatch`
logs `create_actuator_command_packet returned 0 for <ip>`, `bad board IP <ip>`, `socket() failed`,
`bind(<addr>) failed`, `sendto(<ip>:<port>) round <n> failed` and returns false; `emit` logs `Sent
<n> commands for state <s>[ (+<d>s)]` or `UDP send failed for state <s>`. Unchanged by the move.

Must not change: packet bytes (via `daq::create_actuator_command_packet`), 3 rounds with the
interleaving order "round 1 to all boards, then 2, then 3", `usleep(1000)` between rounds,
`SO_SNDTIMEO` 100 ms, one socket per batch, map iteration order (by board IP string), the republish
period (100 x 10 ms; D34 is about this loop), stage poll 1 ms, the staging/generation logic, the
precedence manual > script > CSV, `is_fire && is_pwm` skip (C4-4).

---

## 3. ControllerService

### 3.1 Current responsibilities (`ControllerService.cpp`)

| lines | what |
|---|---|
| 1-39 | includes (incl. `db.hpp`), `using namespace vtable; using namespace vtable::builder;` (35-36), namespaces |
| 41-62 | PWM wire format comment and constants (`PACKET_TYPE_PWM 10`, `COMMS_VERSION 0`, sizes 20/33) |
| 64-183 | ctor, dtor (`stop`, close socket), `initialize` (socket + `bindToDaqInterface`, logs, Elodin publisher + `registerControllerTables`, `connectSubscriber`, DDP init, LUT, thrust curve, default measurement) |
| 185-228 | `start` (controller thread, then subscriber thread), `stop` |
| 230-381 | setters, `setFireActive` (gate check, `fire_active_.exchange`, open command via test duty / LUT / DDP, close command, [0x44] publish), `setTestDuty`, getters |
| 383-530 | `sendPWMCommand`, `sendPWMCommands`, `sendActuationPWM` (one packet if same board) |
| 532-752 | `controllerLoop` |
| 754-915 | `connectSubscriber`, `elodinSubscriberLoop`, `subscriberReadLoop` (parity fallback on [0x50,0x00], calibrated PT → measurement) |
| 917-1107 | `static send_msg<T>` (921-927), `registerControllerTables`, `writeActuationToDB`, `writeDiagnosticsToDB`, `writeMeasurementToDB` |
| 1109-1157 | `loadThrustCurve`, `interpolateThrustCurve` |

### 3.2 Threads and shared state (controller process)

| thread | runs |
|---|---|
| main | control server (`controller_main.cpp`, WP8) |
| connection threads (<= 64) | `setFireActive` on `FIRE_START`/`FIRE_STOP` |
| `controller_thread_` | `controllerLoop` at `loop_rate_hz` |
| `elodin_subscriber_thread_` | reconnecting subscriber; calls `setFireActive` (parity) and writes the measurement |

| primitive | guards |
|---|---|
| `input_mutex_` | `current_meas_`, `current_cmd_`, `current_nav_`, `has_measurement_` |
| `output_mutex_` | `last_actuation_`, `last_diagnostics_` |
| atomics | `running_`, `fire_active_`, `fire_gate_enabled_`, `test_duty_fuel_/ox_` |
| unguarded | `fire_start_time_` (written by `setFireActive` on a TCP or subscriber thread, read by `controllerLoop`: an existing data race, keep and report); `elodin_client_` used by the loop and by `setFireActive` (relies on `ElodinClient::publish_mutex_`); `udp_socket_fd_` (`sendto` from two threads); `elodin_connected_` (set once in `initialize`, never on reconnect) |

`input_mutex_` and `output_mutex_` are never nested; `setFireActive` releases `input_mutex_` before
`sendActuationPWM` and before the [0x44] publish (353-358).

Known defect C4-5 (keep): the loop reads `fire_active_` at 699 and can send one more test-duty PWM
after `setFireActive(false)` sent its zero (N7b drops it from the golden). The CR, wrong-cause reply
and >3 s SIGTERM exit parts of C4-5 live in `controller_main.cpp` (WP8) and in the blocking
subscriber read the move does not touch.

### 3.3 Target TUs

Header unchanged. All three TUs go into `fsw_daq_lib` (`lib/CMakeLists.txt` `FSW_SOURCES`, after
`src/control/ControllerService.cpp` at line 41).

| TU | contents | approx. lines |
|---|---|---|
| `ControllerService.cpp` | 1-39, 64-381, 532-752, 1109-1160 | ~630 |
| `ControllerService_pwm.cpp` | 41-62, 383-530 | ~190 |
| `ControllerService_elodin.cpp` | 754-1107 (incl. `send_msg`) | ~390 |

`interpolateThrustCurve` and every double-precision step of the control path stay in the core TU
with their callers (`setFireActive`, `controllerLoop`), so inlining and FMA contraction (D22) see
the same code. `sendActuationPWM`'s clamp-and-cast moves with the senders; it has no fused
operation. The PWM duty floats are on the wire (`packets/golden/service_pwm.txt`).

`using namespace vtable; using namespace vtable::builder;` is copied into **both** the core and
`_elodin` TU in the move-only pass (so name lookup in the core TU is unchanged), and removed from
the core TU in cleanup after a clean build proves it unused. If WP3 has already replaced `send_msg`
with `lib/include/elodin/SendMsg.hpp`, the include moves instead of the template.

### 3.4 Observables

PWM bytes (type 10, version 0 hard-coded — B4 is parked; system-clock ms timestamp; 20/33-byte
layouts; one packet when both targets share a board), the gate funnel, the [0x40]-[0x44] VTables,
component and entity names and their registration order (`elodin/golden` section
`controller_service`), the subscribe set (100 calibrated-PT tables then [0x50,0x00]),
`setFireActive` log lines including "FIRE close command sent (duty=0)" (CTL_FACTS), loop log
sampling (`tick % 10/50/100`), subscriber retry 20 x 100 ms, 1 ms read back-off.

---

## 4. daq_bridge_main.cpp

### 4.1 Current responsibilities

| lines | what |
|---|---|
| 1-28 | includes |
| 30-47 | anonymous namespace: `SERVER_HEARTBEAT_PACKET_TYPE`, `build_server_heartbeat_packet` (7 bytes, `DIABLO_COMMS_VERSION`) |
| 49-90 | anonymous namespace: `class BackendLogForwarder` (all members inline) |
| 91 | close namespace |
| 92-104 | more includes |
| 106-111 | `std::atomic<bool> running`, `signal_handler` (prints from the handler) — WP8 |
| 113-149 | `BoardType` alias, `struct BoardConfig`, `struct ServerHeartbeatConfig`, `BoardByOctet`, `static ipv4_host_octet` |
| 151-232 | `static load_board_map_from_config` (default args; prints `[Config] WARN: loopback host octet …` to stderr) |
| 234-280 | `static discovery_board_type_to_enum`, `static config_board_type_to_wire_u8` |
| 282-305 | `static resolve_board_config_by_source_ip` |
| 307-339 | `main`: positional argv (`config bind_address bind_port`), banner, hard-fail on missing config (exit 1) |
| 341-344 | signals, `SIGPIPE` ignored — WP8 |
| 346-424 | board map load (C2-12: `std::invalid_argument` → "FATAL: …", exit 1), C1-12 port override, NIC resolve (exit 1), routing-table print 383-418, system mode |
| 426-551 | FSW config manager (UDP 5008; exit 1 on failure), discovery (`popen` of `ip`), sensor pipeline (exit 1 if not ready), log forwarder, broadcast, proactive SENSOR_CONFIG (C6-1), router + inline calibration |
| 553-606 | Elodin connect + first registration (578-592) + 1500 ms drain |
| 608-1067 | single-threaded main loop: SERVER_HEARTBEAT 629-640, idle path 642-778 (environmental, heartbeat/discovery/config push, logs, 500 µs sleep, drain, 5 s reconnect + re-registration 749-775), routing 780-814, self-test publish 816-883, raw batch 885-989, time-sync log 993-1008, stats 1010-1066 |
| 1069-1074 | shutdown log, `return 0` |

Threads: one (plus the signal handler). No mutex. Library objects it drives
(`BoardDiscovery`, `FSWConfigManager`, `SensorFramePipeline`, `HeartbeatRouter`) start no threads.

### 4.2 Registration duplicate (cleanup target, not move-only)

| step | first connect 578-592 | reconnect 759-773 |
|---|---|---|
| `register_tables` | return checked, logs "⚠️  RAW VTable registration failed" | ignored |
| `register_calibrated_tables` | — | — |
| `register_ball_valve_tables` (if `bv_boards` non-empty) | return checked, logs "⚠️  Ball valve RAW VTable registration failed" | ignored |
| `register_heartbeat_tables`, `register_environmental_tables`, `register_self_test_tables` | — | — |
| before | "✅ Connected to Elodin database" | `elodin_connected = true`, "✅ Reconnected to Elodin — re-registering VTables" |
| after | 1500 ms drain (20 ms sleeps), "[Elodin] Drain complete, ready for TABLE data" | nothing |

### 4.3 Target files

Move-only:

| file | contents |
|---|---|
| `daq_bridge/daq_bridge_main.cpp` | 1-47, 91 (anonymous namespace now holds only the heartbeat builder), 92-111, 307-1074 (~835 lines) |
| `daq_bridge/BackendLogForwarder.hpp` (header-only) | 49-90 verbatim, `#pragma once`, its includes (`<arpa/inet.h>`, `<netinet/in.h>`, `<sys/socket.h>`, `<unistd.h>`, `<cstring>`, `<cstdint>`, `<string>`, `<vector>`). Leaves the anonymous namespace; global namespace like today's other daq_bridge types. No `.cpp`: the class is all inline today, and splitting it would be an edit, not a move. |
| `daq_bridge/BoardMap.hpp` | `BoardType` alias, `BoardConfig`, `ServerHeartbeatConfig`, `BoardByOctet`, declarations of the five functions with `load_board_map_from_config`'s default arguments. Includes `<cstdint>`, `<map>`, `<string>`, `config/LoadActiveBoards.hpp`, `time/BoardClockSync.hpp`. |
| `daq_bridge/BoardMap.cpp` | 139-305 bodies, `static` removed (external linkage), defaults removed from the definition. Includes `<cstdlib>`, `<fstream>`, `<iostream>`, `config/Config.hpp`, `fsw/BoardTypeWire.hpp`, `"BoardMap.hpp"`. |

Global names `BoardConfig` / `ServerHeartbeatConfig` coexist with `fsw::config::BoardConfig` /
`fsw::config::ServerHeartbeatConfig` (`Config.hpp:35, 222`) only because nothing in daq_bridge
says `using namespace fsw::config`; keep it so. Putting them in a `daq_bridge` namespace is not
done (it would need a second harness edit, §7.3, for no behaviour).

Cleanup (brings `daq_bridge_main.cpp` under 700):

| new | from | users |
|---|---|---|
| `daq_bridge/TableRegistration.{hpp,cpp}`: `void registerAllTables(fsw::elodin::ElodinClient&, const ActiveBoards&…, const std::vector<uint8_t>& config_board_ids, bool report_failures)` | 578-592, 759-773 | 2 |
| `print_board_routing_table(...)` in `BoardMap.cpp` | 383-418 | 1 (split of `main`) |
| `daq_bridge/ElodinPublish.{hpp,cpp}`: `publish_self_tests(...)`, `publish_raw_batch(...)` | 816-883, 885-989 | 1 each (split of `main`) |

`registerAllTables` calls the six registrations in the order above and, when `report_failures`,
prints the two warnings **at the point each registration returns**, as today (logging after all six
would move the warning relative to the `DatabaseConfig` functions' own output). The connect/reconnect
logs, `elodin_connected = true`, and the drain stay at their call sites. The extracted publish
functions take every local they use by reference (`elodin_client`, `publishing`, `effective_cfg`,
`board_map`, `discovery`, `source_ip`, `receive_timestamp_ns`, `clock_sync`, counters) and keep the
statement order, the `begin_batch`/`flush_batch`/drain sequence and the counter increments exactly.
Nothing else in `main` moves.

### 4.4 Observables

Exit codes: 1 for missing config, `std::invalid_argument` from the config (C2-12), NIC resolution
failure, FSW manager init failure, pipeline not ready; 0 after the loop. Startup log up to
`[System] Mode` byte for byte (`config/golden/bin/daq_bridge`); "Listening for DiabloAvionics
packets", "Proactive SENSOR_CONFIG sent to N sense boards" (C6-1), "[DAQ Bridge] Shutdown complete"
(lifecycle). SERVER_HEARTBEAT bytes and `interval_ms` gating; log envelope bytes
(`packets/golden/service_daq_bridge.txt`); raw table ids (`0x20 PT, 0x30 ACT, 0x23 LC, 0x21 TC,
0x22 RTD, 0x24 ENC, 0x33 BV`, low byte `(slot-1)*0x20 + ch`), [0x25, board] environmental,
[0x60+sensor, board] self-test with the board-id fallback ladder, unknown IP treated as PT; the
registration stream (`elodin/golden` section `daq_bridge`, 1559 packets on config_base); 500 µs idle
sleep, 5 s reconnect, 1500 ms drain, 2 s stats; port 5008; C1-12 and C6-3 (`send_from_daq_bridge`
fixed at startup) unchanged.

---

## 5. Naming

- New TUs use `<Class>_<aspect>.cpp` as BLOAT-MAP WP10 names them:
  `SequencerService_config.cpp`, `SequencerService_controller_notify.cpp`,
  `SequencerService_elodin.cpp`, `ActuatorCommander_load.cpp`, `ActuatorCommander_udp.cpp`,
  `ControllerService_pwm.cpp`, `ControllerService_elodin.cpp`. daq_bridge files are named for what
  they hold: `BoardMap`, `BackendLogForwarder`, `TableRegistration`, `ElodinPublish`.
- No identifier is renamed in the move-only pass. In cleanup, the only new identifiers are
  `registerAllTables`, `print_board_routing_table`, `publish_self_tests`, `publish_raw_batch`
  (snake_case like the file's other free functions except `registerAllTables`, which BLOAT-MAP and
  the LEDGER already name).
- Private members of `ActuatorCommander` (`bind_addr_`, `bind_addr_explicit_`, `actuator_port_`,
  `roles_`) and the `ActuatorRole` fields are not renamed in either pass (§7.2).

---

## 6. The move-only pass (one package, merged alone), then cleanup

### 6.1 Move-only steps

General rules for every step: cut whole top-level definitions with their leading comment blocks and
section banners; paste them in the same relative order; open/close the same namespace; copy the
source file's **entire include block** (and, for ControllerService, the two `using namespace`
lines) verbatim into each new TU, pruning nothing; move file-statics to the one TU that uses them;
headers `SequencerService.hpp`, `ActuatorCommander.hpp`, `ControllerService.hpp` untouched; run
`clang-format -i` (19.1.7) on new and edited files only. Review with
`git diff -M --color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change`: every non-dimmed
line must be an include, a namespace line, a removed `static`/default argument (daq_bridge only) or
CMake.

1. **SequencerService.** Create `services/sequencer/SequencerService_config.cpp` (lines 139-567),
   `SequencerService_controller_notify.cpp` (35-39, 995-1114), `SequencerService_elodin.cpp`
   (27-33, 41-53, 1116-1168, 1245-1293). Anchors: `grep -n '^static\|^bool SequencerService::\|^void SequencerService::\|^std::string SequencerService::\|^ScriptEnv' SequencerService.cpp`.
2. **ActuatorCommander.** Create `services/sequencer/ActuatorCommander_load.cpp` (46-50, 57-257)
   and `ActuatorCommander_udp.cpp` (276-390).
3. **ControllerService.** Create `lib/src/control/ControllerService_pwm.cpp` (41-62, 383-530) and
   `ControllerService_elodin.cpp` (754-1107; `using` lines copied).
4. **daq_bridge + harness, one commit.** Create `BackendLogForwarder.hpp`, `BoardMap.hpp`,
   `BoardMap.cpp` as §4.3; `daq_bridge_main.cpp` includes `"BackendLogForwarder.hpp"` and
   `"BoardMap.hpp"`. In the **same commit**: the `char_config_services.cpp` include change (§7.3)
   and the `test/characterization/config/CMakeLists.txt` edit (§7.2 `char_config_dump` sources and
   §7.3 `target_sources(char_cfg_daq_bridge …)`). Because that CMake edit also names the
   ActuatorCommander TUs, step 2's ActuatorCommander split is part of this same commit (otherwise
   `char_config_dump` does not build in between). No other commit touches harness files.
5. **CMake.**
   - `diablo_server/CMakeLists.txt` (not in BLOAT-MAP's WP10 file list; the package claims it),
     before `add_subdirectory(lib)`:
     ```cmake
     set(SEQ_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/services/sequencer)
     set(ACTUATOR_COMMANDER_SOURCES
         ${SEQ_SRC_DIR}/ActuatorCommander.cpp
         ${SEQ_SRC_DIR}/ActuatorCommander_load.cpp
         ${SEQ_SRC_DIR}/ActuatorCommander_udp.cpp)
     set(SEQUENCER_SOURCES
         ${SEQ_SRC_DIR}/SequencerService.cpp
         ${SEQ_SRC_DIR}/SequencerService_config.cpp
         ${SEQ_SRC_DIR}/SequencerService_controller_notify.cpp
         ${SEQ_SRC_DIR}/SequencerService_elodin.cpp
         ${SEQ_SRC_DIR}/StateMachine.cpp
         ${ACTUATOR_COMMANDER_SOURCES}
         ${SEQ_SRC_DIR}/AbortBroadcaster.cpp
         ${SEQ_SRC_DIR}/HoldTimer.cpp
         ${SEQ_SRC_DIR}/ScriptStates.cpp
         ${SEQ_SRC_DIR}/ScriptRunner.cpp
         ${SEQ_SRC_DIR}/PressureFeed.cpp)
     ```
     (same order the targets list today).
   - `services/CMakeLists.txt` `sequencer_service` (14-24): `sequencer/sequencer_main.cpp
     ${SEQUENCER_SOURCES}`.
   - `lib/CMakeLists.txt`. Users, correctly counted: **6 SequencerService test executables plus 4
     ActuatorCommander-only test executables, plus the `sequencer_service` executable** (the
     LEDGER's "8 targets" is wrong). The SequencerService users —
     `test_sequencer_elodin` (254), `test_hold_rules` (276), `test_script_states` (299),
     `test_script_runtime` (325), and the `foreach` pair `test_sequencer_concurrency` /
     `test_abort_ordering` (406-424): replace their eight sequencer source lines with
     `${SEQUENCER_SOURCES}`. The ActuatorCommander-only users — `test_fire_lifecycle` (149),
     `test_actuator_delays` (203), `test_script_positions` (223), `test_ball_valve_commander`
     (239) — replace their `ActuatorCommander.cpp` line with `${ACTUATOR_COMMANDER_SOURCES}`.
     `FSW_SOURCES`: add `src/control/ControllerService_pwm.cpp` and
     `src/control/ControllerService_elodin.cpp` after line 41.
   - `daq_bridge/CMakeLists.txt`: `add_executable(daq_bridge daq_bridge_main.cpp BoardMap.cpp)`.
   - Harness CMake (`test/characterization/config/CMakeLists.txt`), §7.2/§7.3: in step 4's commit
     only (D18 extension above).
6. **Verify** (all port-binding runs under `with_stack_lock.sh`, subsets only, D23/D36): clean build,
   no new warning vs `baseline_warnings.txt`; `ctest -R
   'actuator_delays|script_positions|ball_valve_commander|fire_lifecycle|hold_rules|script_states|script_runtime|sequencer_concurrency|abort_ordering|controller_pwm_roles|robust_ddp|characterization_config_cpp'`;
   `CHAR_AREAS=sequencer,config,lifecycle,packets,elodin,pipeline`;
   `linux_gate.sh --areas sequencer,config,lifecycle,packets,elodin,pipeline <rev>`; a CI run
   (D34: required for any WP touching the sequencer). `t7_integration` is in the verify list too,
   **judged on CI only** (D34: the local Linux leg inherits this Mac's timer overshoot); it runs
   the stack against `fsw_daq_lib`, which gains the two ControllerService TUs. `actuator_delays`,
   `script_positions` and `script_runtime` are likewise CI-only (D34), and D31's 10× rule applies
   to any of them that needs a retry. The full gate is the orchestrator's.

### 6.2 Cleanup pass (second package)

- Prune each new TU's includes to what it uses; drop `using namespace vtable…` from the core
  ControllerService TU.
- daq_bridge: `registerAllTables`, `print_board_routing_table`, `publish_self_tests`,
  `publish_raw_batch` (§4.3). Only after the reconnect characterization in §7.4 exists.
- Optional adoptions of WP8 helpers only under the conditions in §0.
- Not in cleanup (parked or forbidden): fixing C4-1/C4-2/C4-3/C1-10/C4-4/C4-5/C6-1/C6-3/C1-12;
  replacing the republish 10 ms slices with a condition variable (comment at
  `ActuatorCommander.cpp:652-654` already defers it; it changes timing); B4 encoders; unifying
  `toLower`/`trimVal`/`trim` across files; the `fire_start_time_` and `elodin_` pointer races.

### 6.3 Must not change (both passes)

| surface | where frozen |
|---|---|
| actuator UDP bytes, order, destination board, retransmit count 3, `usleep(1000)` rounds | `sequencer/golden/*` (N2, board per line), `actuator_delays`, `ball_valve_commander` |
| abort broadcast: ABORT first, 2 x 4 repeats, ABORT_DONE after 3000 ms (60 x 50 ms), CLEAR_ABORT never sent | `packets/golden/service_abort.txt`, sequencer `first datagram:` |
| stage delays from the CSV, generation semantics incl. C4-3 | sequencer N4 bounds, `default__aborts`, `actuator_delays` |
| republish period 100 x 10 ms and `defer_first_pass` | sequencer N5 `[0.8, 1.5] x 1 s`, `script_positions`, `script_runtime` |
| PWM bytes, version 0, same-board single packet | `packets/golden/service_pwm.txt`, `sequencer/golden/controller__*`, `default__fire-*` |
| TCP replies (built in mains, reasons from SequencerService): `OK\n`, `OK:<ms>\n`, `ERR:<reason>\n`, `ERR:unknown command\n`, `ERR:too many connections\n`, `ERR:not in FIRE state\n`, `SCRIPT:<id>:<name>:OK:<n>:<ms>` / `:REFUSED:<why>` / `:BLOCKED:<why>`, `END\n`; controller `OK\n`, `ERR\n`, `ERR:fire gate disabled (sequencer owns the valves)\n` | `default__malformed`, `default__holds`, `digital-twin__scripts-load`, `controller__*` |
| timing constants: `kCommandTimeoutSeconds` 10, `kControllerConnectTimeoutMs` 300, `SO_SNDTIMEO` 1 s (sequencer TCP) and 100 ms (actuator UDP), `kElodinRetrySeconds` 5 in 100 ms slices, `kAbortDoneDelayMs` 3000, hold rounding `d*1000+0.5`, controller retry 20 x 100 ms, 1 ms read back-off, daq_bridge 500 µs / 5 s / 1500 ms / 2 s | sequencer N4/N5, `hold_rules`, lifecycle bounds; constants not all individually frozen (gap §7.4) |
| Elodin: [0x50,0x00] 17-byte layout, [0x43,0x00], ACT_CMD [0x32/0x35, slot-encoded ch], controller [0x40]-[0x44], daq_bridge raw/calibrated/heartbeat/env/self-test tables, registration order | `elodin/golden/schema_*.txt` (startup only), `pipeline/golden/*` |
| SERVER_HEARTBEAT bytes, log envelope, SENSOR_CONFIG push (C6-1: none) | `packets/golden/service_daq_bridge.txt`, lifecycle `startup`, `hbloss` |
| exit codes: sequencer 1 on init failure / 0 on stop; daq_bridge as §4.4; controller as `controller_main.cpp` | lifecycle `shutdown` (daq_bridge only; gap for the other two) |
| startup order (§1.1, §3.1, §4.1) | sequencer N6 load-time lines, `config/golden/bin/daq_bridge`, schema order |
| log lines read by tests: SEQ_LOAD prefixes and SEQ_FACTS / CTL_FACTS phrases (`char_sequencer.py:349-372`), daq_bridge "Listening for DiabloAvionics packets", "Proactive SENSOR_CONFIG sent to", "[DAQ Bridge] Shutdown complete", startup log to `[System] Mode` | sequencer, lifecycle, config/bin |
| SIGPIPE: sequencer ignore, daq_bridge ignore, controller default | WP8's per-service setting; lifecycle `shutdown` for daq_bridge |

---

## 7. Guarding characterization

### 7.1 Coverage per part

| part | black-box goldens | ctests |
|---|---|---|
| SequencerService transitions, holds, scripts, refusals, controller notify | `sequencer/` 64 sessions (incl. C4-1, C4-3, C4-4, C4-6), `packets/service_abort.txt`, `elodin` section `sequencer`, `pipeline` (state frames) | `hold_rules`, `script_states`, `script_runtime`, `sequencer_concurrency`, `abort_ordering`, `sequencer_elodin` (integration only) |
| ActuatorCommander | `sequencer/` (bytes, board, staging, republish), `config/golden/cpp/config` section `=== ActuatorCommander` (white box, §7.2) | `actuator_delays`, `script_positions`, `ball_valve_commander`, `fire_lifecycle` |
| ControllerService | `sequencer/golden/controller__*`, `default__fire-*`, `packets/service_pwm.txt`, `elodin` section `controller_service` | `controller_pwm_roles` (resolution only), `robust_ddp` (DDP only) |
| daq_bridge | `config/golden/bin/daq_bridge`, `config/golden/cpp/daq_bridge` (white box, §7.3), `packets/service_daq_bridge.txt`, `elodin` section `daq_bridge`, `lifecycle/*`, `pipeline/*` | `test_integration.sh` |

`packets/` and `elodin/` are on `queue/C1` (f872c788), **not yet merged** on `backend-remastered` @
b2599617; WP10 depends on them being merged first (they are queued ahead of every WP).

### 7.2 `char_ac_private.cpp` (`#define private public` around `ActuatorCommander.hpp`)

Reaches: `ac.bind_addr_`, `ac.bind_addr_explicit_`, `ac.actuator_port_`, `ac.roles_` and
`ActuatorRole::{channel, board_id, board_ip, is_no, is_pwm, cmd_table_hi}`. The header is unchanged
in both passes, so the file itself needs **no edit**. Its CMake target does: `char_config_dump`
(`test/characterization/config/CMakeLists.txt:15-21`) lists
`${_DS}/services/sequencer/ActuatorCommander.cpp`; add `ActuatorCommander_load.cpp` and
`ActuatorCommander_udp.cpp` beside it (the top-level `test/characterization` scope does not see
`ACTUATOR_COMMANDER_SOURCES`, so the list stays explicit). D18 proof: `golden/cpp/config/*`
byte-identical; mutation — in `ActuatorCommander_load.cpp` change `role.is_pwm =
!r.controller_role.empty();` to `= false;` → the `role … is_pwm=` lines go red; revert. Any later
change to those member names is a harness change and out of WP10's scope.

### 7.3 `char_config_services.cpp` (`#include` of `daq_bridge_main.cpp`, `CHAR_SERVICE_DAQ_BRIDGE`)

Reaches, all from `daq_bridge_main.cpp` 113-305: `BoardType`, `BoardConfig`, `BoardByOctet`,
`ServerHeartbeatConfig`, `load_board_map_from_config` (all out-parameters),
`ipv4_host_octet`, `resolve_board_config_by_source_ip`, `config_board_type_to_wire_u8`, plus
`fsw::time::TimeSyncConfig` through the main's includes; it captures stdout/stderr around the call
(so the `[Config] WARN` line is part of the golden).

Re-pointing (move-only package, D18): in the `#elif CHAR_SERVICE_DAQ_BRIDGE` branch replace
`#include "../../../diablo_server/daq_bridge/daq_bridge_main.cpp"` with
`#include "../../../diablo_server/daq_bridge/BoardMap.hpp"`, and add after the `foreach`
`target_sources(char_cfg_daq_bridge PRIVATE ${_DS}/daq_bridge/BoardMap.cpp)`. The harness then no
longer compiles a main at all for daq_bridge (closer to D20). The stacklight and config_broadcast
branches need no edit (DESIGN-WP8 §7.3). Proof: `golden/cpp/daq_bridge/*` and `golden/bin/daq_bridge/*` byte-identical;
the area's recorded mutations re-run; one new mutation — in `BoardMap.cpp` change `if (octet >= 2)`
in `load_board_map_from_config` to `>= 3` → `board_by_octet[…]` and `resolve("127.0.0.2…")` lines
go red; revert. Orchestrator reviews the harness diff. If the cleanup moves
`print_board_routing_table` into `BoardMap.cpp`, the harness is unaffected (it does not call it).

### 7.4 Gaps

1. **Re-registration after an Elodin restart is not frozen** for daq_bridge (759-773), the
   sequencer (`tryConnectElodin` on the retry thread) or the controller (`connectSubscriber` in the
   loop). `elodin/` captures startup only; lifecycle `shutdown` only checks "still running". The
   cleanup's `registerAllTables` merges exactly this path, so a characterization case must exist
   first: restart the stand-in Elodin (`packets/bb.py FakeElodin`) and record each service's second
   registration stream (a golden that only grows, D20). This gap gates **only cleanup's
   `registerAllTables`**; the move-only pass does not depend on it (the reconnect code moves
   verbatim).
2. Sequencer and controller **exit codes and SIGTERM latency**: **closed by DESIGN-WP8 gap 2**,
   which must merge before WP8 pass 1 and therefore before WP10. C4-1's "SIGTERM does not exit"
   stays documented (the gap 2 case runs without a refused dynamic state); C4-5's ">3 s exit" is
   asserted as a bound there.
3. Controller TABLE rows ([0x40]-[0x44] data), LUT- and DDP-driven duties and the thrust curve are
   not characterized; only test duty and FIRE_START/STOP are. A float change there would not go red.
4. C4-2's double fire is avoided, not frozen (the session lands where the second transition is
   refused; only `[HoldTimer]` counts are frozen). C4-5's straggler is dropped by N7b.
5. ActuatorCommander failure paths (bind failure, bad board IP, short send) have no golden.
6. daq_bridge stats/time-sync log text and the discovery fallback (unknown IP → PT, discovered
   type) are not frozen; pipeline C5b covers board types via configured IPs only.
7. Timing constants are frozen only as bounds (N4/N5, lifecycle); a constant changed within its
   bound is not caught. The move-only pass changes none, by construction.

---

## 8. Risks

- **Concurrency.** The split changes no thread, lock or call order; the risk is an "obvious" fix
  slipping in. Specifically forbidden: touching the C4-1 scope (716-730) or `publishState`'s lock;
  merging the two `triggerAbort` calls (C1-10); changing `is_transition=!isAbortState(to)` (C4-3);
  removing either timeout of C4-2; nesting any two ActuatorCommander mutexes; moving
  `notifyControllerFire` off the thread that calls it today. TSan (CI job) must stay green with no
  new suppressions; the pre-existing unsynchronised `fire_start_time_` and `ActuatorCommander::elodin_`
  are reported, not fixed.
- **Static initialization.** None of the moved TUs has a namespace-scope object with dynamic
  initialization (`daq_bridge`'s `running` is constant-initialized; `logOverrideShadowingScript`'s
  statics are function-local and stay in one TU). No static-init-order hazard is introduced; keep it
  so (no namespace-scope `std::string`/`std::map` constants in new TUs).
- **ODR and linkage.** File-statics move, never copy (also the warning gate). daq_bridge's helpers
  gain external linkage in the global namespace; they are linked only into `daq_bridge` and
  `char_cfg_daq_bridge`. `BackendLogForwarder` leaves its anonymous namespace; no other definition
  of that name exists in the tree. ControllerService's new TUs are in the shared `fsw_daq_lib`;
  their symbols are members already declared in the header, so the library exports the same set.
- **Float/inlining (D22).** All control-path arithmetic stays in the TU with its callers (§3.3).
- **Timing tests (D31, D34).** On this Mac `sleep_for(10 ms)` overshoots ~3.5 ms, so the
  republish (100 x 10 ms) runs ~1.35 s: `actuator_delays` and `script_positions` fail
  deterministically here, and the local Docker Linux leg fails `script_runtime`; those three are
  judged on CI only. `sequencer_concurrency` is on the Darwin baseline (passes on Linux). The
  sequencer characterization's republish bound is 1.5 x 1 s, uncomfortably close to 1.35 s: a red
  sequencer session whose only diff is a republish interval is checked against the same run on the
  pre-WP tip before it is blamed on WP10. D31: if any of `actuator_delays`, `script_positions`,
  `script_runtime`, `sequencer_concurrency` needed a retry, run it 10x alone (Linux) on the WP and
  on the pre-WP tip; WP10 is not done unless its pass rate is no worse.
- **Harness drift.** Two harness edits (§7.2 CMake, §7.3 include + CMake), each with goldens
  byte-identical and a mutation that goes red; nothing else under `test/characterization/` changes,
  and no golden line is removed.

## Open questions

1. (Decided: WP10 owns `diablo_server/CMakeLists.txt`.)
2. Answered by `DESIGN-WP8.md`: it gives only `openUdpSocket`/`ipv4Destination` (statement-identical
   socket creation and address fill) and no TCP-client or Elodin-loop helper. So the sequencer's
   controller-notify client and the B3 sites in these four files stay hand-written after WP10;
   only the optional `openUdpSocket` adoption in cleanup remains.
3. Who adds the Elodin-reconnect characterization (§7.4 gap 1)? It gates only cleanup's
   `registerAllTables`, so it can land any time before WP10's cleanup item.
4. The LEDGER's "8 CMake test targets" should read: 6 SequencerService test executables plus 4
   ActuatorCommander-only test executables, plus the `sequencer_service` executable.

---

# Amendments (design/cpp2, 2026-11-16) — alternatives, interfaces, walkthroughs

Added after the review (D39), with D42's research (`docs/remaster/research/abort-statemachines.md`,
`teststand-architecture.md`, `subscription-robustness.md`, `cpp-service-plumbing.md`) and its
binding constraints, and STYLE.md (D43, cited `STYLE-S<n>`). Nothing above is deleted; changes to
the reviewed text are marked **AMENDMENT**.

## A. Alternatives considered

| | **A. Same-class TUs by concern (§1-§6, chosen)** | B. Collaborator objects with explicit interfaces | C. Minimal: daq_bridge (+ `ActuatorCommander_udp`) only |
|---|---|---|---|
| shape | `SequencerService_{config,controller_notify,elodin}.cpp`, `ActuatorCommander_{load,udp}.cpp`, `ControllerService_{pwm,elodin}.cpp` define members of the unchanged classes; daq_bridge gets `BoardMap`, `BackendLogForwarder`, then (cleanup) `TableRegistration`, `ElodinPublish` | `SequencerConfigLoader` (returns a value), `ControllerNotifier`, `SequencerPublisher`, `ActuatorUdpLink`, `PwmLink`, `ControllerTables`, a daq_bridge `BoardRouter` class; the god classes hold them as members and call through interfaces | only `daq_bridge_main.cpp` (the one god *function*) is split; `SequencerService.cpp` (1295) and `ControllerService.cpp` (1160) stay whole; `ActuatorCommander` loses only `sendBatch` |
| clarity | concern per file; class layout, lock members and call graph unchanged; a reader still sees one class | each collaborator is small and nameable; but the C4-1 chain (`doTransitionTo` holds `config_mutex_` → `publishState` locks it again) would cross an object boundary: the publisher needs the service's private mutex or the state it guards | nothing moves in the two classes, so nothing to learn; but a 430-line `applyConfig` keeps sitting between the command queue and `doTransitionTo` |
| lines deleted | ~0 in move-only (a split); cleanup: the duplicated registration (~15), `using namespace` in the core TU | ~0, plus ~150 of interface/plumbing | ~0 / ~15 (same daq_bridge cleanup) |
| testability | unchanged; black-box goldens and the existing ctests (§7) | interfaces invite fakes, but D20 keeps goldens black-box and no ctest would be rewritten in a refactor | unchanged |
| fit with characterization | two reviewed harness edits (§7.2 CMake, §7.3 include), one commit (D18 extension) | **fails by construction**: `char_ac_private.cpp` reads `ActuatorCommander`'s private members (`bind_addr_`, `roles_`, …, §7.2) — moving them into a link object is a harness rewrite; `SequencerService.hpp`'s member order is its destruction order, which the shutdown goldens see (worker joined before the retry thread, loop and hold timer, §1.1); new members change it | smallest harness exposure (only §7.3) |
| abort paths (D42 binding 1; research abort-statemachines "Structural choices" 1-5) | both `triggerAbort` sites, the 716-730 block, the 835 call and every `publishState` call site stay in `doTransitionTo` in core `SequencerService.cpp`; `schedule_gen_`, `pending_roles_`, `applyForState`, the stage thread and `emit` stay in core `ActuatorCommander.cpp` (only `sendBatch` moves); `enqueueAndWait`/`enqueueDetached` stay together in core | an `AbortPath` collaborator is the research's own idea (teststand-architecture Idea 3(b): "make abort its own path… fixes C1-10 by construction") — which is exactly why it is a **PROPOSAL**: it changes ABORT counts and timing (`service_abort.txt`, N3a) | untouched by construction |
| float path (D22) | `interpolateThrustCurve` and every control-path double stay in the core TU with `setFireActive`/`controllerLoop` (§3.3); `sendActuationPWM`'s clamp-and-cast has no fused operation | the DDP/LUT/thrust math behind an interface → different inlining context | none |
| thread/lock risk | none: same members, same threads, same lock order; the only new fact is cross-TU call chains (§1.5) | the C4-1 re-entry and `config_mutex_ → ScriptRunner::mtx_ / PressureFeed::mtx_` order would have to be re-expressed across objects (S23: no new nesting; forbidden in §8) | none |
| timing tests (D31/D34) | every sequencer/actuator ctest recompiles; CI-only judgement for three of them | same plus behaviour risk | `ActuatorCommander_udp` alone still recompiles them; much smaller blast radius |

**Why B lost.** Two independent reasons, each sufficient: the headers cannot change (harness reads
privates; member order is destruction order), and the one place where a collaborator would help a
reader — the abort — is the place D42 binds to stay together and every improvement there is a
proposal (research abort-statemachines Ideas 1-4 all change goldens). Also STYLE-S34: each
collaborator would have one user.

**Why C lost (narrowly).** C is the safest and fully meets D42 binding 1. It loses on the one thing
WP10 exists for: `SequencerService.cpp` mixes four concerns with different threads and different
reviewers (config parsing before the worker exists; the worker's transitions; a TCP client that
runs on the hold-timer thread; an Elodin publisher shared by worker, retry thread and loop). A
separates exactly those, moves none of the abort ordering, and its move-only diff is checked by
`--color-moved` (every non-dimmed line is an include, a namespace line or CMake; D43(6): include
regrouping by clang-format is an expected non-dimmed line). If the D34 timing tests cannot be judged
on CI when WP10 is queued, C is the fallback: it is a strict subset of A's steps (§6.1 steps 2 and
4 only).

**Decision: A, as reviewed**, with these amendments:

- **AMENDMENT (D42 binding 1, research structural choice 4):** cleanup step 1 (not move-only,
  STYLE-S12/S38: a move adds no comment lines) adds above `publishState` in
  `SequencerService_elodin.cpp`:
  `// Lock contract: acquires config_mutex_ (and releases it before pressure_feed_.read and
  elodin_.publish). Callers must not hold config_mutex_ — except doTransitionTo's refused-state
  block (Kept: C4-1 (D17)).`
- **AMENDMENT (D42 binding 1, research structural choice 5; STYLE-S12):** cleanup step 1 tags every
  frozen defect site with `// Kept: <id> (D17)` and one line on why. D42 spells the tag
  `// FROZEN C4-1`; D43(4) ratified S12's `// Kept:` for WP8. One spelling for the whole tree, so
  this note uses S12's; `grep -rn 'Kept: C4-'` is the fix PR's index. Sites: C4-1
  (`doTransitionTo` refused-state block), C1-10 (both `triggerAbort` calls), C4-3 (the
  `applyForState(to, !isAbortState(to))` call; `++schedule_gen_` only on `is_transition` in
  `ActuatorCommander::applyForState`), C4-2 (the dynamic-state hold rule in `applyConfig`), C4-4
  (`is_fire && role.is_pwm` skip; `notify_controller` gate), C4-5 (`controllerLoop`'s `fire_active_`
  read), C1-12 (daq_bridge `sensor_port` override), C6-1 (proactive SENSOR_CONFIG log), C6-3
  (`send_from_daq_bridge` fixed at start-up). Open question 5 if the orchestrator wants the
  literal `FROZEN`.
- **AMENDMENT (D42 binding 1):** the single enqueue entry point is structural and stays so: every
  `do*` member is `private` (`SequencerService.hpp:187-191`), the public commands are the only
  callers of `enqueueAndWait`, and `enqueueDetached` is used only from the hold-timer and script
  threads. WP8's `serveTcpClients` reaches the service only through `handleCommandLine` →
  public methods (DESIGN-WP8 amendment A).
- **AMENDMENT (D43(2), STYLE-S1):** `registerAllTables` → `register_all_tables` (daq_bridge is
  snake_case, 0:13).
- **AMENDMENT (D42 binding 3, DESIGN-WP3 §2.5):** `register_all_tables` is the one daq_bridge
  registration site a later D-SLOT injectivity check lands in; the ids themselves come from WP3's
  `fsw::elodin::table_id_for` inside `DatabaseConfig`. Honest limit: calibration_service registers
  the calibrated tables too (`calibration_main.cpp:1483`, its own `register_calibrated` lambda, WP9
  keeps it in `main`), so a D-SLOT fix has two registration call sites across two processes, both
  through `DatabaseConfig` and therefore through one `table_id_for`. Cleanup may also adopt
  `table_id_for` where the integer expression is the same — candidates, decided at cleanup review:
  `ActuatorCommander.cpp:36-41` `actuator_elodin_low_byte` (has no hi byte at hand),
  `ControllerService.cpp:773` (base only), daq_bridge's publish `board_offset` (`daq_bridge_main.cpp`
  ~892-898, base only). None is required. For the command tables (ACT_CMD 0x32, BV_CMD 0x35)
  the offset is `TableHalf::kRaw` (0x00): integer-identical, but the name reads wrong there.
- **AMENDMENT (D42, D-PF):** WP10 does not move `PressureFeed.cpp` (it is only named in the
  `SEQUENCER_SOURCES` list). The suspected re-subscribe accumulation (`PressureFeed.cpp:118-146`,
  LEDGER D-PF) must be reproduced, and its result recorded, **before** WP10's move-only item is
  queued, so a multiplied PressureFeed stream on the WP10 tip is not blamed on the move.

## B. Interfaces

Declaration-only stubs in `docs/remaster/design-stubs/cpp/daq_bridge/` (not built). The three
class splits add **no header** (headers unchanged, §1.4, §2.3, §3.3).

| stub | pass | from |
|---|---|---|
| `daq_bridge/BoardMap.hpp` | move-only (one commit with the harness edit, §6.1 step 4) | §4.3 |
| `daq_bridge/BackendLogForwarder.hpp` | move-only; header-only today (the stub shows the class without bodies) | §4.3 |
| `daq_bridge/TableRegistration.hpp` | cleanup (after §7.4 gap 1) | §4.3, renamed per D43 |
| `daq_bridge/ElodinPublish.hpp` | cleanup | §4.3 |

`print_board_routing_table` is declared in `BoardMap.hpp` (cleanup addition, one call site).

## C. Walkthroughs

"Owner" = the module whose code performs the step and whose state or output it produces; a caller
that only causes it is a *trigger*. A step with two owners, or none, is a design smell and is
either fixed below or shown to be frozen behaviour (then it is named, not changed). Files are as
after both passes; steps 1-7 of every TCP command are DESIGN-WP8 walkthrough C.1.

### (a) A fire: sequencer state change → controller notify → actuator commands → abort broadcaster idle

Scenario: default profile, `Armed → Fire`, `sequencer_owns_valves = false` (the controller owns
the PWM roles), the controller's gate enabled, Elodin up, no previous abort pending.

| # | step | owner (file) | thread |
|---|---|---|---|
| 1 | `TRANSITION:Fire` read, parsed, `transitionTo(Fire)` → `enqueueAndWait` | `sequencer_main` / `SequencerService` core (WP8 C.1) | conn → worker |
| 2 | read the hold rule for Fire under `config_mutex_` | `doTransitionTo` (core `SequencerService.cpp`) | worker |
| 3 | validations: requested hold, refused state (the C4-1 block, not taken), script pressure roles via `PressureFeed::read`, `isAllowed` | `doTransitionTo`; `PressureFeed` (sequencer, unmoved) answers reads | worker |
| 4 | `isAbortState(Fire)` is false → **no `triggerAbort`**; AbortBroadcaster stays idle (its done thread, if a previous abort left one, keeps counting untouched) | `AbortBroadcaster` (idle) | — |
| 5 | stop script, clear manual overrides and script positions, stop the republish loop, stop any hold | `ScriptRunner`, `ActuatorCommander` core, `HoldTimer` (triggered by `doTransitionTo`) | worker |
| 6 | resolve Fire's column (manual > script > CSV), **skip `is_pwm` roles** in the fire state, bump `schedule_gen_` (`is_transition = true`), split by delay, stage 0 now | `ActuatorCommander::applyForState` (core) | worker |
| 7 | serialize per board, socket per batch, `SO_SNDTIMEO` 100 ms, bind, 3 interleaved rounds, `usleep(1000)` | `ActuatorCommander::sendBatch` (`_udp.cpp`) via `emit` (core) | worker; later stages on the detached stage thread |
| 8 | arm the hold: `hold_ms = requested + open delay − close delay`; `notify_controller = (to == fire_state_) && !sequencer_owns_valves_` | `doTransitionTo` | worker |
| 9 | `HoldTimer::start` calls `on_active(true)` **before** the clock starts | `HoldTimer` (trigger) → `notifyControllerFire(true)` | worker |
| 10 | FIRE_START over TCP: non-blocking connect + `poll` 300 ms, `SO_SNDTIMEO` 1 s, send without `MSG_NOSIGNAL` (D-SEQ; harmless, SIGPIPE ignored), `recv` ≤ 15 bytes, prefix `OK`; one retry, then the `❌ … did not acknowledge` line | `SequencerService::notifyControllerFire[Once]` (`_controller_notify.cpp`) | worker |
| 11 | controller accepts and reads the line | `serveTcpClients` + `handleControlClient` (WP8 C.2) | controller conn |
| 12 | **the PWM gate edge**: gate check, `fire_active_.exchange(true)`; on the edge compute the open command (test duty / LUT / DDP) and send it | `ControllerService::setFireActive` (core) → `sendActuationPWM` (`_pwm.cpp`) | controller conn |
| 13 | publish `[0x44,0x00]` fire state | `setFireActive` (core) through `ElodinClient` | controller conn |
| 14 | reply `OK\n` | `handleControlClient` | controller conn |
| 15 | timer thread starts counting the hold | `HoldTimer` | timer |
| 16 | 1 Hz republish of Fire's settled column (`allow_delays = false`) | `ActuatorCommander::startContinuousLoop` (core) | loop thread |
| 17 | `current_state_ = Fire`; not an abort → no second `triggerAbort` | `doTransitionTo` | worker |
| 18 | publish `[0x43,0x00]` transition and `[0x50,0x00]` state (lock taken and released before I/O) | `publishStateTransition`/`publishState` (`_elodin.cpp`) | worker |
| 19 | controller subscriber sees `[0x50]` = fire id → `setFireActive(true)` again → `exchange` returns true → **no second edge**: `if (was_active == active) return;` before any log, PWM or `[0x44]` publish (`ControllerService.cpp:258-259`) | `ControllerService` subscriber (`_elodin.cpp`) → `setFireActive` | controller subscriber |
| 20 | heartbeat/stacklight follow the new state | `follow_sequencer_state` + their mains (WP8 C.3) | follower threads |
| 21 | log `Armed → Fire`, return true → `OK` | `doTransitionTo` → `handleCommandLine` | worker → conn |
| 22 | hold expires: `on_active(false)` → FIRE_STOP (steps 10-14 with `false`, zero-duty close) **on the timer thread**; then `on_expire` → `enqueueDetached(doTransitionTo(return_state))` | `HoldTimer::runTimer` (trigger), `notifyControllerFire`, `setFireActive` | timer → worker |

Ownership check:

- **The PWM gate edge (12) has one owner, `setFireActive`, and two triggers** — the sequencer's TCP
  notify (10) and the controller's own `[0x50]` parity path (19). `exchange` makes the second a
  no-op; whichever arrives first sends the open command. This is the design today ("parity
  fallback for a missed TCP edge"), kept; the walkthrough names it so nobody removes either trigger
  thinking it is a duplicate owner.
- **Zero owner, frozen (C4-4):** with `sequencer_owns_valves = true` the PWM roles have no owner in
  Fire: step 6 still skips them, step 8 arms no notifier, and the controller refuses
  (`ERR:fire gate disabled …`). Kept and tagged (amendment above); it is
  `default__fire-sequencer-owns-valves`.
- Step 4: the abort broadcaster is idle because nothing triggers it, not because something stops
  it; it needs no owner in a fire.
- Steps 7 and 16 both send actuator UDP for Fire, from different threads, with one owner
  (`ActuatorCommander`): the first is the transition batch, the second the republish; the stage
  generation keeps the republish from cancelling pending stages (§2.4).

### (b) An abort (C1-10's double `triggerAbort` preserved)

Scenario: during the Fire hold of (a), the operator sends `TRANSITION:Engine Abort`.

| # | step | owner (file) | thread |
|---|---|---|---|
| 1 | read, parse, `transitionTo(Engine Abort)` → `enqueueAndWait` — **FIFO behind anything already queued**; no priority lane (research abort-statemachines Idea 2: a PROPOSAL) | WP8 C.1; `SequencerService` core | conn → worker |
| 2 | validations (no hold rule; not refused; allowed) | `doTransitionTo` (core) | worker |
| 3 | `entering_abort` → **`triggerAbort()` #1**: 4 × ABORT at once on a per-send socket (`openUdpSocket(true)` after WP8, `SO_SNDTIMEO` 100 ms), then under `done_thread_mutex_` cancel any old done thread and start one (3000 ms in 50 ms slices) | `AbortBroadcaster` (trigger: `doTransitionTo`, `// Kept: C1-10`) | worker; done thread |
| 4 | stop script, clear overrides, stop republish loop | as (a) 5 | worker |
| 5 | `hold_timer_.stop()`: the fire hold is active → `on_active(false)` → **FIRE_STOP** to the controller (zero-duty close, `[0x44]`) — on the worker, delaying the valve batch, not the ABORT packet | `HoldTimer` (trigger) → `notifyControllerFire(false)` → `setFireActive(false)` | worker; controller conn |
| 6 | `applyForState(Engine Abort, is_transition = false)`: **no `schedule_gen_` bump**, so a pending stage of the left state still lands, and the abort batch skips that role (`// Kept: C4-3`) | `ActuatorCommander` core → `sendBatch` (`_udp.cpp`) | worker; stage thread |
| 7 | republish loop for the abort state | `ActuatorCommander` core | loop thread |
| 8 | `current_state_ = Engine Abort` | `doTransitionTo` | worker |
| 9 | **`triggerAbort()` #2**: 4 more ABORTs; then joins #1's done thread (≤ 50 ms on the worker) and starts its own → **4 × ABORT_DONE 3 s after #2** | `AbortBroadcaster` (`// Kept: C1-10`) | worker; done thread |
| 10 | publish `[0x43]`, `[0x50]` | `_elodin.cpp` | worker |
| 11 | controller parity sees a non-fire state → `setFireActive(false)` → no edge (already closed at 5); if step 5's TCP notify failed, **this** is what closes the gate | `ControllerService` subscriber → `setFireActive` | controller subscriber |
| 12 | log, `OK` | as (a) 21 | |

Ownership check:

- **ABORT has one owner (`AbortBroadcaster::sendPacket`) and two triggers in one transition** (3
  and 9): C1-10, kept, both tagged. Both sites stay in `doTransitionTo` in core
  `SequencerService.cpp` (D42 binding 1); a reviewer reading one sees the other.
- **ABORT_DONE has one owner**, the done thread of the *last* `triggerAbort`; #2 cancels #1's.
- **CLEAR_ABORT has no trigger at all** (C1-9): `sendClearAbort` exists, nothing calls it. Frozen,
  not "fixed" by WP10.
- **The fire gate close has one owner (`setFireActive`) and two triggers** (5, 11), as in (a).
- **If C4-1 has wedged the worker, no step from 2 on has a running owner**: the command waits
  10 s, the reply is `ERR` ("timed out … it may still run"), and **zero** ABORT datagrams leave the
  sequencer; the boards' own thresholds and heartbeat watchdog are the only stop (research
  abort-statemachines Idea 1, teststand-architecture Idea 3: SERVER_HEARTBEAT keeps flowing, so the
  boards' NO_CONNECTION_ABORT never trips). Frozen (`digital-twin__scripts-load.txt`); the PROPOSALS
  are in the research.
- EINTR (research cpp-service-plumbing §0.2): a SIGTERM landing on the worker during step 3 or 9
  can fail one ABORT repeat; frozen with the `SO_SNDTIMEO` sockets.

### (c) A board reconnect in daq_bridge (registration; D-SUB's race preserved)

Two different events are called "reconnect", and only the second registers anything.

**(c1) A board power-cycles** (e.g. PT board 21). daq_bridge is single-threaded; every step is on
the main loop.

| # | step | owner (file) |
|---|---|---|
| 1 | receive and classify the BOARD_HEARTBEAT | `SensorFramePipeline::poll` / `get_last_heartbeat` (lib) |
| 2 | record the board in memory | `BoardDiscovery::process_board_announcement` (lib) |
| 3 | map source IP → configured board (config IP, then the 127.0.0.<octet> fallback) | `resolve_board_config_by_source_ip` (`BoardMap.cpp`) |
| 4 | assignment bookkeeping; **sends nothing** although start-up logs "Proactive SENSOR_CONFIG sent" (C6-1) | `FSWConfigManager::process_board_heartbeat` (lib) |
| 5 | publish the `[0x10, board_id]` heartbeat row | `HeartbeatRouter::process_heartbeat` (lib) |
| 6 | data resumes: route by source IP; an unknown IP gets the discovered type (and is inserted into `board_map`) or is treated as PT | `main` (routing block), `discovery_board_type_to_enum` (`BoardMap.cpp`) |
| 7 | self-test rows `[0x60+s, board_id]` with the board-id fallback ladder | `publish_self_tests` (`ElodinPublish.cpp`, cleanup) |
| 8 | raw rows, timestamps from per-board clock sync (reboot/wrap handling) | `publish_raw_batch` (`ElodinPublish.cpp`, cleanup); `BoardClockSync` (lib) |
| 9 | the board receives its SENSOR_CONFIG/ACTUATOR_CONFIG | **not daq_bridge**: `config_broadcast_service`'s periodic broadcast (C6-6 restricts it) |

No VTable registration happens on a board reconnect: the tables were registered for every
*configured* board at Elodin connect time, whether or not the board was up.

Ownership check: step 9 has **no owner inside daq_bridge**, by design today; `FSWConfigManager`
looks like the owner (and its log says so, C6-1) but is not. The design keeps it so and says it in
`TableRegistration.hpp`/`BoardMap.hpp`'s "must not" lines, so nobody adds a push in a refactor.

**(c2) Elodin restarts.** This is where registration, and D-SUB, live.

| # | step | owner (file) |
|---|---|---|
| 1 | publishes start failing; `is_connected()` false; every 5 s on the idle path try `reconnect()` | `main` loop (idle path) |
| 2 | on success: log `✅ Reconnected to Elodin — re-registering VTables`, `elodin_connected = true` | `main` (stays at the call site, §4.3) |
| 3 | re-register, in order: raw, calibrated, ball valve (if any), heartbeat, environmental, self-test; **no return checks, no drain** | move-only: inline in `main` (759-773); cleanup: **`register_all_tables(…, report_failures = false)`** (`TableRegistration.cpp`) |
| 4 | ids and entity names for every table | `DatabaseConfig` registrars → `table_id_for` (WP3) |
| 5 | meanwhile calibration_service reconnects on its own 2 s cadence and re-registers **the same calibrated tables** | calibration_service `main` (WP9 keeps it there) |
| 6 | the backend reconnects and re-subscribes; a subscribe accepted **inside** a re-registration that changes an id's content (the D-SLOT collision: slot 10 vs PT2.CH1) binds to stale components and delivers nothing, forever (D-SUB) | the backend registry (WP5/WP6); elodin-db 0.16.1 (research subscription-robustness §0) |
| 7 | rows resume for every other table | `publish_raw_batch` etc. |

Ownership check:

- **Fixed by the cleanup:** step 3 has two copies in move-only (first connect 578-592 with checks
  and the 1.5 s drain; reconnect 759-773 without). After cleanup it has **one owner**,
  `register_all_tables`; the differences (checks, drain, logs, flag) are the `report_failures`
  argument and the call sites (§4.3).
- **Two owners across processes, frozen:** the calibrated tables are registered by daq_bridge
  (step 3) and by calibration_service (step 5). Both sections are in `elodin/golden`; whether their
  `VTableMsg` bytes are identical for every shared id is research question 1 (subscription-
  robustness). Recorded with D-SLOT; not WP10's to change.
- **Zero owner, frozen:** nothing detects a subscription that was accepted and never delivers
  (D-SUB). WP10 preserves the race exactly: no barrier, no ack wait, no reordering of the six
  registrations, no change to the 5 s cadence. The proposals (echo check, liveness, reconnect
  remedy) are in the research and are the team's.

## D. Open questions (added)

5. Tag spelling: D42(c) says `// FROZEN C4-1`; STYLE-S12 and D43(4) say `// Kept: <id> (D17)`. This
   note uses S12's so one grep finds every kept defect in every WP. Orchestrator to confirm.
6. Should the `publishState` lock-contract comment land in the move-only commit (D42(c): "where that
   code moves") rather than in cleanup step 1? This note follows STYLE-S12/S38 (a move adds no
   comment lines); either is behaviour-neutral.
7. If CI cannot judge the D34 timing tests when WP10 is queued, is alternative C (daq_bridge +
   `ActuatorCommander_udp` only) the accepted fallback?
