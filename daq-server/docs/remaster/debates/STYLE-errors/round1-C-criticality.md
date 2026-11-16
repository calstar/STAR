# STYLE S8–S14 debate — round 1, advocate C: criticality classes, errors as values

Anchors: 85a02f9a, paths under `daq-server/diablo_server/`.

## The case

The tree runs four error policies, unnamed, sometimes inside one function.
`lib/src/config/Config.cpp:446-452` returns defaults on `toml::parse_error` (C2-4) yet rethrows
`std::invalid_argument` — SIGABRT in config_broadcast, exit 1 in daq_bridge
(`daq_bridge_main.cpp:360-362`; C2-12). Elodin absent is `return 1` in calibration
(`calibration_main.cpp:1545`, C6-9), a 5 s reconnect loop in daq_bridge (`:745-754`), a 20×100 ms
retry in `ControllerService.cpp:139`. A failed listener is exit 1 in the sequencer and a controller
with no fire gate (D-CTL, WP8 §2.3).

Some sites already state a *class* rule in prose. `AbortBroadcaster.cpp:91-96,98-100,108-121`:
continue unpinned ("still beats no abort"), bound every send at 100 ms, repeats independent, log
after sending. `heartbeat_service_main.cpp:240-244`: "a heartbeat on an unknown interface beats
none" — so D-BIND is class-consistent there. `PressureFeed.hpp:36-47`: refuse rather than return a
plausible zero (control). `server.ts:1823-1829`: live through anything uncaught (observation).

A uniform rule cannot tell C6-9 (fatal on a transient, in a service that only observes) from D-SLOT
(a config error that steals a live pressure channel merely warns, `Config.cpp:49-53`). Named classes
can. The split is IEC 61511's (`teststand-architecture` Idea 3): the boards' 5 s watchdog is the SIS,
the server is BPCS, and the server-side **safety path** is whatever feeds or gates the SIS.

## Classification (rows are paths; a process may hold several)

| path (process) | class | startup | runtime | frozen by / violators (parked) |
|---|---|---|---|---|
| ABORT/ABORT_DONE broadcast; SERVER_HEARTBEAT (heartbeat, daq_bridge); abort-column batch (`ActuatorCommander::sendBatch`); FIRE_STOP/PWM close; ACTUATOR_CONFIG thresholds (config_broadcast, C1-7) | **safety** | exit 1 only when the boards are unreachable (invalid broadcast IP: heartbeat `:259-262`, sequencer `init`, WP10 §1.6) | never block, throw or exit mid-send; bounded sends; independent repeats; degraded beats none; never wait on control | packets `service_abort.txt`, sequencer N3a/N5, lifecycle hbloss / C4-1 (zero ABORT datagrams while wedged), D-HB, D-EINTR, C1-10, C1-9 |
| `SequencerService` worker, `StateMachine`, `ScriptRunner`, `HoldTimer`, `PressureFeed`, `ControllerService` loop, TCP :9998/:9999 | **control** | exit 1 on config that changes what a valve does or where a table lands (CSVs, NIC; D-SLOT only warns) | refuse as a value with a reason; a refusal leaves the rig unchanged (`SequencerService.cpp:710-730`) | sequencer goldens, `digital-twin__scripts-load.txt`, `default__aborts.txt` / C4-1, C4-3, D-CTL, D-SLOT, C2-12 |
| daq_bridge ingest, calibration, backend WS/HTTP, vtable registry, stacklight, t7_bridge | **observation** | start; a missing dependency is retried, never fatal | drop the row, keep the stream; one answer per request; a silent subscription is reported | pipeline, lifecycle `reconnect/shutdown.txt`, calibration / C6-9, D-SUB, D-API3, C6-3, C6-4, C6-1 |
| ota_service, `/api/ota-flash` | **tooling** | exit 1 on bad argv/port | fail per request, reply `ERR:`, process lives; never touches the safety path | lifecycle ota / C6-10, D-OTA, D-OTA2, D-FORK |

The parked column is the LEDGER's proposals list read by class — the direction for team fixes:
out-of-band abort (abort-statemachines 2b) and heartbeat-only-while-alive are "safety never waits on
control"; `cancelPendingStages` and the C4-1 hoist, "a step leaves the rig defined"; exit 78 +
`RestartPreventExitStatus`, "control fails fast on config"; the D-SUB watchdog, "observation
degrades".

## Proposed S8–S14

**S8 — The refactor preserves every failure mode.** Unchanged (D17, AGENT-RULES 6); S9–S14 describe
new structure and the direction of golden-first, team-approved fixes, never a refactor edit.

**S9 — Every path carries a criticality class, and the class decides its policy.** Per the table (in
STYLE, not code). A new header or module names its class in the S36 doc comment; a kept defect site
reads `// Kept: <id> (D17) — <class rule it violates>`. That is the whole code footprint: no knob, no
type (S34).

**S10 — Inside a process errors are values; only the input boundary turns a value into policy.**
Seams that return status keep doing so and grow no exception: `SequencerService` `bool` +
`refusal_reason` after `ERR:` (WP10 §1.6), `PressureFeed::Status` + `explain` (`PressureFeed.hpp:50-56,83`),
`TcpListener::Failed`, `ConfigFileChoice` (WP8 §2.3, §2.5), `{ok, reply}` (`server.ts:1411-1418`),
`noteSubscriptionRejected` (`elodin-vtable-registry.ts:136`). Catch only where input enters (WP6
§4.3, a TCP reader, an Elodin read loop, `main`'s startup, the command worker
`SequencerService.cpp:94-105`); inner code catches only when the catch *is* a decision. A try/catch
moves with its body, span unchanged.

**S11 — Safety path: never block, never throw, never exit mid-send; degraded beats none.** Sends are
bounded (`SO_SNDTIMEO`), repeats independent, the log line follows the datagram; the path never waits
on a lock, a join or a control step. Fail fast at startup only when the boards cannot be reached or
the SIS's thresholds cannot be loaded. Kept violations: C4-1 (the broadcast runs on the wedged
worker), C1-10, D-EINTR, D-HB.

**S12 — Control path: refuse with a reason, leave the rig where it was, fail fast on config that
moves a valve.** A refusal is a value the operator reads; a step holds no lock across publish or I/O
(S23). Config that changes a commanded position, a threshold or a table id is exit 1 before any
socket opens, one stderr line with the tag; a transiently absent dependency is not config. Kept:
D-SLOT (`Config.cpp:49-53`), D-CTL (`controller_main.cpp:147`), C2-4, C2-12. Direction: a status a
unit can refuse to restart — every C++ unit is `Restart=always RestartSec=5` except
`sensor-t7.service:21-22` (`RestartPreventExitStatus=2 3`), so code and unit change together
(cpp-service-plumbing §4).

**S13 — Observation and tooling: degrade and keep running; every request gets exactly one answer;
every accepted subscription delivers or is reported.** Drop the row, keep the stream; retry the
dependency (daq_bridge `:745-754` is the model; C6-9 the kept counter-example).
Kept: D-API3 (`api-server.ts:397-398` and ~40 more; `sendJson` only on literal bodies, D39),
`registerVTables(...).then` without `.catch` (`server.ts:1508,1590`), D-SUB, C6-10. Tooling fails per
request with `ERR:`.

**S14 — Preserved behaviour is explicit; exit codes are frozen.** Where shared code serves services of
different classes, each service's behaviour is a named setting at its call site (WP8 §2.1
`ShutdownNotice`/`Sigpipe`; `TcpListener::Failed` returned to the caller who decides). Exit 0 on clean
stop and `--help`, 1 on startup failure; frozen exceptions as WP8 §4. Helpers return status; only
`main` exits.

## Objections I expect

**1. "A table in STYLE is documentation that drifts; nothing checks it."** Partly conceded: the gate
cannot read a class. The check is D17(c)'s design review diffing each S36 doc comment against the
table; a path with no class fails review. No abstraction is added (S34).

**2. "Classes blur: the abort is sent by the control worker; heartbeat_service both follows state
and strokes the watchdog."** The blur sites are the lead defects: C4-1 is control blocking safety
(abort-statemachines Idea 1); D-HB is the safety stroke ignoring control liveness. Rows per path let
the `// Kept` tag name the violated rule, and make 2b and heartbeat-only-while-alive class fixes
rather than taste. Conceded: the refactor can only label, never re-class.

**3. "This is uniform fail-fast glued to uniform degrade, and S8 forbids applying it now."** Both
halves conceded. Fail-fast is right for control config (D-SLOT) and wrong for observation
(C6-9); degrade is right for observation (D-SUB) and wrong for a config error that steals a pressure
channel. No single rule survives both. What the remaster gets today: the `// Kept` tags and a
per-class list of characterization gaps (abort-statemachines "structural choices" item 6,
cpp-service-plumbing §6), so each later fix is "these golden lines, and only these".
