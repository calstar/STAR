# STYLE S8–S14 debate — round 2, advocate C: class × phase

Anchors: 85a02f9a, under `daq-server/diablo_server/`.

## A's weakest point: S11(c) "runtime invariant broken → stop; `Restart=always` restores it"

For the control path a restart is itself a valve-moving event. `SequencerService::init`
(`SequencerService.cpp:606-609`) commands the boot column with `is_transition=true` and starts the
republisher; `sensor-actuator.service:11-12` is `Restart=always RestartSec=5`. A stop mid-Fuel Press
commands the boot column five seconds later, unannounced. The boot batch is already an observable:
D35's `ACT_CMD.B2.CH7` history `{0}` is elodin-db replaying the sequencer's boot-time row. And the
wedge (c) is written for, C4-1, raises no exception and ignores SIGTERM (frozen in
`sequencer/golden/digital-twin__scripts-load.txt`): (c) has no trigger. B is right on both.

A's backend direction (exit non-zero, let `sensor-backend.service` restart) exits the only GUI
server: every client sees close 1006 (C6-5, `lifecycle/golden/shutdown.txt`) and the import-time
session singleton (`session-manager.ts:401`) is gone. A throw in one WS handler is one message (WP6
§4.3), not an invariant. Conceded: the guard's justification is stale (`server.ts:1818-1822`: `tsx
watch` is no longer used); the kept label must say so.

Not a disagreement: D-CTL/D-BIND at startup → exit 1, unit retries. All three agree.

## B's weakest point: one line (time of detection), one loud surface

config_broadcast re-reads `config.toml` every cycle: `buildPackets` at `:548` inside `while
(g_running)` (`:545`) calls `fsw::config::load`, which rethrows `invalid_argument`
(`Config.cpp:450-451`); nothing in the TU catches it (C2-12). A bad board id saved mid-run is a
SIGABRT *in duty*, then a 5 s loop on the same file — safety configuration (ACTUATOR_CONFIG carries
the boards' abort thresholds, C1-7) failing at runtime. B's S11 ("once in duty, never fatal") does
not say what to send meanwhile; A's S11(d) does — reject the re-read, keep the last validated config
— and is right *because* it is class-specific. B's own concessions (D-SLOT, D-CTL) already use class
as the proxy; the line is class × phase.

B's loud half is the keyed `ongoing` notification (`server.ts:661-701`) — an observation-class
surface that cannot report a backend fault; and B's stacklight finding (UNKNOWN only at boot,
`:85-91`; reconnect shows the last state, `:103-128`) shows no server-independent surface but the
boards. So the surface is per class: `ERR:` + `refusal_reason` for control (WP10 §1.6), stacklight
and the boards' watchdog for safety, the keyed notification for observation.

## Concessions

To A: "present and wrong defeats every absence detector" — the strongest sentence in the debate and
the whole case for fail-fast on control config (D-SLOT); S11(d); exit 78 + `RestartPreventExitStatus=78`
in every unit; `[[nodiscard]]` with `(void)` under `// Kept:` (D4); the injectivity test as adoptable
today; the stale guard comment.

To B: control never exits in duty; C4-1 is unexitable, so D-HB — not exit — covers a wedge; keyed
`ongoing` status for observation faults; "startup, before duty" as the fail-fast window in every
class; the loud half named at the `// Kept` site; C6-3 is fail-fast's own D-SUB, so an exit must be
visible (78 shows in `--failed`).

My own: I withdraw "D-BIND is class-consistent in heartbeat". The boards' watchdog is unarmed until
the first heartbeat (`last_server_heartbeat_ms == 0` → never timed out; firmware, via
`teststand-architecture` Idea 3), so a heartbeat exit *at startup* costs nothing and A's exit 1 is
right; "beats none" holds only in duty. B's point inside my safety class — hence the revised shape.

Shared by all three: D-HB is the precondition for every safety-related direction.

## Revised classification (class × phase)

| class (paths) | startup fault, before duty | fault in duty | loud surface | parked |
|---|---|---|---|---|
| **safety** — ABORT/ABORT_DONE, SERVER_HEARTBEAT, abort-column batch, FIRE_STOP/PWM close, ACTUATOR_CONFIG thresholds | exit 78 on config that makes the boards unreachable or a threshold wrong; exit 1 on socket/NIC (watchdog unarmed) | never exit or block; bounded independent sends; bad re-read rejected, last validated kept | stacklight; the boards (D-HB) | C4-1, C1-10, C1-9, D-EINTR, D-HB, C2-12 in duty |
| **control** — sequencer worker, state machine, scripts, PressureFeed, controller loop, :9998/:9999 | exit 78 on config that moves a valve or lands a table (D-SLOT, CSVs); exit 1 on bind (D-CTL) | refuse as a value with a reason; rig left where it was; never exit (restart = boot batch) | `ERR:` + `refusal_reason` | C4-1, C4-3, D-CTL, D-SLOT, C2-4 |
| **observation** — daq_bridge ingest, calibration, backend, registry, stacklight, t7 | transients retried, never fatal; exit 1 only on argv/port | drop the row, keep the stream; one answer per request; a dead subscription reported | keyed `ongoing` notification | C6-9, D-SUB, D-API3, C6-3, C6-4 |
| **tooling** — ota, `/api/ota-flash` | exit 1 on argv/port | fail per request, `ERR:`; never reaches safety or control | reply + log | C6-10, D-OTA, D-OTA2 |

## Revised S8–S14

**S8 — unchanged.** Every failure mode preserved (D17, AGENT-RULES 6); below is direction: golden
first, code and unit file in one team package.

**S9 — Every path carries a class and a phase, and the pair decides the policy.** Per the table.
A new header names its class (S36); a kept site reads `// Kept: <id> (D17) — <class/phase rule>;
loud half: <surface>`.

**S10 — Inside a process errors are values; a boundary catch isolates one unit of work and either
decides or passes the value up.** Status seams as round 1; new helpers `[[nodiscard]]`; a returned
status is consumed or passed up (A's S14). Spans move verbatim.

**S11 — Startup, before duty: fail fast on what retrying cannot fix, with a status the unit will
not loop on.** Collect all config errors, print each, exit 78 before any socket opens (A's S11a);
transients exit 1 or retry (A's S11b). Which errors are fatal is the class row.

**S12 — In duty: never exit from the safety or control paths.** Safety sends are bounded and
independent, degraded beats none; control refuses with a reason and leaves the rig unchanged; a
failed re-read is rejected and the last validated config kept (A's S11d). A wedge is answered by
the SIS through D-HB, not by a restart that commands the boot batch.

**S13 — Observation and tooling: degrade, keep running, one answer per request; a fault that
outlives its request is a keyed `ongoing` status on the operator surface** (B's S14a). An accepted
subscription delivers or is reported dead; never a flat line.

**S14 — Preserved behaviour is explicit; exit codes are frozen; 78 is reserved.** Per-service
settings at call sites (WP8 §2.1, §2.3, §2.5). 0 clean stop/`--help`, 1 startup failure, frozen
exceptions as WP8 §4; 78 only for refused config, `RestartPreventExitStatus=78` in the same package.
Only `main` exits, in its startup block (B's S13).

## Remaining sharp disagreements

- **A S11(c):** a broken runtime invariant in the sequencer should stop the process; I say a
  restart commands the boot batch and C4-1 cannot be stopped anyway — the SIS acts, via D-HB.
- **A S9:** uncaught backend errors should exit and restart; I say one message, keyed status.
- **B S11:** the line is time of detection alone; I say class × phase — config_broadcast's in-duty
  re-read and heartbeat's unarmed watchdog each break a single-axis rule.
- **B S14a:** one operator surface; I say one per class — the notification path is itself an
  observation-class component.
