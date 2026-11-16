# STYLE S8–S14, round 1 — Advocate B: keep running, degrade loudly

Paths relative to `daq-server/diablo_server/` unless prefixed `firmware/` or `deploy/`; lines on
`backend-remastered` @ `85a02f9a`.

## The case

**A server process exiting is invisible to the stand's safety layer.** The only independent
safety layer is the boards: `heartbeatTimedOut()` at 5000 ms
(`firmware/Actuator_Board/ActuatorCon_Hotfire/src/main.cpp:365-370`,
`firmware/Hotfire_Code/common/actuator_config.h:10`) drives CONNECTION_LOSS_DETECTED →
NO_CONNECTION_ABORT / STANDALONE_ABORT (`main.cpp:475-498`) with no server at all. It watches
heartbeat *absence*, and `heartbeat_service` strokes it whether or not the sequencer can abort
(D-HB; teststand-architecture Idea 3). A server exit buys no safety: the boards do not notice, and
what is lost is what the operator needs — telemetry (a backend bounce hits "every
operator's GUI mid-run", `daq-server/CLAUDE.md:74`) and the commanded-abort path (`:9998` →
worker → `triggerAbort`, on the sequencer's own thread).

**Main already chose "stay up" where it was designed with care**: the crash guards keep the
backend alive (`backend/src/server.ts:1823-1829`); the worker catches a throwing command, logs
it and still fulfils the promise
(`services/sequencer/SequencerService.cpp:94-105`); heartbeat says it in a comment — "Not fatal:
a heartbeat on an unknown interface beats none" (`services/heartbeat/heartbeat_service_main.cpp:244-252`);
the outbox degrades *resolution*, never *time*, and never drops an abort notification
(`backend/src/client-outbox.ts:1-35`).

**"Fail fast" on this stand is a 5-second flap.** Every C++ service unit but `sensor-t7` is
`Restart=always`, `RestartSec=5` (`deploy/systemd/*.service`); `sensor-elodin.service:5` calls
that "an invisible spin" only `systemctl --user --failed` sees. Nothing on the GUI detects a dead
service — C6-3 (heartbeat loss undetected, daq_bridge never takes over) is fail-fast's own D-SUB.
C6-9 (calibration exits 1 when Elodin is not up yet) is fatal-on-transient.

**Where main is wrong is not that it keeps running; it is that it keeps running silently.**
D-SUB: an accepted-dead subscription shows nothing because `dataFresh` is one global bit
(`server.ts:737-738, 1549`) that one dead channel in a hundred never flips. D-SLOT: one stderr line
at startup (`lib/src/config/Config.cpp:49-53`), then a live pressure channel is stolen with no flag
anywhere an operator looks. D-CTL: one stderr line (`services/controller/controller_main.cpp:142-147`),
then a controller with no fire gate reports nothing. Stacklight's UNKNOWN is all lights plus
buzzer (`services/stacklight/stacklight_service_main.cpp:85-91`), but only at boot: on Elodin loss
it reconnects (`:103-128`) showing the last state, since `g_seq_state` is written only on receipt
(`:34,133`). Each "loud" half is one log line; nobody reads
stderr during a hot fire.

**Loud, operationally** (what separates this position from main): a fault is (a) a *state*
until cleared, not an event; (b) on a surface the operator watches — the keyed NOTIFICATION with
`ongoing: true` that `markStaleBoards` uses for "connection lost" (`server.ts:647-701`), the
connection-status badge, the stacklight; (c) scoped to the failed part, isolated while the rest
keeps its duties. D-SUB loud = per-pair `lastDeliveredMs` plus a keyed notification, verdict only
with a positive sibling or DB signal, never a blind re-send (C6-2; subscription-robustness Idea 4).

**Concessions.** D-SLOT is fail-closed: a wrong slot steals a channel *while data flows*, so no
liveness flag catches it (subscription-robustness Q2) — S11 stays. D-CTL is a startup failure of
the duty the service exists for (control thread at `controller_main.cpp:500`, after `initialize()`
at `:462`, before any FIRE is possible), so S11's exit applies there too. The
line is **time of detection**: during startup, before the service begins its duty, on a fault no
retry heals → exit, with a code the unit will not loop on. Once in duty, or anything transient →
never fatal.

## Rules (S8–S14 rewritten; direction only, per S8)

**S8 — unchanged.** The refactor preserves every failure mode (D17, AGENT-RULES 6).

**S9 — Catch only where input enters, and a boundary catch isolates one unit of work.**
Boundaries as today (WP6 §4.3, the C++ list). A boundary catch ends one message, command, row,
request or client — never the process, never the thread serving the others: model
`SequencerService.cpp:94-105` (log, fulfil the promise, next command). Inner modules do not
catch-and-log unless the catch *is* a decision. Spans move verbatim.

**S10 — Every request gets exactly one answer; silence and exit are both non-answers.** A failed
request is answered with a failure (`ERROR`, 500, `ERR:<reason>`), never left hanging (D-API3),
never turned into an exit. An accepted subscription delivers or is reported dead on an operator
surface (D-SUB).

**S11 — Fail fast only during startup, before the service begins its duty, on a fault no retry
can heal.** One stderr line with the tag, then exit with a status the unit does not restart-loop
on (in-tree precedent `deploy/systemd/sensor-t7.service:21-22`; cpp-service-plumbing §4's exit 78).
**Once in duty, and for any transient (Elodin down, NIC not up, a
peer gone), a fault is never fatal:** the service keeps its other duties, marks the failing part
faulted, retries at a bounded interval (model: stacklight's 2 s reconnect; counter-model: C6-9).

**S12 — Preserved behaviour is explicit**, and **a kept degraded path names its loud
half at the site**: `// Kept: <id> (D17); loud half: <surface>`.

**S13 — Exit codes** as today. **No new exit path after startup**: helpers return status; only
`main` exits, in its startup block.

**S14 — Keep a seam's error style; a fault is a value that crosses the seam.** Status seams keep
returning status (`{ok, reply}`, `bool` + `refusal_reason`); a new seam returns its fault as data
the caller can publish — models WP8 §2.3 `TcpListener::Failed`, §2.5 `ConfigFileChoice{found,
fell_back}`. No exception crosses such a seam; no seam reports a fault only in a log.

**S14a (new) — Every degraded part has a keyed, ongoing operator status, and the safety layer
never depends on a service choosing to exit.** A fault that outlives the request that found it is
a keyed status (`ongoing: true`) until cleared, on an operator surface — model
`markStaleBoards` → `broadcastNotification` (`server.ts:661-701`). The boards' watchdog is the
safety layer; the direction for D-HB is that SERVER_HEARTBEAT reflects the liveness of the abort
path, so a wedged sequencer becomes a board NO_CONNECTION_ABORT within 5 s — accepting that a
software stall during a hold then aborts the stand (PROPOSAL; teststand-architecture Idea 3a, Q2).

## Objections

**1. "Stay-up is exactly what produced D-SLOT, C2-4 and D-CTL. A service on defaults is a lie."**
Those are stay-up-*silent*, and all three are startup faults conceded to S11's exit. The
disagreement is confined to run time and transients, where the alternative is a 5 s restart
(`Restart=always`) the GUI cannot see (C6-3) and that, for the sequencer, re-sends the boot-state
actuator batch inside `init` (`SequencerService.cpp:609`) — a restart is itself a valve-moving event.

**2. "A C4-1-wedged sequencer should die so systemd brings it back."** C4-1 is a self-deadlock:
no exception fires, so no catch policy exits it, and SIGTERM does not either (Defects C4-1). Killing
it externally re-runs the boot batch (objection 1). What
keeps the stand safe during the wedge is the boards' layer, defeated today because the heartbeat
keeps flowing (D-HB). The fix that matters is S14a's direction, not exit.

**3. "Node discourages `uncaughtException` guards; process state after one is undefined, so
`server.ts:1823-1829` masks bugs."** Conceded: the guard is a last resort; S9's boundaries keep it
unreached. But its alternative bounces every operator GUI (`daq-server/CLAUDE.md:74`), and the
guard has only half of what this position asks: a tagged log, no keyed status saying "the backend
has swallowed an error since <t>". Under S14a that becomes a notification, not `process.exit`.
