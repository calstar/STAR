# WP10 round 2 — C (minimal): rebuttal and revised design

Anchors as round 1 (`backend-remastered` @ 4241556b).

## 1. Against A

**A1 — the thread partition is true for three TUs and false for three.** Checked per member:

| TU | A's claim | threads that actually run it |
|---|---|---|
| `_config` | before the worker | main only (`applyConfig` from `init:570`) — **holds** |
| `_load` | before threads | main only — **holds** |
| `_controller_notify` | worker and HoldTimer | worker, HoldTimer (`:1005-1114`) — **holds**, and nothing else on the timer thread touches the service |
| `_elodin` | worker, main, retry | yes — but core `init` is main and `doTransitionTo` is worker: the same two threads, plus retry. Not a partition; a closed set (A2) |
| `_pwm` | conn, controller, subscriber | `sendActuationPWM` from `setFireActive` (`:329`, `:341`; conn and subscriber threads) and `controllerLoop` (`:700`) — every thread the core runs on |
| `ControllerService_elodin` | "subscriber thread; `initialize`" | also the **controller thread**: `write*ToDB` at `:728-731` inside `controllerLoop`. A's table omits it |

So "A partitions by thread" is the right argument for `_config`, `_load`, `_controller_notify` and
I concede those three on it. It does not justify `_pwm` or `ControllerService_elodin`; A needs a
different reason there (A has none in round 1 beyond size).

**A2 — the closed set for `_elodin`: conceded.** `now_ns` (`:49`) has exactly two users,
`publishState:1164` and `publishStateTransition:1249`; the `VTABLE_*` constants and the two
aliases have one user each in that set; keeping `publishState` in core would copy a file-static
(S27). If the sequencer is split, that is the cut. My remaining condition: the lock-contract
comment lands **in the move-only commit**, not in cleanup (D42(c) "where that code moves"; open
question 6). It is one labelled non-dimmed line; the move creates the need, so the move carries it.

**A3 — the commit order: accepted, and turned into two queue items.** A proposes step 4 first so
the fallback is "the package truncated after commit 1". Truncating a queue item is a re-cut (D25:
a failed queue branch is deleted). Make commit 1 its own queue item instead: daq_bridge +
ActuatorCommander + harness, merged alone; the sequencer/controller TUs are queue item 2, cut
from item 1's tip. Then the fallback is "do not queue item 2", the D31 10× comparison for
`actuator_delays`/`script_positions` has a merged baseline that already contains the AC move,
and D-PF (which gates sequencer moves, not AC moves) only has to be reproduced before item 2.
Cost: one extra full gate + Linux leg + CI. That is the price of bisectability A's own O3 asks for.

**A4 — errors in A's table.** (i) "C: one [harness] edit" repeats the design note's mistake: with
`_udp`, `char_config_dump` (`test/characterization/config/CMakeLists.txt:15-21`) needs §7.2. (ii)
"lines deleted ~0 both" omits the 27 dead `ControllerService` lines (round 1 §3) — available to A,
unlisted by A. (iii) "`_controller_notify` is where a WP8 TCP helper lands (§0)": DESIGN-WP10 §0
row B1 says "no WP8 helper is named" and open question 2 says the notify client "stay[s]
hand-written after WP10". Nothing lands there. (iv) "the next abort fix lands in a 1295-line file":
A's own §5 table says every abort fix is "one hunk" in `doTransitionTo`; a reviewer reads the hunk
against the golden, not the file. File length is not the fix's cost.

**A5 — `_pwm` is the one sequencer/controller TU I still oppose.** 190 lines, three threads, no
mutex (`setFireActive` releases `input_mutex_` before `:329`), and the wire bytes are frozen
(`service_pwm.txt`). Moving it changes nothing a reader needs and adds one CMake line and one
include block. Keep `sendPWMCommand[s]` beside `setFireActive`, which is the only place that
decides to call them.

## 2. Against B

B concedes passes 1–2 to A, so the live claim is: "under C every fix package would start by doing
A's split". False by A's own §5: C4-1 hoist, single `triggerAbort`, `cancelPendingStages`,
`enqueueUrgent` are each one or two hunks in `doTransitionTo`/`applyForState`, in core under A and
in the same functions under C. No fix needs a TU boundary first. B's step-3 map is useful and I
take it as written, with one correction: B says the comments "still say `fire_manager_`"; they do
(`:59-61`), and that stale comment is exactly a cleanup-pass S38 fix, not evidence that extraction
"already happened" — `HoldTimer` is a member with its own file, which is the collaborator pattern
working *without* splitting the class that owns it. B's tier table also shows why `CommandQueue`
is the only Tier-1 candidate: everything else in `SequencerService` owns a thread or
`config_mutex_` state (Tier 2). That is the cohesion argument from round 1 in B's words.

## 3. Conceded

- Thread partition: `_config`, `_load`, `_controller_notify` (A1).
- `_elodin` as the closed set, with the comment in the move commit (A2).
- A's O1: proximity never guarded C4-1; the header's "guarded by" line and the tag do.
- B: `char_ac_private.cpp` names four members; no private of the other two headers is read. The
  "headers cannot change" rule is therefore narrower than the note states — but still binds:
  member order is destruction order for `PressureFeed`/`ScriptRunner`, and `ControllerService.hpp`
  is where round 1's deletions land (no harness, no order change).
- "Split less" loses for the sequencer; "delete more" stands.

## 4. Revised design

| queue item | content | gate |
|---|---|---|
| **1 (move-only)** | `BoardMap.{hpp,cpp}`, `BackendLogForwarder.hpp`, `ActuatorCommander_{load,udp}.cpp`, CMake, §7.2 + §7.3 harness edits — DESIGN-WP10 §6.1 step 4 verbatim | full gate, Linux leg, CI; D34 tests judged on CI |
| **2 (move-only)** | `SequencerService_{config,controller_notify,elodin}.cpp` with the `publishState` lock-contract comment; `ControllerService_elodin.cpp`. **No `_pwm`.** Prerequisites: item 1 merged; D-PF reproduced; CI judged item 1's timing tests | same; D31 10× against item 1's tip |
| **3 (cleanup)** | `register_all_tables` (after §7.4 gap 1), the §4.3 daq_bridge extractions, **delete** `getLastActuation`/`getLastDiagnostics`/`setNavState` and the write-only `output_mutex_`/`last_*` (hpp:92, 138-140, 221-223; cpp:245-248, 373-382, 703-708; `nm` proof), `using namespace vtable` out of core, `// Kept:` tags, B's step-3 map recorded in the LEDGER as the fix-package admission rule | same |

Item 2 may be skipped by a ledger entry (D45(3)) without touching item 1 or 3. Walkthroughs: §C
(a)/(b)/(c) unchanged; (a) step 12's PWM send stays in core `ControllerService.cpp`.

Sizes after both passes: `SequencerService.cpp` ≈ 610, `ActuatorCommander.cpp` ≈ 505,
`ControllerService.cpp` ≈ 790 (waiver, S33 cohesive clause: the gate edge, the loop and the PWM
codec are one thread-crossing decision), `daq_bridge_main.cpp` < 700.

## 5. Remaining disagreements

1. `_pwm`: A splits it; I keep it in core (no thread or lock boundary, bytes frozen).
2. One queue item with ordered commits (A) vs two queue items (C): one extra gate for a fallback
   that needs no re-cut.
3. The lock-contract comment in the move commit (C, D42(c)) vs cleanup (A, S38).
4. The 27 dead `ControllerService` lines and `ControllerService.hpp`'s edit in cleanup: A's table
   still says "~0"; the note still says "header unchanged".
5. B's `CommandQueue`/`StageScheduler` are fix-package objects, never WP10's — agreed with B, but
   the LEDGER should say so now, so a cleanup reviewer cannot be talked into extracting one early.
