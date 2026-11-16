# STYLE S8–S14 debate — round 2, advocate A: fail fast (rebuttal)

Paths under `daq-server/diablo_server/` unless prefixed; evidence from round 1 §1 is not restated.

## 1. Against B ("keep running, degrade loudly")

**B's thesis defeats itself at the one service that matters.** "A server exit buys no safety: the
boards do not notice" is true only while D-HB is unfixed — and B's S14a adopts
heartbeat-only-while-alive, "accepting that a software stall during a hold then aborts the
stand". After S14a a stopped abort path goes silent, `heartbeatTimedOut()`
(`firmware/Actuator_Board/ActuatorCon_Hotfire/src/main.cpp:366-370`) trips,
`run_ConnectionLossDetected` lands in `NoConnectionAbort` after the grace (`:478-483`). That *is*
fail-fast: the stand's safety action is triggered by absence, and B has conceded it for the abort
path. What remains between us is only whether the process exits or merely stops stroking — and a
process that has stopped stroking but is still `active` is exactly the "present and wrong" state
systemd cannot see.

**"Nobody reads stderr during a hot fire" — absence already has an operator surface; presence
does not.** A dead sequencer answers `state_transition` with `ERROR "<Action> failed: …"` to the
sender (DESIGN-WP6 §4.3, TCP `:9998` refused row). `dataFresh` (`server.ts:1775` advances on any
Elodin row) — the global bit B rightly says one dead channel cannot flip — *does* flip when ingest
stops, though a live t7_bridge or calibration keeps it fresh past a dead daq_bridge. A dead
backend is WS close 1006 on every GUI. A dead heartbeat is a board abort the GUI shows as board
state. Every exit is loud through layers that exist; D-SLOT, D-CTL,
D-SUB have no surface because the process is up.

**B's cure for the backend crash guard is a notification sent by the process B concedes is
undefined.** Objection 3: "process state after one is undefined" — then "a keyed status saying the
backend has swallowed an error" is emitted by that undefined process, over the WS it owns, while
it is also the operator's abort path (B's own `:9998 → worker → triggerAbort`). The comment at
`server.ts:1818-1822` justifies the guard by a `tsx watch` port race it says no longer applies —
and `sensor-backend.service` running the watcher anyway is C5-7, a defect, not a reason.

**Cost.** A keyed `ongoing: true` status for heartbeat, config_broadcast or the controller has no
channel to the GUI today except Elodin tables and the journal: S14a is new plumbing per C++
service, each with one user (S34). Exit rides `Restart=`, `--failed`, the board watchdog and the
journal-on-the-Boards-page precedent (`deploy/systemd/star-dhcp-sync.service:13-16`).

## 2. Against C ("criticality classes")

**Nothing executes the table.** C's own objection 1: "the gate cannot read a class"; the policy
lives in STYLE prose and S36 doc comments, checked by a design review. An exit status is the one
error policy the machine enforces for free, on every start, with no reviewer — that is what my S13
carries and C's S14 ("exit codes are frozen … 1 on startup failure") throws away: under
`Restart=always`, 1 is a 5 s loop whether the cause is a typo or a crash. C's S12 "Direction"
already points at 78 with the unit change; that is convergence, and I claim it.

**The backend is misclassified at the one process the operator aborts through.** C's observation
row holds "backend WS/HTTP" → "degrade and keep running", which blesses `server.ts:1823-1829`.
But every operator command — abort included — travels browser → backend → `:9998` (WP6 §4.3 line
338). The backend is on the control path; C's objection 2 ("classes blur at the lead defects")
lands on C's own table.

**The table does not decide D-BIND; the call site does.** C calls heartbeat's ignored bind
class-consistent (conceded below) — but the same `bindToDaqInterface` result is ignored in
config_broadcast, whose ACTUATOR_CONFIG thresholds sit on C's *safety* row, and the table gives
no ruling. Two services, one helper, two answers: that is S12 as drafted ("each service's
behaviour is a named setting at its call site"), not a class.

## 3. Concessions

- **A sequencer restart moves valves.** `SequencerService.cpp:603-610`: `init` publishes
  `bootState()` and `applyForState(boot, is_transition=true)` plus the continuous loop. B is right
  that restart is itself an actuator event, so S11(c) for the sequencer is gated on D-HB *and* on a
  team ruling about re-init after a board abort — open, not asserted.
- **Heartbeat's D-BIND is class-consistent and fail-safe either way** (C): the destination is
  subnet-directed (`heartbeat_service_main.cpp:241-244`), and a heartbeat that misses the boards
  aborts them. D-BIND stays a direction only for config_broadcast.
- **B's time-of-detection line** (startup vs in duty) is my S11(a)/(b)/(d); we agree on D-SLOT
  fail-closed, D-CTL startup exit, C6-9 inverted, 78 + `RestartPreventExitStatus`.
- **B's "a fault is a state until cleared, on a surface"** is the right loud half where exit is
  wrong: S11(d) and D-SUB adopt `markStaleBoards` → keyed notification (`server.ts:661-701`).
- **C's classes are the reason behind my buckets**; the `// Kept:` tag carries the class name.

## 4. Revised S8–S14

**S8 — The refactor preserves every failure mode.** Unchanged.

**S9 — Catch only where input enters; a catch decides or rethrows; a boundary catch ends one unit
of work, never the thread serving the others** (B's wording adopted). No process-level "keep
alive" guard: `server.ts:1818-1829` kept and labelled; direction is exit non-zero.

**S10 — One answer per request; every accepted subscription delivers or is reported dead** on a
keyed, ongoing operator status, and the remedy is recreate-not-resend (Idea 3).

**S11 — Classify, then refuse, retry, stop or report; never limp silently.**
(a) config/invariant knowable before a socket opens, any class: all errors, exit 78 before any
bind (D-SLOT, C2-4, C1-8, C2-5, C2-12 one policy);
(b) environment transient: bounded retry, never fatal; at startup the supervisor is the retry
(exit 1, D-CTL);
(c) runtime invariant broken in a control or safety path: stop, saying why — for the sequencer
only after D-HB and the re-init ruling (§3);
(d) runtime config re-read, and any *observation*-path fault: reject/keep last-good or drop the
row, keep the stream; the keyed `ongoing` status is raised by the backend from the absence it
already observes (stale ingest, dead subscription, refused `:9998`, missing heartbeat), as
`markStaleBoards` does — not by each service.

**S12 — Preserved behaviour is explicit.** `// Kept: <id> (D17) — <class>, becomes S11(<x>)`.

**S13 — Exit codes name the class.** 0, 1 (frozen), 78 never restarted, −6 only for a programming
invariant; only `main` exits; unit file changes with the code.

**S14 — A seam keeps its error style; every status reaches a decider; a fault that outlives its
request is a value the caller can publish** (C's wording for new seams; B's for the surface).

## 5. Remaining sharp disagreements

1. Runtime invariant in a control path: stop (A) vs mark faulted and keep other duties (B) vs
   per-row policy in a table (C).
2. Policy carrier: exit status the supervisor enforces (A) vs a keyed notification (B) vs a STYLE
   table plus review (C).
3. The backend: control path (A; B implicitly) vs observation (C).
4. B's S13 "no new exit path after startup" vs S11(c).
5. Loudness for C++ services: existing absence layers suffice (A) vs new per-service status
   plumbing (B).
