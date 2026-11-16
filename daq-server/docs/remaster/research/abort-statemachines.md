# Research: abort precedence in safety-critical state machines (TOPIC = abort-statemachines)

Scope: patterns that make an abort impossible to block or reorder, mapped onto the sequencer's
abort defects C4-1, C4-3, C1-10 (and C1-9, which falls out of the same pattern) and onto
`DESIGN-WP10.md`. Everything that changes an observable (a golden line, a packet, a timing) is a
**PROPOSAL for the team**, never a remaster change (AGENT-RULES 4-6, D5). Line numbers are on
`backend-remastered` @ `85a02f9a` (product code = `main` @ `15b5a0c5`); `grep -n` anchors are given
so they survive WP8/WP9 re-anchoring, as DESIGN-WP10 does.

Our abort path today, in one paragraph. An operator abort is `TRANSITION:<abort state>` on TCP
:9998 (`sequencer_main.cpp:83`, `grep -n '"TRANSITION:"'`). It becomes
`SequencerService::transitionTo` → `enqueueAndWait` (`SequencerService.cpp:107-125`), i.e. a
lambda pushed on the **same FIFO `cmd_queue_`** as every other command (manual actuator, debug,
hold expiry, script `transition_to`), and the connection thread waits ≤ 10 s
(`kCommandTimeoutSeconds`, `SequencerService.hpp:175`). Only when the single worker
(`commandLoop`, 76-105) reaches it does `doTransitionTo` (666-938) run the validation gates, then
`abort_broadcaster_.triggerAbort()` (795), `script_runner_.stop()` (809), `stopContinuousLoop`
(818), `hold_timer_.stop()` (823), `applyForState(to, !isAbortState(to))` (835), the republish loop
(907), `current_state_ = to` (911), `triggerAbort()` again (916), Elodin publishes (932-933). The
boards' own PT-threshold abort (ACTUATOR_CONFIG thresholds, C1-7) is independent of all of this and
is the real last line of defence; nothing below touches it.

---

## Idea 1 — A run-to-completion step must never block on, or re-enter, its own lock (C4-1)

**What.** The actor / active-object model serialises all state-machine work on one thread and one
queue; its correctness rests on each step running to completion without blocking. QP's
documentation: "Active Objects process the events one at a time, and the next event can only be
processed after the previous event has been processed completely", and "blocking (as in the middle
of the RTC step) is incompatible with the RTC event processing semantics" — a blocked step makes the
object "unresponsive to queued events"
([QP/C++ concurrency, state-machine.com](https://state-machine.com/qpcpp/conc-qp.html)). SCXML
defines the same unit as a *macrostep* that ends only when "the internal event queue is empty and no
transitions are enabled" ([W3C SCXML §3.13](https://www.w3.org/TR/scxml/)). Locking a
`std::mutex` the thread already owns is not a deadlock by specification, it is UB: "If lock is
called by a thread that already owns the mutex, the behavior is undefined: for example, the program
may deadlock" ([cppreference, std::mutex::lock](https://en.cppreference.com/w/cpp/thread/mutex/lock)).
(CERT [CON56-CPP](https://wiki.sei.cmu.edu/confluence/spaces/cplusplus/pages/88046858) is the
related rule for `try_lock*`; it does not cover plain `lock()`.)

**Our code.** We already *have* the actor: one worker, one queue, `do*` bodies only on the worker
(`SequencerService.hpp:51`, DESIGN-WP10 §1.2). C4-1 is exactly a step that blocks forever:
`doTransitionTo` takes `config_mutex_` at 717 (`grep -n 'refused_states_.find(to)'`), and for a
refused dynamic state calls `publishState()` at 727 inside that scope; `publishState` returns early
when Elodin is down (1117-1118) but otherwise locks `config_mutex_` again at 1130 → UB, observed as
self-deadlock. Because the actor has one thread, the whole state machine is gone: every later
`enqueueAndWait` — **aborts included** — times out after 10 s with "reporting failure (it may still
run)" (121-123). Two aggravations the RTC lens makes visible:
- The abort's own `triggerAbort()` (795) runs on the worker, so during C4-1 **zero ABORT
  datagrams** leave the sequencer; the GUI's abort button gets `ERR` and nothing reaches the boards
  except via their own thresholds.
- "It may still run" means a timed-out command stays queued; if the worker ever came back, stale
  transitions would execute after the operator was told they failed (not reachable in C4-1, since
  the worker never returns, but true of any slow step).

The same RTC rule flags two softer blocks in the abort step itself, both *after* the broadcast:
`script_runner_.stop()` (809, joins the script thread) and `hold_timer_.stop()` (823), which joins a
timer thread that may be inside `notifyControllerFire` (300 ms connect + 1 s `SO_SNDTIMEO`,
DESIGN-WP10 §6.3). They delay the abort's **valve batch** (835), not its ABORT packet.

Goldens/characterization: `sequencer/golden/digital-twin__scripts-load.txt` freezes C4-1;
DESIGN-WP10 §7.4 notes "SIGTERM does not exit" is documented, not frozen.

**Cost.** Fix = move the 727 `publishState()` after the scope closes (copy the reason string out,
release, publish) — ~5 lines, mirrors what 742-760 already does with `lk.unlock()`. A
`recursive_mutex` would also stop the hang but is weaker: it legitimises re-entry under a lock whose
holders call out to `ScriptRunner::mtx_` and `PressureFeed::mtx_` (lock order, DESIGN-WP10 §1.2) and
hides the next re-entry rather than preventing it.

**Status: PROPOSAL** (changes `digital-twin__scripts-load.txt`: the later commands would succeed;
DESIGN-WP10 §1.3/§8 explicitly forbid touching 716-730 in the remaster).

---

## Idea 2 — Abort travels on a priority channel, not behind the FIFO (C4-1 consequence, queue order)

**What.** Mature frameworks separate *urgent* from *routine* input at the queue, not inside the
handler. NASA's F´ (FPP) lets every async input port/command declare a `priority`: "In general the
priorities regulate the order in which elements are dispatched from the message queue", and a
queue-full policy of `assert | block | drop | hook` (default assert → FSW abort/reset)
([FPP User's Guide §11.2.4-11.2.5, 11.5.4](https://nasa.github.io/fpp/fpp-users-guide.html); note
FPP says the numeric meaning is implementation-specific). SCXML gives internally-raised events
strict precedence over the external queue ([W3C SCXML §3.13](https://www.w3.org/TR/scxml/)). In
launch sequencing the Shuttle Ground Launch Sequencer treats a cutoff not as one more queued step but
as a mode switch: "At breakout the GLS mainline program will be automatically suspended and a safing
sequence will take its place", and "Cutoff is defined as a manually … initiated command … which will
cause a GLS breakout" ([GLS Description Documentation, Rev 6 Chg Q, Operational Notes 1-2,
ibiblio](https://ibiblio.org/apollo/Shuttle/Countdown/Ground%20Launch%20Sequencer%20Description%20Documentation.pdf)).
ISO 13850 states the requirement the pattern serves: the emergency stop "shall be available and
operational at all times and override all other functions and operations in all operating modes"
([ISO 13850:2006 §4.1.1, sample](https://cdn.standards.iteh.ai/samples/39078/161b50f101dc44dd869b507d05119e6b/ISO-13850-2006.pdf);
2006 edition, the one with a public sample).

**Our code.** An abort is indistinguishable from any other `transitionTo` at enqueue
(`SequencerService.cpp:633-664`, both `transitionTo` overloads → `enqueueAndWait`). It waits behind
whatever is queued: a burst of script `transition_to`s and hold expiries (`enqueueDetached`,
127-136), manual actuator commands, and — worst case — a wedged step (Idea 1). The house already
learnt the in-handler version of this lesson ("Physical abort broadcast FIRST", comment 781-792;
`lib/test/test_abort_ordering.cpp:152` asserts ABORT < 200 ms ahead of the controller notify), but
the ordering stops at the handler: nothing orders the abort *ahead of the queue*.

Two shapes, increasing in strength:
- **2a. Front-of-queue.** `transitionTo` sees `StateMachine::isAbort(to)` and `push_front`s instead
  of `push_back`s (and may discard queued non-abort transitions, GLS-style "mainline suspended").
  Cheap; does nothing for a wedged worker.
- **2b. Out-of-band broadcast.** The connection thread calls `abort_broadcaster_.triggerAbort()`
  *before* enqueueing (it is already thread-safe: it sends before taking `done_thread_mutex_`,
  `AbortBroadcaster.cpp:137-145`), then enqueues the state transition as today. The boards hear
  ABORT even if the worker is dead. This is the GLS/ISO shape: the stop path does not depend on the
  sequencer's own liveness.

Resolving the name on the caller thread for 2a/2b reads the state table off-worker, which the
comment at 638-640 deliberately avoids; the abort-state set is fixed after `applyConfig`, so a
read-only snapshot taken in `init` would do.

Goldens touched: `packets/golden/service_abort.txt` (on queue/C1) and sequencer N3a `xK` counts
(ABORT count/timing), `default__aborts.txt` (`first datagram: ABORT` already holds), and any
`sequencer_concurrency` ordering expectations.

**Cost.** 2a ≈ 15 lines in `enqueueAndWait`/a new `enqueueUrgent`; 2b ≈ 10 lines plus deciding
idempotence (Idea 4) because the worker would then broadcast again.

**Status: PROPOSAL** (observable: ABORT timing and count, command ordering).

---

## Idea 3 — Entering an abort cancels the mainline's pending actions (C4-3)

**What.** In GLS, safing *replaces* the mainline (Idea 2 quote) and uses a "mainline event complete
indicator … to determine the functions that must be performed" (same document, §3 Breakout Safing):
the safing sequence decides what still happens, nothing scheduled by the mainline fires on its own.
ISO 13850 §4.1.1: no start command "shall be effective on those operations stopped by the initiation
of the emergency stop function until the emergency stop function is manually reset". For delayed
work the standard implementation is an epoch/fencing token checked **at the sink**, so a stale
scheduler that has already passed its check still cannot act
([Kleppmann, "How to do distributed locking", fencing tokens](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)).

**Our code.** We have the epoch: `ActuatorCommander::schedule_gen_`, bumped only when
`is_transition` (`ActuatorCommander.cpp:462`, `grep -n '++schedule_gen_'`), checked by the detached
stage thread (597, 601). `doTransitionTo` 835 passes `is_transition = !isAbortState(to)`, so an
abort does **not** bump it, and the left state's stage fires after the abort batch. Worse than "a
late command": because the stage's role is still in `pending_roles_`, the abort batch *skips* it
(`ActuatorCommander.cpp:492-495`, "still waiting on its delay"). Frozen in
`sequencer/golden/default__aborts.txt`:

```
16:  state Fuel Press -> Engine Abort
17-  first datagram: ABORT
18-      +0ms x3 (x2 sends) to board 12: ACTUATOR_COMMAND v0 n=6: ch7=0[Fuel Main] ... (no ch3)
24:    +100ms x3 to board 12: ACTUATOR_COMMAND v0 n=1: ch3=1[Fuel Press]
```

The Engine Abort batch omits Fuel Press; the Fuel Press state's 0.2 s stage
(`config/profiles/default/state_machine_actuator_delays.csv:3`, armed ~100 ms before the abort)
lands 100 ms after it. Here it is harmless by coincidence — the Engine Abort column also says OPEN
(`state_machine_actuators.csv`, row Fuel Press) — but for any role whose abort column differs from
the left state's column, the abort never commands it and the stale stage drives it the wrong way.
(Also note the delays CSV gives Fuel Press 0.2 s in the abort columns; aborts ignore delays because
of the same flag, which is what a reviewer would expect, but it is undocumented.)

There is a second, smaller hole the fencing view exposes: even with a bump, the stage thread checks
`schedule_gen_` at 601 and then calls `emit` → `sendBatch` without a lock shared with the abort
batch, so a stage that passed the check microseconds before the bump can still interleave with it.
A sink-side fence = re-check the generation inside `emit` under the mutex that serialises sends.

**Cost.** Fix = a `cancelPendingStages()` (bump `schedule_gen_`, clear `pending_roles_`) called on
abort entry before `applyForState(to, false)`; the abort column then also includes the formerly
pending roles. ~10 lines in `ActuatorCommander` + 1 call. Sink fence: +1 mutex around
check+send in `emit`.

**Status: PROPOSAL** (changes `default__aborts.txt` lines 18/24 and N4 bounds; DESIGN-WP10 §8
forbids changing `is_transition=!isAbortState(to)`).

---

## Idea 4 — The abort is a latched, idempotent mode with an explicit reset (C1-10, C1-9)

**What.** ISO 13850 §4.1.6 latching: "the effect of this command shall be sustained until it
is manually reset … The reset of the command shall not restart the machinery but only permit
restarting" ([ISO 13850:2006](https://cdn.standards.iteh.ai/samples/39078/161b50f101dc44dd869b507d05119e6b/ISO-13850-2006.pdf)).
Read as software: the abort is a *latched state*, entering it again is a no-op (idempotent), and
leaving it is a distinct, explicit event that tells everyone downstream. Statechart practice puts a
side effect that must happen exactly once per entry in the state's **entry action**, not in the
transition body twice ([W3C SCXML §3.13 / `<onentry>`](https://www.w3.org/TR/scxml/)).

**Our code.** `triggerAbort()` is called at 795 *and* 916 (`grep -n 'triggerAbort'`); each call
sends 4 ABORTs, and the second cancels and reschedules the first's ABORT_DONE
(`AbortBroadcaster.cpp:145-157`): 8 ABORTs then 4 ABORT_DONEs 3 s after the *second* call (C1-10).
Abort→abort transitions (golden `default__aborts.txt:26-36`, Engine→GSE→Emergency) re-broadcast
and restart the ABORT_DONE clock each time. And the reset half does not exist:
`AbortBroadcaster::sendClearAbort` has no caller (C1-9), so boards are never told the latch is
cleared — the "explicit reset" is missing in the other direction.

Frozen by `packets/golden/service_abort.txt` (queue/C1), sequencer N3a `xK` (README row N3a:
"the two `triggerAbort()` calls … K frozen"), `default__aborts.txt`.

**Cost.** Fix = delete 915-917 (keep the early one, which is the one `test_abort_ordering` needs),
optionally guard with "already latched → don't restart ABORT_DONE"; decide when CLEAR_ABORT is sent
(exit from the abort set to a non-abort state is the obvious edge, but it is a protocol/board
behaviour decision, not a code one).

**Status: PROPOSAL** (packet counts/timing change; CLEAR_ABORT adds wire traffic the boards have
never seen from the server).

---

## Idea 5 — Make the lock discipline machine-checked (static; zero runtime effect)

**What.** Clang Thread Safety Analysis: `REQUIRES(!mu)` / `EXCLUDES(mu)` on a function says the
caller must not hold `mu`; the analysis "is completely static (i.e. compile-time); there is no
run-time overhead", attributes do not change generated code; `-Wthread-safety` enables it,
`-Wthread-safety-negative` makes the negative requirement transitive
([Clang docs](https://clang.llvm.org/docs/ThreadSafetyAnalysis.html)). It needs annotated mutex
types (libc++ with `_LIBCPP_ENABLE_THREAD_SAFETY_ANNOTATIONS`, or a thin annotated wrapper) and a
no-op macro for gcc (the Linux leg).

**Our code.** `publishState` would carry `REQUIRES(!config_mutex_)`; `config_mutex_` members
`GUARDED_BY(config_mutex_)` (`hold_rules_`, `dynamic_states_`, `refused_states_`,
`SequencerService.hpp:255`). With that, clang **correctly** flags 727 — the C4-1 site — at compile
time, and any future re-entry (the four other `publishState` calls in `doTransitionTo`, the
cross-TU chains DESIGN-WP10 §1.5 lists) is caught when written.

**Cost / catch.** Requires editing `SequencerService.hpp`, which DESIGN-WP10 §1.4 says is not edited
in either WP10 pass, and introduces exactly one new warning at 727, which the D4 warning baseline
turns red. So: adopt only as (a) a separate later package, (b) with 727 recorded as a named baseline
exception ("C4-1, frozen") or the analysis run as a non-gating CI job, never by
`NO_THREAD_SAFETY_ANALYSIS` on `doTransitionTo` (that would hide every future site in the one
function where it matters).

**Status: ADOPTABLE in the remaster** (no observable change: no code generation change, no
golden), conditional on the orchestrator accepting the header edit and the baseline exception. It
does not fix C4-1; it makes C4-1 the only instance and keeps it that way.

---

## Structural choices in WP10 that make the later fixes cheap (no behaviour change now)

All compatible with WP10's move-only rules; most are "don't split this".

1. **Keep the abort ordering in one function, one TU.** Both `triggerAbort` sites (795, 916), the
   716-730 block, the 835 `applyForState` call and the publish calls stay in `doTransitionTo` in core
   `SequencerService.cpp` (DESIGN-WP10 §1.4 already does this). Do not extract helpers around them in
   cleanup: Idea 1/3/4 fixes are then single-hunk diffs reviewers can read against the goldens.
2. **Keep `schedule_gen_`, `pending_roles_`, `applyForState`, the stage thread and `emit` in core
   `ActuatorCommander.cpp`** (§2.3 does; `sendBatch` goes to `_udp`). A later
   `cancelPendingStages()` / sink fence (Idea 3) is then one-TU; if `emit` ever moves next to
   `sendBatch`, move the generation check with it.
3. **One entry point for "enqueue".** `enqueueAndWait`/`enqueueDetached` stay together in core
   (§1.4 does) and every public command keeps going through them; do not let the WP8 `LineCommand
   Server` adoption call `do*` directly. Idea 2a then changes one function.
4. **Write the lock contract next to the code that will move.** When `publishState` moves to
   `SequencerService_elodin.cpp`, carry a one-line comment "acquires `config_mutex_`; callers must
   not hold it — except `doTransitionTo` 727 (C4-1, frozen)". Comments are not observables; this is
   the cheap half of Idea 5.
5. **Mark frozen defects at their sites with stable tags** (`// FROZEN C4-1`, `C4-3`, `C1-10`) in
   the moved code, so the fix PR is `grep -rn FROZEN` and the reviewer sees the golden line it flips.
6. **Close the characterization gaps a fix will need to show a deliberate diff.** DESIGN-WP10 §7.4:
   C4-1's "SIGTERM does not exit" is documented not frozen; C4-2 is avoided not frozen. Add (in
   characterization, not product) (a) "abort issued while the worker is wedged" → today: `ERR` after
   10 s and 0 ABORT datagrams; (b) an abort whose column differs from a pending stage's value. Then
   each proposal above is "these golden lines change, and only these".

---

## Questions for the debate advocates

1. Is the operator abort (`TRANSITION:<abort>`) meant to be *the* stop path, or a courtesy on top
   of the boards' threshold abort? Ideas 2b and 4 only matter if the team relies on it.
2. 2a vs 2b: should the ABORT datagram depend on the sequencer worker being alive at all? If not,
   which thread owns the broadcast, and is a third ABORT burst (caller + worker) acceptable?
3. On abort, should queued non-abort commands be discarded (GLS "mainline suspended") or still run
   after the abort (today)? A queued script `transition_to` out of the abort state is the case.
4. C4-3: should the abort batch include roles whose stage was pending (i.e. the abort column always
   wins), and should abort columns ever honour the delays CSV (default profile declares 0.2 s for
   Fuel Press in all three abort columns)?
5. C1-10/C1-9: abort→abort (Engine→Emergency) — re-broadcast and restart ABORT_DONE, or latched
   no-op? And on what edge is CLEAR_ABORT sent — any exit from the abort set, or only an explicit
   operator reset command?
6. For C4-1, accept the 5-line hoist, or require Idea 5's static check to land first so the fix is
   proven to be the last re-entry?
7. Is a header edit plus one named warning-baseline exception acceptable inside the remaster for
   Idea 5, or must it wait for the post-remaster defect pass?
