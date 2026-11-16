# WP10 verdict

Lines are `backend-remastered` (product = `main` @ 15b5a0c5), paths under
`daq-server/diablo_server/` unless said; every ruling was checked with `git show`.

## 1. Fact rulings

1. **Dead ControllerService code (C): true.** `setNavState` (hpp:92, cpp:245-248), both getters
   (hpp:139-140, cpp:373-381), `output_mutex_`/`last_*` and the store block (hpp:221-223,
   cpp:703-708) have no other reference in the repository (archive included).
   `current_nav_` is read at cpp:322, :558 and stays.
2. **"No harness reads `ControllerService.hpp`" (B): true but imprecise.** Includers:
   `PWMTargets.hpp:29`, the `.cpp`, `controller_main.cpp:36`; `PWMTargets.hpp` is included by
   `char_config_dump.cpp` and `ActuatorCommander.cpp`, so the cleanup header edit needs no harness
   file edit but recompiles `char_config_dump`, the 10 AC ctests and `sequencer_service`; the only
   `#define private public` is `char_ac_private.cpp:23`.
3. **`now_ns` (:49) has two users, :1164 and :1249, both publishers; `tryConnectElodin`
   (1253-1293) uses none of `now_ns`/`VTABLE_*`/the aliases.** B's A2 holds: S27 is met by either
   `_elodin` cut.
4. **"Partition by thread" (C's A1): true for `_config`, `_load`, `_controller_notify` only.**
   `sendActuationPWM` is called from `setFireActive` (:329, :341; conn and subscriber threads) and
   `controllerLoop` (:700); `write*ToDB` (:728-731) is inside `controllerLoop`, so
   `ControllerService_elodin` also runs on the controller thread. `setFireActive` holds
   `input_mutex_` only in inner blocks: `_pwm` is lock-free. `sendActuationPWM` (509-530) is
   clamp + cast, nothing fusable (D22 holds).
5. **A ("only sequencer code on the HoldTimer thread") and C ("nothing else on the timer thread")
   are both false:** the `on_expire` lambda (:866-880) calls `enqueueDetached` (core, 127-136).
   `_controller_notify` is the only I/O there. A's "where a WP8 TCP helper lands" is also false
   (DESIGN §0 row B1, open question 2).
6. **StageScheduler is Tier 2 (A's attack holds).** The stage thread (:592) captures `emit` (:504),
   which captures `this` and takes `script_positions_mutex_` (:515) and `overrides_mutex_` (:520);
   `pending_roles_mutex_` is taken by `applyForState` (:464, :493, :499), the stage thread (:605)
   and `setScriptPosition` (:780). B's Tier 1 row excludes it.
7. **`config_mutex_` sites:** :546, :552 (`applyConfig`, before the worker starts at :616),
   :673/:717/:740/:904/:925 (`doTransitionTo`), :1130, :1217. `notifyControllerFireOnce`
   (995-1114) takes none; C's "threads through all four concerns" is false.
8. **`lifecycle/golden/shutdown.txt` has no sequencer or controller row.** The dtor body (56-71)
   stops worker, retry thread, loop and hold timer; only `PressureFeed` and `ScriptRunner` stop
   in their own destructors (`PressureFeed.cpp:33`, `ScriptRunner.cpp:61`). B's A1 holds; DESIGN
   §A's "fails by construction" row is wrong.
9. **ctest targets:** `SequencerService.cpp` in `lib/CMakeLists.txt` 254, 276, 299, 325, 406-424
   = 6; `ActuatorCommander.cpp` in those plus 149, 203, 223, 239 = 10; plus `sequencer_service`
   and `char_config_dump` (`test/characterization/config/CMakeLists.txt:15-21`). Moving `sendBatch`
   needs §7.2 in A and C alike (C's correction holds).
10. **D25**: a failed queue branch is deleted and re-cut with a full re-gate, so A's "truncate
    after commit 1" is a re-cut (C's A3). **D-PF** gates "WP10's move-only item"; item 1 runs
    `CHAR_AREAS=sequencer`, so it gates item 1 (B's C4).

## 2. Decision

**A's file list as reviewed (DESIGN §1.4, §2.3, §3.3, §4.3), including `_pwm` and A's `_elodin`
cut; C's deletions; two move-only queue items; B's tiers with StageScheduler re-tiered.**
Headers untouched in move-only. Core `SequencerService.cpp` keeps dtor, queue, `init`, the `do*`
bodies and `doTransitionTo` with both `triggerAbort` sites, the 716-730 block and the 835 call;
core `ActuatorCommander.cpp` keeps `applyForState`, `emit`, the stage thread, `schedule_gen_`,
`pending_roles_`; only `sendBatch` goes to `_udp` (D42 binding 1).

The criterion actually applied, which the DESIGN must state: a TU is cut where (i) it runs in a
different phase or thread set (`_config`, `_load`, `_controller_notify`) **or** (ii) it is a wire
format or transport a different reader reviews (`_udp`, `_pwm`, both `_elodin`). `_pwm` has
`_udp`'s exact shape (codec + `sendto`, several callers, lock-free, bytes frozen); C moves one
and opposes the other with no distinguishing fact, and without `_pwm` core is ~790, an S33
waiver. A's `_elodin` cut keeps the 17-byte layout and ids with their publisher under (ii), keeps
core ~610 rather than ~690, and is what §1.3, §1.5, D42(c) and research choice 4 presuppose; all
concede proximity never guarded C4-1. B's retry-only cut: legal, not adopted.

Queue:

1. **Move-only item 1** = DESIGN §6.1 step 4 verbatim (BoardMap, BackendLogForwarder,
   `ActuatorCommander_{load,udp}`, §7.2 + §7.3 harness edits, one commit) plus all the CMake
   restructuring: define `ACTUATOR_COMMANDER_SOURCES` and `SEQUENCER_SOURCES` (§6.1's list minus
   the three new SequencerService TUs) and use them in the 6 + 4 targets and `sequencer_service`.
   D-PF reproduced first. Full gate, Linux leg, CI (D34).
2. **Move-only item 2**, cut from item 1's tip: commit a `SequencerService_{config,
   controller_notify,elodin}` (three lines appended); commit b `ControllerService_{pwm,elodin}`
   (two `FSW_SOURCES` lines). D31's 10x comparison runs against item 1's tip; D45(3)'s fallback
   becomes "item 2 not queued", with a ledger entry.
3. **Cleanup item:** include pruning; `using namespace vtable…` out of core; `// Kept:` tags and
   the `publishState` lock-contract comment; `register_all_tables` (after §7.4 gap 1),
   `print_board_routing_table`, `publish_self_tests`, `publish_raw_batch`; the deletions, two
   commits: (c1) `setNavState` + getters (hpp:92, 138-140; cpp:245-248, 373-381); (c2)
   `output_mutex_`/`last_*` + store block (hpp:220-223; cpp:703-708), separate because it edits
   `controllerLoop`, the D22 TU. Proof: `nm -C fsw_daq_lib` loses exactly three symbols after
   c1, none after c2; `service_pwm.txt`, `controller__*`, config goldens byte-identical.

**Lock-contract comment: cleanup; D45(2) stands.** S12 says it literally ("a move-only pass adds
no such line; its diff rules forbid it"); §6.1's enumeration of permitted non-dimmed lines is
what lets a reviewer trust 1,700 dimmed ones. The header's "Guarded by config_mutex_" and §1.3
already say it; cleanup is the next item.

**S33 waivers: none.** `daq_bridge_main.cpp` is ~835 between item 1 and cleanup; the three
extractions not gated by gap 1 (383-418, 816-883, 885-989) bring it to ~626: interim, not waiver.

## 3. Best argument from each side

- **A:** the phase/thread partition for three TUs; C as a prefix of A. Lost: the
  destruction-order and WP8-helper claims; "by thread" overclaimed for three TUs.
- **B:** the shutdown-golden refutation; the tier taxonomy; "fix first, extract second". Lost:
  StageScheduler's tier; the retry-only `_elodin`.
- **C:** the 27-line deletion with `nm` proof, adopted by all; the §7.2 correction; two items
  under D25; "a reviewer reads the hunk, not the file". Lost: `_pwm` (no thread or lock boundary,
  true; outweighed by `_udp` consistency and S33), the comment timing, D-PF.

## 4. Collaborator admission rule and tiers

Record as a LEDGER Decision row: **WP10's passes introduce no collaborator object (S34,
D17(d)); the following governs team fix packages**, pointing here.

**Tier 0** — free functions, carrier structs; header untouched; passes 1-2 (daq_bridge).
**Tier 1** — plain data; no mutex another member function takes; a thread only if the destructor's
first statements already stop it; not placed between `script_runner_` and `pressure_feed_`
(hpp:227-229); an appended member or a dead member removed; fix packages only.
**Tier 2** — a thread or fd the body does not stop, `config_mutex_`'s guarded state, any of the
four `char_ac_private.cpp` members, or a path captured by `emit`; never.

Rulings: `StageScheduler` **Tier 2** — C4-3's fix is `cancelPendingStages()` on
`ActuatorCommander` plus the 835 call, as research Idea 3 words it. `CommandQueue` Tier 1 while
dtor 56-66 stays first. `ControllerNotifier` Tier 1, not worth it (its lines are SEQ_FACTS,
`char_sequencer.py:357-364`). Publisher, `ActuatorUdpLink`, `PwmLink`, `SequencerConfigLoader`
Tier 2. Admission: a collaborator enters only in the package whose fix is its reason to exist;
the row names the single user (S34 exception); its header edit is CI-judged there; the publisher
waits for the C4-1 hoist and a const snapshot replacing `config_mutex_`.

## 5. Edits DESIGN-WP10.md needs

1. §A row "fit with characterization", column B: replace "fails by construction … shutdown
   goldens see" with fact 8; "Why B lost" reason 1 becomes D17(d)/S34 plus the harness's four
   members, not goldens.
2. §A "Why C lost": replace "different threads and different reviewers" with the two-criterion
   rule; `_pwm` and both `_elodin` TUs are criterion (ii).
3. §A "lines deleted", column A: "~0 / ≈ 42 (15 registration, 27 dead, 2 `using`)".
4. §3.3: "header unchanged in move-only; cleanup deletes hpp:92, 138-140, 220-223". §3.2:
   `output_mutex_` "removed in cleanup". §6.2: the two deletion commits, `nm` proof,
   `current_nav_` stays. §8 ODR: "three fewer symbols after cleanup".
5. New §3.5 mirroring §1.5: controller thread → `_pwm` (:700), `_elodin` (:728-731);
   conn/subscriber threads → `setFireActive` → `_pwm` (:329, :341).
6. §1.5: `enqueueDetached` (core) also runs on the timer and script threads.
7. §6.1: items 1 and 2 as above; CMake and verify lists per item. §A D-PF amendment: "before
   item 1 is queued"; fallback: "item 2 not queued".
8. §7.2: `char_config_dump` → `PWMTargets.hpp` → `ControllerService.hpp`: cleanup's header edit
   recompiles the harness binary (fact 2).
9. §A: a "Collaborator objects" subsection with §4; §1.4: one sentence on why A's `_elodin` cut
   stands.
10. Open questions 5, 6, 7 closed (D45(1), D45(2) + §2, D45(3) + item structure); 3 stays open.

## 6. Remaining team questions

1. Is `TRANSITION:<abort>` *the* stop path; 2a (`push_front`) or 2b (connection-thread
   broadcast); is a third ABORT burst acceptable? (research Q1-2)
2. C4-3: does the abort column always win over a pending stage; honour the delays CSV? (Q4)
3. C1-10/C1-9: latch abort→abort as a no-op; on which edge is CLEAR_ABORT sent? (Q5)
4. C4-1: the 5-line hoist, or Idea 5's static check first — inside the remaster, with one
   baseline exception? (Q6-7)
5. After `setNavState` goes, `current_nav_` is never written: planned input or dead member?
6. Who records the Elodin-reconnect characterization (§7.4 gap 1)?
