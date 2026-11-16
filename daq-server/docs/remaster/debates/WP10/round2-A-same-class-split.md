# WP10 round 2 — A: same-class split, revised

Lines: `backend-remastered` (product = `main` @ 15b5a0c5). Round 1 is not restated.

## 1. Concessions

**C's dead code in ControllerService — verified, adopted.** `git grep` over `daq-server/` finds
`getLastActuation`/`getLastDiagnostics` (hpp:139-140, cpp:373-382), `setNavState` (hpp:92,
cpp:245-248) and `output_mutex_`/`last_actuation_`/`last_diagnostics_` (hpp:221-223, store block
cpp:703-708) only in the class's own two files; nothing calls them. A takes all three rows in the
cleanup pass as one commit of its own. That makes WP10's **one header edit**: §3.3's "header
unchanged" becomes "unchanged in move-only; cleanup deletes three dead declarations and three
members". It is safe because, as B's grep shows, no harness reaches a `ControllerService.hpp`
private; the proof is C's: `nm -C` on `fsw_daq_lib` differs in exactly the three symbols,
`service_pwm.txt` and `sequencer/golden/controller__*` green. §3.2's lock table loses
`output_mutex_`.

**C's harness-exposure correction — right.** My "C: one edit" was wrong: with `_udp`, C needs
§7.2 (`config/CMakeLists.txt:15-21` lists `ActuatorCommander.cpp` by path) and §7.3; A needs the
same two files, §7.2 naming two TUs instead of one.

**B's shutdown-golden correction — withdrawn.** `lifecycle/golden/shutdown.txt` has rows for
board_simulator, config_broadcast, stacklight, calibration, ota, elodin-db, daq_bridge, heartbeat
and the backend — no sequencer. What fixes the sequencer's teardown order is the destructor's
explicit body (`SequencerService.cpp:56-71`) plus WP8 gap 2's exit bound; member order matters
only for `PressureFeed` and `ScriptRunner`, which stop in their own destructors. An *appended*
member is therefore feasible in a fix package, as B says.

**B's tier table and admission rule — accepted**, with one re-tiering (§2) and one sharpening:
"the fix is the user" is recorded per package in the LEDGER, and the header edit lands in that
package's own CI-judged item (every `SequencerService.hpp` edit recompiles the 6 + 4 ctests and
`sequencer_service`).

**C's timing argument — partly.** Release is confirmed (`gate.sh:39`), and both A and C move
`sendBatch` out of its TU. C's real gain is `script_runtime` (D34, CI-only), which links
`SequencerService.cpp` (`lib/CMakeLists.txt:325-329`): in C it has one variable. My round-1
commit order gives A the same bisection: commit 1 *is* C's content (step 4), so a CI red that
appears only after commit 2 names the SequencerService split.

**C's "+180 copied includes"** — true of the move-only interim; §6.2's first bullet prunes them.

## 2. Attacks

**B's weakest point: `StageScheduler` is Tier 2 by B's own table.** The stage spawn
`std::thread([this, gen, staged, order, emit, roles_by_delay]` (`ActuatorCommander.cpp:592`)
captures `emit` (`:504`), and `emit` captures `this` and takes `script_positions_mutex_` then
`overrides_mutex_` (`:513-522`) — mutexes `setScriptPosition` (`:770`) and `setManualOverride`
(`:734`) also take. A scheduler object either owns that snapshot path (Tier 2: "a mutex another
member function takes") or receives `emit` as a callback type with one user (S34; B's own
preamble). So B's step-3 map item 2 should read Tier 2, and the C4-3 fix stays a method on
`ActuatorCommander` (`cancelPendingStages` + the 835 call), exactly where A puts it. The taxonomy
itself stands.

**C's weakest point: it pays the blast radius twice and empties its own deletion column.** C §5
concedes `_controller_notify` and `_elodin` have "genuine merit" and proposes them as "a later,
separately gated item" — a second queue item recompiling the same 6 + 4 ctests and
`sequencer_service`, after a full gate was spent merging a 1295-line file only to split it next.
C §2 then offers to trade `_udp` first; without it C is daq_bridge-only. And C's "≈40 deleted" is
−27 of ControllerService dead code plus the registration fold, both now in A: A deletes ≈42, C's
edge is gone. The remaining C claim, "`config_mutex_` threads through all four concerns", is
false for `_controller_notify` (no mutex, `:1023-1114`; C concedes) and true of `_config` only as
the one-time writer at `:546`, `:552` before any thread exists (`init:570-623` starts the worker
last).

## 3. `_config` and `_pwm`: C says no merit

**`_config` (139-567) has the most merit of the four, by the number.** Without it core
`SequencerService.cpp` is ≈995 lines (1295 − ~150 − ~150): C's position asks a *third* S33
waiver beside 1295 and 1160, for the three largest class TUs in the tree, and S33 is a dead
letter. On its own terms: it runs exactly once on main before the worker exists; it is the only
writer of the fifteen unguarded fields (§1.2), holding `config_mutex_` twice and never nested; it
is the C4-2 site (`:514-520`, its own `// Kept:` tag); its reviewer reads N6's load-time lines
and the CSVs, never the state machine. "Writes fields others read" is true of every constructor;
it cannot be the rule for cohesion or nothing could ever be split.

**`_pwm` (41-62, 383-530) is the wire format**, which is the part of ControllerService a firmware
reviewer reads: `PACKET_TYPE_PWM`/`COMMS_VERSION 0` hard-coded (parked B4, bloat-map defect 7 —
the tag lands here), the 20/33-byte layouts, and both `ipv4Destination` adoption sites WP8 §0
names (`:434-439`, `:498-506`). Its callers release `input_mutex_` first (`:320-341`), and the
reported `udp_socket_fd_` two-thread `sendto` race is contained in it. Honest ranking: if the
judge wants fewer files, `_pwm` is the one to fold (core → ~820); `_config` never.

## 4. Revised design

1. Files, ownership, threads and lock map as round 1 §1-§2, with §4's harness row corrected:
   A = §7.2 (two TUs) + §7.3; C = §7.2 (one TU) + §7.3.
2. Move-only commits in the order step 4 (daq_bridge + ActuatorCommander + harness) →
   SequencerService → ControllerService, so D45(3)'s fallback is truncation after commit 1 and a
   CI-only red bisects by commit.
3. Cleanup adds C's ControllerService deletions as a separate commit (header edit, `nm` proof),
   beside the registration fold, the `using` lines and include pruning.
4. D-PF (`PressureFeed.cpp:118-146`) is reproduced before the move-only item is queued; it gates
   A and C equally, since both move `sendBatch`.
5. B's tier table and admission rule go to the LEDGER as the rule for fix packages, with
   `StageScheduler` at Tier 2; passes 1-2 introduce no object.
6. The round-1 claim that a golden freezes the sequencer's destruction order is withdrawn; the
   dtor body and WP8 gap 2 are what hold it.

## 5. Remaining disagreements

- With C: whether S33's 700 is a target A meets or one that two or three recorded waivers dissolve.
- With C: whether keeping 1295/1160 whole buys bisectability worth a second gated item for the two TUs C itself wants.
- With C: whether a one-time writer of immutable fields (`_config`) is "cohesion" or a load phase.
- With B: `StageScheduler`'s tier (2, per the `emit` capture), and so whether C4-3's fix is a method or an object.
