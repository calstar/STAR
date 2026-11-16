# Research: test-stand command architecture (DAQ → sequencer → actuator)

Topic: how mature flight-software, ground-segment, robotics and industrial-control stacks structure
the path from a measurement to a valve command, and to an abort; what that says about
`daq_bridge`, `sequencer_service`, `controller_service`, `AbortBroadcaster`, `ActuatorCommander`
and the WP8/WP10 designs.

Anchors are on `backend-remastered` @ `85a02f9a` (product code = `main` @ `15b5a0c5`); paths are
relative to `daq-server/diablo_server/` unless they start with `firmware/` or `docs/`.

**Verdict up front.** None of the five ideas below is a behaviour-preserving remaster change: every
one of them, applied to code, moves a frozen golden (D5) or fixes a frozen defect (C4-1, C4-3, C1-9,
C1-10, C6-3, D-SUB). What the remaster *can* adopt is vocabulary in the WP10 note and proposed
characterization cases (design only, like DESIGN-WP8 §7.2). Everything else is a **PROPOSAL** for
the team, to be argued after the remaster ships.

## How our path looks today (one paragraph, for the mapping)

Boards → UDP → `daq_bridge` (single thread, `daq_bridge/daq_bridge_main.cpp:608-1067`) → Elodin
tables. Operator → GUI → backend → TCP `:9998` (`backend/src/server.ts:75`) → `sequencer_main` line
server → `SequencerService::transitionTo` → `enqueueAndWait` (10 s,
`services/sequencer/SequencerService.cpp:109-129`) → worker `doTransitionTo` (`:666-938`) →
`AbortBroadcaster::triggerAbort` (first, `:794-795`) and `ActuatorCommander::applyForState`
(`:835`) → `sendBatch`, 3 blind rounds (`services/sequencer/ActuatorCommander.cpp:368-386`) → boards.
Fire → `notifyControllerFire` → TCP `:9999` → `ControllerService::setFireActive` → PWM. The only
closed loops are `PressureFeed` (script reads, `lib/include/control/PressureFeed.hpp:30-83`) and the
boards' own watchdog (`firmware/Actuator_Board/ActuatorCon_Hotfire/src/main.cpp:365-370`,
`HEARTBEAT_TIMEOUT_MS 5000` in `firmware/Hotfire_Code/common/actuator_config.h:10`). I found **no
server-side redline or automatic abort**: every abort is operator-commanded or board-originated
(PT abort / NO_CONNECTION_ABORT / STANDALONE_ABORT, same file `:165-190, 458-498`).

---

## Idea 1 — A command is a request with a guaranteed, staged response

**What it is.**
- F Prime: commands go through a command dispatcher that "receives the raw buffer … the command
  opcode is extracted, and a lookup table is used to find the handling component … and the command
  dispatcher waits without blocking for the component to return status"
  ([F´ commands/events](https://fprime.jpl.nasa.gov/latest/docs/user-manual/overview/04-cmd-evt-chn-prm)).
  It is the "callback port" pattern: request out, response in on a separate port, so the requester
  never blocks ([F´ common port patterns](https://fprime.jpl.nasa.gov/latest/docs/user-manual/design-patterns/common-port-patterns/)).
- Yamcs: every command walks Queued (`Q`) → transmission constraints → Released (`R`) → Sent (`S`)
  → verifier stages, each stamped into command history
  ([Yamcs command processing](https://docs.yamcs.org/yamcs-server-manual/processors/command-processing/),
  [Yamcs TC overview](https://docs.yamcs.org/yamcs-server-manual/tc/)): "constraints are checked
  before issuing a command and the verifiers are run after … to verify the different stages".
- OpenC3 COSMOS: a `VALIDATOR` class with `pre_check` / `post_check`, each returning
  true / false / nil(unknown) plus a message ([COSMOS command config](https://docs.openc3.com/docs/configuration/command)).

**How it maps onto ours.**
- Our reply is a single bit plus a reason, produced *by the worker*: `enqueueAndWait` blocks the
  connection thread up to 10 s and on timeout says "command timed out … reporting failure (it may
  still run)" (`SequencerService.cpp:120-125`). That message is exactly the case the Yamcs model
  exists to make impossible: the reply is not "failed", it is "unknown", and the operator cannot
  tell which. C4-1 is the worst instance — after one refused dynamic-state entry
  (`SequencerService.cpp:716-730`, `publishState()` under `config_mutex_`), every later command,
  aborts included, returns this "unknown-as-failure". Frozen by
  `test/characterization/sequencer/golden/digital-twin__scripts-load.txt`.
- `ActuatorCommander::sendBatch` (`ActuatorCommander.cpp:368-386`) is "Sent" with no verifier: the
  log `Sent <n> commands for state <s>` is the only acknowledgement, and the boards' commanded vs.
  actual position (the `[0x32/0x35, ch]` tables, `publishCommandedState` `:794-827`) is never
  compared. Same for `AbortBroadcaster::sendPacket` (`services/sequencer/AbortBroadcaster.cpp:106-133`:
  `delivered/kBroadcastRepeats` counts `sendto` successes, not board receipt) and for C1-9: no
  stage of the abort lifecycle ever *requires* CLEAR_ABORT, so nothing notices it is never sent.
- `PressureFeed::read`'s `Status` (`PressureFeed.hpp:50-56`) is already a transmission constraint
  in Yamcs's sense, with the refusal text reaching the operator through `refusal_reason`
  (WP10 §1.6). It is the one place we already do this well.

**Cost.** A command-history record (id, Q/R/S/verified, reason) per command means a new Elodin
table or a new WS message shape (contract change), a verifier per actuator role reading the
board's reported state, and a defined "unknown" reply on the `:9998` line protocol.

**Adoptable in the remaster?** No — every piece changes a reply string, a log, or adds a stream.
PROPOSAL. Remaster-side, only: WP10's note could name `enqueueAndWait`'s timeout reply as
"outcome unknown" so the C4-1 paragraph says what the operator actually sees. Characterization
already pins the timeout text; a proposed case (design only): a `sequencer` session that sends a
command while the worker is wedged and records the reply latency (10 s) — it would make the
C4-1 golden's consequence explicit rather than implied.

---

## Idea 2 — Staged valve actions need an explicit qualifier: SFC `D` vs `SD`

**What it is.** IEC 61131-3 Sequential Function Charts attach actions to steps with a qualifier.
`D` (time-delayed): "a delay timer is started when the step becomes active. If the step is still
active after the time delay, the action will start … if the step is active shorter than the fixed
delay time the action does not become active." `SD` (stored and time-delayed): the action is set
"when the fixed delay time has elapsed after the step activation, **even if the step becomes
inactive**" ([Schneider Machine Expert, SFC qualifiers](https://product-help.schneider-electric.com/Machine%20Expert/V2.1/en/SoMProg/SoMProg/D-SE-0083504.html);
[PLCnext, action qualifiers](https://engineer.plcnext.help/latest/Action_ActionQualifier_SFC.htm)).
F Prime's "synchronous cancel" pattern is the same idea in threads: a cancel flag set
synchronously, polled by the long-running handler, "operated on atomically"
([F´ common port patterns](https://fprime.jpl.nasa.gov/latest/docs/user-manual/design-patterns/common-port-patterns/)).

**How it maps onto ours.** Our delays CSV stages are `D` for every normal transition and `SD` for
an abort, and nobody chose that:
- The stage thread (`ActuatorCommander.cpp:592-606`) polls `schedule_gen_` every 1 ms and returns
  when it changes — that is `D` with F Prime's synchronous-cancel flag.
- But the generation only advances when `is_transition` is true (`:462`), and `doTransitionTo`
  passes `!isAbortState(to)` (`SequencerService.cpp:835`). Entering an abort therefore does *not*
  deactivate the previous step's delayed actions; they behave as `SD`. That is C4-3, frozen by
  `test/characterization/sequencer/golden/default__aborts*` (Fuel Press +0.2 s after Engine Abort).
- The 1 Hz republish (`startContinuousLoop`, `:613-666`) is the PLC scan's "write outputs" phase —
  it re-asserts settled positions. Unlike a scan, it is not the *only* writer: stage threads,
  scripts (`ScriptRunner`), manual overrides and the abort path all write directly. In a scan model
  a stale stage could not land after the abort because the abort step would own the output image
  on the next scan ([PLC scan cycle](https://automationprimer.com/2016/01/08/ladder-logic-105-plc-scanning/)).

**Cost.** The fix is one argument (`is_transition=true` for aborts, or bump the generation on abort
entry) — but it removes a line from `default__aborts`, which D20/AGENT-RULES §5 treat as a contract
change. A full "single writer per scan" redesign is a rewrite of `ActuatorCommander`.

**Adoptable in the remaster?** No (C4-3 is frozen). PROPOSAL: "abort entry cancels pending stages
(SFC `D` semantics for every step)". Remaster-side: WP10 §2.4's "must not change … the
staging/generation logic" could state the qualifier explicitly ("stages are D on transition, SD on
abort entry; C4-3") so the move-only reviewer sees the asymmetry is the defect, not an accident of
the split. `abort_ordering` ctest guards only the ABORT-first timing (< 200 ms), not the late stage.

---

## Idea 3 — Keep the safety layer independent of the control layer (SIS vs BPCS; F´ Health)

**What it is.**
- IEC 61511-1 §11.2.4: the basic process control system "shall be designed to be separate and
  independent to the extent that the functional integrity of the SIS is not compromised"; layers
  must be independent and fail to the safe state on loss of power or support systems
  ([Emerson, separation between control and safety](https://www.emersonautomationexperts.com/?p=44162);
  [ARC, functional safety separation or integration](https://www.arcweb.com/industry-best-practices/functional-safety-separation-integration)).
- F Prime `Svc::Health` pings every active component each cycle, escalates WARNING → FATAL on
  missed pings, and "shall stroke a watchdog port while all ping replies are within their limit"
  ([F´ Health SDD](https://fprime.jpl.nasa.gov/devel/Svc/Health/docs/sdd/)) — liveness is
  *proved*, not assumed, and the hardware watchdog is the independent layer.

**How it maps onto ours.**
- Our SIS is the boards: `heartbeatTimedOut()` (`firmware/Actuator_Board/ActuatorCon_Hotfire/src/main.cpp:365-370`,
  5000 ms) drives NO_CONNECTION_ABORT / PT abort / STANDALONE_ABORT without any server. That is the
  right shape and should be named as the stand's last line of defence (the comment at
  `SequencerService.cpp:780-790` already says so).
- Our BPCS is everything on the server, and `SERVER_HEARTBEAT` is its watchdog stroke. But the
  stroke is not tied to health: `daq_bridge` sends it when `send_from_daq_bridge`
  (`daq_bridge/daq_bridge_main.cpp:130, 493`) or `heartbeat_service` does — neither checks that the
  sequencer worker is alive. A C4-1-wedged sequencer keeps the boards fed with heartbeats, so the
  board SIS never trips while the server cannot abort. In F´ terms, the watchdog is stroked without
  pinging the component that matters. C6-3 (heartbeat loss undetected, daq_bridge never takes over)
  is the mirror image on the server side.
- `AbortBroadcaster` firing first and "before taking any lock" (`AbortBroadcaster.cpp:138-140`;
  `SequencerService.cpp:780-795`) is the correct BPCS-side ordering; C1-10 (sent twice: 8 ABORT,
  4 ABORT_DONE, `service_abort.txt`) shows the abort is a side effect of transition bookkeeping
  rather than its own component.
- There is no server-side redline layer at all (grep of `services/`, `lib/src`, `backend/src`).
  COSMOS has `LIMITS_RESPONSE`, a class "called when the limits state of the current item changes"
  ([COSMOS telemetry config](https://docs.openc3.com/docs/configuration/telemetry)); that is a
  BPCS feature, and correctly so — it must not be mistaken for the SIS.

**Cost.** Health-gated heartbeat: the sequencer would publish a liveness counter that
`heartbeat_service`/`daq_bridge` checks before stroking — a new Elodin table and a change to when
SERVER_HEARTBEAT stops (board behaviour changes). Redlines: a new config section and abort source.

**Adoptable in the remaster?** No. PROPOSAL: (a) gate SERVER_HEARTBEAT on sequencer worker
liveness, so a wedged sequencer becomes a board NO_CONNECTION_ABORT within 5 s; (b) make abort its
own path, not a step of `doTransitionTo` (fixes C1-10 by construction); (c) any redline layer is
BPCS and sits beside, never instead of, the board watchdog. Remaster-side: WP8 §0 already keeps
`AbortBroadcaster`'s socket-per-send lifetime — correct; do not let an RAII `UdpSender` couple it to
the commander's lifetime.

---

## Idea 4 — Explicit lifecycle states (ROS 2 managed nodes)

**What it is.** ROS 2 managed nodes have primary states Unconfigured / Inactive / Active / Finalized
and transition states Configuring, Activating, Deactivating, CleaningUp, ShuttingDown,
ErrorProcessing; configure does one-time setup (subscriptions), activate acquires what is "only held
while the node is actually active", and `onError` "must provide the cleanup of both onDeactivate and
onCleanup" when entered from Active ([ROS 2 node lifecycle design](https://design.ros2.org/articles/node_lifecycle.html);
[rclcpp lifecycle demo](https://docs.ros.org/en/humble/p/lifecycle)). A transition callback returns
SUCCESS, FAILURE (back to the previous primary state) or ERROR (to ErrorProcessing).

**How it maps onto ours.**
- `SequencerService::init` already runs configure → activate (WP10 §1.1: `applyConfig` →
  Elodin connect → `bootState` → `applyForState` → worker → "Initialized"), but "configured and not
  commanding" is not an observable state: the first actuator batch goes out inside `init`.
- `refused_states_` (`SequencerService.cpp:490-504`) is a per-state FAILURE result kept forever;
  C4-1 is what happens when the refusal path itself errors with no ErrorProcessing to fall into.
- Service-level lifecycle is what DESIGN-WP8 §0 rejected as `ServiceMain`: signal-install order is
  observable (a SIGTERM before installation exits -15, after it 0). That rejection is right under D17:
  a ROS-style lifecycle manager would own the order and change exit codes.

**Cost.** A lifecycle state per service on Elodin + a backend view of it; changes startup streams.

**Adoptable in the remaster?** No; and a weak proposal even for the team: our services are
single-purpose processes started by `dev.sh`/systemd, where process up/down already is the
lifecycle. The useful part is narrow — PROPOSAL: a "configured, not commanding" state for the
sequencer so a config reload or a boot can be inspected before the first batch.

---

## Idea 5 — A subscription must prove it is live (Open MCT, Yamcs, our own PressureFeed)

**What it is.** Open MCT's provider contract: `subscribe` "must return an unsubscribe function"
([Open MCT API.md](https://github.com/nasa/openmct/blob/master/API.md)), and the telemetry API has a
separate `subscribeToStaleness(domainObject, callback)` delivering `{isStale, timestamp}`
([Open MCT TelemetryAPI.js](https://github.com/nasa/openmct/blob/master/src/api/telemetry/TelemetryAPI.js)) —
staleness is a first-class, displayed signal, not inferred from silence. Yamcs transmission
constraints likewise wait "a configured interval" for telemetry before releasing a command
([Yamcs command processing](https://docs.yamcs.org/yamcs-server-manual/processors/command-processing/)).

**How it maps onto ours.**
- D-SUB: the backend retries only *refused* subscriptions (`backend/src/elodin-vtable-registry.ts:57,136`,
  `noteSubscriptionRejected`); an accepted subscription that delivers nothing is dead forever and
  the GUI shows no staleness. `PressureFeed` already does the right thing: it re-asks tables that
  have never delivered (`services/sequencer/PressureFeed.cpp:17-22, 80-114`) and refuses `Stale`
  readings older than `kMaxAgeMs = 1000` (`PressureFeed.hpp:90`). The fix pattern exists in-tree.
- D-SLOT: the uint8 table id wrap (`(slot-1)*0x20+ch`) means a mis-slotted board can *feed* a
  live channel; staleness detection would not catch it (data keeps arriving). That one needs a
  load-time refusal, not a liveness check.
- `ControllerService` subscribes 100 calibrated-PT tables + `[0x50,0x00]` with 20 × 100 ms retry
  (WP10 §3.4) and no never-delivered re-ask — the same D-SUB exposure on the closed-loop path.

**Cost.** Backend: per-table last-arrival tracking, a re-subscribe pass for never-delivered tables,
a staleness flag on the WS stream (new field = HTTP/WS shape change). Controller: port
PressureFeed's re-ask.

**Adoptable in the remaster?** No (WS shape and subscription stream change; D-SUB/D-SLOT are lead
defects for REPORT.md). PROPOSAL. Remaster-side: DESIGN-WP8 §0 rejected a generic
`SubscriberLoop` for good reasons; when D-SUB is fixed, PressureFeed's never-delivered re-ask is the
two-user candidate (PressureFeed + backend registry, or + ControllerService) that D17 would allow.

---

## What I looked at and rejected

- **F´ port kinds (sync/guarded/async) as a refactor target.** Our sequencer is already an
  "active component": one worker, a command queue, every `do*` body on the worker
  (`SequencerService.cpp:73-137`) — F´ `async_input` in all but name
  ([F´ ports/components](https://fprime.jpl.nasa.gov/v3.6.0/docs/user-manual/overview/port-comp-top/)).
  `enqueueDetached` from the hold-timer and script threads (`:864-882`) is F´'s rule that a
  component's own thread never blocks on its own queue. Nothing to adopt; worth naming in WP10 §1.2.
- **COSMOS hazardous/critical (two-person) commanding.** A GUI/operator-policy feature
  ([COSMOS command config](https://docs.openc3.com/docs/configuration/command)); out of the
  backend-remaster scope. Noted for the team only if Fire is ever sent remotely.
- **Open MCT as a GUI replacement.** Display layer only; our frontend tests are frozen.

## Questions for the debate advocates

1. C4-3: is "abort entry cancels pending stages" (SFC `D` everywhere) a **defect fix** or a
   **contract change**? `default__aborts` would lose the Fuel Press +0.2 s line. Who signs that?
2. Should SERVER_HEARTBEAT be **health-gated** on the sequencer worker (Idea 3a)? It turns a C4-1
   wedge into a board NO_CONNECTION_ABORT within 5 s — safer, but a new way for the stand to abort
   on a software stall during a hold. Is that the behaviour the team wants?
3. Who owns redlines: the boards (SIS, independent, slow to change) or the sequencer (BPCS,
   configurable)? Today neither has a configurable one beyond PT abort.
4. For `enqueueAndWait`'s 10 s timeout, is the right reply "ERR" (today), "UNKNOWN", or should
   abort bypass the queue entirely (abort as its own port, F´-style) so it cannot wait at all?
5. Is a command-history record (Yamcs Q/R/S + verifier) worth a new Elodin table, or is the
   existing `[0x43,0x00]` transition table + commanded-state tables enough if a verifier compares
   commanded vs. reported position?
6. D-SUB: fix in the backend registry alone, or extract PressureFeed's never-delivered re-ask as the
   shared piece WP8 deferred — and does ControllerService need it before the next hot fire?
