# WP10 round 1 — B: collaborator objects

Advocate B. Lines are `backend-remastered` @ b2599617 (product = `main` @ 15b5a0c5), paths under
`daq-server/diablo_server/`.

## Position

`SequencerService` is already a collaborator design: `StateMachine`, `ActuatorCommander`,
`AbortBroadcaster`, `HoldTimer`, `ScriptRunner`, `PressureFeed`, `ElodinClient` are members
(`SequencerService.hpp:223-230`), each owning its own thread and mutex; `HoldTimer` is an extraction
that already happened (the comments still say `fire_manager_`, `.cpp:59`). daq_bridge drives the
four library objects §4.1 names plus its own `BackendLogForwarder` class
(`daq_bridge_main.cpp:49-90`). So B is "finish the pattern", and A *already* applies it wherever
the headers allow (`BoardMap` functions over a carrier pair, `BackendLogForwarder.hpp`,
`register_all_tables` as the one registration owner, §4.3). The dispute is only the rule for the
three class files.

**I concede passes 1 and 2 to A as written**, and side with A over C: A's same-class TUs are what
make the step-3 objects small diffs (`_controller_notify.cpp` already fences what a notifier
would own; `_elodin.cpp` makes the publisher's "fix first" order visible), whereas under C every
fix package would start by doing A's split. Lines deleted: as A (~0 / ~15); step 3 is net
additive — collaborators buy locality for a fix, not deletions. What B contributes is (1) a
feasibility taxonomy that narrows §A's "fails by construction" to exactly the cases where it is
true, and (2) a map from each team proposal to the one collaborator that makes its fix a
one-object diff — so a later cleanup does not extract the wrong object first.

## Taxonomy: what a collaborator must own decides where it can land

| tier | owns | header | feasible in | examples |
|---|---|---|---|---|
| 0 | nothing (free functions, file-local carrier struct) | untouched | passes 1–2 | A's daq_bridge treatment; file-statics `now_ns`, `toLower`, `trimVal` (§1.4, §2.3) |
| 1 | plain data; no mutex another member function takes; a thread or fd only if its stop/close is already the enclosing destructor's first explicit statement | **appended** member, nothing moved | a fix package | `ControllerNotifier`, `StageScheduler`, `CommandQueue` (the conditional case) |
| 2 | a thread, an fd, or `config_mutex_`'s guarded state | moved/removed members | never | `SequencerPublisher`, `ActuatorUdpLink`, `SequencerConfigLoader` |

Evidence for the tiers:

- **Harness.** `char_ac_private.cpp:58-63` names exactly four members of one class —
  `bind_addr_`, `bind_addr_explicit_`, `actuator_port_`, `roles_` (plus `ActuatorRole` fields).
  No file reaches a private of `SequencerService.hpp` or `ControllerService.hpp` (grep: the only
  `define private public` is `char_ac_private.cpp`; the headers' includers are six `lib/test/*`
  ctests, the mains and the class TUs). So "the harness reads privates ⇒ no collaborators" holds
  for four named members and nothing else.
- **Destruction order.** `~SequencerService` (`.cpp:56-71`) stops the worker, the retry thread, the
  commander loop and the hold timer *explicitly, in the body*, before any member destructor runs.
  `PressureFeed` and `ScriptRunner` stop in their own destructors (`PressureFeed.cpp:33-34`,
  `ScriptRunner.cpp:61-62`), so member order matters for those two. An appended Tier 1 member is
  destroyed first and joins nothing. And `lifecycle/golden/shutdown.txt` has no sequencer or
  controller row; WP8 gap 2 adds an exit-code and latency **bound**, not an order freeze.
- **Lock chain.** C4-1 is `doTransitionTo:717` → `publishState:1130` on `config_mutex_`.
  `publishState` reads `elodin_`, `current_state_`, `state_machine_`, `refused_states_`,
  `dynamic_states_`, `pressure_feed_`, `debug_mode_` (`.cpp:1116-1168`): a publisher object is the
  deadlock re-expressed across objects. Conceded in full. The chain touches no other candidate.

## Conceded as infeasible

- **`SequencerConfigLoader` returning a value.** `applyConfig` (`.cpp:206-567`) writes ~20 members
  and calls into five sub-objects (`actuator_commander_.load`, abort broadcaster, hold rules,
  `pressure_feed_.start`, controller endpoint) with the `SEQ_LOAD` lines frozen in that order
  (`char_sequencer.py:349-355`, N6). A struct of those values is the privates duplicated; the log
  order forbids reordering the side effects. `_config.cpp` or nothing.
- **`ActuatorUdpLink`.** `sendBatch` reads `bind_addr_` and `actuator_port_`
  (`ActuatorCommander.cpp:276-390`); owning them rewrites §7.2's harness.
- **`SequencerPublisher`; `PwmLink` owning `udp_socket_fd_`** (WP8 §0 rejected owning sockets;
  the controller closes after `stop()`, `ControllerService.cpp:74-80`; S21).
- **"Interfaces invite fakes."** Dead under D20: goldens are black-box, no ctest is rewritten in
  a refactor. The only real gain is a stack-free ctest for an invariant a fix creates.
- **S34.** Every collaborator below has one user: disqualifying in the remaster; no exception asked.

## The step-3 map: which collaborator each fix package introduces

Passes 1–2 are A's. Step 3 is the team's fix packages (golden first, then the fix, S8), each
allowed to change goldens and headers. Admission rule (proposal for the LEDGER): a collaborator
class enters only in the package whose fix is its reason to exist; the row records the single user.

1. **`CommandQueue`** ← research Idea 2a (abort precedence). Owns `cmd_queue_`, `cmd_mutex_`,
   `cmd_cv_`, `cmd_thread_`, `cmd_stop_`, `Command` (`hpp:159-183`) and `commandLoop`,
   `enqueueAndWait`, `enqueueDetached` (`.cpp:76-137`). Tier 1 only if `~SequencerService` calls
   `queue_.stop()` as its first statement (the join precedes `stopElodinRetry`, `.cpp:60-68`) and
   the object's destructor is a no-op once stopped. `enqueueUrgent` is one `push_front`; D42's
   single entry point becomes structural. The 10 s timeout line keeps its bytes.
2. **`StageScheduler`** ← research Idea 3 (C4-3). Owns `schedule_gen_`, `pending_roles_`,
   `pending_roles_mutex_` (`hpp:189-195`) and the stage spawn (`ActuatorCommander.cpp:592-610`).
   Touches none of the four harness members. `cancelAll()` (bump + clear) *is* the fix, and the
   research's sink fence (re-check the generation under the lock that serialises `emit`) lives
   inside this object (S23 bars a new mutex in a refactor, not in a fix). **Collision, stated
   openly:** D42(c) keeps these members in core `ActuatorCommander.cpp` for WP10; the C4-3 package
   already flips `default__aborts.txt:18,24`, so it revises D42(c) in the same review.
3. **`ControllerNotifier`** — Tier 1 feasible (reads only `controller_host_`, `controller_port_`,
   `kControllerConnectTimeoutMs`, `.cpp:1023-1114`; same threads, §1.5) but **not worth it**: no
   proposal touches it, and its lines are SEQ_FACTS (`char_sequencer.py:357-362`), so a class of
   another name would keep the `[SequencerService]` prefix (S15 beats S16). A's
   `_controller_notify.cpp` is the right home.
4. **C4-1, Idea 2b, C1-10/C1-9, Idea 5, D-SLOT/D-SUB** — no collaborator. The hoist is 5 lines in
   `doTransitionTo`; `AbortBroadcaster` is already the object (2b is a call site on the connection
   thread, C1-10 is deleting `.cpp:915-917`); Idea 5 is a header edit orthogonal to any object;
   `register_all_tables` is a function and should stay one. B adds nothing here.

Order matters: `SequencerPublisher` becomes *considerable* only after the C4-1 hoist unlocks every
caller, and then only if it takes a const snapshot of the mask inputs rather than
`config_mutex_` (`.cpp:1130`). Fix first, extract second — never the reverse.

## Flows

Passes 1–2: DESIGN-WP10 §C (a), (b), (c) verbatim. Step-3 deltas only:

- **Fire (a):** step 1's `enqueueAndWait` is `CommandQueue`'s; step 10 unchanged (notifier stays
  a member function).
- **Abort (b):** step 1 may `push_front` (Idea 2a); `stages_.cancelAll()` is inserted before step
  6, so the Fuel Press stage of (b)6 no longer lands — the fix, with its golden flip. Steps 3 and 9
  unchanged.
- **Reconnect (c):** no delta; A is right.

Every step-3 header edit recompiles the 6 + 4 ctests and `sequencer_service` (§6.1 step 5):
D31/D34 CI judgement per package.

## Objections

1. *"This is A with extra steps."* For passes 1–2, yes. The deliverable is the tier table and the
   per-fix map, which stop a cleanup from extracting the publisher before C4-1 is fixed.
2. *"S34: one user each."* Conceded for the remaster. In a fix package the fix is the user; the
   admission rule above makes that explicit, recorded, and the orchestrator's call, not an agent's.
3. *"D42(c) forbids `StageScheduler`."* For WP10, correctly. The C4-3 package already changes the
   golden D42(c) protects; revising the binding there, with the fix, is honest; doing it in cleanup
   would not be.
