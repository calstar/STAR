# WP10 round 1 — A: same-class TUs by concern (the reviewed design)

Anchors: `backend-remastered` (product code = `main` @ 15b5a0c5), as DESIGN-WP10, cited by `§`.

## 1. Files and ownership

| TU | owns | thread(s) that run it |
|---|---|---|
| `SequencerService.cpp` (core, ~610) | dtor 55-71, queue 73-137, `init` 570-623, `doTransitionTo` 666-938 with **both** `triggerAbort` (795, 916), the C4-1 block 716-730, the 835 call; `do*` bodies; `makeScriptEnv`, `scriptStatusReport` | worker; `init` on main |
| `SequencerService_config.cpp` (~455) | `readFile`, `loadConfig`, `configDir`, `resolveDataPath`, `applyConfig` 139-567 | main, before the worker exists |
| `SequencerService_controller_notify.cpp` (~150) | `kControllerConnectTimeoutMs`, `notifyControllerFire[Once]` 995-1114 (D-SEQ) | worker **and** the HoldTimer thread |
| `SequencerService_elodin.cpp` (~150) | `VTABLE_*`, msg aliases, `now_ns`, `publishState`, `publishStateTransition`, `tryConnectElodin`, retry 1253-1293 | worker, main, retry thread |
| `ActuatorCommander.cpp` (core, ~505) | `applyForState` 392-611 with `schedule_gen_` 462, `pending_roles_` 492-500, `emit` 504, the detached stage thread 592-610; republish loop; overrides; `publishCommandedState` | worker, loop, stage threads |
| `ActuatorCommander_load.cpp` (~225) | `trimVal`, `setDefaultBindAddress`, `load` 57-257 | main, before threads |
| `ActuatorCommander_udp.cpp` (~130) | `sendUDP`, `sendBatch` 276-390 | `emit`'s caller |
| `ControllerService.cpp` (core, ~630) | ctor/dtor/`initialize` (socket 92-98), `start`/`stop`, `setFireActive` 250-360, `controllerLoop` 536-752, thrust curve 1113-1157 | conn threads, controller thread |
| `ControllerService_pwm.cpp` (~190) | PWM constants 41-62, `sendPWMCommand[s]`, `sendActuationPWM` 383-530 | conn, controller, subscriber threads |
| `ControllerService_elodin.cpp` (~390) | subscriber 754-915, `send_msg`, `registerControllerTables`, `write*ToDB` | subscriber thread; `initialize` |
| `daq_bridge/BoardMap.{hpp,cpp}` | 113-305, `static` dropped | single thread |
| `daq_bridge/BackendLogForwarder.hpp` | 49-90 verbatim, header-only | single thread |
| `daq_bridge_main.cpp` (~835; < 700 after cleanup's four extractions, §4.3) | argv, signals, both registration sites until cleanup, the loop | single thread |

Headers untouched in both passes. The 6 + 4 test targets and `sequencer_service` take two source
lists (§6.1 step 5); `FSW_SOURCES` gains the controller TUs.

## 2. Locks and threads after the split

Nothing changes: same members, threads and lock order `config_mutex_` → `ScriptRunner::mtx_` /
`PressureFeed::mtx_` (§1.2). New is only that some lock-holding chains cross a TU: core
`doTransitionTo` holding `config_mutex_` at 717 → `_elodin` `publishState` relocking at 1130
(C4-1); core → `_elodin` at 705, 759, 776, 933, 605; HoldTimer → `_controller_notify`.
The cut preserves by construction: the commander's three mutexes are never nested
(`ActuatorCommander.hpp:202-206`; `emit` snapshots each separately, 513-522) and `sendBatch` takes
none; `setFireActive` releases `input_mutex_` before `sendActuationPWM` (320-341), so `_pwm` is
lock-free. Existing races (`fire_start_time_`, `ActuatorCommander::elodin_`) stay reported (§2.2, §3.2).

## 3. Walkthroughs as boundary crossings

**Fire (§C(a)).** Worker: core `doTransitionTo` → core `applyForState` (skips `is_pwm`, bumps `schedule_gen_`)
→ `_udp` → core arms the hold → `_controller_notify` FIRE_START → controller conn thread: core
`setFireActive` → `_pwm` → `[0x44]` → worker: `_elodin` publishes `[0x43]`, `[0x50]` →
controller `_elodin` subscriber → core `setFireActive` (no edge). Expiry: HoldTimer thread → `_controller_notify`
FIRE_STOP → core `enqueueDetached`.

**Abort (§C(b)).** Entirely inside core `doTransitionTo` on the worker: `triggerAbort` #1 (795)
→ `hold_timer_.stop()` → `_controller_notify` FIRE_STOP → core `applyForState(to, false)` (no
generation bump, 462; pending role skipped, 492-495) → `_udp` → `current_state_ = to` →
`triggerAbort` #2 (916) → `_elodin`. `default__aborts.txt` freezes exactly this: the Engine Abort
batch to board 12 has no ch3, `+100ms … ch3=1[Fuel Press]` lands after it (C4-3), `ABORT x4 (x2
sends)` (C1-10). Both `triggerAbort` sites and the C4-1 block never leave the one function
(D42 binding 1); `test_abort_ordering.cpp:152` (ABORT < 200 ms) measures one TU.

**daq_bridge reconnect (§C(c)).** Board power-cycle: `resolve_board_config_by_source_ip`
(`BoardMap.cpp`) from the routing block; no registration. Elodin restart: 745-776 moves
verbatim; cleanup folds 578-592 and 759-773 into `register_all_tables(…, report_failures)` only
after §7.4 gap 1 freezes the reconnect stream; D-SUB's window (no barrier, same order) stays.

## 4. Why A beats B and C

| axis | vs B (collaborator objects) | vs C (daq_bridge + `_udp` only) |
|---|---|---|
| clarity | B's units are nameable, but the C4-1 chain and `config_mutex_` would cross an object boundary; A partitions **by thread**: `_config` before threads, `_controller_notify` on the timer thread, `_elodin` shared by worker/retry/loop | C leaves a 430-line `applyConfig` between the queue (73-137) and `doTransitionTo` (666); the next abort fix lands in a 1295-line file |
| lines deleted | ~0 both; B adds ~150 of interface | ~0 both; cleanup's ~15 registration lines are the same in A and C |
| testability | D20: goldens stay black-box; B's fakes need rewritten ctests | identical |
| harness | A: two reviewed edits (`config/CMakeLists.txt:15-21`, `char_config_services.cpp:24`). B **cannot**: `char_ac_private.cpp:23-25` reaches `bind_addr_`, `roles_`, and `SequencerService.hpp` member order is destruction order the shutdown golden observes (dtor 55-71) | C: one edit |
| move-only | A's diff is `--color-moved` dimmed except includes/namespace/CMake; B is not a move | C is a strict subset of A (§6.1 steps 2, 4) |

## 5. Positioning the team's later fixes (none made)

| proposal | lands in | shape after A |
|---|---|---|
| C4-1 hoist (research Idea 1) | core SS 716-730 | one hunk; the `// Kept: C4-1` tag and `publishState`'s lock-contract comment index it |
| single `triggerAbort` (Idea 4) | core SS 915-917 | one hunk, same function as 795 |
| `cancelPendingStages` (Idea 3) | core AC + the 835 call | two hunks, `_udp` untouched; the sink fence stays with `emit` |
| abort precedence 2a (Idea 2) | `enqueueAndWait`, core SS | single entry point kept structural (`do*` private, hpp 187-191) |
| D-SLOT check | `register_all_tables` (cleanup) | one daq_bridge site |
| Idea 5 annotations | `SequencerService.hpp` | outside WP10; A never touches the header |

## 6. Objections

**O1 — "A makes C4-1 cross-TU; a reader of `doTransitionTo` no longer sees the relock."**
Today 717 and 1130 are 400 lines apart in one file; proximity never guarded it — the header's
"Guarded by config_mutex_" (hpp ~255) and the cleanup comment do. The alternative cut — keep
`publishState` in core — is not free: `now_ns()` (49) serves both `publishState` and
`publishStateTransition` (1248), so that cut copies a file-static (S27, D4) or mints a header,
and `_elodin` shrinks to a 50-line retry stub. {`now_ns`, both `VTABLE_*`, both aliases, both
publishers} is a closed set with exactly one TU: the reviewed cut.

**O2 — "Four TUs of one class is still a god class; B is the real design."** Conceded: a small
named unit reads better. But the headers cannot move (harness, destruction order), S34 makes
every collaborator single-user, and the one place a collaborator would help is the abort, which
D42 binds to core and where every research idea is a PROPOSAL. A is what the frozen contract
permits.

**O3 — "Blast radius: every sequencer/AC ctest recompiles; D34 judges three on CI only; take C."**
Conceded: C is the right fallback (D45(3)). But recompiling is not changing; `--color-moved`
checks the move and D31's 10× rule covers any retry. **Improvement:** order the move-only
commits as step 4 (daq_bridge + AC + harness) **first**, then SequencerService, then
ControllerService. If CI cannot judge the timing tests when WP10 is queued, the fallback is the
package truncated after its first commit, not a re-cut. `_controller_notify` is not surplus: it is
the only sequencer code on the HoldTimer thread, carries D-SEQ, and is where a WP8 TCP helper
lands (§0).

Honest cost: move-only deletes nothing; A's price is the D31/D34 exposure C avoids.
