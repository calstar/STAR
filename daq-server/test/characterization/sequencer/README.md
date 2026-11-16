# sequencer/ — sequencer_service and controller_service on the wire

Freezes what `sequencer_service` (`diablo_server/services/sequencer/**`) and `controller_service`
(`services/controller/controller_main.cpp`, `lib/src/control/**`) do in answer to TCP commands:
the reply text of every command and every datagram they put on the actuator port, decoded and as
raw hex, in order, with the delays between them.

```bash
bash test/characterization/sequencer/run.sh                       # compare with golden/
CHAR_UPDATE=1 bash test/characterization/sequencer/run.sh         # rewrite (main's behaviour only)
CHAR_SEQ_REPEAT=3 bash test/characterization/sequencer/run.sh     # each session 3x; fail on any difference
CHAR_SEQ_ONLY='default/entry/Fire$' bash test/characterization/sequencer/run.sh   # a subset
```

`run.sh` takes the stack lock itself (re-entrant under `gate.sh`) and refuses to run on the stand.
Binaries come from `$CHAR_BUILD_DIR/bin`, else `build-gate/`, else `build/`. A failing session
prints a unified diff; the actual renderings are left in `daq-server/.tmp/char_sequencer_out/`.
Golden files: `golden/<profile>__<kind>__<name>.txt`, one per session. Python 3.11+, stdlib only.

## Safety and isolation

Every config the suite runs a service against is a copy of a shipped profile with every
`[boards.*]` address rewritten to **`127.0.0.<board_id>`**, every other `192.168.x.x` (the abort
broadcast, the stacklight) to `127.0.0.1`, and every stand port moved into this area's private range.
`harness.patch_config` asserts no non-loopback address and no 5005 / 2240 / 9998 / 9999 survives,
and that every `[actuator_roles]` board has a `[boards]` entry (`ActuatorCommander` would otherwise
fall back to `192.168.2.<board>`). Ports: 26301 actuator UDP — bound on 127.0.0.1 (abort broadcast)
and on each actuator / ball-valve board's 127.0.0.<id>, one socket each, read by one thread so
arrival order is kept — 26302 sequencer TCP, 26303 controller TCP, 26304 a fake Elodin, 26306
board send ports (nothing listens). Work files: `daq-server/.tmp/char_sequencer_<pid>/`. Only PIDs
this suite started are ever signalled.

**Every command is frozen with its destination board** (`to board 12: ...`), taken from the address
the datagram was sent to, and each channel is named by the one role `[actuator_roles]` puts on that
board and channel. On macOS the addresses 127.0.0.11-14 and .71 need lo0 aliases
(`sudo ifconfig lo0 alias 127.0.0.<id> up`, as `test_integration.sh` uses); if any is missing
`run.sh` **fails** and lists them. Linux routes all of 127/8 to lo and needs none.

## Profiles and sessions

`default` (profiles/default, with `[fire] duration_ms = 500, extended_ms = 600`) and `digital-twin`
(profiles/digital-twin, with `[flow] duration_ms = 600`). The holds are shortened so a session takes
seconds, and chosen so no state's actuator loop ends near a republish tick (N5).

| sessions | what |
|---|---|
| `<p>/matrix` | every (from, to) pair, from the state table as the sequencer reads it (short rows left-aligned, see `feed-twin/backend/statemachines/NEEDS-REPAIR.md`): reply only. Each row is entered with `DEBUG_MODE`. |
| `<p>/entry/<state>` | one per `[[states]]` entry: boot, walk legally (BFS, no abort/held/scripted intermediates) to a predecessor, enter the state, record 1.8 s (4.2 s for aborts, + the hold for held states). Staging, abort broadcast and ABORT_DONE, hold expiry, the first republish. |
| `<p>/actuators` | `ACTUATOR:` for every role, open and close; refusal without debug; aliases, case, unknown role, bad values; overrides riding the republish; cleared by `DEBUG_MODE:0` and by a transition. |
| `<p>/debug` | what `DEBUG_MODE` unlocks (an illegal transition) and does not (a refused dynamic state); bad values. |
| `default/malformed` | `RELOAD_CONFIG` (there is none: `ERR:unknown command`), unknown commands, bad holds, blank lines, CRLF, two commands per write, oversize line, `SCRIPTS`. |
| `default/holds`, `default/aborts` | hold-duration refusals, `EXTEND_FIRE` in and out of Fire; abort ordering, a stale stage landing after an abort, abort-from-abort cancelling ABORT_DONE. |
| `default/fire-*` | Ready → Fire with the controller up, up with a test duty (PWM stream), up with its gate disabled, down (the retry path; in `default/entry/Fire`), and with `sequencer_owns_valves`. |
| `controller/*` | `FIRE_START` / `FIRE_STOP` / junk straight to controller_service's port: shipped config, test duty, gate disabled, unresolved PWM roles. |
| `digital-twin/flow` | `Flow Test:<ms>` holds: refusals, the gate stagger, early exit, re-entry. |
| `digital-twin/scripts-load`, `script/*` | dynamic states added the way `test_integration.sh` adds its Script Test: load-time refusals (via `SCRIPTS` and the reply), and runs that end, time out, loop, transition, are pre-empted and are overridden by hand. |
| `digital-twin/pressure/*` | the profile's own `Dynamic Test` (reads `High Press`, `GN2 High`) against a fake calibrated-PT feed: no reading, uncalibrated, a full run, a feed that goes stale mid-script. |

## The fake Elodin (side channel and pressure feed)

`fake_elodin.py` listens on the profile's `[database].port`. It is **not** elodin-db and nothing
here depends on the installed elodin-db. It records the sequencer's StateTransition publishes
([0x43, 0x00]) — used only to know when each state's actuator loop began (N5) and to print
`state A -> B` — and serves calibrated-PT frames to whoever subscribes, so `pressure()` can be
driven. Elodin bytes are not frozen here.

## Normalisation

Each rule is stated here and in `wire.py`; nothing is masked to make a particular diff go away. The
first 3x runs showed real races (N3a, N3b), transition overhead (N4) and spliced log lines (N6);
the rules below were changed for those mechanisms, never to fit one golden.

- **N1** Bytes 2..5 of every packet are a clock (steady ms for types 4/7/8/9, system ms for 10):
  masked as `........` in the hex and ignored in comparisons.
- **N2** The same bytes again (clock bytes included, so only a copy of one send can match)
  within 0.5 s is a retransmit: one line, `xN`. PWM sends are never retransmitted, so never grouped.
  N is frozen (3 for an actuator batch, 4 for an abort broadcast, 1 for PWM).
- **N3a** The same send again within 150 ms is one line with `(xK sends)`: a state entry is always
  the staged apply *and* the continuous loop's first pass, identical bytes, normally ~3 ms apart but
  measured up to ~60 ms on this loaded machine; an abort sends its broadcast twice (top and bottom of
  `doTransitionTo`). K is frozen.
- **N3b** Lines with the same time bucket are printed in canonical order (packet type, then
  bytes), never arrival order: the loop's first pass, a +1 ms stage, the second abort broadcast and
  the controller's PWM answer race each other inside a few tens of ms. The one ordering the code
  guarantees is frozen explicitly as `first datagram:` — on an abort entry the ABORT broadcast
  leaves before any valve is commanded.
- **N3c** The loop's first pass skips roles whose stage is still pending
  (`ActuatorCommander::applyForState`, `pending_roles_`); a stage due in ~1 ms (default Fire's LOX
  Main, 0.001 s) is sent from the stage thread and races it. A send to one board that is an earlier
  send to that board plus exactly the pairs a stage has already sent there is that first pass:
  counted as `(xK sends)` on the earlier line. Every pair it carries is still frozen, in the earlier
  send or the stage.
- **N4** Times are relative to the window's first datagram (or, after a `(note)`, to the moment the
  harness changed something). A *staged* send — an actuator send in the entered state's own loop,
  for a state that is neither an abort nor scripted, i.e. the delays CSV at work — is rounded to the
  nearest 50 ms below 1 s. Everything else is floored: to 100 ms below 1 s, 250 ms from 1 to 2 s,
  1 s from 2 s. 50 ms is the coarsest bucket that still moves when a staged delay changes by 50 ms:
  a stage is timed from its own batch on its own thread, measured jitter +0..+5 ms, so 0.001 -> 0,
  0.080 -> 100, 0.2 -> 200 and 0.25 would be 250 (the profiles' 1.0 s delay is in the 250 ms band).
  Everything else is a wait plus overhead that only ever overshoots, by up to ~60 ms under load
  measured in the 3x runs: a hold expiry or a script's `transition_to` joins the 10 ms-sliced loop
  thread; an abort's batch waits for its 4-repeat broadcast; ABORT_DONE is 60 x 50 ms sleeps
  (3.0 s nominal, ~3.3 s on macOS). Flooring keeps those in one bucket. Hold and script durations
  in the sessions are chosen to sit at the bottom of a band.
- **N5** The continuous loop republishes the current state about once a second. A republish is an
  actuator send >= 0.7 s into its state's loop (loop start = the sequencer's StateTransition publish,
  via the fake Elodin) carrying the state's full column; it is dropped from the event list. Windows
  marked for it print a summary instead: the period floored to 1 s (the 100 x 10 ms loop runs at
  ~1.0 s on Linux, ~1.2 s on macOS and up to ~1.6 s on this machine under load), the first tick's
  age when the state was entered in that window, and the distinct contents. The tick count is not
  frozen. Such a window does not end on a timer: `Session.settle()` ends it `SETTLE_TAIL` (200 ms)
  after the second complete tick round of whatever state the rig has landed in (after ABORT_DONE,
  for an abort), so its ticks are fixed and the next command is ~0.8 s clear of the next tick. The
  tail must exceed the 60 ms boundary lookahead: at 50 ms, on Linux under load, the next command's
  transition publish arrived within 60 ms of the tick, the tick was taken for that state's entry,
  and it showed up as an extra `+4s` command with the summary's `every` lost.
- **N6** Service logs are written by several threads with no line atomicity, so lines can come
  out spliced (seen in the 3x runs). Only two things are frozen: the sequencer's load-time verdicts
  (printed by `init()` before its other threads talk: fire/flow/script verdicts, warnings, refusals),
  and a count of each run-time message in `SEQ_FACTS` / `CTL_FACTS` — phrases that are one string
  literal in the source, hence one write — e.g. how many FIRE_START attempts, retries, ACKs and
  refusals happened. Work paths become `<WORK>`.
- **N7** PWM sends with one content < 100 ms apart (the controller's 100 Hz loop under a test duty)
  are one line with their period (median gap, floored to 10 ms) and whether they stopped inside the
  window or were still running when the harness moved on. Neither the count nor the stop time is
  frozen: the stream stops within one period of the event that stops it, which is frozen itself.
  A stream packet continuing a stream that was running when a window opened belongs to that
  stream, already recorded where it started, and is not listed again.
  **N7b**: a stream packet repeating within 50 ms after the close command (the loop's straggler,
  see below) is dropped.

Goldens are recorded on macOS (darwin-arm64). N4/N5 are chosen so Linux timing should land in the
same buckets, but that has not been verified.

## Found while characterizing (frozen as found, not fixed)

- Entering a dynamic state that was refused at load **deadlocks the sequencer's command worker**
  whenever Elodin is connected (always, on the stand): `doTransitionTo` holds `config_mutex_` while
  calling `publishState()`, which locks it again. Every later command (aborts included) waits the
  10 s command timeout and fails. `digital-twin__scripts-load` freezes it.
- An abort entry applies its column with `is_transition=false`, which does not bump the stage
  generation: a delayed stage of the state being left still lands after the abort's batch
  (`default__aborts`, Fuel Press +0.2 s after Engine Abort).
- With `sequencer_owns_valves = true` the Fire column still skips the PWM-assigned roles, so nobody
  commands them during the burn (`default__fire-sequencer-owns-valves`).
- controller_service does not strip `\r`: `FIRE_START\r\n` is `ERR` (the sequencer trims it). With
  unresolved PWM roles it refuses with "fire gate disabled (sequencer owns the valves)", which names
  the wrong cause (`controller__unresolved-pwm`).

- A dynamic state's timeout is armed twice — as a hold rule (`HoldTimer`) and as the
  `ScriptRunner`'s own deadline, both `script_timeout_ms` — and both fire. The loser's transition
  arrives second: into a timeout target that may transition to itself (Vent), the state is
  re-entered and its column re-sent, in some runs and not others. The session lands Script
  Timeout in a state with no self-transition, where the second one is refused, to stay
  deterministic.

- controller_service can send one more stream packet (the test duty) *after* its FIRE_STOP close
  command: the 100 Hz loop read "active" before `setFireActive(false)` sent the zero (N7b).

## Proven to fail

Applied one at a time to the source, the four turned their sessions red (and `default/entry/Idle`,
run alongside as a control, stayed green); each was reverted:

| break | session that went red | the line that moved |
|---|---|---|
| transition cell: digital-twin `Fuel Tank Vent -> Vent` 1 -> 0 | `digital-twin/matrix` | `Fuel Tank Vent -> Vent: OK` -> `ERR:transition rejected` |
| actuator delay: default `Fuel Fill Press` in Fuel Fill 0.2 -> 0.25 | `default/entry/Fuel Fill` | `+200ms` -> `+250ms` |
| swapped order within one state: `triggerAbort()` moved below `applyForState()` in `doTransitionTo` | `default/entry/Engine Abort` | `first datagram: ABORT` -> `ACTUATOR_COMMAND` |
| TCP reply: `ERR:not in FIRE state` -> `ERR:not in fire state` | `default/malformed` | the reply line |
| a role on the wrong board: default `"LOX Main" = ["NC", 1, 12]` -> board 14 | `default/entry/Fire`, `default/entry/Idle` | `to board 12: ... ch1=0[LOX Main]` -> `to board 14: ...` |

## What each rule hides, and why it is allowed to

| rule | hides | concurrency it absorbs (code) | still visible, proven by |
|---|---|---|---|
| N1 | clock bytes 2..5 | n/a — a clock | — |
| (none) | nothing about boards: the destination is part of every send's identity and canonical key | — | wrong-board mutation went red |
| N2 | retransmit count is kept; only the repeat lines | `ActuatorCommander::sendBatch` 3 rounds, `AbortBroadcaster::sendPacket` 4 repeats | xN is frozen |
| N3a | the gap between identical sends (count kept as xK) | apply on the worker vs the loop's first pass on `loop_thread_` (`startContinuousLoop`); the two `triggerAbort()` calls | K frozen |
| N3c | whether the loop's first pass came before or after a ~1 ms stage | `loop_thread_` vs the stage thread over `pending_roles_` | every pair still frozen; delay mutation still red |
| N3b | arrival order inside one time bucket | stage thread (`applyForState`'s detached `std::thread`) vs `loop_thread_` vs the worker's second `triggerAbort()` vs controller_service's process; no defined order between them | the ordered guarantee is `first datagram`: abort-order swap went red |
| N4 | sub-bucket timing | sleeps only overshoot: `HoldTimer`, ScriptRunner `wait_until`, `AbortBroadcaster::waitAndSendAbortDone` (50 ms steps) | staged delays keep 50 ms: delay 0.2 -> 0.25 went red |
| N5 | republish count and exact phase (content and period kept) | `loop_thread_` runs on its own 100 x 10 ms clock | its content is frozen per summary window |
| N6 | log line text after start-up | multi-threaded `std::cout`, no line atomicity | counts of each hand-off message |
| N7 | PWM stream packet count and stop time (content, period kept) | `ControllerService::controllerLoop` 100 Hz thread | the close command and its time are frozen |
| N7b | one stream packet landing after the close | controllerLoop vs the control-server thread's `setFireActive(false)` | reported as a defect; never an actuator command, only a PWM repeat of an already-frozen stream |

No rule drops a distinct actuator command except N5's repeats of the current column (frozen as
content) and N7/N7b's repeats of a PWM stream (frozen as content).
