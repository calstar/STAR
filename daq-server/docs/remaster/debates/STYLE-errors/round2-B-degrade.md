# STYLE S8–S14, round 2 — Advocate B rebuttal

Paths under `daq-server/diablo_server/` unless prefixed `firmware/`, `deploy/`; lines on
`backend-remastered` @ `85a02f9a`.

## Correction to my round 1

The boards abort at `HEARTBEAT_TIMEOUT_MS` 5000 **plus** `CONNECTION_LOSS_GRACE_MS` 10000
(`firmware/Hotfire_Code/common/actuator_config.h:10-12`; `main.cpp:422-425, 479`), and a heartbeat
inside the grace returns the board to Active (`main.cpp:533-536`). "Within 5 s" was wrong: a wedge
becomes a board abort at 15 s. A's "aborts inside `RestartSec=5`" carries the same error.

## Against A

**A1. A's supervisor is a property of one launch configuration, not of the stand.** The tree
documents two: systemd on the server (`deploy/README.md:10-14`) and the tmux launcher for the
launch-site laptop (`backend/src/service-controller.ts:4-10`), whose panes are
`remain-on-exit on` (`deploy/startup/start_tmux_dev.sh:439`). Under tmux an exit is permanent
until a human reads a dead pane. S9's backend direction, S11(b) "the supervisor *is* the retry",
S11(c) and O2's "systemd restores it in 5 s" all assume the first configuration.

**A2. "Restart restores it" is a valve-moving event for the sequencer.** `init()` sets
`current_state_ = bootState()` and sends the IDLE column with `is_transition=true`
(`SequencerService.cpp:603-609`), then republishes it (`:610`). A restart under S11(c) commands
every valve to IDLE, uncommanded, with no ABORT datagram — the boards' abort machine
(`main.cpp:516-531`) never engages, no abort column runs, no operator chose it. A concedes
ABORT ownership on a dead worker is abort-statemachines Q2; that concession is the case.

**A3. The heartbeat arithmetic cuts against A either way.** Under systemd, exit + 5 s restart
lands inside the 10 s grace: the boards return to Active; the server itself detects nothing
(C6-3), and the only trace is the boards' reported `boardState` (frozen in
`test/characterization/lifecycle/golden/hbloss.txt:4`) flickering for the restart window — a
flicker, not a keyed status. Under tmux it is a stand abort at 15 s, chosen by whatever crashed
the heartbeat sender (default SIGPIPE disposition, Parked). "Absence
is a command" is exactly why the heartbeat sender must never exit except deliberately — C's
safety row, "degraded beats none".

**A4. S11(c) names no mechanism.** "Worker not consuming → stop": the wedged process cannot stop
itself (C4-1, frozen in `sequencer/golden/digital-twin__scripts-load.txt`; SIGTERM does not exit it). A's own text makes D-HB the precondition — a liveness
signal published by a process that stays up. That is my S14a, not an exit policy.

**A5. The backend guard's justification is live, not stale.** A says the `tsx watch` race "no
longer applies"; `sensor-backend.service` runs `npm run dev` = `tsx watch src/server.ts`
(`backend/package.json:8`; C5-7). The EADDRINUSE race the guard was written for is live in the
deployed unit; the comment's "plain `tsx`" describes the tmux launcher, not the unit.

**A6. D-SUB at connection granularity is A's evidence applied too coarsely.** Idea 3's condition:
re-sending is duplicate-free when the pair is *classified* dead (refused, task died, stale-bound)
— which A's S10 already adopts via the echo. Recreating the connection (18 fenced batches, a GUI
gap; subscription-robustness Q3) is warranted only for the unclassifiable case.

**Conceded to A:** exit 78 distinct from 1, `RestartPreventExitStatus` in every unit (S13);
collect *all* config errors (S11a); `[[nodiscard]]` on new helpers, cast to `void` under
`// Kept:` (S14); S11(d) last-validated-config-kept, verbatim; D-SLOT fail-closed (round 1);
and the hard one — "present and wrong" defeats every layer because **a C++ service has no status
surface today** (only the backend has NOTIFICATION; stacklight shows sequencer state). My S14a is
therefore a larger package for C++ than A's `return 1`: a status table or a backend service view.
I concede the cost, not the direction.

## Against C

**C1. "Errors as values" with no surface rule is D-CTL with a type.** `TcpListener::Failed`
returned to a caller who decides to fall through (WP8 §2.3) is `controller_main.cpp:147` again. C's
S10 says what the value is and never who shows it; C's S13 says "a silent subscription is
reported" — to whom, on what? Without S14a, C's observation row is silent degrade.

**C2. Classes are per path; exit is per process, and C never resolves the collision.** daq_bridge
hosts observation (ingest) and safety (SERVER_HEARTBEAT when `send_from_daq_bridge`,
`daq_bridge/daq_bridge_main.cpp:130, 629-636`); the sequencer hosts control and safety. C's S12
"exit 1 on config that moves a valve" and S11 "never exit mid-send" meet in one `main`. The missing
rule: **a process's exit policy is the most conservative of the classes it hosts.**

**C3. At runtime C is B; at startup C is A.** Control "refuse as a value, rig unchanged",
observation "drop the row, keep the stream", safety "degraded beats none" are my S11's second
half; C's startup exits are my first half. C's taxonomy is better than my "duty" wording, and
I adopt it. **Conceded to C:** the class table; the class in the S36 doc comment and in
`// Kept: <id> (D17) — <class rule>`; "safety never waits on control"; SIS/BPCS naming.

## Revised S8–S14 (deltas against round 1)

**S8** unchanged.

**S9** as round 1, plus A: a catch *decides* (defaults, refuse, drop, retry) or rethrows to the
boundary that can; a boundary catch still ends one unit of work, never the process.

**S10** as round 1; D-SUB direction: classify by the echoed `VTableMsg` (Idea 2), re-send only a
classified-dead pair, reconnect only the unclassifiable case; a dead channel is shown dead.

**S11 — C's classes × time of detection.** *Startup, before duty:* control config that moves a
valve or lands a table, and safety reachability — collect every error, one stderr block, exit 78;
transients (Elodin, NIC, port held) bounded retry, never fatal. *In duty:* control refuses as a
value and leaves the rig unchanged; observation drops the row and keeps the stream; safety never
blocks, throws or exits mid-send; a re-read that fails validation keeps the last validated config
and is shown (A's d). **A process's exit policy is the most conservative class it hosts**:
daq_bridge and the sequencer carry safety, so no runtime exit, whatever path faulted.

**S12** `// Kept: <id> (D17) — <class rule violated>; loud half: <surface>`.

**S13** 0, 1, frozen exceptions; **78** = refused config, never restarted; only `main` exits, only
before duty begins.

**S14** seam keeps its style; a fault is a value; a returned status is acted on or passed up
(`[[nodiscard]]`; `(void)` under `// Kept:`); nothing reports a fault only in a log.

**S14a** every degraded part is a keyed, `ongoing` status on an operator surface (the model is
frozen: `hbloss.txt:3`, `board_lost_21 ongoing=True`); for C++ services
that surface does not exist yet and is part of the fix package. The safety layer never depends on
an exit: SERVER_HEARTBEAT reflects abort-path liveness (D-HB), so a wedge is a board abort at 15 s.

## Sharp disagreements remaining

- **A:** a broken runtime invariant in the sequencer → stop and restart; **B:** stay, publish faulted, let D-HB trip the boards — the restart's IDLE batch is the crux.
- **A:** backend `uncaughtException` → exit and restart; **B:** keep, keyed notification — `tsx watch` is live and the laptop has no supervisor.
- **A:** D-SUB remedy = recreate the connection; **B:** classify first, reconnect last.
- **A vs B/C:** a heartbeat exit is the alarm (A) or the hazard (B, C's safety row); the number is 15 s.
- **C:** a class table plus values suffices; **B:** values nobody publishes are D-CTL; S14a is the missing rule.
