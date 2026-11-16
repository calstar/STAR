# WP10 round 2 — B: rebuttal and revised position

Lines: `backend-remastered` @ b2599617 (C's 4241556b has identical product code: `git diff
--stat` over `diablo_server/` is empty). Paths under `daq-server/diablo_server/`.

## 1. Against A

**A1 — the destruction-order argument is wrong as stated, and A leans on it twice (§4 harness row,
O2).** "`SequencerService.hpp` member order is destruction order the shutdown golden observes (dtor
55-71)". Three facts: `~SequencerService` (`.cpp:56-71`) joins the worker, the retry thread, the
commander loop and the hold timer *in the body*, before any member destructor runs; the only
members that join in their own destructors are `PressureFeed` and `ScriptRunner`
(`PressureFeed.cpp:33-34`, `ScriptRunner.cpp:61-62`); and `lifecycle/golden/shutdown.txt` has no
sequencer or controller row (WP8 gap 2 adds an exit-code and latency bound, not an order). So the
argument bars a collaborator placed *between* those two members, or one that owns a thread the
body does not stop — Tier 2 — and nothing else. Also "B adds ~150 of interface": a Tier 1
collaborator is one declaration (`StageScheduler`: three members and two methods it already has).
The harness half of the row is right and I conceded it in round 1: four named members of one class.

**A2 — O1 defends the `_elodin` cut with a four-line static.** The closed set A names
(`now_ns`, `VTABLE_*`, both aliases, both publishers) is equally closed in *core*: `now_ns` has
exactly two users, `:1164` and `:1249`, both publishers. Then `_elodin.cpp` is `tryConnectElodin`
+ `start/stopElodinRetry` (`:1253-1293`), the only sequencer code on the retry thread — which is
A's own partition criterion ("by thread"), applied more cleanly than A applies it: A's `_elodin`
is "worker, main, retry thread" (A §1), i.e. not partitioned by thread at all. The cost A names
("a 50-line retry stub") is not a cost; the gain is that the C4-1 chain (`717 → 727 → 1130`) and
its future hoist stay one file, which C and A both call worth something and research structural
choice 4 exists to compensate for. S27 is met (the static moves with its users).

**A3 — the fix-positioning table (§5) already answers B's round-1 objection "A with extra steps"
in my favour.** A's rows for `cancelPendingStages` ("two hunks, core AC + the 835 call") and 2a
("`enqueueAndWait`, core SS") describe member-function hunks. The live question for step 3 is
hunk vs object, and A does not argue it; it lists hunks because WP10 cannot do more. Fine for
WP10; it says nothing against an object in the fix package.

## 2. Against C

**C1 — C is A's `_controller_notify` + `_elodin` deferred, at double the gate cost.** C §5 concedes
those two "have genuine merit: no lock crosses them, D22 untouched" and proposes them "as a later,
separately gated item". Every product-code item pays D19's full gate + Linux leg + CI (D34, for
anything touching the sequencer). C therefore pays the sequencer's CI exposure twice to arrive at
A minus `_config` and `_pwm`. A's O3 commit order (daq_bridge + AC + harness first, SequencerService
second, controller third) already yields C as "the package truncated after commit 1" without a
second item.

**C2 — the S33 cohesion claim does not survive its own evidence.** C: "`config_mutex_` threads
through all four concerns". It does not. `config_mutex_` is taken at `:546, :552` (applyConfig,
before the worker exists — `init:616` starts it after), `:673-925` (doTransitionTo), `:1130`
(publishState) and `:1217` (scriptStatusReport). `notifyControllerFireOnce` (`:1023-1114`) takes
no mutex — C says so itself in §5. Four thread owners in one file is the opposite of the
`RobustDDPController.cpp` exception S33 names.

**C3 — "bisects to one 115-line move instead of seven TUs"** is true only if the red is in the
republish path; it is captured by A's O3 ordering (commit 1 is C), so it is an argument for that
ordering, not for stopping there.

**C4 — the D-PF point cuts both ways.** The amendment requires D-PF reproduced "before WP10's
move-only item is queued" (DESIGN §A, D-PF), whatever that item moves; a BoardMap-only package is
still WP10's move-only item.

## 3. Conceded

- **To C, deletions.** Verified by `git grep` at the tip: `getLastActuation`, `getLastDiagnostics`
  (`hpp:139-140`, `cpp:373-381`) and `setNavState` (`hpp:92`, `cpp:245-248`) have no caller
  outside the class; `current_nav_` is still read at `:322, :558`, so it stays. No harness reads
  `ControllerService.hpp` (includers: `PWMTargets.hpp`, the `.cpp`, `controller_main.cpp`), so the
  header edit is free. These belong in A's cleanup. The `output_mutex_` block (`cpp:703-708`,
  `hpp:221-223`) is a separate reviewer decision, as C already says.
- **To C, the harness table.** A's "C: only §7.3" was wrong; with `_udp` C needs §7.2 too.
- **To A, the fix hunks.** For WP10 the rows in A §5 are the only legal shape.
- **To both:** no collaborator in passes 1–2. Round 1 said so; nothing above changes it.

## 4. Revised position

**Pass 1–2: A's**, with three amendments: A's O3 commit order; C's §3 deletions (getters,
`setNavState`) in cleanup; and the `_elodin` cut narrowed to the retry thread (A2) — the last is
a proposal, the first two I consider settled.

**Tier table (unchanged in substance, two corrections):**

| tier | owns | header | when |
|---|---|---|---|
| 0 | nothing: free functions, carrier structs | untouched | passes 1–2 (A does this in daq_bridge) |
| 1 | plain data; no mutex another member function takes; a thread only if the enclosing destructor's first explicit statement already stops it; no position between `pressure_feed_` and `script_runner_` | appended, or a dead member removed (C §3) | a fix package |
| 2 | a thread or fd the body does not stop; `config_mutex_`'s guarded state; any of the four harness-named members | moved members | never |

Corrections: the "no thread" clause is now the explicit `CommandQueue` condition; "dead member
removed" admits C's deletions as Tier 1 header edits.

**Admission rule (proposal for the LEDGER, orchestrator's call):** a collaborator class enters only
in the team fix package whose fix is its reason to exist; the row records the single user (S34
exception, named); the publisher is never a candidate until the C4-1 hoist lands and it takes a
const snapshot of the mask inputs instead of `config_mutex_` (`:1130`). Map, as round 1:
`StageScheduler` ↔ C4-3 (revising D42(c) in the same review as the `default__aborts.txt:18,24`
flip); `CommandQueue` ↔ Idea 2a; nothing for C4-1, 2b, C1-10/C1-9, Idea 5, D-SLOT/D-SUB.

## 5. Remaining disagreements

1. **A vs B:** whether header member order is a blanket bar (A) or bars Tier 2 only (B, §1 A1).
2. **A/C vs B:** at step 3, member-function hunks (A §5, C §4) or the collaborator that owns the
   state the fix mutates (B); not a WP10 question, but the ledger rule decides it later.
3. **A vs C:** `_config` and `_pwm` now (A) or never (C); I side with A on C1/C2.
4. **B vs A:** `_elodin.cpp` = retry thread only, publishers in core (B, A2) or as reviewed (A).
5. **C vs A:** C's deletions are in or out of A's cleanup; I side with C.
6. **A vs C:** whether C's single-TU bisectability is a reason to stop (C) or a commit order (A, B).
